-- Sprint 5 — Control Plane durable state (PRD v6.5 §24).

-- §24.2/§24.7 review_findings: persisted findings with retention columns.
-- Evidence and suggested_patch contain raw code and follow raw-data TTL
-- (HARD-RULE-047): the retention worker redacts them in place, preserving
-- non-identifying finding metadata (365d class).
CREATE TABLE IF NOT EXISTS review_findings (
  tenant_id        TEXT        NOT NULL,
  repo             TEXT        NOT NULL,
  pull_request_id  BIGINT      NOT NULL,
  run_id           UUID        NOT NULL,
  finding_id       TEXT        NOT NULL,
  severity         TEXT        NOT NULL,
  category         TEXT        NOT NULL,
  file             TEXT        NOT NULL,
  line             INT         NOT NULL,
  title            TEXT        NOT NULL,
  evidence         TEXT,
  recommendation   TEXT        NOT NULL,
  suggested_patch  TEXT,
  confidence       REAL        NOT NULL,
  agent_source     TEXT        NOT NULL,
  root_cause_id    TEXT        NOT NULL,
  root_cause_family TEXT       NOT NULL,
  taxonomy_version TEXT        NOT NULL,
  disposition      TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence_redacted_at TIMESTAMPTZ,
  suggested_patch_redacted_at TIMESTAMPTZ,
  contains_raw_code BOOLEAN    NOT NULL DEFAULT TRUE,
  PRIMARY KEY (run_id, finding_id)
);

CREATE INDEX IF NOT EXISTS review_findings_retention_scan
  ON review_findings (created_at)
  WHERE contains_raw_code;

-- §24.9 spend ledger: immutable accounting facts with tenant-scoped HMAC
-- pseudonyms only (HARD-RULE-024/025, FORBIDDEN-034/035). Authoritative
-- financial store is Postgres; ClickHouse analytics copy arrives with the
-- telemetry sprint.
CREATE TABLE IF NOT EXISTS spend_ledger (
  ledger_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        TEXT        NOT NULL,
  app_id           TEXT        NOT NULL,
  provider         TEXT        NOT NULL,
  model            TEXT        NOT NULL,
  model_tier       TEXT        NOT NULL,
  task_type        TEXT        NOT NULL,
  workflow_id      TEXT        NOT NULL,
  date_bucket      DATE        NOT NULL,
  token_input      BIGINT      NOT NULL,
  token_output     BIGINT      NOT NULL,
  cost_usd         NUMERIC(12,6) NOT NULL DEFAULT 0,
  hmac_repo_id     TEXT        NOT NULL,
  hmac_pull_request_id TEXT    NOT NULL,
  hmac_user_id     TEXT,
  hmac_run_id      TEXT        NOT NULL,
  hmac_trace_id    TEXT,
  hmac_key_id      TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spend_ledger_by_bucket
  ON spend_ledger (tenant_id, date_bucket);

-- §24.8 expungable identity map — the ONLY re-identification path
-- (FR-CP-024/028). Privacy expungement tombstones rows here while the
-- immutable ledger aggregates survive (FR-CP-025/026).
CREATE TABLE IF NOT EXISTS spend_ledger_identity_map (
  tenant_id        TEXT        NOT NULL,
  identity_type    TEXT        NOT NULL,
  raw_identifier_encrypted TEXT NOT NULL,
  hmac_identifier  TEXT        NOT NULL,
  hmac_key_id      TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ,
  expunged_at      TIMESTAMPTZ,
  expungement_request_id TEXT,
  PRIMARY KEY (tenant_id, identity_type, hmac_identifier)
);
