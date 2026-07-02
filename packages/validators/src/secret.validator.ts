/**
 * Outbound secret redaction — HARD-RULE-038, FR-SEC-015..021, FORBIDDEN-043.
 *
 * Every outbound GitHub comment body passes through redactOutboundComment
 * before POST. Detected secret-like values are replaced with a redaction
 * marker; the comment may say a secret-like value was detected but must not
 * repost the value (FR-SEC-017).
 */

export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

/** Default patterns; extended via configs/security/secret-patterns.yaml. */
export const DEFAULT_SECRET_PATTERNS: SecretPattern[] = [
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'generic_api_key', pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"\s]{16,}['"]/gi },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g },
  { name: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
];

export interface RedactionResult {
  body: string;
  redactions: { name: string; count: number }[];
  redacted: boolean;
}

export function redactOutboundComment(
  body: string,
  patterns: SecretPattern[] = DEFAULT_SECRET_PATTERNS,
): RedactionResult {
  let out = body;
  const redactions: { name: string; count: number }[] = [];
  for (const { name, pattern } of patterns) {
    let count = 0;
    out = out.replace(pattern, () => {
      count += 1;
      return `[REDACTED:${name}]`;
    });
    if (count > 0) redactions.push({ name, count });
  }
  return { body: out, redactions, redacted: redactions.length > 0 };
}
