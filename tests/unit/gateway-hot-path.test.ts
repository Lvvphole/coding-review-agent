import { describe, expect, it } from 'vitest';
import {
  generatePolicySigningKeys,
  signPolicyBundle,
  verifyPolicyBundle,
  type PolicyBundle,
} from '../../apps/llm-gateway/src/policy/policy-bundle.js';
import {
  encodeRouteKey,
  UnknownRouteFieldError,
} from '../../apps/llm-gateway/src/hot-path/route-key.js';
import { LocalQuotaLease } from '../../apps/llm-gateway/src/hot-path/quota-lease.js';
import { signGatewayMetadata, verifyGatewayMetadata } from '@review-bot/llm-client';

/** Gateway hot-path unit tests — PRD v6.5 §30 G-series. */

function bundle(overrides: Partial<PolicyBundle> = {}): PolicyBundle {
  return {
    version: 'test-1',
    route_key_layout_version: 1,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    routes: { default: { provider: 'local-stub', model: 'stub-1', model_tier: 'standard' } },
    embedding_model: { provider: 'local-stub-embeddings', model: 'stub-embed', version: 'stub-embed-v1', dimensions: 8 },
    app_allowlist: { 'ci-review-bot': { task_types: ['code_review'], data_classes: ['internal'] } },
    ...overrides,
  };
}

describe('signed policy bundle (FR-ROUTE-003..005)', () => {
  const keys = generatePolicySigningKeys();

  it('verifies a validly signed, unexpired bundle', () => {
    const signed = signPolicyBundle(bundle(), keys.privateKeyPem);
    expect(verifyPolicyBundle(signed, keys.publicKeyPem)).toMatchObject({ ok: true });
  });

  it('rejects a tampered bundle (FR-CP-011 analogue)', () => {
    const signed = signPolicyBundle(bundle(), keys.privateKeyPem);
    signed.bundle.routes['default']!.model = 'attacker-model';
    expect(verifyPolicyBundle(signed, keys.publicKeyPem)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects a bundle signed with the wrong key', () => {
    const otherKeys = generatePolicySigningKeys();
    const signed = signPolicyBundle(bundle(), otherKeys.privateKeyPem);
    expect(verifyPolicyBundle(signed, keys.publicKeyPem)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('G-006: rejects an expired bundle (FORBIDDEN-012)', () => {
    const expired = bundle({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const signed = signPolicyBundle(expired, keys.privateKeyPem);
    expect(verifyPolicyBundle(signed, keys.publicKeyPem)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('bit-masked route key (FR-ROUTE-001/002, G-008)', () => {
  const input = {
    task_type: 'code_review',
    risk_level: 'medium',
    data_class: 'internal',
    latency_class: 'batch',
    streaming_mode: 'disabled',
  };

  it('is deterministic for identical input', () => {
    expect(encodeRouteKey(input)).toBe(encodeRouteKey({ ...input }));
  });

  it('encodes fields into distinct bit ranges', () => {
    const base = encodeRouteKey(input); // risk medium = 1 << 4
    expect(encodeRouteKey({ ...input, risk_level: 'high' }) - base).toBe((2 - 1) << 4);
    expect(encodeRouteKey({ ...input, degraded_mode_state: 1 }) - base).toBe(1 << 18);
  });

  it('fails closed on unknown field values', () => {
    expect(() => encodeRouteKey({ ...input, task_type: 'made_up' })).toThrow(
      UnknownRouteFieldError,
    );
  });
});

describe('local quota leases (FR-QUOTA, G-007)', () => {
  const config = { rpmLimit: 2, tpmLimit: 100, ttlSeconds: 60, renewalThresholdPercentRemaining: 30 };

  it('consumes within limits and signals renewal near exhaustion', () => {
    const lease = new LocalQuotaLease(config);
    expect(lease.consume(40)).toEqual({ allowed: true, shouldRenew: false });
    const second = lease.consume(40);
    expect(second.allowed).toBe(true);
    expect(second).toMatchObject({ shouldRenew: true }); // 20% tokens remaining
  });

  it('blocks on rpm exhaustion', () => {
    const lease = new LocalQuotaLease(config);
    lease.consume(1);
    lease.consume(1);
    expect(lease.consume(1)).toEqual({ allowed: false, reason: 'rpm_exhausted' });
  });

  it('G-007/FORBIDDEN-010: expired lease blocks dispatch', () => {
    const lease = new LocalQuotaLease(config);
    lease.expireNow();
    expect(lease.consume(1)).toEqual({ allowed: false, reason: 'lease_expired' });
  });

  it('renewal restores capacity (FR-QUOTA-004)', () => {
    const lease = new LocalQuotaLease(config);
    lease.expireNow();
    lease.renew();
    expect(lease.consume(1).allowed).toBe(true);
  });
});

describe('metadata signing (FR-META-003)', () => {
  const metadata = {
    tenant_id: 't1',
    app_id: 'ci-review-bot',
    workflow_id: 'pr_review',
    request_id: 'r1',
    task_type: 'code_review',
    risk_level: 'medium',
    data_class: 'internal',
    latency_class: 'batch',
    streaming_mode: 'disabled',
  };

  it('round-trips with the shared secret', () => {
    const sig = signGatewayMetadata('secret', metadata);
    expect(verifyGatewayMetadata('secret', metadata, sig)).toBe(true);
  });

  it('rejects tampered metadata (risk lowering, FR-META-007)', () => {
    const sig = signGatewayMetadata('secret', { ...metadata, risk_level: 'high' });
    expect(verifyGatewayMetadata('secret', { ...metadata, risk_level: 'low' }, sig)).toBe(false);
  });

  it('rejects signatures from a different secret', () => {
    const sig = signGatewayMetadata('other-secret', metadata);
    expect(verifyGatewayMetadata('secret', metadata, sig)).toBe(false);
  });
});
