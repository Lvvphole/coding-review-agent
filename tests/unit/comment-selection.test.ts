import { describe, expect, it } from 'vitest';
import { orderFindingsForPosting, selectComments } from '@review-bot/validators';
import type { ReviewFinding } from '@review-bot/shared';

function finding(overrides: Partial<ReviewFinding>): ReviewFinding {
  return {
    finding_id: 'f1',
    severity: 'medium',
    category: 'bug',
    file: 'src/a.ts',
    line: 10,
    title: 't',
    evidence: 'e',
    recommendation: 'r',
    confidence: 0.85,
    agent_source: 'diff-reviewer',
    root_cause_id: 'BUG.GENERIC',
    root_cause_family: 'BUG',
    root_cause_source: 'global',
    taxonomy_version: '2026-07-02',
    ...overrides,
  };
}

/** HARD-RULE-043 / FR-POST-064..067 / FORBIDDEN-049. */
describe('deterministic comment selection', () => {
  it('orders by severity, confidence, evidence strength, category, finding_id', () => {
    const findings = [
      finding({ finding_id: 'a', severity: 'low', confidence: 0.99 }),
      finding({ finding_id: 'b', severity: 'critical', confidence: 0.91 }),
      finding({ finding_id: 'c', severity: 'critical', confidence: 0.95 }),
      finding({ finding_id: 'd', severity: 'high', confidence: 0.9, deterministic_evidence: true }),
      finding({ finding_id: 'e', severity: 'high', confidence: 0.9 }),
      finding({ finding_id: 'f', severity: 'high', confidence: 0.9, category: 'security', deterministic_evidence: true }),
    ];
    const ordered = orderFindingsForPosting(findings).map((f) => f.finding_id);
    expect(ordered).toEqual(['c', 'b', 'f', 'd', 'e', 'a']);
  });

  it('FR-POST-067: identical input yields identical selection regardless of order', () => {
    const base = [
      finding({ finding_id: 'x1', severity: 'high' }),
      finding({ finding_id: 'x2', severity: 'high' }),
      finding({ finding_id: 'x3', severity: 'low' }),
      finding({ finding_id: 'x4', severity: 'critical' }),
    ];
    const a = selectComments([...base], 2);
    const b = selectComments([...base].reverse(), 2);
    expect(a.inline.map((f) => f.finding_id)).toEqual(b.inline.map((f) => f.finding_id));
  });

  it('FR-POST-066: overflow findings route to summary', () => {
    const findings = Array.from({ length: 15 }, (_, i) =>
      finding({ finding_id: `f${String(i).padStart(2, '0')}` }),
    );
    const { inline, summaryOnly } = selectComments(findings, 10);
    expect(inline).toHaveLength(10);
    expect(summaryOnly).toHaveLength(5);
  });
});
