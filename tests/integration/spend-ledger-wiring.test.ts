import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { StubGatewayClient } from '@review-bot/llm-client';
import { createSecurityReviewerAgent } from '@review-bot/agent-core';
import type { RunIdentity } from '@review-bot/shared';
import { PrRunCoordinator } from '../../apps/ci-review-bot/src/concurrency/pr-run-coordinator.js';
import { DebounceManager } from '../../apps/ci-review-bot/src/concurrency/debounce-manager.js';
import { PendingPostStore } from '../../apps/ci-review-bot/src/outbox/pending-post-store.js';
import { FakeGitHubAdapter } from '../../apps/ci-review-bot/src/adapters/github.adapter.js';
import { RunExecutor } from '../../apps/ci-review-bot/src/workers/run-executor.js';
import { SpendLedger } from '../../apps/ci-review-bot/src/ledger/spend-ledger.js';
import { makeTenantLedgerKeyProvider } from '../../apps/ci-review-bot/src/ledger/tenant-key.js';
import { createRedis, setupDb, truncateAll } from './helpers.js';

/**
 * Spend-ledger wiring (prod path). A completed review run now records privacy-
 * safe spend: one immutable ledger row carrying HMAC pseudonyms only, plus the
 * expungable identity map (HARD-RULE-024/025, FR-CP-003/020..030). Accounting
 * failures never fail the run — so the run still posts.
 */

const TENANT = 'inst_9';
const REPO = 'acme/led';
const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,3 +10,4 @@
 function login(user) {
+  const q = "SELECT * FROM users WHERE name = '" + user + "'";
 }
`;
const SECURITY = {
  finding_id: 'sec-001', severity: 'high', category: 'security', file: 'src/auth/login.ts', line: 11,
  title: 'SQL injection via string concatenation',
  evidence: `const q = "SELECT * FROM users WHERE name = '" + user + "'";`,
  recommendation: 'Use parameterized queries.', confidence: 0.96, agent_source: 'security-reviewer',
  root_cause_id: 'INPUT.SQL_INJECTION_RISK', root_cause_family: 'INPUT_VALIDATION',
  root_cause_source: 'global', taxonomy_version: '2026-07-02',
};

describe('spend-ledger wiring (executor end-to-end)', () => {
  let pool: pg.Pool;
  let redis: Redis;
  let coordinator: PrRunCoordinator;
  let pendingPosts: PendingPostStore;

  beforeAll(async () => {
    pool = await setupDb();
    redis = createRedis();
    coordinator = new PrRunCoordinator(pool);
    pendingPosts = new PendingPostStore(pool);
  });
  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    await redis.flushdb();
  });

  function buildExecutor(github: FakeGitHubAdapter, gateway: StubGatewayClient): RunExecutor {
    return new RunExecutor({
      pool, coordinator,
      debounce: new DebounceManager(redis, { debounceSeconds: 30, maxDebounceSeconds: 120 }),
      pendingPosts, github,
      agents: [createSecurityReviewerAgent(gateway)],
      contextPolicy: {
        maxFiles: 40, maxChangedLines: 1200, maxFileBytes: 80000,
        ignoreLockfiles: true, ignoreGeneratedFiles: true, ignoreMinifiedFiles: true, ignoreBinaryFiles: true,
      },
      highRisk: { categories: { security: ['**/auth/**'] } },
      validationPolicy: {
        confidenceThreshold: 0.8, highSeverityConfidenceThreshold: 0.9,
        requireDeterministicEvidenceForHighSeverity: true,
        approvedRootCauseIds: new Set(['INPUT.SQL_INJECTION_RISK']),
      },
      postingPolicy: { maxInlineComments: 10, pendingPostExpireAfterHours: 24, tenantSecret: 'tenant-secret', integrationStatus: 'ACTIVE' },
      dryRun: false,
      ledger: new SpendLedger(pool, makeTenantLedgerKeyProvider({ appSecret: 'master', keyId: 'ledger-test' })),
    });
  }

  async function run(): Promise<{ github: FakeGitHubAdapter; run: RunIdentity }> {
    const { run: r } = await coordinator.startRun({ tenantId: TENANT, repo: REPO, pullRequestId: 7, headSha: 'sha-a' });
    await coordinator.updateRunStatus(r.runId, 'QUEUED');
    const github = new FakeGitHubAdapter();
    github.setDiff(REPO, 7, DIFF);
    github.setHeadSha(REPO, 7, 'sha-a');
    const gateway = new StubGatewayClient();
    gateway.registerResponse('security_review', JSON.stringify([SECURITY]));
    await buildExecutor(github, gateway).tick();
    return { github, run: r };
  }

  it('records one pseudonymized ledger row for a completed run; the run still posts', async () => {
    const { github, run: r } = await run();

    // The run posted for real (accounting never blocks the review path).
    expect(github.reviews.length).toBeGreaterThan(0);

    const ledgerRows = await pool.query(`SELECT * FROM spend_ledger WHERE tenant_id = $1`, [TENANT]);
    expect(ledgerRows.rowCount).toBe(1);
    const row = ledgerRows.rows[0];
    expect(row.hmac_key_id).toBe('ledger-test'); // rotation stamp (FR-CP-029)
    expect(Number(row.token_input) + Number(row.token_output)).toBeGreaterThan(0);
    expect(row.hmac_run_id).toMatch(/^[0-9a-f]{64}$/);

    // Pseudonyms only — no raw identifiers on the immutable row (FORBIDDEN-034).
    const scan = JSON.stringify(row);
    expect(scan).not.toContain(REPO);
    expect(scan).not.toContain(r.runId);
  });

  it('writes the expungable identity map (the sole re-identification path)', async () => {
    await run();
    const idmap = await pool.query(
      `SELECT identity_type, expunged_at, raw_identifier_encrypted
         FROM spend_ledger_identity_map WHERE tenant_id = $1 ORDER BY identity_type`,
      [TENANT],
    );
    // repo, pull_request, run (no user/trace on this run path).
    expect(idmap.rows.map((r) => r.identity_type)).toEqual(['pull_request', 'repo', 'run']);
    for (const r of idmap.rows) {
      expect(r.expunged_at).toBeNull();
      expect(r.raw_identifier_encrypted.length).toBeGreaterThan(0);
    }
  });
});
