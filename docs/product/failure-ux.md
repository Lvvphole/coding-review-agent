# LimeReview — Failure UX

> Public failure messages must explain what happened, what LimeReview did safely, and what the user can do next.

LimeReview defaults to **safe silence over unsafe output** (HARD-RULE-UX-006): when a review cannot be safely validated or posted, nothing is posted, and the user gets a plain-language explanation — never an internal infrastructure error (HARD-RULE-UX-005).

## Public-Facing Failure States

### Draft PR

```text
LimeReview skipped this PR because it is still a draft.
Mark it ready for review when you want feedback.
```

*Backed by:* draft PRs skipped by default; `ready_for_review` triggers review (HARD-RULE-041, FR-GH-056/057).

### Newer commit detected

```text
LimeReview detected a newer commit and restarted review on the latest version.
Older review output was discarded to avoid stale comments.
```

*Backed by:* run supersession + latest-SHA/run-epoch posting guard against a durable authority (HARD-RULE-001/032).

### GitHub rate limit

```text
GitHub temporarily limited review posting.
LimeReview saved the validated findings and will retry automatically.
```

*Backed by:* validated findings persist to the durable pending-post outbox **before** the run enters backoff; retries re-check freshness (HARD-RULE-014/015).

### PRD missing

```text
No PRD was found for this repo.
LimeReview will run a general code review, or you can add a PRD for requirement-aware review.
```

*Backed by:* the general-review fallback defined in [PRD Ingestion](prd-ingestion.md). (PRD ingestion is a defined product behavior; see that doc for status.)

### Cannot safely review

```text
LimeReview could not complete a safe review.
No comments were posted.
Try again, or switch to general review mode.
```

*Backed by:* fail-closed posting guard and validation gates — no partial or unverified output ever posts (HARD-RULE-010/033).

### AI review unavailable

```text
AI review is temporarily unavailable.
LimeReview did not post partial or unverified findings.
Try again later or run deterministic checks only.
```

*Backed by:* Gateway degraded mode fails closed (expired policy, exhausted quota, provider outage) rather than degrading into unverified posting (FORBIDDEN-010/012).

## Message Rules

- Every public message answers three questions: **what happened**, **what LimeReview did safely**, **what you can do next**.
- Internal identifiers (run epochs, fencing state, outbox rows, Gateway routes) appear only in advanced/admin surfaces, never in standard-user messages (HARD-RULE-UX-005).
- Safe silence beats unsafe output: a skipped review with a clear reason is always preferred over an unvalidated one (HARD-RULE-UX-006).

## Implementation

These messages are implemented in `apps/ci-review-bot/src/status/public-status.ts` and surfaced as the run's GitHub **check-run summary** by the executor: internal outcomes map to the plain-language messages above (`posted`, `no_issues`, `prd_missing`, `newer_commit`, `rate_limited`, `cannot_safely_review`, `ai_unavailable`), the conclusion is never `failure` (§23.3 — AI review does not block merge), and every standard-surface summary is checked against a leak guard (`containsInternalIdentifier`) so run epochs, fencing state, outbox rows, Gateway routes, SHAs, and raw internal errors never reach the user (HARD-RULE-UX-005). Proven in `tests/unit/public-status.test.ts` and `tests/integration/public-status.test.ts`.
