import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import {
  HttpGatewayClient,
  StubGatewayClient,
  type GatewayClient,
} from '@review-bot/llm-client';
import {
  createDiffReviewerAgent,
  createSecurityReviewerAgent,
} from '@review-bot/agent-core';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { WebhookDeliveryStore } from './handlers/webhook-delivery-store.js';
import { WebhookHandler } from './handlers/webhook.handler.js';
import { InstallationHandler } from './handlers/installation.handler.js';
import { TenantStore } from './tenancy/tenant-store.js';
import { ModeStore } from './review-modes/mode-store.js';
import { PrRunCoordinator } from './concurrency/pr-run-coordinator.js';
import { DebounceManager } from './concurrency/debounce-manager.js';
import { PendingPostStore } from './outbox/pending-post-store.js';
import { GitHubAppAuth, InstallationStore, StaticTokenProvider } from './adapters/github-app-auth.js';
import { GitHubRestAdapter } from './adapters/github-rest.adapter.js';
import { GitHubGraphQLAdapter } from './adapters/github-graphql.adapter.js';
import { RunExecutor } from './workers/run-executor.js';
import { PostingWorker } from './workers/posting-worker.js';
import { loadHighRiskConfig, loadTaxonomy } from './config-files.js';

/**
 * ci-review-bot entrypoint — standing webhook-driven service (FR-EXEC-001).
 *
 * Sprint 2 wiring: webhook ingestion → durable idempotency → debounce →
 * RunExecutor (durable QUEUED runs, FR-EXEC-002/006) → GitHub REST/GraphQL
 * adapter with App-token refresh (HARD-RULE-040) → PostingWorker draining the
 * durable outbox. The LLM Gateway remains a stub until the Gateway sprint;
 * set DRY_RUN=true for shadow-mode onboarding (FR-SLO-008).
 */

