import type { Pool } from 'pg';
import { DEFAULT_REVIEW_MODE, isReviewMode, type ReviewMode } from './modes.js';

/**
 * Per-repo review-mode resolution — PRD v6.5 §9.3, HARD-RULE-UX-003.
 *
 * Resolution precedence (single authority in this sprint): the repository's
 * stored mode → managed default (Standard). The optional `.github/review-bot.yml`
 * opt-in layer (HARD-RULE-UX-003) slots in above the stored mode later without
 * changing this contract.
 *
 * Mode is NOT a safety gate: an unreadable/unknown value resolves to the
 * default rather than failing the run (the safety floor is applied by
 * applyMode regardless of mode).
 */
export interface ModeResolver {
  resolveMode(tenantId: string, repo: string): Promise<ReviewMode>;
}

export class ModeStore implements ModeResolver {
  constructor(private readonly pool: Pool) {}

  async resolveMode(_tenantId: string, repo: string): Promise<ReviewMode> {
    const res = await this.pool.query(
      `SELECT review_mode FROM repositories WHERE repo_full_name = $1 AND active`,
      [repo],
    );
    const raw = res.rows[0]?.review_mode;
    return isReviewMode(raw) ? raw : DEFAULT_REVIEW_MODE;
  }

  /** Admin surface (Sprint 10) sets a repo's mode; returns false if no active repo. */
  async setMode(repoFullName: string, mode: ReviewMode): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE repositories SET review_mode = $2, updated_at = now()
        WHERE repo_full_name = $1 AND active`,
      [repoFullName, mode],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
