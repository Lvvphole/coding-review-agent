import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAppJwt, StaticTokenProvider } from '../../apps/ci-review-bot/src/adapters/github-app-auth.js';
import { GitHubRestAdapter } from '../../apps/ci-review-bot/src/adapters/github-rest.adapter.js';
import {
  FakeGitHubAdapter,
  GitHubIntegrationSeveredError,
  GitHubRateLimitError,
  GitHubReadError,
} from '../../apps/ci-review-bot/src/adapters/github.adapter.js';
import { reconcileOrphanedComment } from '../../apps/ci-review-bot/src/workflows/post-comments.workflow.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe('GitHub App JWT (FR-GH-035)', () => {
  it('builds a valid RS256 JWT with iss/iat/exp', () => {
    const now = 1_700_000_000;
    const jwt = buildAppJwt('12345', privatePem, now);
    const [header, payload, signature] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toEqual({ iss: '12345', iat: now - 60, exp: now + 600 });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicPem, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

function fakeFetch(
  script: { status: number; headers?: Record<string, string>; body?: unknown }[],
): { impl: typeof fetch; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    const step = script.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers: { 'content-type': 'application/json', ...(step.headers ?? {}) },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function adapter(script: Parameters<typeof fakeFetch>[0]) {
  const { impl, calls } = fakeFetch(script);
  return {
    calls,
    rest: new GitHubRestAdapter({
      apiBaseUrl: 'https://fake.local',
      tokens: new StaticTokenProvider('t'),
      botLogin: 'bot',
      readMaxRetries: 3,
      fetchImpl: impl,
      sleepImpl: async () => {},
    }),
  };
}

const submission = {
  repo: 'org/proj',
  pullRequestId: 7,
  commitSha: 'sha-a',
  body: 'summary',
  comments: [],
};

describe('GitHubRestAdapter error mapping', () => {
  it('maps 429 review POST to GitHubRateLimitError with retry-after (FR-POST-011/013)', async () => {
    const { rest } = adapter([{ status: 429, headers: { 'retry-after': '42' } }]);
    await expect(rest.submitReview(submission)).rejects.toMatchObject({
      name: 'GitHubRateLimitError',
      retryAfterSeconds: 42,
    });
  });

  it('maps secondary-limit 403 with retry-after to rate limit, not severance', async () => {
    const { rest } = adapter([{ status: 403, headers: { 'retry-after': '9' } }]);
    await expect(rest.submitReview(submission)).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it('maps plain 403 to integration severance (FORBIDDEN-037)', async () => {
    const { rest } = adapter([{ status: 403 }]);
    await expect(rest.submitReview(submission)).rejects.toBeInstanceOf(
      GitHubIntegrationSeveredError,
    );
  });

  it('read path retries 5xx with bounded attempts (HARD-RULE-045)', async () => {
    const { rest, calls } = adapter([
      { status: 500 },
      { status: 502 },
      { status: 200, body: { head: { sha: 'sha-x' } } },
    ]);
    expect(await rest.getCurrentHeadSha('org/proj', 7)).toBe('sha-x');
    expect(calls).toHaveLength(3);
  });

  it('read path fails with GitHubReadError after retry exhaustion', async () => {
    const { rest } = adapter([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    await expect(rest.getCurrentHeadSha('org/proj', 7)).rejects.toBeInstanceOf(GitHubReadError);
  });

  it('getReplyCount returns null when the read fails (FR-POST-034)', async () => {
    const { rest } = adapter([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    expect(await rest.getReplyCount('org/proj', 7, 'c1')).toBeNull();
  });
});

describe('post-flight reconciliation (RACE-002/003/004)', () => {
  const run = {
    tenantId: 't1',
    repo: 'org/proj',
    pullRequestId: 7,
    headSha: 'old-sha',
    runId: 'run-1',
    runEpoch: 1,
  };

  it('RACE-002: orphaned comment with zero replies is minimized', async () => {
    const github = new FakeGitHubAdapter();
    const comment = { commentId: 'c9', body: 'stale finding', nodeId: 'c9' };
    github.setReplyCount('c9', 0);
    const action = await reconcileOrphanedComment(run, comment, github);
    expect(action).toBe('deleted_or_minimized');
    expect(github.minimized).toEqual(['c9']);
  });

  it('RACE-003: comment with human replies is preserved and marked (HARD-RULE-019)', async () => {
    const github = new FakeGitHubAdapter();
    const comment = { commentId: 'c9', body: 'stale finding', nodeId: 'c9' };
    github.setReplyCount('c9', 2);
    const action = await reconcileOrphanedComment(run, comment, github);
    expect(action).toBe('preserved_marked');
    expect(github.minimized).toHaveLength(0);
    expect(github.editedBodies.get('c9')).toContain('[Outdated Code State]');
  });

  it('RACE-004: unknown reply count defaults to preserve-not-delete', async () => {
    const github = new FakeGitHubAdapter();
    const comment = { commentId: 'c9', body: 'stale finding', nodeId: 'c9' };
    github.setReplyCount('c9', null);
    const action = await reconcileOrphanedComment(run, comment, github);
    expect(action).toBe('preserved_unknown');
    expect(github.minimized).toHaveLength(0);
    expect(github.editedBodies.size).toBe(0);
  });

  it('minimization unavailable → preserve, never delete (FR-POST-026)', async () => {
    const github = new FakeGitHubAdapter();
    github.minimizeSupported = false;
    github.setReplyCount('c9', 0);
    const action = await reconcileOrphanedComment(
      run,
      { commentId: 'c9', body: 'stale', nodeId: 'c9' },
      github,
    );
    expect(action).toBe('preserved_unknown');
  });
});
