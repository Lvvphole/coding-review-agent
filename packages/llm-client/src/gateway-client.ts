/**
 * Gateway-only LLM access — HARD-RULE-003/004/005, FR-AGENT-008, FORBIDDEN-006.
 *
 * The CI Bot never calls providers and never holds provider keys. This client
 * speaks only the Gateway request contract (PRD v6.5 §19.2,
 * id="gateway-request-contract-v65"). In Sprint 1 the Gateway itself is not
 * built; StubGatewayClient provides a deterministic in-process stand-in used
 * by tests and the simulate-pr-review script.
 */

export interface GatewayMessage {
  role: 'system' | 'user';
  content: string;
}

export interface GatewayRequest {
  tenant_id: string;
  app_id: 'ci-review-bot';
  workflow_id: 'pr_review';
  request_id: string;
  run_id: string;
  repo: string;
  pull_request_id: number;
  head_sha: string;
  run_epoch: number;
  task_type: string;
  risk_level: 'low' | 'medium' | 'high';
  data_class: 'internal' | 'confidential';
  latency_class: 'batch';
  streaming_mode: 'disabled';
  expected_output: 'json_schema';
  cache_policy: 'provider_prefix_only';
  metadata_signature: string;
  messages: GatewayMessage[];
}

export interface GatewayResponse {
  request_id: string;
  /** Raw model output; agents require strict JSON (FR-AGENT-009). */
  content: string;
  token_input: number;
  token_output: number;
  model_tier: 'cheap' | 'standard' | 'frontier';
}

export interface GatewayClient {
  complete(request: GatewayRequest, signal?: AbortSignal): Promise<GatewayResponse>;
}

export class GatewayBlockedError extends Error {
  constructor(reason: string) {
    super(`gateway blocked request: ${reason}`);
    this.name = 'GatewayBlockedError';
  }
}

/**
 * Deterministic stub. Responses are registered per task_type; cancellation is
 * honored (FR-CAN-004) by rejecting when the signal is already aborted.
 */
export class StubGatewayClient implements GatewayClient {
  private responses = new Map<string, string[]>();
  public readonly requests: GatewayRequest[] = [];

  registerResponse(taskType: string, jsonContent: string): void {
    const list = this.responses.get(taskType) ?? [];
    list.push(jsonContent);
    this.responses.set(taskType, list);
  }

  async complete(request: GatewayRequest, signal?: AbortSignal): Promise<GatewayResponse> {
    if (signal?.aborted) {
      throw new GatewayBlockedError('request cancelled before dispatch');
    }
    this.requests.push(request);
    const list = this.responses.get(request.task_type);
    const content = list && list.length > 0 ? list.shift()! : '[]';
    return {
      request_id: request.request_id,
      content,
      token_input: Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 4),
      token_output: Math.ceil(content.length / 4),
      model_tier: 'standard',
    };
  }
}
