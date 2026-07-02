import { describe, expect, it } from 'vitest';
import {
  buildContextPlan,
  parseUnifiedDiff,
  type ContextPolicy,
  type HighRiskConfig,
} from '@review-bot/context-engine';

const policy: ContextPolicy = {
  maxFiles: 40,
  maxChangedLines: 1200,
  maxFileBytes: 80000,
  ignoreLockfiles: true,
  ignoreGeneratedFiles: true,
  ignoreMinifiedFiles: true,
  ignoreBinaryFiles: true,
};

const highRisk: HighRiskConfig = {
  categories: {
    security: ['**/auth/**', '**/middleware/**'],
    secrets: ['**/.env*'],
  },
};

function diffFor(paths: string[]): string {
  return paths
    .map(
      (p) => `diff --git a/${p} b/${p}
--- a/${p}
+++ b/${p}
@@ -1,1 +1,2 @@
 line1
+added line in ${p}
`,
    )
    .join('');
}

/** Context tests — PRD v6.5 §30 CTX series. */
describe('context engine filters and budgeting', () => {
  it('CTX-001: .reviewignore excludes ignored paths', () => {
    const files = parseUnifiedDiff(diffFor(['docs/readme.md', 'src/app.ts']));
    const plan = buildContextPlan(files, {
      policy,
      highRisk,
      reviewIgnoreContent: 'docs/**\n',
    });
    expect(plan.included.map((d) => d.file.path)).toEqual(['src/app.ts']);
    expect(plan.skipped[0]?.skipReason).toBe('reviewignore');
  });

  it('CTX-002/003/004: lockfiles, generated, minified files skipped', () => {
    const files = parseUnifiedDiff(
      diffFor(['pnpm-lock.yaml', 'src/api.generated.ts', 'dist/app.min.js', 'src/real.ts']),
    );
    const plan = buildContextPlan(files, { policy, highRisk });
    expect(plan.included.map((d) => d.file.path)).toEqual(['src/real.ts']);
    const reasons = plan.skipped.map((d) => d.skipReason).sort();
    expect(reasons).toEqual(['generated_file', 'lockfile', 'minified_file']);
  });

  it('CTX-006: massive PR triggers budgeted review (max_files)', () => {
    const paths = Array.from({ length: 60 }, (_, i) => `src/file${String(i).padStart(2, '0')}.ts`);
    const plan = buildContextPlan(parseUnifiedDiff(diffFor(paths)), { policy, highRisk });
    expect(plan.included).toHaveLength(40);
    expect(plan.skipped.filter((d) => d.skipReason === 'max_files_budget')).toHaveLength(20);
  });

  it('CTX-007: high-risk paths are prioritized under budget pressure', () => {
    const paths = [
      ...Array.from({ length: 45 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`),
      'src/auth/session.ts',
    ];
    const plan = buildContextPlan(parseUnifiedDiff(diffFor(paths)), { policy, highRisk });
    expect(plan.included.some((d) => d.file.path === 'src/auth/session.ts')).toBe(true);
    expect(plan.included[0]?.highRisk).toBe(true);
  });

  it('FR-CTX-023: oversized high-risk file is blocked for chunking, never silently skipped', () => {
    const files = parseUnifiedDiff(diffFor(['src/auth/big.ts', 'src/big-plain.ts']));
    const plan = buildContextPlan(files, {
      policy,
      highRisk,
      fileSizes: new Map([
        ['src/auth/big.ts', 200_000],
        ['src/big-plain.ts', 200_000],
      ]),
    });
    expect(plan.blockedHighRisk.map((d) => d.file.path)).toEqual(['src/auth/big.ts']);
    expect(plan.skipped.find((d) => d.file.path === 'src/big-plain.ts')?.skipReason).toBe(
      'oversized_low_risk',
    );
  });

  it('CTX-005: binary files skipped', () => {
    const diff = `diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
--- a/logo.png
+++ b/logo.png
`;
    const files = parseUnifiedDiff(diff + diffFor(['src/ok.ts']));
    const plan = buildContextPlan(files, { policy, highRisk });
    expect(plan.included.map((d) => d.file.path)).toEqual(['src/ok.ts']);
  });
});
