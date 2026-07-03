# Sprint 3 — LLM Gateway Service

**Spec:** PRD v6.5 §19–20. **Scope decision:** the Gateway hot path as a standing HTTP service. The last stubbed component in the review path is now real; the bot's `GatewayClient` seam gains an `HttpGatewayClient` with zero changes to bot workflows.

## Delivered

| Component | PRD anchor | Notes |
|---|---|---|
| Gateway hot path (`apps/llm-gateway/src/gateway.ts`) | FR-GW-001..017, FR-META-001..009 | app identity → tenant validation → signed metadata → redaction + secret scan → quota lease → route key → signed route lookup → provider dispatch → async event → normalized response; every validation failure fails closed |
| Signed policy bundle (`policy/policy-bundle.ts`) | HARD-RULE-006, FR-ROUTE-003..007 | Ed25519-signed compiled bundle; invalid signature / expiry / layout mismatch → fail-closed degraded mode (FORBIDDEN-011/012); dev signer at `scripts/sign-policy-bundle.ts` (production signing belongs to the Control Plane after eval+canary, HARD-RULE-029) |
| Bit-masked route key (`hot-path/route-key.ts`) | §19 layout, FR-ROUTE-001/002/008 | Versioned v1 layout, deterministic encoder, O(1) table lookup with safe `default` fallback; unknown field values fail closed; no dynamic scoring |
| Local quota leases (`hot-path/quota-lease.ts`) | §20.3, FORBIDDEN-010 | RPM/TPM/TTL local consumption; expired or exhausted lease blocks dispatch; renewal is *requested* via event, granted only by the Control Plane budget authority — never self-served in the hot path |
| Metadata signing (`llm-client/metadata-signing.ts`) | FR-META-003 | Shared HMAC-SHA256 canonicalization; per-app secret; bot signs, Gateway verifies; tampering (e.g. risk-lowering, FR-META-007) fails verification |
| Providers | HARD-RULE-005, FR-SEC-001/002 | `AnthropicProvider` (Messages API; key only in Gateway env) + deterministic stub completion/embedding providers for tests and dev |
| Embeddings endpoint | FR-GW-018..023 | `/v1/embeddings` under identical trust rules; model version + dimensions pinned in the bundle; provider/bundle version mismatch fails closed |
| Edge redaction + secret scan | FR-GW-006/007, FR-SEC-006/007 | Message contents pass secret redaction before any provider dispatch |
| HTTP surface (`gateway-http.ts`, `server.ts`) | FR-EXEC analog | `/v1/complete`, `/v1/embeddings`, `/healthz`; request-abort propagates cancellation to providers (FR-GW-014) |
| Bot client (`llm-client/http-gateway-client.ts`) | HARD-RULE-003/004 | Drop-in `GatewayClient`; signs metadata per request; the bot still never holds provider keys |

## Tests (124 passing: 73 unit + 51 integration)

New this sprint:
- **Unit (14):** bundle sign/verify/tamper/expiry (G-006); route-key determinism, bit-range isolation, unknown-value fail-closed (G-008); quota consume/exhaust/expire/renew (G-007, FORBIDDEN-010); metadata signing round-trip + tamper + wrong-secret (FR-META-003/007).
- **Integration (10, real HTTP with the bot's `HttpGatewayClient`):** signed completion e2e; tampered metadata 401 (G-003); rogue app 403 (G-004); wrong tenant 403 (G-005/TENANT-004); disallowed task_type 403 (FR-META-004); expired bundle 503 with zero provider calls (G-006); lease exhaustion 429 blocking dispatch (G-007); secret redacted before provider (SEC-001); embeddings e2e with version pinning + unsigned rejection (FR-GW-018..020); embedding version mismatch 503 (FR-GW-021/022).

Bug caught by tests during the sprint: the hot path initially self-renewed leases at the renewal threshold, silently granting unlimited quota — G-007 failed and the fix routes renewal through an event to the Control Plane authority.

## Deliberate deferrals
1. Control Plane route compiler / canary / publisher workers (bundle generation is a dev script until then).
2. Exact-response cache (code review runs `provider_prefix_only`; exact cache lands with the cache-policy sprint).
3. Streaming guardrails (code review is batch/disabled).
4. Provider failover + health-based routing weight (needs provider-health worker).
5. Wiring `main.ts` of the bot from `StubGatewayClient` to `HttpGatewayClient` by env (`GATEWAY_URL`) — one-line switch, done when a Gateway deployment exists.

## Verification
```bash
pnpm build && pnpm test && pnpm test:integration   # 124/124
pnpm tsx scripts/sign-policy-bundle.ts             # dev bundle + keys
POLICY_BUNDLE_PATH=policy-bundle.signed.json POLICY_PUBLIC_KEY_PATH=policy-signing.pub.pem \
  node apps/llm-gateway/dist/server.js             # gateway on :8090
```
