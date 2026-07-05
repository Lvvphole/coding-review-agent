import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { WebhookDeliveryStore } from './webhook-delivery-store.js';
import { tenantIdForInstallation } from '../tenancy/tenant-store.js';
import type {
  InstallationHandler,
  InstallationEventPayload,
  InstallationOutcome,
} from './installation.handler.js';

/**
 * Webhook ingestion pipeline — PRD v6.5 §4.2 ordering:
 *   tenant resolution → signature verification (G1) → actor-loop prevention
 *   (FR-GH-043) → edge idempotency (FR-GH-016) → normalization → coordination.
 *
 * Fails closed on unverified payloads before any hot-path mutation
 * (FORBIDDEN-025, FR-TENANT-013).
 */

export interface TenantResolver {
  /** Trusted org/repo → tenant mapping (FR-TENANT-012). Null = unresolvable. */
  resolveTenant(repoFullName: string): Promise<{ tenantId: string; webhookSecret: string } | null>;
}

export interface NormalizedPrEvent {
  tenantId: string;
  deliveryId: string;
  eventType: string;
  action: string;
  repo: string;
  pullRequestId: number;
  headSha: string;
  baseSha: string;
  sender: string;
  senderIsBot: boolean;
  isDraft: boolean;
  isFork: boolean;
  merged: boolean;
}

export type WebhookOutcome =
  | { kind: 'accepted'; event: NormalizedPrEvent }
  | { kind: 'lifecycle_accepted'; detail: InstallationOutcome }
  | { kind: 'noop_accepted'; reason: 'duplicate_delivery' | 'bot_event_ignored' | 'draft_pr_skipped' | 'unsupported_event' }
  | { kind: 'rejected'; status: number; reason: string };

/**
 * Installation lifecycle dependencies. Managed mode verifies these events with
 * the App-level webhook secret (there is no per-repo tenant yet — the install
 * creates it) and delegates to the tenant provisioner.
 */
export interface WebhookLifecycleDeps {
  handler: InstallationHandler;
  appWebhookSecret: string;
}

export interface WebhookPolicy {
  idempotencyTtlHours: number;
  skipDraftPrs: boolean;
  reviewBotAuthoredPrs: boolean;
  /** GitHub App bot login, used for actor-loop prevention (HARD-RULE-036). */
  botLogin: string;
}

export function verifySignature(secret: string, payload: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

const SUPPORTED_ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'closed',
  'ready_for_review',
  'converted_to_draft',
]);

export class WebhookHandler {
  constructor(
    private readonly tenants: TenantResolver,
    private readonly deliveries: WebhookDeliveryStore,
    private readonly redis: Redis,
    private readonly policy: WebhookPolicy,
    private readonly lifecycle?: WebhookLifecycleDeps,
  ) {}

