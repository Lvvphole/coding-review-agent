import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { StubGatewayClient } from '@review-bot/llm-client';
import { createDiffReviewerAgent, STABLE_REVIEW_PREFIX } from '@review-bot/agent-core';
import type { RunIdentity } from '@review-bot/shared';
import { PrdExtractor } from '../../apps/ci-review-bot/src/prd/prd-extractor.js';
import { PrdSourceStore, PrdResolver } from '../../apps/ci-review-bot/src/prd/prd-store.js';
import { ManagedPrdContextProvider } from '../../apps/ci-review-bot/src/prd/prd-context-provider.js';
import { setupDb, truncateAll } from './helpers.js';

/**
 * PRD ingestion (Sprint 8, HARD-RULE-UX-004). Extraction routes through the
 * Gateway (task_type=prd_extraction), is content-addressed (cache hit unless
 * the PRD changes), map-reduces oversized PRDs, and injects criteria as
 * DYNAMIC agent context. No PRD → general-review fallback.
 */

const RUN: RunIdentity = {
  tenantId: 'inst_1',
  repo: 'acme/web',
  pullRequestId: 7,
  headSha: 'sha-a',
  runId: 'run-1',
  runEpoch: 1,
};
const OPTS = { taxonomyVersion: 'tax-v1', maxBytes: 24000, maxChunks: 8 };

