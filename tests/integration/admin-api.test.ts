import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { StubGatewayClient } from '@review-bot/llm-client';
import { createDiffReviewerAgent, createSecurityReviewerAgent } from '@review-bot/agent-core';
import type { RunIdentity } from '@review-bot/shared';
import { PrRunCoordinator } from '../../apps/ci-review-bot/src/concurrency/pr-run-coordinator.js';
import { DebounceManager } from '../../apps/ci-review-bot/src/concurrency/debounce-manager.js';
import { PendingPostStore } from '../../apps/ci-review-bot/src/outbox/pending-post-store.js';
import { FakeGitHubAdapter } from '../../apps/ci-review-bot/src/adapters/github.adapter.js';
import { RunExecutor } from '../../apps/ci-review-bot/src/workers/run-executor.js';
import { TenantStore } from '../../apps/ci-review-bot/src/tenancy/tenant-store.js';
import { ModeStore } from '../../apps/ci-review-bot/src/review-modes/mode-store.js';
import { PrdSourceStore, PrdResolver } from '../../apps/ci-review-bot/src/prd/prd-store.js';
import { PrdExtractor } from '../../apps/ci-review-bot/src/prd/prd-extractor.js';
import { ManagedPrdContextProvider } from '../../apps/ci-review-bot/src/prd/prd-context-provider.js';
import { AdminStore } from '../../apps/ci-review-bot/src/admin/admin-store.js';
import { AdminApi, type AdminRequest } from '../../apps/ci-review-bot/src/admin/admin-api.js';
import { StaticTokenAuthenticator } from '../../apps/ci-review-bot/src/admin/rbac.js';
import { createRedis, setupDb, truncateAll } from './helpers.js';

/**
 * Onboarding / Admin API end-to-end (Sprint 10). The thin admin surface over
 * the built substrate drives real review behavior: a mode set via the API
 * changes the next run's surfaced findings; a PRD attached via the API makes the
 * next run requirement-aware; RBAC blocks unauthorized callers; a freshly
 * onboarded repo reviews in shadow until an admin activates it (FR-SLO-008);
 * expungement purges raw PRD data (HARD-RULE-047). All against live Postgres.
 */

const TENANT = 'inst_7';
const INSTALLATION = 7;
const REPO = 'acme/web';

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
const EXTRACT_OPTS = { taxonomyVersion: '2026-07-02', maxBytes: 24000, maxChunks: 8 };

