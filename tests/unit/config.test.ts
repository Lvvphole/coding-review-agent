import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/ci-review-bot/src/config.js';

/**
 * Config precedence (config-precedence sprint): env override > the §10 default
 * file `configs/review/default.review-bot.yaml` > built-in fallback. The file
 * is the single source of truth for platform defaults; absent/malformed → the
 * built-in values (fail safe).
 */

const tmpDirs: string[] = [];
function fixtureRoot(yaml: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'cfg-'));
  tmpDirs.push(root);
  if (yaml !== null) {
    mkdirSync(join(root, 'review'), { recursive: true });
    writeFileSync(join(root, 'review/default.review-bot.yaml'), yaml);
  }
  return root;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('loadConfig precedence', () => {
  it('loads the committed §10 default file as the base layer', () => {
    // The real repo default file must agree with the §10 values.
    const cfg = loadConfig({}, 'configs');
    expect(cfg.review.confidenceThreshold).toBe(0.8);
    expect(cfg.review.highSeverityConfidenceThreshold).toBe(0.9);
    expect(cfg.review.maxInlineComments).toBe(10);
    expect(cfg.review.debounceSeconds).toBe(30);
    expect(cfg.review.skipDraftPrsByDefault).toBe(true);
    expect(cfg.context.maxFiles).toBe(40);
    expect(cfg.context.maxChangedLines).toBe(1200);
    expect(cfg.webhookIdempotency.ttlHours).toBe(24);
    expect(cfg.pendingPosts.lockTtlSeconds).toBe(120);
  });

  it('a file value overrides the built-in default', () => {
    const root = fixtureRoot('review:\n  confidence_threshold: 0.95\n  max_inline_comments: 3\ncontext:\n  max_files: 7\n');
    const cfg = loadConfig({}, root);
    expect(cfg.review.confidenceThreshold).toBe(0.95);
    expect(cfg.review.maxInlineComments).toBe(3);
    expect(cfg.context.maxFiles).toBe(7);
    // Unspecified fields still fall back to the built-in default.
    expect(cfg.review.highSeverityConfidenceThreshold).toBe(0.9);
  });

  it('an env override wins over the file', () => {
    const root = fixtureRoot('review:\n  debounce_seconds: 45\n');
    expect(loadConfig({}, root).review.debounceSeconds).toBe(45); // file
    expect(loadConfig({ DEBOUNCE_SECONDS: '99' }, root).review.debounceSeconds).toBe(99); // env wins
  });

  it('a boolean false in the file is honored (not masked by the default)', () => {
    const root = fixtureRoot('review:\n  skip_draft_prs_by_default: false\n');
    expect(loadConfig({}, root).review.skipDraftPrsByDefault).toBe(false);
  });

  it('a missing file falls back to the built-in §10 defaults', () => {
    const cfg = loadConfig({}, fixtureRoot(null));
    expect(cfg.review.confidenceThreshold).toBe(0.8);
    expect(cfg.review.maxInlineComments).toBe(10);
    expect(cfg.context.maxFileBytes).toBe(80000);
  });

  it('a malformed file fails safe to the built-in defaults (never throws)', () => {
    const root = fixtureRoot(': : not : valid : yaml\n\t- broken');
    const cfg = loadConfig({}, root);
    expect(cfg.review.confidenceThreshold).toBe(0.8);
    expect(cfg.pendingPosts.maxRetries).toBe(3);
  });
});
