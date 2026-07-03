/**
 * Symbol Skeleton — PRD v6.5 FR-CTX-025..029 + §15.10 language matrix.
 *
 * A lightweight whole-file outline (classes, function signatures,
 * imports/exports, security-sensitive names) injected as DYNAMIC per-file
 * context into every chunk prompt — never into the stable global prefix
 * (HARD-RULE-021, FORBIDDEN-021). Line numbers are preserved (FR-CTX-028).
 *
 * Extraction is pattern-based, not full AST parsing. The support matrix
 * discloses this explicitly (FR-AST-001/003): findings carry
 * ast_supported=false until a tree-sitter tier lands, and dedupe records
 * which tier matched (FR-AST-004).
 */

export type SkeletonSupport = 'pattern' | 'none';

/** Supported-language matrix — FR-AST-001; unsupported falls back (FR-AST-002). */
export const LANGUAGE_MATRIX: Record<string, { skeleton: SkeletonSupport; ast: false }> = {
  ts: { skeleton: 'pattern', ast: false },
  tsx: { skeleton: 'pattern', ast: false },
  js: { skeleton: 'pattern', ast: false },
  jsx: { skeleton: 'pattern', ast: false },
  mjs: { skeleton: 'pattern', ast: false },
  py: { skeleton: 'pattern', ast: false },
  go: { skeleton: 'pattern', ast: false },
  java: { skeleton: 'pattern', ast: false },
  rb: { skeleton: 'pattern', ast: false },
};

export function languageSupportFor(filePath: string): { skeleton: SkeletonSupport; ast: false } {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_MATRIX[ext] ?? { skeleton: 'none', ast: false };
}

const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+\w+/,
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*\w+\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(?[\w\s,{}:[\]]*\)?\s*=>/,
  /^\s*(?:export\s+)?interface\s+\w+/,
  /^\s*(?:export\s+)?type\s+\w+\s*=/,
  /^\s*(?:export\s+)?enum\s+\w+/,
  /^\s*import\s.+from\s/,
  /^\s*(?:from\s+\S+\s+)?import\s+\S+/, // python imports
  /^\s*def\s+\w+\s*\(/, // python
  /^\s*(?:public|private|protected|static|final|synchronized)\s+[\w<>[\]]+\s+\w+\s*\(/, // java methods
  /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/, // go
  /^\s*(?:module|class|def)\s+\w+/, // ruby
];

const SECURITY_SENSITIVE = /auth|token|secret|password|credential|crypt|permission|session|sanitiz/i;

export interface SkeletonLine {
  line: number;
  text: string;
  securitySensitive: boolean;
}

export interface SymbolSkeleton {
  filePath: string;
  support: SkeletonSupport;
  lines: SkeletonLine[];
}

/** Builds the skeleton from exact head_sha file content (FR-REPO-006). */
export function buildSymbolSkeleton(filePath: string, content: string): SymbolSkeleton {
  const support = languageSupportFor(filePath).skeleton;
  if (support === 'none') return { filePath, support, lines: [] };

  const lines: SkeletonLine[] = [];
  content.split('\n').forEach((text, index) => {
    if (SYMBOL_PATTERNS.some((re) => re.test(text))) {
      lines.push({
        line: index + 1,
        // Signature only — implementation bodies stay out unless the symbol
        // is inside the active chunk (FR-CTX-027).
        text: text.trimEnd().slice(0, 200),
        securitySensitive: SECURITY_SENSITIVE.test(text),
      });
    }
  });
  return { filePath, support, lines };
}

/** Renders the skeleton for the dynamic per-file preamble (FR-CTX-031). */
export function renderSkeleton(skeleton: SymbolSkeleton): string {
  if (skeleton.lines.length === 0) return '(no symbol skeleton available for this file type)';
  return skeleton.lines
    .map((l) => `L${l.line}: ${l.text.trim()}${l.securitySensitive ? '  // security-sensitive' : ''}`)
    .join('\n');
}
