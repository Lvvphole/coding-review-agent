import { createHmac } from 'node:crypto';
import type { TenantLedgerKey } from './spend-ledger.js';

/**
 * Tenant-scoped ledger key provider — HARD-RULE-024/025, FR-CP-023/029.
 *
 * The spend ledger pseudonymizes every identifier with a tenant-scoped HMAC key
 * and encrypts the sole re-identification copy under a key derived from that
 * same secret. In the managed/self-hosted deploy those per-tenant secrets are
 * derived deterministically from ONE app-level master secret held in the
 * approved secret store, so no per-tenant secret is stored anywhere: a tenant's
 * key is recomputed on demand and never leaves the process.
 *
 * These are pseudonymization keys, NOT provider credentials — the bot still
 * holds no provider keys (HARD-RULE-005). `keyId` is the rotation handle
 * stamped onto every ledger row (FR-CP-029, LEDGER-005): bump it (and the
 * master secret) to rotate; old rows keep their old `keyId`.
 */

export interface LedgerKeyProviderOptions {
  /** App-level master secret from the secret store. */
  appSecret: string;
  /** Versioned key id stamped on every ledger row for rotation (FR-CP-029). */
  keyId: string;
}

export function makeTenantLedgerKeyProvider(
  opts: LedgerKeyProviderOptions,
): (tenantId: string) => TenantLedgerKey {
  return (tenantId: string): TenantLedgerKey => ({
    keyId: opts.keyId,
    // Distinct per-tenant secret: compromise of one tenant's derived key does
    // not reveal the master secret or any sibling tenant's key.
    secret: createHmac('sha256', opts.appSecret).update(`ledger-key\n${tenantId}`).digest('hex'),
  });
}
