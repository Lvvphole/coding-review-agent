import type { DiffFile } from './diff-parser.js';

/**
 * Deterministic pre-LLM filters — HARD-RULE-007, FR-CTX-003..012.
 * Every skipped file is recorded with a reason (FR-CTX-012); high-risk files
 * are never silently skipped (FR-CTX-023 — enforced by the budgeter which
 * routes oversized high-risk files to chunking or EVT_CONTEXT_BLOCKED).
 */

export type SkipReason =
  | 'reviewignore'
  | 'generated_file'
  | 'lockfile'
  | 'minified_file'
  | 'binary_file'
  | 'deleted_file'
  | 'max_files_budget'
  | 'max_changed_lines_budget'
  | 'oversized_low_risk';

export interface FileDecision {
  file: DiffFile;
  included: boolean;
  skipReason?: SkipReason;
  highRisk: boolean;
  highRiskCategory?: string;
}

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
]);

const GENERATED_MARKERS = [/\.generated\./, /_pb2\.py$/, /\.pb\.go$/, /__generated__\//, /\.snap$/];

export function isLockfile(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  return LOCKFILE_NAMES.has(base);
}

export function isGeneratedFile(path: string): boolean {
  return GENERATED_MARKERS.some((re) => re.test(path));
}

export function isMinifiedFile(path: string): boolean {
  return /\.min\.(js|css)$/.test(path);
}

/** Glob-lite matcher supporting ** and * — enough for .reviewignore and high-risk paths. */
export function globMatch(pattern: string, path: string): boolean {
  const esc = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${esc}$`).test(path);
}

export function parseReviewIgnore(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

export interface HighRiskConfig {
  /** category → glob patterns, from configs/review/high-risk-paths.yaml (FR-RISK-001). */
  categories: Record<string, string[]>;
}

export function classifyHighRisk(
  path: string,
  config: HighRiskConfig,
): { highRisk: boolean; category?: string } {
  for (const [category, patterns] of Object.entries(config.categories)) {
    if (patterns.some((p) => globMatch(p, path))) return { highRisk: true, category };
  }
  return { highRisk: false };
}
