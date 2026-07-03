import { describe, expect, it } from 'vitest';
import {
  compileTaxonomy,
  mapRootCause,
  TaxonomyCompileError,
  validateFinding,
  type TaxonomyDocument,
  type ValidationPolicy,
} from '@review-bot/validators';
import {
  buildSymbolSkeleton,
  chunkHighRiskFile,
  languageSupportFor,
  parseUnifiedDiff,
  renderChunkPreamble,
  renderSkeleton,
} from '@review-bot/context-engine';
import { buildDiffLineIndex } from '@review-bot/context-engine';
import type { ReviewFinding } from '@review-bot/shared';

/** Sprint 4 — taxonomy TAX series + context CTX-009..017. */

const DOC: TaxonomyDocument = {
  taxonomy: {
    version: '2026-07-03',
    global: [
      {
        id: 'AUTHZ.MISSING_AUTHORIZATION_CHECK',
        family: 'AUTHORIZATION',
        category: 'security',
        aliases: ['auth bypass', 'missing auth check'],
      },
      {
        id: 'INPUT.SQL_INJECTION_RISK',
        family: 'INPUT_VALIDATION',
        category: 'security',
        aliases: ['sql injection'],
      },
    ],
    repository_extensions: {
      enabled: true,
      rules: [
        {
          repo_id: 'org/proj',
          allowed_extensions: [
            {
              id: 'BUSINESS.TENANT_SCOPE_MISSING',
              parent_id: 'AUTHZ.MISSING_AUTHORIZATION_CHECK',
              family: 'AUTHORIZATION',
              category: 'security',
              aliases: ['missing tenant scope'],
            },
          ],
        },
      ],
    },
  },
};

describe('taxonomy compilation (§16)', () => {
  it('TAX-001/002: global IDs and valid extensions with global parent pass', () => {
    const compiled = compileTaxonomy(DOC, 'org/proj');
    expect(compiled.approvedIds.has('AUTHZ.MISSING_AUTHORIZATION_CHECK')).toBe(true);
    expect(compiled.approvedIds.has('BUSINESS.TENANT_SCOPE_MISSING')).toBe(true);
    expect(compiled.extensionParents.get('BUSINESS.TENANT_SCOPE_MISSING')).toBe(
      'AUTHZ.MISSING_AUTHORIZATION_CHECK',
    );
  });

  it('extensions for other repos are not compiled in', () => {
    const compiled = compileTaxonomy(DOC, 'other/repo');
    expect(compiled.approvedIds.has('BUSINESS.TENANT_SCOPE_MISSING')).toBe(false);
  });

  it('TAX-003: extension without parent_id fails', () => {
    const bad = structuredClone(DOC);
    bad.taxonomy.repository_extensions!.rules[0]!.allowed_extensions[0]!.parent_id = '';
    expect(() => compileTaxonomy(bad, 'org/proj')).toThrow(TaxonomyCompileError);
  });

  it('TAX-004/FORBIDDEN-024: extension overriding a global ID fails', () => {
    const bad = structuredClone(DOC);
    bad.taxonomy.repository_extensions!.rules[0]!.allowed_extensions[0]!.id =
      'INPUT.SQL_INJECTION_RISK';
    expect(() => compileTaxonomy(bad, 'org/proj')).toThrow(/overrides a global/);
  });

  it('extension with unknown parent fails', () => {
    const bad = structuredClone(DOC);
    bad.taxonomy.repository_extensions!.rules[0]!.allowed_extensions[0]!.parent_id = 'NOT.A_REAL_ID';
    expect(() => compileTaxonomy(bad, 'org/proj')).toThrow(/not a global canonical/);
  });

  it('TAX-005: agent alias maps to canonical root_cause_id', () => {
    const compiled = compileTaxonomy(DOC, 'org/proj');
    expect(mapRootCause(compiled, 'sql injection')).toBe('INPUT.SQL_INJECTION_RISK');
    expect(mapRootCause(compiled, 'SQL Injection')).toBe('INPUT.SQL_INJECTION_RISK');
    expect(mapRootCause(compiled, 'INPUT.SQL_INJECTION_RISK')).toBe('INPUT.SQL_INJECTION_RISK');
  });

  it('TAX-006: unmapped root cause returns null → NEEDS_TAXONOMY_MAPPING', () => {
    const compiled = compileTaxonomy(DOC);
    expect(mapRootCause(compiled, 'something novel')).toBeNull();
  });

  it('validator canonicalizes aliases before approval (TAX-005 end-to-end)', () => {
    const compiled = compileTaxonomy(DOC);
    const diff = `diff --git a/src/q.ts b/src/q.ts
--- a/src/q.ts
+++ b/src/q.ts
@@ -1,1 +1,2 @@
 x
+const q = "SELECT * FROM t WHERE id = " + id;
`;
    const index = buildDiffLineIndex(parseUnifiedDiff(diff));
    const policy: ValidationPolicy = {
      confidenceThreshold: 0.8,
      highSeverityConfidenceThreshold: 0.9,
      requireDeterministicEvidenceForHighSeverity: true,
      approvedRootCauseIds: compiled.approvedIds,
      taxonomy: compiled,
    };
    const finding: ReviewFinding = {
      finding_id: 'f1',
      severity: 'high',
      category: 'security',
      file: 'src/q.ts',
      line: 2,
      title: 'SQL injection',
      evidence: 'const q = "SELECT * FROM t WHERE id = " + id;',
      recommendation: 'parameterize',
      confidence: 0.95,
      agent_source: 'security-reviewer',
      root_cause_id: 'sql injection', // alias, not canonical
      root_cause_family: 'INPUT_VALIDATION',
      root_cause_source: 'global',
      taxonomy_version: 'stale',
    };
    const result = validateFinding(finding, index, policy);
    expect(result.disposition).toBe('VALIDATED');
    expect(result.finding.root_cause_id).toBe('INPUT.SQL_INJECTION_RISK');
    expect(result.finding.taxonomy_version).toBe('2026-07-03');
  });
});

