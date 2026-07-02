# Architecture Evaluation — Agentic AI CI Code Review Bot PRD v6.4.3

**Scope:** Assessment of the system design and architecture in `Agentic_AI_CI_Code_Review_Bot_PRD_v6.4.3` for (1) internal contradictions, (2) missing hard rules, (3) inaccurate or under-pinned tech stack, (4) missing components.
**Method:** Full-document review (59 pages) with every finding cited against a PRD rule/requirement/test ID. Every citation was re-verified against the source text before publication.

---

## Verdict

The PRD is far above average for an AI-generated spec: the fencing model (head SHA + run_epoch), durable Postgres outbox with `SELECT ... FOR UPDATE SKIP LOCKED` claims, edge webhook idempotency, integration-severance handling, deterministic-first dedupe, and HMAC-pseudonymized spend ledger are all correct patterns, correctly motivated, and unusually well test-matrixed (§30–31).

It is **not implementation-ready as claimed** ("Locked for engineering implementation", §0). It contains:

- **10 internal contradictions**, two of which (A1, A2) break the document's own core safety guarantees;
- **8 missing hard rules**, including one open security hole (B3: secrets can be re-posted to the PR);
- **8 tech-stack inaccuracies**, including a load-bearing assumption GitHub's API does not support (C1);
- **10 missing components** a coding agent cannot infer, starting with the GitHub App permission/event manifest (D1).

A coding agent following this contract literally would build a system that violates HARD-RULE-001 under Redis eviction (A1) and blocks all tenants hourly (C3).

### Scorecard

| Dimension | Grade | Summary |
|---|---|---|
| Concurrency & staleness safety | B+ | Right design; fencing authority left in evictable Redis (A1) |
| State machine rigor | B− | Strong matrix; event double-use, unreachable transitions, status mismatch (A2, A4, A8) |
| GitHub integration accuracy | C | Idempotency-key and token-expiry semantics don't match GitHub's API (C1–C4) |
| LLM governance (Gateway/policy/evals) | A− | Best section; embeddings path unspecified (C7) |
| Privacy & ledger | B+ | Sophisticated; findings-evidence retention contradiction (A7) |
| Security | B | Inbound path solid; outbound comment path unscanned (B3), fork/bot-actor rules absent (B2, B5) |
| Completeness as build contract | C+ | Orphaned tree components, no App manifest, no SLOs, no execution-model decision (A9, D1, D6, D10) |

---

## A. Internal Contradictions and Spec Bugs

