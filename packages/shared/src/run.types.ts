/** PRReviewRun identity — PRD v6.5 §12.1 (id="run-identity-v65"). */
export interface RunIdentity {
  tenantId: string;
  repo: string;
  pullRequestId: number;
  headSha: string;
  runId: string;
  runEpoch: number;
}

/** PRReviewRun states — PRD v6.5 §12.2 (id="pr-review-run-states-v65"). */
export const RUN_STATES = [
  'RECEIVED',
  'DEBOUNCING',
  'QUEUED',
  'CONTEXT_PREPARING',
  'GATEWAY_REQUESTING',
  'AGENTS_RUNNING',
  'AGGREGATING',
  'VERIFYING',
  'READY_TO_POST',
  'POSTING',
  'GH_RATE_LIMIT_BACKOFF',
  'COMPLETED',
  'CANCELLED',
  'STALE_DISCARDED',
  'FAILED',
  'BLOCKED',
  'ESCALATED',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Terminal states — §12.4. */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  'COMPLETED',
  'CANCELLED',
  'STALE_DISCARDED',
  'FAILED',
  'BLOCKED',
  'ESCALATED',
]);

/** Active states — §12.8 (id="active-states-v65"). */
export const ACTIVE_STATES: ReadonlySet<RunState> = new Set([
  'RECEIVED',
  'DEBOUNCING',
  'QUEUED',
  'CONTEXT_PREPARING',
  'GATEWAY_REQUESTING',
  'AGENTS_RUNNING',
  'AGGREGATING',
  'VERIFYING',
  'READY_TO_POST',
  'POSTING',
  'GH_RATE_LIMIT_BACKOFF',
]);

/** State machine events — §12.5 (id="events-v65"). */
export const RUN_EVENTS = [
  'EVT_WEBHOOK_VERIFIED',
  'EVT_TENANT_AUTH_FAIL',
  'EVT_DUPLICATE_WEBHOOK_IGNORED',
  'EVT_WEBHOOK_HASH_MISMATCH',
  'EVT_GITHUB_INTEGRATION_SUSPENDED',
  'EVT_RUN_DEQUEUED',
  'EVT_DEBOUNCE_EXPIRED',
  'EVT_NEW_HEAD_SHA_RECEIVED',
  'EVT_CONTEXT_READY',
  'EVT_CONTEXT_BLOCKED',
  'EVT_GATEWAY_OK',
  'EVT_GATEWAY_BLOCKED',
  'EVT_AGENTS_DONE',
  'EVT_AGENT_ERROR',
  'EVT_AGGREGATION_DONE',
  'EVT_VALIDATION_PASS',
  'EVT_VALIDATION_FAIL',
  'EVT_POST_GUARD_PASS',
  'EVT_POST_GUARD_FAIL',
  'EVT_COMMENTS_POSTED',
  'EVT_CANCEL_REQUESTED',
  'EVT_TIMEOUT',
  'EVT_ESCALATION_REQUIRED',
  'EVT_GITHUB_RATE_LIMITED',
  'EVT_GITHUB_BACKOFF_EXPIRED',
  'EVT_GITHUB_POST_RETRYABLE_ERROR',
  'EVT_GITHUB_POST_NON_RETRYABLE_ERROR',
  'EVT_PENDING_POST_DURABLY_WRITTEN',
  'EVT_PENDING_POST_RECOVERED',
  'EVT_POST_FLIGHT_STALE_DETECTED',
] as const;
export type RunEvent = (typeof RUN_EVENTS)[number];

/** GitHubIntegrationStatus — §13.3 (id="github-integration-statuses-v65"). */
export type GitHubIntegrationStatus =
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'REVOKED'
  | 'TOKEN_REFRESH_FAILED'
  | 'INSTALLATION_NOT_FOUND'
  | 'REAUTH_REQUIRED';

/**
 * Per-state watchdog deadlines in seconds — FR-RUN-001, HARD-RULE-044.
 * The Control Plane watchdog compares durable review_runs.updated_at against
 * these; null = terminal state, no deadline.
 */
export const STATE_DEADLINES_SECONDS: Record<RunState, number | null> = {
  RECEIVED: 60,
  DEBOUNCING: 300,
  QUEUED: 600,
  CONTEXT_PREPARING: 300,
  GATEWAY_REQUESTING: 120,
  AGENTS_RUNNING: 900,
  AGGREGATING: 120,
  VERIFYING: 300,
  READY_TO_POST: 120,
  POSTING: 300,
  GH_RATE_LIMIT_BACKOFF: 3600,
  COMPLETED: null,
  CANCELLED: null,
  STALE_DISCARDED: null,
  FAILED: null,
  BLOCKED: null,
  ESCALATED: null,
};

/** PendingReviewPost statuses — §13.2 (id="pending-post-statuses-v65"). */
export type PendingPostStatus =
  | 'PENDING'
  | 'BACKOFF'
  | 'POSTING'
  | 'POSTED'
  | 'STALE_DISCARDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED';