const BIG_FILE_DIFF = `diff --git a/src/auth/service.ts b/src/auth/service.ts
--- a/src/auth/service.ts
+++ b/src/auth/service.ts
@@ -1,2 +1,5 @@
 import { db } from './db';
+export class AuthService {
+  async login(user: string, password: string) {
+    return db.query("SELECT * FROM users WHERE name='" + user + "'");
+  }
@@ -20,1 +23,4 @@
 }
+export function validateToken(token: string) {
+  return token.length > 0;
+}
`;

describe('symbol skeleton (CTX-014..017)', () => {
  const content = [
    "import { db } from './db';",
    'export class AuthService {',
    '  async login(user: string, password: string) {',
    '    const secretImpl = 1;',
    '  }',
    '}',
    'export function validateToken(token: string) {',
    '  return token.length > 0;',
    '}',
  ].join('\n');

  it('CTX-017: preserves signatures with line numbers; CTX-016: strips bodies', () => {
    const skeleton = buildSymbolSkeleton('src/auth/service.ts', content);
    const rendered = renderSkeleton(skeleton);
    expect(rendered).toContain('L2: export class AuthService {');
    expect(rendered).toContain('L7: export function validateToken(token: string) {');
    expect(rendered).not.toContain('secretImpl'); // implementation body excluded
  });

  it('flags security-sensitive symbols', () => {
    const skeleton = buildSymbolSkeleton('src/auth/service.ts', content);
    expect(skeleton.lines.some((l) => l.securitySensitive)).toBe(true);
  });

  it('FR-AST-001/002: unsupported languages fall back with disclosure', () => {
    expect(languageSupportFor('src/main.zig').skeleton).toBe('none');
    const skeleton = buildSymbolSkeleton('src/main.zig', 'pub fn main() void {}');
    expect(skeleton.lines).toHaveLength(0);
    expect(renderSkeleton(skeleton)).toContain('no symbol skeleton');
  });
});

describe('high-risk chunking (CTX-009..013)', () => {
  const file = parseUnifiedDiff(BIG_FILE_DIFF)[0]!;

  it('CTX-011: chunks by diff hunk boundaries with full metadata (FR-CTX-019)', () => {
    const chunks = chunkHighRiskFile(file, {
      policy: { maxChunkLines: 200 },
      reason: 'security',
    });
    expect(chunks).toHaveLength(2); // one per hunk
    expect(chunks[0]).toMatchObject({
      filePath: 'src/auth/service.ts',
      chunkIndex: 1,
      totalChunks: 2,
      strategy: 'diff_hunk',
      reason: 'security',
    });
    expect(chunks[0]!.startLine).toBe(2);
  });

  it('CTX-010/FR-CTX-024: chunk content preserves original line numbers', () => {
    const chunks = chunkHighRiskFile(file, { policy: { maxChunkLines: 200 }, reason: 'security' });
    expect(chunks[0]!.content).toContain('L2: export class AuthService {');
    // Hunk +23,4 starts with a context line, so the added symbol is line 24.
    expect(chunks[1]!.content).toContain('L24: export function validateToken');
  });

  it('oversized hunks split into bounded line windows (FR-CTX-018)', () => {
    const chunks = chunkHighRiskFile(file, { policy: { maxChunkLines: 2 }, reason: 'security' });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.strategy === 'line_window' || c.content.split('\n').length <= 2)).toBe(true);
  });

  it('FR-CTX-025: every chunk carries the whole-file symbol skeleton', () => {
    const chunks = chunkHighRiskFile(file, { policy: { maxChunkLines: 2 }, reason: 'security' });
    for (const chunk of chunks) {
      expect(chunk.skeleton).toContain('AuthService');
    }
    const preamble = renderChunkPreamble(chunks[0]!);
    expect(preamble).toContain('HIGH-RISK FILE CHUNK');
    expect(preamble).toContain('symbol skeleton');
  });
});
