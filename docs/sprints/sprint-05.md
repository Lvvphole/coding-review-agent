# Sprint 5 — Control Plane Workers

**Spec:** PRD v6.5 §26–27, §21.2–21.3, §15.17. **Scope decision:** the hygiene/privacy loops with durable targets — run watchdog, retention cleanup, privacy-safe spend ledger, and targeted expungement. Event-bus-driven learning workers (route compiler, canary, feedback) remain deferred.

## Delivered

| Component | PRD anchor | Notes |
|---|---|---|
| `apps/control-plane` | §7.3, FR-CP-001/002 | Standing worker process (watchdog + retention on intervals); expungement executes on demand |
| Run watchdog (`run-watchdog.worker.ts`) | HARD-RULE-044, FR-RUN-001..005, FORBIDDEN-050 | Sweeps **durable** `review_runs` (never Redis) against `STATE_DEADLINES_SECONDS` (now in `@review-bot/shared`); stuck current → FAILED, superseded → STALE_DISCARDED, severed tenant → BLOCKED; guarded UPDATE only fires if the run is still stuck |
| Retention cleanup (`retention-cleanup.worker.ts`) | HARD-RULE-022/047, FR-PRIV-001/008/009/010, FR-CP-012 | Deletes expired webhook deliveries + pending posts; redacts finding `evidence`/`suggested_patch` in place after the raw-data TTL while metadata survives on the 365d class; idempotent |
| Privacy expungement (`privacy-expungement.worker.ts`) | HARD-RULE-023, FR-PRIV-011..020, FORBIDDEN-029/030/036 | Authorized + unambiguous targeting only (fails closed otherwise); identity-map tombstoning removes the re-identification path while immutable aggregates survive; run-scoped erasure for finding payloads |
| Spend ledger writer (`ci-review-bot/src/ledger/spend-ledger.ts`) | HARD-RULE-024/025, FR-CP-020..030, FORBIDDEN-034/035 | Tenant-scoped HMAC pseudonyms (tenant folded into material → LEDGER-002), versioned `hmac_key_id` rotation, AES-256-GCM-encrypted expungable identity map in a separate table; ledger rows carry zero plain identifiers |
| Findings persistence (`db/findings-store.ts` + migration 002) | §24.2/§24.7 | `review_findings` with retention columns; executor persists validated findings (failure never fails the run) |
| Token accounting | FR-CP-003 | Gateway usage flows through `AgentResult` → pipeline `tokenUsage` → ledger `recordUsage` in the executor |
| Migration `002_control_plane.sql` | §24 | `review_findings`, `spend_ledger` (Postgres-authoritative; ClickHouse analytics copy deferred), `spend_ledger_identity_map` |

## Tests (151 passing: 88 unit + 63 integration)
New (12): watchdog FAILED/STALE_DISCARDED/BLOCKED classification + deadline respect; retention delivery purge + evidence redaction with metadata survival + idempotency; LEDGER-001 (no raw identifiers in rows), LEDGER-002 (per-tenant HMAC divergence), LEDGER-003/006 (expungement tombstones mapping, aggregates survive), LEDGER-005 (key rotation via key_id); FR-PRIV-020 unauthorized/ambiguous fail-closed; PRIV-007 run-scoped erasure.

## Deliberate deferrals
1. Event bus + ClickHouse telemetry (ledger analytics copy, event schema registry).
2. Route compiler / policy canary / publisher workers (dev signer script remains until eval infra exists).
3. Feedback ingestion (needs review-comment webhook events).
4. Admin dashboard surface for expungement requests (worker function is the API for now).
5. Cost attribution per model/provider (ledger records gateway-aggregate usage until the Gateway emits per-request events over the bus).

## Verification
```bash
pnpm build && pnpm test && pnpm test:integration   # 151/151
```
