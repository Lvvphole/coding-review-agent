import { createServer, type Server } from 'node:http';
import type { Gateway } from './gateway.js';

/** HTTP surface for the Gateway hot path; used by server.ts and tests. */
export function createGatewayHttpServer(gateway: Gateway): Server {
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method !== 'POST' || (req.url !== '/v1/complete' && req.url !== '/v1/embeddings')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort()); // cancellation propagation (FR-GW-014)

    if (req.url === '/v1/complete') {
      const result = await gateway.complete(parsed as never, controller.signal);
      if (result.ok) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.response));
      } else {
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: result.reason }));
      }
      return;
    }

    const result = await gateway.embed(parsed as never, controller.signal);
    if (result.ok) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          vectors: result.vectors,
          model_version: result.model_version,
          dimensions: result.dimensions,
        }),
      );
    } else {
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: result.reason }));
    }
  });
}
