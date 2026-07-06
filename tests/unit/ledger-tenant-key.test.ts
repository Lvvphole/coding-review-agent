import { describe, expect, it } from 'vitest';
import { makeTenantLedgerKeyProvider } from '../../apps/ci-review-bot/src/ledger/tenant-key.js';

/**
 * Tenant-scoped ledger key derivation (HARD-RULE-024/025, FR-CP-023/029). One
 * app master secret → distinct, deterministic, versioned per-tenant keys.
 */

describe('makeTenantLedgerKeyProvider', () => {
  const provider = makeTenantLedgerKeyProvider({ appSecret: 'master', keyId: 'ledger-1' });

  it('stamps the configured rotation key id (FR-CP-029)', () => {
    expect(provider('inst_1').keyId).toBe('ledger-1');
  });

  it('is deterministic per tenant (recomputable, never stored)', () => {
    expect(provider('inst_1').secret).toBe(provider('inst_1').secret);
  });

  it('derives a distinct secret per tenant', () => {
    expect(provider('inst_1').secret).not.toBe(provider('inst_2').secret);
  });

  it('a different master secret yields different tenant keys', () => {
    const other = makeTenantLedgerKeyProvider({ appSecret: 'rotated', keyId: 'ledger-1' });
    expect(other('inst_1').secret).not.toBe(provider('inst_1').secret);
  });

  it('produces a hex secret (not the raw master secret)', () => {
    const key = provider('inst_1');
    expect(key.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(key.secret).not.toContain('master');
  });
});
