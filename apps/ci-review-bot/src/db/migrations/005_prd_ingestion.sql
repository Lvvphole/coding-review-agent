-- Sprint 8 — PRD ingestion & requirement-aware review (PRD v6.5 §16, HARD-RULE-UX-004).
-- Two tables:
--   prd_sources  — per-repo PRD source config; upload/paste raw text is
--                  retention-bounded (expires_at) and expungable (FR-PRIV,
--                  HARD-RULE-022/023/047).
--   prd_criteria — content-addressed extraction cache. The key is a pure
--                  function of (tenant, repo, source_ref, PRD content hash,
--                  extraction model version, taxonomy version), so a PM edit
--                  changes the hash -> cache miss -> re-extract, and an
--                  unchanged PRD is a cache hit. Same discipline as
--                  exact_cache:{commit}:{diff}:{agent} (§25.1). Concurrent
--                  first-runs collapse via ON CONFLICT DO NOTHING + temp=0.

CREATE TABLE IF NOT EXISTS prd_sources (
  tenant_id    TEXT        NOT NULL,
  repo         TEXT        NOT NULL,
  source_kind  TEXT        NOT NULL
    CHECK (source_kind IN ('repo_path', 'link', 'upload', 'paste')),
  source_ref   TEXT        NOT NULL,          -- repo path, URL, or upload id
  content      TEXT,                          -- inlined raw text for upload/paste
  content_hash TEXT,
  expires_at   TIMESTAMPTZ,                   -- raw-content retention TTL (NULL = repo-resident)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, repo)
);

CREATE TABLE IF NOT EXISTS prd_criteria (
  criteria_key       TEXT        NOT NULL PRIMARY KEY,  -- sha256 of the key tuple
  tenant_id          TEXT        NOT NULL,
  repo               TEXT        NOT NULL,
  source_ref         TEXT        NOT NULL,
  content_hash       TEXT        NOT NULL,
  extraction_version TEXT        NOT NULL,
  taxonomy_version   TEXT        NOT NULL,
  criteria           JSONB       NOT NULL,
  truncated          BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Expungement / retention targets (HARD-RULE-047): find a tenant's PRD data.
CREATE INDEX IF NOT EXISTS prd_criteria_by_tenant_repo ON prd_criteria (tenant_id, repo);