describe('PRD ingestion', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await setupDb();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
  });

  it('routes extraction through the Gateway with task_type=prd_extraction', async () => {
    const gw = new StubGatewayClient();
    gw.registerResponse('prd_extraction', JSON.stringify({ requirements: ['R2', 'R1'] }));
    const ex = new PrdExtractor(pool, gw, OPTS);

    const res = await ex.extract(RUN, 'PRD body', 'paste:v1');
    expect(res.cached).toBe(false);
    expect(res.criteria.requirements).toEqual(['R1', 'R2']); // deterministic sort
    expect(gw.requests).toHaveLength(1);
    expect(gw.requests[0]!.task_type).toBe('prd_extraction');
    expect(gw.requests[0]!.data_class).toBe('confidential');

    // Durable content-addressed row.
    const row = await pool.query(`SELECT criteria_key FROM prd_criteria`);
    expect(row.rowCount).toBe(1);
  });

  it('is content-addressed: unchanged PRD hits cache; an edit re-extracts', async () => {
    const gw = new StubGatewayClient();
    gw.registerResponse('prd_extraction', JSON.stringify({ requirements: ['R1'] }));
    const ex = new PrdExtractor(pool, gw, OPTS);

    const first = await ex.extract(RUN, 'PRD body', 'paste:v1');
    expect(first.cached).toBe(false);
    const second = await ex.extract(RUN, 'PRD body', 'paste:v1');
    expect(second.cached).toBe(true);
    expect(gw.requests).toHaveLength(1); // no re-call on cache hit

    // PM edits the PRD → new content hash → cache miss → re-extract.
    gw.registerResponse('prd_extraction', JSON.stringify({ requirements: ['R9'] }));
    const edited = await ex.extract(RUN, 'PRD body EDITED', 'paste:v1');
    expect(edited.cached).toBe(false);
    expect(edited.criteria.requirements).toEqual(['R9']);
    expect(gw.requests).toHaveLength(2);
  });

  it('map-reduces an oversized PRD: one call per chunk, deterministic union', async () => {
    const gw = new StubGatewayClient();
    gw.registerResponse('prd_extraction', JSON.stringify({ requirements: ['A'] }));
    gw.registerResponse('prd_extraction', JSON.stringify({ requirements: ['B'] }));
    const ex = new PrdExtractor(pool, gw, { ...OPTS, maxBytes: 20, maxChunks: 8 });

    const text = '# One\n' + 'x'.repeat(15) + '\n# Two\n' + 'y'.repeat(15);
    const res = await ex.extract(RUN, text, 'paste:big');
    expect(gw.requests.length).toBeGreaterThanOrEqual(2);
    gw.requests.forEach((r) => expect(r.task_type).toBe('prd_extraction'));
    expect(res.criteria.requirements).toEqual(['A', 'B']); // reduce = union
  });

  it('over-budget PRD keeps the head and flags truncation (never silent drop)', async () => {
    const gw = new StubGatewayClient();
    gw.registerResponse('prd_extraction', JSON.stringify({ requirements: ['head'] }));
    const ex = new PrdExtractor(pool, gw, { ...OPTS, maxBytes: 20, maxChunks: 1 });

    const text = '# One\n' + 'x'.repeat(30) + '\n# Two\n' + 'y'.repeat(30);
    const res = await ex.extract(RUN, text, 'paste:huge');
    expect(gw.requests).toHaveLength(1); // capped to maxChunks
    expect(res.criteria.truncated).toBe(true);
    const row = await pool.query(`SELECT truncated FROM prd_criteria`);
    expect(row.rows[0].truncated).toBe(true);
  });

  it('PrdResolver: paste content resolves; expired is treated as absent', async () => {
    const store = new PrdSourceStore(pool);
    const resolver = new PrdResolver(store);
    expect(await resolver.resolve(RUN)).toBeNull(); // no source → fallback

    await store.setSource({ tenantId: RUN.tenantId, repo: RUN.repo, kind: 'paste', ref: 'v1', content: 'PRD body' });
    expect((await resolver.resolve(RUN))?.text).toBe('PRD body');

    await pool.query(`UPDATE prd_sources SET expires_at = now() - interval '1 hour'`);
    expect(await resolver.resolve(RUN)).toBeNull(); // retention TTL elapsed
  });

  it('PrdResolver: repo_path is read at the PR head SHA via the injected reader', async () => {
    const store = new PrdSourceStore(pool);
    const reader = {
      async read(repo: string, path: string, ref: string): Promise<string | null> {
        return repo === 'acme/web' && path === 'docs/PRD.md' && ref === 'sha-a' ? 'FILE PRD' : null;
      },
    };
    const resolver = new PrdResolver(store, reader);
    await store.setSource({ tenantId: RUN.tenantId, repo: RUN.repo, kind: 'repo_path', ref: 'docs/PRD.md' });
    const r = await resolver.resolve(RUN);
    expect(r?.text).toBe('FILE PRD');
    expect(r?.sourceRef).toContain('@sha-a'); // fenced at head SHA
  });

  it('injects PRD criteria as DYNAMIC agent context (never the stable prefix)', async () => {
    const store = new PrdSourceStore(pool);
    await store.setSource({ tenantId: RUN.tenantId, repo: RUN.repo, kind: 'paste', ref: 'v1', content: 'PRD body' });

    const extractGw = new StubGatewayClient();
    extractGw.registerResponse('prd_extraction', JSON.stringify({ requirements: ['users must be authenticated'] }));
    const provider = new ManagedPrdContextProvider(
      new PrdResolver(store),
      new PrdExtractor(pool, extractGw, OPTS),
    );
    const prd = await provider.provide(RUN);
    expect(prd).not.toBeNull();
    expect(prd!.context).toContain('users must be authenticated');

    // The rendered context must reach the agent's DYNAMIC user message.
    const agentGw = new StubGatewayClient();
    agentGw.registerResponse('code_review', '[]');
    await createDiffReviewerAgent(agentGw).run({
      run: RUN,
      files: [],
      diffText: 'diff',
      chunks: [],
      stablePrefix: STABLE_REVIEW_PREFIX,
      prdCriteria: prd!.context,
      cancellation: new AbortController().signal,
    });
    const req = agentGw.requests[0]!;
    expect(req.messages[1]!.content).toContain('users must be authenticated'); // dynamic
    expect(req.messages[0]!.content).not.toContain('users must be authenticated'); // not stable prefix
  });

  it('no PRD → provider returns null (general-review fallback)', async () => {
    const provider = new ManagedPrdContextProvider(
      new PrdResolver(new PrdSourceStore(pool)),
      new PrdExtractor(pool, new StubGatewayClient(), OPTS),
    );
    expect(await provider.provide(RUN)).toBeNull();
  });
});
