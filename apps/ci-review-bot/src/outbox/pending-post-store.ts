import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PendingPostStatus } from '@review-bot/shared';

/**
 * Durable pending-post outbox — PRD v6.5 §15.6.
 *
 * HARD-RULE-015: pending posts are durably persisted before the run is
 * considered safely backoff-queued.
 * HARD-RULE-016/017: execution requires an exclusive Postgres row claim
 * (SELECT ... FOR UPDATE SKIP LOCKED, id="pending-post-claim-sql-v65");
 * Redis may wake workers but never authorizes execution.
 */

export interface PendingPostRow {
  pendingPostId: string;
  tenantId: string;
  repo: string;
  pullRequestId: number;
  runId: string;
  runEpoch: number;
  headSha: string;
  findingIds: string[];
  commentPayload: unknown;
  postingStrategy: string;
  postStatus: PendingPostStatus;
  retryCount: number;
  commentFingerprint: string;
  idempotencyKey: string;
  workerId: string | null;
  lockExpiresAt: Date | null;
  githubCommentId: string | null;
}

function mapRow(r: Record<string, unknown>): PendingPostRow {
  return {
    pendingPostId: r['pending_post_id'] as string,
    tenantId: r['tenant_id'] as string,
    repo: r['repo'] as string,
    pullRequestId: Number(r['pull_request_id']),
    runId: r['run_id'] as string,
    runEpoch: Number(r['run_epoch']),
    headSha: r['head_sha'] as string,
    findingIds: r['finding_ids'] as string[],
    commentPayload: r['comment_payload'],
    postingStrategy: r['posting_strategy'] as string,
    postStatus: r['post_status'] as PendingPostStatus,
    retryCount: Number(r['retry_count']),
    commentFingerprint: r['comment_fingerprint'] as string,
    idempotencyKey: r['idempotency_key'] as string,
    workerId: (r['worker_id'] as string | null) ?? null,
    lockExpiresAt: (r['lock_expires_at'] as Date | null) ?? null,
    githubCommentId: (r['github_comment_id'] as string | null) ?? null,
  };
}

export class PendingPostStore {
  constructor(private readonly pool: Pool) {}

