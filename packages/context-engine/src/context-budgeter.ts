import type { DiffFile } from './diff-parser.js';
import {
  classifyHighRisk,
  globMatch,
  isGeneratedFile,
  isLockfile,
  isMinifiedFile,
  parseReviewIgnore,
  type FileDecision,
  type HighRiskConfig,
} from './file-filters.js';

/**
 * Context budgeting — FR-CTX-003..012, FR-CTX-015, FR-CTX-021..023.
 *
 * High-risk files are prioritized (FR-CTX-011) and never silently skipped
 * (FR-CTX-023): an oversized high-risk file is flagged for chunking; when
 * chunking is unavailable in this sprint it is reported as blocked so it
 * appears in the PR summary (FR-CTX-022).
 */

export interface ContextPolicy {
  maxFiles: number;
  maxChangedLines: number;
  maxFileBytes: number;
  ignoreLockfiles: boolean;
  ignoreGeneratedFiles: boolean;
  ignoreMinifiedFiles: boolean;
  ignoreBinaryFiles: boolean;
}

export interface ContextPlan {
  included: FileDecision[];
  skipped: FileDecision[];
  /** High-risk oversized files requiring chunking or explicit block (FR-CTX-015/021). */
  blockedHighRisk: FileDecision[];
  totalChangedLines: number;
}

export function buildContextPlan(
  files: DiffFile[],
  opts: {
    policy: ContextPolicy;
    reviewIgnoreContent?: string;
    highRisk: HighRiskConfig;
    /** file path → byte size of new content, when known. */
    fileSizes?: Map<string, number>;
  },
): ContextPlan {
  const ignorePatterns = opts.reviewIgnoreContent
    ? parseReviewIgnore(opts.reviewIgnoreContent)
    : [];

  const decisions: FileDecision[] = files.map((file) => {
    const risk = classifyHighRisk(file.path, opts.highRisk);
    const d: FileDecision = {
      file,
      included: true,
      highRisk: risk.highRisk,
    };
    if (risk.category !== undefined) d.highRiskCategory = risk.category;

    if (file.isDeleted) return { ...d, included: false, skipReason: 'deleted_file' };
    if (opts.policy.ignoreBinaryFiles && file.isBinary)
      return { ...d, included: false, skipReason: 'binary_file' };
    if (ignorePatterns.some((p) => globMatch(p, file.path)))
      return { ...d, included: false, skipReason: 'reviewignore' };
    if (opts.policy.ignoreGeneratedFiles && isGeneratedFile(file.path))
      return { ...d, included: false, skipReason: 'generated_file' };
    if (opts.policy.ignoreLockfiles && isLockfile(file.path))
      return { ...d, included: false, skipReason: 'lockfile' };
    if (opts.policy.ignoreMinifiedFiles && isMinifiedFile(file.path))
      return { ...d, included: false, skipReason: 'minified_file' };
    return d;
  });

  const skipped = decisions.filter((d) => !d.included);
  const blockedHighRisk: FileDecision[] = [];
  let candidates = decisions.filter((d) => d.included);

  // Oversized handling: low-risk oversized files are skipped/summarized
  // (FR-CTX-008); high-risk oversized files route to chunking (FR-CTX-015).
  candidates = candidates.filter((d) => {
    const size = opts.fileSizes?.get(d.file.path);
    if (size !== undefined && size > opts.policy.maxFileBytes) {
      if (d.highRisk) {
        blockedHighRisk.push(d);
        return false;
      }
      d.included = false;
      d.skipReason = 'oversized_low_risk';
      skipped.push(d);
      return false;
    }
    return true;
  });

  // Prioritize high-risk paths (FR-CTX-011), then larger diffs first;
  // deterministic tiebreak on path.
  candidates.sort((a, b) => {
    if (a.highRisk !== b.highRisk) return a.highRisk ? -1 : 1;
    if (a.file.addedLineCount !== b.file.addedLineCount) {
      return b.file.addedLineCount - a.file.addedLineCount;
    }
    return a.file.path.localeCompare(b.file.path);
  });

  const included: FileDecision[] = [];
  let totalChangedLines = 0;
  for (const d of candidates) {
    if (included.length >= opts.policy.maxFiles) {
      if (d.highRisk) {
        blockedHighRisk.push(d); // never silently skip high-risk (FR-CTX-023)
      } else {
        d.included = false;
        d.skipReason = 'max_files_budget';
        skipped.push(d);
      }
      continue;
    }
    if (totalChangedLines + d.file.addedLineCount > opts.policy.maxChangedLines) {
      if (d.highRisk) {
        blockedHighRisk.push(d);
      } else {
        d.included = false;
        d.skipReason = 'max_changed_lines_budget';
        skipped.push(d);
      }
      continue;
    }
    totalChangedLines += d.file.addedLineCount;
    included.push(d);
  }

  return { included, skipped, blockedHighRisk, totalChangedLines };
}
