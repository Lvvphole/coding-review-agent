import { describe, expect, it } from 'vitest';
import {
  dedupeFindings,
  validateFinding,
  validateFindingSchema,
  type ValidationPolicy,
} from '@review-bot/validators';
import type { ReviewFinding } from '@review-bot/shared';
import { buildDiffLineIndex, parseUnifiedDiff } from '@review-bot/context-engine';

const DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,4 +10,6 @@
 function login(user) {
+  const query = "SELECT * FROM users WHERE name = '" + user + "'";
+  return db.raw(query);
 }
`;

const index = buildDiffLineIndex(parseUnifiedDiff(DIFF));

const policy: ValidationPolicy = {
  confidenceThreshold: 0.8,
  highSeverityConfidenceThreshold: 0.9,
  requireDeterministicEvidenceForHighSeverity: true,
  approvedRootCauseIds: new Set(['INPUT.SQL_INJECTION_RISK', 'BUG.GENERIC']),
};

function finding(overrides: Partial<ReviewFinding>): ReviewFinding {
  return {
    finding_id: 'f1',
    severity: 'high',
    category: 'security',
    file: 'src/auth/login.ts',
    line: 11,
    title: 'SQL injection',
    evidence: `const query = "SELECT * FROM users WHERE name = '" + user + "'";`,
    recommendation: 'Use parameterized queries.',
    confidence: 0.95,
    agent_source: 'security-reviewer',
    root_cause_id: 'INPUT.SQL_INJECTION_RISK',
    root_cause_family: 'INPUT_VALIDATION',
    root_cause_source: 'global',
    taxonomy_version: '2026-07-02',
    ...overrides,
  };
}

describe('validation pipeline (§18 posting rules)', () => {
  it('validates a well-formed high-severity finding with diff evidence', () => {
    const v = validateFinding(finding({}), index, policy);
    expect(v.disposition).toBe('VALIDATED');
    expect(v.finding.deterministic_evidence).toBe(true);
  });

  it('V-001: invalid schema rejected', () => {
    expect(validateFindingSchema({ severity: 'catastrophic' }).ok).toBe(false);
    const v = validateFinding({ nonsense: true }, index, policy);
    expect(v.disposition).toBe('REJECTED_SCHEMA');
  });

  it('V-002/V-003: file or line outside the diff rejected (FORBIDDEN-009)', () => {
    expect(validateFinding(finding({ file: 'src/other.ts' }), index, policy).disposition).toBe(
      'REJECTED_LINE_MAPPING',
    );
    expect(validateFinding(finding({ line: 999 }), index, policy).disposition).toBe(
      'REJECTED_LINE_MAPPING',
    );
  });

  it('V-005: low confidence rejected — high severity needs 0.90 (posting rule 2)', () => {
    const v = validateFinding(finding({ confidence: 0.85 }), index, policy);
    expect(v.disposition).toBe('REJECTED_CONFIDENCE');
  });

  it('V-007 / HARD-RULE-039: high severity without deterministic evidence rejected', () => {
    const v = validateFinding(
      finding({ evidence: 'this code looks vulnerable to me' }),
      index,
      policy,
    );
    expect(v.disposition).toBe('REJECTED_EVIDENCE');
  });

  it('V-009 / FR-DEDUP-026: unapproved taxonomy → NEEDS_TAXONOMY_MAPPING, not rejection', () => {
    const v = validateFinding(finding({ root_cause_id: 'CUSTOM.UNKNOWN' }), index, policy);
    expect(v.disposition).toBe('NEEDS_TAXONOMY_MAPPING');
  });
});

describe('deterministic-first dedupe (§17)', () => {
  const mk = (id: string, over: Partial<ReviewFinding>, range: { start: number; end: number }, sha = 'abc') => ({
    finding: finding({ finding_id: id, ...over }),
    headSha: sha,
    lineRange: range,
  });

  it('DEDUP-001: exact file/category/range/root_cause merges', () => {
    const out = dedupeFindings([
      mk('a', {}, { start: 11, end: 12 }),
      mk('b', { agent_source: 'diff-reviewer' }, { start: 11, end: 12 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.merged_from).toEqual(['b']);
    expect(out[0]!.agent_source).toBe('diff-reviewer,security-reviewer');
    expect(out[0]!.dedupe_tier).toBe('exact');
  });

  it('DEDUP-003: >=50% line overlap with same root_cause merges', () => {
    const out = dedupeFindings([
      mk('a', {}, { start: 10, end: 13 }),
      mk('b', {}, { start: 12, end: 13 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.dedupe_tier).toBe('line-overlap');
  });

  it('different root_cause_id does not merge (DEDUP-005 analogue)', () => {
    const out = dedupeFindings([
      mk('a', {}, { start: 11, end: 12 }),
      mk('b', { root_cause_id: 'BUG.GENERIC', category: 'bug' }, { start: 11, end: 12 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('DEDUP-009: findings from different head_sha never merge', () => {
    const out = dedupeFindings([
      mk('a', {}, { start: 11, end: 12 }, 'sha-1'),
      mk('b', {}, { start: 11, end: 12 }, 'sha-2'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('DEDUP-007 / FR-DEDUP-018: merged finding keeps highest severity', () => {
    const out = dedupeFindings([
      mk('a', { severity: 'medium' }, { start: 11, end: 12 }),
      mk('b', { severity: 'critical' }, { start: 11, end: 12 }),
    ]);
    expect(out[0]!.severity).toBe('critical');
  });

  it('FR-DEDUP-020: deterministic output regardless of input order', () => {
    const inputs = [
      mk('z', { severity: 'low' }, { start: 11, end: 12 }),
      mk('a', { severity: 'critical' }, { start: 11, end: 12 }),
    ];
    const fwd = dedupeFindings(inputs.map((i) => ({ ...i, finding: { ...i.finding } })));
    const rev = dedupeFindings([...inputs].reverse().map((i) => ({ ...i, finding: { ...i.finding } })));
    expect(fwd.map((f) => f.finding_id)).toEqual(rev.map((f) => f.finding_id));
  });
});