  /**
   * FR-POST-036/038: durable write; the caller may only transition the run to
   * GH_RATE_LIMIT_BACKOFF after this resolves.
   */
  async createPendingPost(input: {
    tenantId: string;
    repo: string;
    pullRequestId: number;
    runId: string;
    runEpoch: number;
    headSha: string;
    findingIds: string[];
    commentPayload: unknown;
    postingStrategy: 'batched_review' | 'single_comment';
    commentFingerprint: string;
    expireAfterHours: number;
    nextRetryAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO pending_review_posts
         (pending_post_id, tenant_id, repo, pull_request_id, run_id, run_epoch, head_sha,
          finding_ids, comment_payload, posting_strategy, post_status, next_retry_at,
          expires_at, idempotency_key, comment_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', $11,
               now() + make_interval(hours => $12), $13, $14)`,
      [
        id,
        input.tenantId,
        input.repo,
        input.pullRequestId,
        input.runId,
        input.runEpoch,
        input.headSha,
        input.findingIds,
        JSON.stringify(input.commentPayload),
        input.postingStrategy,
        input.nextRetryAt ?? new Date(),
        input.expireAfterHours,
        `${input.runId}:${input.commentFingerprint}`,
        input.commentFingerprint,
      ],
    );
    return id;
  }

  /**
   * Exclusive claim — required SQL pattern id="pending-post-claim-sql-v65".
   * The claim and the PENDING/BACKOFF → POSTING transition happen in the same
   * statement (FR-POST-045/046). Expired claims are reclaimable because the
   * lock only excludes rows currently locked by a live transaction plus rows
   * already in POSTING with an unexpired lock_expires_at (FR-POST-050).
   */
  async claimNextPendingPost(workerId: string, lockTtlSeconds = 120): Promise<PendingPostRow | null> {
    const res = await this.pool.query(
      `WITH next_post AS (
         SELECT pending_post_id
           FROM pending_review_posts
          WHERE (
                  post_status IN ('PENDING', 'BACKOFF')
                  OR (post_status = 'POSTING' AND lock_expires_at < now())
                )
            AND next_retry_at <= now()
            AND expires_at > now()
          ORDER BY next_retry_at ASC
            FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE pending_review_posts p
          SET post_status = 'POSTING',
              worker_id = $1,
              locked_at = now(),
              lock_expires_at = now() + make_interval(secs => $2),
              claim_attempt_count = claim_attempt_count + 1,
              updated_at = now()
         FROM next_post
        WHERE p.pending_post_id = next_post.pending_post_id
        RETURNING p.*`,
      [workerId, lockTtlSeconds],
    );
    if (res.rowCount === 0) return null;
    return mapRow(res.rows[0]);
  }

  /**
   * FR-POST-048: only the current unexpired claim owner may act on the row.
   */
  async assertClaimOwnership(pendingPostId: string, workerId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM pending_review_posts
        WHERE pending_post_id = $1 AND worker_id = $2 AND lock_expires_at > now()`,
      [pendingPostId, workerId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** FR-POST-049: successful publication. */
  async markPosted(pendingPostId: string, workerId: string, githubCommentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_review_posts
          SET post_status = 'POSTED', github_comment_id = $3, posted_at = now(), updated_at = now()
        WHERE pending_post_id = $1 AND worker_id = $2`,
      [pendingPostId, workerId, githubCommentId],
    );
  }

  async transitionStatus(
    pendingPostId: string,
    status: PendingPostStatus,
    error?: { code: string; message: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE pending_review_posts
          SET post_status = $2,
              last_error_code = COALESCE($3, last_error_code),
              last_error_message = COALESCE($4, last_error_message),
              updated_at = now()
        WHERE pending_post_id = $1`,
      [pendingPostId, status, error?.code ?? null, error?.message ?? null],
    );
  }

  /** Reschedules a retryable failure with backoff (FR-POST-044). */
  async scheduleRetry(pendingPostId: string, nextRetryAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE pending_review_posts
          SET post_status = 'BACKOFF', retry_count = retry_count + 1,
              next_retry_at = $2, worker_id = NULL, locked_at = NULL,
              lock_expires_at = NULL, updated_at = now()
        WHERE pending_post_id = $1`,
      [pendingPostId, nextRetryAt],
    );
  }

  /**
   * FR-GH-046/047: PR close/merge/supersession cascades to the outbox.
   */
  async cancelForPullRequest(
    tenantId: string,
    repo: string,
    pullRequestId: number,
    to: 'CANCELLED' | 'STALE_DISCARDED',
  ): Promise<number> {
    const res = await this.pool.query(
      `UPDATE pending_review_posts
          SET post_status = $4, updated_at = now()
        WHERE tenant_id = $1 AND repo = $2 AND pull_request_id = $3
          AND post_status IN ('PENDING', 'BACKOFF', 'POSTING')`,
      [tenantId, repo, pullRequestId, to],
    );
    return res.rowCount ?? 0;
  }

  /** FR-POST-063: severed integrations block pending posts. */
  async blockForTenant(tenantId: string): Promise<number> {
    const res = await this.pool.query(
      `UPDATE pending_review_posts
          SET post_status = 'BLOCKED', updated_at = now()
        WHERE tenant_id = $1 AND post_status IN ('PENDING', 'BACKOFF')`,
      [tenantId],
    );
    return res.rowCount ?? 0;
  }

  /** Startup recovery scan (FR-POST-039) — returns eligible rows for rehydration. */
  async listRecoverable(limit = 100): Promise<PendingPostRow[]> {
    const res = await this.pool.query(
      `SELECT * FROM pending_review_posts
        WHERE post_status IN ('PENDING', 'BACKOFF') AND expires_at > now()
        ORDER BY next_retry_at ASC
        LIMIT $1`,
      [limit],
    );
    return res.rows.map(mapRow);
  }
}
