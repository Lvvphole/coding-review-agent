import { describe, expect, it } from 'vitest';
import {
  InvalidMoveError,
  transition,
} from '../../apps/ci-review-bot/src/state-machine/machine.js';
import { ACTIVE_STATES, TERMINAL_STATES, RUN_STATES } from '@review-bot/shared';

/** State machine acceptance tests — PRD v6.5 §30.1 (id="state-tests-v65"). */
describe('PRReviewRun state machine', () => {
  it('T-001: RECEIVED + EVT_WEBHOOK_VERIFIED → DEBOUNCING', () => {
    expect(transition('RECEIVED', 'EVT_WEBHOOK_VERIFIED').next).toBe('DEBOUNCING');
  });

  it('T-002: RECEIVED + EVT_TENANT_AUTH_FAIL → BLOCKED', () => {
    expect(transition('RECEIVED', 'EVT_TENANT_AUTH_FAIL').next).toBe('BLOCKED');
  });

  it('T-004: RECEIVED + EVT_WEBHOOK_HASH_MISMATCH → BLOCKED', () => {
    expect(transition('RECEIVED', 'EVT_WEBHOOK_HASH_MISMATCH').next).toBe('BLOCKED');
  });

  it('T-005: RECEIVED + EVT_GITHUB_INTEGRATION_SUSPENDED → BLOCKED', () => {
    expect(transition('RECEIVED', 'EVT_GITHUB_INTEGRATION_SUSPENDED').next).toBe('BLOCKED');
  });

  it('duplicate webhook deliveries never transition a run (FR-GH-032)', () => {
    expect(() => transition('RECEIVED', 'EVT_DUPLICATE_WEBHOOK_IGNORED')).toThrow(InvalidMoveError);
  });

  it('T-006/T-007: debounce loop then queue', () => {
    expect(transition('DEBOUNCING', 'EVT_NEW_HEAD_SHA_RECEIVED').next).toBe('DEBOUNCING');
    expect(transition('DEBOUNCING', 'EVT_DEBOUNCE_EXPIRED').next).toBe('QUEUED');
  });

  it('QUEUED + EVT_RUN_DEQUEUED → CONTEXT_PREPARING (v6.5 event, no double-use)', () => {
    expect(transition('QUEUED', 'EVT_RUN_DEQUEUED').next).toBe('CONTEXT_PREPARING');
    // The v6.4.3 double-use (QUEUED + EVT_CONTEXT_READY) is now invalid.
    expect(() => transition('QUEUED', 'EVT_CONTEXT_READY')).toThrow(InvalidMoveError);
  });

  it('happy path: CONTEXT_PREPARING → ... → COMPLETED', () => {
    expect(transition('CONTEXT_PREPARING', 'EVT_CONTEXT_READY').next).toBe('GATEWAY_REQUESTING');
    expect(transition('GATEWAY_REQUESTING', 'EVT_GATEWAY_OK').next).toBe('AGENTS_RUNNING');
    expect(transition('AGENTS_RUNNING', 'EVT_AGENTS_DONE').next).toBe('AGGREGATING');
    expect(transition('AGGREGATING', 'EVT_AGGREGATION_DONE').next).toBe('VERIFYING');
    expect(transition('VERIFYING', 'EVT_VALIDATION_PASS').next).toBe('READY_TO_POST');
    expect(transition('READY_TO_POST', 'EVT_POST_GUARD_PASS').next).toBe('POSTING');
    expect(transition('POSTING', 'EVT_COMMENTS_POSTED').next).toBe('COMPLETED');
  });

  it('T-013/T-014: agent error retries then fails', () => {
    expect(transition('AGENTS_RUNNING', 'EVT_AGENT_ERROR', { retryAvailable: true }).next).toBe(
      'AGENTS_RUNNING',
    );
    expect(transition('AGENTS_RUNNING', 'EVT_AGENT_ERROR', { retryAvailable: false }).next).toBe(
      'FAILED',
    );
  });

  it('T-019: READY_TO_POST + EVT_POST_GUARD_FAIL → STALE_DISCARDED', () => {
    expect(transition('READY_TO_POST', 'EVT_POST_GUARD_FAIL').next).toBe('STALE_DISCARDED');
  });

  it('T-021 + G31: backoff entry requires durable pending post write (FORBIDDEN-027)', () => {
    expect(() => transition('POSTING', 'EVT_GITHUB_RATE_LIMITED')).toThrow(InvalidMoveError);
    expect(
      transition('POSTING', 'EVT_GITHUB_RATE_LIMITED', { pendingPostDurablyWritten: true }).next,
    ).toBe('GH_RATE_LIMIT_BACKOFF');
  });

  it('T-023/T-024: backoff retry and stale discard', () => {
    expect(transition('GH_RATE_LIMIT_BACKOFF', 'EVT_GITHUB_BACKOFF_EXPIRED').next).toBe('POSTING');
    expect(transition('GH_RATE_LIMIT_BACKOFF', 'EVT_NEW_HEAD_SHA_RECEIVED').next).toBe(
      'STALE_DISCARDED',
    );
  });

  it('T-025/HARD-RULE-046: severance is legal from EVERY active state → BLOCKED', () => {
    for (const state of ACTIVE_STATES) {
      expect(transition(state, 'EVT_GITHUB_INTEGRATION_SUSPENDED').next).toBe('BLOCKED');
    }
  });

  it('T-026: POSTING + EVT_POST_FLIGHT_STALE_DETECTED → STALE_DISCARDED', () => {
    expect(transition('POSTING', 'EVT_POST_FLIGHT_STALE_DETECTED').next).toBe('STALE_DISCARDED');
  });

  it('T-027 + FR-GH-049: cancellation from any active state, including backoff', () => {
    for (const state of ACTIVE_STATES) {
      expect(transition(state, 'EVT_CANCEL_REQUESTED').next).toBe('CANCELLED');
    }
  });

  it('T-030: terminal states accept no events', () => {
    for (const state of TERMINAL_STATES) {
      expect(() => transition(state, 'EVT_WEBHOOK_VERIFIED')).toThrow(InvalidMoveError);
      expect(() => transition(state, 'EVT_CANCEL_REQUESTED')).toThrow(InvalidMoveError);
    }
  });

  it('unlisted state/event pairs are INVALID_MOVE (§12.9)', () => {
    expect(() => transition('DEBOUNCING', 'EVT_COMMENTS_POSTED')).toThrow(InvalidMoveError);
    expect(() => transition('AGENTS_RUNNING', 'EVT_POST_GUARD_PASS')).toThrow(InvalidMoveError);
    // FORBIDDEN-001: AGENTS_RUNNING → POSTING has no legal event.
    for (const evt of ['EVT_COMMENTS_POSTED', 'EVT_POST_GUARD_PASS'] as const) {
      expect(() => transition('AGENTS_RUNNING', evt)).toThrow(InvalidMoveError);
    }
  });

  it('covers every declared state', () => {
    expect(RUN_STATES.length).toBe(17);
  });
});
