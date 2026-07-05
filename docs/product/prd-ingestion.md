# LimeReview — PRD Ingestion

PRD ingestion is first-class (HARD-RULE-UX-004). LimeReview turns your product requirements into review criteria automatically, so reviews check not just "is this code correct?" but "does this code do what the PRD said it should?"

## Ways to Add a PRD

```text
Upload PRD
Paste PRD
Select PRD from repo
Link PRD path
```

- **Upload PRD** — drop a Markdown or PDF file during setup.
- **Paste PRD** — paste requirements text directly.
- **Select PRD from repo** — pick an existing file already in the repository.
- **Link PRD path** — point LimeReview at a path it should read on each review.

## Supported Repo Path Examples

```text
docs/prd/PRD.md
docs/prd/PRD.pdf
README.md
docs/spec.md
```

## What LimeReview Extracts

From the PRD, LimeReview derives review criteria across:

```text
requirements
acceptance criteria
risk areas
expected behavior
expected files or modules
test expectations
security expectations
out-of-scope items
```

These become the requirement-aware checks the reviewer agents apply, alongside the always-on bug, security, test, and maintainability checks.

## No PRD? General Review Fallback

> If no PRD is available, LimeReview should fall back to general code review mode and clearly tell the user that requirement-aware review is not active.

When no PRD is found, LimeReview still runs a full general code review (bugs, security, tests, maintainability) and surfaces the plain-language notice from [Failure UX](failure-ux.md):

```text
No PRD was found for this repo.
LimeReview will run a general code review, or you can add a PRD for requirement-aware review.
```

The safety guarantees (latest-SHA posting, validation before posting, secret redaction, Gateway-only access) apply identically whether or not a PRD is attached.

> PRD ingestion is implemented. Extraction routes through the LLM Gateway (`task_type: prd_extraction`) — no provider keys in the review service (HARD-RULE-003/004/005). Criteria are **content-addressed** (`apps/ci-review-bot/src/prd/prd-criteria.ts`): keyed by `(tenant, repo, source_ref, PRD content hash, extraction version, taxonomy version)` and resolved once at the PR head SHA, so an unchanged PRD is a cache hit and a PM edit re-extracts — no invalidation event. Oversized PRDs use a bounded map-reduce (per-chunk extraction + deterministic union; over-budget keeps the highest-priority head and flags truncation, never a silent drop). Criteria are injected as **dynamic per-run context** into the reviewer agents (never the stable prefix, HARD-RULE-021), and requirement-gap findings still pass every normal validation gate (HARD-RULE-031). Uploaded/pasted PRDs are retention-bounded and expungable (FR-PRIV). No PRD → general review. Proven in `tests/unit/prd-criteria.test.ts` and `tests/integration/prd-ingestion.test.ts`.
