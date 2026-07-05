import { isReviewMode, REVIEW_MODES } from '../review-modes/modes.js';
import type { ModeStore } from '../review-modes/mode-store.js';
import { type PrdSourceKind, type PrdSourceStore } from '../prd/prd-store.js';
import type { AdminAuthenticator, AdminPrincipal, AdminRole } from './rbac.js';
import { roleSatisfies } from './rbac.js';
import type { AdminStore } from './admin-store.js';

/**
 * Admin / onboarding HTTP surface (Sprint 10, PRD v6.5 §7, HARD-RULE-UX-001..004).
 *
 * API-first (a heavy SPA is a non-goal): a thin, tenant-scoped JSON surface over
 * the built substrate. Reads report install/repo/PRD/integration status; writes
 * set review mode (→ ModeStore.setMode), attach a PRD (→ PrdSourceStore.setSource),
 * activate real posting (→ AdminStore.activateRepo, FR-SLO-008), and request
 * raw-data expungement (→ AdminStore.expunge, HARD-RULE-047).
 *
 * `handle` is transport-agnostic (method/path/headers/body in, status/body out)
 * so it is unit-testable without a live socket; main.ts adapts node:http to it.
 *
 * Authorization order (fail closed): authenticate → 401; role gate → 403;
 * tenant-scope the repo → 404 (a cross-tenant repo is indistinguishable from a
 * missing one, HARD-RULE-026).
 */

const PRD_KINDS: readonly PrdSourceKind[] = ['repo_path', 'link', 'upload', 'paste'];

export interface AdminRequest {
  method: string;
  /** Path with the `/admin` prefix, e.g. `/admin/repos`. */
  path: string;
  authorization?: string | undefined;
  query?: Record<string, string>;
  body?: unknown;
}

export interface AdminResponse {
  status: number;
  body: unknown;
}

export interface AdminApiDeps {
  auth: AdminAuthenticator;
  store: AdminStore;
  modes: ModeStore;
  prd: PrdSourceStore;
}

