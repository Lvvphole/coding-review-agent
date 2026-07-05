import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { WebhookDeliveryStore } from '../../apps/ci-review-bot/src/handlers/webhook-delivery-store.js';
import { WebhookHandler } from '../../apps/ci-review-bot/src/handlers/webhook.handler.js';
import { InstallationHandler } from '../../apps/ci-review-bot/src/handlers/installation.handler.js';
import { TenantStore } from '../../apps/ci-review-bot/src/tenancy/tenant-store.js';
import { createRedis, setupDb, truncateAll } from './helpers.js';

/**
 * Managed tenancy lifecycle — Sprint 6 (PRD v6.5 §7.3, §24.2).
 * install provisions tenant+repos; repo→tenant resolution replaces the env
 * stub and fails closed for uninstalled repos (HARD-RULE-026, FR-TENANT-013);
 * uninstall/suspend sever the integration (FR-GH-017..024).
 */

const APP_SECRET = 'app-webhook-secret';
const BOT_LOGIN = 'agentic-ai-review-bot';

function sign(body: Buffer): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

function installEvent(
  action: string,
  installationId: number,
  org: string,
  repos: { id: number; full_name: string }[],
): Buffer {
  return Buffer.from(
    JSON.stringify({
      action,
      installation: { id: installationId, account: { login: org, type: 'Organization' } },
      repositories: repos,
    }),
  );
}

function installReposEvent(
  action: string,
  installationId: number,
  org: string,
  changes: { added?: { id: number; full_name: string }[]; removed?: { id: number; full_name: string }[] },
): Buffer {
  return Buffer.from(
    JSON.stringify({
      action,
      installation: { id: installationId, account: { login: org, type: 'Organization' } },
      repositories_added: changes.added ?? [],
      repositories_removed: changes.removed ?? [],
    }),
  );
}

function prEvent(repo: string, number = 7, headSha = 'aaa111'): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: 'opened',
      repository: { full_name: repo },
      sender: { login: 'human-dev', type: 'User' },
      pull_request: {
        number,
        draft: false,
        merged: false,
        user: { login: 'human-dev', type: 'User' },
        head: { sha: headSha, repo: { full_name: repo } },
        base: { sha: 'bbb222', repo: { full_name: repo } },
      },
    }),
  );
}

