import { describe, expect, it, beforeEach } from 'vitest';
import { AdminApi, type AdminRequest } from '../../apps/ci-review-bot/src/admin/admin-api.js';
import type { AdminAuthenticator, AdminPrincipal } from '../../apps/ci-review-bot/src/admin/rbac.js';

/**
 * AdminApi routing + authorization (Sprint 10). Pure routing/guard logic over
 * in-memory fakes: authenticate → 401, role gate → 403, tenant-scope → 404,
 * input validation → 400, happy paths delegate to the reused stores.
 */

const ADMIN: AdminPrincipal = { tenantId: 'inst_7', role: 'admin' };
const VIEWER: AdminPrincipal = { tenantId: 'inst_7', role: 'viewer' };

class FakeAuth implements AdminAuthenticator {
  constructor(private readonly table: Record<string, AdminPrincipal>) {}
  authenticate(header: string | undefined): AdminPrincipal | null {
    const tok = header?.replace(/^Bearer\s+/i, '') ?? '';
    return this.table[tok] ?? null;
  }
}

function fakes() {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const ownedRepos = new Set(['acme/web']);
  const store = {
    async getTenant(tenantId: string) {
      return { tenantId, status: 'ACTIVE', integrationStatus: 'ACTIVE', repoCount: 1 };
    },
    async listRepos(tenantId: string) {
      rec('listRepos', tenantId);
      return [{ repo: 'acme/web', active: true, mode: 'standard', shadow: true, prd: { attached: false } }];
    },
    async repoBelongsToTenant(_t: string, repo: string) {
      return ownedRepos.has(repo);
    },
    async activateRepo(t: string, repo: string) {
      rec('activateRepo', t, repo);
      return true;
    },
    async expunge(input: unknown) {
      rec('expunge', input);
      return { requestId: 'req-1', prdSourcesPurged: 1, prdCriteriaDeleted: 0, identitiesTombstoned: 0 };
    },
  };
  const modes = {
    async setMode(repo: string, mode: string) {
      rec('setMode', repo, mode);
      return true;
    },
  };
  const prd = {
    async setSource(input: unknown) {
      rec('setSource', input);
    },
  };
  const auth = new FakeAuth({ admintok: ADMIN, viewertok: VIEWER });
  const api = new AdminApi({
    auth,
    store: store as never,
    modes: modes as never,
    prd: prd as never,
  });
  return { api, calls };
}

const req = (over: Partial<AdminRequest>): AdminRequest => ({
  method: 'GET',
  path: '/admin/tenant',
  authorization: 'Bearer admintok',
  ...over,
});

describe('AdminApi authorization', () => {
  let api: AdminApi;
  let calls: Record<string, unknown[]>;
  beforeEach(() => {
    ({ api, calls } = fakes());
  });

  it('401 when unauthenticated', async () => {
    expect((await api.handle(req({ authorization: undefined }))).status).toBe(401);
    expect((await api.handle(req({ authorization: 'Bearer nope' }))).status).toBe(401);
  });

  it('403 when a viewer attempts a write', async () => {
    const res = await api.handle(
      req({ method: 'POST', path: '/admin/repos/mode', authorization: 'Bearer viewertok', body: { repo: 'acme/web', mode: 'strict' } }),
    );
    expect(res.status).toBe(403);
    expect(calls['setMode']).toBeUndefined();
  });

  it('404 when the repo is not in the caller tenant', async () => {
    const res = await api.handle(
      req({ method: 'POST', path: '/admin/repos/mode', body: { repo: 'evil/repo', mode: 'strict' } }),
    );
    expect(res.status).toBe(404);
    expect(calls['setMode']).toBeUndefined();
  });

  it('404 on an unknown route', async () => {
    expect((await api.handle(req({ path: '/admin/nope' }))).status).toBe(404);
  });
});

describe('AdminApi reads', () => {
  it('GET /admin/tenant returns the install status card', async () => {
    const { api } = fakes();
    const res = await api.handle(req({ path: '/admin/tenant' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tenantId: 'inst_7', status: 'ACTIVE', repoCount: 1 });
  });

  it('GET /admin/repos lists the tenant repos', async () => {
    const { api } = fakes();
    const res = await api.handle(req({ path: '/admin/repos' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      repos: [{ repo: 'acme/web', active: true, mode: 'standard', shadow: true, prd: { attached: false } }],
    });
  });
});

describe('AdminApi writes', () => {
  it('POST mode: rejects an invalid mode, accepts a valid one', async () => {
    const { api, calls } = fakes();
    const bad = await api.handle(req({ method: 'POST', path: '/admin/repos/mode', body: { repo: 'acme/web', mode: 'turbo' } }));
    expect(bad.status).toBe(400);

    const ok = await api.handle(req({ method: 'POST', path: '/admin/repos/mode', body: { repo: 'acme/web', mode: 'strict' } }));
    expect(ok.status).toBe(200);
    expect(calls['setMode']).toEqual([['acme/web', 'strict']]);
  });

  it('POST prd: paste requires content; a valid paste attaches', async () => {
    const { api, calls } = fakes();
    const noContent = await api.handle(req({ method: 'POST', path: '/admin/repos/prd', body: { repo: 'acme/web', kind: 'paste' } }));
    expect(noContent.status).toBe(400);

    const ok = await api.handle(
      req({ method: 'POST', path: '/admin/repos/prd', body: { repo: 'acme/web', kind: 'paste', content: 'PRD text', ttlHours: 24 } }),
    );
    expect(ok.status).toBe(200);
    expect(calls['setSource']).toEqual([
      [{ tenantId: 'inst_7', repo: 'acme/web', kind: 'paste', ref: 'paste', content: 'PRD text', ttlHours: 24 }],
    ]);
  });

  it('POST prd: repo_path requires a ref', async () => {
    const { api } = fakes();
    const noRef = await api.handle(req({ method: 'POST', path: '/admin/repos/prd', body: { repo: 'acme/web', kind: 'repo_path' } }));
    expect(noRef.status).toBe(400);
  });

  it('POST prd: rejects an unknown kind', async () => {
    const { api } = fakes();
    const res = await api.handle(req({ method: 'POST', path: '/admin/repos/prd', body: { repo: 'acme/web', kind: 'telepathy' } }));
    expect(res.status).toBe(400);
  });

  it('POST activate clears shadow via the store', async () => {
    const { api, calls } = fakes();
    const res = await api.handle(req({ method: 'POST', path: '/admin/repos/activate', body: { repo: 'acme/web' } }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repo: 'acme/web', shadow: false });
    expect(calls['activateRepo']).toEqual([['inst_7', 'acme/web']]);
  });

  it('POST expungement returns a request id (202)', async () => {
    const { api, calls } = fakes();
    const res = await api.handle(req({ method: 'POST', path: '/admin/expungement', body: {} }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ requestId: 'req-1' });
    expect(calls['expunge']).toEqual([[{ tenantId: 'inst_7', requestedBy: 'admin:inst_7' }]]);
  });
});