  async handle(input: {
    deliveryId: string | undefined;
    eventType: string | undefined;
    signature: string | undefined;
    rawBody: Buffer;
  }): Promise<WebhookOutcome> {
    if (!input.deliveryId || !input.eventType) {
      return { kind: 'rejected', status: 400, reason: 'missing delivery id or event type' };
    }
    if (input.eventType === 'installation' || input.eventType === 'installation_repositories') {
      return this.handleLifecycle({
        deliveryId: input.deliveryId,
        eventType: input.eventType,
        signature: input.signature,
        rawBody: input.rawBody,
      });
    }
    if (input.eventType !== 'pull_request') {
      return { kind: 'noop_accepted', reason: 'unsupported_event' };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      return { kind: 'rejected', status: 400, reason: 'invalid JSON payload' };
    }

    const repoFullName = (payload['repository'] as { full_name?: string } | undefined)?.full_name;
    if (!repoFullName) {
      return { kind: 'rejected', status: 400, reason: 'missing repository' };
    }

    // Tenant resolution before signature verification (FR-TENANT-012).
    const tenant = await this.tenants.resolveTenant(repoFullName);
    if (!tenant) {
      return { kind: 'rejected', status: 403, reason: 'unknown repo-to-tenant mapping (fail closed)' };
    }

    // G1: tenant-specific signature verification (FR-TENANT-011).
    if (!verifySignature(tenant.webhookSecret, input.rawBody, input.signature)) {
      return { kind: 'rejected', status: 401, reason: 'invalid webhook signature (fail closed)' };
    }

    const pr = payload['pull_request'] as Record<string, unknown> | undefined;
    const action = payload['action'] as string | undefined;
    if (!pr || !action) {
      return { kind: 'rejected', status: 400, reason: 'missing pull_request or action' };
    }
    if (!SUPPORTED_ACTIONS.has(action)) {
      return { kind: 'noop_accepted', reason: 'unsupported_event' };
    }

    const sender = payload['sender'] as { login?: string; type?: string } | undefined;
    const senderLogin = sender?.login ?? '';
    const senderIsBot = sender?.type === 'Bot';

    // Actor-loop prevention BEFORE run coordination (HARD-RULE-036, FR-GH-040/043).
    if (senderLogin === this.policy.botLogin || senderLogin === `${this.policy.botLogin}[bot]`) {
      return { kind: 'noop_accepted', reason: 'bot_event_ignored' };
    }

    const prUser = pr['user'] as { login?: string; type?: string } | undefined;
    const prAuthorIsSelf =
      prUser?.login === this.policy.botLogin || prUser?.login === `${this.policy.botLogin}[bot]`;
    if (prAuthorIsSelf && !this.policy.reviewBotAuthoredPrs) {
      // HARD-RULE-037: bot-authored PRs are not reviewed without opt-in.
      return { kind: 'noop_accepted', reason: 'bot_event_ignored' };
    }

    // Edge idempotency after signature verification, before coordination
    // (FR-GH-016). Redis SETNX fast lock; Postgres durable authority.
    const payloadHash = createHash('sha256').update(input.rawBody).digest('hex');
    const redisKey = `tenant:${tenant.tenantId}:webhook:delivery:${input.deliveryId}`;
    const setnx = await this.redis.set(
      redisKey,
      payloadHash,
      'EX',
      this.policy.idempotencyTtlHours * 3600,
      'NX',
    );
    if (setnx === null) {
      const knownHash = await this.redis.get(redisKey);
      if (knownHash !== null && knownHash !== payloadHash) {
        return { kind: 'rejected', status: 400, reason: 'delivery payload hash mismatch (fail closed)' };
      }
    }
    const decision = await this.deliveries.recordDelivery({
      tenantId: tenant.tenantId,
      deliveryId: input.deliveryId,
      payloadHash,
      eventType: input.eventType,
      repo: repoFullName,
      pullRequestId: typeof pr['number'] === 'number' ? (pr['number'] as number) : null,
      ttlHours: this.policy.idempotencyTtlHours,
    });
    if (decision.kind === 'hash_mismatch_blocked') {
      return { kind: 'rejected', status: 400, reason: 'delivery payload hash mismatch (fail closed)' };
    }
    if (decision.kind === 'duplicate_ignored') {
      // FR-GH-014/032: safe no-op; never touches run state.
      return { kind: 'noop_accepted', reason: 'duplicate_delivery' };
    }

    const head = pr['head'] as { sha?: string; repo?: { full_name?: string } } | undefined;
    const base = pr['base'] as { sha?: string; repo?: { full_name?: string } } | undefined;
    const isDraft = pr['draft'] === true;
    const isFork = head?.repo?.full_name !== undefined && head.repo.full_name !== base?.repo?.full_name;

    // Draft PRs skipped by default (HARD-RULE-041, FR-GH-056); ready_for_review
    // and closed still flow through.
    if (isDraft && this.policy.skipDraftPrs && action !== 'closed') {
      return { kind: 'noop_accepted', reason: 'draft_pr_skipped' };
    }

    const event: NormalizedPrEvent = {
      tenantId: tenant.tenantId,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      action,
      repo: repoFullName,
      pullRequestId: pr['number'] as number,
      headSha: head?.sha ?? '',
      baseSha: base?.sha ?? '',
      sender: senderLogin,
      senderIsBot,
      isDraft,
      isFork,
      merged: pr['merged'] === true,
    };
    if (!event.headSha) {
      return { kind: 'rejected', status: 400, reason: 'missing head sha' };
    }
    return { kind: 'accepted', event };
  }

  /**
   * installation / installation_repositories — verify with the App webhook
   * secret before any state mutation (FORBIDDEN-025), dedupe at the edge
   * (FR-GH-016), then provision/sever the tenant. tenant_id = inst_<id> so
   * redeliveries collapse deterministically.
   */
  private async handleLifecycle(input: {
    deliveryId: string;
    eventType: string;
    signature: string | undefined;
    rawBody: Buffer;
  }): Promise<WebhookOutcome> {
    if (!this.lifecycle) {
      return { kind: 'noop_accepted', reason: 'unsupported_event' };
    }
    if (!verifySignature(this.lifecycle.appWebhookSecret, input.rawBody, input.signature)) {
      return { kind: 'rejected', status: 401, reason: 'invalid webhook signature (fail closed)' };
    }

    let payload: InstallationEventPayload;
    try {
      payload = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      return { kind: 'rejected', status: 400, reason: 'invalid JSON payload' };
    }

    const installationId = payload.installation?.id;
    if (!installationId || !payload.action || !payload.installation?.account?.login) {
      return { kind: 'rejected', status: 400, reason: 'missing installation, account, or action' };
    }
    const tenantId = tenantIdForInstallation(installationId);

    // Edge idempotency: installation redeliveries are safe (FR-GH-016). Redis
    // SETNX fast lock, Postgres durable authority.
    const payloadHash = createHash('sha256').update(input.rawBody).digest('hex');
    const redisKey = `tenant:${tenantId}:webhook:delivery:${input.deliveryId}`;
    const setnx = await this.redis.set(
      redisKey,
      payloadHash,
      'EX',
      this.policy.idempotencyTtlHours * 3600,
      'NX',
    );
    if (setnx === null) {
      const knownHash = await this.redis.get(redisKey);
      if (knownHash !== null && knownHash !== payloadHash) {
        return { kind: 'rejected', status: 400, reason: 'delivery payload hash mismatch (fail closed)' };
      }
    }
    const decision = await this.deliveries.recordDelivery({
      tenantId,
      deliveryId: input.deliveryId,
      payloadHash,
      eventType: input.eventType,
      repo: `installation:${installationId}`,
      pullRequestId: null,
      ttlHours: this.policy.idempotencyTtlHours,
    });
    if (decision.kind === 'hash_mismatch_blocked') {
      return { kind: 'rejected', status: 400, reason: 'delivery payload hash mismatch (fail closed)' };
    }
    if (decision.kind === 'duplicate_ignored') {
      return { kind: 'noop_accepted', reason: 'duplicate_delivery' };
    }

    const detail = await this.lifecycle.handler.handle(input.eventType, payload);
    return { kind: 'lifecycle_accepted', detail };
  }
}
