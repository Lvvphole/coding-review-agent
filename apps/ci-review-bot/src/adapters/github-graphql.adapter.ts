import type { InstallationTokenProvider } from './github-app-auth.js';

/**
 * GitHub GraphQL adapter — comment minimization is GraphQL-only
 * (`minimizeComment` mutation); used by post-flight reconciliation
 * (FR-POST-024/025).
 */
export class GitHubGraphQLAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      apiBaseUrl: string;
      tokens: InstallationTokenProvider;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.opts.tokens.getToken();
    const response = await this.fetchImpl(`${this.opts.apiBaseUrl}/graphql`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`graphql request failed: ${response.status}`);
    }
    const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new Error(`graphql errors: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    return body.data as T;
  }

  /** Returns true when the comment was minimized (classifier OUTDATED). */
  async minimizeComment(nodeId: string): Promise<boolean> {
    try {
      const data = await this.query<{
        minimizeComment?: { minimizedComment?: { isMinimized?: boolean } };
      }>(
        `mutation($id: ID!) {
           minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
             minimizedComment { isMinimized }
           }
         }`,
        { id: nodeId },
      );
      return data.minimizeComment?.minimizedComment?.isMinimized === true;
    } catch {
      return false; // minimization unavailable → caller preserves (FR-POST-026)
    }
  }
}
