<p align="center">
  <img src="./docs/assets/lime-review-dashboard.png" alt="LimeReview AI code review dashboard" width="100%" />
</p>

# Agentic AI CI Code Review Bot

[![CI](https://github.com/Lvvphole/coding-review-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Lvvphole/coding-review-agent/actions/workflows/ci.yml) ![Status](https://img.shields.io/badge/status-sprint%205%20complete-blue) ![Node](https://img.shields.io/badge/node-%3E%3D22-3c873a) ![pnpm](https://img.shields.io/badge/pnpm-10.33-f69220) ![TypeScript](https://img.shields.io/badge/TypeScript-5.7%20strict-3178c6) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791) ![Redis](https://img.shields.io/badge/Redis-7-dc382d)

A production-grade pull-request review system implementing the **Agentic AI CI Code Review Bot PRD v6.5**. It is not an LLM wrapper: it is a deterministic CI workflow with controlled agentic review, durable Postgres fencing, edge webhook idempotency, distributed pending-post locking, and validated-only GitHub posting.

> Agents may generate findings. Agents may not post findings. No finding posts without schema, evidence, line-mapping, confidence, and taxonomy validation — plus a latest-SHA + run-epoch guard checked against a durable authority.

## Overview

When a pull request is opened or updated, the bot verifies and deduplicates the webhook at the edge, coalesces rapid pushes, and runs specialized reviewer agents (diff correctness, security) against a deterministically filtered diff context. Every candidate finding is validated after the LLM, deduplicated deterministically, redacted for secrets, and posted as a single batched GitHub review — but only if the PR head SHA and run epoch still match the durable fencing state at post time. Stale runs are discarded, never posted.

## Table of Contents

- [Why It Exists](#why-it-exists)
- [Key Features](#key-features)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Command Reference](#command-reference)
- [Testing](#testing)
- [Data & Security Invariants](#data--security-invariants)
- [Project Structure](#project-structure)
- [Roadmap & Status](#roadmap--status)
- [Docs](#docs)
- [License](#license)

## Why It Exists

| Production truth | Consequence in this system |
|---|---|
| Developers push commits quickly | Debounce + supersession: only the latest head SHA may produce comments |
| Webhook deliveries duplicate and race | Edge idempotency with a durable Postgres delivery record that survives Redis loss |
| GitHub throttles, fails, and revokes auth | Durable pending-post outbox; integration severance never enters rate-limit backoff |
| Pods restart and race each other | `SELECT … FOR UPDATE SKIP LOCKED` row claims; pending posts recover on startup |
| Redis restarts and evicts hot keys | Postgres is the correctness authority; Redis is cache and scheduling only |
| LLMs hallucinate, duplicate, and overstate | Post-LLM validators, deterministic-first dedupe, deterministic evidence required for high severity |
| GitHub has no comment idempotency keys | Bot markers + HMAC comment fingerprints with read-before-retry reconciliation |

## Key Features

- **Durable fencing** — run identity (`head_sha`, `run_epoch`) lives in Postgres; the posting guard fails closed when durable state is unreadable (HARD-RULE-032/033).
- **Edge webhook idempotency** — Redis SETNX fast lock backed by a durable `github_webhook_deliveries` authority; payload-hash mismatches fail closed (HARD-RULE-027/034).
- **Distributed pending-post outbox** — rate-limited posts persist durably *before* the run enters backoff; execution requires an exclusive, expiring row claim (HARD-RULE-015/016/017).
- **Marker-based comment idempotency** — every comment embeds a structured marker with a tenant-scoped HMAC fingerprint; ambiguous retries scan before posting (HARD-RULE-035).
- **Outbound secret redaction** — every comment body passes secret scanning before POST, so a credential quoted in evidence is never republished (HARD-RULE-038).
- **Actor-loop prevention** — the bot ignores its own events; bot-authored and draft PRs are skipped by default, fork PRs are flagged elevated-risk (HARD-RULE-036/037/041/042).
- **Deterministic comment selection** — findings over the inline cap are ordered by severity → confidence → evidence strength → category → stable ID and overflow to the summary (HARD-RULE-043).
- **Gateway-only LLM access** — the bot holds no provider keys and speaks only the Gateway request contract (HARD-RULE-003/004/005).

## How It Works

```mermaid
flowchart TD
    A[GitHub webhook] --> B{Signature valid?<br/>Tenant resolved?}
    B -- no --> R1[Reject: fail closed]
    B -- yes --> C{Actor-loop check<br/>Draft/bot PR policy}
    C -- bot/draft --> R2[No-op accepted]
    C -- pass --> D{Delivery ID seen?<br/>Redis SETNX + Postgres}
    D -- duplicate --> R3[No-op: never touches run state]
    D -- new --> E[Debounce window<br/>latest SHA wins]
    E --> F[Run coordinator<br/>atomic epoch increment in Postgres]
    F --> G[Context engine<br/>reviewignore, lockfile/generated/binary filters,<br/>budget with high-risk priority]
    G --> H[Reviewer agents via LLM Gateway<br/>diff + security, all-settled]
    H --> I[Validators<br/>schema, line mapping, evidence,<br/>confidence, taxonomy]
    I --> J[Deterministic dedupe<br/>exact + line-overlap tiers]
    J --> K{Posting guard:<br/>durable SHA + epoch match?}
    K -- stale/missing --> R4[STALE_DISCARDED<br/>never posted]
    K -- pass --> L[Outbound secret redaction]
    L --> M[Batched GitHub review<br/>with marker + fingerprint]
    M -- rate limited --> N[(Durable pending post<br/>then backoff)]
    N --> K
    M -- success --> O[Post-flight stale check]
```

## Architecture

```mermaid
flowchart LR
    subgraph app["apps/ci-review-bot"]
        WH[Webhook handler]
        SM[State machine]
        CO[Run coordinator]
        OB[Pending-post outbox]
        PW[Posting workflow]
    end
    subgraph pkgs["packages/*"]
        CE[context-engine]
        AG[agent-core]
        VA[validators]
        LC[llm-client]
    end
    subgraph stores["Durable / hot state"]
        PG[(Postgres 16<br/>fencing authority,<br/>outbox, deliveries)]
        RD[(Redis 7<br/>debounce, fast locks)]
    end
    GH[GitHub App] --> WH
    WH --> CO --> SM
    CO --> PG
    WH --> RD
    WH --> PG
    SM --> CE --> AG --> VA --> PW
    AG --> LC --> GW[LLM Gateway<br/>apps/llm-gateway]
    PW --> OB --> PG
    PW --> GH
```

Postgres is the single correctness authority: run fencing, webhook deliveries, the pending-post outbox, and integration status all live there. Redis accelerates the hot path but is never trusted for posting decisions.

## Tech Stack

| Layer | Technology | Role |
|---|---|---|
| Runtime | Node.js ≥ 22, TypeScript 5.7 (strict, NodeNext ESM) | All services and packages |
| Monorepo | pnpm workspaces + `tsc -b` project references | `apps/*`, `packages/*` |
| Durable state | PostgreSQL 16 (`pg`) | Fencing, outbox, deliveries, installations |
| Hot-path state | Redis 7 / Valkey (`ioredis`) | Debounce, SETNX fast locks, scheduling |
| Testing | Vitest 3 | Unit + integration (real Postgres/Redis, serial) |
| Local infra | Docker Compose | `infra/docker-compose.yml` |
| LLM access | LLM Gateway service (`apps/llm-gateway`) | Signed policy, quota leases, provider dispatch; no provider keys in the bot |

## Getting Started

**Prerequisites:** Node ≥ 22, pnpm ≥ 10, Docker.

```bash
git clone https://github.com/Lvvphole/coding-review-agent.git
cd coding-review-agent
pnpm install
pnpm db:up            # Postgres on :5433, Redis on :6380
pnpm build
pnpm test             # unit tests
pnpm test:integration # integration tests against real stores
```

Run the webhook service locally:

```bash
GITHUB_WEBHOOK_SECRET=dev-secret TENANT_ID=tenant_local pnpm --filter @review-bot/ci-review-bot start
# POST /webhooks/github  |  GET /healthz
```

## Configuration

| Source | Purpose |
|---|---|
| `configs/review/default.review-bot.yaml` | Review defaults: debounce, comment caps, confidence thresholds, draft/bot-PR policy (PRD §10) |
| `configs/review/high-risk-paths.yaml` | High-risk path classification driving context priority (PRD §15.9) |
| `configs/apps/github-app.manifest.yaml` | Required GitHub App permissions and webhook subscriptions (PRD §11) |
| `schemas/review-finding.schema.json` | Strict finding contract (PRD §18) |

| Environment variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://review_bot:review_bot_dev@localhost:5433/review_bot` | Durable authority |
| `REDIS_URL` | `redis://localhost:6380` | Hot-path state |
| `GITHUB_WEBHOOK_SECRET` | — (required) | Tenant webhook verification |
| `TENANT_ID` / `TENANT_REPOS` | `tenant_default` / all | Tenant mapping stub |
| `BOT_LOGIN` | `agentic-ai-review-bot` | Actor-loop prevention identity |
| `PORT` | `8080` | HTTP listen port |

Repository-level config (`.github/review-bot.yml`, `.reviewignore`) may loosen noise controls but can never weaken security, fencing, idempotency, or durability rules (PRD §9.3).

## Command Reference

| Command | Description |
|---|---|
| `pnpm build` | Type-check and build all packages (`tsc -b`) |
| `pnpm test` | Unit tests (state machine, validators, dedupe, selection, redaction, context) |
| `pnpm test:integration` | Integration tests against real Postgres + Redis |
| `pnpm test:all` | Both suites |
| `pnpm db:up` / `pnpm db:down` | Start / destroy local Postgres + Redis |
| `pnpm db:migrate` | Apply SQL migrations |

## Testing

81 tests, all mapped to PRD v6.5 acceptance-test IDs.

| Suite | Count | Covers |
|---|---|---|
| `tests/unit/state-machine.test.ts` | 18 | T-series transitions, INVALID_MOVE, any-active-state severance/cancel/timeout, backoff gated on durable write (G31) |
| `tests/unit/validators-and-dedupe.test.ts` | 12 | V-series posting rules, deterministic-evidence rule, DEDUP series incl. head-SHA isolation |
| `tests/unit/context-engine.test.ts` | 6 | CTX series: filters, budget, high-risk priority, blocked-not-skipped oversized files |
| `tests/unit/marker-and-redaction.test.ts` | 9 | Fingerprint stability, marker round-trip, secret redaction |
| `tests/unit/comment-selection.test.ts` | 3 | HARD-RULE-043 deterministic ordering and overflow |
| `tests/integration/webhook-idempotency.test.ts` | 10 | GH-IDEMP series, Redis-loss survival, fail-closed signature/tenant paths, bot/draft/fork policy |
| `tests/integration/durable-fencing.test.ts` | 7 | Epoch monotonicity under concurrency, supersession, fail-closed guard |
| `tests/integration/pending-post-locking.test.ts` | 9 | PPOST series: claim races, expiry reclaim, close/severance cascades |
| `tests/integration/review-pipeline-e2e.test.ts` | 7 | Full slice: seeded finding → validated → posted with marker; duplicate retry; rate-limit durability; evidence redaction |

Integration tests run strictly serially against the compose stack (one shared database).

## Data & Security Invariants

> Cancellation saves cost. Fencing guarantees correctness. Redis may wake workers, but Postgres is the authority.

- Only the latest PR head SHA may produce review comments; the guard reads the **durable Postgres fencing authority** and fails closed when it is missing (HARD-RULE-001/032/033).
- Duplicate webhook deliveries are rejected at the edge; protection survives Redis restart (HARD-RULE-027/034); payload-hash mismatch on a known delivery ID fails closed and emits a security event.
- Pending posts persist durably before backoff; execution requires an unexpired exclusive row claim; multiple pods can never post the same row (FORBIDDEN-032).
- Comment idempotency never relies on (nonexistent) GitHub API idempotency keys (HARD-RULE-035).
- Every outbound comment passes secret scanning and redaction before POST (HARD-RULE-038).
- High/critical findings require deterministic evidence — an LLM verifier can reject or downgrade but never substitute for evidence (HARD-RULE-039).
- The CI bot never calls LLM providers directly and holds no provider keys (HARD-RULE-003/004/005).
- PR content is untrusted input: prompt injection in diffs cannot override system policy; fork PRs run under elevated-risk policy (HARD-RULE-042).

## Project Structure

```
agentic-ci-review-bot/
├── apps/
│   └── ci-review-bot/        # Webhook service: handlers, state machine, coordinator, outbox, workflows
│       └── src/db/migrations # Postgres schema (fencing, deliveries, outbox, installations)
├── packages/
│   ├── shared/               # Run/finding types, bot marker + HMAC comment fingerprint
│   ├── context-engine/       # Diff parser, deterministic filters, context budgeter
│   ├── validators/           # Schema/evidence/line-mapping validators, dedupe, selection, redaction
│   ├── agent-core/           # Reviewer agents, all-settled runner, stable prompt prefix
│   └── llm-client/           # Gateway request contract + deterministic stub
├── configs/                  # App manifest, review defaults, high-risk paths
├── schemas/                  # JSON Schema contracts
├── infra/                    # docker-compose (Postgres 16, Redis 7)
├── tests/                    # unit/ + integration/ suites
└── docs/                     # PRD evaluation, sprint records
```

## Roadmap & Status

| Sprint | Scope | Status |
|---|---|---|
| 1 | Core review path skeleton: webhook → fencing → context → agents (stub Gateway) → validators → posting with marker idempotency; docker-compose infra | **Complete** |
| 2 | Real GitHub boundary: App auth with token refresh, REST/GraphQL adapter, read-path backoff, durable run executor + posting worker, post-flight reconciliation actions, dry-run mode | **Complete** |
| 3 | LLM Gateway service: signed policy bundles, bit-masked routing, quota leases, metadata signing, Anthropic provider, embeddings endpoint | **Complete** |
| 4 | Context depth: Symbol Skeleton, high-risk chunking, language matrix, taxonomy compilation with alias mapping, YAML config loading, check-run reporter | **Complete** |
| 5 | Control Plane workers: run watchdog, retention cleanup with evidence redaction, HMAC-pseudonymized spend ledger + expungable identity map, privacy expungement | **Complete** |
| 6+ | Telemetry/event bus (ClickHouse), route compiler + policy canary, feedback ingestion, multi-tenant hardening, eval pipeline, admin dashboard | Planned |

Full deferral details per sprint live in [`docs/sprints/sprint-01.md`](docs/sprints/sprint-01.md).

## Docs

- [`docs/sprints/sprint-01.md`](docs/sprints/sprint-01.md) — delivered scope, PRD anchors, deferrals
- [`docs/prd-evaluation-v6.4.3.md`](docs/prd-evaluation-v6.4.3.md) — architecture evaluation that produced PRD v6.5
- PRD v6.5 — the governing build contract (§ references throughout the codebase)

## License

Not yet licensed. All rights reserved until a license is selected.
