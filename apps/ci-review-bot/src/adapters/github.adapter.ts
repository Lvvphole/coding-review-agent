/**
 * GitHub adapter boundary — apps/ci-review-bot/src/adapters (PRD §8).
 *
 * Sprint 2: the contract now covers the full read/write/reconcile surface.
 * `GitHubRestAdapter` (+ GraphQL delegate) is the production implementation;
 * `FakeGitHubAdapter` remains the deterministic test double. Batched review
 * submission is the default posting strategy (FR-POST-068).
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
  /** GraphQL node id, required for minimization (FR-POST-025). */
  nodeId?: string;
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

/** Read-path failure after bounded retries (HARD-RULE-045, FR-GH-053). */
export class GitHubReadError extends Error {
  constructor(message: string, public readonly status: number | null) {
    super(message);
    this.name = 'GitHubReadError';
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
  /** Fetches the unified diff for the PR head (context read path). */
  getDiff(repo: string, pullRequestId: number): Promise<string>;
  /**
   * Reply count for a posted comment; null when it cannot be reliably
   * determined → callers default to preserve-not-delete (FR-POST-034).
   */
  getReplyCount(repo: string, pullRequestId: number, commentId: string): Promise<number | null>;
  /**
   * Minimizes an orphaned comment when supported (GraphQL); returns false
   * when minimization is unavailable (FR-POST-026).
   */
  minimizeComment(comment: PostedComment): Promise<boolean>;
  /** Appends the [Outdated Code State] marker, preserving the thread (FR-POST-033). */
  appendOutdatedMarker(repo: string, commentId: string, currentBody: string): Promise<void>;
}

/** Deterministic in-memory fake for tests and simulate-pr-review. */
export class FakeGitHubAdapter implements GitHubAdapter {
  public readonly reviews: ReviewSubmission[] = [];
  private comments = new Map<string, PostedComment[]>();
  private headShas = new Map<string, string>();
  private diffs = new Map<string, string>();
  private replyCounts = new Map<string, number | null>();
  public readonly minimized: string[] = [];
  public readonly editedBodies = new Map<string, string>();
  public minimizeSupported = true;
  private nextId = 1;
  /** Test hooks: queue of errors to throw on next submitReview calls. */
  public failNextSubmitWith: Error[] = [];
  /** Test hook: when true, submitReview succeeds but throws after recording (ambiguous POST). */
  public crashAfterSubmit = false;

  setHeadSha(repo: string, prId: number, sha: string): void {
    this.headShas.set(`${repo}#${prId}`, sha);
  }

  setDiff(repo: string, prId: number, diff: string): void {
    this.diffs.set(`${repo}#${prId}`, diff);
  }

  setReplyCount(commentId: string, count: number | null): void {
    this.replyCounts.set(commentId, count);
  }

  async submitReview(submission: ReviewSubmission): Promise<PostedComment> {
    const queued = this.failNextSubmitWith.shift();
    if (queued) throw queued;
    const key = `${submission.repo}#${submission.pullRequestId}`;
    const id = `c${this.nextId++}`;
    const posted: PostedComment = { commentId: id, body: submission.body, nodeId: id };
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

  async getDiff(repo: string, pullRequestId: number): Promise<string> {
    const diff = this.diffs.get(`${repo}#${pullRequestId}`);
    if (diff === undefined) throw new GitHubReadError('no diff configured', 404);
    return diff;
  }

  async getReplyCount(_repo: string, _prId: number, commentId: string): Promise<number | null> {
    return this.replyCounts.has(commentId) ? (this.replyCounts.get(commentId) as number | null) : 0;
  }

  async minimizeComment(comment: PostedComment): Promise<boolean> {
    if (!this.minimizeSupported) return false;
    this.minimized.push(comment.commentId);
    return true;
  }

  async appendOutdatedMarker(_repo: string, commentId: string, currentBody: string): Promise<void> {
    this.editedBodies.set(commentId, `${currentBody}\n\n> [Outdated Code State]`);
  }
}
