import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { WebhookDeliveryStore } from './handlers/webhook-delivery-store.js';
import { WebhookHandler, type TenantResolver } from './handlers/webhook.handler.js';
import { PrRunCoordinator } from './concurrency/pr-run-coordinator.js';
import { DebounceManager } from './concurrency/debounce-manager.js';

/**
 * ci-review-bot entrypoint — standing webhook-driven service (FR-EXEC-001).
 *
 * Sprint 1 wires: webhook ingestion → durable idempotency → run coordination
 * with durable fencing. The full review execution loop (queue consumer,
 * Gateway, posting worker) is exercised through tests and the
 * simulate-pr-review script until the Gateway sprint lands.
 */

/** Env-var tenant mapping stub; replaced by tenants table lookup. */
class EnvTenantResolver implements TenantResolver {
  async resolveTenant(repoFullName: string): Promise<{ tenantId: string; webhookSecret: string } | null> {
    const secret = process.env['GITHUB_WEBHOOK_SECRET'];
    const allowedRepos = (process.env['TENANT_REPOS'] ?? '').split(',').filter(Boolean);
    if (!secret) return null;
    if (allowedRepos.length > 0 && !allowedRepos.includes(repoFullName)) return null;
    return { tenantId: process.env['TENANT_ID'] ?? 'tenant_default', webhookSecret: secret };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  await migrate(config.databaseUrl);

  const pool = createPool({ connectionString: config.databaseUrl });
  const redis = new Redis(config.redisUrl);
  const deliveries = new WebhookDeliveryStore(pool);
  const coordinator = new PrRunCoordinator(pool);
  const debounce = new DebounceManager(redis, {
    debounceSeconds: config.review.debounceSeconds,
    maxDebounceSeconds: config.review.maxDebounceSeconds,
  });
  const handler = new WebhookHandler(new EnvTenantResolver(), deliveries, redis, {
    idempotencyTtlHours: config.webhookIdempotency.ttlHours,
    skipDraftPrs: config.review.skipDraftPrsByDefault,
    reviewBotAuthoredPrs: config.review.reviewBotAuthoredPrsByDefault,
    botLogin: config.botLogin,
  });

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/webhooks/github') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const outcome = await handler.handle({
      deliveryId: req.headers['x-github-delivery'] as string | undefined,
      eventType: req.headers['x-github-event'] as string | undefined,
      signature: req.headers['x-hub-signature-256'] as string | undefined,
      rawBody: Buffer.concat(chunks),
    });

    if (outcome.kind === 'rejected') {
      res.writeHead(outcome.status).end(JSON.stringify({ error: outcome.reason }));
      return;
    }
    if (outcome.kind === 'noop_accepted') {
      res.writeHead(202).end(JSON.stringify({ status: 'noop_accepted', reason: outcome.reason }));
      return;
    }

    const event = outcome.event;
    if (event.action === 'closed') {
      // FR-GH-009/045..047 cascade is handled by the run lifecycle worker; the
      // webhook path only acknowledges here in Sprint 1.
      res.writeHead(202).end(JSON.stringify({ status: 'accepted', action: 'cancel_run' }));
      return;
    }

    const deadline = await debounce.recordEvent(
      event.tenantId,
      event.repo,
      event.pullRequestId,
      event.headSha,
    );
    // Debounce settlement + run start: the scheduler loop polls settle() and
    // then calls coordinator.startRun; wired minimally here for the slice.
    setTimeout(async () => {
      const settledSha = await debounce.settle(event.tenantId, event.repo, event.pullRequestId);
      if (settledSha) {
        await coordinator.startRun({
          tenantId: event.tenantId,
          repo: event.repo,
          pullRequestId: event.pullRequestId,
          headSha: settledSha,
        });
      }
    }, Math.max(0, deadline - Date.now())).unref();

    res.writeHead(202).end(JSON.stringify({ status: 'accepted' }));
  });

  const port = Number(process.env['PORT'] ?? 8080);
  server.listen(port, () => console.log(`ci-review-bot listening on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
