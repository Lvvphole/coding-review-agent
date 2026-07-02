import type { ReviewFinding } from '@review-bot/shared';

/**
 * Deterministic-first hybrid deduplication — PRD v6.5 §17.
 *
 * Sprint 1 implements the deterministic tiers only:
 *   Stage 4: exact match (file, category, normalized range, root_cause_id) — FR-DEDUP-011
 *   Stage 6: line-range overlap >= 50% with same root_cause_id — FR-DEDUP-012
 * AST-node overlap (FR-DEDUP-013) and embedding candidates (FR-DEDUP-014..016)
 * arrive with the AST/embedding sprints; the tier is recorded per FR-AST-004.
 *
 * Hard rules honored: findings from different head_sha never merge
 * (id="dedupe-head-sha-rule"), dedupe is deterministic for identical input
 * (FR-DEDUP-020), merged findings preserve highest severity, strongest
 * evidence, and merged_from lineage (FR-DEDUP-018).
 */

const SEVERITY_RANK: Record<ReviewFinding['severity'], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface DedupeInput {
  finding: ReviewFinding;
  headSha: string;
  /** Inclusive changed-line range covered by the finding. */
  lineRange: { start: number; end: number };
}

function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start) + 1;
  if (overlap <= 0) return 0;
  const shorter = Math.min(a.end - a.start + 1, b.end - b.start + 1);
  return overlap / shorter;
}

function mergeInto(target: DedupeInput, source: DedupeInput, tier: 'exact' | 'line-overlap'): void {
  const t = target.finding;
  const s = source.finding;
  if (SEVERITY_RANK[s.severity] > SEVERITY_RANK[t.severity]) t.severity = s.severity;
  if (s.confidence > t.confidence) t.confidence = s.confidence;
  // Strongest evidence: deterministic beats non-deterministic, then longer text.
  const sStronger =
    (s.deterministic_evidence && !t.deterministic_evidence) ||
    (s.deterministic_evidence === t.deterministic_evidence && s.evidence.length > t.evidence.length);
  if (sStronger) {
    t.evidence = s.evidence;
    t.deterministic_evidence = s.deterministic_evidence ?? false;
    t.recommendation = s.recommendation;
  }
  const sources = new Set((t.agent_source + ',' + s.agent_source).split(','));
  t.agent_source = [...sources].sort().join(',');
  t.merged_from = [...(t.merged_from ?? []), s.finding_id];
  t.dedupe_tier = tier;
  target.lineRange = {
    start: Math.min(target.lineRange.start, source.lineRange.start),
    end: Math.max(target.lineRange.end, source.lineRange.end),
  };
}

export function dedupeFindings(inputs: DedupeInput[]): ReviewFinding[] {
  // Deterministic processing order regardless of agent completion order (FR-DEDUP-020).
  const sorted = [...inputs].sort((a, b) =>
    a.finding.finding_id.localeCompare(b.finding.finding_id),
  );

  const kept: DedupeInput[] = [];
  for (const candidate of sorted) {
    let merged = false;
    for (const existing of kept) {
      // Findings from different head_sha values must never deduplicate together.
      if (existing.headSha !== candidate.headSha) continue;
      const ef = existing.finding;
      const cf = candidate.finding;
      if (ef.file !== cf.file || ef.category !== cf.category) continue;
      if (ef.root_cause_id !== cf.root_cause_id) continue;

      const exact =
        existing.lineRange.start === candidate.lineRange.start &&
        existing.lineRange.end === candidate.lineRange.end;
      if (exact) {
        mergeInto(existing, candidate, 'exact');
        merged = true;
        break;
      }
      if (overlapRatio(existing.lineRange, candidate.lineRange) >= 0.5) {
        mergeInto(existing, candidate, 'line-overlap');
        merged = true;
        break;
      }
    }
    if (!merged) kept.push(candidate);
  }
  return kept.map((k) => k.finding);
}
