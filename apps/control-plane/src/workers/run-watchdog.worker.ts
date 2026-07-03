import type { Pool } from 'pg';
import { STATE_DEADLINES_SECONDS, type RunState } from '@review-bot/shared';

/**
 * Run watchdog — HARD-RULE-044, FR-RUN-001..005.
 *
 * Detects runs stuck past their per-state deadline using DURABLE
 * review_runs state (never Redis, FR-RUN-005) and transitions them:
 *   - superseded (no longer current) → STALE_DISCARDED
 *   - severed integration            → BLOCKED
 *   - otherwise                      → FAILED (EVT_TIMEOUT semantics)
 */

export interface WatchdogTransition {
  runId: string;
  from: RunState;
  to: 'FAILED' | 'STALE_DISCARDED' | 'BLOCKED';
}

export async function sweepStuckRuns(
  pool: Pool,
  log: (msg: string, fields: Record<string, unknown>) => void = () => {},
): Promise<WatchdogTransition[]> {
  const transitions: WatchdogTransition[] = [];
  for (const [state, deadline] of Object.entries(STATE_DEADLINES_SECONDS)) {
    if (deadline === null) continue; // terminal states have no deadline
    const stuck = await pool.query(
      `SELECT r.run_id, r.status, r.is_current, r.tenant_id,
              COALESCE(
                (SELECT bool_or(gi.status <> 'ACTIVE') FROM github_installations gi
                  WHERE gi.tenant_id = r.tenant_id),
                FALSE
              ) AS severed
         FROM review_runs r
        WHERE r.status = $1 AND r.updated_at < now() - make_interval(secs => $2)`,
      [state, deadline],
    );
    for (const row of stuck.rows) {
      const to: WatchdogTransition['to'] = row.severed
        ? 'BLOCKED'
        : row.is_current
          ? 'FAILED'
          : 'STALE_DISCARDED';
      await pool.query(
        `UPDATE review_runs
            SET status = $2, updated_at = now(),
                stale_discarded_at = CASE WHEN $2 = 'STALE_DISCARDED' THEN now() ELSE stale_discarded_at END
          WHERE run_id = $1 AND status = $3`, // guarded: only if still stuck
        [row.run_id, to, state],
      );
      transitions.push({ runId: row.run_id, from: state as RunState, to });
      log('ci_review.run.watchdog_timeout', { runId: row.run_id, from: state, to });
    }
  }
  return transitions;
}
