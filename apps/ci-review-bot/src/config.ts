import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Runtime configuration with PRD v6.5 §10 defaults (id="default-config-v65").
 *
 * Config precedence: environment override > `configs/review/default.review-bot.yaml`
 * (the documented §10 default file) > built-in fallback. Loading the YAML makes
 * that file the single source of truth for the platform defaults; an absent or
 * malformed file falls back to the built-in values (fail safe — never guess).
 * Credentials and connection URLs are NEVER read from the file — env only.
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
    /** App-level webhook secret; managed mode verifies all deliveries with it. */
    webhookSecret: string;
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
  prd: {
    /** Single prd_extraction call budget; larger PRDs are chunked (map-reduce). */
    maxBytes: number;
    /** Cap on map chunks; over-budget PRDs keep the highest-priority head. */
    maxChunks: number;
  };
}

/** The subset of `default.review-bot.yaml` that maps onto BotConfig fields. */
interface DefaultConfigFile {
  review?: {
    debounce_seconds?: number;
    max_debounce_seconds?: number;
    max_inline_comments?: number;
    confidence_threshold?: number;
    high_severity_confidence_threshold?: number;
    require_deterministic_evidence_for_high_severity?: boolean;
    skip_draft_prs_by_default?: boolean;
    review_bot_authored_prs_by_default?: boolean;
  };
  context?: {
    max_files?: number;
    max_changed_lines?: number;
    max_file_bytes?: number;
    ignore_lockfiles_by_default?: boolean;
    ignore_generated_files?: boolean;
    ignore_minified_files?: boolean;
    ignore_binary_files?: boolean;
  };
  webhook_idempotency?: { ttl_hours?: number };
  pending_posts?: { lock_ttl_seconds?: number; max_retries?: number; expire_after_hours?: number };
}

/** Load the §10 default file, or {} when absent/malformed (fail safe). */
function loadDefaultsFile(configRoot: string): DefaultConfigFile {
  const path = join(configRoot, 'review/default.review-bot.yaml');
  if (!existsSync(path)) return {};
  try {
    return (parseYaml(readFileSync(path, 'utf8')) as DefaultConfigFile) ?? {};
  } catch {
    return {};
  }
}

/** Coerce an env string to a number, or undefined when unset/blank. */
function numEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  configRoot: string = env['CONFIG_ROOT'] ?? 'configs',
): BotConfig {
  const file = loadDefaultsFile(configRoot);
  const r = file.review ?? {};
  const c = file.context ?? {};
  const wi = file.webhook_idempotency ?? {};
  const pp = file.pending_posts ?? {};

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
      webhookSecret: env['GITHUB_WEBHOOK_SECRET'] ?? '',
      readMaxRetries: 3,
      refreshBeforeExpirySeconds: 300,
      maxRefreshRetries: 2,
    },
    // Precedence per field: env override > file default > built-in fallback.
    review: {
      debounceSeconds: numEnv(env['DEBOUNCE_SECONDS']) ?? r.debounce_seconds ?? 30,
      maxDebounceSeconds: r.max_debounce_seconds ?? 120,
      maxInlineComments: r.max_inline_comments ?? 10,
      confidenceThreshold: r.confidence_threshold ?? 0.8,
      highSeverityConfidenceThreshold: r.high_severity_confidence_threshold ?? 0.9,
      requireDeterministicEvidenceForHighSeverity:
        r.require_deterministic_evidence_for_high_severity ?? true,
      skipDraftPrsByDefault: r.skip_draft_prs_by_default ?? true,
      reviewBotAuthoredPrsByDefault: r.review_bot_authored_prs_by_default ?? false,
      dryRun: env['DRY_RUN'] === 'true',
    },
    context: {
      maxFiles: c.max_files ?? 40,
      maxChangedLines: c.max_changed_lines ?? 1200,
      maxFileBytes: c.max_file_bytes ?? 80000,
      ignoreLockfilesByDefault: c.ignore_lockfiles_by_default ?? true,
      ignoreGeneratedFiles: c.ignore_generated_files ?? true,
      ignoreMinifiedFiles: c.ignore_minified_files ?? true,
      ignoreBinaryFiles: c.ignore_binary_files ?? true,
    },
    webhookIdempotency: {
      ttlHours: wi.ttl_hours ?? 24,
    },
    pendingPosts: {
      lockTtlSeconds: pp.lock_ttl_seconds ?? 120,
      maxRetries: pp.max_retries ?? 3,
      expireAfterHours: pp.expire_after_hours ?? 24,
    },
    prd: {
      maxBytes: numEnv(env['PRD_MAX_BYTES']) ?? 24000,
      maxChunks: numEnv(env['PRD_MAX_CHUNKS']) ?? 8,
    },
  };
}
