import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { GitHubIntegrationStatus } from '@review-bot/shared';
import { DEFAULT_REVIEW_MODE, isReviewMode, type ReviewMode } from '../review-modes/modes.js';
import type { PrdSourceKind } from '../prd/prd-store.js';
import type { ShadowResolver } from '../workers/run-executor.js';

/**
 * Admin/onboarding read + control-state store (Sprint 10, PRD v6.5 §7).
 *
 * Read models for the admin surface (install status, repo list with mode /
 * shadow / PRD attachment / integration status) plus the two write actions that
 * do NOT already have a store: repo activation (clear shadow, FR-SLO-008) and
 * raw-data expungement (HARD-RULE-047). Mode and PRD writes reuse the existing
 * ModeStore.setMode / PrdSourceStore.setSource — the admin API is a thin,
 * tenant-scoped surface over the built substrate, not a new engine.
 *
 * Every method is tenant-scoped; nothing here can reach across the HARD-RULE-026
 * boundary.
 */

export interface RepoAdminView {
  repo: string;
  active: boolean;
  /** Effective review mode (Standard by default). */
  mode: ReviewMode;
  /** True until an admin activates real posting (FR-SLO-008). */
  shadow: boolean;
  prd: {
    attached: boolean;
    kind?: PrdSourceKind;
    ref?: string;
    /** Raw upload/paste content whose retention TTL has elapsed (HARD-RULE-023). */
    expired?: boolean;
  };
}

export interface TenantAdminView {
  tenantId: string;
  /** Tenant lifecycle: ACTIVE / SUSPENDED / DELETED. */
  status: string;
  /** Latest GitHub integration/severance status (FR-GH-019/020). */
  integrationStatus: GitHubIntegrationStatus | 'UNKNOWN';
  repoCount: number;
}

export interface ExpungementResult {
  requestId: string;
  prdSourcesPurged: number;
  prdCriteriaDeleted: number;
  identitiesTombstoned: number;
}

export class AdminStore implements ShadowResolver {
  constructor(private readonly pool: Pool) {}

  /** Install/tenant status card. Null when the tenant does not exist. */
  async getTenant(tenantId: string): Promise<TenantAdminView | null> {
    const t = await this.pool.query(
      `SELECT t.status,
              (SELECT count(*) FROM repositories r WHERE r.tenant_id = t.tenant_id AND r.active) AS repo_count,
              gi.status AS integration_status
         FROM tenants t
         LEFT JOIN LATERAL (
           SELECT status FROM github_installations g
            WHERE g.tenant_id = t.tenant_id
            ORDER BY g.updated_at DESC LIMIT 1
         ) gi ON TRUE
        WHERE t.tenant_id = $1`,
      [tenantId],
    );
    if (t.rowCount === 0) return null;
    const row = t.rows[0];
    return {
      tenantId,
      status: row.status as string,
      integrationStatus: (row.integration_status as GitHubIntegrationStatus | null) ?? 'UNKNOWN',
      repoCount: Number(row.repo_count),
    };
  }

  /** Repo list for the tenant with mode, shadow, and PRD attachment status. */
  async listRepos(tenantId: string): Promise<RepoAdminView[]> {
    const res = await this.pool.query(
      `SELECT r.repo_full_name, r.active, r.review_mode, r.shadow_mode,
              p.source_kind, p.source_ref,
              (p.expires_at IS NOT NULL AND p.expires_at <= now()) AS prd_expired
         FROM repositories r
         LEFT JOIN prd_sources p ON p.tenant_id = r.tenant_id AND p.repo = r.repo_full_name
        WHERE r.tenant_id = $1
        ORDER BY r.repo_full_name ASC`,
      [tenantId],
    );
    return res.rows.map((row) => {
      const prd: RepoAdminView['prd'] = { attached: row.source_kind !== null };
      if (row.source_kind !== null) {
        prd.kind = row.source_kind as PrdSourceKind;
        prd.ref = row.source_ref as string;
        prd.expired = row.prd_expired as boolean;
      }
      return {
        repo: row.repo_full_name as string,
        active: row.active as boolean,
        mode: isReviewMode(row.review_mode) ? row.review_mode : DEFAULT_REVIEW_MODE,
        shadow: row.shadow_mode as boolean,
        prd,
      };
    });
  }

