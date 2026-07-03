import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { StubGatewayClient } from '@review-bot/llm-client';
import { createSecurityReviewerAgent } from '@review-bot/agent-core';
import { parseMarker } from '@review-bot/shared';
import { PrRunCoordinator } from '../../apps/ci-review-bot/src/concurrency/pr-run-coordinator.js';
import { DebounceManager } from '../../apps/ci-review-bot/src/concurrency/debounce-manager.js';
import { PendingPostStore } from '../../apps/ci-review-bot/src/outbox/pending-post-store.js';
import {
  GitHubAppAuth,
  InstallationStore,
  StaticTokenProvider,
} from '../../apps/ci-review-bot/src/adapters/github-app-auth.js';
import { GitHubRestAdapter } from '../../apps/ci-review-bot/src/adapters/github-rest.adapter.js';
import { RunExecutor } from '../../apps/ci-review-bot/src/workers/run-executor.js';
import { PostingWorker } from '../../apps/ci-review-bot/src/workers/posting-worker.js';
import { FakeGitHubServer } from './fake-github-server.js';
import { createRedis, setupDb, truncateAll } from './helpers.js';

/**
 * Sprint 2 end-to-end: durable executor + real REST adapter against a fake
 * GitHub API + posting worker draining the outbox.
 */

const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,4 +10,6 @@
 function login(user) {
+  const query = "SELECT * FROM users WHERE name = '" + user + "'";
+  return db.raw(query);
 }
