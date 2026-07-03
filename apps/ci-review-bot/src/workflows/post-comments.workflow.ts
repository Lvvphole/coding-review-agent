import {
  commentFingerprint,
  parseMarker,
  renderMarker,
  type ReviewFinding,
  type RunIdentity,
} from '@review-bot/shared';
import { redactOutboundComment, selectComments } from '@review-bot/validators';
import {
  GitHubIntegrationSeveredError,
  GitHubRateLimitError,
  type GitHubAdapter,
} from '../adapters/github.adapter.js';
import {
  evaluatePostingGuard,
  type FencingSnapshot,
  type PrRunCoordinator,
} from '../concurrency/pr-run-coordinator.js';
import type { PendingPostStore } from '../outbox/pending-post-store.js';

/**
 * Posting workflow — the correctness-critical tail of the review pipeline.
 *
 * Order of operations:
 *  1. Deterministic comment selection under max_inline_comments (HARD-RULE-043)
 *  2. Outbound secret redaction on every body (HARD-RULE-038, G41)
 *  3. Posting guard against durable fencing authority (HARD-RULE-001/032/033)
 *  4. Marker scan before ambiguous retry (HARD-RULE-035, FR-POST-055/056)
 *  5. Batched review submission (FR-POST-068)
 *  6. Rate limit → durable pending post BEFORE backoff transition (HARD-RULE-015)
 *  7. Post-flight stale reconciliation trigger (HARD-RULE-018, FR-POST-022)
 */

export interface PostingPolicy {
  maxInlineComments: number;
  pendingPostExpireAfterHours: number;
  tenantSecret: string;
  integrationStatus: string;
}

export type PostOutcome =
  | { kind: 'posted'; commentId: string; postFlightStale: boolean }
  | { kind: 'stale_discarded'; reason: string }
  | { kind: 'backoff_queued'; pendingPostId: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'already_posted'; commentId: string };

export interface PostDependencies {
  github: GitHubAdapter;
  coordinator: PrRunCoordinator;
  pendingPosts: PendingPostStore;
}

export function buildReviewBody(
  run: RunIdentity,
  inline: ReviewFinding[],
  summaryOnly: ReviewFinding[],
  fingerprint: string,
  pendingPostId: string,
): { body: string; comments: { path: string; line: number; body: string }[] } {
  const marker = renderMarker({
    tenantId: run.tenantId,
    repo: run.repo,
    pullRequestId: run.pullRequestId,
    runId: run.runId,
    runEpoch: run.runEpoch,
    headSha: run.headSha,
    pendingPostId,
    findingId: 'batch',
    commentFingerprint: fingerprint,
  });

  const summaryLines = [
    `## AI Code Review`,
    ``,
    `${inline.length} inline finding(s); ${summaryOnly.length} additional lower-priority finding(s).`,
    ...summaryOnly.map((f) => `- **${f.severity}** \`${f.file}:${f.line}\` — ${f.title}`),
    ``,
    marker,
  ];

  const comments = inline.map((f) => {
    const perFindingMarker = renderMarker({
      tenantId: run.tenantId,
      repo: run.repo,
      pullRequestId: run.pullRequestId,
      runId: run.runId,
      runEpoch: run.runEpoch,
      headSha: run.headSha,
      pendingPostId,
      findingId: f.finding_id,
      commentFingerprint: fingerprint,
    });
    const bodyLines = [
      `**[${f.severity}] ${f.title}**`,
      ``,
      f.recommendation,
      ``,
      `Evidence: \`${f.evidence}\``,
      ...(f.suggested_patch ? ['', '```suggestion', f.suggested_patch, '```'] : []),
      ``,
      perFindingMarker,
    ];
    return { path: f.file, line: f.line, body: bodyLines.join('\n') };
  });

  return { body: summaryLines.join('\n'), comments };
}

export async function postFindings(
  run: RunIdentity,
  validatedFindings: ReviewFinding[],
  policy: PostingPolicy,
  deps: PostDependencies,
): Promise<PostOutcome> {
  const { inline, summaryOnly } = selectComments(validatedFindings, policy.maxInlineComments);

  // Batch fingerprint is anchored to the first (highest-priority) finding so
  // it is stable for the same finding set and code state (FR-POST-062).
  const anchor = inline[0] ?? summaryOnly[0];
  if (!anchor) return { kind: 'blocked', reason: 'no findings to post' };
  const fingerprint = commentFingerprint(policy.tenantSecret, {
    tenantId: run.tenantId,
    repo: run.repo,
    pullRequestId: run.pullRequestId,
    headSha: run.headSha,
    runEpoch: run.runEpoch,
    findingId: anchor.finding_id,
    file: anchor.file,
    line: anchor.line,
    rootCauseId: anchor.root_cause_id,
  });

  return executePost(run, inline, summaryOnly, fingerprint, policy, deps, null);
}

