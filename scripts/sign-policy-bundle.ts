import { writeFileSync } from 'node:fs';
import {
  generatePolicySigningKeys,
  signPolicyBundle,
  type PolicyBundle,
} from '../apps/llm-gateway/src/policy/policy-bundle.js';

/**
 * Development policy-bundle signer (PRD §8 scripts/sign-policy-bundle.ts).
 * Production bundles are compiled and signed by the Control Plane after
 * eval + canary (HARD-RULE-029); this seeds a signed bundle for local dev.
 *
 * Usage: pnpm tsx scripts/sign-policy-bundle.ts [ttl-hours]
 * Writes: policy-bundle.signed.json, policy-signing.pub.pem, policy-signing.key.pem
 */
const ttlHours = Number(process.argv[2] ?? 24);
const { privateKeyPem, publicKeyPem } = generatePolicySigningKeys();

const bundle: PolicyBundle = {
  version: `dev-${new Date().toISOString()}`,
  route_key_layout_version: 1,
  issued_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
  routes: {
    // Safe default route (FR-ROUTE-006); model tiers per PRD §20 routing table.
    default: { provider: 'anthropic', model: 'claude-sonnet-5', model_tier: 'standard' },
  },
  embedding_model: {
    provider: 'local-stub-embeddings',
    model: 'stub-embed',
    version: 'stub-embed-v1',
    dimensions: 8,
  },
  app_allowlist: {
    'ci-review-bot': {
      task_types: ['code_review', 'security_review', 'test_review', 'pr_summary', 'embedding'],
      data_classes: ['internal', 'confidential'],
    },
  },
};

writeFileSync('policy-bundle.signed.json', JSON.stringify(signPolicyBundle(bundle, privateKeyPem), null, 2));
writeFileSync('policy-signing.pub.pem', publicKeyPem);
writeFileSync('policy-signing.key.pem', privateKeyPem);
console.log(`signed policy bundle ${bundle.version} (expires ${bundle.expires_at})`);
