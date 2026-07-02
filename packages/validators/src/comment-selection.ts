import type { Category, ReviewFinding } from '@review-bot/shared';

/**
 * Deterministic inline-comment selection when validated findings exceed
 * max_inline_comments — HARD-RULE-043, FR-POST-064..067, FORBIDDEN-049.
 *
 * Sort order (FR-POST-065): severity desc, confidence desc, deterministic
 * evidence strength desc, category priority, stable finding_id asc.
 */

const SEVERITY_RANK: Record<ReviewFinding['severity'], number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

const CATEGORY_PRIORITY: Record<Category, number> = {
  security: 0,
  bug: 1,
  test_gap: 2,
  performance: 3,
  maintainability: 4,
  style: 5,
};

export function orderFindingsForPosting(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => {
    if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
      return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    }
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    const aDet = a.deterministic_evidence ? 1 : 0;
    const bDet = b.deterministic_evidence ? 1 : 0;
    if (aDet !== bDet) return bDet - aDet;
    if (CATEGORY_PRIORITY[a.category] !== CATEGORY_PRIORITY[b.category]) {
      return CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
    }
    return a.finding_id.localeCompare(b.finding_id);
  });
}

export interface CommentSelection {
  inline: ReviewFinding[];
  /** Overflow findings routed to the grouped summary (FR-POST-066). */
  summaryOnly: ReviewFinding[];
}

export function selectComments(
  findings: ReviewFinding[],
  maxInlineComments: number,
): CommentSelection {
  const ordered = orderFindingsForPosting(findings);
  return {
    inline: ordered.slice(0, maxInlineComments),
    summaryOnly: ordered.slice(maxInlineComments),
  };
}
