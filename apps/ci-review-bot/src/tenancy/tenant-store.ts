import type { Pool } from 'pg';
import type { TenantResolver } from '../handlers/webhook.handler.js';
import { InstallationStore } from '../adapters/github-app-auth.js';

/**
 * Managed tenancy store — provisions tenants/repositories on GitHub App
 * install and resolves repo→tenant for the webhook hot path.
 *
 * HARD-RULE-026: every managed tenant is an installation; all downstream
 * state is tenant-scoped. FR-TENANT-012/013: repo→tenant resolution is
 * durable and fails closed for repos this App is not installed on.
 *
 * In managed mode there is a single App-level webhook secret; the
 * per-tenant-secret seam is preserved by returning that App secret. (The
 * self-hosted path can override with per-tenant secrets later.)
 */

export function tenantIdForInstallation(installationId: number): string {
  return `inst_${installationId}`; // deterministic → install re-delivery is idempotent
}

export interface ProvisionInput {
  installationId: number;
  org: string;
  accountType?: string;
  repositories: { fullName: string; repoId?: number }[];
}

export class TenantStore implements TenantResolver {
  private readonly installations: InstallationStore;

  constructor(
    private readonly pool: Pool,
    /** App-level webhook secret used to verify all managed deliveries. */
    private readonly appWebhookSecret: string,
  ) {
    this.installations = new InstallationStore(pool);
  }

  /** FR-TENANT-012: durable repo→tenant lookup; null = not installed → fail closed. */
  async resolveTenant(
    repoFullName: string,
  ): Promise<{ tenantId: string; webhookSecret: string } | null> {
    const res = await this.pool.query(
      `SELECT r.tenant_id
         FROM repositories r
         JOIN tenants t ON t.tenant_id = r.tenant_id
        WHERE r.repo_full_name = $1 AND r.active AND t.status = 'ACTIVE'`,
      [repoFullName],
    );
    if (res.rowCount === 0) return null;
    return { tenantId: res.rows[0].tenant_id, webhookSecret: this.appWebhookSecret };
  }

  /** installation:created / added — idempotent upsert of tenant + repos. */
  async provisionInstall(input: ProvisionInput): Promise<{ tenantId: string; reposAdded: number }> {
    const tenantId = tenantIdForInstallation(input.installationId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO tenants (tenant_id, installation_id, org, account_type, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')
         ON CONFLICT (tenant_id) DO UPDATE
           SET org = EXCLUDED.org, account_type = EXCLUDED.account_type,
               status = 'ACTIVE', updated_at = now()`,
        [tenantId, input.installationId, input.org, input.accountType ?? 'Organization'],
      );
      let reposAdded = 0;
      for (const repo of input.repositories) {
        const r = await client.query(
          `INSERT INTO repositories (repo_full_name, tenant_id, installation_id, repo_id, active)
           VALUES ($1, $2, $3, $4, TRUE)
           ON CONFLICT (repo_full_name) DO UPDATE
             SET tenant_id = EXCLUDED.tenant_id, installation_id = EXCLUDED.installation_id,
                 repo_id = COALESCE(EXCLUDED.repo_id, repositories.repo_id),
                 active = TRUE, updated_at = now()`,
          [repo.fullName, tenantId, input.installationId, repo.repoId ?? null],
        );
        reposAdded += r.rowCount ?? 0;
      }
      await client.query('COMMIT');
      // Mirror into github_installations for the severance/token path (Sprint 2).
      await this.installations.upsertStatus({
        tenantId,
        installationId: input.installationId,
        org: input.org,
        status: 'ACTIVE',
      });
      return { tenantId, reposAdded };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** installation_repositories:removed — deactivate repos (keep history). */
  async removeRepositories(installationId: number, repoFullNames: string[]): Promise<number> {
    if (repoFullNames.length === 0) return 0;
    const res = await this.pool.query(
      `UPDATE repositories SET active = FALSE, updated_at = now()
        WHERE installation_id = $1 AND repo_full_name = ANY($2)`,
      [installationId, repoFullNames],
    );
    return res.rowCount ?? 0;
  }

  /**
   * installation:deleted / suspend — sever the tenant. Repos deactivate so
   * new PR events fail closed (FR-GH-020); github_installations status drives
   * the existing severance guard.
   */
  async severInstallation(
    installationId: number,
    org: string,
    to: 'SUSPENDED' | 'DELETED',
  ): Promise<void> {
    const tenantId = tenantIdForInstallation(installationId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE tenants SET status = $2, updated_at = now() WHERE tenant_id = $1`, [
        tenantId,
        to,
      ]);
      await client.query(
        `UPDATE repositories SET active = FALSE, updated_at = now() WHERE tenant_id = $1`,
        [tenantId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await this.installations.upsertStatus({
      tenantId,
      installationId,
      org,
      status: to === 'SUSPENDED' ? 'SUSPENDED' : 'INSTALLATION_NOT_FOUND',
      statusReason: `installation ${to.toLowerCase()}`,
    });
  }

  /** installation:unsuspend — reactivate tenant + its repos. */
  async reactivateInstallation(installationId: number, org: string): Promise<void> {
    const tenantId = tenantIdForInstallation(installationId);
    await this.pool.query(`UPDATE tenants SET status = 'ACTIVE', updated_at = now() WHERE tenant_id = $1`, [
      tenantId,
    ]);
    await this.pool.query(
      `UPDATE repositories SET active = TRUE, updated_at = now() WHERE tenant_id = $1`,
      [tenantId],
    );
    await this.installations.upsertStatus({ tenantId, installationId, org, status: 'ACTIVE' });
  }
}
