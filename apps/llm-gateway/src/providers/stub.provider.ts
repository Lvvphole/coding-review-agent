import { createHash } from 'node:crypto';
import type {
  CompletionProvider,
  EmbeddingProvider,
  ProviderCompletionRequest,
  ProviderCompletionResponse,
} from './provider.interface.js';

/** Deterministic completion provider for tests and local development. */
export class StubCompletionProvider implements CompletionProvider {
  readonly name = 'local-stub';
  private responses: string[] = [];
  public readonly requests: ProviderCompletionRequest[] = [];

  registerResponse(content: string): void {
    this.responses.push(content);
  }

  async complete(
    req: ProviderCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ProviderCompletionResponse> {
    if (signal?.aborted) throw new Error('cancelled before provider dispatch');
    this.requests.push(req);
    const content = this.responses.shift() ?? '[]';
    return {
      content,
      tokenInput: Math.ceil((req.system.length + req.user.length) / 4),
      tokenOutput: Math.ceil(content.length / 4),
    };
  }
}

/**
 * Deterministic embedding stub: sha256-derived unit vectors. Model version
 * and dimensions are pinned (FR-GW-020) so threshold validity is anchored.
 */
export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-stub-embeddings';
  readonly modelVersion = 'stub-embed-v1';
  readonly dimensions = 8;

  async embed(inputs: string[]): Promise<number[][]> {
    return inputs.map((text) => {
      const digest = createHash('sha256').update(text).digest();
      const raw = Array.from({ length: this.dimensions }, (_, i) => digest[i]! - 128);
      const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
      return raw.map((v) => v / norm);
    });
  }
}
