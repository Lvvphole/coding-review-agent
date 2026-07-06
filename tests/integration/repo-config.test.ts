import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { StubGatewayClient } from '@review-bot/llm-client';
import { createDiffReviewerAgent, createSecurityReviewerAgent } from '@review-bot/agent-core';
import { PrRunCoordinator } from '../../apps/ci-review-bot/src/concurrency/pr-run-coordinator.js';
import { DebounceManager } from '../../apps/ci-review-bot/src/concurrency/debounce-manager.js';
import { PendingPostStore } from '../../apps/ci-review-bot/src/outbox/pending-post-store.js';
import { FakeGitHubAdapter } from '../../apps/ci-review-bot/src/adapters/github.adapter.js';
import { RunExecutor } from '../../apps/ci-review-bot/src/workers/run-executor.js';
import { TenantStore } from '../../apps/ci-review-bot/src/tenancy/tenant-store.js';
import { ModeStore } from '../../apps/ci-review-bot/src/review-modes/mode-store.js';
import { RepoFileConfigResolver } from '../../apps/ci-review-bot/src/review-modes/repo-config.js';
import type { RepoFileReader } from '../../apps/ci-review-bot/src/prd/prd-store.js';
import { createRedis, setupDb, truncateAll } from './helpers.js';

/**
 * `.github/review-bot.yml` opt-in layer end-to-end (HARD-RULE-UX-003). The
 * committed file's review_mode OVERRIDES the admin-stored mode for the run;
 * an absent or malformed file falls back to the stored mode. Precedence:
 * repo file > admin-stored mode > managed default.
 */

const TENANT = 'inst_42';
const REPO = 'acme/web';

const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,5 @@
 const x = 1;
 const y = 2;
 const z = 3;
+const q = "SELECT * FROM users WHERE name = '" + user + "'";
+var unusedThing = compute();
`;
const SECURITY = {
  finding_id: 'sec-001', severity: 'high', category: 'security', file: 'src/app.ts', line: 4,
  title: 'SQL injection via string concatenation',
  evidence: `const q = "SELECT * FROM users WHERE name = '" + user + "'";`,
  recommendation: 'Use parameterized queries.', confidence: 0.96, agent_source: 'security-reviewer',
  root_cause_id: 'INPUT.SQL_INJECTION_RISK', root_cause_family: 'INPUT_VALIDATION',
  root_cause_source: 'global', taxonomy_version: '2026-07-02',
};
const MAINT = {
  finding_id: 'mnt-001', severity: 'medium', category: 'maintainability', file: 'src/app.ts', line: 5,
  title: 'Unused variable', evidence: `var unusedThing = compute();`,
  recommendation: 'Remove dead code.', confidence: 0.9, agent_source: 'diff-reviewer',
  root_cause_id: 'MAINT.GENERIC', root_cause_family: 'MAINTAINABILITY',
  root_cause_source: 'global', taxonomy_version: '2026-07-02',
};

/** In-memory reader for `.github/review-bot.yml`; returns text regardless of ref. */
function configReader(text: string | null): RepoFileReader {
  return { async read() { return text; } };
}

describe('.github/review-bot.yml opt-in layer (end-to-end)', () => {
  let pool: pg.Pool;
  let redis: Redis;
  let coordinator: PrRunCoordinator;
  let pendingPosts: PendingPostStore;
  let tenants: TenantStore;
  let modes: ModeStore;

  beforeAll(async () => {
    pool = await setupDb();
    redis = createRedis();
    coordinator = new PrRunCoordinator(pool);
    pendingPosts = new PendingPostStore(pool);
    tenants = new TenantStore(pool, 'app-secret');
    modes = new ModeStore(pool);
  });
  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    await redis.flushdb();
    await tenants.provisionInstall({ installationId: 42, org: 'acme', repositories: [{ fullName: REPO, repoId: 1 }] });
  });

  function buildExecutor(github: FakeGitHubAdapter, gateway: StubGatewayClient, configText: string | null): RunExecutor {
    return new RunExecutor({
      pool, coordinator,
      debounce: new DebounceManager(redis, { debounceSeconds: 30, maxDebounceSeconds: 120 }),
      pendingPosts, github,
      agents: [createDiffReviewerAgent(gateway), createSecurityReviewerAgent(gateway)],
      contextPolicy: {
        maxFiles: 40, maxChangedLines: 1200, maxFileBytes: 80000,
        ignoreLockfiles: true, ignoreGeneratedFiles: true, ignoreMinifiedFiles: true, ignoreBinaryFiles: true,
      },
      highRisk: { categories: {} },
      validationPolicy: {
        confidenceThreshold: 0.8, highSeverityConfidenceThreshold: 0.9,
        requireDeterministicEvidenceForHighSeverity: true,
        approvedRootCauseIds: new Set(['INPUT.SQL_INJECTION_RISK', 'MAINT.GENERIC']),
      },
      postingPolicy: { maxInlineComments: 10, pendingPostExpireAfterHours: 24, tenantSecret: 'tenant-secret', integrationStatus: 'ACTIVE' },
      dryRun: false,
      modeResolver: modes,
      repoConfigResolver: new RepoFileConfigResolver(configReader(configText)),
    });
  }

  async function run(prId: number, configText: string | null): Promise<FakeGitHubAdapter> {
    const { run: r } = await coordinator.startRun({ tenantId: TENANT, repo: REPO, pullRequestId: prId, headSha: `sha-${prId}` });
    await coordinator.updateRunStatus(r.runId, 'QUEUED');
    const github = new FakeGitHubAdapter();
    github.setDiff(REPO, prId, DIFF);
    github.setHeadSha(REPO, prId, `sha-${prId}`);
    const gateway = new StubGatewayClient();
    gateway.registerResponse('security_review', JSON.stringify([SECURITY]));
    gateway.registerResponse('code_review', JSON.stringify([MAINT]));
    await buildExecutor(github, gateway, configText).tick();
    return github;
  }

  const commentCount = (g: FakeGitHubAdapter): number => g.reviews[0]?.comments.length ?? 0;

  it('a committed review.mode overrides the admin-stored mode', async () => {
    // Stored mode is Standard → security + maintainability (2 comments).
    const standard = await run(1, null);
    expect(commentCount(standard)).toBe(2);

    // The repo commits `.github/review-bot.yml: review.mode=light`, which
    // suppresses maintainability → only security surfaces (1 comment).
    const overridden = await run(2, 'review:\n  mode: light\n');
    expect(commentCount(overridden)).toBe(1);
    expect(overridden.reviews[0]!.comments.map((c) => c.body).join('\n')).toContain('SQL injection');
  });

  it('an admin-set mode is overridden by the committed file (precedence)', async () => {
    expect(await modes.setMode(REPO, 'strict')).toBe(true); // admin sets Strict
    // But the repo file pins Light → Light wins.
    const github = await run(3, 'review:\n  mode: light\n');
    expect(commentCount(github)).toBe(1);
  });

  it('a malformed file yields no override — the stored mode stands', async () => {
    expect(await modes.setMode(REPO, 'light')).toBe(true);
    // Unknown mode value → ignored; stored Light stands → 1 comment.
    const github = await run(4, 'review:\n  mode: turbo\n');
    expect(commentCount(github)).toBe(1);
  });
});
