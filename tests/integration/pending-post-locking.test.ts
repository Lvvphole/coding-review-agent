import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { PendingPostStore } from '../../apps/ci-review-bot/src/outbox/pending-post-store.js';
import { setupDb, truncateAll } from './helpers.js';

/**
 * Pending-post recovery and distributed locking — PRD v6.5 §30 PPOST series,
 * HARD-RULE-015/016/017.
 */
describe('pending post outbox: distributed claims', () => {
  let pool: pg.Pool;
  let store: PendingPostStore;

  beforeAll(async () => {
    pool = await setupDb();
    store = new PendingPostStore(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
  });

  const basePost = {
    tenantId: 't1',
    repo: 'org/proj',
    pullRequestId: 7,
    runId: '11111111-1111-4111-8111-111111111111',
    runEpoch: 1,
    headSha: 'sha-a',
    findingIds: ['f1'],
    commentPayload: { inline: [], summaryOnly: [], fingerprint: 'fp' },
    postingStrategy: 'batched_review' as const,
    commentFingerprint: 'fp-1',
    expireAfterHours: 24,
  };

  it('PPOST-001: pending post is durably written and recoverable', async () => {
    const id = await store.createPendingPost(basePost);
    const recoverable = await store.listRecoverable();
    expect(recoverable.map((r) => r.pendingPostId)).toEqual([id]);
  });

  it('PPOST-009/010: N concurrent workers — exactly one claims the row (FORBIDDEN-032)', async () => {
    await store.createPendingPost(basePost);
    const claims = await Promise.all(
      Array.from({ length: 3 }, (_, i) => store.claimNextPendingPost(`worker-${i}`)),
    );
    const successful = claims.filter((c) => c !== null);
    expect(successful).toHaveLength(1);
    expect(successful[0]!.postStatus).toBe('POSTING'); // PPOST-011 / FR-POST-046
  });

  it('FR-POST-048: only the claim owner passes ownership assertion', async () => {
    await store.createPendingPost(basePost);
    const claimed = await store.claimNextPendingPost('worker-a');
    expect(claimed).not.toBeNull();
    expect(await store.assertClaimOwnership(claimed!.pendingPostId, 'worker-a')).toBe(true);
    expect(await store.assertClaimOwnership(claimed!.pendingPostId, 'worker-b')).toBe(false);
  });

  it('PPOST-012/013: expired claim is reclaimable by another worker (FR-POST-050)', async () => {
    await store.createPendingPost(basePost);
    const first = await store.claimNextPendingPost('worker-a', 0); // TTL 0 = instantly expired
    expect(first).not.toBeNull();
    // worker-a crashed; its claim has expired.
    const second = await store.claimNextPendingPost('worker-b', 120);
    expect(second).not.toBeNull();
    expect(second!.pendingPostId).toBe(first!.pendingPostId);
    expect(second!.workerId).toBe('worker-b');
    expect(await store.assertClaimOwnership(first!.pendingPostId, 'worker-a')).toBe(false);
  });

  it('an unexpired POSTING claim is not stealable', async () => {
    await store.createPendingPost(basePost);
    const first = await store.claimNextPendingPost('worker-a', 120);
    expect(first).not.toBeNull();
    const thief = await store.claimNextPendingPost('worker-b', 120);
    expect(thief).toBeNull();
  });

  it('PPOST-008: retry scheduling returns the row to BACKOFF with incremented count', async () => {
    const id = await store.createPendingPost(basePost);
    const claimed = await store.claimNextPendingPost('worker-a');
    expect(claimed).not.toBeNull();
    await store.scheduleRetry(id, new Date(Date.now() - 1000));
    const reclaimed = await store.claimNextPendingPost('worker-b');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.retryCount).toBe(1);
  });

  it('PPOST-014 setup: POSTED rows are never re-claimed', async () => {
    const id = await store.createPendingPost(basePost);
    const claimed = await store.claimNextPendingPost('worker-a');
    await store.markPosted(id, 'worker-a', 'gh-comment-1');
    expect(claimed).not.toBeNull();
    expect(await store.claimNextPendingPost('worker-b')).toBeNull();
  });

  it('FR-GH-046/047: PR close cascades PENDING/BACKOFF rows', async () => {
    await store.createPendingPost(basePost);
    await store.createPendingPost({ ...basePost, commentFingerprint: 'fp-2' });
    const n = await store.cancelForPullRequest('t1', 'org/proj', 7, 'CANCELLED');
    expect(n).toBe(2);
    expect(await store.claimNextPendingPost('worker-a')).toBeNull();
  });

  it('FR-POST-063: severed integration blocks pending posts instead of retrying', async () => {
    await store.createPendingPost(basePost);
    const n = await store.blockForTenant('t1');
    expect(n).toBe(1);
    expect(await store.claimNextPendingPost('worker-a')).toBeNull();
  });
});
