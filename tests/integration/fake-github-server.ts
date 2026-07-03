import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Scriptable fake GitHub API server for integration tests: token exchange,
 * PR reads (JSON + diff), review submission, comment listing, GraphQL.
 */

export interface ScriptedFailure {
  status: number;
  headers?: Record<string, string>;
}

export class FakeGitHubServer {
  private server: Server | null = null;
  public baseUrl = '';

  /** State inspected by tests. */
  public tokenRequests = 0;
  public reviews: { id: number; node_id: string; body: string; commit_id: string; comments: unknown[] }[] = [];
  public failNextReviewWith: ScriptedFailure[] = [];
  public failNextTokenWith: ScriptedFailure[] = [];
  public tokenTtlSeconds = 3600;
  public headSha = 'sha-a';
  public diff = '';
  public checkRuns: Record<string, unknown>[] = [];
  private nextId = 100;

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';

      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(url)) {
        this.tokenRequests += 1;
        const failure = this.failNextTokenWith.shift();
        if (failure) return json(failure.status, { message: 'nope' }, failure.headers);
        return json(201, {
          token: `ghs_test_${this.tokenRequests}`,
          expires_at: new Date(Date.now() + this.tokenTtlSeconds * 1000).toISOString(),
        });
      }

      if (req.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(url)) {
        const failure = this.failNextReviewWith.shift();
        if (failure) return json(failure.status, { message: 'limited' }, failure.headers);
        const parsed = JSON.parse(body) as { body: string; commit_id: string; comments: unknown[] };
        const id = this.nextId++;
        const review = {
          id,
          node_id: `node_${id}`,
          body: parsed.body,
          commit_id: parsed.commit_id,
          comments: parsed.comments,
        };
        this.reviews.push(review);
        return json(201, review);
      }

      if (req.method === 'GET' && /\/pulls\/\d+\/reviews/.test(url)) {
        return json(200, this.reviews.map((r) => ({ id: r.id, node_id: r.node_id, body: r.body })));
      }
      if (req.method === 'GET' && /\/pulls\/\d+\/comments/.test(url)) {
        return json(200, []);
      }
      if (req.method === 'GET' && /\/issues\/\d+\/comments/.test(url)) {
        return json(200, []);
      }
      if (req.method === 'GET' && /\/pulls\/\d+$/.test(url)) {
        if (req.headers.accept === 'application/vnd.github.diff') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          return res.end(this.diff);
        }
        return json(200, { head: { sha: this.headSha } });
      }
      if (req.method === 'POST' && url === '/graphql') {
        return json(200, { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } });
      }
      if (req.method === 'POST' && /\/check-runs$/.test(url)) {
        this.checkRuns.push(JSON.parse(body) as Record<string, unknown>);
        return json(201, { id: this.nextId++ });
      }
      json(404, { message: `unhandled ${req.method} ${url}` });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server!.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
