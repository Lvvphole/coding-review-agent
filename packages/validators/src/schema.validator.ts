import {
  CATEGORIES,
  SEVERITIES,
  type ReviewFinding,
} from '@review-bot/shared';

/**
 * Strict finding schema validation — PRD v6.5 §18 (id="review-finding-schema-v65").
 * Invalid schema rejects the finding (posting rule 7, FORBIDDEN-008).
 */

export interface SchemaResult {
  ok: boolean;
  errors: string[];
}

const ROOT_CAUSE_SOURCES = new Set(['global', 'organization_extension', 'repository_extension']);

export function validateFindingSchema(raw: unknown): SchemaResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['finding must be a JSON object'] };
  }
  const f = raw as Record<string, unknown>;

  const requireString = (key: string) => {
    if (typeof f[key] !== 'string' || (f[key] as string).length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  };

  for (const key of [
    'finding_id',
    'file',
    'title',
    'evidence',
    'recommendation',
    'agent_source',
    'root_cause_id',
    'root_cause_family',
    'taxonomy_version',
  ]) {
    requireString(key);
  }

  if (!SEVERITIES.includes(f['severity'] as never)) {
    errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  }
  if (!CATEGORIES.includes(f['category'] as never)) {
    errors.push(`category must be one of ${CATEGORIES.join(', ')}`);
  }
  if (typeof f['line'] !== 'number' || !Number.isInteger(f['line']) || f['line'] < 1) {
    errors.push('line must be a positive integer');
  }
  if (typeof f['confidence'] !== 'number' || f['confidence'] < 0 || f['confidence'] > 1) {
    errors.push('confidence must be a number in [0, 1]');
  }
  if (typeof f['root_cause_source'] !== 'string' || !ROOT_CAUSE_SOURCES.has(f['root_cause_source'])) {
    errors.push('root_cause_source must be global | organization_extension | repository_extension');
  }
  if (f['suggested_patch'] !== undefined && typeof f['suggested_patch'] !== 'string') {
    errors.push('suggested_patch must be a string when present');
  }

  return { ok: errors.length === 0, errors };
}

export function isReviewFinding(raw: unknown): raw is ReviewFinding {
  return validateFindingSchema(raw).ok;
}
