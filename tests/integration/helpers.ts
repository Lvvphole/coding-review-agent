import { Redis } from 'ioredis';
import pg from 'pg';
import { migrate } from '../../apps/ci-review-bot/src/db/migrate.js';

export const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://review_bot:review_bot_dev@localhost:5433/review_bot';
export const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6380';

export async function setupDb(): Promise<pg.Pool> {
  await migrate(DATABASE_URL);
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  await truncateAll(pool);
  return pool;
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE review_runs, pr_fencing_state, github_webhook_deliveries,
              pending_review_posts, github_installations`,
  );
}

export function createRedis(): Redis {
  return new Redis(REDIS_URL);
}
