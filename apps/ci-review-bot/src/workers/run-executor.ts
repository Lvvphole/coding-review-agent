import type { Pool } from 'pg';
import type { Category, RunIdentity } from '@review-bot/shared';
import type { ContextPolicy, HighRiskConfig } from '@review-bot/context-engine';
import type { ValidationPolicy } from '@review-bot/validators';
import type { ReviewAgent } from '@review-bot/agent-core';
import { applyMode, DEFAULT_REVIEW_MODE, type EffectivePolicies } from '../review-modes/modes.js';
import type { ModeResolver } from '../review-modes/mode-store.js';
import type { RepoConfigResolver } from '../review-modes/repo-config.js';
import type { PrdContextProvider } from '../prd/prd-context-provider.js';
import { publicStatus, type PublicStatusKind } from '../status/public-status.js';
import { transition } from '../state-machine/machine.js';
import { PrRunCoordinator } from '../concurrency/pr-run-coordinator.js';
import { DebounceManager } from '../concurrency/debounce-manager.js';
import { PendingPostStore } from '../outbox/pending-post-store.js';
import { GitHubReadError, type GitHubAdapter } from '../adapters/github.adapter.js';
import { SpendLedger } from '../ledger/spend-ledger.js';
import { persistFindings } from '../db/findings-store.js';
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

/**
 * Per-repo shadow (dry-run) resolver (Sprint 10, FR-SLO-008). A newly onboarded
 * repo starts in shadow so its first reviews are fully validated but never
 * posted, until an admin activates real posting. Shadow only ever SUPPRESSES
 * posting, so it can never weaken a safety gate; it composes with the global
 * `dryRun` by OR (either forces shadow).
 */
