-- Sprint 7 — Review modes (PRD v6.5 §10, HARD-RULE-UX-002/003).
-- A per-repo preset (light/standard/strict) over the existing review controls.
-- Modes tune comment volume and depth only; the safety floor is identical
-- across all three (§3, enforced in code by applyMode). Default is Standard.
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS review_mode TEXT NOT NULL DEFAULT 'standard'
    CHECK (review_mode IN ('light', 'standard', 'strict'));
