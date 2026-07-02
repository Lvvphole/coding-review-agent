import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { RunIdentity } from '@review-bot/shared';

/**
 * PR run coordination with durable Postgres fencing authority.
 *
 * HARD-RULE-032: correctness-critical PR state has a durable Postgres
 * authority (pr_fencing_state + review_runs); Redis only caches it
 * (FR-PRC-007, FR-FENCE-012).
 * HARD-RULE-033 / FR-FENCE-014: missing/unreadable durable state → posting
 * guard fails closed.
 * FR-FENCE-016/017: run_epoch is monotonic in Postgres; Redis loss cannot
 * reset it.
 */

export interface FencingSnapshot {
  headSha: string;
  runEpoch: number;
  runId: string;
}

export interface StartRunResult {
  run: RunIdentity;
  /** run_id of the run this one superseded, when a newer SHA arrived (FR-PRC-008/009). */
  supersededRunId: string | null;
}

export class PrRunCoordinator {
  constructor(private readonly pool: Pool) {}

  /**
   * Registers a new review target. Atomically increments the durable
   * run_epoch, marks any previous current run superseded (stale-discarded and
   * no longer current), and creates the new current run.
   */
  async startRun(input: {
    tenantId: string;
    repo: string;
    pullRequestId: number;
    headSha: string;
  }): Promise<StartRunResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Atomic claim-or-increment: concurrent starters (including the
      // first-ever run for a PR, where SELECT FOR UPDATE would lock nothing)
      // serialize on the ON CONFLICT row lock, guaranteeing monotonic epochs
      // (FR-FENCE-016).
      const runId = randomUUID();
      const upsert = await client.query(
        `INSERT INTO pr_fencing_state
           (tenant_id, repo, pull_request_id, current_head_sha, current_run_epoch, current_run_id)
         VALUES ($1, $2, $3, $4, 1, $5)
         ON CONFLICT (tenant_id, repo, pull_request_id) DO UPDATE
           SET current_head_sha = EXCLUDED.current_head_sha,
               current_run_epoch = pr_fencing_state.current_run_epoch + 1,
               current_run_id = EXCLUDED.current_run_id,
               updated_at = now()
         RETURNING current_run_epoch`,
        [input.tenantId, input.repo, input.pullRequestId, input.headSha, runId],
      );
      const nextEpoch = Number(upsert.rows[0].current_run_epoch);

      // Supersede the previous current run (FR-PRC-008..010). The fencing row
      // lock held by this transaction serializes this with concurrent starters.
      const superseded = await client.query(
        `UPDATE review_runs
            SET is_current = FALSE,
                status = CASE WHEN status IN ('COMPLETED','CANCELLED','STALE_DISCARDED','FAILED','BLOCKED','ESCALATED')
                              THEN status ELSE 'STALE_DISCARDED' END,
                stale_discarded_at = CASE WHEN status IN ('COMPLETED','CANCELLED','STALE_DISCARDED','FAILED','BLOCKED','ESCALATED')
                                          THEN stale_discarded_at ELSE now() END,
                updated_at = now()
          WHERE tenant_id = $1 AND repo = $2 AND pull_request_id = $3 AND is_current
          RETURNING run_id`,
        [input.tenantId, input.repo, input.pullRequestId],
      );
      const supersededRunId: string | null =
        superseded.rowCount && superseded.rowCount > 0 ? superseded.rows[0].run_id : null;

      await client.query(
        `INSERT INTO review_runs
           (tenant_id, repo, pull_request_id, run_id, head_sha, run_epoch, status, is_current)
         VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVED', TRUE)`,
        [input.tenantId, input.repo, input.pullRequestId, runId, input.headSha, nextEpoch],
      );

      await client.query('COMMIT');
      return {
        run: {
          tenantId: input.tenantId,
          repo: input.repo,
          pullRequestId: input.pullRequestId,
          headSha: input.headSha,
          runId,
          runEpoch: nextEpoch,
        },
        supersededRunId,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reads the durable fencing snapshot (FR-FENCE-013). Returns null when the
   * durable state is missing — callers MUST fail closed (FR-FENCE-014).
   */
  async readDurableFencing(
    tenantId: string,
    repo: string,
    pullRequestId: number,
  ): Promise<FencingSnapshot | null> {
    const res = await this.pool.query(
      `SELECT current_head_sha, current_run_epoch, current_run_id
         FROM pr_fencing_state
        WHERE tenant_id = $1 AND repo = $2 AND pull_request_id = $3`,
      [tenantId, repo, pullRequestId],
    );
    if (res.rowCount === 0) return null;
    return {
      headSha: res.rows[0].current_head_sha,
      runEpoch: Number(res.rows[0].current_run_epoch),
      runId: res.rows[0].current_run_id,
    };
  }

  async updateRunStatus(runId: string, status: string): Promise<void> {
    await this.pool.query(
      `UPDATE review_runs
          SET status = $2,
              updated_at = now(),
              completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END,
              cancelled_at = CASE WHEN $2 = 'CANCELLED' THEN now() ELSE cancelled_at END,
              stale_discarded_at = CASE WHEN $2 = 'STALE_DISCARDED' THEN now() ELSE stale_discarded_at END
        WHERE run_id = $1`,
      [runId, status],
    );
  }
}

export interface PostingGuardDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Latest-SHA + run_epoch posting guard against the durable authority —
 * HARD-RULE-001/033, G4/G5/G19/G39, FORBIDDEN-040/041.
 */
export function evaluatePostingGuard(
  run: RunIdentity,
  durable: FencingSnapshot | null,
  integrationStatus: string,
): PostingGuardDecision {
  if (durable === null) {
    return { allowed: false, reason: 'durable fencing state missing — fail closed (HARD-RULE-033)' };
  }
  if (integrationStatus !== 'ACTIVE') {
    return { allowed: false, reason: `integration status ${integrationStatus} is not ACTIVE (G37)` };
  }
  if (durable.headSha !== run.headSha) {
    return { allowed: false, reason: `head_sha mismatch: current=${durable.headSha} run=${run.headSha} (G4)` };
  }
  if (durable.runEpoch !== run.runEpoch) {
    return { allowed: false, reason: `run_epoch mismatch: current=${durable.runEpoch} run=${run.runEpoch} (G5)` };
  }
  if (durable.runId !== run.runId) {
    return { allowed: false, reason: 'run is no longer the current run for this PR' };
  }
  return { allowed: true, reason: 'guard passed' };
}
