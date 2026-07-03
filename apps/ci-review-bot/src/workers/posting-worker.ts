import type { ReviewFinding, RunIdentity } from '@review-bot/shared';
import type { PrRunCoordinator } from '../concurrency/pr-run-coordinator.js';
import type { GitHubAdapter } from '../adapters/github.adapter.js';
import { PendingPostStore, type PendingPostRow } from '../outbox/pending-post-store.js';
import { executePost, type PostingPolicy } from '../workflows/post-comments.workflow.js';

/**
 * Posting worker — drains the durable pending-post outbox.
 *
 * Every execution is gated on the exclusive Postgres row claim
 * (HARD-RULE-016/017); before any retry the marker scan and durable fencing
 * guard re-run inside executePost (FR-POST-040/055). Redis wakeups are an
 * optimization only — this loop is correct on a plain interval.
 */

export interface PostingWorkerDeps {
  pendingPosts: PendingPostStore;
  coordinator: PrRunCoordinator;
  github: GitHubAdapter;
  postingPolicy: PostingPolicy;
  workerId: string;
  maxRetries: number;
  lockTtlSeconds: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

interface StoredPayload {
  inline: ReviewFinding[];
  summaryOnly: ReviewFinding[];
  fingerprint: string;
}

export class PostingWorker {
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;

  constructor(private readonly deps: PostingWorkerDeps) {
    this.log = deps.log ?? ((msg, fields) => console.log(msg, fields ?? ''));
  }

  /** Startup recovery scan (FR-POST-039) — logs eligible rows, claims lazily. */
  async recoverOnStartup(): Promise<number> {
    const recoverable = await this.deps.pendingPosts.listRecoverable();
    if (recoverable.length > 0) {
      this.log('ci_review.pending_post.recovered', { count: recoverable.length });
    }
    return recoverable.length;
  }

  /** One drain pass: claims and executes up to `limit` pending posts. */
  async tick(limit = 5): Promise<number> {
    let processed = 0;
    for (; processed < limit; processed++) {
      const row = await this.deps.pendingPosts.claimNextPendingPost(
        this.deps.workerId,
        this.deps.lockTtlSeconds,
      );
      if (!row) break;
      await this.executeClaimed(row);
    }
    return processed;
  }

  private async executeClaimed(row: PendingPostRow): Promise<void> {
    // FR-POST-048: re-verify claim ownership immediately before acting.
    const owned = await this.deps.pendingPosts.assertClaimOwnership(
      row.pendingPostId,
      this.deps.workerId,
    );
    if (!owned) return;

    const run: RunIdentity = {
      tenantId: row.tenantId,
      repo: row.repo,
      pullRequestId: row.pullRequestId,
      headSha: row.headSha,
      runId: row.runId,
      runEpoch: row.runEpoch,
    };
    const payload = row.commentPayload as StoredPayload;

    try {
      const outcome = await executePost(
        run,
        payload.inline,
        payload.summaryOnly,
        payload.fingerprint ?? row.commentFingerprint,
        this.deps.postingPolicy,
        {
          github: this.deps.github,
          coordinator: this.deps.coordinator,
          pendingPosts: this.deps.pendingPosts,
        },
        row.pendingPostId,
      );

      switch (outcome.kind) {
        case 'posted':
          await this.deps.pendingPosts.markPosted(row.pendingPostId, this.deps.workerId, outcome.commentId);
          break;
        case 'already_posted':
          // FR-POST-056: fingerprint found on GitHub — POSTED without reposting.
          await this.deps.pendingPosts.markPosted(row.pendingPostId, this.deps.workerId, outcome.commentId);
          break;
        case 'stale_discarded':
          await this.deps.pendingPosts.transitionStatus(row.pendingPostId, 'STALE_DISCARDED');
          break;
        case 'blocked':
          // FR-POST-063: severed integrations block, never retry indefinitely.
          await this.deps.pendingPosts.transitionStatus(row.pendingPostId, 'BLOCKED');
          break;
        case 'backoff_queued':
          await this.scheduleOrFail(row);
          break;
      }
      this.log('ci_review.pending_post.executed', {
        pendingPostId: row.pendingPostId,
        outcome: outcome.kind,
      });
    } catch (err) {
      // Ambiguous failure: the next attempt re-runs the marker scan, which
      // resolves whether the POST landed (FR-POST-051/052).
      this.log('ci_review.pending_post.retry_scheduled', {
        pendingPostId: row.pendingPostId,
        error: String(err),
      });
      await this.scheduleOrFail(row);
    }
  }

  private async scheduleOrFail(row: PendingPostRow): Promise<void> {
    if (row.retryCount + 1 >= this.deps.maxRetries) {
      // FR-POST-018: retry exhaustion → FAILED (never silently dropped;
      // the row and its findings remain durably recorded).
      await this.deps.pendingPosts.transitionStatus(row.pendingPostId, 'FAILED', {
        code: 'RETRY_EXHAUSTED',
        message: `retry count ${row.retryCount + 1} reached max ${this.deps.maxRetries}`,
      });
      return;
    }
    const backoffSeconds = Math.min(15 * 2 ** row.retryCount, 300);
    await this.deps.pendingPosts.scheduleRetry(
      row.pendingPostId,
      new Date(Date.now() + backoffSeconds * 1000),
    );
  }
}
