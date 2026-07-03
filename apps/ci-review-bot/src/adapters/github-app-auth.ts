import { createSign } from 'node:crypto';
import type { Pool } from 'pg';
import type { GitHubIntegrationStatus } from '@review-bot/shared';
import { GitHubIntegrationSeveredError } from './github.adapter.js';

/**
 * GitHub App authentication — HARD-RULE-040, FR-GH-033..039.
 *
 * Installation tokens expire hourly BY DESIGN: expiry triggers transparent
 * refresh, never severance (FORBIDDEN-045). Only refresh failure caused by
 * revocation, suspension, missing installation, or permission loss severs the
 * integration, and severance is recorded durably in github_installations.
 */

export interface InstallationTokenProvider {
  getToken(): Promise<string>;
  /** Forces a refresh on the next getToken call (used after a 401 response). */
  invalidate(): void;
}

export class InstallationStore {
  constructor(private readonly pool: Pool) {}

  async upsertStatus(input: {
    tenantId: string;
    installationId: number;
    org: string;
    status: GitHubIntegrationStatus;
    statusReason?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO github_installations (tenant_id, installation_id, org, status, status_reason, reauth_required)
       VALUES ($1, $2, $3, $4, $5, $4 <> 'ACTIVE')
       ON CONFLICT (tenant_id, installation_id) DO UPDATE
         SET status = EXCLUDED.status,
             status_reason = EXCLUDED.status_reason,
             reauth_required = EXCLUDED.reauth_required,
             last_seen_at = now(),
             updated_at = now()`,
      [input.tenantId, input.installationId, input.org, input.status, input.statusReason ?? null],
    );
  }

  async getStatus(tenantId: string, installationId: number): Promise<GitHubIntegrationStatus> {
    const res = await this.pool.query(
      `SELECT status FROM github_installations WHERE tenant_id = $1 AND installation_id = $2`,
      [tenantId, installationId],
    );
    return res.rowCount === 0 ? 'ACTIVE' : (res.rows[0].status as GitHubIntegrationStatus);
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** App JWT (RS256) — 10 minute lifetime, 60s clock-skew backdate. */
export function buildAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 600, iss: appId }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

export interface GitHubAppAuthOptions {
  appId: string;
  privateKeyPem: string;
  installationId: number;
  tenantId: string;
  org: string;
  apiBaseUrl: string;
  store: InstallationStore;
  /** Refresh proactively this many seconds before expiry (config §10.7). */
  refreshBeforeExpirySeconds: number;
  maxRefreshRetries: number;
  fetchImpl?: typeof fetch;
}

export class GitHubAppAuth implements InstallationTokenProvider {
  private cached: { token: string; expiresAtMs: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GitHubAppAuthOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  invalidate(): void {
    this.cached = null;
  }

  async getToken(): Promise<string> {
    const refreshWindowMs = this.opts.refreshBeforeExpirySeconds * 1000;
    if (this.cached && Date.now() < this.cached.expiresAtMs - refreshWindowMs) {
      return this.cached.token;
    }
    return this.refresh();
  }

  /**
   * Exchanges the App JWT for an installation token. Transient failures
   * (5xx, network) retry up to maxRefreshRetries; auth failures classify to a
   * severance status (FR-GH-036) and are persisted before throwing.
   */
  private async refresh(): Promise<string> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.opts.maxRefreshRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.opts.apiBaseUrl}/app/installations/${this.opts.installationId}/access_tokens`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${buildAppJwt(this.opts.appId, this.opts.privateKeyPem)}`,
              accept: 'application/vnd.github+json',
            },
          },
        );
      } catch (err) {
        lastError = err;
        continue; // network error: transient, retry (FR-GH-034)
      }

      if (response.ok) {
        const body = (await response.json()) as { token: string; expires_at: string };
        this.cached = { token: body.token, expiresAtMs: Date.parse(body.expires_at) };
        await this.opts.store.upsertStatus({
          tenantId: this.opts.tenantId,
          installationId: this.opts.installationId,
          org: this.opts.org,
          status: 'ACTIVE',
        });
        return body.token;
      }

      if (response.status >= 500) {
        lastError = new Error(`installation token exchange ${response.status}`);
        continue; // transient, retry
      }

      // Non-retryable auth outcome → severance classification (FR-GH-036).
      const status = this.classifySeverance(response.status);
      await this.opts.store.upsertStatus({
        tenantId: this.opts.tenantId,
        installationId: this.opts.installationId,
        org: this.opts.org,
        status,
        statusReason: `token exchange returned ${response.status}`,
      });
      throw new GitHubIntegrationSeveredError(`token refresh failed with ${response.status} (${status})`);
    }

    // Retries exhausted on transient errors: refresh failed, but this is not
    // proof of revocation — record TOKEN_REFRESH_FAILED (FR-GH-034/019).
    await this.opts.store.upsertStatus({
      tenantId: this.opts.tenantId,
      installationId: this.opts.installationId,
      org: this.opts.org,
      status: 'TOKEN_REFRESH_FAILED',
      statusReason: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw new GitHubIntegrationSeveredError('token refresh retries exhausted (TOKEN_REFRESH_FAILED)');
  }

  private classifySeverance(httpStatus: number): GitHubIntegrationStatus {
    if (httpStatus === 404) return 'INSTALLATION_NOT_FOUND';
    if (httpStatus === 403) return 'SUSPENDED';
    if (httpStatus === 401) return 'REAUTH_REQUIRED';
    return 'REVOKED';
  }
}

/** Static token provider for tests and dry-run against fakes. */
export class StaticTokenProvider implements InstallationTokenProvider {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
  invalidate(): void {}
}
