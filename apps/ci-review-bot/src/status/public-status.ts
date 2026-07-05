/**
 * Public status & failure messaging — PRD v6.5 §23.3, HARD-RULE-UX-005/006.
 *
 * Maps internal run outcomes to the plain-language messages defined in
 * docs/product/failure-ux.md. Every message answers what happened / what
 * LimeReview did safely / what to do next, and NEVER leaks internal
 * identifiers (run epochs, fencing state, outbox rows, Gateway routes, SHAs)
 * to the standard-user surface (HARD-RULE-UX-005). Safe silence beats unsafe
 * output (HARD-RULE-UX-006).
 */

export type PublicStatusKind =
  | 'in_progress'
  | 'no_issues'
  | 'posted'
  | 'draft_skipped'
  | 'newer_commit'
  | 'rate_limited'
  | 'prd_missing'
  | 'cannot_safely_review'
  | 'ai_unavailable';

export type CheckConclusion = 'success' | 'neutral' | 'cancelled' | 'failure';

export interface PublicStatus {
  summary: string;
  conclusion?: CheckConclusion;
}

/** Canonical messages — kept byte-aligned with docs/product/failure-ux.md. */
export function publicStatus(kind: PublicStatusKind, opts: { findingCount?: number } = {}): PublicStatus {
  switch (kind) {
    case 'in_progress':
      return { summary: 'LimeReview is reviewing this pull request.' };
    case 'no_issues':
      return { summary: 'LimeReview found no issues to report.', conclusion: 'success' };
    case 'posted':
      return {
        summary: `LimeReview posted ${opts.findingCount ?? 0} review comment(s).`,
        conclusion: 'neutral',
      };
    case 'draft_skipped':
      return {
        summary:
          'LimeReview skipped this PR because it is still a draft.\n' +
          'Mark it ready for review when you want feedback.',
        conclusion: 'neutral',
      };
    case 'newer_commit':
      return {
        summary:
          'LimeReview detected a newer commit and restarted review on the latest version.\n' +
          'Older review output was discarded to avoid stale comments.',
        conclusion: 'cancelled',
      };
    case 'rate_limited':
      return {
        summary:
          'GitHub temporarily limited review posting.\n' +
          'LimeReview saved the validated findings and will retry automatically.',
        conclusion: 'neutral',
      };
    case 'prd_missing':
      return {
        summary:
          'No PRD was found for this repo.\n' +
          'LimeReview will run a general code review, or you can add a PRD for requirement-aware review.',
        conclusion: 'neutral',
      };
    case 'cannot_safely_review':
      return {
        summary:
          'LimeReview could not complete a safe review.\n' +
          'No comments were posted.\n' +
          'Try again, or switch to general review mode.',
        conclusion: 'neutral',
      };
    case 'ai_unavailable':
      return {
        summary:
          'AI review is temporarily unavailable.\n' +
          'LimeReview did not post partial or unverified findings.\n' +
          'Try again later or run deterministic checks only.',
        conclusion: 'neutral',
      };
  }
}

/**
 * Guard for the standard-user surface (HARD-RULE-UX-005): flags text that leaks
 * an internal identifier or infrastructure term. Admin/advanced surfaces are
 * exempt; this is asserted against public check-run summaries and comments.
 */
const INTERNAL_LEAK_PATTERNS: RegExp[] = [
  /\brun[_ ]?epoch\b/i,
  /\bfencing\b/i,
  /\boutbox\b/i,
  /\bpending[_ ]?post\b/i,
  /\bgateway\b/i,
  /\broute[_ ]?key\b/i,
  /\btenant[_ ]?id\b/i,
  /\binternally\b/i,
  /\bstack\s?trace\b/i,
  /\bnull\b/i,
  /\bundefined\b/i,
  /[0-9a-f]{40}/i, // git SHA
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // UUID
];

export function containsInternalIdentifier(text: string): boolean {
  return INTERNAL_LEAK_PATTERNS.some((re) => re.test(text));
}
