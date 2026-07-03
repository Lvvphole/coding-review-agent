import type { Pool } from 'pg';
import type { RunIdentity } from '@review-bot/shared';
import type { ContextPolicy, HighRiskConfig } from '@review-bot/context-engine';
import type { ValidationPolicy } from '@review-bot/validators';
import type { ReviewAgent } from '@review-bot/agent-core';
import { transition } from '../state-machine/machine.js';
import { PrRunCoordinator } from '../concurrency/pr-run-coordinator.js';
import { DebounceManager } from '../concurrency/debounce-manager.js';
import { PendingPostStore } from '../outbox/pending-post-store.js';
import { GitHubReadError, type GitHubAdapter } from '../adapters/github.adapter.js';
import { runReviewPipeline } from '../workflows/review-pr.workflow.js';
import {
  postFindings,
  reconcileOrphanedComment,
  type PostingPolicy,
} from '../workflows/post-comments.workflow.js';

/**
 * Run executor — the durable review execution loop (FR-EXEC-001..006).
 *
 * Replaces Sprint 1's in-process setTimeout: due debounce windows come from a
 * Redis scan, but the run itself becomes durable at startRun (Postgres
 * review_runs), so pods can restart without losing QUEUED work
 * (FR-EXEC-006). State transitions go through the state-machine table and are
 * persisted per step.
 */

