import { describe, expect, it } from 'vitest';
import { commentFingerprint, parseMarker, renderMarker } from '@review-bot/shared';
import { redactOutboundComment } from '@review-bot/validators';

describe('comment marker and fingerprint (HARD-RULE-035)', () => {
  const fingerprintInput = {
    tenantId: 't1',
    repo: 'org/proj',
    pullRequestId: 42,
    headSha: 'abc123',
    runEpoch: 7,
    findingId: 'f-01',
    file: 'src/auth/login.ts',
    line: 33,
    rootCauseId: 'AUTHZ.MISSING_AUTHORIZATION_CHECK',
  };

  it('FR-POST-062: fingerprint is stable for identical finding and code state', () => {
    const a = commentFingerprint('secret', fingerprintInput);
    const b = commentFingerprint('secret', { ...fingerprintInput });
    expect(a).toBe(b);
  });

  it('fingerprint changes with head_sha (different code state)', () => {
    const a = commentFingerprint('secret', fingerprintInput);
    const b = commentFingerprint('secret', { ...fingerprintInput, headSha: 'def456' });
    expect(a).not.toBe(b);
  });

  it('LEDGER-002 analogue: different tenant secrets give different fingerprints', () => {
    const a = commentFingerprint('secret-tenant-a', fingerprintInput);
    const b = commentFingerprint('secret-tenant-b', fingerprintInput);
    expect(a).not.toBe(b);
  });

  it('marker round-trips through render and parse (FR-POST-058)', () => {
    const marker = {
      tenantId: 't1',
      repo: 'org/proj',
      pullRequestId: 42,
      runId: 'run-1',
      runEpoch: 7,
      headSha: 'abc123',
      pendingPostId: 'pp-1',
      findingId: 'f-01',
      commentFingerprint: 'deadbeef',
    };
    const body = `**[high] Missing auth check**\n\nDetails here.\n\n${renderMarker(marker)}`;
    expect(parseMarker(body)).toEqual(marker);
  });

  it('returns null for bodies without markers (human comments)', () => {
    expect(parseMarker('just a human reply')).toBeNull();
  });
});

describe('outbound secret redaction (HARD-RULE-038, FR-SEC-015..017)', () => {
  it('redacts a GitHub token quoted in evidence', () => {
    const body = 'Evidence: `const t = "ghp_' + 'a'.repeat(36) + '";`';
    const result = redactOutboundComment(body);
    expect(result.redacted).toBe(true);
    expect(result.body).not.toContain('ghp_');
    expect(result.body).toContain('[REDACTED:github_token]');
  });

  it('redacts AWS access keys and private key blocks', () => {
    const body = [
      'key: AKIAIOSFODNN7EXAMPLE',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = redactOutboundComment(body);
    expect(result.body).toContain('[REDACTED:aws_access_key]');
    expect(result.body).toContain('[REDACTED:private_key_block]');
    expect(result.body).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('FR-SEC-019: preserves surrounding context', () => {
    const result = redactOutboundComment('Hardcoded credential found: AKIAIOSFODNN7EXAMPLE — move to env.');
    expect(result.body).toContain('Hardcoded credential found:');
    expect(result.body).toContain('move to env.');
  });

  it('leaves clean comments untouched', () => {
    const body = 'This loop is O(n^2); use a Set for lookup.';
    const result = redactOutboundComment(body);
    expect(result.redacted).toBe(false);
    expect(result.body).toBe(body);
  });
});