### A1 — Fencing/coordination state lives only in evictable Redis (Critical)
**Cites:** FR-PRC-007 ("Current PR state is stored in Redis / Valkey"), FR-FENCE-003 ("Before posting, read current PR state"), production truth #7 ("Redis can restart or evict hot-path keys"), HARD-RULE-017.
The PRD makes Postgres the durable authority for pending posts *because* Redis can evict (truths #7–8), but leaves the correctness-critical state — `pr:current`, `run_epoch`, `pr:lock`, webhook idempotency keys (§25.1) — Redis-only. If Redis restarts mid-run, the posting guard (G4/G5, §11.7) has nothing to compare against and `run_epoch` monotonicity (FR-FENCE-002) can silently reset, breaking HARD-RULE-001. The behavior of the posting guard when `pr:current:*` is **missing** is unspecified — an implementer can legally fail open.
**Fix:** Mirror run identity (`run_id`, `head_sha`, `run_epoch`, status) into the existing `review_runs` Postgres table as the fencing authority (Redis as cache), and add a hard rule: *posting guard fails closed (STALE_DISCARDED) when current PR state cannot be read from the durable store*. Same treatment for webhook delivery IDs (see B1).

### A2 — FR-GH-021 requires a pending-post status that does not exist (High)
**Cites:** FR-GH-021 ("Pending posts for a severed integration must transition to BLOCKED or CANCELLED"), §12.2 (allowed `post_status` values: `PENDING BACKOFF POSTING POSTED STALE_DISCARDED FAILED CANCELLED`).
`BLOCKED` is not an allowed `pending_review_posts.post_status`. Either add `BLOCKED` to §12.2 (correct — FR-GH-025 expects stale pending posts to survive reactivation, which `CANCELLED` forecloses) or rewrite FR-GH-021.

### A3 — Duplicate-webhook state test contradicts edge idempotency (High)
**Cites:** T-003 ("RECEIVED + EVT_DUPLICATE_WEBHOOK_IGNORED → COMPLETED/no-op") vs HARD-RULE-027 / FORBIDDEN-026 (duplicates rejected "at the edge before PR run coordination").
If duplicates are rejected at the edge, no `PRReviewRun` exists to transition — T-003 tests a state transition on an object the hard rules forbid creating. Delete T-003's run transition; assert instead that no run is created and `github.webhook.duplicate_ignored` is emitted (matches GH-IDEMP-002).

### A4 — Event double-use makes the state machine ambiguous (High)
**Cites:** T-008 ("QUEUED + EVT_CONTEXT_READY → CONTEXT_PREPARING") and T-009 ("CONTEXT_PREPARING + EVT_CONTEXT_READY → GATEWAY_REQUESTING"); T-012 and T-015 both consume `EVT_AGENTS_DONE`.
The same event drives two consecutive transitions, so a duplicated or replayed event legally skips a state — in a spec that elsewhere mandates idempotency keys on every event (§26). Introduce distinct events (`EVT_RUN_DEQUEUED`, `EVT_AGGREGATION_DONE`); QUEUED→CONTEXT_PREPARING should be triggered by dequeue, not by context readiness that hasn't started.

### A5 — Final Verifier violates HARD-RULE-031 (High)
**Cites:** Posting rule 3 (§17: "high or critical severity requires deterministic evidence **or Final Verifier approval**") vs HARD-RULE-031 ("may not use probabilistic tools as the final authority for correctness [or] posting").
The Final Verifier is an LLM agent (`final-verifier.agent.ts`). Allowing its approval to substitute for deterministic evidence makes a probabilistic tool the final posting authority for the highest-severity findings — exactly what HARD-RULE-031 forbids. Restrict the verifier to reject/downgrade authority only; high/critical posting requires deterministic evidence, full stop.

### A6 — Routing table targets tasks no component produces (Medium)
**Cites:** §20 rows "PR summary", "Architecture review", "Comment formatting" vs the agent roster (§14.10, `packages/agent-core`: Planner, Diff, Security, Test, Maintainability, Style, Final Verifier).
Three routed task types have no producing agent or workflow. Either add the agents (a Summary/Formatter step plausibly exists implicitly — grouped summary comments are in scope §6.1 #57) or remove the rows. As written, the route compiler compiles dead routes and the coding agent must guess.

### A7 — Findings retention contradicts raw-data retention (Medium)
**Cites:** §10.11 (`raw_diffs_days: 30`, `review_findings_days: 365`), §17 (`evidence` is a required finding field), FR-PRIV-012 (expungement targets omit findings), FR-PRIV-013.
`evidence` and `suggested_patch` are verbatim source-code fragments — raw PR data by the PRD's own definition (HARD-RULE-022) — yet they persist 335 days beyond the raw-diff TTL and are not an enumerated expungement target. Add: findings' evidence/patch fields follow raw-data TTL (or are redacted at TTL), and `review_findings` joins the FR-PRIV-013 store list.

### A8 — Mid-run integration severance is an INVALID_MOVE (Medium)
**Cites:** §11.9 (any unlisted state/event pair = INVALID_MOVE); `EVT_GITHUB_INTEGRATION_SUSPENDED` is only wired at RECEIVED (T-005) and POSTING (T-025); FR-GH-017 says "the run must transition to BLOCKED" generically.
A token revoked while the run is in CONTEXT_PREPARING, GATEWAY_REQUESTING, AGENTS_RUNNING, AGGREGATING, VERIFYING, or READY_TO_POST has no legal transition. Add `any-active-state + EVT_GITHUB_INTEGRATION_SUSPENDED → BLOCKED` to the table.

### A9 — Monorepo tree contains components with zero requirements (Medium)
**Cites:** §8 `github-check-run.handler.ts`, `patch.validator.ts` vs §14 (no check-run FRs; no `suggested_patch` validation FRs despite the schema field in §17).
Tree/contract drift: a coding agent must either invent behavior or ship dead files. Specify check-run reporting (see D2) and patch validation (does the patch parse? apply cleanly to `head_sha`? satisfy GitHub `suggestion`-block line constraints?) or cut both.

### A10 — PR close/merge cancels runs but strands the outbox (Medium)
**Cites:** FR-GH-009 ("Closed or merged PR must cancel active run"); §14.7 pending-post lifecycle has no close/merge path; T-027 scope ("Active state + EVT_CANCEL_REQUESTED") is ambiguous for GH_RATE_LIMIT_BACKOFF.
Pending posts for a closed/merged PR will keep retrying until `expires_at` (24 h) and can post onto a merged PR. Add: run cancellation cascades `PENDING/BACKOFF` outbox rows to `CANCELLED`, and state explicitly whether GH_RATE_LIMIT_BACKOFF is cancellable (it must be).

---

## B. Missing Hard Rules

Proposed continuations of the HARD-RULE series:

1. **HARD-RULE-032 (fail-closed fencing):** If current PR state cannot be read from the durable authority, the posting guard must fail closed. No posting decision may depend solely on evictable storage. *(Companion to A1; also applies to §25.1 `webhook:delivery:*` keys — a Redis restart inside the 24 h TTL window reopens HARD-RULE-027's duplicate-delivery hole, with only implicit run-coordinator dedupe as an unstated backstop.)*
2. **HARD-RULE-033 (actor loop prevention):** The bot must ignore webhook events caused by its own actions and must not review bot-authored PRs unless policy opts in. Nothing in §14.1 filters `sender`; the bot's own comment posts generate webhook traffic, and dependabot-style PRs are reviewed by default. Every production review bot has this rule; its absence is the most conspicuous product-level gap.
3. **HARD-RULE-034 (outbound redaction):** Every outbound GitHub comment must pass secret scanning/redaction before POST. FR-SEC-007/008 scan the provider path and cache-write path only. A finding whose `evidence` quotes a committed credential is currently posted verbatim to the PR — republishing the secret to every subscriber's inbox. `secret.validator.ts` exists in the tree (§8) with no requirement binding it to the posting path.
4. **HARD-RULE-035 (read-path rate limiting):** GitHub read/API calls during context building must respect rate-limit backoff. GH_RATE_LIMIT_BACKOFF covers POSTING only (§14.7); diff/file/metadata fetches for large PRs can 429 first, and the spec is silent.
5. **Draft and fork PRs:** Skip draft PRs by default and trigger on `pull_request.ready_for_review` (absent from FR-GH-005…008). Treat fork PRs as elevated prompt-injection risk with restricted policy (FR-SEC-011/012 declare PR content untrusted but define no differential handling).
6. **Comment-cap overflow determinism:** `max_inline_comments: 10` (§10.1) has no selection rule when more findings validate. Mandate severity-then-confidence ordering with deterministic tiebreak; remainder to the grouped summary. Without it, "deterministic" (§1) is false at the last step.
7. **Run watchdog:** Pending-post crash recovery is exhaustively specified (FR-POST-036…053) but a pod dying mid-`AGENTS_RUNNING` orphans the run forever — `EVT_TIMEOUT` exists (§11.5) with no emitter. Require a sweeper that fails/expires runs exceeding a state-level deadline.
8. **Token refresh vs severance:** Routine installation-token expiry must trigger refresh; only refresh *failure* is severance (see C3).

---

## C. Tech-Stack Inaccuracies

1. **GitHub has no idempotency keys (Critical).** FR-POST-042/051 and coding-agent rule §34.11 rest on `idempotency_key` preventing duplicate comments across retries. GitHub's REST API does not accept idempotency keys on comment/review creation; a retried POST after an ambiguous success (worker crash post-200, network timeout after server accept) creates a duplicate. The only implementable mechanism — list comments, match the embedded bot marker/`idempotency_key` from FR-POST-021's metadata, then decide — is never specified, and is itself racy without the row claim. The PRD's guarantee is currently unimplementable as written; the marker-scan-before-retry protocol must be an explicit requirement.
2. **REST vs GraphQL split ignored (High).** Comment minimization (FR-POST-024/025, §11.8 side effect "Delete, minimize, or preserve-mark") is GraphQL-only (`minimizeComment`); reliable reply counts/thread structure (FR-POST-031…034, G28) are materially easier via GraphQL `reviewThreads`. The PRD never mentions GraphQL; `github.adapter.ts` needs a dual-protocol contract, and "where supported" (FR-POST-021) needs pinning per comment type.
3. **`TOKEN_EXPIRED` as a blocking status (High).** §10.7 `block_on_status` includes `TOKEN_EXPIRED`, and FR-GH-019 sets it on the integration. GitHub App installation tokens expire every hour *by design*; implemented literally, every tenant is severed hourly and requires FR-GH-024 reactivation. Expiry must trigger transparent refresh; only refresh failure (401/permission loss) is a severance status.
4. **Per-comment posting instead of batched reviews (Medium).** The pending-post model treats inline comments as individually posted units (§14.7–14.8, `pending_review_posts` rows). GitHub supports one `POST /pulls/{n}/reviews` carrying all inline comments — one rate-limit charge, one notification, one atomic unit — which would shrink the outbox, the idempotency surface (C1), and reviewer noise. At minimum the PRD must choose and justify; the current design fights the platform.
5. **Financial ledger in ClickHouse (Medium).** §25.2 (Postgres tables) omits `spend_ledger`; it appears only in §25.7 (ClickHouse). Finance-authoritative, "immutable" accounting (§23.3) in an analytics store with async mutation-based deletes is a mismatch, and FR-PRIV-013's ClickHouse expungement implies heavy `ALTER TABLE DELETE` mutations. Either declare Postgres the authoritative ledger with ClickHouse as an analytics copy, or add rules requiring PII-free ClickHouse rows (making expungement there unnecessary) plus partition/TTL design.
6. **Event bus left as "Kafka / Redpanda / NATS" (Medium).** For a "locked" contract, delivery semantics (at-least-once vs at-most-once, ordering keys, replay) differ materially across these — core NATS drops on consumer absence; JetStream vs Kafka retention/replay models diverge. §26 requires `idempotency_key` but never states delivery guarantees, partitioning keys, DLQ, or replay policy (replay safety is a stakeholder need, §5, with no requirement behind it).
7. **Embeddings have no path through the Gateway (Medium).** FR-DEDUP-014/015 require embedding similarity (≥ 0.88 cosine), and HARD-RULE-003/004 route all LLM/provider calls through the Gateway — but the Gateway contract (§18.2) defines completions only. No embeddings endpoint, no embedding model in the model catalog, no cache policy for vectors, no dimension/model-version pinning (which changes dedupe behavior across upgrades).
8. **Implementation stack implied but never pinned (Low).** The tree is entirely TypeScript, yet no requirement states language, runtime versions, monorepo tooling, HTTP framework, or Postgres migration tooling. Fine for a PRD; not fine for a document whose audience is "Coding Agent … with no guessing" (§5).

---

## D. Missing Components

1. **GitHub App manifest.** No enumeration of required permissions (`pull_requests: write`, `contents: read`, `checks: read/write`, `members: read` for tenant mapping) or webhook event subscriptions. This is the first thing an implementer must know and the first thing a security reviewer audits.
2. **Check-run reporter and check events.** `wait_for_checks: true` is the *default* (§10.1) but requires `check_suite`/`check_run`/`workflow_run` event ingestion or polling — neither specified (FR-GH covers four `pull_request` actions only). The handler file exists (A9) with no contract, and there is no requirement to surface review status ("review in progress / completed / blocked") as a check run, which is the standard UX.
3. **Feedback ingestion pipeline.** §26 defines `feedback.finding.accepted/dismissed` and §28 builds the flywheel on them, but no component ingests reply comments, 👍/👎 reactions, or thread resolutions to *produce* those events. The learning loop has no sensor.
4. **Repo content acquisition.** Symbol Skeletons require whole-file content (FR-CTX-025); repo-map/dependency-graph components (§8) require tree access. Clone vs contents-API, shallow-fetch strategy, caching, and size limits are unspecified — a major cost/latency/rate-limit driver (interacts with B4).
5. **AST tooling and language matrix.** `high-risk-chunker`, `ast-overlap`, `symbol-skeleton-builder`, and FR-DEDUP-013 all depend on parsing (tree-sitter or equivalent), yet no supported-language list exists. Dedupe silently loses its AST tier for unsupported languages — "deterministic" dedupe (FR-DEDUP-020) then varies by language with no disclosure requirement.
6. **Execution model and job queue.** The title says "CI" and infra lists "CI Runner", but the architecture (webhooks, horizontally scaled pods, Redis debounce, pod-restart recovery) is a standing service. If reviews ran in CI runners, the pending-post/pod-recovery design wouldn't apply. Also: what executes QUEUED runs — Redis-backed queue, Postgres queue, bus consumer? Unstated.
7. **Escalation workflow.** ESCALATED is a terminal state with an event and a guard (G20 "escalation path exists") but no definition of triggers, consumers, UI, notification, or resume path. Dead-end feature.
8. **Signing-key management.** Metadata signatures (FR-META-003) and policy-bundle signing (FR-ROUTE-004/005) require key generation, distribution, rotation, and revocation (KMS/HSM). §25.5 versions HMAC keys (`hmac_key_id`) but the signing PKI has no equivalent treatment.
9. **`high_risk_paths` definition.** High-risk classification gates chunking (HARD-RULE-020, FR-CTX-015…023), prioritization (§10.2), and model escalation (§20) — and is never defined. No config schema, no default patterns, no precedence with `.reviewignore`.
10. **Operational envelope.** No SLOs (event→comment latency, availability), no load-test targets to make "Load tests passing" (§32) falsifiable, no Postgres backup/DR RPO-RTO, no DLQ/schema-registry for the bus, no dashboard authn/RBAC, and no dry-run/shadow mode for safe repo onboarding (the natural first rollout step, and the obvious canary substrate for §28).

---

## Priority Remediation (before implementation starts)

| # | Finding | Why first |
|---|---|---|
| 1 | A1 + B1 — durable fencing authority, fail-closed guard | Breaks HARD-RULE-001, the system's defining guarantee |
| 2 | C1 — specify the real comment-idempotency protocol | Current duplicate-comment guarantee is unimplementable |
| 3 | C3 — token refresh vs severance | Literal implementation blocks every tenant hourly |
| 4 | B3 — outbound secret redaction | Open security hole: republishes committed secrets |
| 5 | A2/A3/A4/A8 — state-machine repairs | Cheap to fix now; each is a guaranteed implementation bug later |
| 6 | B2 — actor loop prevention | Self-triggering webhook traffic at first deployment |
| 7 | D1/D2/D6 — App manifest, check events, execution model | Coding agent cannot start without them |
| 8 | C4 — batched review submission decision | Restructures the outbox unit; decide before schema freeze |

Everything else in B/C/D should land as PRD v6.5 changes; none invalidates the overall architecture, which is sound.
