import { tenantIdForInstallation, type ProvisionInput } from '../tenancy/tenant-store.js';

/**
 * Installation lifecycle — PRD v6.5 §7.3, §24.2, FR-GH-017..024.
 *
 * Managed mode: a GitHub App `installation` IS a tenant. Install/added events
 * provision the tenant + selected repositories; uninstall/suspend sever the
 * integration so subsequent PR webhooks fail closed at repo→tenant resolution
 * (HARD-RULE-026, FR-TENANT-013). All provisioning is idempotent so GitHub
 * redeliveries are safe (FR-GH-016).
 */

/** Structural contract satisfied by TenantStore; narrowed for testability. */
export interface InstallationProvisioner {
  provisionInstall(input: ProvisionInput): Promise<{ tenantId: string; reposAdded: number }>;
  removeRepositories(installationId: number, repoFullNames: string[]): Promise<number>;
  severInstallation(installationId: number, org: string, to: 'SUSPENDED' | 'DELETED'): Promise<void>;
  reactivateInstallation(installationId: number, org: string): Promise<void>;
}

export interface InstallationEventPayload {
  action?: string;
  installation?: { id?: number; account?: { login?: string; type?: string } };
  repositories?: { id?: number; full_name?: string }[];
  repositories_added?: { id?: number; full_name?: string }[];
  repositories_removed?: { id?: number; full_name?: string }[];
}

export type InstallationOutcome =
  | { kind: 'provisioned'; tenantId: string; reposAffected: number }
  | { kind: 'repos_removed'; tenantId: string; reposAffected: number }
  | { kind: 'severed'; tenantId: string; status: 'SUSPENDED' | 'DELETED' }
  | { kind: 'reactivated'; tenantId: string }
  | { kind: 'ignored'; reason: string };

function mapRepos(
  repos: { id?: number; full_name?: string }[] | undefined,
): { fullName: string; repoId?: number }[] {
  return (repos ?? [])
    .filter((r): r is { id?: number; full_name: string } => typeof r.full_name === 'string')
    .map((r) => (r.id === undefined ? { fullName: r.full_name } : { fullName: r.full_name, repoId: r.id }));
}

export class InstallationHandler {
  constructor(private readonly provisioner: InstallationProvisioner) {}

  /** Route a verified installation lifecycle payload to the tenant store. */
  async handle(eventType: string, payload: InstallationEventPayload): Promise<InstallationOutcome> {
    const installationId = payload.installation?.id;
    const org = payload.installation?.account?.login;
    const accountType = payload.installation?.account?.type;
    if (!installationId || !org || !payload.action) {
      return { kind: 'ignored', reason: 'missing installation id, account, or action' };
    }
    const tenantId = tenantIdForInstallation(installationId);

    if (eventType === 'installation') {
      switch (payload.action) {
        case 'created': {
          const r = await this.provisioner.provisionInstall({
            installationId,
            org,
            repositories: mapRepos(payload.repositories),
            ...(accountType !== undefined ? { accountType } : {}),
          });
          return { kind: 'provisioned', tenantId: r.tenantId, reposAffected: r.reposAdded };
        }
        case 'deleted': {
          await this.provisioner.severInstallation(installationId, org, 'DELETED');
          return { kind: 'severed', tenantId, status: 'DELETED' };
        }
        case 'suspend': {
          await this.provisioner.severInstallation(installationId, org, 'SUSPENDED');
          return { kind: 'severed', tenantId, status: 'SUSPENDED' };
        }
        case 'unsuspend': {
          await this.provisioner.reactivateInstallation(installationId, org);
          return { kind: 'reactivated', tenantId };
        }
        default:
          // new_permissions_accepted and future actions: no lifecycle change.
          return { kind: 'ignored', reason: `installation action ${payload.action}` };
      }
    }

    if (eventType === 'installation_repositories') {
      switch (payload.action) {
        case 'added': {
          const r = await this.provisioner.provisionInstall({
            installationId,
            org,
            repositories: mapRepos(payload.repositories_added),
            ...(accountType !== undefined ? { accountType } : {}),
          });
          return { kind: 'provisioned', tenantId: r.tenantId, reposAffected: r.reposAdded };
        }
        case 'removed': {
          const names = mapRepos(payload.repositories_removed).map((r) => r.fullName);
          const count = await this.provisioner.removeRepositories(installationId, names);
          return { kind: 'repos_removed', tenantId, reposAffected: count };
        }
        default:
          return { kind: 'ignored', reason: `installation_repositories action ${payload.action}` };
      }
    }

    return { kind: 'ignored', reason: `unsupported lifecycle event ${eventType}` };
  }
}
