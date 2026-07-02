import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const aliases = {
  '@review-bot/shared': resolve(import.meta.dirname, 'packages/shared/src/index.ts'),
  '@review-bot/validators': resolve(import.meta.dirname, 'packages/validators/src/index.ts'),
  '@review-bot/context-engine': resolve(import.meta.dirname, 'packages/context-engine/src/index.ts'),
  '@review-bot/agent-core': resolve(import.meta.dirname, 'packages/agent-core/src/index.ts'),
  '@review-bot/llm-client': resolve(import.meta.dirname, 'packages/llm-client/src/index.ts'),
};

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: aliases },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // Real Postgres + Redis via infra/docker-compose.yml. Test files
          // share one database, so they must run strictly serially.
          hookTimeout: 60_000,
          testTimeout: 30_000,
          fileParallelism: false,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
