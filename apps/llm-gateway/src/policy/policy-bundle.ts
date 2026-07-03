import { createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync } from 'node:crypto';

/**
 * Signed compiled policy bundle — HARD-RULE-006, FR-ROUTE-003..007.
 *
 * The Control Plane compiles and signs (Ed25519); the Gateway verifies the
 * signature and expiry before serving any route (G9). Invalid signature or
 * expired bundle fails closed (FORBIDDEN-011/012, gateway defaults
 * reject_expired_policy_bundle: true).
 */

export interface RouteTarget {
  provider: string;
  model: string;
  model_tier: 'cheap' | 'standard' | 'frontier';
}

export interface PolicyBundle {
  version: string;
  route_key_layout_version: 1;
  issued_at: string;
  expires_at: string;
  /** encoded route key (decimal string) → target; 'default' is the safe fallback (FR-ROUTE-006). */
  routes: Record<string, RouteTarget>;
  /** Embedding model pinning — FR-GW-020..022. */
  embedding_model: { provider: string; model: string; version: string; dimensions: number };
  /** app_id → allowed task_types (FR-META-001/004). */
  app_allowlist: Record<string, { task_types: string[]; data_classes: string[] }>;
}

export interface SignedPolicyBundle {
  bundle: PolicyBundle;
  signature: string;
}

export function signPolicyBundle(bundle: PolicyBundle, privateKeyPem: string): SignedPolicyBundle {
  const payload = Buffer.from(JSON.stringify(bundle));
  const signature = sign(null, payload, createPrivateKey(privateKeyPem)).toString('base64');
  return { bundle, signature };
}

export type BundleVerification =
  | { ok: true; bundle: PolicyBundle }
  | { ok: false; reason: 'invalid_signature' | 'expired' | 'unsupported_layout' };

export function verifyPolicyBundle(
  signed: SignedPolicyBundle,
  publicKeyPem: string,
  now = new Date(),
): BundleVerification {
  const payload = Buffer.from(JSON.stringify(signed.bundle));
  const valid = verify(
    null,
    payload,
    createPublicKey(publicKeyPem),
    Buffer.from(signed.signature, 'base64'),
  );
  if (!valid) return { ok: false, reason: 'invalid_signature' };
  if (new Date(signed.bundle.expires_at) <= now) return { ok: false, reason: 'expired' };
  if (signed.bundle.route_key_layout_version !== 1) return { ok: false, reason: 'unsupported_layout' };
  return { ok: true, bundle: signed.bundle };
}

/** Ed25519 keypair for policy signing (Control Plane side / tests / scripts). */
export function generatePolicySigningKeys(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}
