/**
 * Unified diff parser — FR-CTX-001.
 * Produces per-file changed-line indexes used by line-mapping validation (G15)
 * and deterministic evidence checks (G14).
 */

export interface DiffHunk {
  newStart: number;
  newLines: number;
  /** Added-line numbers (new file coordinates) → line text without the '+'. */
  addedLines: Map<number, string>;
}

export interface DiffFile {
  path: string;
  oldPath: string;
  isBinary: boolean;
  isDeleted: boolean;
  isRenameOnly: boolean;
  hunks: DiffHunk[];
  addedLineCount: number;
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = {
        path: '',
        oldPath: '',
        isBinary: false,
        isDeleted: false,
        isRenameOnly: true,
        hunks: [],
        addedLineCount: 0,
      };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;

    if (raw.startsWith('--- ')) {
      current.oldPath = raw.slice(4).replace(/^a\//, '').trim();
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '').trim();
      current.path = p;
      current.isDeleted = p === '/dev/null';
      continue;
    }
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      current.isBinary = true;
      continue;
    }
    const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunkHeader) {
      current.isRenameOnly = false;
      newLine = Number(hunkHeader[1]);
      hunk = {
        newStart: newLine,
        newLines: hunkHeader[2] ? Number(hunkHeader[2]) : 1,
        addedLines: new Map(),
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith('+')) {
      hunk.addedLines.set(newLine, raw.slice(1));
      current.addedLineCount += 1;
      newLine += 1;
    } else if (raw.startsWith('-')) {
      // old-file line; new-file line number does not advance
    } else {
      newLine += 1;
    }
  }
  return files.filter((f) => f.path !== '');
}

export interface BuiltDiffIndex {
  changedLines: Map<string, Set<number>>;
  changedLineText: Map<string, Map<number, string>>;
}

export function buildDiffLineIndex(files: DiffFile[]): BuiltDiffIndex {
  const changedLines = new Map<string, Set<number>>();
  const changedLineText = new Map<string, Map<number, string>>();
  for (const f of files) {
    if (f.isBinary || f.isDeleted) continue;
    const lines = new Set<number>();
    const text = new Map<number, string>();
    for (const h of f.hunks) {
      for (const [n, t] of h.addedLines) {
        lines.add(n);
        text.set(n, t);
      }
    }
    changedLines.set(f.path, lines);
    changedLineText.set(f.path, text);
  }
  return { changedLines, changedLineText };
}
