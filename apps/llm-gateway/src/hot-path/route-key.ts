/**
 * Bit-masked route key — PRD v6.5 §19 layout (id="route-key-layout"), v1:
 *   bits 0–3  task_type      bits 10–11 cache_probability_bucket
 *   bits 4–5  risk_level     bits 12–13 quota_status
 *   bits 6–7  data_class     bits 14–15 streaming_mode
 *   bits 8–9  latency_class  bits 16–17 app_tier
 *                            bits 18–19 degraded_mode_state
 *
 * The encoder is deterministic (FR-ROUTE-002) and versioned (FR-ROUTE-001);
 * lookup is O(1) against the compiled signed table with a safe default
 * fallback (FR-ROUTE-006). The Gateway never scores models dynamically
 * (FR-ROUTE-008, G-008).
 */

export const ROUTE_KEY_LAYOUT_VERSION = 1 as const;

const TASK_TYPES: Record<string, number> = {
  code_review: 0,
  security_review: 1,
  test_review: 2,
  maintainability_review: 3,
  style_review: 4,
  pr_summary: 5,
  architecture_review: 6,
  final_verification: 7,
  comment_formatting: 8,
  planning: 9,
  embedding: 10,
};

const RISK_LEVELS: Record<string, number> = { low: 0, medium: 1, high: 2 };
const DATA_CLASSES: Record<string, number> = { public: 0, internal: 1, confidential: 2 };
const LATENCY_CLASSES: Record<string, number> = { batch: 0, interactive: 1 };
const STREAMING_MODES: Record<string, number> = { disabled: 0, enabled: 1 };

export interface RouteKeyInput {
  task_type: string;
  risk_level: string;
  data_class: string;
  latency_class: string;
  streaming_mode: string;
  cache_probability_bucket?: number; // 0-3, async-computed; defaults to 0
  quota_status?: number; // 0 healthy, 1 constrained, 2 exhausted
  app_tier?: number;
  degraded_mode_state?: number; // 0 normal, 1 degraded
}

export class UnknownRouteFieldError extends Error {
  constructor(field: string, value: string) {
    super(`unknown ${field}: ${value}`);
    this.name = 'UnknownRouteFieldError';
  }
}

function lookup(table: Record<string, number>, field: string, value: string): number {
  const encoded = table[value];
  if (encoded === undefined) throw new UnknownRouteFieldError(field, value);
  return encoded;
}

export function encodeRouteKey(input: RouteKeyInput): number {
  return (
    (lookup(TASK_TYPES, 'task_type', input.task_type) << 0) |
    (lookup(RISK_LEVELS, 'risk_level', input.risk_level) << 4) |
    (lookup(DATA_CLASSES, 'data_class', input.data_class) << 6) |
    (lookup(LATENCY_CLASSES, 'latency_class', input.latency_class) << 8) |
    (((input.cache_probability_bucket ?? 0) & 0b11) << 10) |
    (((input.quota_status ?? 0) & 0b11) << 12) |
    (lookup(STREAMING_MODES, 'streaming_mode', input.streaming_mode) << 14) |
    (((input.app_tier ?? 0) & 0b11) << 16) |
    (((input.degraded_mode_state ?? 0) & 0b11) << 18)
  );
}
