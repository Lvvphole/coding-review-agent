# Sprint 4 — Context Depth + Config Wiring

**Spec:** PRD v6.5 §15.7–15.10, §16, §15.15. **Scope decision:** review-quality depth (Symbol Skeleton, chunking, taxonomy) plus the config plumbing that was stubbed as empty defaults in `main.ts`.

## Delivered

| Component | PRD anchor | Notes |
|---|---|---|
| Taxonomy compilation (`validators/taxonomy.ts`) | §16, HARD-RULE-030, TAX-001..007 | `finding-taxonomy.yaml` → compiled `{approvedIds, aliasMap, extensionParents}`; extensions require a global `parent_id`, never override global IDs (FORBIDDEN-024), duplicate aliases fail compile; `mapRootCause` canonicalizes agent aliases (TAX-005) |
| Validator taxonomy wiring (`finding.validator.ts`) | TAXONOMY-INV-001, FR-DEDUP-021..023 | Alias → canonical before approval; `taxonomy_version` stamped from the compiled taxonomy; unmapped → `NEEDS_TAXONOMY_MAPPING` (finding-scoped, never run-scoped) |
| Symbol Skeleton builder (`context-engine/symbol-skeleton-builder.ts`) | FR-CTX-025..029, HARD-RULE-021 | Pattern-based whole-file outline (classes, functions, imports/exports, security-sensitive names) with preserved line numbers; explicit language matrix (FR-AST-001) disclosing pattern-tier support — `ast_supported` stays false until a tree-sitter tier lands (FR-AST-003) |
| High-risk chunker (`context-engine/high-risk-chunker.ts`) | HARD-RULE-020, FR-CTX-015..024 | Diff-hunk chunking (tier 2) with bounded line-window fallback (tier 3); each chunk carries path, line range, index/total, reason, and the whole-file skeleton; strategy recorded per chunk |
| Pipeline wiring (`review-pr.workflow.ts`, `agent-core`) | FR-CTX-020..022, id="prompt-layout-v65" | Budget-blocked high-risk files now chunk into the agents' **dynamic** context (never the stable prefix); files that still can't chunk are reported blocked |
| YAML config loading (`config-files.ts`) | §9, FR-RISK-001, FR-DEDUP-025 | `high-risk-paths.yaml` + `finding-taxonomy.yaml` loaded and compiled at startup; missing files fail closed (empty approvals), never fail open |
| Seed taxonomy (`configs/review/finding-taxonomy.yaml`) | §16.3 | 14 global canonical IDs across security/bug/perf/test/maintainability families with alias sets |
| Check-run reporter (adapters + executor) | FR-CHECK-001..006, §23.3 | `ai-code-review` check run: in_progress → completed with **neutral/success** conclusion (AI review never blocks merge by default); reporting failures never fail the run (FR-CHECK-005) |
| Gateway client switch (`main.ts`) | HARD-RULE-003/004 | `GATEWAY_URL` env selects `HttpGatewayClient`; stub otherwise; provider keys in neither case |

## Tests (139 passing: 88 unit + 51 integration)
New: TAX-001..006 compile/override/parent/alias matrix; validator alias-canonicalization end-to-end; skeleton signature/line/body rules (CTX-016/017) + unsupported-language fallback disclosure; chunk metadata, line fidelity, window splitting, per-chunk skeleton (CTX-009..013, FR-CTX-018/019/024/025); check-run lifecycle assertion in the executor e2e (in_progress → completed/neutral).

## Deliberate deferrals
1. tree-sitter AST tier (chunking tier 1, AST-node dedupe) — the language matrix and `ast_supported` plumbing are in place for it.
2. Repo content acquisition (§15.8): skeletons currently build from changed lines when whole-file content is unavailable; the shallow-fetch workspace lands with its own sprint.
3. Config precedence chain (§9.3 repo overrides) and `.github/review-bot.yml`.
4. Control Plane workers, telemetry/event bus, multi-tenant hardening, eval pipeline (Sprint 5+).

## Verification
```bash
pnpm build && pnpm test && pnpm test:integration   # 139/139
```
