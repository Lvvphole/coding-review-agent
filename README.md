# Agentic AI CI Code Review Bot

Implementation of the **Agentic AI CI Code Review Bot PRD v6.5** — a production-grade pull-request review system: deterministic CI workflow with controlled agentic review, durable Postgres fencing, edge webhook idempotency, distributed pending-post locking, and validated-only GitHub posting.

## Repository layout

```
apps/ci-review-bot/     Webhook service: run coordination, state machine, outbox, posting
packages/shared/        Run/finding types, bot comment marker + HMAC fingerprint
packages/context-engine/ Diff parsing, deterministic filters, context budgeting
packages/validators/    Schema/evidence/line-mapping validation, dedupe, selection, redaction
packages/agent-core/    Reviewer agents (Gateway-only), all-settled orchestration
packages/llm-client/    Gateway request contract client (stub Gateway in Sprint 1)
configs/                GitHub App manifest, review defaults, high-risk paths
schemas/                JSON Schemas (review finding contract)
infra/                  docker-compose for local Postgres + Redis
docs/                   PRD evaluation, sprint records
tests/                  unit + integration suites (integration needs Postgres/Redis)
```

## Development

Requires Node ≥ 22, pnpm, Docker (for local infra).

```bash
pnpm install
pnpm db:up               # Postgres on :5433, Redis on :6380
pnpm build
pnpm test                # unit tests
pnpm test:integration    # against real Postgres + Redis
```

## Non-negotiable invariants (PRD §3)

The correctness core implemented in Sprint 1:

- Only the latest PR head SHA may produce review comments; the posting guard checks the **durable Postgres fencing authority** and fails closed when it is unreadable (HARD-RULE-001/032/033).
- Duplicate webhook deliveries are rejected at the edge and the protection survives Redis loss (HARD-RULE-027/034).
- Pending posts are durably persisted before backoff and executed only under an exclusive `SELECT … FOR UPDATE SKIP LOCKED` claim (HARD-RULE-015/016/017).
- GitHub comment idempotency uses bot markers + read-before-retry, never nonexistent API idempotency keys (HARD-RULE-035).
- The bot ignores its own events and never reviews bot-authored or draft PRs by default (HARD-RULE-036/037/041).
- Every outbound comment passes secret redaction before POST (HARD-RULE-038).
- The CI bot never calls LLM providers directly and never holds provider keys (HARD-RULE-003/004/005).

See `docs/sprints/sprint-01.md` for delivered scope and deferrals, and `docs/prd-evaluation-v6.4.3.md` for the architecture evaluation that produced PRD v6.5.
