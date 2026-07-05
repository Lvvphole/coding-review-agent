import type { Pool } from 'pg';
import type { RunIdentity } from '@review-bot/shared';
import { contentHash } from './prd-criteria.js';

/**
 * PRD source config + resolution — HARD-RULE-UX-004, FR-PRIV.
 *
 * A repo attaches a PRD one of four ways (docs/product/prd-ingestion.md):
 * upload/paste store raw text here (retention-bounded, expungable); repo_path/
 * link are resolved from the repository at the PR head SHA via an injected
 * RepoFileReader (fenced exactly like head_sha — a mid-run edit cannot affect
 * an in-flight run). No PRD → resolve() returns null → general-review fallback.
 */

export type PrdSourceKind = 'repo_path' | 'link' | 'upload' | 'paste';

export interface PrdSource {
  kind: PrdSourceKind;
  ref: string;
  content: string | null;
  expired: boolean;
}

export class PrdSourceStore {
  constructor(private readonly pool: Pool) {}

  /** Attach/replace a repo's PRD source. Upload/paste inline raw text with TTL. */
  async setSource(input: {
    tenantId: string;
    repo: string;
    kind: PrdSourceKind;
    ref: string;
    content?: string;
    ttlHours?: number;
  }): Promise<void> {
    const hash = input.content !== undefined ? contentHash(input.content) : null;
    await this.pool.query(
      `INSERT INTO prd_sources
         (tenant_id, repo, source_kind, source_ref, content, content_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(hours => $7::int) END)
       ON CONFLICT (tenant_id, repo) DO UPDATE
         SET source_kind = EXCLUDED.source_kind, source_ref = EXCLUDED.source_ref,
             content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
             expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [
        input.tenantId,
        input.repo,
        input.kind,
        input.ref,
        input.content ?? null,
        hash,
        input.ttlHours ?? null,
      ],
    );
  }

  async getSource(tenantId: string, repo: string): Promise<PrdSource | null> {
    const res = await this.pool.query(
      `SELECT source_kind, source_ref, content,
              (expires_at IS NOT NULL AND expires_at <= now()) AS expired
         FROM prd_sources WHERE tenant_id = $1 AND repo = $2`,
      [tenantId, repo],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      kind: row.source_kind as PrdSourceKind,
      ref: row.source_ref,
      content: row.content,
      expired: row.expired,
    };
  }
}

/** Reads a repo file at a ref (repo_path/link sources). Adapter-backed in prod. */
export interface RepoFileReader {
  read(repo: string, path: string, ref: string): Promise<string | null>;
}

export class PrdResolver {
  constructor(
    private readonly sources: PrdSourceStore,
    private readonly reader?: RepoFileReader,
  ) {}

  /** Resolve the PRD text + a stable source_ref for this run, or null. */
  async resolve(run: RunIdentity): Promise<{ text: string; sourceRef: string } | null> {
    const source = await this.sources.getSource(run.tenantId, run.repo);
    if (!source) return null;

    if (source.kind === 'upload' || source.kind === 'paste') {
      // Expired raw content is treated as absent (retention, HARD-RULE-023).
      if (source.expired || source.content === null || source.content.trim().length === 0) {
        return null;
      }
      return { text: source.content, sourceRef: `${source.kind}:${source.ref}` };
    }

    // repo_path / link: read at the PR head SHA (frozen for the run).
    if (!this.reader) return null;
    const text = await this.reader.read(run.repo, source.ref, run.headSha);
    if (text === null || text.trim().length === 0) return null;
    return { text, sourceRef: `${source.kind}:${source.ref}@${run.headSha}` };
  }
}