describe('Admin / onboarding API (end-to-end)', () => {
  let pool: pg.Pool;
  let redis: Redis;
  let coordinator: PrRunCoordinator;
  let pendingPosts: PendingPostStore;
  let tenants: TenantStore;
  let modes: ModeStore;
  let prdSources: PrdSourceStore;
  let store: AdminStore;
  let api: AdminApi;

  beforeAll(async () => {
    pool = await setupDb();
    redis = createRedis();
    coordinator = new PrRunCoordinator(pool);
    pendingPosts = new PendingPostStore(pool);
    tenants = new TenantStore(pool, 'app-secret');
    modes = new ModeStore(pool);
    prdSources = new PrdSourceStore(pool);
    store = new AdminStore(pool);
    api = new AdminApi({
      auth: new StaticTokenAuthenticator({
        admintok: { tenantId: TENANT, role: 'admin' },
        viewertok: { tenantId: TENANT, role: 'viewer' },
        othertok: { tenantId: 'inst_99', role: 'admin' },
      }),
      store,
      modes,
      prd: prdSources,
    });
  });
  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    await redis.flushdb();
    await tenants.provisionInstall({
      installationId: INSTALLATION,
      org: 'acme',
      repositories: [{ fullName: REPO, repoId: 1 }],
    });
  });

  const as = (token: string | undefined, over: Partial<AdminRequest>): AdminRequest => ({
    method: 'GET',
    path: '/admin/tenant',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...over,
  });

  function buildExecutor(
    github: FakeGitHubAdapter,
    gateway: StubGatewayClient,
    opts: { prd?: boolean } = {},
  ): RunExecutor {
    const provider = opts.prd
      ? new ManagedPrdContextProvider(
          new PrdResolver(prdSources),
          new PrdExtractor(pool, gateway, EXTRACT_OPTS),
        )
      : undefined;
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
        approvedRootCauseIds: new Set(['INPUT.SQL_INJECTION_RISK', 'MAINT.GENERIC']),
      },
      postingPolicy: {
        maxInlineComments: 10,
        pendingPostExpireAfterHours: 24,
        tenantSecret: 'tenant-secret',
        integrationStatus: 'ACTIVE',
      },
      dryRun: false,
      shadowResolver: store,
      modeResolver: modes,
      ...(provider ? { prdProvider: provider } : {}),
    });
  }

  async function runOnce(prId: number, gateway: StubGatewayClient, opts: { prd?: boolean } = {}): Promise<FakeGitHubAdapter> {
    const { run } = await coordinator.startRun({ tenantId: TENANT, repo: REPO, pullRequestId: prId, headSha: `sha-${prId}` });
    await coordinator.updateRunStatus(run.runId, 'QUEUED');
    const github = new FakeGitHubAdapter();
    github.setDiff(REPO, prId, DIFF);
    github.setHeadSha(REPO, prId, `sha-${prId}`);
    await buildExecutor(github, gateway, opts).tick();
    return github;
  }

  const gatewayWith = (findings: unknown[], security = [SECURITY]): StubGatewayClient => {
    const gw = new StubGatewayClient();
    gw.registerResponse('security_review', JSON.stringify(security));
    gw.registerResponse('code_review', JSON.stringify(findings));
    return gw;
  };

  // --- Read surface ---------------------------------------------------------

  it('GET /admin/tenant reports install + integration status', async () => {
    const res = await api.handle(as('admintok', { path: '/admin/tenant' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tenantId: TENANT, status: 'ACTIVE', repoCount: 1 });
  });

  it('GET /admin/repos lists the repo with mode, shadow, and PRD status', async () => {
    const res = await api.handle(as('admintok', { path: '/admin/repos' }));
    expect(res.status).toBe(200);
    const repos = (res.body as { repos: unknown[] }).repos;
    expect(repos).toEqual([
      { repo: REPO, active: true, mode: 'standard', shadow: true, prd: { attached: false } },
    ]);
  });

  // --- RBAC (FR-SLO-009) ----------------------------------------------------

  it('blocks unauthenticated, viewer-write, and cross-tenant callers', async () => {
    expect((await api.handle(as(undefined, { path: '/admin/repos' }))).status).toBe(401);

    const viewerWrite = await api.handle(
      as('viewertok', { method: 'POST', path: '/admin/repos/mode', body: { repo: REPO, mode: 'strict' } }),
    );
    expect(viewerWrite.status).toBe(403);

    // Another tenant's admin cannot see or touch this repo.
    const cross = await api.handle(
      as('othertok', { method: 'POST', path: '/admin/repos/mode', body: { repo: REPO, mode: 'strict' } }),
    );
    expect(cross.status).toBe(404);
    expect(await modes.resolveMode(TENANT, REPO)).toBe('standard'); // unchanged
  });

  // --- Mode set via API drives the next run ---------------------------------

  it('a mode set via the API drives the next run (light suppresses maintainability)', async () => {
    // Activate first so real posting happens; default standard would post 2.
    expect((await api.handle(as('admintok', { method: 'POST', path: '/admin/repos/activate', body: { repo: REPO } }))).status).toBe(200);

    const setLight = await api.handle(
      as('admintok', { method: 'POST', path: '/admin/repos/mode', body: { repo: REPO, mode: 'light' } }),
    );
    expect(setLight.status).toBe(200);

    const github = await runOnce(10, gatewayWith([MAINT]));
    // Light surfaces security only; maintainability is suppressed by the mode
    // the API set — proving the write reached the next run.
    expect(github.reviews).toHaveLength(1);
    const bodies = github.reviews[0]!.comments.map((c) => c.body).join('\n');
    expect(bodies).toContain('SQL injection');
    expect(bodies).not.toContain('Unused variable');
  });

  // --- PRD attach via API drives requirement-aware review -------------------

  it('a PRD attached via the API makes the next run requirement-aware', async () => {
    const attach = await api.handle(
      as('admintok', {
        method: 'POST',
        path: '/admin/repos/prd',
        body: { repo: REPO, kind: 'paste', content: 'Users must be authenticated before any query.' },
      }),
    );
    expect(attach.status).toBe(200);

    const gw = gatewayWith([MAINT]);
    gw.registerResponse('prd_extraction', JSON.stringify({ requirements: ['users must be authenticated'] }));
    await runOnce(11, gw, { prd: true });

    // The extracted criteria must reach an agent's DYNAMIC message (not the
    // stable prefix), proving the API-attached PRD drove the review.
    const reviewReqs = gw.requests.filter((r) => r.task_type !== 'prd_extraction');
    expect(reviewReqs.length).toBeGreaterThan(0);
    const sawCriteria = reviewReqs.some((r) => r.messages[1]?.content.includes('users must be authenticated'));
    expect(sawCriteria).toBe(true);
    // GET /admin/repos now reflects the attachment.
    const repos = (await api.handle(as('admintok', { path: '/admin/repos' }))).body as { repos: { prd: { attached: boolean; kind?: string } }[] };
    expect(repos.repos[0]!.prd).toMatchObject({ attached: true, kind: 'paste' });
  });

  // --- Shadow default + activation (FR-SLO-008) -----------------------------

  it('a freshly onboarded repo reviews in shadow until an admin activates it', async () => {
    // Repo is shadow by default → the run is fully validated but never posted.
    const shadowRun = await runOnce(20, gatewayWith([MAINT]));
    expect(shadowRun.reviews).toHaveLength(0);
    const persisted = await pool.query(`SELECT count(*)::int AS n FROM review_findings WHERE repo = $1`, [REPO]);
    expect(persisted.rows[0].n).toBeGreaterThan(0); // guard-checked, just not posted

    // Admin activates → the next run posts for real.
    const activate = await api.handle(as('admintok', { method: 'POST', path: '/admin/repos/activate', body: { repo: REPO } }));
    expect(activate.status).toBe(200);
    expect(activate.body).toEqual({ repo: REPO, shadow: false });

    const liveRun = await runOnce(21, gatewayWith([MAINT]));
    expect(liveRun.reviews.length).toBeGreaterThan(0);
  });

  // --- Expungement (HARD-RULE-047) ------------------------------------------

  it('expungement purges raw PRD content, drops criteria, and tombstones identities', async () => {
    // Seed raw PRD content + an extraction-cache row + an identity-map row.
    await prdSources.setSource({ tenantId: TENANT, repo: REPO, kind: 'paste', ref: 'v1', content: 'secret PRD body' });
    await pool.query(
      `INSERT INTO prd_criteria (criteria_key, tenant_id, repo, source_ref, content_hash, extraction_version, taxonomy_version, criteria)
       VALUES ('k1', $1, $2, 'paste:v1', 'h', 'ex', 'tax', '{}'::jsonb)`,
      [TENANT, REPO],
    );
    await pool.query(
      `INSERT INTO spend_ledger_identity_map (tenant_id, identity_type, raw_identifier_encrypted, hmac_identifier, hmac_key_id)
       VALUES ($1, 'repo', 'ENCRYPTED', 'hmac1', 'key1')`,
      [TENANT],
    );

    const res = await api.handle(as('admintok', { method: 'POST', path: '/admin/expungement', body: {} }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ prdSourcesPurged: 1, prdCriteriaDeleted: 1, identitiesTombstoned: 1 });

    const src = await pool.query(`SELECT content, content_hash FROM prd_sources WHERE tenant_id = $1`, [TENANT]);
    expect(src.rows[0].content).toBeNull();
    expect(src.rows[0].content_hash).toBeNull();
    const crit = await pool.query(`SELECT count(*)::int AS n FROM prd_criteria WHERE tenant_id = $1`, [TENANT]);
    expect(crit.rows[0].n).toBe(0);
    const idmap = await pool.query(`SELECT expunged_at, raw_identifier_encrypted FROM spend_ledger_identity_map WHERE tenant_id = $1`, [TENANT]);
    expect(idmap.rows[0].expunged_at).not.toBeNull();
    expect(idmap.rows[0].raw_identifier_encrypted).toBe('');
    const reqRow = await pool.query(`SELECT status FROM expungement_requests WHERE tenant_id = $1`, [TENANT]);
    expect(reqRow.rows[0].status).toBe('COMPLETED');
  });
});
