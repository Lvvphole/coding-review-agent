import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpGatewayClient, signGatewayMetadata, type GatewayRequest } from '@review-bot/llm-client';
import { Gateway } from '../../apps/llm-gateway/src/gateway.js';
import { createGatewayHttpServer } from '../../apps/llm-gateway/src/gateway-http.js';
import {
  generatePolicySigningKeys,
  signPolicyBundle,
  type PolicyBundle,
} from '../../apps/llm-gateway/src/policy/policy-bundle.js';
import {
  StubCompletionProvider,
  StubEmbeddingProvider,
} from '../../apps/llm-gateway/src/providers/stub.provider.js';

/**
 * Gateway end-to-end over HTTP with the CI Bot's real HttpGatewayClient —
 * PRD v6.5 §30 G-series + SEC-001 + FR-GW-018..020.
 */

const APP_SECRET = 'app-metadata-secret';
const keys = generatePolicySigningKeys();

function bundle(overrides: Partial<PolicyBundle> = {}): PolicyBundle {
  return {
    version: 'e2e-1',
    route_key_layout_version: 1,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    routes: { default: { provider: 'local-stub', model: 'stub-1', model_tier: 'standard' } },
    embedding_model: {
      provider: 'local-stub-embeddings',
      model: 'stub-embed',
      version: 'stub-embed-v1',
      dimensions: 8,
    },
    app_allowlist: {
      'ci-review-bot': {
        task_types: ['code_review', 'security_review', 'embedding'],
        data_classes: ['internal'],
      },
    },
    ...overrides,
  };
}

function request(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    tenant_id: 't1',
    app_id: 'ci-review-bot',
    workflow_id: 'pr_review',
    request_id: 'req-1',
    run_id: 'run-1',
    repo: 'org/proj',
    pull_request_id: 7,
    head_sha: 'sha-a',
    run_epoch: 1,
    task_type: 'code_review',
    risk_level: 'medium',
    data_class: 'internal',
    latency_class: 'batch',
    streaming_mode: 'disabled',
    expected_output: 'json_schema',
    cache_policy: 'provider_prefix_only',
    metadata_signature: 'filled-by-client',
    messages: [
      { role: 'system', content: 'stable prefix' },
      { role: 'user', content: 'review this diff' },
    ],
    ...overrides,
  };
}