/** Shared by first-attempt posting and pending-post retry execution. */
export async function executePost(
  run: RunIdentity,
  inline: ReviewFinding[],
  summaryOnly: ReviewFinding[],
  fingerprint: string,
  policy: PostingPolicy,
  deps: PostDependencies,
  existingPendingPostId: string | null,
): Promise<PostOutcome> {
  // Posting guard against durable authority — fail closed on missing state.
  const durable = await readDurable(run, deps);
  const guard = evaluatePostingGuard(run, durable, policy.integrationStatus);
  if (!guard.allowed) {
    const missingState = durable === null;
    return missingState && policy.integrationStatus === 'ACTIVE'
      ? { kind: 'blocked', reason: guard.reason }
      : { kind: 'stale_discarded', reason: guard.reason };
  }

  // Marker scan before any ambiguous retry (FR-POST-055/056): if a comment
  // with this fingerprint already exists, we are already posted.
  const existing = await deps.github.listBotComments(run.repo, run.pullRequestId);
  for (const comment of existing) {
    const marker = parseMarker(comment.body);
    if (marker?.commentFingerprint === fingerprint) {
      return { kind: 'already_posted', commentId: comment.commentId };
    }
  }

  const pendingPostId = existingPendingPostId ?? cryptoRandomId();
  const { body, comments } = buildReviewBody(run, inline, summaryOnly, fingerprint, pendingPostId);

  // Outbound redaction — every body, including inline bodies (FR-SEC-015/018).
  const redactedBody = redactOutboundComment(body);
  const redactedComments = comments.map((c) => ({ ...c, body: redactOutboundComment(c.body).body }));

  try {
    const posted = await deps.github.submitReview({
      repo: run.repo,
      pullRequestId: run.pullRequestId,
      commitSha: run.headSha,
      body: redactedBody.body,
      comments: redactedComments,
    });

    // Post-flight stale reconciliation (HARD-RULE-018, FR-POST-022/023).
    const currentSha = await deps.github.getCurrentHeadSha(run.repo, run.pullRequestId);
    const postFlightStale = currentSha !== '' && currentSha !== run.headSha;
    return { kind: 'posted', commentId: posted.commentId, postFlightStale };
  } catch (err) {
    if (err instanceof GitHubIntegrationSeveredError) {
      // FORBIDDEN-037: severance never enters rate-limit backoff.
      return { kind: 'blocked', reason: err.message };
    }
    if (err instanceof GitHubRateLimitError) {
      // HARD-RULE-015: durable write FIRST; only then is backoff safe.
      const retryAt = new Date(Date.now() + (err.retryAfterSeconds ?? 15) * 1000);
      const id =
        existingPendingPostId ??
        (await deps.pendingPosts.createPendingPost({
          tenantId: run.tenantId,
          repo: run.repo,
          pullRequestId: run.pullRequestId,
          runId: run.runId,
          runEpoch: run.runEpoch,
          headSha: run.headSha,
          findingIds: [...inline, ...summaryOnly].map((f) => f.finding_id),
          commentPayload: { inline, summaryOnly, fingerprint },
          postingStrategy: 'batched_review',
          commentFingerprint: fingerprint,
          expireAfterHours: policy.pendingPostExpireAfterHours,
          nextRetryAt: retryAt,
        }));
      return { kind: 'backoff_queued', pendingPostId: id };
    }
    // Ambiguous failure (e.g. connection reset after POST accepted): the next
    // retry re-runs the marker scan, which resolves whether it landed.
    throw err;
  }
}

export type ReconcileAction = 'deleted_or_minimized' | 'preserved_marked' | 'preserved_unknown';

/**
 * Post-flight stale comment reconciliation — HARD-RULE-018/019,
 * FR-POST-024/025/031..035 (tests RACE-002/003/004).
 *
 * Automation may correct its own stale output; it may never destroy human
 * discussion: delete/minimize only when reply_count == 0, mark
 * [Outdated Code State] when replies exist, preserve when unknown.
 */
export async function reconcileOrphanedComment(
  run: RunIdentity,
  comment: { commentId: string; body: string; nodeId?: string },
  github: Pick<GitHubAdapter, 'getReplyCount' | 'minimizeComment' | 'appendOutdatedMarker'>,
): Promise<ReconcileAction> {
  const replyCount = await github.getReplyCount(run.repo, run.pullRequestId, comment.commentId);
  if (replyCount === null) {
    // FR-POST-034: cannot determine → preserve-not-delete.
    return 'preserved_unknown';
  }
  if (replyCount > 0) {
    // FR-POST-032/033: never delete; mark and preserve the thread.
    await github.appendOutdatedMarker(run.repo, comment.commentId, comment.body);
    return 'preserved_marked';
  }
  const minimized = await github.minimizeComment(comment);
  if (minimized) return 'deleted_or_minimized';
  // FR-POST-026: minimization unavailable → no further comments for the run.
  return 'preserved_unknown';
}

async function readDurable(
  run: RunIdentity,
  deps: PostDependencies,
): Promise<FencingSnapshot | null> {
  try {
    return await deps.coordinator.readDurableFencing(run.tenantId, run.repo, run.pullRequestId);
  } catch {
    // Unreadable durable authority → fail closed (FR-FENCE-014).
    return null;
  }
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
