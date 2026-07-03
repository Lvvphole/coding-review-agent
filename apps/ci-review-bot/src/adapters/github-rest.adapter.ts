import { setTimeout as sleep } from 'node:timers/promises';
import {
  GitHubIntegrationSeveredError,
  GitHubRateLimitError,
  GitHubReadError,
  type GitHubAdapter,
  type PostedComment,
  type ReviewSubmission,
} from './github.adapter.js';
import type { InstallationTokenProvider } from './github-app-auth.js';
import type { GitHubGraphQLAdapter } from './github-graphql.adapter.js';

/**
 * GitHub REST adapter — the production GitHubAdapter implementation.
 *
 * Error contract:
 * - Write path (submitReview): 403/429/secondary limit → GitHubRateLimitError
 *   so the posting workflow durably queues before backoff (HARD-RULE-015);
 *   401/permission loss → GitHubIntegrationSeveredError (never backoff,
 *   FORBIDDEN-037).
 * - Read path: bounded retries with backoff honoring retry-after
 *   (HARD-RULE-045, FR-GH-050..053); exhaustion → GitHubReadError.
 */

export interface GitHubRestAdapterOptions {
  apiBaseUrl: string;
  tokens: InstallationTokenProvider;
  botLogin: string;
  readMaxRetries: number;
  graphql?: GitHubGraphQLAdapter;
  fetchImpl?: typeof fetch;
  /** Test hook: sleep between read retries (defaults to real timers). */
  sleepImpl?: (ms: number) => Promise<void>;
}

const MARKER_PREFIX = '<!-- ai-review-bot:';

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n)) return n;
  }
  const reset = response.headers.get('x-ratelimit-reset');
  if (reset) {
    const delta = Number(reset) - Math.floor(Date.now() / 1000);
    if (Number.isFinite(delta) && delta > 0) return delta;
  }
  return null;
}

function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  // Primary/secondary limits surface as 403 with remaining=0 or retry-after.
  if (response.status === 403) {
    return (
      response.headers.get('x-ratelimit-remaining') === '0' ||
      response.headers.get('retry-after') !== null
    );
  }
  return false;
}

export class GitHubRestAdapter implements GitHubAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(private readonly opts: GitHubRestAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? ((ms) => sleep(ms));
  }

  private async authedFetch(path: string, init: RequestInit & { accept?: string }): Promise<Response> {
    const token = await this.opts.tokens.getToken();
    const response = await this.fetchImpl(`${this.opts.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: init.accept ?? 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        ...(init.headers ?? {}),
      },
    });
    if (response.status === 401) {
      // Token may have expired mid-flight: refresh once, retry once
      // (routine expiry is retryable — FR-GH-033, FORBIDDEN-045).
      this.opts.tokens.invalidate();
      const freshToken = await this.opts.tokens.getToken(); // severance throws here
      return this.fetchImpl(`${this.opts.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${freshToken}`,
          accept: init.accept ?? 'application/vnd.github+json',
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
          ...(init.headers ?? {}),
        },
      });
    }
    return response;
  }

  /** Read path with bounded retries (HARD-RULE-045). */
  private async read(path: string, accept?: string): Promise<Response> {
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt <= this.opts.readMaxRetries; attempt++) {
      const init: RequestInit & { accept?: string } = { method: 'GET' };
      if (accept !== undefined) init.accept = accept;
      const response = await this.authedFetch(path, init);
      if (response.ok) return response;
      lastStatus = response.status;
      if (isRateLimited(response) || response.status >= 500) {
        const wait = (retryAfterSeconds(response) ?? 2 ** attempt) * 1000;
        await this.sleepImpl(Math.min(wait, 30_000));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new GitHubIntegrationSeveredError(`read ${path} returned ${response.status}`);
      }
      break; // non-retryable (404 etc.)
    }
    throw new GitHubReadError(`read ${path} failed after retries`, lastStatus);
  }

  async submitReview(submission: ReviewSubmission): Promise<PostedComment> {
    const response = await this.authedFetch(
      `/repos/${submission.repo}/pulls/${submission.pullRequestId}/reviews`,
      {
        method: 'POST',
        body: JSON.stringify({
          commit_id: submission.commitSha,
          body: submission.body,
          event: 'COMMENT',
          comments: submission.comments.map((c) => ({
            path: c.path,
            line: c.line,
            side: 'RIGHT',
            body: c.body,
          })),
        }),
      },
    );
    if (isRateLimited(response)) {
      throw new GitHubRateLimitError(retryAfterSeconds(response));
    }
    if (response.status === 401 || response.status === 403) {
      throw new GitHubIntegrationSeveredError(`review POST returned ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`review POST failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { id: number; node_id: string; body: string };
    return { commentId: String(body.id), body: body.body ?? submission.body, nodeId: body.node_id };
  }

  async listBotComments(repo: string, pullRequestId: number): Promise<PostedComment[]> {
    const [reviewComments, issueComments, reviews] = await Promise.all([
      this.read(`/repos/${repo}/pulls/${pullRequestId}/comments?per_page=100`),
      this.read(`/repos/${repo}/issues/${pullRequestId}/comments?per_page=100`),
      this.read(`/repos/${repo}/pulls/${pullRequestId}/reviews?per_page=100`),
    ]);
    const all = [
      ...((await reviewComments.json()) as { id: number; node_id: string; body: string }[]),
      ...((await issueComments.json()) as { id: number; node_id: string; body: string }[]),
      ...((await reviews.json()) as { id: number; node_id: string; body: string }[]),
    ];
    return all
      .filter((c) => typeof c.body === 'string' && c.body.includes(MARKER_PREFIX))
      .map((c) => ({ commentId: String(c.id), body: c.body, nodeId: c.node_id }));
  }

  async getCurrentHeadSha(repo: string, pullRequestId: number): Promise<string> {
    const response = await this.read(`/repos/${repo}/pulls/${pullRequestId}`);
    const body = (await response.json()) as { head?: { sha?: string } };
    return body.head?.sha ?? '';
  }

  async getDiff(repo: string, pullRequestId: number): Promise<string> {
    const response = await this.read(
      `/repos/${repo}/pulls/${pullRequestId}`,
      'application/vnd.github.diff',
    );
    return response.text();
  }

  async getReplyCount(repo: string, pullRequestId: number, commentId: string): Promise<number | null> {
    try {
      const response = await this.read(`/repos/${repo}/pulls/${pullRequestId}/comments?per_page=100`);
      const comments = (await response.json()) as { in_reply_to_id?: number }[];
      return comments.filter((c) => String(c.in_reply_to_id ?? '') === commentId).length;
    } catch {
      return null; // cannot determine → preserve-not-delete (FR-POST-034)
    }
  }

  async minimizeComment(comment: PostedComment): Promise<boolean> {
    if (!this.opts.graphql || !comment.nodeId) return false;
    return this.opts.graphql.minimizeComment(comment.nodeId);
  }

  async appendOutdatedMarker(repo: string, commentId: string, currentBody: string): Promise<void> {
    if (currentBody.includes('[Outdated Code State]')) return;
    const response = await this.authedFetch(`/repos/${repo}/pulls/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: `${currentBody}\n\n> [Outdated Code State]` }),
    });
    if (!response.ok) {
      throw new GitHubReadError(`comment PATCH failed: ${response.status}`, response.status);
    }
  }
}
