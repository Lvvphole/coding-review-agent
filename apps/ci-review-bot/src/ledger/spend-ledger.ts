import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Privacy-safe spend ledger writer — HARD-RULE-024/025, FR-CP-020..030.
 *
 * Immutable ledger rows carry ONLY tenant-scoped HMAC pseudonyms
 * (FORBIDDEN-034/035); the separate identity map is the only
 * re-identification path and is expungable (FR-CP-024/025/028). HMAC keys
 * are tenant-scoped and versioned via key_id (FR-CP-023/029).
 */

export interface TenantLedgerKey {
  keyId: string;
  /** Tenant-scoped HMAC key from the approved secret store. */
  secret: string;
}

export interface UsageRecord {
  tenantId: string;
  appId: string;
  provider: string;
  model: string;
  modelTier: string;
  taskType: string;
  workflowId: string;
  tokenInput: number;
  tokenOutput: number;
  costUsd: number;
  repo: string;
  pullRequestId: number;
  runId: string;
  userId?: string;
  traceId?: string;
}

export function ledgerHmac(key: TenantLedgerKey, tenantId: string, raw: string): string {
  // Tenant id is folded into the material so identical raw identifiers
  // produce different pseudonyms per tenant (LEDGER-002).
  return createHmac('sha256', key.secret).update(`${tenantId}\n${raw}`).digest('hex');
}

function encryptRaw(key: TenantLedgerKey, raw: string): string {
  // AES-256-GCM with a key derived from the tenant secret; the identity map
  // value is recoverable only while the tenant key exists and the row is not
  // expunged.
  const derived = createHmac('sha256', key.secret).update('identity-map-encryption').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

export class SpendLedger {
  constructor(
    private readonly pool: Pool,
    private readonly keyForTenant: (tenantId: string) => TenantLedgerKey,
  ) {}

  async recordUsage(usage: UsageRecord): Promise<void> {
    const key = this.keyForTenant(usage.tenantId);
    const pseudonym = (identityType: string, raw: string) =>
      ledgerHmac(key, usage.tenantId, raw);

    const identities: { type: string; raw: string; hmac: string }[] = [
      { type: 'repo', raw: usage.repo, hmac: pseudonym('repo', usage.repo) },
      {
        type: 'pull_request',
        raw: String(usage.pullRequestId),
        hmac: pseudonym('pull_request', String(usage.pullRequestId)),
      },
      { type: 'run', raw: usage.runId, hmac: pseudonym('run', usage.runId) },
      ...(usage.userId ? [{ type: 'user', raw: usage.userId, hmac: pseudonym('user', usage.userId) }] : []),
      ...(usage.traceId ? [{ type: 'trace', raw: usage.traceId, hmac: pseudonym('trace', usage.traceId) }] : []),
    ];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Immutable accounting fact — pseudonyms only (FORBIDDEN-034/035).
      await client.query(
        `INSERT INTO spend_ledger
           (tenant_id, app_id, provider, model, model_tier, task_type, workflow_id, date_bucket,
            token_input, token_output, cost_usd,
            hmac_repo_id, hmac_pull_request_id, hmac_user_id, hmac_run_id, hmac_trace_id, hmac_key_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CURRENT_DATE, $8,$9,$10, $11,$12,$13,$14,$15,$16)`,
        [
          usage.tenantId,
          usage.appId,
          usage.provider,
          usage.model,
          usage.modelTier,
          usage.taskType,
          usage.workflowId,
          usage.tokenInput,
          usage.tokenOutput,
          usage.costUsd,
          identities.find((i) => i.type === 'repo')!.hmac,
          identities.find((i) => i.type === 'pull_request')!.hmac,
          identities.find((i) => i.type === 'user')?.hmac ?? null,
          identities.find((i) => i.type === 'run')!.hmac,
          identities.find((i) => i.type === 'trace')?.hmac ?? null,
          key.keyId,
        ],
      );
      // Expungable identity mapping (FR-CP-024) — separate table, never the
      // ledger row itself.
      for (const identity of identities) {
        await client.query(
          `INSERT INTO spend_ledger_identity_map
             (tenant_id, identity_type, raw_identifier_encrypted, hmac_identifier, hmac_key_id)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, identity_type, hmac_identifier) DO NOTHING`,
          [usage.tenantId, identity.type, encryptRaw(key, identity.raw), identity.hmac, key.keyId],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
