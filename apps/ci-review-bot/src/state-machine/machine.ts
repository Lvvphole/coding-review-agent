import { ACTIVE_STATES, TERMINAL_STATES, type RunEvent, type RunState } from '@review-bot/shared';

/**
 * PRReviewRun state machine — PRD v6.5 §12.8 (id="required-transitions-v65").
 * Any state/event pair not explicitly allowed is INVALID_MOVE (§12.9) and
 * emits state.invalid_transition.
 */

export class InvalidMoveError extends Error {
  constructor(
    public readonly state: RunState,
    public readonly event: RunEvent,
  ) {
    super(`INVALID_MOVE: ${state} + ${event}`);
    this.name = 'InvalidMoveError';
  }
}

type TransitionKey = `${RunState}|${RunEvent}`;

const t = (state: RunState, event: RunEvent, next: RunState): [TransitionKey, RunState] => [
  `${state}|${event}`,
  next,
];

/** Required transitions table — verbatim from id="required-transitions-v65". */
const TRANSITIONS = new Map<TransitionKey, RunState>([
  t('RECEIVED', 'EVT_WEBHOOK_VERIFIED', 'DEBOUNCING'),
  t('RECEIVED', 'EVT_TENANT_AUTH_FAIL', 'BLOCKED'),
  t('RECEIVED', 'EVT_WEBHOOK_HASH_MISMATCH', 'BLOCKED'),
  t('DEBOUNCING', 'EVT_NEW_HEAD_SHA_RECEIVED', 'DEBOUNCING'),
  t('DEBOUNCING', 'EVT_DEBOUNCE_EXPIRED', 'QUEUED'),
  t('QUEUED', 'EVT_RUN_DEQUEUED', 'CONTEXT_PREPARING'),
  t('CONTEXT_PREPARING', 'EVT_CONTEXT_READY', 'GATEWAY_REQUESTING'),
  t('CONTEXT_PREPARING', 'EVT_CONTEXT_BLOCKED', 'BLOCKED'),
  t('GATEWAY_REQUESTING', 'EVT_GATEWAY_OK', 'AGENTS_RUNNING'),
  t('GATEWAY_REQUESTING', 'EVT_GATEWAY_BLOCKED', 'BLOCKED'),
  t('AGENTS_RUNNING', 'EVT_AGENTS_DONE', 'AGGREGATING'),
  t('AGGREGATING', 'EVT_AGGREGATION_DONE', 'VERIFYING'),
  t('VERIFYING', 'EVT_VALIDATION_PASS', 'READY_TO_POST'),
  t('VERIFYING', 'EVT_VALIDATION_FAIL', 'COMPLETED'),
  t('READY_TO_POST', 'EVT_POST_GUARD_PASS', 'POSTING'),
  t('READY_TO_POST', 'EVT_POST_GUARD_FAIL', 'STALE_DISCARDED'),
  t('POSTING', 'EVT_COMMENTS_POSTED', 'COMPLETED'),
  t('POSTING', 'EVT_GITHUB_POST_NON_RETRYABLE_ERROR', 'FAILED'),
  t('POSTING', 'EVT_POST_FLIGHT_STALE_DETECTED', 'STALE_DISCARDED'),
  t('GH_RATE_LIMIT_BACKOFF', 'EVT_PENDING_POST_RECOVERED', 'GH_RATE_LIMIT_BACKOFF'),
  t('GH_RATE_LIMIT_BACKOFF', 'EVT_GITHUB_BACKOFF_EXPIRED', 'POSTING'),
  t('GH_RATE_LIMIT_BACKOFF', 'EVT_NEW_HEAD_SHA_RECEIVED', 'STALE_DISCARDED'),
  t('GH_RATE_LIMIT_BACKOFF', 'EVT_POST_GUARD_FAIL', 'STALE_DISCARDED'),
  t('GH_RATE_LIMIT_BACKOFF', 'EVT_TIMEOUT', 'FAILED'),
]);

export interface TransitionOptions {
  /**
   * POSTING → GH_RATE_LIMIT_BACKOFF requires the pending post to be durably
   * written first (G31, FR-POST-038): the transition event is only legal when
   * paired with EVT_PENDING_POST_DURABLY_WRITTEN.
   */
  pendingPostDurablyWritten?: boolean;
  /** AGENTS_RUNNING + EVT_AGENT_ERROR: retry available keeps the run in place. */
  retryAvailable?: boolean;
}

export interface TransitionResult {
  next: RunState;
  emitted: string[];
}

export function transition(
  state: RunState,
  event: RunEvent,
  opts: TransitionOptions = {},
): TransitionResult {
  // Terminal states accept no events (test T-030 analogue).
  if (TERMINAL_STATES.has(state)) {
    throw new InvalidMoveError(state, event);
  }

  // Integration severance is legal from ANY active state (HARD-RULE-046,
  // id="integration-suspension-active-state-rule").
  if (event === 'EVT_GITHUB_INTEGRATION_SUSPENDED' && ACTIVE_STATES.has(state)) {
    return { next: 'BLOCKED', emitted: ['github.integration.suspended'] };
  }

  // Cancellation from any active state (T-027 analogue; FR-GH-049 makes
  // GH_RATE_LIMIT_BACKOFF cancellable).
  if (event === 'EVT_CANCEL_REQUESTED' && ACTIVE_STATES.has(state)) {
    return { next: 'CANCELLED', emitted: ['ci_review.run.cancelled'] };
  }

  // Watchdog/timeout from any active state (HARD-RULE-044) except the backoff
  // state, which has its own retry-exhaustion row in the table.
  if (event === 'EVT_TIMEOUT' && ACTIVE_STATES.has(state) && state !== 'GH_RATE_LIMIT_BACKOFF') {
    return { next: 'FAILED', emitted: ['ci_review.run.watchdog_timeout'] };
  }

  // Escalation from any active state.
  if (event === 'EVT_ESCALATION_REQUIRED' && ACTIVE_STATES.has(state)) {
    return { next: 'ESCALATED', emitted: ['ci_review.run.escalated'] };
  }

  // Duplicate webhooks never transition a run (FR-GH-032): duplicates are
  // rejected at the edge before coordination — reaching here is a bug.
  if (event === 'EVT_DUPLICATE_WEBHOOK_IGNORED') {
    throw new InvalidMoveError(state, event);
  }

  // Agent error handling — retry keeps AGENTS_RUNNING, exhaustion fails.
  if (state === 'AGENTS_RUNNING' && event === 'EVT_AGENT_ERROR') {
    return opts.retryAvailable
      ? { next: 'AGENTS_RUNNING', emitted: ['ci_review.agent.retry'] }
      : { next: 'FAILED', emitted: ['ci_review.run.failed'] };
  }

  // Backoff entry requires durable pending-post write (G31, FORBIDDEN-027).
  if (
    state === 'POSTING' &&
    (event === 'EVT_GITHUB_RATE_LIMITED' || event === 'EVT_GITHUB_POST_RETRYABLE_ERROR')
  ) {
    if (!opts.pendingPostDurablyWritten) {
      throw new InvalidMoveError(state, event);
    }
    return { next: 'GH_RATE_LIMIT_BACKOFF', emitted: ['github.backoff.started'] };
  }

  const next = TRANSITIONS.get(`${state}|${event}`);
  if (next === undefined) {
    throw new InvalidMoveError(state, event);
  }
  return { next, emitted: ['state.transition'] };
}

// STATE_DEADLINES_SECONDS moved to @review-bot/shared (consumed by the
// Control Plane watchdog worker as well as this app).
export { STATE_DEADLINES_SECONDS } from '@review-bot/shared';
