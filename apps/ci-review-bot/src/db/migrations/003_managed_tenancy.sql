-- Sprint 6 — Managed tenant & installation lifecycle (PRD v6.5 §24.2, §7.3).
-- Managed mode: one GitHub App, tenant = installation. An install provisions a
-- tenant + its selected repositories; repo→tenant resolution replaces the
-- env-var stub. Multi-tenant scoping per HARD-RULE-026; unresolved repo fails
-- closed (FR-TENANT-013).

-- §24.2 tenants: one row per GitHub App installation.
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT        NOT NULL PRIMARY KEY,   -- 'inst_<installation_id>'
  installation_id  BIGINT      NOT NULL UNIQUE,
  org              TEXT        NOT NULL,
  account_type     TEXT        NOT NULL DEFAULT 'Organization',
  status           TEXT        NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- §24.2 repositories: the repo→tenant resolution authority (FR-TENANT-012).
-- One row per repo the installation selected; `active` flips on
-- installation_repositories add/remove without losing history.
CREATE TABLE IF NOT EXISTS repositories (
  repo_full_name   TEXT        NOT NULL PRIMARY KEY,   -- 'org/name'
  tenant_id        TEXT        NOT NULL REFERENCES tenants(tenant_id),
  installation_id  BIGINT      NOT NULL,
  repo_id          BIGINT,
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS repositories_by_tenant ON repositories (tenant_id);
