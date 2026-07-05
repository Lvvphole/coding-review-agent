-- Sprint 10 — Onboarding / Admin surface (PRD v6.5 §7, FR-SLO-008/009, HARD-RULE-UX-001..004).
-- Adds the two pieces of durable state the admin API needs over the existing
-- substrate:
--   repositories.shadow_mode — FR-SLO-008: a newly provisioned repo starts in
--     shadow (dry-run) so the very first reviews are guard-checked but never
--     posted; an admin explicitly activates real posting. shadow only ever
--     SUPPRESSES posting, so it can never weaken a safety gate (§3).
--   expungement_requests      — HARD-RULE-047 / FR-PRIV: an auditable record of
--     a tenant/repo raw-data expungement requested through the admin surface.

-- FR-SLO-008: safe first-repo default. Existing rows are backfilled to FALSE so
-- already-onboarded repos keep posting; new installs default to shadow=TRUE.
-- ADD COLUMN backfills every existing row to TRUE; the UPDATE then flips those
-- already-provisioned repos to FALSE (they predate this migration), leaving the
-- DEFAULT TRUE to apply only to repos provisioned from here on.
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS shadow_mode BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE repositories SET shadow_mode = FALSE WHERE created_at < now();

-- HARD-RULE-047: auditable expungement requests from the admin surface. The
-- actual raw-data purge runs in the same transaction that inserts the row;
-- `detail` records the counts (prd sources/criteria purged, identities
-- tombstoned) without holding any raw content.
CREATE TABLE IF NOT EXISTS expungement_requests (
  request_id    TEXT        NOT NULL PRIMARY KEY,
  tenant_id     TEXT        NOT NULL,
  repo          TEXT,                             -- NULL = tenant-wide
  scope         TEXT        NOT NULL DEFAULT 'prd',
  requested_by  TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'COMPLETED'
    CHECK (status IN ('COMPLETED', 'PENDING', 'FAILED')),
  detail        JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expungement_requests_by_tenant
  ON expungement_requests (tenant_id, created_at);
