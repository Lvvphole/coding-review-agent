import type { FindingDisposition, ReviewFinding } from '@review-bot/shared';
import { validateFindingSchema } from './schema.validator.js';
import { validateLineMapping, type DiffLineIndex } from './line-mapping.validator.js';

/**
 * Post-LLM validation pipeline (HARD-RULE-008, HARD-RULE-010).
 *
 * Posting rules — PRD v6.5 §18 (id="posting-rules-v65"):
 *  1. confidence >= 0.80 for normal posting
 *  2. high/critical requires confidence >= 0.90
 *  3. high/critical requires deterministic evidence (HARD-RULE-039)
 *  4. high/critical requires valid line mapping
 *  5. high/critical requires taxonomy validation
 *  6. final verification must not reject
 */

export interface ValidationPolicy {
  confidenceThreshold: number;
  highSeverityConfidenceThreshold: number;
  requireDeterministicEvidenceForHighSeverity: boolean;
  /** Approved taxonomy IDs (global + compiled extensions) — §16. */
  approvedRootCauseIds: ReadonlySet<string>;
}

export interface ValidatedFinding {
  finding: ReviewFinding;
  disposition: FindingDisposition;
  reasons: string[];
}

export function validateFinding(
  raw: unknown,
  diffIndex: DiffLineIndex,
  policy: ValidationPolicy,
): ValidatedFinding {
  const schema = validateFindingSchema(raw);
  if (!schema.ok) {
    return {
      finding: raw as ReviewFinding,
      disposition: 'REJECTED_SCHEMA',
      reasons: schema.errors,
    };
  }
  const finding = raw as ReviewFinding;
  const isHigh = finding.severity === 'high' || finding.severity === 'critical';

  // Line mapping — posting rule 8 / FORBIDDEN-009.
  const lineOk = validateLineMapping(finding, diffIndex);
  if (!lineOk.ok) {
    return { finding, disposition: 'REJECTED_LINE_MAPPING', reasons: lineOk.reasons };
  }

  // Evidence must map to current code context (G14). Deterministic corroboration:
  // the quoted evidence must appear in the changed lines of the target file.
  const fileLines = diffIndex.changedLineText.get(finding.file);
  const evidenceInDiff =
    fileLines !== undefined &&
    [...fileLines.values()].some((text) => text.includes(finding.evidence.trim().slice(0, 200)));
  finding.deterministic_evidence = evidenceInDiff;
  if (!evidenceInDiff && isHigh && policy.requireDeterministicEvidenceForHighSeverity) {
    // HARD-RULE-039 / FR-VERIFY-006: reject or downgrade; we reject here, the
    // Final Verifier may separately downgrade when appropriate.
    return {
      finding,
      disposition: 'REJECTED_EVIDENCE',
      reasons: ['high/critical finding lacks deterministic evidence (HARD-RULE-039)'],
    };
  }
  if (!evidenceInDiff && finding.evidence.trim().length === 0) {
    return { finding, disposition: 'REJECTED_EVIDENCE', reasons: ['empty evidence'] };
  }

  // Confidence — posting rules 1-2.
  const threshold = isHigh
    ? policy.highSeverityConfidenceThreshold
    : policy.confidenceThreshold;
  if (finding.confidence < threshold) {
    return {
      finding,
      disposition: 'REJECTED_CONFIDENCE',
      reasons: [`confidence ${finding.confidence} below threshold ${threshold}`],
    };
  }

  // Taxonomy — FR-DEDUP-023/026: unmapped taxonomy blocks the finding, not the run.
  if (!policy.approvedRootCauseIds.has(finding.root_cause_id)) {
    return {
      finding,
      disposition: 'NEEDS_TAXONOMY_MAPPING',
      reasons: [`root_cause_id ${finding.root_cause_id} not in approved taxonomy`],
    };
  }

  return { finding, disposition: 'VALIDATED', reasons: [] };
}