export interface ShadowResolver {
  isShadow(tenantId: string, repo: string): Promise<boolean>;
}

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
  /** Global shadow toggle (dev/local, FR-SLO-008). Per-repo shadow ORs on top. */
  dryRun: boolean;
  /**
   * Per-repo shadow resolver (Sprint 10). Absent → only the global `dryRun`
   * governs shadow, so existing callers are byte-for-byte unaffected.
   */
  shadowResolver?: ShadowResolver;
  /**
   * Per-repo review-mode resolver (Sprint 7). When absent the executor keeps
   * the pre-mode behavior (base policies, no category suppression), so existing
   * callers are unaffected.
   */
  modeResolver?: ModeResolver;
  /**
   * `.github/review-bot.yml` opt-in layer (HARD-RULE-UX-003). When present its
   * review_mode overrides the admin-stored mode for the run; absent → the
   * stored mode stands. Optional advanced control, so an unset seam preserves
   * the existing behavior exactly.
   */
  repoConfigResolver?: RepoConfigResolver;
  /**
   * PRD-derived requirement-aware review context (Sprint 8). When absent, or
   * when it returns null for a repo with no PRD, the run is a general review
   * (docs/product/failure-ux.md fallback).
   */
  prdProvider?: PrdContextProvider;
  /** Spend accounting (HARD-RULE-024/025); optional until the event bus sprint. */
  ledger?: SpendLedger;
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

  /**
   * Resolve the per-repo review mode into effective, safety-floored policies.
   * With no resolver configured, returns the base policies unchanged so the
   * pre-mode path is byte-for-byte preserved.
   */
  private async resolveEffective(run: RunIdentity): Promise<EffectivePolicies> {
    const base = {
      validationPolicy: this.deps.validationPolicy,
      contextPolicy: this.deps.contextPolicy,
      maxInlineComments: this.deps.postingPolicy.maxInlineComments,
    };
    // Pre-mode path preserved byte-for-byte when neither seam is wired.
    if (!this.deps.modeResolver && !this.deps.repoConfigResolver) {
      return { ...base, suppressedCategories: new Set<Category>(), mode: 'standard' };
    }
    // Precedence (HARD-RULE-UX-003): .github/review-bot.yml > admin-stored mode
    // > managed default. The opt-in file only ever OVERRIDES which preset runs;
    // the safety floor is identical across presets (applyMode).
    let mode = this.deps.modeResolver
      ? await this.deps.modeResolver.resolveMode(run.tenantId, run.repo)
      : DEFAULT_REVIEW_MODE;
    if (this.deps.repoConfigResolver) {
      const config = await this.deps.repoConfigResolver.resolve(run);
      if (config?.reviewMode) mode = config.reviewMode;
    }
    return applyMode(base, mode);
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
      await this.reportCheck(run, 'in_progress', publicStatus('in_progress').summary);

      // Resolve the per-repo mode into effective policies (safety floor intact).
      const effective = await this.resolveEffective(run);

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

      const cancellation = new AbortController();

      // Requirement-aware review (Sprint 8): resolve + extract the PRD (once, at
      // head SHA, Gateway-routed). Extraction failure never fails the run — it
      // falls back to a general review (HARD-RULE-UX-004, docs/product/failure-ux.md).
      let prdCriteriaContext: string | undefined;
      let prdMissing = false;
      if (this.deps.prdProvider) {
        try {
          const prd = await this.deps.prdProvider.provide(run, cancellation.signal);
          if (prd) {
            prdCriteriaContext = prd.context;
            this.log('ci_review.prd.attached', {
              runId: run.runId,
              sourceRef: prd.sourceRef,
              truncated: prd.truncated,
            });
          } else {
            prdMissing = true;
            this.log('ci_review.prd.absent_general_review', { runId: run.runId });
          }
        } catch (err) {
          this.log('ci_review.prd.extract_failed_general_review', {
            runId: run.runId,
            error: String(err),
          });
        }
      }

      state = transition(state, 'EVT_GATEWAY_OK').next; // AGENTS_RUNNING
      await this.setState(run, state);

      const result = await runReviewPipeline({
        run,
        diffText,
        agents: this.deps.agents,
        contextPolicy: effective.contextPolicy,
        highRisk: this.deps.highRisk,
        validationPolicy: effective.validationPolicy,
        ...(prdCriteriaContext !== undefined ? { prdCriteriaContext } : {}),
        cancellation: cancellation.signal,
      });

      // Spend accounting from gateway usage (FR-CP-003); accounting failures
      // never fail the review run.
      if (this.deps.ledger && result.tokenUsage.input + result.tokenUsage.output > 0) {
        try {
          await this.deps.ledger.recordUsage({
            tenantId: run.tenantId,
            appId: 'ci-review-bot',
            provider: 'gateway',
            model: 'per-route',
            modelTier: 'standard',
            taskType: 'code_review',
            workflowId: 'pr_review',
            tokenInput: result.tokenUsage.input,
            tokenOutput: result.tokenUsage.output,
            costUsd: 0,
            repo: run.repo,
            pullRequestId: run.pullRequestId,
            runId: run.runId,
          });
        } catch (err) {
          this.log('ledger.write_failed', { runId: run.runId, error: String(err) });
        }
      }

      state = transition(state, 'EVT_AGENTS_DONE').next; // AGGREGATING
      await this.setState(run, state);
      state = transition(state, 'EVT_AGGREGATION_DONE').next; // VERIFYING
      await this.setState(run, state);

      // Mode surfacing (Sprint 7): drop suppressed categories AFTER validation.
      // Every survivor still passed all safety gates; suppression only governs
      // what this mode surfaces, never the validation floor. security/bug are
      // never in the suppressed set.
      const surfaced =
        effective.suppressedCategories.size === 0
          ? result.validated
          : result.validated.filter((f) => !effective.suppressedCategories.has(f.category as Category));

      if (surfaced.length === 0) {
        await this.setState(run, transition(state, 'EVT_VALIDATION_FAIL').next); // COMPLETED
        // A clean general review with no PRD attached surfaces the "add a PRD"
        // notice instead of a bare "no issues" (HARD-RULE-UX-004/006).
        const clean = publicStatus(prdMissing ? 'prd_missing' : 'no_issues');
        await this.reportCheck(run, 'completed', clean.summary, clean.conclusion);
        this.log('ci_review.run.completed', { runId: run.runId, findings: 0, mode: effective.mode });
        return;
      }

      state = transition(state, 'EVT_VALIDATION_PASS').next; // READY_TO_POST
      await this.setState(run, state);

      // Durable findings record (§24.2) — retention/expungement target
      // (HARD-RULE-047); persistence failure never fails the run.
      try {
        await persistFindings(this.deps.pool, run, result.validated, 'VALIDATED');
      } catch (err) {
        this.log('ci_review.findings.persist_failed', { runId: run.runId, error: String(err) });
      }

      // FR-SLO-008 shadow mode: the global dry-run toggle OR a per-repo shadow
      // flag (a newly onboarded repo, not yet activated by an admin). Shadow
      // runs the full guard-checked pipeline but never posts.
      const shadow =
        this.deps.dryRun ||
        (this.deps.shadowResolver
          ? await this.deps.shadowResolver.isShadow(run.tenantId, run.repo)
          : false);
      if (shadow) {
        await this.setState(run, 'COMPLETED');
        this.log('ci_review.run.dry_run_completed', {
          runId: run.runId,
          mode: effective.mode,
          findings: surfaced.length,
          titles: surfaced.map((f) => `${f.file}:${f.line} ${f.title}`),
        });
        return;
      }

      const outcome = await postFindings(
        run,
        surfaced,
        { ...this.deps.postingPolicy, maxInlineComments: effective.maxInlineComments },
        {
          github: this.deps.github,
          coordinator: this.deps.coordinator,
          pendingPosts: this.deps.pendingPosts,
        },
      );

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
      // AI review never blocks merge by default (§23.3 CI rule): conclusion is
      // neutral/cancelled/success, never failure. The user-facing summary is a
      // plain-language message with no internal identifiers (HARD-RULE-UX-005).
      const OUTCOME_STATUS: Record<typeof outcome.kind, PublicStatusKind> = {
        posted: 'posted',
        already_posted: 'posted',
        backoff_queued: 'rate_limited',
        stale_discarded: 'newer_commit',
        blocked: 'cannot_safely_review',
      };
      const status = publicStatus(OUTCOME_STATUS[outcome.kind], { findingCount: surfaced.length });
      await this.reportCheck(run, 'completed', status.summary, status.conclusion);
      this.log('ci_review.run.finished', { runId: run.runId, outcome: outcome.kind });
    } catch (err) {
      await this.setState(run, 'FAILED');
      // Safe silence over unsafe output (HARD-RULE-UX-006): the public message
      // never exposes the internal failure (HARD-RULE-UX-005); details go to logs.
      const safe = publicStatus('cannot_safely_review');
      await this.reportCheck(run, 'completed', safe.summary, safe.conclusion);
      this.log('ci_review.run.failed', { runId: run.runId, error: String(err) });
    }
  }
}
