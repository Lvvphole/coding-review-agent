import type { RunIdentity } from '@review-bot/shared';
import { renderCriteriaContext } from './prd-criteria.js';
import type { PrdExtractor } from './prd-extractor.js';
import type { PrdResolver } from './prd-store.js';

/**
 * Binds PRD resolution → Gateway extraction → dynamic-context rendering for a
 * run. Returns null when no PRD is attached (general-review fallback,
 * docs/product/failure-ux.md). Injected into the executor as an optional seam,
 * so the no-PRD path is unchanged.
 */
export interface PrdContext {
  context: string;
  sourceRef: string;
  truncated: boolean;
}

export interface PrdContextProvider {
  provide(run: RunIdentity, signal?: AbortSignal): Promise<PrdContext | null>;
}

export class ManagedPrdContextProvider implements PrdContextProvider {
  constructor(
    private readonly resolver: PrdResolver,
    private readonly extractor: PrdExtractor,
  ) {}

  async provide(run: RunIdentity, signal?: AbortSignal): Promise<PrdContext | null> {
    const resolved = await this.resolver.resolve(run);
    if (!resolved) return null; // no PRD → requirement-aware review not active

    const { criteria } = await this.extractor.extract(run, resolved.text, resolved.sourceRef, signal);
    const context = renderCriteriaContext(criteria);
    if (context.length === 0) return null; // PRD yielded no usable criteria
    return { context, sourceRef: resolved.sourceRef, truncated: criteria.truncated };
  }
}