  /** FR-TENANT-012 authority: is this repo owned by this tenant (active or not)? */
  async repoBelongsToTenant(tenantId: string, repo: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM repositories WHERE repo_full_name = $1 AND tenant_id = $2`,
      [repo, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** FR-SLO-008: clear shadow → real posting. Tenant-scoped. False if no active repo. */
  async activateRepo(tenantId: string, repo: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE repositories SET shadow_mode = FALSE, updated_at = now()
        WHERE repo_full_name = $1 AND tenant_id = $2 AND active`,
      [repo, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** ShadowResolver for the executor. Missing repo → not shadow (fail open to
   * the existing global dryRun toggle, which stays authoritative). */
  async isShadow(tenantId: string, repo: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT shadow_mode FROM repositories WHERE repo_full_name = $1 AND tenant_id = $2 AND active`,
      [repo, tenantId],
    );
    return res.rows[0]?.shadow_mode === true;
  }

  /**
   * HARD-RULE-047 / FR-PRIV raw-data expungement, tenant-scoped (optionally a
   * single repo). In one transaction: purge inline PRD raw text + its
   * content-addressed extraction cache, tombstone the spend-ledger identity map
   * (the only re-identification path, FR-CP-024/025), and record an auditable
   * request row. Immutable aggregate facts (the ledger itself) survive.
   */
  async expunge(input: {
    tenantId: string;
    repo?: string;
    requestedBy: string;
  }): Promise<ExpungementResult> {
    const requestId = randomUUID();
    const repoFilter = input.repo ? ' AND repo = $2' : '';
    const params = input.repo ? [input.tenantId, input.repo] : [input.tenantId];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Null out inline raw content (keep the source config row so the PRD can
      // be re-attached); its expired flag makes resolution treat it as absent.
      const sources = await client.query(
        `UPDATE prd_sources
            SET content = NULL, content_hash = NULL, expires_at = now(), updated_at = now()
          WHERE tenant_id = $1${repoFilter} AND content IS NOT NULL`,
        params,
      );
      const criteria = await client.query(
        `DELETE FROM prd_criteria WHERE tenant_id = $1${repoFilter}`,
        params,
      );
      // Identity map is repo-agnostic (tenant-scoped pseudonyms); a repo-scoped
      // request still tombstones the tenant's map — raw identifiers are the
      // re-identification risk regardless of which repo asked.
      const identities = await client.query(
        `UPDATE spend_ledger_identity_map
            SET raw_identifier_encrypted = '', expunged_at = now(), expungement_request_id = $2
          WHERE tenant_id = $1 AND expunged_at IS NULL`,
        [input.tenantId, requestId],
      );
      await client.query(
        `INSERT INTO expungement_requests (request_id, tenant_id, repo, scope, requested_by, status, detail)
         VALUES ($1, $2, $3, 'prd', $4, 'COMPLETED', $5)`,
        [
          requestId,
          input.tenantId,
          input.repo ?? null,
          input.requestedBy,
          JSON.stringify({
            prdSourcesPurged: sources.rowCount ?? 0,
            prdCriteriaDeleted: criteria.rowCount ?? 0,
            identitiesTombstoned: identities.rowCount ?? 0,
          }),
        ],
      );
      await client.query('COMMIT');
      return {
        requestId,
        prdSourcesPurged: sources.rowCount ?? 0,
        prdCriteriaDeleted: criteria.rowCount ?? 0,
        identitiesTombstoned: identities.rowCount ?? 0,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