`;

const FINDING = {
  finding_id: 'sec-001',
  severity: 'high',
  category: 'security',
  file: 'src/auth/login.ts',
  line: 11,
  title: 'SQL injection via string concatenation',
  evidence: `const query = "SELECT * FROM users WHERE name = '" + user + "'";`,
  recommendation: 'Use parameterized queries.',
  confidence: 0.96,
  agent_source: 'security-reviewer',
  root_cause_id: 'INPUT.SQL_INJECTION_RISK',
  root_cause_family: 'INPUT_VALIDATION',
  root_cause_source: 'global',
  taxonomy_version: '2026-07-02',
};

describe('github boundary e2e', () => {
  let pool: pg.Pool;
  let redis: Redis;
  let server: FakeGitHubServer;

  beforeAll(async () => {
    pool = await setupDb();
    redis = createRedis();
  });
  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    await redis.flushdb();
    server = new FakeGitHubServer();
    server.diff = DIFF;
    server.headSha = 'sha-a';
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  function buildStack(opts: { dryRun?: boolean } = {}) {
    const coordinator = new PrRunCoordinator(pool);
    const pendingPosts = new PendingPostStore(pool);
    const debounce = new DebounceManager(redis, { debounceSeconds: 0, maxDebounceSeconds: 1 });
    const github = new GitHubRestAdapter({
      apiBaseUrl: server.baseUrl,
      tokens: new StaticTokenProvider('test-token'),
      botLogin: 'agentic-ai-review-bot',
      readMaxRetries: 2,
      sleepImpl: async () => {},
    });
    const gateway = new StubGatewayClient();
    gateway.registerResponse('security_review', JSON.stringify([FINDING]));
    const postingPolicy = {
      maxInlineComments: 10,
      pendingPostExpireAfterHours: 24,
      tenantSecret: 'tenant-secret',
      integrationStatus: 'ACTIVE',
    };
    const executor = new RunExecutor({
      pool,
      coordinator,
      debounce,
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
      postingPolicy,
      dryRun: opts.dryRun ?? false,
      log: () => {},
    });
    const worker = new PostingWorker({
      pendingPosts,
      coordinator,
      github,
      postingPolicy,
      workerId: 'test-worker',
      maxRetries: 3,
      lockTtlSeconds: 120,
      log: () => {},
    });
    return { coordinator, pendingPosts, debounce, github, executor, worker };
  }

  const pr = { tenantId: 't1', repo: 'org/proj', prId: 7 };

  async function runStatus(): Promise<string[]> {
    const res = await pool.query('SELECT status FROM review_runs ORDER BY created_at');
    return res.rows.map((r) => r.status);
  }

  it('executor: debounce settle → durable QUEUED run → review posted with marker', async () => {
    const { debounce, executor } = buildStack();
    await debounce.recordEvent(pr.tenantId, pr.repo, pr.prId, 'sha-a');
    // One tick settles the due debounce window (run becomes durable QUEUED)
    // and then executes it in the same pass.
    const result = await executor.tick();
    expect(result.started).toBe(1);
    expect(result.executed).toBe(1);

    expect(server.reviews).toHaveLength(1);
    const review = server.reviews[0]!;
    expect(review.commit_id).toBe('sha-a');
    const inline = review.comments as { body: string }[];
    expect(inline).toHaveLength(1);
    const marker = parseMarker(inline[0]!.body);
    expect(marker?.headSha).toBe('sha-a');
    expect(await runStatus()).toEqual(['COMPLETED']);

    // FR-CHECK-001/002: check run reported in_progress then completed,
    // with a non-blocking conclusion (§23.3 CI rule).
    const statuses = server.checkRuns.map((c) => c['status']);
    expect(statuses).toEqual(['in_progress', 'completed']);
    expect(server.checkRuns[1]!['conclusion']).toBe('neutral');
  });

  it('FR-EXEC-006: QUEUED run survives "restart" — a fresh executor picks it up', async () => {
    // A run parked in QUEUED (as if the pod died right after coordination):
    const { coordinator } = buildStack();
    const { run } = await coordinator.startRun({
      tenantId: pr.tenantId,
      repo: pr.repo,
      pullRequestId: pr.prId,
      headSha: 'sha-a',
    });
    await coordinator.updateRunStatus(run.runId, 'QUEUED');
    expect(await runStatus()).toEqual(['QUEUED']);

    const { executor: freshExecutor } = buildStack(); // simulated new pod
    const result = await freshExecutor.tick();
    expect(result.executed).toBe(1);
    expect(await runStatus()).toEqual(['COMPLETED']);
    expect(server.reviews).toHaveLength(1);
  });

  it('dry-run mode completes the run without posting (FR-SLO-008)', async () => {
    const { debounce, executor } = buildStack({ dryRun: true });
    await debounce.recordEvent(pr.tenantId, pr.repo, pr.prId, 'sha-a');
    await executor.tick();
    expect(server.reviews).toHaveLength(0);
    expect(await runStatus()).toEqual(['COMPLETED']);
  });

  it('429 → durable pending post → posting worker drains, exactly one review (GH-001, PPOST series)', async () => {
    const { debounce, executor, worker, pendingPosts } = buildStack();
    server.failNextReviewWith.push({ status: 429, headers: { 'retry-after': '0' } });

    await debounce.recordEvent(pr.tenantId, pr.repo, pr.prId, 'sha-a');
    await executor.tick();

    expect(await runStatus()).toEqual(['GH_RATE_LIMIT_BACKOFF']);
    const pending = await pendingPosts.listRecoverable();
    expect(pending).toHaveLength(1); // durably written before backoff (HARD-RULE-015)

    const drained = await worker.tick();
    expect(drained).toBe(1);
    expect(server.reviews).toHaveLength(1); // no duplicate from the failed attempt

    const rows = await pool.query('SELECT post_status, github_comment_id FROM pending_review_posts');
    expect(rows.rows[0].post_status).toBe('POSTED');
    expect(rows.rows[0].github_comment_id).not.toBeNull();
  });

  it('worker retry after ambiguous success does not duplicate (marker scan, FR-POST-055/056)', async () => {
    const { debounce, executor, worker, pendingPosts } = buildStack();
    server.failNextReviewWith.push({ status: 429, headers: { 'retry-after': '0' } });
    await debounce.recordEvent(pr.tenantId, pr.repo, pr.prId, 'sha-a');
    await executor.tick();

    await worker.tick(); // posts successfully, row POSTED
    // Simulate a duplicate scheduler wakeup on an already-posted fingerprint:
    // force the row back to PENDING as if the POSTED write was lost mid-crash.
    await pool.query(
      `UPDATE pending_review_posts SET post_status = 'PENDING', worker_id = NULL,
              locked_at = NULL, lock_expires_at = NULL, next_retry_at = now()`,
    );
    const drained = await worker.tick();
    expect(drained).toBe(1);
    expect(server.reviews).toHaveLength(1); // marker scan found the fingerprint
    const rows = await pool.query('SELECT post_status FROM pending_review_posts');
    expect(rows.rows[0].post_status).toBe('POSTED');
    expect(await pendingPosts.listRecoverable()).toHaveLength(0);
  });

  it('closed PR cancels the run and cascades the outbox (FR-GH-045..047)', async () => {
    const { debounce, executor, pendingPosts } = buildStack();
    server.failNextReviewWith.push({ status: 429, headers: { 'retry-after': '600' } });
    await debounce.recordEvent(pr.tenantId, pr.repo, pr.prId, 'sha-a');
    await executor.tick(); // run parked in GH_RATE_LIMIT_BACKOFF with pending post

    await executor.handleClosedPr(pr.tenantId, pr.repo, pr.prId);
    expect(await runStatus()).toEqual(['CANCELLED']);
    const rows = await pool.query('SELECT post_status FROM pending_review_posts');
    expect(rows.rows[0].post_status).toBe('CANCELLED');
    expect(await pendingPosts.listRecoverable()).toHaveLength(0);
  });

  it('FORBIDDEN-045: routine token expiry refreshes transparently, no severance', async () => {
    const installations = new InstallationStore(pool);
    server.tokenTtlSeconds = 250; // inside the 300s refresh window → next call refreshes
    const auth = new GitHubAppAuth({
      appId: '1',
      privateKeyPem: TEST_PRIVATE_KEY,
      installationId: 42,
      tenantId: 't1',
      org: 'org',
      apiBaseUrl: server.baseUrl,
      store: installations,
      refreshBeforeExpirySeconds: 300,
      maxRefreshRetries: 2,
    });
    const t1 = await auth.getToken();
    const t2 = await auth.getToken(); // within refresh window → new exchange
    expect(server.tokenRequests).toBe(2);
    expect(t1).not.toBe(t2);
    expect(await installations.getStatus('t1', 42)).toBe('ACTIVE');
  });

  it('401 on token exchange severs the integration durably (FR-GH-036)', async () => {
    const installations = new InstallationStore(pool);
    server.failNextTokenWith.push({ status: 401 });
    const auth = new GitHubAppAuth({
      appId: '1',
      privateKeyPem: TEST_PRIVATE_KEY,
      installationId: 42,
      tenantId: 't1',
      org: 'org',
      apiBaseUrl: server.baseUrl,
      store: installations,
      refreshBeforeExpirySeconds: 300,
      maxRefreshRetries: 2,
    });
    await expect(auth.getToken()).rejects.toMatchObject({ name: 'GitHubIntegrationSeveredError' });
    expect(await installations.getStatus('t1', 42)).toBe('REAUTH_REQUIRED');
  });
});

import { generateKeyPairSync } from 'node:crypto';
const TEST_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
