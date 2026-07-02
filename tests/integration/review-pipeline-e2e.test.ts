import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { StubGatewayClient } from '@review-bot/llm-client';
import {
  createDiffReviewerAgent,
  createSecurityReviewerAgent,
} from '@review-bot/agent-core';
import { parseMarker } from '@review-bot/shared';
import { PrRunCoordinator } from '../../apps/ci-review-bot/src/concurrency/pr-run-coordinator.js';
import { PendingPostStore } from '../../apps/ci-review-bot/src/outbox/pending-post-store.js';
import {
  FakeGitHubAdapter,
  GitHubRateLimitError,
} from '../../apps/ci-review-bot/src/adapters/github.adapter.js';
import { runReviewPipeline } from '../../apps/ci-review-bot/src/workflows/review-pr.workflow.js';
import { postFindings } from '../../apps/ci-review-bot/src/workflows/post-comments.workflow.js';
import { setupDb, truncateAll } from './helpers.js';

/**
 * End-to-end slice: webhook-normalized event → run coordination → context →
 * agents (stub Gateway) → validators → dedupe → posting guard → batched post
 * with marker-scan idempotency (E-001/E-002 analogues on the fake provider).
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

const SQL_INJECTION_FINDING = {
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

describe('review pipeline end-to-end (stub gateway, fake GitHub, real Postgres)', () => {
  let pool: pg.Pool;
  let coordinator: PrRunCoordinator;
  let pendingPosts: PendingPostStore;
  let github: FakeGitHubAdapter;
  let gateway: StubGatewayClient;

  const pr = { tenantId: 't1', repo: 'org/proj', pullRequestId: 7 };

  beforeAll(async () => {
    pool = await setupDb();
    coordinator = new PrRunCoordinator(pool);
    pendingPosts = new PendingPostStore(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    github = new FakeGitHubAdapter();
    gateway = new StubGatewayClient();
  });

  async function runPipeline(headSha: string) {
    const { run } = await coordinator.startRun({ ...pr, headSha });
    github.setHeadSha(pr.repo, pr.pullRequestId, headSha);
    const result = await runReviewPipeline({
      run,
      diffText: DIFF,
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
      highRisk: { categories: { security: ['**/auth/**'] } },
      validationPolicy: {
        confidenceThreshold: 0.8,
        highSeverityConfidenceThreshold: 0.9,
        requireDeterministicEvidenceForHighSeverity: true,
        approvedRootCauseIds: new Set(['INPUT.SQL_INJECTION_RISK', 'BUG.GENERIC']),
      },
      cancellation: new AbortController().signal,
    });
    return { run, result };
  }

  const postingPolicy = {
    maxInlineComments: 10,
    pendingPostExpireAfterHours: 24,
    tenantSecret: 'tenant-secret',
    integrationStatus: 'ACTIVE',
  };

  it('E-001 analogue: seeded security issue is detected, validated, and posted with marker', async () => {
    gateway.registerResponse('security_review', JSON.stringify([SQL_INJECTION_FINDING]));
    gateway.registerResponse('code_review', '[]');

    const { run, result } = await runPipeline('sha-a');
    expect(result.validated).toHaveLength(1);
    expect(result.validated[0]!.deterministic_evidence).toBe(true);

    const outcome = await postFindings(run, result.validated, postingPolicy, {
      github,
      coordinator,
      pendingPosts,
    });
    expect(outcome.kind).toBe('posted');
    expect(github.reviews).toHaveLength(1);
    const review = github.reviews[0]!;
    expect(review.commitSha).toBe('sha-a');
    expect(review.comments).toHaveLength(1);
    const marker = parseMarker(review.comments[0]!.body);
    expect(marker).not.toBeNull();
    expect(marker!.headSha).toBe('sha-a');
    expect(marker!.runEpoch).toBe(run.runEpoch);
  });

  it('E-002 analogue: clean diff produces no comments', async () => {
    gateway.registerResponse('security_review', '[]');
    gateway.registerResponse('code_review', '[]');
    const { run, result } = await runPipeline('sha-a');
    expect(result.validated).toHaveLength(0);
    const outcome = await postFindings(run, result.validated, postingPolicy, {
      github,
      coordinator,
      pendingPosts,
    });
    expect(outcome.kind).toBe('blocked');
    expect(github.reviews).toHaveLength(0);
  });

  it('marker scan prevents duplicate comments on retry (FR-POST-055/056, PPOST-007)', async () => {
    gateway.registerResponse('security_review', JSON.stringify([SQL_INJECTION_FINDING]));
    gateway.registerResponse('code_review', '[]');
    const { run, result } = await runPipeline('sha-a');

    const first = await postFindings(run, result.validated, postingPolicy, {
      github,
      coordinator,
      pendingPosts,
    });
    expect(first.kind).toBe('posted');

    // Ambiguous retry of the same post: marker scan finds the fingerprint.
    const retry = await postFindings(run, result.validated, postingPolicy, {
      github,
      coordinator,
      pendingPosts,
    });
    expect(retry.kind).toBe('already_posted');
    expect(github.reviews).toHaveLength(1); // no duplicate
  });

  it('C-003: superseded run findings are discarded by the posting guard', async () => {
    gateway.registerResponse('security_review', JSON.stringify([SQL_INJECTION_FINDING]));
    gateway.registerResponse('code_review', '[]');
    const { run: runA, result } = await runPipeline('commit-A');
    // Commit B arrives before A posts.
    await coordinator.startRun({ ...pr, headSha: 'commit-B' });

    const outcome = await postFindings(runA, result.validated, postingPolicy, {
      github,
      coordinator,
      pendingPosts,
    });
    expect(outcome.kind).toBe('stale_discarded');
    expect(github.reviews).toHaveLength(0); // FR-FENCE-008
  });

  it('GH-001/PPOST-001: rate limit writes durable pending post before backoff', async () => {
    gateway.registerResponse('security_review', JSON.stringify([SQL_INJECTION_FINDING]));
    gateway.registerResponse('code_review', '[]');
    const { run, result } = await runPipeline('sha-a');
    github.failNextSubmitWith.push(new GitHubRateLimitError(30));

    const outcome = await postFindings(run, result.validated, postingPolicy, {
      github,
      coordinator,
      pendingPosts,
    });
    expect(outcome.kind).toBe('backoff_queued');
    const rows = await pool.query('SELECT post_status FROM pending_review_posts');
    expect(rows.rows).toEqual([{ post_status: 'PENDING' }]); // durable before backoff
  });

  it('HARD-RULE-038: secrets in evidence are redacted from the posted comment', async () => {
    const leakyDiff = `diff --git a/src/auth/config.ts b/src/auth/config.ts
--- a/src/auth/config.ts
+++ b/src/auth/config.ts
@@ -1,2 +1,3 @@
 const config = {
+  awsKey: "AKIAIOSFODNN7EXAMPLE",
 };
`;
    const leakyFinding = {
      ...SQL_INJECTION_FINDING,
      finding_id: 'sec-002',
      file: 'src/auth/config.ts',
      line: 2,
      title: 'Hardcoded AWS credential',
      evidence: `awsKey: "AKIAIOSFODNN7EXAMPLE",`,
      root_cause_id: 'INPUT.SQL_INJECTION_RISK',
    };
    gateway.registerResponse('security_review', JSON.stringify([leakyFinding]));
    gateway.registerResponse('code_review', '[]');

    const { run } = await coordinator
      .startRun({ ...pr, headSha: 'sha-leak' })
      .then(async (r) => {
        github.setHeadSha(pr.repo, pr.pullRequestId, 'sha-leak');
        return { run: r.run };
      });
    const result = await runReviewPipeline({
      run,
      diffText: leakyDiff,
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
      cancellation: new AbortController().signal,
    });
    expect(result.validated).toHaveLength(1);

    const outcome = await postFindings(run, result.validated, postingPolicy, {
      github,
      coordinator,
      pendingPosts,
    });
    expect(outcome.kind).toBe('posted');
    const posted = github.reviews[0]!;
    const allBodies = [posted.body, ...posted.comments.map((c) => c.body)].join('\n');
    expect(allBodies).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(allBodies).toContain('[REDACTED:aws_access_key]');
  });

  it('agent failure is isolated; other agents still produce findings (FR-AGENT-011)', async () => {
    gateway.registerResponse('security_review', JSON.stringify([SQL_INJECTION_FINDING]));
    gateway.registerResponse('code_review', 'this is not valid json');
    const { result } = await runPipeline('sha-a');
    expect(result.validated).toHaveLength(1);
    expect(result.rejected.some((r) => r.disposition === 'REJECTED_SCHEMA')).toBe(true);
  });
});
