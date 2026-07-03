import type { GatewayRequest, GatewayResponse } from '@review-bot/llm-client';
import { verifyGatewayMetadata } from '@review-bot/llm-client';
import { DEFAULT_SECRET_PATTERNS, redactOutboundComment } from '@review-bot/validators';
import {
  verifyPolicyBundle,
  type PolicyBundle,
  type SignedPolicyBundle,
} from './policy/policy-bundle.js';
import { encodeRouteKey, UnknownRouteFieldError } from './hot-path/route-key.js';
import { QuotaLeaseRegistry, type QuotaLeaseConfig } from './hot-path/quota-lease.js';
import {
  ProviderDispatchError,
  type CompletionProvider,
  type EmbeddingProvider,
} from './providers/provider.interface.js';

/**
 * Gateway hot path — PRD v6.5 §19 (FR-GW-001..023, FR-META-001..009).
 *
 * Order: app identity → tenant validation → signed metadata → redaction +
 * secret scan → quota lease → route key encode → compiled signed route
 * lookup → provider dispatch → async event → normalized response.
 * Every validation failure fails closed (FR-META-009). No dynamic model
 * scoring, no LLM classification in the hot path (FR-ROUTE-008,
 * out-of-scope §6.2 #13/#15).
 */

export interface GatewayAppRegistration {
  appId: string;
  /** HMAC secret used to verify metadata signatures (FR-META-003). */
  metadataSecret: string;
  /** Tenants this app identity may act for (FR-META-002, G23). */
  allowedTenants: Set<string>;
}

export interface GatewayEvent {
  event_type: string;
  occurred_at: string;
  tenant_id: string;
  request_id: string;
  fields: Record<string, unknown>;
}

export type GatewayResult =
  | { ok: true; response: GatewayResponse }
  | { ok: false; status: number; reason: string };

export interface GatewayOptions {
  apps: GatewayAppRegistration[];
  signedBundle: SignedPolicyBundle;
  policyPublicKeyPem: string;
  providers: Record<string, CompletionProvider>;
  embeddings: EmbeddingProvider;
  quota: QuotaLeaseConfig;
  maxTokens?: number;
  onEvent?: (event: GatewayEvent) => void;
}

export class Gateway {
  private readonly apps: Map<string, GatewayAppRegistration>;
  private readonly bundle: PolicyBundle | null;
  private readonly bundleRejection: string | null;
  private readonly leases: QuotaLeaseRegistry;
  private readonly events: GatewayEvent[] = [];

  constructor(private readonly opts: GatewayOptions) {
    this.apps = new Map(opts.apps.map((a) => [a.appId, a]));
    // Verify the signed bundle once at load (FR-ROUTE-005); an invalid or
    // expired bundle leaves the gateway in fail-closed degraded mode
    // (FR-ROUTE-007, FORBIDDEN-012).
    const verification = verifyPolicyBundle(opts.signedBundle, opts.policyPublicKeyPem);
    if (verification.ok) {
      this.bundle = verification.bundle;
      this.bundleRejection = null;
    } else {
      this.bundle = null;
      this.bundleRejection = verification.reason;
    }
    this.leases = new QuotaLeaseRegistry(opts.quota);
  }

  private emit(event: Omit<GatewayEvent, 'occurred_at'>): void {
    const full = { ...event, occurred_at: new Date().toISOString() };
    this.events.push(full);
    this.opts.onEvent?.(full);
  }

  get emittedEvents(): readonly GatewayEvent[] {
    return this.events;
  }

  /**
   * Validates identity, tenant, and signed metadata (FR-GW-002..005).
   * Returns null when valid, otherwise the fail-closed result.
   */
  private validateRequestEnvelope(request: {
    app_id: string;
    tenant_id: string;
    task_type: string;
    data_class: string;
    metadata_signature: string;
    workflow_id: string;
    request_id: string;
    risk_level: string;
    latency_class: string;
    streaming_mode: string;
  }): { ok: false; status: number; reason: string } | null {
    if (this.bundle === null) {
      return { ok: false, status: 503, reason: `policy bundle rejected: ${this.bundleRejection}` };
    }
    const app = this.apps.get(request.app_id);
    if (!app) return { ok: false, status: 403, reason: 'app_id not allowlisted (FR-META-001)' };
    if (!app.allowedTenants.has(request.tenant_id)) {
      return { ok: false, status: 403, reason: 'tenant_id not valid for app_id (FR-META-002)' };
    }
    if (!verifyGatewayMetadata(app.metadataSecret, request, request.metadata_signature)) {
      return { ok: false, status: 401, reason: 'invalid metadata signature (FR-META-003)' };
    }
    const appPolicy = this.bundle.app_allowlist[request.app_id];
    if (!appPolicy || !appPolicy.task_types.includes(request.task_type)) {
      return { ok: false, status: 403, reason: 'task_type not allowed for app_id (FR-META-004)' };
    }
    if (!appPolicy.data_classes.includes(request.data_class)) {
      return { ok: false, status: 403, reason: 'data_class not allowed for app_id (FR-META-005)' };
    }
    return null;
  }

