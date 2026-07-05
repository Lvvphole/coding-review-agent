import { describe, expect, it } from 'vitest';
import {
  chunkPrdText,
  contentHash,
  criteriaKey,
  mergeCriteria,
  parseCriteria,
  renderCriteriaContext,
  emptyCriteria,
} from '../../apps/ci-review-bot/src/prd/prd-criteria.js';

/** PRD criteria model — PRD v6.5 §16, HARD-RULE-UX-004. Pure + deterministic. */

describe('PRD criteria (pure model)', () => {
  it('parseCriteria accepts snake_case and camelCase, trims, drops empties/non-strings', () => {
    const c = parseCriteria({
      requirements: [' R1 ', '', 2, 'R2'],
      security_expectations: ['no plaintext secrets'],
      acceptanceCriteria: ['A1'],
    });
    expect(c.requirements).toEqual(['R1', 'R2']);
    expect(c.securityExpectations).toEqual(['no plaintext secrets']);
    expect(c.acceptanceCriteria).toEqual(['A1']);
    expect(c.riskAreas).toEqual([]);
  });

  it('mergeCriteria unions, dedupes, and stable-sorts (deterministic reduce)', () => {
    const a = { ...emptyCriteria(), requirements: ['B', 'A'] };
    const b = { ...emptyCriteria(), requirements: ['A', 'C'], truncated: true };
    const merged = mergeCriteria([a, b]);
    expect(merged.requirements).toEqual(['A', 'B', 'C']);
    expect(merged.truncated).toBe(true); // truncation propagates
  });

  it('contentHash is stable and criteriaKey changes only when an input changes', () => {
    expect(contentHash('PRD')).toBe(contentHash('PRD'));
    const base = {
      tenantId: 't',
      repo: 'o/r',
      sourceRef: 'paste:1',
      contentHash: contentHash('PRD'),
      extractionVersion: 'v1',
      taxonomyVersion: 'tax1',
    };
    const k1 = criteriaKey(base);
    expect(criteriaKey(base)).toBe(k1); // same inputs → same key
    expect(criteriaKey({ ...base, contentHash: contentHash('PRD v2') })).not.toBe(k1); // edit → new key
    expect(criteriaKey({ ...base, taxonomyVersion: 'tax2' })).not.toBe(k1); // taxonomy drift → new key
  });

  it('renderCriteriaContext is empty for empty criteria and flags truncation', () => {
    expect(renderCriteriaContext(emptyCriteria())).toBe('');
    const ctx = renderCriteriaContext({ ...emptyCriteria(), requirements: ['R1'], truncated: true });
    expect(ctx).toContain('PARTIAL');
    expect(ctx).toContain('Requirements:');
    expect(ctx).toContain('- R1');
  });

  it('chunkPrdText splits on headings, bounds windows, and caps with truncation', () => {
    const text = '# A\n' + 'x'.repeat(30) + '\n# B\n' + 'y'.repeat(30);
    const bounded = chunkPrdText(text, { maxChunkChars: 20, maxChunks: 10 });
    expect(bounded.chunks.length).toBeGreaterThan(2); // headings + window splits
    expect(bounded.truncated).toBe(false);
    bounded.chunks.forEach((c) => expect(c.text.length).toBeLessThanOrEqual(20));

    const capped = chunkPrdText(text, { maxChunkChars: 20, maxChunks: 1 });
    expect(capped.chunks).toHaveLength(1);
    expect(capped.truncated).toBe(true); // over-budget → keep head, never silent drop
  });
});
