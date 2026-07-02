import type { ReviewFinding } from '@review-bot/shared';

/**
 * Line mapping validation — posting rule 8, G15, FORBIDDEN-009.
 * A finding may only anchor to a line that exists in the current diff for the
 * named file.
 */

export interface DiffLineIndex {
  /** file path → set of changed (added) line numbers in the new file version. */
  changedLines: Map<string, Set<number>>;
  /** file path → line number → text of that changed line. */
  changedLineText: Map<string, Map<number, string>>;
}

export function validateLineMapping(
  finding: Pick<ReviewFinding, 'file' | 'line'>,
  index: DiffLineIndex,
): { ok: boolean; reasons: string[] } {
  const lines = index.changedLines.get(finding.file);
  if (!lines) {
    return { ok: false, reasons: [`file ${finding.file} is not part of the reviewed diff`] };
  }
  if (!lines.has(finding.line)) {
    return {
      ok: false,
      reasons: [`line ${finding.line} is not a changed line in ${finding.file}`],
    };
  }
  return { ok: true, reasons: [] };
}
