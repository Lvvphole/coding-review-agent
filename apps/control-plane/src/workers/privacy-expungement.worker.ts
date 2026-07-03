import type { Pool } from 'pg';

/**
 * Privacy expungement — HARD-RULE-023, FR-PRIV-011..020, FR-CP-017..019/025.
 *
 * Authorized, unambiguous, targeted deletion: tombstones ledger identity
 * mappings (removing the re-identification path) and deletes raw finding
 * evidence, while immutable aggregate financial facts survive
 * (FORBIDDEN-036, LEDGER-003). Fails closed on unauthorized or ambiguous
 * requests (FR-PRIV-020) and is idempotent (FR-PRIV-019).
 */

export interface ExpungementRequest {
  requestId: string;
  /** Verified by the caller's RBAC layer; worker fails closed when false. */
  requesterAuthorized: boolean;
  tenantId: string;
  /** Exactly one target selector must be provided (FR-PRIV-034 ambiguity rule). */
  target: {
    identityType?: 'repo' | 'pull_request' | 'run' | 'user' | 'trace';
    hmacIdentifier?: string;
    runId?: string;
  };
}

export type ExpungementOutcome =
  | { ok: true; identityRowsTombstoned: number; findingsErased: number }
  | { ok: false; reason: 'unauthorized' | 'ambiguous_target' };

export async function executeExpungement(
  pool: Pool,
  request: ExpungementRequest,
  log: (msg: string, fields: Record<string, unknown>) => void = () => {},
): Promise<ExpungementOutcome> {
  if (!request.requesterAuthorized) {
    log('privacy.data_expungement_failed', { requestId: request.requestId, reason: 'unauthorized' });
    return { ok: false, reason: 'unauthorized' }; // FORBIDDEN-029
  }
  const byIdentity =
    request.target.identityType !== undefined && request.target.hmacIdentifier !== undefined;
  const byRun = request.target.runId !== undefined;
  if (byIdentity === byRun) {
    // Zero or multiple selectors → ambiguous → fail closed (FORBIDDEN-030).
    log('privacy.data_expungement_failed', { requestId: request.requestId, reason: 'ambiguous' });
    return { ok: false, reason: 'ambiguous_target' };
  }

  let identityRowsTombstoned = 0;
  let findingsErased = 0;

  if (byIdentity) {
    const res = await pool.query(
      `UPDATE spend_ledger_identity_map
          SET raw_identifier_encrypted = '[EXPUNGED]',
              expunged_at = now(),
              expungement_request_id = $4
        WHERE tenant_id = $1 AND identity_type = $2 AND hmac_identifier = $3
          AND expunged_at IS NULL`,
      [request.tenantId, request.target.identityType, request.target.hmacIdentifier, request.requestId],
    );
    identityRowsTombstoned = res.rowCount ?? 0;
  } else {
    // Run-scoped expungement: erase raw finding payloads for the run
    // (PRIV-007: raw data goes, aggregates/metadata stay).
    const findings = await pool.query(
      `UPDATE review_findings
          SET evidence = '[EXPUNGED]',
              suggested_patch = NULL,
              evidence_redacted_at = now(),
              suggested_patch_redacted_at = now(),
              contains_raw_code = FALSE
        WHERE tenant_id = $1 AND run_id = $2`,
      [request.tenantId, request.target.runId],
    );
    findingsErased = findings.rowCount ?? 0;
  }

  // Immutable audit record (FR-PRIV-015/018) — event log in this sprint.
  log('privacy.data_expungement_completed', {
    requestId: request.requestId,
    tenantId: request.tenantId,
    identityRowsTombstoned,
    findingsErased,
  });
  return { ok: true, identityRowsTombstoned, findingsErased };
}
