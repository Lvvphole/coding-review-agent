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
import type { ReviewMode } from '../../apps/ci-review-bot/src/review-modes/modes.js';
import { createRedis, setupDb, truncateAll } from './helpers.js';

/**
 * Review modes end-to-end (Sprint 7) — a per-repo preset over the review
 * controls. Modes tune surfaced volume/categories; the safety floor is
 * identical (§10, HARD-RULE-UX-002/003). A high-severity security finding
 * surfaces in EVERY mode; style/maintainability are suppressed in the lower
 * modes.
 */

const REPO = 'acme/web';
const TENANT = 'inst_42';

// Three added lines (new-side lines 4,5,6), one per category/severity.
const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,6 @@
 const x = 1;
 const y = 2;
 const z = 3;
+const q = "SELECT * FROM users WHERE name = '" + user + "'";
+var unusedThing = compute();
+let w=1;
`;

const SECURITY = {
  finding_id: 'sec-001',
  severity: 'high',
  category: 'security',
  file: 'src/app.ts',
  line: 4,
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
const MAINT = {
  finding_id: 'mnt-001',
  severity: 'medium',
  category: 'maintainability',
  file: 'src/app.ts',
  line: 5,
  title: 'Unused variable',
  evidence: `var unusedThing = compute();`,
  recommendation: 'Remove dead code.',
  confidence: 0.9,
  agent_source: 'diff-reviewer',
  root_cause_id: 'MAINT.GENERIC',
  root_cause_family: 'MAINTAINABILITY',
  root_cause_source: 'global',
  taxonomy_version: '2026-07-02',
};
const STYLE = {
  finding_id: 'sty-001',
  severity: 'low',
  category: 'style',
  file: 'src/app.ts',
  line: 6,
  title: 'Missing spaces around operator',
  evidence: `let w=1;`,
  recommendation: 'Format per style guide.',
  confidence: 0.9,
  agent_source: 'diff-reviewer',
  root_cause_id: 'STYLE.GENERIC',
  root_cause_family: 'STYLE',
  root_cause_source: 'global',
  taxonomy_version: '2026-07-02',
};

describe('review modes (executor end-to-end)', () => {
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
  });

  function buildExecutor(github: FakeGitHubAdapter, gateway: StubGatewayClient): RunExecutor {
    return new RunExecutor({
      pool,
      coordinator,
      debounce: new DebounceManager(redis, { debounceSeconds: 30, maxDebounceSeconds: 120 }),
      pendingPosts,
      github,
      agents: [createDiffReviewerAgent(gateway), createSecurityReviewerAgent(gateway)],
      contextPolicy: {
        maxFiles: 40,
        maxChangedLines: 1200,
        maxFileBytes: 80000,
        ignoreLockfiles: true,
        ignoreGeneratedFiles: true,
        ignoreMinifiedFiles: true,
        ignoreBinaryFiles: true,
      },
      highRisk: { categories: {} },
      validationPolicy: {
        confidenceThreshold: 0.8,
        highSeverityConfidenceThreshold: 0.9,
        requireDeterministicEvidenceForHighSeverity: true,
        approvedRootCauseIds: new Set(['INPUT.SQL_INJECTION_RISK', 'MAINT.GENERIC', 'STYLE.GENERIC']),
      },
      postingPolicy: {
        maxInlineComments: 10,
        pendingPostExpireAfterHours: 24,
        tenantSecret: 'tenant-secret',
        integrationStatus: 'ACTIVE',
      },
      dryRun: false,
      modeResolver: modes,
    });
  }

  /** Provision the repo, set its mode, seed a QUEUED run, execute one tick. */
  async function reviewInMode(mode?: ReviewMode): Promise<FakeGitHubAdapter> {
    await tenants.provisionInstall({
      installationId: 42,
      org: 'acme',
      repositories: [{ fullName: REPO, repoId: 1 }],
    });
    if (mode) expect(await modes.setMode(REPO, mode)).toBe(true);

    const { run } = await coordinator.startRun({
      tenantId: TENANT,
      repo: REPO,
      pullRequestId: 7,
      headSha: 'sha-a',
    });
    await coordinator.updateRunStatus(run.runId, 'QUEUED');

    const github = new FakeGitHubAdapter();
    github.setDiff(REPO, 7, DIFF);
    github.setHeadSha(REPO, 7, 'sha-a');
    const gateway = new StubGatewayClient();
    gateway.registerResponse('security_review', JSON.stringify([SECURITY]));
    gateway.registerResponse('code_review', JSON.stringify([MAINT, STYLE]));

    await buildExecutor(github, gateway).tick();
    return github;
  }

  const postedCategories = (github: FakeGitHubAdapter): number =>
    github.reviews[0]?.comments.length ?? 0;

  it('Standard (default): surfaces security + maintainability, suppresses style', async () => {
    const github = await reviewInMode(); // no explicit mode → default standard
    expect(github.reviews).toHaveLength(1);
    expect(postedCategories(github)).toBe(2);
    const bodies = github.reviews[0]!.comments.map((c) => c.body).join('\n');
    expect(bodies).toContain('SQL injection');
    expect(bodies).toContain('Unused variable');
    expect(bodies).not.toContain('Missing spaces');
  });

  it('Light: surfaces only the high-signal security finding (maintainability + style suppressed)', async () => {
    const github = await reviewInMode('light');
    expect(github.reviews).toHaveLength(1);
    expect(postedCategories(github)).toBe(1);
    expect(github.reviews[0]!.comments[0]!.body).toContain('SQL injection');
  });

  it('Strict: surfaces all three categories', async () => {
    const github = await reviewInMode('strict');
    expect(github.reviews).toHaveLength(1);
    expect(postedCategories(github)).toBe(3);
  });

  it('SAFETY FLOOR: the high-severity security finding is posted in every mode', async () => {
    for (const mode of ['light', 'standard', 'strict'] as ReviewMode[]) {
      await truncateAll(pool);
      await redis.flushdb();
      const github = await reviewInMode(mode);
      const bodies = github.reviews[0]!.comments.map((c) => c.body).join('\n');
      expect(bodies).toContain('SQL injection');
    }
  });

  it('ModeStore: default is Standard; setMode persists and re-provision preserves it', async () => {
    await tenants.provisionInstall({
      installationId: 42,
      org: 'acme',
      repositories: [{ fullName: REPO, repoId: 1 }],
    });
    expect(await modes.resolveMode(TENANT, REPO)).toBe('standard');

    expect(await modes.setMode(REPO, 'strict')).toBe(true);
    expect(await modes.resolveMode(TENANT, REPO)).toBe('strict');

    // installation_repositories redelivery must not reset the chosen mode.
    await tenants.provisionInstall({
      installationId: 42,
      org: 'acme',
      repositories: [{ fullName: REPO, repoId: 1 }],
    });
    expect(await modes.resolveMode(TENANT, REPO)).toBe('strict');
  });

  it('ModeStore: unknown/uninstalled repo resolves to the default (mode is not a safety gate)', async () => {
    expect(await modes.resolveMode(TENANT, 'stranger/repo')).toBe('standard');
  });
});
