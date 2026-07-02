import type { Pool } from 'pg';

/**
 * Durable webhook delivery idempotency — HARD-RULE-034, FR-GH-026..032.
 * Redis SETNX is the fast edge lock (FR-GH-012/027); this Postgres record is
 * the durable authority that survives Redis restart (FR-GH-028).
 */

export type DeliveryDecision =
  | { kind: 'accepted' }
  | { kind: 'duplicate_ignored' }
  | { kind: 'hash_mismatch_blocked' };

export class WebhookDeliveryStore {
  constructor(private readonly pool: Pool) {}

  async recordDelivery(input: {
    tenantId: string;
    deliveryId: string;
    payloadHash: string;
    eventType: string;
    repo: string;
    pullRequestId: number | null;
    ttlHours: number;
    traceId?: string;
  }): Promise<DeliveryDecision> {
    const inserted = await this.pool.query(
      `INSERT INTO github_webhook_deliveries
         (tenant_id, delivery_id, payload_hash, event_type, repo, pull_request_id,
          expires_at, first_seen_trace_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7), $8, 'ACCEPTED')
       ON CONFLICT (tenant_id, delivery_id) DO NOTHING
       RETURNING delivery_id`,
      [
        input.tenantId,
        input.deliveryId,
        input.payloadHash,
        input.eventType,
        input.repo,
        input.pullRequestId,
        input.ttlHours,
        input.traceId ?? null,
      ],
    );
    if ((inserted.rowCount ?? 0) > 0) return { kind: 'accepted' };

    // Duplicate delivery_id: compare payload hash (G30, FR-GH-029/030).
    const existing = await this.pool.query(
      `UPDATE github_webhook_deliveries
          SET duplicate_count = duplicate_count + 1
        WHERE tenant_id = $1 AND delivery_id = $2
        RETURNING payload_hash`,
      [input.tenantId, input.deliveryId],
    );
    const storedHash: string = existing.rows[0].payload_hash;
    if (storedHash !== input.payloadHash) {
      // FORBIDDEN-031: same delivery_id, different payload → fail closed.
      await this.pool.query(
        `UPDATE github_webhook_deliveries SET status = 'HASH_MISMATCH_BLOCKED'
          WHERE tenant_id = $1 AND delivery_id = $2`,
        [input.tenantId, input.deliveryId],
      );
      return { kind: 'hash_mismatch_blocked' };
    }
    return { kind: 'duplicate_ignored' };
  }
}
