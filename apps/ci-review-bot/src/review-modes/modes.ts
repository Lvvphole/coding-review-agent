import type { Category } from '@review-bot/shared';
import type { ValidationPolicy } from '@review-bot/validators';
import type { ContextPolicy } from '@review-bot/context-engine';

/**
 * Review modes — PRD v6.5 §10, HARD-RULE-UX-002/003. A user-facing preset over
 * the platform's existing review controls (comment cap, confidence floors,
 * category surfacing, high-risk chunk depth). Modes tune **volume and depth**;
 * the safety floor is identical across all three (§3):
 *
 *   - the general confidence floor is raise-only (delta >= 0) — a mode can
 *     demand MORE certainty, never less (HARD-RULE-010). The high-severity
 *     floor is never touched, so obvious bugs and security risks surface in
 *     every mode (including Light);
 *   - requireDeterministicEvidenceForHighSeverity, taxonomy, latest-SHA
 *     posting, redaction, and Gateway-only access are never touched;
 *   - security and bug are never suppressed in any mode.
 *
 * The invariant is proven in tests over every mode (see review-modes.test.ts).
 */

export type ReviewMode = 'light' | 'standard' | 'strict';
export const REVIEW_MODES: readonly ReviewMode[] = ['light', 'standard', 'strict'];
export const DEFAULT_REVIEW_MODE: ReviewMode = 'standard';

export function isReviewMode(value: unknown): value is ReviewMode {
  return value === 'light' || value === 'standard' || value === 'strict';
}

export interface ModePreset {
  /** max_inline_comments cap (HARD-RULE-043). */
  maxInlineComments: number;
  /**
   * Added to the GENERAL confidence floor only; MUST be >= 0 (never lowered).
   * The high-severity floor is deliberately left at base so security/bug
   * findings surface in every mode.
   */
  normalConfidenceDelta: number;
  /** Categories not surfaced in this mode. Never contains 'security' or 'bug'. */
  suppressedCategories: ReadonlySet<Category>;
  /** High-risk chunk window; finer window = deeper review. undefined = engine default. */
  maxChunkLines?: number;
}

export const MODE_PRESETS: Record<ReviewMode, ModePreset> = {
  // Fewer, surer comments: raise the general floor and surface only the
  // highest-signal categories. High-severity detection is unchanged.
  light: {
    maxInlineComments: 5,
    normalConfidenceDelta: 0.1,
    suppressedCategories: new Set<Category>(['style', 'maintainability', 'performance']),
  },
  // Default: matches the §10 default config (style suppressed, base floors).
  standard: {
    maxInlineComments: 10,
    normalConfidenceDelta: 0,
    suppressedCategories: new Set<Category>(['style']),
  },
  // Deepest: surface everything and chunk high-risk files more finely.
  strict: {
    maxInlineComments: 20,
    normalConfidenceDelta: 0,
    suppressedCategories: new Set<Category>(),
    maxChunkLines: 200,
  },
};

export interface BasePolicies {
  validationPolicy: ValidationPolicy;
  contextPolicy: ContextPolicy;
  maxInlineComments: number;
}

export interface EffectivePolicies {
  validationPolicy: ValidationPolicy;
  contextPolicy: ContextPolicy;
  maxInlineComments: number;
  suppressedCategories: ReadonlySet<Category>;
  mode: ReviewMode;
}

/**
 * Pure preset application. Confidence floors only rise; every other safety
 * control passes through unchanged. Determinism: same (base, mode) → same
 * output, so a run's effective policy is a function of the resolved mode.
 */
export function applyMode(base: BasePolicies, mode: ReviewMode): EffectivePolicies {
  const preset = MODE_PRESETS[mode];
  return {
    validationPolicy: {
      ...base.validationPolicy,
      // General floor rises with the mode; high-severity floor stays at base so
      // security/bug findings surface in every mode.
      confidenceThreshold: Math.min(1, base.validationPolicy.confidenceThreshold + preset.normalConfidenceDelta),
    },
    contextPolicy: {
      ...base.contextPolicy,
      ...(preset.maxChunkLines !== undefined ? { maxChunkLines: preset.maxChunkLines } : {}),
    },
    maxInlineComments: preset.maxInlineComments,
    suppressedCategories: preset.suppressedCategories,
    mode,
  };
}
