/**
 * Local quota leases — PRD v6.5 §20.3 (FR-QUOTA-001..010).
 *
 * Consumption is local in the hot path (FR-QUOTA-003); an expired or
 * exhausted lease blocks provider dispatch (FR-QUOTA-009, FORBIDDEN-010,
 * G10). Renewal happens proactively at the configured remaining threshold;
 * async reconciliation belongs to the Control Plane.
 */

export interface QuotaLeaseConfig {
  rpmLimit: number;
  tpmLimit: number;
  ttlSeconds: number;
  renewalThresholdPercentRemaining: number;
}

export type LeaseDecision =
  | { allowed: true; shouldRenew: boolean }
  | { allowed: false; reason: 'lease_expired' | 'rpm_exhausted' | 'tpm_exhausted' };

export class LocalQuotaLease {
  private rpmUsed = 0;
  private tpmUsed = 0;
  private expiresAtMs: number;

  constructor(
    private readonly config: QuotaLeaseConfig,
    now = Date.now(),
  ) {
    this.expiresAtMs = now + config.ttlSeconds * 1000;
  }

  /** Attempts to consume one request + estimated tokens from the lease. */
  consume(estimatedTokens: number, now = Date.now()): LeaseDecision {
    if (now >= this.expiresAtMs) return { allowed: false, reason: 'lease_expired' };
    if (this.rpmUsed + 1 > this.config.rpmLimit) return { allowed: false, reason: 'rpm_exhausted' };
    if (this.tpmUsed + estimatedTokens > this.config.tpmLimit) {
      return { allowed: false, reason: 'tpm_exhausted' };
    }
    this.rpmUsed += 1;
    this.tpmUsed += estimatedTokens;
    const remaining = Math.min(
      (this.config.rpmLimit - this.rpmUsed) / this.config.rpmLimit,
      (this.config.tpmLimit - this.tpmUsed) / this.config.tpmLimit,
    );
    return {
      allowed: true,
      shouldRenew: remaining * 100 <= this.config.renewalThresholdPercentRemaining,
    };
  }

  /** Releases unused reservation after cancellation (FR-CAN-008). */
  release(estimatedTokens: number, actualTokens: number): void {
    this.tpmUsed = Math.max(0, this.tpmUsed - Math.max(0, estimatedTokens - actualTokens));
  }

  /** Lease renewal (FR-QUOTA-004): fresh window and counters. */
  renew(now = Date.now()): void {
    this.rpmUsed = 0;
    this.tpmUsed = 0;
    this.expiresAtMs = now + this.config.ttlSeconds * 1000;
  }

  /** Test hook: force expiry. */
  expireNow(): void {
    this.expiresAtMs = 0;
  }
}

/** Per provider:model lease registry for a gateway node. */
export class QuotaLeaseRegistry {
  private leases = new Map<string, LocalQuotaLease>();

  constructor(private readonly config: QuotaLeaseConfig) {}

  leaseFor(provider: string, model: string): LocalQuotaLease {
    const key = `${provider}:${model}`;
    let lease = this.leases.get(key);
    if (!lease) {
      lease = new LocalQuotaLease(this.config);
      this.leases.set(key, lease);
    }
    return lease;
  }
}
