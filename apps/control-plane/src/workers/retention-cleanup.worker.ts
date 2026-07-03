import type { Pool } from 'pg';

/**
 * Retention cleanup — HARD-RULE-022/047, FR-PRIV-001/008/009/010,
 * FR-CP-012.
 *
 * Deletes expired raw operational rows and redacts raw code held inside
 * finding evidence/patches after the raw-data TTL, preserving the
 * non-identifying finding metadata (which lives on the 365d class).
 * Idempotent and retry-safe (FR-PRIV-019 analogue).
 */

export interface RetentionPolicy {
  rawFindingEvidenceDays: number;
}

export interface RetentionResult {
  webhookDeliveriesDeleted: number;
  pendingPostsDeleted: number;
  findingsRedacted: number;
}

export async function runRetentionCleanup(
  pool: Pool,
  policy: RetentionPolicy,
  log: (msg: string, fields: Record<string, unknown>) => void = () => {},
): Promise<RetentionResult> {
  // Expired webhook delivery records (FR-GH-031).
  const deliveries = await pool.query(
    `DELETE FROM github_webhook_deliveries WHERE expires_at < now()`,
  );
  // Expired terminal pending posts (FR-POST-043): rows past expiry in a
  // terminal status; PENDING/BACKOFF past expiry are also dead by definition.
  const pendingPosts = await pool.query(
    `DELETE FROM pending_review_posts WHERE expires_at < now()`,
  );
  // Raw code redaction inside findings (HARD-RULE-047): evidence and
  // suggested_patch follow the raw-data TTL; metadata survives.
  const findings = await pool.query(
    `UPDATE review_findings
        SET evidence = '[REDACTED: raw-data retention expired]',
            suggested_patch = NULL,
            evidence_redacted_at = now(),
            suggested_patch_redacted_at = now(),
            contains_raw_code = FALSE
      WHERE contains_raw_code
        AND created_at < now() - make_interval(days => $1)`,
    [policy.rawFindingEvidenceDays],
  );

  const result: RetentionResult = {
    webhookDeliveriesDeleted: deliveries.rowCount ?? 0,
    pendingPostsDeleted: pendingPosts.rowCount ?? 0,
    findingsRedacted: findings.rowCount ?? 0,
  };
  if (result.webhookDeliveriesDeleted + result.pendingPostsDeleted + result.findingsRedacted > 0) {
    log('privacy.data_deleted', { ...result }); // FR-PRIV-010
  }
  return result;
}