describe('managed tenancy lifecycle', () => {
  let pool: pg.Pool;
  let redis: Redis;
  let handler: WebhookHandler;
  let tenants: TenantStore;

  beforeAll(async () => {
    pool = await setupDb();
    redis = createRedis();
  });
  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    await redis.flushdb();
    tenants = new TenantStore(pool, APP_SECRET);
    const installations = new InstallationHandler(tenants);
    handler = new WebhookHandler(
      tenants,
      new WebhookDeliveryStore(pool),
      redis,
      { idempotencyTtlHours: 24, skipDraftPrs: true, reviewBotAuthoredPrs: false, botLogin: BOT_LOGIN },
      { handler: installations, appWebhookSecret: APP_SECRET },
    );
  });

  let delivery = 0;
  const send = (eventType: string, body: Buffer, signature?: string) =>
    handler.handle({
      deliveryId: `d-${++delivery}`,
      eventType,
      signature: signature ?? sign(body),
      rawBody: body,
    });

  it('FR-GH-017: installation:created provisions tenant + repositories', async () => {
    const body = installEvent('created', 42, 'acme', [{ id: 1, full_name: 'acme/web' }]);
    const outcome = await send('installation', body);
    expect(outcome).toMatchObject({
      kind: 'lifecycle_accepted',
      detail: { kind: 'provisioned', tenantId: 'inst_42', reposAffected: 1 },
    });

    const t = await pool.query(`SELECT status FROM tenants WHERE tenant_id = 'inst_42'`);
    expect(t.rows[0].status).toBe('ACTIVE');
    const r = await pool.query(`SELECT active FROM repositories WHERE repo_full_name = 'acme/web'`);
    expect(r.rows[0].active).toBe(true);

    // repo→tenant resolution now succeeds for the PR hot path.
    expect(await tenants.resolveTenant('acme/web')).toEqual({
      tenantId: 'inst_42',
      webhookSecret: APP_SECRET,
    });
  });

  it('FR-TENANT-012: a PR webhook for an installed repo is accepted end-to-end', async () => {
    await send('installation', installEvent('created', 42, 'acme', [{ id: 1, full_name: 'acme/web' }]));
    const pr = prEvent('acme/web');
    const outcome = await send('pull_request', pr);
    expect(outcome.kind).toBe('accepted');
  });

  it('FR-TENANT-013: unknown repo fails closed at resolution (403)', async () => {
    const pr = prEvent('stranger/repo');
    const outcome = await send('pull_request', pr);
    expect(outcome).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('FR-GH-023: installation_repositories:added / removed toggles repo activation', async () => {
    await send('installation', installEvent('created', 42, 'acme', [{ id: 1, full_name: 'acme/web' }]));
    await send('installation_repositories', installReposEvent('added', 42, 'acme', {
      added: [{ id: 2, full_name: 'acme/api' }],
    }));
    expect(await tenants.resolveTenant('acme/api')).not.toBeNull();

    const removed = await send('installation_repositories', installReposEvent('removed', 42, 'acme', {
      removed: [{ id: 2, full_name: 'acme/api' }],
    }));
    expect(removed).toMatchObject({ kind: 'lifecycle_accepted', detail: { kind: 'repos_removed', reposAffected: 1 } });

    // Removed repo fails closed; the still-installed repo keeps working.
    expect(await tenants.resolveTenant('acme/api')).toBeNull();
    expect(await tenants.resolveTenant('acme/web')).not.toBeNull();
    const pr = await send('pull_request', prEvent('acme/api'));
    expect(pr).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('FR-GH-020: installation:suspend severs; PRs fail closed; install marked SUSPENDED', async () => {
    await send('installation', installEvent('created', 42, 'acme', [{ id: 1, full_name: 'acme/web' }]));
    await send('installation', installEvent('suspend', 42, 'acme', []));

    expect(await tenants.resolveTenant('acme/web')).toBeNull();
    const pr = await send('pull_request', prEvent('acme/web'));
    expect(pr).toMatchObject({ kind: 'rejected', status: 403 });

    const gi = await pool.query(
      `SELECT status FROM github_installations WHERE tenant_id = 'inst_42' AND installation_id = 42`,
    );
    expect(gi.rows[0].status).toBe('SUSPENDED');
  });

  it('installation:unsuspend reactivates the tenant and its repos', async () => {
    await send('installation', installEvent('created', 42, 'acme', [{ id: 1, full_name: 'acme/web' }]));
    await send('installation', installEvent('suspend', 42, 'acme', []));
    await send('installation', installEvent('unsuspend', 42, 'acme', []));

    expect(await tenants.resolveTenant('acme/web')).not.toBeNull();
    const gi = await pool.query(`SELECT status FROM github_installations WHERE tenant_id = 'inst_42'`);
    expect(gi.rows[0].status).toBe('ACTIVE');
  });

  it('FR-GH-019: installation:deleted severs and records INSTALLATION_NOT_FOUND', async () => {
    await send('installation', installEvent('created', 42, 'acme', [{ id: 1, full_name: 'acme/web' }]));
    const outcome = await send('installation', installEvent('deleted', 42, 'acme', []));
    expect(outcome).toMatchObject({ kind: 'lifecycle_accepted', detail: { kind: 'severed', status: 'DELETED' } });

    expect(await tenants.resolveTenant('acme/web')).toBeNull();
    const t = await pool.query(`SELECT status FROM tenants WHERE tenant_id = 'inst_42'`);
    expect(t.rows[0].status).toBe('DELETED');
    const gi = await pool.query(`SELECT status FROM github_installations WHERE tenant_id = 'inst_42'`);
    expect(gi.rows[0].status).toBe('INSTALLATION_NOT_FOUND');
  });

  it('HARD-RULE-026: cross-tenant isolation — repos resolve to their own installation', async () => {
    await send('installation', installEvent('created', 42, 'acme', [{ id: 1, full_name: 'acme/web' }]));
    await send('installation', installEvent('created', 99, 'globex', [{ id: 2, full_name: 'globex/app' }]));

    expect((await tenants.resolveTenant('acme/web'))?.tenantId).toBe('inst_42');
    expect((await tenants.resolveTenant('globex/app'))?.tenantId).toBe('inst_99');

    // Severing one tenant does not affect the other.
    await send('installation', installEvent('deleted', 42, 'acme', []));
    expect(await tenants.resolveTenant('acme/web')).toBeNull();
    expect((await tenants.resolveTenant('globex/app'))?.tenantId).toBe('inst_99');
  });

  it('FORBIDDEN-025: lifecycle event with an invalid signature fails closed before mutation', async () => {
    const body = installEvent('created', 42, 'acme', [{ id: 1, full_name: 'acme/web' }]);
    const outcome = await send('installation', body, 'sha256=' + '0'.repeat(64));
    expect(outcome).toMatchObject({ kind: 'rejected', status: 401 });
    const t = await pool.query(`SELECT count(*)::int AS n FROM tenants`);
    expect(t.rows[0].n).toBe(0);
  });

  it('FR-GH-016: install redelivery is idempotent (single tenant row, duplicate no-op)', async () => {
    const body = installEvent('created', 42, 'acme', [{ id: 1, full_name: 'acme/web' }]);
    const first = await handler.handle({ deliveryId: 'inst-d1', eventType: 'installation', signature: sign(body), rawBody: body });
    expect(first.kind).toBe('lifecycle_accepted');
    const dup = await handler.handle({ deliveryId: 'inst-d1', eventType: 'installation', signature: sign(body), rawBody: body });
    expect(dup).toEqual({ kind: 'noop_accepted', reason: 'duplicate_delivery' });

    const t = await pool.query(`SELECT count(*)::int AS n FROM tenants WHERE tenant_id = 'inst_42'`);
    expect(t.rows[0].n).toBe(1);
  });
});
