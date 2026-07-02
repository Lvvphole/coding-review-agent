/**
 * Runtime configuration with PRD v6.5 §10 defaults (id="default-config-v65").
 * File-based YAML config loading arrives with the config-precedence sprint;
 * Sprint 1 exposes the default values and env overrides needed by the slice.
 */

export interface BotConfig {
  databaseUrl: string;
  redisUrl: string;
  botLogin: string;
  review: {
    debounceSeconds: number;
    maxDebounceSeconds: number;
    maxInlineComments: number;
    confidenceThreshold: number;
    highSeverityConfidenceThreshold: number;
    requireDeterministicEvidenceForHighSeverity: boolean;
    skipDraftPrsByDefault: boolean;
    reviewBotAuthoredPrsByDefault: boolean;
  };
  context: {
    maxFiles: number;
    maxChangedLines: number;
    maxFileBytes: number;
    ignoreLockfilesByDefault: boolean;
    ignoreGeneratedFiles: boolean;
    ignoreMinifiedFiles: boolean;
    ignoreBinaryFiles: boolean;
  };
  webhookIdempotency: {
    ttlHours: number;
  };
  pendingPosts: {
    lockTtlSeconds: number;
    maxRetries: number;
    expireAfterHours: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  return {
    databaseUrl:
      env['DATABASE_URL'] ?? 'postgres://review_bot:review_bot_dev@localhost:5433/review_bot',
    redisUrl: env['REDIS_URL'] ?? 'redis://localhost:6380',
    botLogin: env['BOT_LOGIN'] ?? 'agentic-ai-review-bot',
    review: {
      debounceSeconds: 30,
      maxDebounceSeconds: 120,
      maxInlineComments: 10,
      confidenceThreshold: 0.8,
      highSeverityConfidenceThreshold: 0.9,
      requireDeterministicEvidenceForHighSeverity: true,
      skipDraftPrsByDefault: true,
      reviewBotAuthoredPrsByDefault: false,
    },
    context: {
      maxFiles: 40,
      maxChangedLines: 1200,
      maxFileBytes: 80000,
      ignoreLockfilesByDefault: true,
      ignoreGeneratedFiles: true,
      ignoreMinifiedFiles: true,
      ignoreBinaryFiles: true,
    },
    webhookIdempotency: {
      ttlHours: 24,
    },
    pendingPosts: {
      lockTtlSeconds: 120,
      maxRetries: 3,
      expireAfterHours: 24,
    },
  };
}
