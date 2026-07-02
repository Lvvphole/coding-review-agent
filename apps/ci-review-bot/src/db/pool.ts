import pg from 'pg';

export interface DbConfig {
  connectionString: string;
}

export function createPool(config: DbConfig): pg.Pool {
  return new pg.Pool({ connectionString: config.connectionString, max: 10 });
}

export type { Pool, PoolClient } from 'pg';
