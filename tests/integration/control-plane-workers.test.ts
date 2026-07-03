import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { sweepStuckRuns } from '../../apps/control-plane/src/workers/run-watchdog.worker.js';
import { runRetentionCleanup } from '../../apps/control-plane/src/workers/retention-cleanup.worker.js';
import { executeExpungement } from '../../apps/control-plane/src/workers/privacy-expungement.worker.js';
import { SpendLedger, ledgerHmac } from '../../apps/ci-review-bot/src/ledger/spend-ledger.js';
import { persistFindings } from '../../apps/ci-review-bot/src/db/findings-store.js';
import { setupDb, truncateAll } from './helpers.js';

/** Sprint 5 — Control Plane workers: watchdog, retention, ledger, expungement. */

describe('control plane workers', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await setupDb();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
  });

  async function insertRun(status: string, opts: { minutesAgo: number; isCurrent?: boolean; tenantId?: string }) {
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO review_runs (tenant_id, repo, pull_request_id, run_id, head_sha, run_epoch, status, is_current, updated_at)
       VALUES ($1,'org/proj',7,$2,'sha-a',1,$3,$4, now() - make_interval(mins => $5))`,
      [opts.tenantId ?? 't1', runId, status, opts.isCurrent ?? true, opts.minutesAgo],
    );
    return runId;
  }

  const run = {
    tenantId: 't1',
    repo: 'org/proj',
    pullRequestId: 7,
    headSha: 'sha-a',
    runId: '',
    runEpoch: 1,
  };

  const finding = {
    finding_id: 'f1',
    severity: 'high' as const,
    category: 'security' as const,
    file: 'src/a.ts',
    line: 3,
    title: 'SQL injection',
    evidence: 'const q = "SELECT * FROM t" + id;',
    recommendation: 'parameterize',
    suggested_patch: 'db.query(sql, [id])',
    confidence: 0.95,
    agent_source: 'security-reviewer',
    root_cause_id: 'INPUT.SQL_INJECTION_RISK',
    root_cause_family: 'INPUT_VALIDATION',
    root_cause_source: 'global' as const,
    taxonomy_version: '2026-07-03',
  };

  describe('run watchdog (HARD-RULE-044, FR-RUN-001..005)', () => {
    it('FORBIDDEN-050: stuck current run past deadline → FAILED', async () => {
      const runId = await insertRun('AGENTS_RUNNING', { minutesAgo: 20 }); // deadline 900s
      const transitions = await sweepStuckRuns(pool);
      expect(transitions).toEqual([{ runId, from: 'AGENTS_RUNNING', to: 'FAILED' }]);
    });

    it('stuck superseded run → STALE_DISCARDED', async () => {
      const runId = await insertRun('POSTING', { minutesAgo: 10, isCurrent: false });
      const transitions = await sweepStuckRuns(pool);
      expect(transitions).toEqual([{ runId, from: 'POSTING', to: 'STALE_DISCARDED' }]);
    });

    it('stuck run under severed integration → BLOCKED (FR-RUN-003)', async () => {
      await pool.query(
        `INSERT INTO github_installations (tenant_id, installation_id, org, status) VALUES ('t1', 42, 'org', 'REVOKED')`,
      );
      const runId = await insertRun('QUEUED', { minutesAgo: 15 });
      const transitions = await sweepStuckRuns(pool);
      expect(transitions).toEqual([{ runId, from: 'QUEUED', to: 'BLOCKED' }]);
    });

    it('healthy runs within deadline are untouched', async () => {
      await insertRun('AGENTS_RUNNING', { minutesAgo: 5 });
      await insertRun('COMPLETED', { minutesAgo: 999, isCurrent: false }); // terminal: no deadline
      expect(await sweepStuckRuns(pool)).toEqual([]);
    });
  });

  describe('retention cleanup (HARD-RULE-047, FR-PRIV series)', () => {
    it('PRIV-001 analogue: expired deliveries and pending posts are deleted', async () => {
      await pool.query(
        `INSERT INTO github_webhook_deliveries (tenant_id, delivery_id, payload_hash, event_type, repo, expires_at, status)
         VALUES ('t1','d-old','h','pull_request','org/proj', now() - interval '1 hour', 'ACCEPTED'),
                ('t1','d-new','h','pull_request','org/proj', now() + interval '1 hour', 'ACCEPTED')`,
      );
      const result = await runRetentionCleanup(pool, { rawFindingEvidenceDays: 30 });
      expect(result.webhookDeliveriesDeleted).toBe(1);
      const left = await pool.query(`SELECT delivery_id FROM github_webhook_deliveries`);
      expect(left.rows).toEqual([{ delivery_id: 'd-new' }]);
    });

    it('HARD-RULE-047: finding evidence redacts after raw TTL, metadata survives', async () => {
      const runId = randomUUID();
      await persistFindings(pool, { ...run, runId }, [finding], 'POSTED');
      await pool.query(`UPDATE review_findings SET created_at = now() - interval '45 days'`);

      const result = await runRetentionCleanup(pool, { rawFindingEvidenceDays: 30 });
      expect(result.findingsRedacted).toBe(1);

      const row = (await pool.query(`SELECT * FROM review_findings`)).rows[0];
      expect(row.evidence).toContain('[REDACTED');
      expect(row.suggested_patch).toBeNull();
      expect(row.contains_raw_code).toBe(false);
      // Non-identifying metadata preserved (365d class).
      expect(row.root_cause_id).toBe('INPUT.SQL_INJECTION_RISK');
      expect(row.severity).toBe('high');

      // FR-PRIV-019: idempotent — second pass redacts nothing new.
      const second = await runRetentionCleanup(pool, { rawFindingEvidenceDays: 30 });
      expect(second.findingsRedacted).toBe(0);
    });
  });

  describe('spend ledger privacy (HARD-RULE-024/025, LEDGER series)', () => {
    const keyA = { keyId: 'k1', secret: 'tenant-a-ledger-secret' };
    const keyB = { keyId: 'k1', secret: 'tenant-b-ledger-secret' };
    const keys: Record<string, typeof keyA> = { 'tenant-a': keyA, 'tenant-b': keyB };
    const ledgerFor = () => new SpendLedger(pool, (tenantId) => keys[tenantId]!);

    const usage = (tenantId: string) => ({
      tenantId,
      appId: 'ci-review-bot',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      modelTier: 'standard',
      taskType: 'code_review',
      workflowId: 'pr_review',
      tokenInput: 1000,
      tokenOutput: 200,
      costUsd: 0.012,
      repo: 'org/proj',
      pullRequestId: 7,
      runId: 'run-1',
      userId: 'dev-alice',
    });

    it('LEDGER-001: ledger rows contain HMAC pseudonyms, never raw identifiers (FORBIDDEN-034)', async () => {
      await ledgerFor().recordUsage(usage('tenant-a'));
      const row = (await pool.query(`SELECT * FROM spend_ledger`)).rows[0];
      expect(row.hmac_user_id).not.toContain('dev-alice');
      expect(row.hmac_repo_id).not.toContain('org/proj');
      expect(row.hmac_user_id).toMatch(/^[0-9a-f]{64}$/);
      expect(row.hmac_key_id).toBe('k1');
      const rawScan = JSON.stringify(row);
      expect(rawScan).not.toContain('dev-alice');
    });

    it('LEDGER-002: same raw identifier yields different HMACs per tenant', async () => {
      expect(ledgerHmac(keyA, 'tenant-a', 'dev-alice')).not.toBe(
        ledgerHmac(keyB, 'tenant-b', 'dev-alice'),
      );
    });

    it('LEDGER-005: key rotation is versioned via key_id on rows', async () => {
      await ledgerFor().recordUsage(usage('tenant-a'));
      keys['tenant-a'] = { keyId: 'k2', secret: 'tenant-a-rotated-secret' };
      await ledgerFor().recordUsage(usage('tenant-a'));
      const rows = await pool.query(`SELECT hmac_key_id FROM spend_ledger ORDER BY ledger_id`);
      expect(rows.rows.map((r) => r.hmac_key_id)).toEqual(['k1', 'k2']);
      keys['tenant-a'] = keyA;
    });

    it('LEDGER-003/006: expungement tombstones identity mapping, aggregates survive', async () => {
      await ledgerFor().recordUsage(usage('tenant-a'));
      const userHmac = ledgerHmac(keyA, 'tenant-a', 'dev-alice');

      const outcome = await executeExpungement(pool, {
        requestId: 'req-1',
        requesterAuthorized: true,
        tenantId: 'tenant-a',
        target: { identityType: 'user', hmacIdentifier: userHmac },
      });
      expect(outcome).toMatchObject({ ok: true, identityRowsTombstoned: 1 });

      // Re-identification path is gone (LEDGER-006)…
      const mapping = (
        await pool.query(
          `SELECT raw_identifier_encrypted, expunged_at FROM spend_ledger_identity_map
            WHERE identity_type = 'user'`,
        )
      ).rows[0];
      expect(mapping.raw_identifier_encrypted).toBe('[EXPUNGED]');
      expect(mapping.expunged_at).not.toBeNull();

      // …while the immutable accounting fact survives (FORBIDDEN-036).
      const ledgerRows = await pool.query(`SELECT token_input, cost_usd FROM spend_ledger`);
      expect(ledgerRows.rows).toHaveLength(1);
      expect(Number(ledgerRows.rows[0].token_input)).toBe(1000);
    });

    it('FR-PRIV-020: unauthorized or ambiguous expungement fails closed', async () => {
      expect(
        await executeExpungement(pool, {
          requestId: 'r1',
          requesterAuthorized: false,
          tenantId: 'tenant-a',
          target: { runId: 'run-1' },
        }),
      ).toEqual({ ok: false, reason: 'unauthorized' });

      expect(
        await executeExpungement(pool, {
          requestId: 'r2',
          requesterAuthorized: true,
          tenantId: 'tenant-a',
          target: {}, // no selector → ambiguous (FORBIDDEN-030)
        }),
      ).toEqual({ ok: false, reason: 'ambiguous_target' });
    });

    it('PRIV-007: run-scoped expungement erases raw finding payloads, keeps metadata', async () => {
      const runId = randomUUID();
      await persistFindings(pool, { ...run, runId }, [finding], 'POSTED');
      const outcome = await executeExpungement(pool, {
        requestId: 'req-2',
        requesterAuthorized: true,
        tenantId: 't1',
        target: { runId },
      });
      expect(outcome).toMatchObject({ ok: true, findingsErased: 1 });
      const row = (await pool.query(`SELECT evidence, root_cause_id FROM review_findings`)).rows[0];
      expect(row.evidence).toBe('[EXPUNGED]');
      expect(row.root_cause_id).toBe('INPUT.SQL_INJECTION_RISK');
    });
  });
});
