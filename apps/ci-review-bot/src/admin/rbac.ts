import { timingSafeEqual } from 'node:crypto';

/**
 * Admin-surface authentication & authorization — PRD v6.5 §7, FR-SLO-009.
 *
 * The onboarding/admin API is a privileged surface: it can change a repo's
 * review mode, attach a PRD, activate real posting, and request raw-data
 * expungement. Every request is authenticated to a tenant-scoped principal and
 * authorized by role. A principal can only ever act within its own tenant
 * (HARD-RULE-026): cross-tenant access is indistinguishable from a missing
 * resource.
 *
 * The bot holds NO provider keys (HARD-RULE-005); admin bearer tokens are the
 * only credential here and live in the deploy's secret store, injected as
 * config. `StaticTokenAuthenticator` is the managed/self-hosted default; an
 * OIDC/JWT authenticator can implement the same interface later without
 * touching the API.
 */

export type AdminRole = 'admin' | 'viewer';

export interface AdminPrincipal {
  /** Tenant this principal is scoped to (`inst_<id>`). */
  tenantId: string;
  /** viewer = read-only; admin = read + write. */
  role: AdminRole;
}

export interface AdminAuthenticator {
  /**
   * Resolve an `Authorization: Bearer <token>` header to a principal, or null
   * when the token is missing/malformed/unknown (→ 401, fail closed).
   */
  authenticate(authorizationHeader: string | undefined): AdminPrincipal | null;
}

/** admin ⊇ viewer: whether `role` is permitted to perform `required`. */
export function roleSatisfies(role: AdminRole, required: AdminRole): boolean {
  if (required === 'viewer') return role === 'viewer' || role === 'admin';
  return role === 'admin';
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string).trim() : null;
}

/** Constant-time string equality (avoids a token-length/prefix timing oracle). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Config-driven token → principal map. Tokens come from the deploy's secret
 * store (never hard-coded); an empty map means the admin surface is closed
 * (every request 401s), which is the safe default when unconfigured.
 */
export class StaticTokenAuthenticator implements AdminAuthenticator {
  private readonly entries: readonly (readonly [string, AdminPrincipal])[];

  constructor(tokens: Record<string, AdminPrincipal> | ReadonlyMap<string, AdminPrincipal>) {
    this.entries = tokens instanceof Map ? [...tokens.entries()] : Object.entries(tokens);
  }

  authenticate(authorizationHeader: string | undefined): AdminPrincipal | null {
    const token = parseBearer(authorizationHeader);
    if (!token) return null;
    // Compare against every configured token so timing does not reveal which
    // (if any) prefix matched.
    let found: AdminPrincipal | null = null;
    for (const [candidate, principal] of this.entries) {
      if (safeEqual(token, candidate)) found = principal;
    }
    return found;
  }
}

/**
 * Parse the `ADMIN_TOKENS` env value: JSON of `{ "<token>": { "tenantId",
 * "role" } }`. Invalid/absent → empty map (admin surface closed). Kept out of
 * config.ts so a malformed value fails soft (closed) rather than crashing boot.
 */
export function parseAdminTokens(raw: string | undefined): Map<string, AdminPrincipal> {
  const map = new Map<string, AdminPrincipal>();
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw) as Record<string, { tenantId?: string; role?: string }>;
    for (const [token, p] of Object.entries(parsed)) {
      if (!token || !p?.tenantId) continue;
      // Least privilege: only an explicit "admin" grants writes; anything else
      // (including a typo'd/absent role) falls back to read-only viewer.
      const role: AdminRole = p.role === 'admin' ? 'admin' : 'viewer';
      map.set(token, { tenantId: p.tenantId, role });
    }
  } catch {
    return new Map();
  }
  return map;
}
