import type { DiffFile } from './diff-parser.js';
import { buildSymbolSkeleton, renderSkeleton } from './symbol-skeleton-builder.js';

/**
 * High-risk oversized file chunking — HARD-RULE-020, FR-CTX-015..024.
 *
 * Tier order (FR-CTX-016..018): AST boundaries are not yet available
 * (§15.10 matrix), so chunking uses diff-hunk boundaries, falling back to
 * bounded line windows for oversized hunks. Every chunk carries file path,
 * line range, index/total, and reason (FR-CTX-019); each chunk prompt gets
 * the whole-file Symbol Skeleton (FR-CTX-025).
 */

export interface FileChunk {
  filePath: string;
  chunkIndex: number;
  totalChunks: number;
  startLine: number;
  endLine: number;
  /** 'diff_hunk' or 'line_window' — recorded per FR-AST-004 tier disclosure. */
  strategy: 'diff_hunk' | 'line_window';
  reason: string;
  /** Changed lines in this chunk: "L<n>: <text>". */
  content: string;
  /** Rendered whole-file Symbol Skeleton (dynamic per-file context). */
  skeleton: string;
}

export interface ChunkPolicy {
  maxChunkLines: number;
}

export function chunkHighRiskFile(
  file: DiffFile,
  opts: {
    policy: ChunkPolicy;
    reason: string;
    /** Full file content at head_sha, when available (for the skeleton). */
    fileContent?: string;
  },
): FileChunk[] {
  const skeleton = renderSkeleton(
    buildSymbolSkeleton(file.path, opts.fileContent ?? hunksAsContent(file)),
  );

  // Tier 1 (AST) unavailable → tier 2: one chunk per diff hunk, splitting
  // oversized hunks into bounded line windows (tier 3).
  const windows: { start: number; end: number; lines: [number, string][]; strategy: FileChunk['strategy'] }[] = [];
  for (const hunk of file.hunks) {
    const entries = [...hunk.addedLines.entries()].sort((a, b) => a[0] - b[0]);
    if (entries.length === 0) continue;
    if (entries.length <= opts.policy.maxChunkLines) {
      windows.push({
        start: entries[0]![0],
        end: entries[entries.length - 1]![0],
        lines: entries,
        strategy: 'diff_hunk',
      });
    } else {
      for (let i = 0; i < entries.length; i += opts.policy.maxChunkLines) {
        const slice = entries.slice(i, i + opts.policy.maxChunkLines);
        windows.push({
          start: slice[0]![0],
          end: slice[slice.length - 1]![0],
          lines: slice,
          strategy: 'line_window',
        });
      }
    }
  }

  return windows.map((w, index) => ({
    filePath: file.path,
    chunkIndex: index + 1,
    totalChunks: windows.length,
    startLine: w.start,
    endLine: w.end,
    strategy: w.strategy,
    reason: opts.reason,
    content: w.lines.map(([n, text]) => `L${n}: ${text}`).join('\n'),
    skeleton,
  }));
}

function hunksAsContent(file: DiffFile): string {
  // Skeleton source fallback when whole-file content is unavailable: the
  // changed lines only. Line numbers stay faithful via padding.
  const byLine = new Map<number, string>();
  for (const hunk of file.hunks) for (const [n, t] of hunk.addedLines) byLine.set(n, t);
  const max = Math.max(0, ...byLine.keys());
  return Array.from({ length: max }, (_, i) => byLine.get(i + 1) ?? '').join('\n');
}

/** Renders chunk prompts for the dynamic per-file preamble (id="prompt-layout-v65"). */
export function renderChunkPreamble(chunk: FileChunk): string {
  return [
    `--- HIGH-RISK FILE CHUNK ---`,
    `file: ${chunk.filePath}`,
    `high-risk reason: ${chunk.reason}`,
    `chunk: ${chunk.chunkIndex}/${chunk.totalChunks} (lines ${chunk.startLine}-${chunk.endLine}, strategy: ${chunk.strategy})`,
    `symbol skeleton (whole file):`,
    chunk.skeleton,
    `changed lines:`,
    chunk.content,
  ].join('\n');
}
