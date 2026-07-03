import pg from 'pg';
import { sweepStuckRuns } from './workers/run-watchdog.worker.js';
import { runRetentionCleanup } from './workers/retention-cleanup.worker.js';

/**
 * control-plane entrypoint — asynchronous learning/hygiene loops
 * (HARD-RULE-006: never in the Gateway hot path; FR-CP-001/002).
 * Sprint 5 runs the watchdog and retention workers; expungement executes on
 * demand via executeExpungement (admin surface arrives with the dashboard).
 */
async function main(): Promise<void> {
  const pool = new pg.Pool({
    connectionString:
      process.env['DATABASE_URL'] ?? 'postgres://review_bot:review_bot_dev@localhost:5433/review_bot',
    max: 5,
  });
  const log = (msg: string, fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ msg, ...fields }));

  const watchdog = setInterval(() => {
    sweepStuckRuns(pool, log).catch((err) => console.error('watchdog sweep failed', err));
  }, Number(process.env['WATCHDOG_INTERVAL_MS'] ?? 30_000));
  watchdog.unref();

  const retention = setInterval(() => {
    runRetentionCleanup(
      pool,
      { rawFindingEvidenceDays: Number(process.env['RAW_EVIDENCE_TTL_DAYS'] ?? 30) },
      log,
    ).catch((err) => console.error('retention cleanup failed', err));
  }, Number(process.env['RETENTION_INTERVAL_MS'] ?? 3_600_000));
  retention.unref();

  console.log('control-plane workers running (watchdog + retention)');
  // Keep the process alive.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