function json(status: number, body: unknown): AdminResponse {
  return { status, body };
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export class AdminApi {
  constructor(private readonly deps: AdminApiDeps) {}

  async handle(req: AdminRequest): Promise<AdminResponse> {
    const principal = this.deps.auth.authenticate(req.authorization);
    if (!principal) return json(401, { error: 'unauthorized' });

    const path = req.path.replace(/\/+$/, '') || '/admin';
    const route = `${req.method.toUpperCase()} ${path}`;

    try {
      switch (route) {
        case 'GET /admin/tenant':
          return await this.getTenant(principal);
        case 'GET /admin/repos':
          return await this.listRepos(principal);
        case 'POST /admin/repos/mode':
          return await this.setMode(principal, req);
        case 'POST /admin/repos/prd':
          return await this.attachPrd(principal, req);
        case 'POST /admin/repos/activate':
          return await this.activate(principal, req);
        case 'POST /admin/expungement':
          return await this.expunge(principal, req);
        default:
          return json(404, { error: 'not_found' });
      }
    } catch {
      // Admin surface: no internal detail in the response body (parallels
      // HARD-RULE-UX-005 for the standard surface); details go to logs upstream.
      return json(500, { error: 'internal_error' });
    }
  }

  private require(principal: AdminPrincipal, role: AdminRole): AdminResponse | null {
    return roleSatisfies(principal.role, role) ? null : json(403, { error: 'forbidden' });
  }

  /** Resolve + tenant-scope a repo from the request body. */
  private async resolveRepo(
    principal: AdminPrincipal,
    req: AdminRequest,
  ): Promise<{ repo: string } | AdminResponse> {
    const repo = asRecord(req.body)['repo'];
    if (typeof repo !== 'string' || repo.length === 0) {
      return json(400, { error: 'repo_required' });
    }
    if (!(await this.deps.store.repoBelongsToTenant(principal.tenantId, repo))) {
      return json(404, { error: 'repo_not_found' });
    }
    return { repo };
  }

  private async getTenant(principal: AdminPrincipal): Promise<AdminResponse> {
    const tenant = await this.deps.store.getTenant(principal.tenantId);
    if (!tenant) return json(404, { error: 'tenant_not_found' });
    return json(200, tenant);
  }

  private async listRepos(principal: AdminPrincipal): Promise<AdminResponse> {
    return json(200, { repos: await this.deps.store.listRepos(principal.tenantId) });
  }

  private async setMode(principal: AdminPrincipal, req: AdminRequest): Promise<AdminResponse> {
    const gate = this.require(principal, 'admin');
    if (gate) return gate;
    const resolved = await this.resolveRepo(principal, req);
    if ('status' in resolved) return resolved;

    const mode = asRecord(req.body)['mode'];
    if (!isReviewMode(mode)) {
      return json(400, { error: 'invalid_mode', allowed: REVIEW_MODES });
    }
    const ok = await this.deps.modes.setMode(resolved.repo, mode);
    if (!ok) return json(409, { error: 'repo_inactive' });
    return json(200, { repo: resolved.repo, mode });
  }

  private async attachPrd(principal: AdminPrincipal, req: AdminRequest): Promise<AdminResponse> {
    const gate = this.require(principal, 'admin');
    if (gate) return gate;
    const resolved = await this.resolveRepo(principal, req);
    if ('status' in resolved) return resolved;

    const body = asRecord(req.body);
    const kind = body['kind'];
    if (typeof kind !== 'string' || !PRD_KINDS.includes(kind as PrdSourceKind)) {
      return json(400, { error: 'invalid_prd_kind', allowed: PRD_KINDS });
    }
    const prdKind = kind as PrdSourceKind;

    const inline = prdKind === 'upload' || prdKind === 'paste';
    const content = body['content'];
    if (inline && (typeof content !== 'string' || content.trim().length === 0)) {
      return json(400, { error: 'content_required' });
    }
    // upload/paste key on the caller-supplied ref (an upload id / version tag),
    // defaulting to the kind; repo_path/link require an explicit ref (path/URL).
    const rawRef = body['ref'];
    const ref = typeof rawRef === 'string' && rawRef.length > 0 ? rawRef : inline ? prdKind : '';
    if (!inline && ref.length === 0) {
      return json(400, { error: 'ref_required' });
    }
    const ttlHours = body['ttlHours'];

    await this.deps.prd.setSource({
      tenantId: principal.tenantId,
      repo: resolved.repo,
      kind: prdKind,
      ref,
      ...(inline ? { content: content as string } : {}),
      ...(typeof ttlHours === 'number' && Number.isFinite(ttlHours) ? { ttlHours } : {}),
    });
    return json(200, { repo: resolved.repo, prd: { kind: prdKind, ref } });
  }

  private async activate(principal: AdminPrincipal, req: AdminRequest): Promise<AdminResponse> {
    const gate = this.require(principal, 'admin');
    if (gate) return gate;
    const resolved = await this.resolveRepo(principal, req);
    if ('status' in resolved) return resolved;

    const ok = await this.deps.store.activateRepo(principal.tenantId, resolved.repo);
    if (!ok) return json(409, { error: 'repo_inactive' });
    return json(200, { repo: resolved.repo, shadow: false });
  }

  private async expunge(principal: AdminPrincipal, req: AdminRequest): Promise<AdminResponse> {
    const gate = this.require(principal, 'admin');
    if (gate) return gate;

    // Optional repo scope; when present it must belong to the tenant.
    const rawRepo = asRecord(req.body)['repo'];
    let repo: string | undefined;
    if (typeof rawRepo === 'string' && rawRepo.length > 0) {
      if (!(await this.deps.store.repoBelongsToTenant(principal.tenantId, rawRepo))) {
        return json(404, { error: 'repo_not_found' });
      }
      repo = rawRepo;
    }
    const result = await this.deps.store.expunge({
      tenantId: principal.tenantId,
      ...(repo ? { repo } : {}),
      requestedBy: `${principal.role}:${principal.tenantId}`,
    });
    return json(202, result);
  }
}
