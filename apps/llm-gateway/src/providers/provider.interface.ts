/**
 * Provider boundary — provider API keys exist ONLY inside the Gateway
 * process (HARD-RULE-005, FR-SEC-001/002).
 */

export interface ProviderCompletionRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}

export interface ProviderCompletionResponse {
  content: string;
  tokenInput: number;
  tokenOutput: number;
}

export interface CompletionProvider {
  readonly name: string;
  complete(req: ProviderCompletionRequest, signal?: AbortSignal): Promise<ProviderCompletionResponse>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  embed(inputs: string[], signal?: AbortSignal): Promise<number[][]>;
}

export class ProviderDispatchError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderDispatchError';
  }
}
