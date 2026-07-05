import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { GatewayClient, GatewayRequest } from '@review-bot/llm-client';
import type { RunIdentity } from '@review-bot/shared';
import {
  chunkPrdText,
  contentHash,
  criteriaKey,
  emptyCriteria,
  EXTRACTION_VERSION,
  mergeCriteria,
  parseCriteria,
  type PrdCriteria,
} from './prd-criteria.js';

/**
 * PRD extraction — HARD-RULE-UX-004, HARD-RULE-003/004/005 (Gateway-only; no
 * provider keys in this process). PRD text is an LLM task and MUST route
 * through the Gateway with task_type `prd_extraction`.
 *
 * Determinism / versioning (§25.1, FR-REPO-006 discipline):
 *  - criteria are content-addressed; the same PRD bytes always hit the same
 *    cache row. A PM edit changes the hash → cache miss → re-extract → upsert.
 *  - concurrent first-runs collapse via ON CONFLICT DO NOTHING; with temp=0
 *    extraction every writer produces identical content.
 *
 * Oversized PRDs use a bounded map-reduce: one `prd_extraction` call per chunk
 * (map), a deterministic union reduce (mergeCriteria) — never an LLM reducer on
 * the sync path (same principle as HARD-RULE-013).
 */

export interface PrdExtractorOptions {
  taxonomyVersion: string;
  /** Single-call budget; larger PRDs are chunked (map-reduce). */
  maxBytes: number;
  /** Cap on map chunks; over-budget PRDs keep the highest-priority head. */
  maxChunks: number;
}

const PRD_EXTRACTION_SYSTEM = [
  'You extract review criteria from a Product Requirements Document.',
  'Return a single JSON object with string-array fields:',
  'requirements, acceptance_criteria, risk_areas, expected_behavior,',
  'expected_files, test_expectations, security_expectations, out_of_scope.',
  'Extract only what the PRD states. Do not invent requirements.',
].join('\n');

export interface ExtractionResult {
  criteria: PrdCriteria;
  cached: boolean;
  criteriaKey: string;
}

export class PrdExtractor {
  constructor(
    private readonly pool: Pool,
    private readonly gateway: GatewayClient,
    private readonly opts: PrdExtractorOptions,
  ) {}

  async extract(
    run: RunIdentity,
    prdText: string,
    sourceRef: string,
    signal?: AbortSignal,
  ): Promise<ExtractionResult> {
    const hash = contentHash(prdText);
    const key = criteriaKey({
      tenantId: run.tenantId,
      repo: run.repo,
      sourceRef,
      contentHash: hash,
      extractionVersion: EXTRACTION_VERSION,
      taxonomyVersion: this.opts.taxonomyVersion,
    });

    const hit = await this.pool.query(
      `SELECT criteria, truncated FROM prd_criteria WHERE criteria_key = $1`,
      [key],
    );
    if ((hit.rowCount ?? 0) > 0) {
      const criteria = hit.rows[0].criteria as PrdCriteria;
      criteria.truncated = hit.rows[0].truncated;
      return { criteria, cached: true, criteriaKey: key };
    }

    // Map: one bounded prd_extraction call per chunk (whole PRD when it fits).
    let truncated = false;
    let chunks: { index: number; total: number; text: string }[];
    if (prdText.length <= this.opts.maxBytes) {
      chunks = [{ index: 0, total: 1, text: prdText }];
    } else {
      const split = chunkPrdText(prdText, {
        maxChunkChars: this.opts.maxBytes,
        maxChunks: this.opts.maxChunks,
      });
      chunks = split.chunks;
      truncated = split.truncated;
    }

    const parts: PrdCriteria[] = [];
    for (const chunk of chunks) {
      const response = await this.gateway.complete(
        this.buildRequest(run, chunk.text, chunk.index, chunk.total),
        signal,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.content);
      } catch {
        parsed = {}; // a malformed chunk yields no criteria, never fails the run
      }
      parts.push(parseCriteria(parsed));
    }

    // Reduce: deterministic union.
    const criteria = parts.length > 0 ? mergeCriteria(parts) : emptyCriteria();
    criteria.truncated = truncated;

    await this.pool.query(
      `INSERT INTO prd_criteria
         (criteria_key, tenant_id, repo, source_ref, content_hash,
          extraction_version, taxonomy_version, criteria, truncated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (criteria_key) DO NOTHING`,
      [
        key,
        run.tenantId,
        run.repo,
        sourceRef,
        hash,
        EXTRACTION_VERSION,
        this.opts.taxonomyVersion,
        JSON.stringify(criteria),
        truncated,
      ],
    );
    return { criteria, cached: false, criteriaKey: key };
  }

  private buildRequest(
    run: RunIdentity,
    prdChunk: string,
    index: number,
    total: number,
  ): GatewayRequest {
    return {
      tenant_id: run.tenantId,
      app_id: 'ci-review-bot',
      workflow_id: 'pr_review',
      request_id: randomUUID(),
      run_id: run.runId,
      repo: run.repo,
      pull_request_id: run.pullRequestId,
      head_sha: run.headSha,
      run_epoch: run.runEpoch,
      task_type: 'prd_extraction',
      risk_level: 'low',
      data_class: 'confidential', // PRD is product-confidential
      latency_class: 'batch',
      streaming_mode: 'disabled',
      expected_output: 'json_schema',
      cache_policy: 'provider_prefix_only',
      metadata_signature: 'unsigned-sprint1-stub',
      messages: [
        { role: 'system', content: PRD_EXTRACTION_SYSTEM },
        {
          role: 'user',
          content:
            total > 1 ? `PRD chunk ${index + 1}/${total}:\n${prdChunk}` : `PRD:\n${prdChunk}`,
        },
      ],
    };
  }
}
