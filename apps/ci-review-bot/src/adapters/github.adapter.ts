/**
 * GitHub adapter boundary — apps/ci-review-bot/src/adapters (PRD §8).
 *
 * The real implementation (REST + GraphQL per §15.6 reconciliation
 * requirements) lands in the GitHub-integration sprint; Sprint 1 defines the
 * contract the workflows depend on plus an in-memory fake used by tests and
 * the simulator. Batched review submission is the default posting strategy
 * (FR-POST-068).
 */

export interface InlineCommentDraft {
  path: string;
  line: number;
  body: string;
}

export interface ReviewSubmission {
  repo: string;
  pullRequestId: number;
  commitSha: string;
  body: string;
  comments: InlineCommentDraft[];
}

export interface PostedComment {
  commentId: string;
  body: string;
}

export class GitHubRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super('github rate limited');
    this.name = 'GitHubRateLimitError';
  }
}

export class GitHubIntegrationSeveredError extends Error {
  constructor(public readonly reason: string) {
    super(`github integration severed: ${reason}`);
    this.name = 'GitHubIntegrationSeveredError';
  }
}

export interface GitHubAdapter {
  /** Submits one PR review carrying all inline comments (FR-POST-068). */
  submitReview(submission: ReviewSubmission): Promise<PostedComment>;
  /**
   * Lists existing bot comments for marker scanning (FR-POST-055). Must obey
   * read-path rate limits (FR-POST-060, HARD-RULE-045).
   */
  listBotComments(repo: string, pullRequestId: number): Promise<PostedComment[]>;
  /** Reads current PR head SHA for post-flight reconciliation (FR-POST-022). */
  getCurrentHeadSha(repo: string, pullRequestId: number): Promise<string>;
}

/** Deterministic in-memory fake for tests and simulate-pr-review. */
export class FakeGitHubAdapter implements GitHubAdapter {
  public readonly reviews: ReviewSubmission[] = [];
  private comments = new Map<string, PostedComment[]>();
  private headShas = new Map<string, string>();
  private nextId = 1;
  /** Test hooks: queue of errors to throw on next submitReview calls. */
  public failNextSubmitWith: Error[] = [];
  /** Test hook: when true, submitReview succeeds but throws after recording (ambiguous POST). */
  public crashAfterSubmit = false;

  setHeadSha(repo: string, prId: number, sha: string): void {
    this.headShas.set(`${repo}#${prId}`, sha);
  }

  async submitReview(submission: ReviewSubmission): Promise<PostedComment> {
    const queued = this.failNextSubmitWith.shift();
    if (queued) throw queued;
    const key = `${submission.repo}#${submission.pullRequestId}`;
    const posted: PostedComment = { commentId: `c${this.nextId++}`, body: submission.body };
    this.reviews.push(submission);
    this.comments.set(key, [...(this.comments.get(key) ?? []), posted]);
    if (this.crashAfterSubmit) {
      this.crashAfterSubmit = false;
      throw new Error('connection reset after POST accepted (ambiguous)');
    }
    return posted;
  }

  async listBotComments(repo: string, pullRequestId: number): Promise<PostedComment[]> {
    return this.comments.get(`${repo}#${pullRequestId}`) ?? [];
  }

  async getCurrentHeadSha(repo: string, pullRequestId: number): Promise<string> {
    return this.headShas.get(`${repo}#${pullRequestId}`) ?? '';
  }
}
