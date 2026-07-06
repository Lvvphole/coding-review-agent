import { parse as parseYaml } from 'yaml';
import type { RunIdentity } from '@review-bot/shared';
import type { RepoFileReader } from '../prd/prd-store.js';
import { isReviewMode, type ReviewMode } from './modes.js';

/**
 * `.github/review-bot.yml` opt-in repo-config layer — PRD v6.5 §9.3,
 * HARD-RULE-UX-003.
 *
 * An OPTIONAL advanced control, never required for first use (UX-002/003):
 * a repo may commit a `.github/review-bot.yml` to override its review mode
 * without touching the admin API. It slots ABOVE the admin-stored mode in the
 * resolution precedence documented in mode-store.ts:
 *
 *   .github/review-bot.yml  >  admin-stored repo mode  >  managed default
 *
 * Read at the PR head SHA via the same fenced `RepoFileReader` seam as
 * repo_path PRDs, so a mid-run edit cannot affect an in-flight run. Mode is not
 * a safety gate: an absent, unreadable, or malformed file (or an unknown value)
 * yields NO override and falls back to the stored mode — safe silence over
 * unsafe guessing (HARD-RULE-UX-006). The safety floor is applied by applyMode
 * regardless of the resolved mode.
 */

export const REPO_CONFIG_PATH = '.github/review-bot.yml';

export interface RepoConfig {
  /** Present only when the file specifies a valid `review.mode`. */
  reviewMode?: ReviewMode;
}

/**
 * Parse a `.github/review-bot.yml` document into the subset the review path
 * consumes. Total and non-throwing: any parse error or shape mismatch → {}
 * (no override), so a malformed advanced-control file never fails a review.
 */
export function parseRepoConfig(text: string): RepoConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return {};
  }
  if (!doc || typeof doc !== 'object') return {};
  const review = (doc as { review?: unknown }).review;
  const mode = review && typeof review === 'object' ? (review as { mode?: unknown }).mode : undefined;
  return isReviewMode(mode) ? { reviewMode: mode } : {};
}

export interface RepoConfigResolver {
  /** The repo's opt-in config for this run, or null when none applies. */
  resolve(run: RunIdentity): Promise<RepoConfig | null>;
}

/** Reads + parses `.github/review-bot.yml` at the run's head SHA. */
export class RepoFileConfigResolver implements RepoConfigResolver {
  constructor(private readonly reader: RepoFileReader) {}

  async resolve(run: RunIdentity): Promise<RepoConfig | null> {
    let text: string | null;
    try {
      text = await this.reader.read(run.repo, REPO_CONFIG_PATH, run.headSha);
    } catch {
      // A read failure on an OPTIONAL control must never fail the run — fall
      // back to the stored mode (HARD-RULE-UX-006).
      return null;
    }
    if (text === null || text.trim().length === 0) return null;
    return parseRepoConfig(text);
  }
}
