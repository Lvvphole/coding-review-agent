import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { WebhookDeliveryStore } from '../../apps/ci-review-bot/src/handlers/webhook-delivery-store.js';
import {
  WebhookHandler,
  type TenantResolver,
} from '../../apps/ci-review-bot/src/handlers/webhook.handler.js';
import { createRedis, setupDb, truncateAll } from './helpers.js';

/** Webhook idempotency tests — PRD v6.5 §30 GH-IDEMP series + HARD-RULE-034. */

const SECRET = 'tenant-webhook-secret';
const BOT_LOGIN = 'agentic-ai-review-bot';

const resolver: TenantResolver = {
  async resolveTenant(repo) {
    return repo === 'org/proj' ? { tenantId: 't1', webhookSecret: SECRET } : null;
  },
};

function payload(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: 'opened',
      repository: { full_name: 'org/proj' },
      sender: { login: 'human-dev', type: 'User' },
      pull_request: {
        number: 7,
        draft: false,
        merged: false,
        user: { login: 'human-dev', type: 'User' },
        head: { sha: 'aaa111', repo: { full_name: 'org/proj' } },
        base: { sha: 'bbb222', repo: { full_name: 'org/proj' } },
      },
      ...overrides,
    }),
  );
}

function sign(body: Buffer): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('webhook edge idempotency', () => {
  let pool: pg.Pool;
  let redis: Redis;
  let handler: WebhookHandler;

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
    handler = new WebhookHandler(resolver, new WebhookDeliveryStore(pool), redis, {
      idempotencyTtlHours: 24,
      skipDraftPrs: true,
      reviewBotAuthoredPrs: false,
      botLogin: BOT_LOGIN,
    });
  });

  const send = (deliveryId: string, body: Buffer, signature?: string) =>
    handler.handle({
      deliveryId,
      eventType: 'pull_request',
      signature: signature ?? sign(body),
      rawBody: body,
    });

  it('accepts a first valid delivery', async () => {
    const outcome = await send('d-1', payload());
    expect(outcome.kind).toBe('accepted');
  });

  it('GH-IDEMP-001: duplicate delivery_id is ignored after first accepted webhook', async () => {
    const body = payload();
    expect((await send('d-1', body)).kind).toBe('accepted');
    const dup = await send('d-1', body);
    expect(dup).toEqual({ kind: 'noop_accepted', reason: 'duplicate_delivery' });
  });

  it('GH-IDEMP-004: same delivery_id with different payload hash fails closed (FORBIDDEN-031)', async () => {
    expect((await send('d-1', payload())).kind).toBe('accepted');
    const different = payload({ action: 'synchronize' });
    const outcome = await send('d-1', different);
    expect(outcome.kind).toBe('rejected');
  });

  it('HARD-RULE-034: duplicate protection survives Redis loss via Postgres authority', async () => {
    const body = payload();
    expect((await send('d-1', body)).kind).toBe('accepted');
    await redis.flushdb(); // simulate Redis restart/eviction
    const dup = await send('d-1', body);
    expect(dup).toEqual({ kind: 'noop_accepted', reason: 'duplicate_delivery' });
  });

  it('FR-GH-011: invalid signature fails closed before any state mutation', async () => {
    const body = payload();
    const outcome = await send('d-1', body, 'sha256=' + '0'.repeat(64));
    expect(outcome).toMatchObject({ kind: 'rejected', status: 401 });
    const rows = await pool.query('SELECT count(*)::int AS n FROM github_webhook_deliveries');
    expect(rows.rows[0].n).toBe(0);
    expect(await redis.keys('*')).toHaveLength(0); // FORBIDDEN-025
  });

  it('unknown repo-to-tenant mapping fails closed (TENANT-006)', async () => {
    const body = payload({ repository: { full_name: 'other/repo' } });
    const outcome = await handler.handle({
      deliveryId: 'd-1',
      eventType: 'pull_request',
      signature: sign(body),
      rawBody: body,
    });
    expect(outcome).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('HARD-RULE-036/037: bot-authored events and PRs are ignored before coordination', async () => {
    const botEvent = payload({ sender: { login: `${BOT_LOGIN}[bot]`, type: 'Bot' } });
    expect(await send('d-1', botEvent)).toEqual({
      kind: 'noop_accepted',
      reason: 'bot_event_ignored',
    });
    const botPr = payload({
      pull_request: {
        number: 8,
        draft: false,
        merged: false,
        user: { login: `${BOT_LOGIN}[bot]`, type: 'Bot' },
        head: { sha: 'ccc', repo: { full_name: 'org/proj' } },
        base: { sha: 'ddd', repo: { full_name: 'org/proj' } },
      },
    });
    expect(await send('d-2', botPr)).toEqual({
      kind: 'noop_accepted',
      reason: 'bot_event_ignored',
    });
  });

  it('HARD-RULE-041: draft PRs are skipped by default', async () => {
    const draft = payload({
      pull_request: {
        number: 9,
        draft: true,
        merged: false,
        user: { login: 'human-dev', type: 'User' },
        head: { sha: 'eee', repo: { full_name: 'org/proj' } },
        base: { sha: 'fff', repo: { full_name: 'org/proj' } },
      },
    });
    expect(await send('d-3', draft)).toEqual({
      kind: 'noop_accepted',
      reason: 'draft_pr_skipped',
    });
  });

  it('FR-GH-057: ready_for_review triggers review', async () => {
    const ready = payload({ action: 'ready_for_review' });
    const outcome = await send('d-4', ready);
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind === 'accepted') {
      expect(outcome.event.action).toBe('ready_for_review');
    }
  });

  it('fork PRs are flagged as elevated risk input (HARD-RULE-042)', async () => {
    const fork = payload({
      pull_request: {
        number: 10,
        draft: false,
        merged: false,
        user: { login: 'external-dev', type: 'User' },
        head: { sha: 'abc', repo: { full_name: 'forker/proj' } },
        base: { sha: 'def', repo: { full_name: 'org/proj' } },
      },
    });
    const outcome = await send('d-5', fork);
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind === 'accepted') expect(outcome.event.isFork).toBe(true);
  });
});
