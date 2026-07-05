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
import type { PrdContextProvider } from '../../apps/ci-review-bot/src/prd/prd-context-provider.js';
import { containsInternalIdentifier, publicStatus } from '../../apps/ci-review-bot/src/status/public-status.js';
import { createRedis, setupDb, truncateAll } from './helpers.js';

/**
 * Public status & failure UX (Sprint 9) — the executor's check-run summaries
 * are plain-language messages (docs/product/failure-ux.md) with NO internal
 * identifiers on the standard surface (HARD-RULE-UX-005/006).
 */

const TENANT = 't1';
const REPO = 'org/proj';
const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,3 +10,4 @@
 function login(user) {
+  const q = "SELECT * FROM users WHERE name = '" + user + "'";
 }
`;
const SECURITY_FINDING = {
  finding_id: 'sec-001',
  severity: 'high',
  category: 'security',
  file: 'src/auth/login.ts',
  line: 11,
  title: 'SQL injection via string concatenation',
  evidence: `const q = "SELECT * FROM users WHERE name = '" + user + "'";`,
  recommendation: 'Use parameterized queries.',
  confidence: 0.96,
  agent_source: 'security-reviewer',
  root_cause_id: 'INPUT.SQL_INJECTION_RISK',
  root_cause_family: 'INPUT_VALIDATION',
  root_cause_source: 'global',
  taxonomy_version: '2026-07-02',
};

const NULL_PRD_PROVIDER: PrdContextProvider = { async provide() { return null; } };

describe('public status & failure UX (executor end-to-end)', () => {
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

  function buildExecutor(
    github: FakeGitHubAdapter,
    gateway: StubGatewayClient,
    prdProvider?: PrdContextProvider,
  ): RunExecutor {
    return new RunExecutor({
      pool,
      coordinator,
      debounce: new DebounceManager(redis, { debounceSeconds: 30, maxDebounceSeconds: 120 }),
      pendingPosts,
      github,
      agents: [createSecurityReviewerAgent(gateway)],
      contextPolicy: {
        maxFiles: 40,
        maxChangedLines: 1200,
        maxFileBytes: 80000,
        ignoreLockfiles: true,
        ignoreGeneratedFiles: true,
        ignoreMinifiedFiles: true,
        ignoreBinaryFiles: true,
      },
      highRisk: { categories: { security: ['**/auth/**'] } },
      validationPolicy: {
        confidenceThreshold: 0.8,
        highSeverityConfidenceThreshold: 0.9,
        requireDeterministicEvidenceForHighSeverity: true,
        approvedRootCauseIds: new Set(['INPUT.SQL_INJECTION_RISK']),
      },
      postingPolicy: {
        maxInlineComments: 10,
        pendingPostExpireAfterHours: 24,
        tenantSecret: 'tenant-secret',
        integrationStatus: 'ACTIVE',
      },
      dryRun: false,
      ...(prdProvider ? { prdProvider } : {}),
    });
  }

  async function seedAndRun(
    security: string,
    prdProvider?: PrdContextProvider,
  ): Promise<FakeGitHubAdapter> {
    const run: RunIdentity = (
      await coordinator.startRun({ tenantId: TENANT, repo: REPO, pullRequestId: 7, headSha: 'sha-a' })
    ).run;
    await coordinator.updateRunStatus(run.runId, 'QUEUED');
    const github = new FakeGitHubAdapter();
    github.setDiff(REPO, 7, DIFF);
    github.setHeadSha(REPO, 7, 'sha-a');
    const gateway = new StubGatewayClient();
    gateway.registerResponse('security_review', security);
    await buildExecutor(github, gateway, prdProvider).tick();
    return github;
  }

  const summaries = (g: FakeGitHubAdapter): string[] => g.checkRuns.map((c) => c.summary);

  it('a posted review surfaces the plain-language "posted" message, no internals', async () => {
    const github = await seedAndRun(JSON.stringify([SECURITY_FINDING]));
    const last = github.checkRuns.at(-1)!;
    expect(last.summary).toBe(publicStatus('posted', { findingCount: 1 }).summary);
    expect(last.conclusion).toBe('neutral'); // never blocks merge (§23.3)
    // No check-run summary at any stage leaks an internal identifier.
    for (const s of summaries(github)) expect(containsInternalIdentifier(s)).toBe(false);
  });

  it('a clean review with no PRD surfaces the "add a PRD" notice (HARD-RULE-UX-004)', async () => {
    const github = await seedAndRun('[]', NULL_PRD_PROVIDER);
    const last = github.checkRuns.at(-1)!;
    expect(last.summary).toBe(publicStatus('prd_missing').summary);
    for (const s of summaries(github)) expect(containsInternalIdentifier(s)).toBe(false);
  });

  it('a clean review with no PRD provider configured reports "no issues"', async () => {
    const github = await seedAndRun('[]'); // no prdProvider → not a PRD-missing case
    const last = github.checkRuns.at(-1)!;
    expect(last.summary).toBe(publicStatus('no_issues').summary);
    expect(last.conclusion).toBe('success');
  });

  it('the in-progress summary is user-facing and identifier-free', async () => {
    const github = await seedAndRun(JSON.stringify([SECURITY_FINDING]));
    const inProgress = github.checkRuns.find((c) => c.status === 'in_progress');
    expect(inProgress?.summary).toBe(publicStatus('in_progress').summary);
    expect(containsInternalIdentifier(inProgress!.summary)).toBe(false);
  });
});
