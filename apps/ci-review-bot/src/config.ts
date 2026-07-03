/**
 * Runtime configuration with PRD v6.5 §10 defaults (id="default-config-v65").
 * File-based YAML config loading arrives with the config-precedence sprint;
 * Sprint 1 exposes the default values and env overrides needed by the slice.
 */

export interface BotConfig {
  databaseUrl: string;
  redisUrl: string;
  botLogin: string;
  github: {
    apiBaseUrl: string;
    appId: string;
    /** PEM private key; empty means GitHub auth is not configured (dry paths only). */
    privateKeyPem: string;
    installationId: number;
    org: string;
    readMaxRetries: number;
    refreshBeforeExpirySeconds: number;
    maxRefreshRetries: number;
  };
  review: {
    debounceSeconds: number;
    maxDebounceSeconds: number;
    maxInlineComments: number;
    confidenceThreshold: number;
    highSeverityConfidenceThreshold: number;
    requireDeterministicEvidenceForHighSeverity: boolean;
    skipDraftPrsByDefault: boolean;
    reviewBotAuthoredPrsByDefault: boolean;
    /** FR-SLO-008 shadow mode: full pipeline, nothing posted. */
    dryRun: boolean;
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
    github: {
      apiBaseUrl: env['GITHUB_API_BASE_URL'] ?? 'https://api.github.com',
      appId: env['GITHUB_APP_ID'] ?? '',
      privateKeyPem: env['GITHUB_APP_PRIVATE_KEY'] ?? '',
      installationId: Number(env['GITHUB_INSTALLATION_ID'] ?? 0),
      org: env['GITHUB_ORG'] ?? '',
      readMaxRetries: 3,
      refreshBeforeExpirySeconds: 300,
      maxRefreshRetries: 2,
    },
    review: {
      debounceSeconds: Number(env['DEBOUNCE_SECONDS'] ?? 30),
      maxDebounceSeconds: 120,
      maxInlineComments: 10,
      confidenceThreshold: 0.8,
      highSeverityConfidenceThreshold: 0.9,
      requireDeterministicEvidenceForHighSeverity: true,
      skipDraftPrsByDefault: true,
      reviewBotAuthoredPrsByDefault: false,
      dryRun: env['DRY_RUN'] === 'true',
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
