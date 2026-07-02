import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  evaluatePostingGuard,
  PrRunCoordinator,
} from '../../apps/ci-review-bot/src/concurrency/pr-run-coordinator.js';
import { setupDb, truncateAll } from './helpers.js';

/**
 * Durable fencing authority tests — HARD-RULE-032/033, FR-FENCE-011..019,
 * concurrency tests C-001..C-004 (§30.2).
 */
describe('durable Postgres fencing', () => {
  let pool: pg.Pool;
  let coordinator: PrRunCoordinator;

  beforeAll(async () => {
    pool = await setupDb();
    coordinator = new PrRunCoordinator(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
  });

  const pr = { tenantId: 't1', repo: 'org/proj', pullRequestId: 7 };

  it('FR-FENCE-016: run_epoch is monotonic in Postgres', async () => {
    const r1 = await coordinator.startRun({ ...pr, headSha: 'sha-a' });
    const r2 = await coordinator.startRun({ ...pr, headSha: 'sha-b' });
    const r3 = await coordinator.startRun({ ...pr, headSha: 'sha-c' });
    expect(r1.run.runEpoch).toBe(1);
    expect(r2.run.runEpoch).toBe(2);
    expect(r3.run.runEpoch).toBe(3);
  });

  it('C-001/C-004: newer SHA supersedes older run; stale run fails the posting guard', async () => {
    const runA = await coordinator.startRun({ ...pr, headSha: 'commit-A' });
    const runB = await coordinator.startRun({ ...pr, headSha: 'commit-B' });
    expect(runB.supersededRunId).toBe(runA.run.runId);

    const durable = await coordinator.readDurableFencing(pr.tenantId, pr.repo, pr.pullRequestId);
    const staleGuard = evaluatePostingGuard(runA.run, durable, 'ACTIVE');
    expect(staleGuard.allowed).toBe(false);
    expect(staleGuard.reason).toContain('mismatch');

    const currentGuard = evaluatePostingGuard(runB.run, durable, 'ACTIVE');
    expect(currentGuard.allowed).toBe(true);
  });

  it('superseded run is marked stale-discarded and no longer current (FR-PRC-008..010)', async () => {
    const runA = await coordinator.startRun({ ...pr, headSha: 'commit-A' });
    await coordinator.startRun({ ...pr, headSha: 'commit-B' });
    const row = await pool.query('SELECT status, is_current FROM review_runs WHERE run_id = $1', [
      runA.run.runId,
    ]);
    expect(row.rows[0]).toEqual({ status: 'STALE_DISCARDED', is_current: false });
    const current = await pool.query(
      `SELECT count(*)::int AS n FROM review_runs
        WHERE tenant_id = $1 AND repo = $2 AND pull_request_id = $3 AND is_current`,
      [pr.tenantId, pr.repo, pr.pullRequestId],
    );
    expect(current.rows[0].n).toBe(1); // FR-PRC-002
  });

  it('HARD-RULE-033: missing durable state fails the posting guard closed', () => {
    const orphanRun = {
      tenantId: 't1',
      repo: 'org/proj',
      pullRequestId: 99,
      headSha: 'sha-x',
      runId: 'run-x',
      runEpoch: 1,
    };
    const guard = evaluatePostingGuard(orphanRun, null, 'ACTIVE');
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toContain('fail closed');
  });

  it('G37: non-ACTIVE integration status blocks posting', async () => {
    const r = await coordinator.startRun({ ...pr, headSha: 'sha-a' });
    const durable = await coordinator.readDurableFencing(pr.tenantId, pr.repo, pr.pullRequestId);
    const guard = evaluatePostingGuard(r.run, durable, 'REVOKED');
    expect(guard.allowed).toBe(false);
  });

  it('FR-FENCE-017: fencing survives without any Redis involvement (Postgres-only path)', async () => {
    // The coordinator never touches Redis: epochs continue across simulated
    // total hot-path loss because the authority is Postgres.
    const r1 = await coordinator.startRun({ ...pr, headSha: 'sha-a' });
    const r2 = await coordinator.startRun({ ...pr, headSha: 'sha-b' });
    expect(r2.run.runEpoch).toBe(r1.run.runEpoch + 1);
  });

  it('concurrent startRun calls for the same PR serialize with unique epochs', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => coordinator.startRun({ ...pr, headSha: `sha-${i}` })),
    );
    const epochs = results.map((r) => r.run.runEpoch).sort((a, b) => a - b);
    expect(epochs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
