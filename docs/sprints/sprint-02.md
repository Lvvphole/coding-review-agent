# Sprint 2 — Real GitHub Boundary

**Spec:** PRD v6.5. **Scope decision:** GitHub App auth, REST/GraphQL adapter, durable worker loops, dry-run mode. The LLM Gateway remains a stub (`StubGatewayClient`) — the Gateway-only seam (HARD-RULE-003/004/005) is unchanged.

## Delivered

| Component | PRD anchor | Notes |
|---|---|---|
| GitHub App auth (`adapters/github-app-auth.ts`) | HARD-RULE-040, FR-GH-033..039 | Hand-rolled RS256 App JWT (`node:crypto`, no new deps) → installation token exchange; proactive refresh at expiry−300s; hourly expiry never severs (FORBIDDEN-045); refresh failures classify to `REAUTH_REQUIRED`/`SUSPENDED`/`INSTALLATION_NOT_FOUND`/`REVOKED`/`TOKEN_REFRESH_FAILED` and persist to `github_installations` |
| REST adapter (`adapters/github-rest.adapter.ts`) | HARD-RULE-045, FR-GH-050..053, FR-POST-011/013/068 | Batched review POST; marker-filtered comment listing; PR head + diff reads; write-path 429/secondary-403 → `GitHubRateLimitError` (durable outbox before backoff), 401/403 → `GitHubIntegrationSeveredError` (never backoff, FORBIDDEN-037); read path bounded retries honoring retry-after; mid-flight 401 → one transparent token refresh + retry |
| GraphQL adapter (`adapters/github-graphql.adapter.ts`) | FR-POST-024/025 | `minimizeComment` mutation (minimization is GraphQL-only) |
| Post-flight reconciliation actions (`workflows/post-comments.workflow.ts` → `reconcileOrphanedComment`) | HARD-RULE-018/019, FR-POST-031..035 | reply_count 0 → minimize; >0 → `[Outdated Code State]` marker, thread preserved; unknown → preserve-not-delete |
| Run executor (`workers/run-executor.ts`) | FR-EXEC-001..006 | Replaces Sprint 1's in-process `setTimeout`: debounce due-window scan (Redis sorted set) → durable QUEUED runs in Postgres → full pipeline with per-step persisted state-machine transitions; read-path failure → FAILED/BLOCKED (FR-GH-053); PR close/merge cancels the run and cascades the outbox (FR-GH-045..049) |
| Posting worker (`workers/posting-worker.ts`) | HARD-RULE-016/017, FR-POST-039..063 | Claims via `SKIP LOCKED`, re-asserts ownership, executes through the marker-scan/guard flow, POSTED/BACKOFF/FAILED/BLOCKED/STALE transitions, startup recovery |
| Dry-run mode (`DRY_RUN=true`) | FR-SLO-008 | Full pipeline + guard, logs the would-be review, posts nothing — the shadow-onboarding path |
| Service wiring (`main.ts`) | FR-EXEC-001 | Executor + posting-worker interval loops; App auth or static token (local dev); webhook `closed` action now cancels + cascades |

## Tests (100 passing: 59 unit + 41 integration)

New this sprint:
- **Unit (11):** RS256 JWT structure verified against the public key; write-path error mapping (429/secondary-403 → rate limit, plain 403 → severance); read-path bounded retries and `GitHubReadError` exhaustion; `getReplyCount` null-on-failure; reconciliation RACE-002/003/004 + minimization-unavailable preservation.
- **Integration (8, fake GitHub HTTP server + real Postgres/Redis):** one-tick webhook→review e2e with marker verification; QUEUED-run restart recovery (FR-EXEC-006); dry-run posts nothing; 429 → durable PENDING before backoff → worker drains → exactly one review; lost-POSTED-write retry resolves via marker scan without duplicating; PR close cascades run + outbox; routine token expiry refreshes without severance (FORBIDDEN-045); 401 token exchange severs durably (FR-GH-036).

## Deliberate deferrals
1. **LLM Gateway service** (§19) — next sprint; the executor takes any `GatewayClient`.
2. **Check-run reporter** (§15.15) and `check_suite`/`workflow_run` ingestion for `wait_for_checks`.
3. **Run watchdog worker** (FR-RUN-001..005) — deadlines defined in `STATE_DEADLINES_SECONDS`, sweeper lands with Control Plane.
4. **YAML config loading** (high-risk paths + taxonomy are wired as empty defaults in `main.ts` until the config/taxonomy sprint; tests inject real values).
5. Symbol Skeleton / AST chunking, feedback ingestion, telemetry/event bus, multi-tenant hardening.

## Verification
```bash
pnpm build && pnpm test && pnpm test:integration   # 100/100
```
