import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed metadata — FR-META-003, FR-GW-004, HARD-RULE-006 trust boundary.
 *
 * The signature covers the routing-relevant metadata fields with a per-app
 * secret. The CI Bot holds only its app signing secret (never provider keys,
 * HARD-RULE-005); the Gateway holds the verifying copy. Message content is
 * NOT covered — content is data, metadata is the trust boundary (§18.3).
 */

export interface SignableMetadata {
  tenant_id: string;
  app_id: string;
  workflow_id: string;
  request_id: string;
  task_type: string;
  risk_level: string;
  data_class: string;
  latency_class: string;
  streaming_mode: string;
}

function canonical(m: SignableMetadata): string {
  return [
    m.tenant_id,
    m.app_id,
    m.workflow_id,
    m.request_id,
    m.task_type,
    m.risk_level,
    m.data_class,
    m.latency_class,
    m.streaming_mode,
  ].join('\n');
}

export function signGatewayMetadata(appSecret: string, m: SignableMetadata): string {
  return createHmac('sha256', appSecret).update(canonical(m)).digest('hex');
}

export function verifyGatewayMetadata(
  appSecret: string,
  m: SignableMetadata,
  signature: string,
): boolean {
  const expected = signGatewayMetadata(appSecret, m);
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
