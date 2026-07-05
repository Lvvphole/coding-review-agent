import { describe, expect, it } from 'vitest';
import {
  containsInternalIdentifier,
  publicStatus,
  type PublicStatusKind,
} from '../../apps/ci-review-bot/src/status/public-status.js';

/** Public status & failure UX — HARD-RULE-UX-005/006, docs/product/failure-ux.md. */

const ALL_KINDS: PublicStatusKind[] = [
  'in_progress',
  'no_issues',
  'posted',
  'draft_skipped',
  'newer_commit',
  'rate_limited',
  'prd_missing',
  'cannot_safely_review',
  'ai_unavailable',
];

describe('public status messages', () => {
  it('every message is non-empty and leaks no internal identifier (HARD-RULE-UX-005)', () => {
    for (const kind of ALL_KINDS) {
      const { summary } = publicStatus(kind, { findingCount: 3 });
      expect(summary.length).toBeGreaterThan(0);
      expect(containsInternalIdentifier(summary)).toBe(false);
    }
  });

  it('carries the failure-ux wording and a merge-safe conclusion (never failure)', () => {
    expect(publicStatus('cannot_safely_review').summary).toContain('could not complete a safe review');
    expect(publicStatus('rate_limited').summary).toContain('retry automatically');
    expect(publicStatus('newer_commit').summary).toContain('newer commit');
    expect(publicStatus('prd_missing').summary).toContain('add a PRD');
    for (const kind of ALL_KINDS) {
      expect(publicStatus(kind).conclusion).not.toBe('failure');
    }
  });

  it('posted reports the finding count without exposing internals', () => {
    expect(publicStatus('posted', { findingCount: 2 }).summary).toContain('2');
    expect(containsInternalIdentifier(publicStatus('posted', { findingCount: 2 }).summary)).toBe(false);
  });

  it('leak guard flags internal identifiers and infra terms', () => {
    expect(containsInternalIdentifier('AI review failed internally')).toBe(true);
    expect(containsInternalIdentifier('run_epoch 4 stale')).toBe(true);
    expect(containsInternalIdentifier('gateway route exhausted')).toBe(true);
    expect(containsInternalIdentifier('head 0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(containsInternalIdentifier('pending post outbox row locked')).toBe(true);
    expect(containsInternalIdentifier('Mark it ready for review when you want feedback.')).toBe(false);
  });
});
