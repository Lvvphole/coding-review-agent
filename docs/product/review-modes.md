# LimeReview — Review Modes

LimeReview offers three review modes. The user picks one at setup; it can be changed at any time.

**Default mode: Standard Review.**

## Light Review

- Lowest comment volume.
- Only obvious bugs, security risks, and severe test gaps.
- Best for fast iteration and early vibe-coding.

## Standard Review

- Default mode.
- Balanced PRD alignment, bug detection, security, tests, and maintainability.
- Best for normal coding-agent PRs.

## Strict Review

- Deepest mode.
- Stronger PRD alignment checks, security checks, test expectations, architectural consistency, and high-risk file review.
- Best before merge, release, or production deployment.

## How Modes Map to the Platform

Review mode is a user-facing preset over the platform's existing review controls (comment caps, confidence thresholds, style suppression, high-risk file handling). The safety floor is identical across all three modes — modes tune **volume and depth**, never the safety gates.

| Control | Light | Standard | Strict |
|---|---|---|---|
| Inline comment volume | Lowest | Balanced | Highest |
| Categories surfaced | Bugs, security, severe test gaps | + tests, maintainability, PRD alignment | + architecture, high-risk file deep review |
| PRD alignment checks | Light | Balanced | Strong |
| Confidence threshold to post | Higher (fewer, surer) | Standard | Standard |
| High-risk file chunked review | Yes | Yes | Yes (deepest) |

The following hold in **every** mode and are never relaxed (PRD v6.5 §3):

- Only the latest PR head SHA can produce comments (HARD-RULE-001).
- Findings are validated before posting; weak or unsafe findings are not posted (HARD-RULE-010).
- High/critical findings require deterministic evidence (HARD-RULE-039).
- Secrets are redacted or blocked before posting (HARD-RULE-038).
- All model access is Gateway-only; the review service holds no provider keys (HARD-RULE-003/004/005).

> Review modes are a defined product behavior. The tuning presets above describe the intended mapping onto the platform controls that already exist in this repository (`configs/review/`).
