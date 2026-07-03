import { readFileSync } from 'node:fs';
import { Gateway } from './gateway.js';
import { createGatewayHttpServer } from './gateway-http.js';
import type { SignedPolicyBundle } from './policy/policy-bundle.js';
import { AnthropicProvider } from './providers/anthropic.provider.js';
import { StubCompletionProvider, StubEmbeddingProvider } from './providers/stub.provider.js';
import type { CompletionProvider } from './providers/provider.interface.js';

/**
 * llm-gateway entrypoint. Provider API keys live only in this process's
 * environment (HARD-RULE-005); the CI Bot reaches models exclusively through
 * this HTTP surface (HARD-RULE-003/004).
 *
 * Required env:
 *   POLICY_BUNDLE_PATH      signed bundle JSON (scripts/sign-policy-bundle.ts)
 *   POLICY_PUBLIC_KEY_PATH  Ed25519 public key PEM
 *   APP_METADATA_SECRET     shared HMAC secret for the ci-review-bot app
 *   ALLOWED_TENANTS         comma-separated tenant ids for ci-review-bot
 *   ANTHROPIC_API_KEY       optional; enables the anthropic provider
 */
async function main(): Promise<void> {
  const signedBundle = JSON.parse(
    readFileSync(process.env['POLICY_BUNDLE_PATH'] ?? 'policy-bundle.signed.json', 'utf8'),
  ) as SignedPolicyBundle;
  const policyPublicKeyPem = readFileSync(
    process.env['POLICY_PUBLIC_KEY_PATH'] ?? 'policy-signing.pub.pem',
    'utf8',
  );

  const providers: Record<string, CompletionProvider> = {
    'local-stub': new StubCompletionProvider(),
  };
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    providers['anthropic'] = new AnthropicProvider({ apiKey: anthropicKey });
  }

  const gateway = new Gateway({
    apps: [
      {
        appId: 'ci-review-bot',
        metadataSecret: process.env['APP_METADATA_SECRET'] ?? 'dev-app-secret',
        allowedTenants: new Set(
          (process.env['ALLOWED_TENANTS'] ?? 'tenant_default').split(',').filter(Boolean),
        ),
      },
    ],
    signedBundle,
    policyPublicKeyPem,
    providers,
    embeddings: new StubEmbeddingProvider(),
    quota: {
      rpmLimit: Number(process.env['QUOTA_RPM'] ?? 60),
      tpmLimit: Number(process.env['QUOTA_TPM'] ?? 200_000),
      ttlSeconds: 60,
      renewalThresholdPercentRemaining: 30,
    },
    onEvent: (event) => console.log(JSON.stringify(event)),
  });

  const server = createGatewayHttpServer(gateway);

  const port = Number(process.env['PORT'] ?? 8090);
  server.listen(port, () => console.log(`llm-gateway listening on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
