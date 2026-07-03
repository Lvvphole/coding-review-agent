import type { GatewayClient, GatewayRequest, GatewayResponse } from './gateway-client.js';
import { GatewayBlockedError } from './gateway-client.js';
import { signGatewayMetadata } from './metadata-signing.js';

/**
 * HTTP client for the LLM Gateway — the CI Bot's only path to models
 * (HARD-RULE-003/004, FR-AGENT-008). Signs metadata with the app secret
 * before dispatch; never sees provider keys.
 */
export class HttpGatewayClient implements GatewayClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      gatewayUrl: string;
      appSecret: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(request: GatewayRequest, signal?: AbortSignal): Promise<GatewayResponse> {
    const signed: GatewayRequest = {
      ...request,
      metadata_signature: signGatewayMetadata(this.opts.appSecret, request),
    };
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    };
    if (signal !== undefined) init.signal = signal;
    const response = await this.fetchImpl(`${this.opts.gatewayUrl}/v1/complete`, init);
    if (!response.ok) {
      const body = await response.text();
      throw new GatewayBlockedError(`${response.status}: ${body}`);
    }
    return (await response.json()) as GatewayResponse;
  }
}