  async complete(request: GatewayRequest, signal?: AbortSignal): Promise<GatewayResult> {
    const envelopeFailure = this.validateRequestEnvelope(request);
    if (envelopeFailure) {
      this.emit({
        event_type: 'gateway.request.failed',
        tenant_id: request.tenant_id,
        request_id: request.request_id,
        fields: { reason: envelopeFailure.reason },
      });
      return envelopeFailure;
    }
    const bundle = this.bundle!;

    // Edge redaction + secret scan BEFORE any provider dispatch or cache
    // write (FR-GW-006/007, FR-SEC-006/007/008).
    const redactedMessages = request.messages.map((m) => ({
      ...m,
      content: redactOutboundComment(m.content, DEFAULT_SECRET_PATTERNS).body,
    }));

    // Route key encode + O(1) signed-table lookup (FR-GW-011/012).
    let routeKey: number;
    try {
      routeKey = encodeRouteKey(request);
    } catch (err) {
      if (err instanceof UnknownRouteFieldError) {
        return { ok: false, status: 400, reason: err.message };
      }
      throw err;
    }
    const target = bundle.routes[String(routeKey)] ?? bundle.routes['default'];
    if (!target) {
      return { ok: false, status: 503, reason: 'no route and no safe default (FR-ROUTE-006)' };
    }

    const provider = this.opts.providers[target.provider];
    if (!provider) {
      return { ok: false, status: 503, reason: `provider ${target.provider} not configured` };
    }

    // Quota lease check (FR-GW-010): expired/exhausted blocks dispatch
    // (FORBIDDEN-010).
    const system = redactedMessages.find((m) => m.role === 'system')?.content ?? '';
    const user = redactedMessages.find((m) => m.role === 'user')?.content ?? '';
    const estimatedTokens = Math.ceil((system.length + user.length) / 4);
    const lease = this.leases.leaseFor(target.provider, target.model);
    const decision = lease.consume(estimatedTokens);
    if (!decision.allowed) {
      this.emit({
        event_type: 'quota.lease.updated',
        tenant_id: request.tenant_id,
        request_id: request.request_id,
        fields: { blocked: true, reason: decision.reason },
      });
      return { ok: false, status: 429, reason: `quota lease blocked: ${decision.reason}` };
    }
    if (decision.shouldRenew) {
      // Renewal is requested proactively (FR-QUOTA-004/005) but granted by the
      // Control Plane's budget authority, never self-served in the hot path —
      // otherwise an exhausted lease could mint itself fresh quota.
      this.emit({
        event_type: 'quota.lease.updated',
        tenant_id: request.tenant_id,
        request_id: request.request_id,
        fields: { renewal_requested: true, provider: target.provider, model: target.model },
      });
    }

    this.emit({
      event_type: 'gateway.request.started',
      tenant_id: request.tenant_id,
      request_id: request.request_id,
      fields: { provider: target.provider, model: target.model, route_key: routeKey },
    });

    try {
      const result = await provider.complete(
        { model: target.model, system, user, maxTokens: this.opts.maxTokens ?? 4096 },
        signal,
      );
      this.emit({
        event_type: 'gateway.request.completed',
        tenant_id: request.tenant_id,
        request_id: request.request_id,
        fields: { token_input: result.tokenInput, token_output: result.tokenOutput },
      });
      return {
        ok: true,
        response: {
          request_id: request.request_id,
          content: result.content,
          token_input: result.tokenInput,
          token_output: result.tokenOutput,
          model_tier: target.model_tier,
        },
      };
    } catch (err) {
      // Release unused reservation on cancellation/failure (FR-CAN-007/008).
      lease.release(estimatedTokens, 0);
      const cancelled = signal?.aborted === true;
      this.emit({
        event_type: cancelled ? 'gateway.request.cancelled' : 'gateway.request.failed',
        tenant_id: request.tenant_id,
        request_id: request.request_id,
        fields: { error: String(err) },
      });
      if (cancelled) return { ok: false, status: 499, reason: 'cancelled' };
      const retryable = err instanceof ProviderDispatchError && err.retryable;
      return { ok: false, status: retryable ? 503 : 502, reason: String(err) };
    }
  }

  /** Embeddings endpoint — same trust rules as completions (FR-GW-018/019). */
  async embed(
    request: {
      tenant_id: string;
      app_id: string;
      workflow_id: string;
      request_id: string;
      task_type: 'embedding';
      risk_level: string;
      data_class: string;
      latency_class: string;
      streaming_mode: 'disabled';
      metadata_signature: string;
      inputs: string[];
    },
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; vectors: number[][]; model_version: string; dimensions: number }
    | { ok: false; status: number; reason: string }
  > {
    const envelopeFailure = this.validateRequestEnvelope(request);
    if (envelopeFailure) return envelopeFailure;
    const bundle = this.bundle!;

    // Model version pinning (FR-GW-020/021): the configured provider must
    // match the bundle's pinned embedding model version.
    if (this.opts.embeddings.modelVersion !== bundle.embedding_model.version) {
      return {
        ok: false,
        status: 503,
        reason: `embedding model version mismatch: provider=${this.opts.embeddings.modelVersion} bundle=${bundle.embedding_model.version}`,
      };
    }

    const redacted = request.inputs.map(
      (text) => redactOutboundComment(text, DEFAULT_SECRET_PATTERNS).body,
    );
    const vectors = await this.opts.embeddings.embed(redacted, signal);
    this.emit({
      event_type: 'gateway.request.completed',
      tenant_id: request.tenant_id,
      request_id: request.request_id,
      fields: { embedding_count: vectors.length, model_version: this.opts.embeddings.modelVersion },
    });
    return {
      ok: true,
      vectors,
      model_version: this.opts.embeddings.modelVersion,
      dimensions: this.opts.embeddings.dimensions,
    };
  }
}