export interface RunExecutorDeps {
  pool: Pool;
  coordinator: PrRunCoordinator;
  debounce: DebounceManager;
  pendingPosts: PendingPostStore;
  github: GitHubAdapter;
  agents: ReviewAgent[];
  contextPolicy: ContextPolicy;
  highRisk: HighRiskConfig;
  validationPolicy: ValidationPolicy;
  postingPolicy: PostingPolicy;
  dryRun: boolean;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class RunExecutor {
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;

  constructor(private readonly deps: RunExecutorDeps) {
    this.log = deps.log ?? ((msg, fields) => console.log(msg, fields ?? ''));
  }

  /** One scheduler pass: settle due debounce windows, then execute QUEUED runs. */
  async tick(): Promise<{ started: number; executed: number }> {
    let started = 0;
    for (const due of await this.deps.debounce.dueWindows()) {
      const sha = await this.deps.debounce.settle(due.tenantId, due.repo, due.prId);
      if (!sha) continue;
      const { run } = await this.deps.coordinator.startRun({
        tenantId: due.tenantId,
        repo: due.repo,
        pullRequestId: due.prId,
        headSha: sha,
      });
      // RECEIVED → DEBOUNCING → QUEUED happened conceptually pre-run; the run
      // is created post-debounce, so walk it to QUEUED durably.
      let state = transition('RECEIVED', 'EVT_WEBHOOK_VERIFIED').next;
      state = transition(state, 'EVT_DEBOUNCE_EXPIRED').next;
      await this.deps.coordinator.updateRunStatus(run.runId, state);
      started += 1;
    }

    const queued = await this.deps.pool.query(
      `SELECT tenant_id, repo, pull_request_id, run_id, head_sha, run_epoch
         FROM review_runs
        WHERE status = 'QUEUED' AND is_current
        ORDER BY created_at ASC
        LIMIT 10`,
    );
    let executed = 0;
    for (const row of queued.rows) {
      const run: RunIdentity = {
        tenantId: row.tenant_id,
        repo: row.repo,
        pullRequestId: Number(row.pull_request_id),
        headSha: row.head_sha,
        runId: row.run_id,
        runEpoch: Number(row.run_epoch),
      };
      await this.executeRun(run);
      executed += 1;
    }
    return { started, executed };
  }

  /** PR closed/merged: cancel the active run and cascade the outbox (FR-GH-045..049). */
  async handleClosedPr(tenantId: string, repo: string, prId: number): Promise<void> {
    const durable = await this.deps.coordinator.readDurableFencing(tenantId, repo, prId);
    if (durable) {
      await this.deps.coordinator.updateRunStatus(durable.runId, 'CANCELLED');
    }
    const cascaded = await this.deps.pendingPosts.cancelForPullRequest(
      tenantId,
      repo,
      prId,
      'CANCELLED',
    );
    this.log('ci_review.run.cancelled', { tenantId, repo, prId, pendingPostsCascaded: cascaded });
  }

  private async setState(run: RunIdentity, state: string): Promise<void> {
    await this.deps.coordinator.updateRunStatus(run.runId, state);
  }

  /** FR-CHECK-005: check-run reporting must never fail or bypass the run. */
  private async reportCheck(
    run: RunIdentity,
    status: 'queued' | 'in_progress' | 'completed',
    summary: string,
    conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled',
  ): Promise<void> {
    try {
      const update: Parameters<GitHubAdapter['upsertCheckRun']>[0] = {
        repo: run.repo,
        headSha: run.headSha,
        status,
        summary,
      };
      if (conclusion !== undefined) update.conclusion = conclusion;
      await this.deps.github.upsertCheckRun(update);
    } catch (err) {
      this.log('ci_review.check_run.report_failed', { runId: run.runId, error: String(err) });
    }
  }

  private async executeRun(run: RunIdentity): Promise<void> {
    try {
      let state = transition('QUEUED', 'EVT_RUN_DEQUEUED').next; // CONTEXT_PREPARING
      await this.setState(run, state);
      await this.reportCheck(run, 'in_progress', 'AI review in progress');

      let diffText: string;
      try {
        diffText = await this.deps.github.getDiff(run.repo, run.pullRequestId);
      } catch (err) {
        // Read-path failure after bounded retries → BLOCKED/FAILED (FR-GH-053).
        const next = err instanceof GitHubReadError ? 'FAILED' : 'BLOCKED';
        await this.setState(run, next);
        this.log('ci_review.run.context_read_failed', { runId: run.runId, error: String(err) });
        return;
      }

      state = transition(state, 'EVT_CONTEXT_READY').next; // GATEWAY_REQUESTING
      await this.setState(run, state);
      state = transition(state, 'EVT_GATEWAY_OK').next; // AGENTS_RUNNING
      await this.setState(run, state);

      const cancellation = new AbortController();
      const result = await runReviewPipeline({
        run,
        diffText,
        agents: this.deps.agents,
        contextPolicy: this.deps.contextPolicy,
        highRisk: this.deps.highRisk,
        validationPolicy: this.deps.validationPolicy,
        cancellation: cancellation.signal,
      });

      state = transition(state, 'EVT_AGENTS_DONE').next; // AGGREGATING
      await this.setState(run, state);
      state = transition(state, 'EVT_AGGREGATION_DONE').next; // VERIFYING
      await this.setState(run, state);

      if (result.validated.length === 0) {
        await this.setState(run, transition(state, 'EVT_VALIDATION_FAIL').next); // COMPLETED
        await this.reportCheck(run, 'completed', 'AI review found no reportable issues', 'success');
        this.log('ci_review.run.completed', { runId: run.runId, findings: 0 });
        return;
      }

      state = transition(state, 'EVT_VALIDATION_PASS').next; // READY_TO_POST
      await this.setState(run, state);

      if (this.deps.dryRun) {
        // FR-SLO-008 shadow mode: full pipeline, guard-checked, never posted.
        await this.setState(run, 'COMPLETED');
        this.log('ci_review.run.dry_run_completed', {
          runId: run.runId,
          findings: result.validated.length,
          titles: result.validated.map((f) => `${f.file}:${f.line} ${f.title}`),
        });
        return;
      }

      const outcome = await postFindings(run, result.validated, this.deps.postingPolicy, {
        github: this.deps.github,
        coordinator: this.deps.coordinator,
        pendingPosts: this.deps.pendingPosts,
      });

      switch (outcome.kind) {
        case 'posted': {
          if (outcome.postFlightStale) {
            // T-026: reconcile then discard (HARD-RULE-018).
            const comments = await this.deps.github.listBotComments(run.repo, run.pullRequestId);
            const posted = comments.find((c) => c.commentId === outcome.commentId);
            if (posted) {
              const action = await reconcileOrphanedComment(run, posted, this.deps.github);
              this.log('ci_review.comment.orphaned', { runId: run.runId, action });
            }
            await this.setState(run, 'STALE_DISCARDED');
          } else {
            await this.setState(run, 'COMPLETED');
          }
          break;
        }
        case 'already_posted':
          await this.setState(run, 'COMPLETED');
          break;
        case 'backoff_queued':
          // Durable write happened inside postFindings (HARD-RULE-015).
          await this.setState(run, 'GH_RATE_LIMIT_BACKOFF');
          break;
        case 'stale_discarded':
          await this.setState(run, 'STALE_DISCARDED');
          break;
        case 'blocked':
          await this.setState(run, 'BLOCKED');
          break;
      }
      // AI review never blocks merge by default (§23.3 CI rule): conclusion
      // is neutral/success, not failure, regardless of findings.
      const summary =
        outcome.kind === 'posted' || outcome.kind === 'already_posted'
          ? `AI review posted ${result.validated.length} finding(s)`
          : `AI review finished: ${outcome.kind}`;
      await this.reportCheck(run, 'completed', summary, 'neutral');
      this.log('ci_review.run.finished', { runId: run.runId, outcome: outcome.kind });
    } catch (err) {
      await this.setState(run, 'FAILED');
      await this.reportCheck(run, 'completed', 'AI review failed internally', 'neutral');
      this.log('ci_review.run.failed', { runId: run.runId, error: String(err) });
    }
  }
}