describe('gateway e2e (HTTP, real HttpGatewayClient)', () => {
  let server: Server | null = null;
  let provider: StubCompletionProvider;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function startGateway(opts: { bundle?: PolicyBundle; rpmLimit?: number } = {}) {
    provider = new StubCompletionProvider();
    const gateway = new Gateway({
      apps: [
        { appId: 'ci-review-bot', metadataSecret: APP_SECRET, allowedTenants: new Set(['t1']) },
      ],
      signedBundle: signPolicyBundle(opts.bundle ?? bundle(), keys.privateKeyPem),
      policyPublicKeyPem: keys.publicKeyPem,
      providers: { 'local-stub': provider },
      embeddings: new StubEmbeddingProvider(),
      quota: {
        rpmLimit: opts.rpmLimit ?? 60,
        tpmLimit: 1_000_000,
        ttlSeconds: 60,
        renewalThresholdPercentRemaining: 30,
      },
    });
    server = createGatewayHttpServer(gateway);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server!.address() as AddressInfo).port;
    return {
      gateway,
      url: `http://127.0.0.1:${port}`,
      client: new HttpGatewayClient({ gatewayUrl: `http://127.0.0.1:${port}`, appSecret: APP_SECRET }),
    };
  }

  it('completes a signed request through the stub provider (FR-GW-001..017)', async () => {
    const { client } = await startGateway();
    provider.registerResponse('[{"finding":"x"}]');
    const response = await client.complete(request());
    expect(response.content).toBe('[{"finding":"x"}]');
    expect(response.model_tier).toBe('standard');
    expect(response.token_input).toBeGreaterThan(0);
  });

  it('G-003: unsigned/tampered metadata is rejected', async () => {
    const { url } = await startGateway();
    const raw = request({ metadata_signature: 'not-a-real-signature' });
    const response = await fetch(`${url}/v1/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(raw),
    });
    expect(response.status).toBe(401);
  });

  it('G-004: invalid app_id rejected', async () => {
    const { client } = await startGateway();
    await expect(client.complete(request({ app_id: 'rogue-app' as never }))).rejects.toThrow(/403/);
  });

  it('G-005: tenant_id not allowed for app identity rejected (TENANT-004)', async () => {
    const { client } = await startGateway();
    await expect(client.complete(request({ tenant_id: 'tenant-b' }))).rejects.toThrow(/403/);
  });

  it('task_type outside app allowlist rejected (FR-META-004)', async () => {
    const { client } = await startGateway();
    await expect(client.complete(request({ task_type: 'pr_summary' }))).rejects.toThrow(/403/);
  });

  it('G-006: expired policy bundle fails closed (FORBIDDEN-012)', async () => {
    const expired = bundle({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const { client } = await startGateway({ bundle: expired });
    await expect(client.complete(request())).rejects.toThrow(/503/);
    expect(provider.requests).toHaveLength(0); // never reached a provider
  });

  it('G-007: exhausted quota lease blocks provider dispatch (FORBIDDEN-010)', async () => {
    const { client } = await startGateway({ rpmLimit: 1 });
    provider.registerResponse('[]');
    await client.complete(request({ request_id: 'r1' }));
    await expect(client.complete(request({ request_id: 'r2' }))).rejects.toThrow(/429/);
    expect(provider.requests).toHaveLength(1);
  });

  it('SEC-001: secret in message content is redacted before the provider call', async () => {
    const { client } = await startGateway();
    provider.registerResponse('[]');
    await client.complete(
      request({
        messages: [
          { role: 'system', content: 'stable prefix' },
          { role: 'user', content: 'diff contains key AKIAIOSFODNN7EXAMPLE here' },
        ],
      }),
    );
    expect(provider.requests[0]!.user).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(provider.requests[0]!.user).toContain('[REDACTED:aws_access_key]');
  });

  it('FR-GW-018..020: embeddings endpoint enforces the same trust rules and pins the model version', async () => {
    const { url } = await startGateway();
    const embedRequest = {
      tenant_id: 't1',
      app_id: 'ci-review-bot',
      workflow_id: 'pr_review',
      request_id: 'req-emb',
      task_type: 'embedding',
      risk_level: 'low',
      data_class: 'internal',
      latency_class: 'batch',
      streaming_mode: 'disabled',
      inputs: ['finding text a', 'finding text b'],
    };
    const signed = {
      ...embedRequest,
      metadata_signature: signGatewayMetadata(APP_SECRET, embedRequest),
    };
    const response = await fetch(`${url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      vectors: number[][];
      model_version: string;
      dimensions: number;
    };
    expect(body.model_version).toBe('stub-embed-v1');
    expect(body.vectors).toHaveLength(2);
    expect(body.vectors[0]).toHaveLength(8);

    // Unsigned embedding request fails closed (FR-GW-019).
    const unsigned = { ...embedRequest, metadata_signature: 'bad' };
    const rejected = await fetch(`${url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(unsigned),
    });
    expect(rejected.status).toBe(401);
  });

  it('embedding model version mismatch fails closed (FR-GW-021/022)', async () => {
    const drifted = bundle({
      embedding_model: {
        provider: 'local-stub-embeddings',
        model: 'stub-embed',
        version: 'stub-embed-v2',
        dimensions: 8,
      },
    });
    const { url } = await startGateway({ bundle: drifted });
    const embedRequest = {
      tenant_id: 't1',
      app_id: 'ci-review-bot',
      workflow_id: 'pr_review',
      request_id: 'req-emb',
      task_type: 'embedding',
      risk_level: 'low',
      data_class: 'internal',
      latency_class: 'batch',
      streaming_mode: 'disabled',
      inputs: ['x'],
    };
    const signed = {
      ...embedRequest,
      metadata_signature: signGatewayMetadata(APP_SECRET, embedRequest),
    };
    const response = await fetch(`${url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    });
    expect(response.status).toBe(503);
  });
});