async function main(): Promise<void> {
  const config = loadConfig();
  await migrate(config.databaseUrl);

  const pool = createPool({ connectionString: config.databaseUrl });
  const redis = new Redis(config.redisUrl);
  const deliveries = new WebhookDeliveryStore(pool);
  const coordinator = new PrRunCoordinator(pool);
  const pendingPosts = new PendingPostStore(pool);
  const installations = new InstallationStore(pool);
  const debounce = new DebounceManager(redis, {
    debounceSeconds: config.review.debounceSeconds,
    maxDebounceSeconds: config.review.maxDebounceSeconds,
  });

  const tokens = config.github.privateKeyPem
    ? new GitHubAppAuth({
        appId: config.github.appId,
        privateKeyPem: config.github.privateKeyPem,
        installationId: config.github.installationId,
        tenantId: process.env['TENANT_ID'] ?? 'tenant_default',
        org: config.github.org,
        apiBaseUrl: config.github.apiBaseUrl,
        store: installations,
        refreshBeforeExpirySeconds: config.github.refreshBeforeExpirySeconds,
        maxRefreshRetries: config.github.maxRefreshRetries,
      })
    : new StaticTokenProvider('unconfigured'); // dry-run/local only
  const graphql = new GitHubGraphQLAdapter({ apiBaseUrl: config.github.apiBaseUrl, tokens });
  const github = new GitHubRestAdapter({
    apiBaseUrl: config.github.apiBaseUrl,
    tokens,
    botLogin: config.botLogin,
    readMaxRetries: config.github.readMaxRetries,
    graphql,
  });

  // Gateway-only LLM access (HARD-RULE-003/004): the real Gateway when
  // GATEWAY_URL is configured, deterministic stub otherwise. No provider
  // keys exist in this process either way (HARD-RULE-005).
  const gatewayUrl = process.env['GATEWAY_URL'];
  const gateway: GatewayClient = gatewayUrl
    ? new HttpGatewayClient({
        gatewayUrl,
        appSecret: process.env['APP_METADATA_SECRET'] ?? 'dev-app-secret',
      })
    : new StubGatewayClient();

  // YAML-config-driven review policy (§9): high-risk paths + compiled taxonomy.
  const configRoot = process.env['CONFIG_ROOT'] ?? 'configs';
  const highRisk = loadHighRiskConfig(configRoot);
  const taxonomy = loadTaxonomy(configRoot);
  const tenantSecret = process.env['TENANT_HMAC_SECRET'] ?? 'dev-tenant-secret';
  const postingPolicy = {
    maxInlineComments: config.review.maxInlineComments,
    pendingPostExpireAfterHours: config.pendingPosts.expireAfterHours,
    tenantSecret,
    integrationStatus: 'ACTIVE',
  };

  const executor = new RunExecutor({
    pool,
    coordinator,
    debounce,
    pendingPosts,
    github,
    agents: [createDiffReviewerAgent(gateway), createSecurityReviewerAgent(gateway)],
    contextPolicy: {
      maxFiles: config.context.maxFiles,
      maxChangedLines: config.context.maxChangedLines,
      maxFileBytes: config.context.maxFileBytes,
      ignoreLockfiles: config.context.ignoreLockfilesByDefault,
      ignoreGeneratedFiles: config.context.ignoreGeneratedFiles,
      ignoreMinifiedFiles: config.context.ignoreMinifiedFiles,
      ignoreBinaryFiles: config.context.ignoreBinaryFiles,
    },
    highRisk,
    validationPolicy: {
      confidenceThreshold: config.review.confidenceThreshold,
      highSeverityConfidenceThreshold: config.review.highSeverityConfidenceThreshold,
      requireDeterministicEvidenceForHighSeverity:
        config.review.requireDeterministicEvidenceForHighSeverity,
      approvedRootCauseIds: taxonomy.approvedIds,
      taxonomy,
    },
    postingPolicy,
    dryRun: config.review.dryRun,
    // Per-repo review mode (Light/Standard/Strict) presets over the controls
    // above; the safety floor is identical across modes (§10, HARD-RULE-UX-002).
    modeResolver: new ModeStore(pool),
  });

  const postingWorker = new PostingWorker({
    pendingPosts,
    coordinator,
    github,
    postingPolicy,
    workerId: `${hostname()}:${process.pid}`,
    maxRetries: config.pendingPosts.maxRetries,
    lockTtlSeconds: config.pendingPosts.lockTtlSeconds,
  });
  await postingWorker.recoverOnStartup(); // FR-POST-039

  // Managed tenancy: an install provisions a tenant + repos; repo→tenant
  // resolution replaces the env stub and fails closed for uninstalled repos
  // (HARD-RULE-026, FR-TENANT-013). One App-level webhook secret verifies all
  // deliveries in managed mode.
  const tenants = new TenantStore(pool, config.github.webhookSecret);
  const installationHandler = new InstallationHandler(tenants);
  const handler = new WebhookHandler(
    tenants,
    deliveries,
    redis,
    {
      idempotencyTtlHours: config.webhookIdempotency.ttlHours,
      skipDraftPrs: config.review.skipDraftPrsByDefault,
      reviewBotAuthoredPrs: config.review.reviewBotAuthoredPrsByDefault,
      botLogin: config.botLogin,
    },
    { handler: installationHandler, appWebhookSecret: config.github.webhookSecret },
  );

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
    if (outcome.kind === 'lifecycle_accepted') {
      res.writeHead(202).end(JSON.stringify({ status: 'lifecycle_accepted', detail: outcome.detail }));
      return;
    }

    const event = outcome.event;
    if (event.action === 'closed') {
      await executor.handleClosedPr(event.tenantId, event.repo, event.pullRequestId);
      res.writeHead(202).end(JSON.stringify({ status: 'accepted', action: 'cancelled' }));
      return;
    }

    await debounce.recordEvent(event.tenantId, event.repo, event.pullRequestId, event.headSha);
    res.writeHead(202).end(JSON.stringify({ status: 'accepted' }));
  });

  // Scheduler loops: durable work survives restarts (FR-EXEC-006); ticks are
  // cheap no-ops when idle.
  const executorLoop = setInterval(() => {
    executor.tick().catch((err) => console.error('executor tick failed', err));
  }, 2_000);
  executorLoop.unref();
  const postingLoop = setInterval(() => {
    postingWorker.tick().catch((err) => console.error('posting tick failed', err));
  }, 5_000);
  postingLoop.unref();

  const port = Number(process.env['PORT'] ?? 8080);
  server.listen(port, () => console.log(`ci-review-bot listening on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
