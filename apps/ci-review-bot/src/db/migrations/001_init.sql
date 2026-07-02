-- Sprint 1 durable state — PRD v6.5 §24.
-- Postgres is the durable authority for run fencing (HARD-RULE-032,
-- FR-FENCE-011), webhook delivery idempotency (FR-GH-026/027), pending posts
-- (HARD-RULE-015/016), and integration status.

-- §24.3 review_runs: durable fencing authority.
CREATE TABLE IF NOT EXISTS review_runs (
  tenant_id        TEXT        NOT NULL,
  repo             TEXT        NOT NULL,
  pull_request_id  BIGINT      NOT NULL,
  run_id           UUID        NOT NULL PRIMARY KEY,
  head_sha         TEXT        NOT NULL,
  run_epoch        BIGINT      NOT NULL,
  status           TEXT        NOT NULL,
  is_current       BOOLEAN     NOT NULL DEFAULT TRUE,
  current_state_authority_version BIGINT NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at     TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  stale_discarded_at TIMESTAMPTZ
);

-- FR-PRC-002: only one current active run per tenant + repo + PR.
CREATE UNIQUE INDEX IF NOT EXISTS review_runs_one_current
  ON review_runs (tenant_id, repo, pull_request_id)
  WHERE is_current;

-- FR-FENCE-016: run_epoch monotonic per tenant + repo + PR, tracked durably.
CREATE TABLE IF NOT EXISTS pr_fencing_state (
  tenant_id        TEXT   NOT NULL,
  repo             TEXT   NOT NULL,
  pull_request_id  BIGINT NOT NULL,
  current_head_sha TEXT   NOT NULL,
  current_run_epoch BIGINT NOT NULL,
  current_run_id   UUID   NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, repo, pull_request_id)
);

-- §24.4 github_webhook_deliveries: durable delivery authority (FR-GH-026..032).
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  tenant_id        TEXT        NOT NULL,
  delivery_id      TEXT        NOT NULL,
  payload_hash     TEXT        NOT NULL,
  event_type       TEXT        NOT NULL,
  repo             TEXT        NOT NULL,
  pull_request_id  BIGINT,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  first_seen_trace_id TEXT,
  duplicate_count  INT         NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL
    CHECK (status IN ('ACCEPTED', 'DUPLICATE_IGNORED', 'HASH_MISMATCH_BLOCKED', 'EXPIRED')),
  PRIMARY KEY (tenant_id, delivery_id)
);

-- §24.5 pending_review_posts: durable outbox (FR-POST-036..053).
CREATE TABLE IF NOT EXISTS pending_review_posts (
  pending_post_id  UUID        NOT NULL PRIMARY KEY,
  tenant_id        TEXT        NOT NULL,
  repo             TEXT        NOT NULL,
  pull_request_id  BIGINT      NOT NULL,
  run_id           UUID        NOT NULL,
  run_epoch        BIGINT      NOT NULL,
  head_sha         TEXT        NOT NULL,
  finding_ids      TEXT[]      NOT NULL,
  comment_payload  JSONB       NOT NULL,
  posting_strategy TEXT        NOT NULL DEFAULT 'batched_review',
  post_status      TEXT        NOT NULL DEFAULT 'PENDING'
    CHECK (post_status IN ('PENDING','BACKOFF','POSTING','POSTED','STALE_DISCARDED','FAILED','CANCELLED','BLOCKED')),
  retry_count      INT         NOT NULL DEFAULT 0,
  next_retry_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  github_retry_after TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  idempotency_key  TEXT        NOT NULL,
  comment_fingerprint TEXT     NOT NULL,
  worker_id        TEXT,
  locked_at        TIMESTAMPTZ,
  lock_expires_at  TIMESTAMPTZ,
  claim_attempt_count INT      NOT NULL DEFAULT 0,
  github_comment_id TEXT,
  posted_at        TIMESTAMPTZ,
  last_error_code  TEXT,
  last_error_message TEXT
);

CREATE INDEX IF NOT EXISTS pending_review_posts_claim_scan
  ON pending_review_posts (next_retry_at)
  WHERE post_status IN ('PENDING', 'BACKOFF');

CREATE INDEX IF NOT EXISTS pending_review_posts_by_pr
  ON pending_review_posts (tenant_id, repo, pull_request_id);

-- §24.6 github_installations: integration severance state (FR-GH-019/020).
CREATE TABLE IF NOT EXISTS github_installations (
  tenant_id        TEXT        NOT NULL,
  installation_id  BIGINT      NOT NULL,
  org              TEXT        NOT NULL,
  repo_scope       TEXT[]      NOT NULL DEFAULT '{}',
  status           TEXT        NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED','TOKEN_REFRESH_FAILED','INSTALLATION_NOT_FOUND','REAUTH_REQUIRED')),
  status_reason    TEXT,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reauth_required  BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, installation_id)
);
