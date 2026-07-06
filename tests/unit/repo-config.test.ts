import { describe, expect, it } from 'vitest';
import type { RunIdentity } from '@review-bot/shared';
import {
  parseRepoConfig,
  RepoFileConfigResolver,
  REPO_CONFIG_PATH,
} from '../../apps/ci-review-bot/src/review-modes/repo-config.js';
import type { RepoFileReader } from '../../apps/ci-review-bot/src/prd/prd-store.js';

/**
 * `.github/review-bot.yml` opt-in layer (HARD-RULE-UX-003). Parsing is total and
 * safe: only a valid `review.mode` produces an override; everything else yields
 * no override (fall back to the stored mode). The resolver reads the file at the
 * PR head SHA.
 */

const RUN: RunIdentity = {
  tenantId: 'inst_1',
  repo: 'acme/web',
  pullRequestId: 7,
  headSha: 'sha-a',
  runId: 'run-1',
  runEpoch: 1,
};

describe('parseRepoConfig', () => {
  it('extracts a valid review.mode', () => {
    expect(parseRepoConfig('review:\n  mode: strict\n')).toEqual({ reviewMode: 'strict' });
    expect(parseRepoConfig('review:\n  mode: light\n')).toEqual({ reviewMode: 'light' });
  });

  it('no override for unknown mode, missing field, empty, or malformed YAML', () => {
    expect(parseRepoConfig('review:\n  mode: turbo\n')).toEqual({});
    expect(parseRepoConfig('review:\n  enabled: true\n')).toEqual({});
    expect(parseRepoConfig('')).toEqual({});
    expect(parseRepoConfig('not: a review file')).toEqual({});
    expect(parseRepoConfig(': : : not yaml : :')).toEqual({}); // parse error → {}
    expect(parseRepoConfig('- a\n- b')).toEqual({}); // top-level array
  });
});

describe('RepoFileConfigResolver', () => {
  const reader = (result: string | null | (() => never)): RepoFileReader => ({
    async read(repo, path, ref) {
      expect(repo).toBe('acme/web');
      expect(path).toBe(REPO_CONFIG_PATH);
      expect(ref).toBe('sha-a'); // fenced at the PR head SHA
      if (typeof result === 'function') return result();
      return result;
    },
  });

  it('resolves the config when the file exists at the head SHA', async () => {
    const r = new RepoFileConfigResolver(reader('review:\n  mode: strict\n'));
    expect(await r.resolve(RUN)).toEqual({ reviewMode: 'strict' });
  });

  it('null when the file is absent or blank', async () => {
    expect(await new RepoFileConfigResolver(reader(null)).resolve(RUN)).toBeNull();
    expect(await new RepoFileConfigResolver(reader('   \n')).resolve(RUN)).toBeNull();
  });

  it('a read failure on the optional control never throws (safe fallback)', async () => {
    const r = new RepoFileConfigResolver(reader(() => {
      throw new Error('severed');
    }));
    expect(await r.resolve(RUN)).toBeNull();
  });
});
