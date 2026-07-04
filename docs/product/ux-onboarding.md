# LimeReview — UX Onboarding

> LimeReview is a GitHub-native agentic review app.
>
> For normal users, setup is app install, repo selection, PRD attachment, and review mode selection.
>
> For builders and enterprise teams, the repo also supports local development and self-hosted deployment with Postgres, Redis, durable webhook delivery records, pending-post recovery, and LLM Gateway routing.

The managed experience described here is the product's **intended default path**. This repository contains the platform implementation behind it; nothing below requires the user to touch that implementation.

## The Standard Flow

1. Create or select GitHub repo.
2. Install LimeReview GitHub App.
3. Select repo.
4. Add PRD.
5. Choose review mode.
6. Coding agent opens PR.
7. LimeReview reviews PR.
8. Coding agent fixes findings.
9. LimeReview re-reviews latest commit.
10. Merge when clean.

## Mental Model

LimeReview should feel like Grammarly for pull requests, but PRD-aware and safety-gated.

## The User Promise

```text
No stale comments.
No duplicate comments.
No bot loops.
No secret leaks.
No hallucinated high-severity claims.
No direct provider access.
No unsafe fallback posting.
No weak findings pretending to be facts.
```

Every line of that promise is backed by an implemented, test-proven platform guarantee (PRD v6.5):

| Promise | Platform guarantee |
|---|---|
| No stale comments | Latest-SHA + run-epoch posting guard against a durable authority (HARD-RULE-001/032/033) |
| No duplicate comments | Edge webhook idempotency + bot-marker fingerprints with read-before-retry (HARD-RULE-027/034/035) |
| No bot loops | Actor-loop prevention: the bot ignores its own events and bot-authored PRs (HARD-RULE-036/037) |
| No secret leaks | Outbound secret scanning + redaction on every comment body (HARD-RULE-038) |
| No hallucinated high-severity claims | High/critical findings require deterministic evidence; an LLM verifier can never substitute for it (HARD-RULE-039) |
| No direct provider access | All model calls go through the LLM Gateway; the review service holds no provider keys (HARD-RULE-003/004/005) |
| No unsafe fallback posting | Fail-closed posting guard; rate-limited posts persist durably before backoff (HARD-RULE-015/033) |
| No weak findings pretending to be facts | Schema, evidence, line-mapping, confidence, and taxonomy validation before any posting (HARD-RULE-010) |

## What Happens When a Coding Agent Opens a PR

1. LimeReview starts automatically when a PR is opened or updated.
2. Draft PRs are skipped by default.
3. Rapid coding-agent pushes are debounced.
4. Older review runs are discarded when a newer commit appears.
5. Only the latest PR head SHA can produce comments.
6. Findings are validated before posting.
7. Weak or unsafe findings are not posted.
8. Secrets are redacted or blocked before posting.
9. GitHub rate-limit failures are retried safely.
10. The user sees plain-language status, not internal infrastructure errors.

All ten behaviors map to implemented, tested platform code in this repository.

## UX Hard Rules

```text
HARD-RULE-UX-001: A standard user must not be required to clone the LimeReview repo, configure webhooks, run infrastructure, manage secrets, deploy workers, configure Postgres, configure Redis, or manually wire the LLM Gateway to use LimeReview on a GitHub repository.

HARD-RULE-UX-002: The default onboarding path must be GitHub App installation plus repository selection plus review mode selection.

HARD-RULE-UX-003: Repo-level configuration files are optional advanced controls, not required setup for first use.

HARD-RULE-UX-004: PRD ingestion must be first-class. The user must be able to upload, paste, link, or select a PRD, and LimeReview must convert it into review criteria automatically.

HARD-RULE-UX-005: Failure messages must describe the next safe action, not expose internal infrastructure unless the user is in advanced/admin mode.

HARD-RULE-UX-006: The product must default to safe silence over unsafe output. If LimeReview cannot safely validate or post a review, it must explain the plain-language reason and point to the next safe action.
```

These UX rules layer on top of — and never weaken — the PRD v6.5 production safety hard rules (§3).

## Related Product Docs

- [Review Modes](review-modes.md) — Light / Standard / Strict
- [PRD Ingestion](prd-ingestion.md) — upload, paste, select, link
- [Failure UX](failure-ux.md) — plain-language failure states
