import {
  ProviderDispatchError,
  type CompletionProvider,
  type ProviderCompletionRequest,
  type ProviderCompletionResponse,
} from './provider.interface.js';

/** Anthropic Messages API provider. API key lives only in the Gateway env. */
export class AnthropicProvider implements CompletionProvider {
  readonly name = 'anthropic';
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(
    req: ProviderCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ProviderCompletionResponse> {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      }),
    };
    if (signal !== undefined) init.signal = signal;
    const response = await this.fetchImpl(
      `${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
      init,
    );
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderDispatchError(
        `anthropic ${response.status}: ${await response.text()}`,
        retryable,
      );
    }
    const body = (await response.json()) as {
      content: { type: string; text?: string }[];
      usage: { input_tokens: number; output_tokens: number };
    };
    return {
      content: body.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join(''),
      tokenInput: body.usage.input_tokens,
      tokenOutput: body.usage.output_tokens,
    };
  }
}
