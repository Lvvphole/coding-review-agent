# Sprint 1 — Core Review Path Skeleton

**Spec:** PRD v6.5 (Agentic AI CI Code Review Bot). **Scope decision:** minimal vertical slice end-to-end; Gateway, Control Plane, Admin Dashboard, multi-tenant isolation, privacy/ledger, and eval pipeline deferred to later sprints.

## Delivered

### Infrastructure
- pnpm/TypeScript monorepo (`apps/*`, `packages/*`) following the PRD §8 tree.
- `infra/docker-compose.yml`: Postgres 16 + Redis 7 for local dev (`pnpm db:up`).
- Forward-only SQL migration runner; migration `001_init.sql` creates `review_runs`, `pr_fencing_state`, `github_webhook_deliveries`, `pending_review_posts`, `github_installations` (§24 columns).

### Correctness-critical components
| Component | PRD anchor | Notes |
|---|---|---|
| Durable fencing authority | HARD-RULE-032/033, FR-FENCE-011..020 | `pr_fencing_state` upsert with atomic epoch increment; posting guard fails closed on missing durable state |
| Webhook edge idempotency | HARD-RULE-027/034, FR-GH-012/026..032 | Redis SETNX fast lock + Postgres `github_webhook_deliveries` durable authority; payload-hash mismatch fails closed |
| Actor-loop prevention | HARD-RULE-036/037, FR-GH-040..044 | Bot events and bot-authored PRs rejected before coordination |
| Draft/fork handling | HARD-RULE-041/042, FR-GH-056..061 | Drafts skipped by default; `ready_for_review` triggers; forks flagged elevated-risk |
| State machine | §12.8, §12.9 | Table-driven, INVALID_MOVE on unlisted pairs, severance/cancel/timeout legal from any active state, backoff entry gated on durable pending-post write (G31) |
| Pending-post outbox | HARD-RULE-015/016/017, FR-POST-036..053 | `SELECT ... FOR UPDATE SKIP LOCKED` claim SQL, lock expiry reclaim, PR-close cascade, severance blocking |
| Comment idempotency | HARD-RULE-035, FR-POST-054..062 | Bot marker + tenant-HMAC `comment_fingerprint`; marker scan before ambiguous retry |
| Outbound secret redaction | HARD-RULE-038, FR-SEC-015..021 | Every comment body scanned/redacted before POST |
| Deterministic comment selection | HARD-RULE-043, FR-POST-064..067 | severity → confidence → evidence strength → category → finding_id |
| Context engine | FR-CTX-001..012, FR-CTX-023 | Diff parser, `.reviewignore`, generated/lockfile/minified/binary filters, budget with high-risk prioritization; oversized high-risk files blocked-not-skipped |
| Validators | §18 posting rules, HARD-RULE-039 | Schema, line-mapping, deterministic-evidence, confidence, taxonomy dispositions |
| Deterministic dedupe (tiers 1–2) | §17 | Exact + ≥50% line-overlap merge; head_sha isolation; AST/embedding tiers deferred |
| Agents | FR-AGENT-002/003/007..012 | Diff + Security reviewers via Gateway client only (stub Gateway in this sprint); all-settled isolation |

### Tests (81 passing)
- **Unit (48):** state machine T-series incl. every-active-state severance/cancel; comment selection determinism; marker/fingerprint stability; redaction; validators V-series; dedupe DEDUP series; context CTX series.
- **Integration (33, real Postgres + Redis):** GH-IDEMP series incl. Redis-loss survival; durable fencing C-series incl. concurrent-start epoch monotonicity; PPOST claim races (3 workers → 1 claim), lock expiry reclaim, close/severance cascades; end-to-end pipeline (stub gateway → validated finding → batched review with marker → duplicate-retry returns `already_posted`; rate limit → durable PENDING row before backoff; secret evidence redacted from posted bodies).

## Deliberate deferrals (next sprints)
1. **LLM Gateway service** (§19): signed metadata, routing, quota leases, providers, embeddings endpoint. Bot already speaks the §19.2 contract via `GatewayClient`.
2. **Posting worker loop + GitHub REST/GraphQL adapter**: real `github.adapter.ts`/`github-graphql.adapter.ts` (token refresh per HARD-RULE-040, read-path backoff per HARD-RULE-045, reply-count preservation, minimization).
3. **Post-flight reconciliation actions** (delete/minimize/preserve): detection is wired; actions need the GraphQL adapter.
4. **Run watchdog worker** (FR-RUN-001..005): `STATE_DEADLINES_SECONDS` defined; worker lands with Control Plane sprint.
5. **Symbol Skeleton + AST chunking** (FR-CTX-015..031, §15.10), taxonomy compilation, debounce scheduler hardening (replace in-process `setTimeout` with durable queue per FR-EXEC-002), check-run reporter, feedback ingestion, telemetry/event bus.

## Verification
```bash
pnpm install
pnpm db:up          # Postgres :5433, Redis :6380 (docker compose)
pnpm build          # tsc -b, strict
pnpm test           # 48 unit tests
pnpm test:integration  # 33 integration tests against real stores
```
