import { describe, expect, it } from 'vitest';
import type { Category } from '@review-bot/shared';
import type { ValidationPolicy } from '@review-bot/validators';
import type { ContextPolicy } from '@review-bot/context-engine';
import {
  applyMode,
  isReviewMode,
  MODE_PRESETS,
  REVIEW_MODES,
  DEFAULT_REVIEW_MODE,
  type BasePolicies,
} from '../../apps/ci-review-bot/src/review-modes/modes.js';

/**
 * Review-mode presets — PRD v6.5 §10, HARD-RULE-UX-002/003. The safety floor
 * (§3) must be identical across all modes; modes only tune volume and depth.
 */

const baseValidation: ValidationPolicy = {
  confidenceThreshold: 0.8,
  highSeverityConfidenceThreshold: 0.9,
  requireDeterministicEvidenceForHighSeverity: true,
  approvedRootCauseIds: new Set(['X']),
};
const baseContext: ContextPolicy = {
  maxFiles: 40,
  maxChangedLines: 1200,
  maxFileBytes: 80000,
  ignoreLockfiles: true,
  ignoreGeneratedFiles: true,
  ignoreMinifiedFiles: true,
  ignoreBinaryFiles: true,
};
const base: BasePolicies = {
  validationPolicy: baseValidation,
  contextPolicy: baseContext,
  maxInlineComments: 10,
};

describe('review mode presets', () => {
  it('Standard is the default and matches the §10 base (style suppressed, base floors)', () => {
    expect(DEFAULT_REVIEW_MODE).toBe('standard');
    const eff = applyMode(base, 'standard');
    expect(eff.maxInlineComments).toBe(10);
    expect(eff.validationPolicy.confidenceThreshold).toBe(0.8);
    expect(eff.validationPolicy.highSeverityConfidenceThreshold).toBe(0.9);
    expect([...eff.suppressedCategories]).toEqual(['style']);
  });

  it('Light is the lowest volume: smaller cap, raised general floor, more categories suppressed', () => {
    const eff = applyMode(base, 'light');
    expect(eff.maxInlineComments).toBe(5);
    // General floor rises (fewer, surer); high-severity floor stays at base so
    // security/bugs still surface.
    expect(eff.validationPolicy.confidenceThreshold).toBeCloseTo(0.9);
    expect(eff.validationPolicy.highSeverityConfidenceThreshold).toBe(0.9);
    expect(eff.suppressedCategories.has('maintainability' as Category)).toBe(true);
    expect(eff.suppressedCategories.has('performance' as Category)).toBe(true);
  });

  it('Strict is the deepest: highest cap, nothing suppressed, finer chunking', () => {
    const eff = applyMode(base, 'strict');
    expect(eff.maxInlineComments).toBe(20);
    expect(eff.suppressedCategories.size).toBe(0);
    expect(eff.contextPolicy.maxChunkLines).toBe(200);
  });

  it('SAFETY FLOOR INVARIANT: no mode lowers a floor, weakens evidence, or suppresses security/bug', () => {
    for (const mode of REVIEW_MODES) {
      const eff = applyMode(base, mode);
      // Confidence floors are raise-only.
      expect(eff.validationPolicy.confidenceThreshold).toBeGreaterThanOrEqual(
        base.validationPolicy.confidenceThreshold,
      );
      expect(eff.validationPolicy.highSeverityConfidenceThreshold).toBeGreaterThanOrEqual(
        base.validationPolicy.highSeverityConfidenceThreshold,
      );
      // Deterministic-evidence requirement and taxonomy are never touched.
      expect(eff.validationPolicy.requireDeterministicEvidenceForHighSeverity).toBe(true);
      expect(eff.validationPolicy.approvedRootCauseIds).toBe(base.validationPolicy.approvedRootCauseIds);
      // security and bug are surfaced in every mode.
      expect(eff.suppressedCategories.has('security' as Category)).toBe(false);
      expect(eff.suppressedCategories.has('bug' as Category)).toBe(false);
      // Floors never exceed 1.0.
      expect(eff.validationPolicy.highSeverityConfidenceThreshold).toBeLessThanOrEqual(1);
    }
  });

  it('every preset declares a non-negative confidence delta (raise-only)', () => {
    for (const mode of REVIEW_MODES) {
      expect(MODE_PRESETS[mode].normalConfidenceDelta).toBeGreaterThanOrEqual(0);
    }
  });

  it('isReviewMode guards unknown values', () => {
    expect(isReviewMode('strict')).toBe(true);
    expect(isReviewMode('aggressive')).toBe(false);
    expect(isReviewMode(undefined)).toBe(false);
  });
});
