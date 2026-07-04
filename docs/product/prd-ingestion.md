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

> PRD ingestion is a defined product behavior. This repository's own origin is PRD-driven review criteria, and the extraction pipeline is the intended implementation of that surface.
