import { describe, expect, it } from 'vitest';
import {
  StaticTokenAuthenticator,
  parseAdminTokens,
  roleSatisfies,
  type AdminPrincipal,
} from '../../apps/ci-review-bot/src/admin/rbac.js';

/**
 * Admin RBAC (Sprint 10, FR-SLO-009). Bearer → tenant-scoped principal; role
 * gates writes; unknown/malformed tokens fail closed.
 */

const PRINCIPAL: AdminPrincipal = { tenantId: 'inst_7', role: 'admin' };

describe('StaticTokenAuthenticator', () => {
  const auth = new StaticTokenAuthenticator({
    'admin-tok': PRINCIPAL,
    'viewer-tok': { tenantId: 'inst_7', role: 'viewer' },
  });

  it('resolves a valid Bearer token to its principal', () => {
    expect(auth.authenticate('Bearer admin-tok')).toEqual(PRINCIPAL);
    expect(auth.authenticate('bearer viewer-tok')).toEqual({ tenantId: 'inst_7', role: 'viewer' });
  });

  it('fails closed on missing, malformed, or unknown tokens', () => {
    expect(auth.authenticate(undefined)).toBeNull();
    expect(auth.authenticate('')).toBeNull();
    expect(auth.authenticate('admin-tok')).toBeNull(); // no Bearer scheme
    expect(auth.authenticate('Bearer wrong')).toBeNull();
    expect(auth.authenticate('Bearer admin-tok-extra')).toBeNull(); // not a prefix match
  });

  it('an empty token map closes the surface entirely', () => {
    const closed = new StaticTokenAuthenticator({});
    expect(closed.authenticate('Bearer admin-tok')).toBeNull();
  });
});

describe('roleSatisfies', () => {
  it('admin ⊇ viewer; viewer cannot write', () => {
    expect(roleSatisfies('admin', 'admin')).toBe(true);
    expect(roleSatisfies('admin', 'viewer')).toBe(true);
    expect(roleSatisfies('viewer', 'viewer')).toBe(true);
    expect(roleSatisfies('viewer', 'admin')).toBe(false);
  });
});

describe('parseAdminTokens', () => {
  it('parses the ADMIN_TOKENS JSON map', () => {
    const map = parseAdminTokens('{"t1":{"tenantId":"inst_1","role":"admin"},"t2":{"tenantId":"inst_2","role":"viewer"}}');
    expect(map.get('t1')).toEqual({ tenantId: 'inst_1', role: 'admin' });
    expect(map.get('t2')).toEqual({ tenantId: 'inst_2', role: 'viewer' });
  });

  it('least privilege: unspecified/typo role → viewer; entries without a tenant are skipped', () => {
    const map = parseAdminTokens('{"t1":{"tenantId":"inst_1"},"t3":{"tenantId":"inst_3","role":"superuser"},"bad":{"role":"admin"}}');
    expect(map.get('t1')).toEqual({ tenantId: 'inst_1', role: 'viewer' });
    expect(map.get('t3')).toEqual({ tenantId: 'inst_3', role: 'viewer' });
    expect(map.has('bad')).toBe(false);
  });

  it('absent or malformed value → empty map (surface closed)', () => {
    expect(parseAdminTokens(undefined).size).toBe(0);
    expect(parseAdminTokens('not json').size).toBe(0);
  });
});
