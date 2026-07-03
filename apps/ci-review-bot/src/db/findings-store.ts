import type { Pool } from 'pg';
import type { ReviewFinding, RunIdentity } from '@review-bot/shared';

/**
 * Persists findings to review_findings (§24.2) so retention (HARD-RULE-047)
 * and the feedback flywheel have a durable target. Evidence and
 * suggested_patch are raw code and get redacted in place by the Control
 * Plane retention worker after the raw-data TTL.
 */
export async function persistFindings(
  pool: Pool,
  run: RunIdentity,
  findings: ReviewFinding[],
  disposition: string,
): Promise<void> {
  for (const f of findings) {
    await pool.query(
      `INSERT INTO review_findings
         (tenant_id, repo, pull_request_id, run_id, finding_id, severity, category, file, line,
          title, evidence, recommendation, suggested_patch, confidence, agent_source,
          root_cause_id, root_cause_family, taxonomy_version, disposition)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (run_id, finding_id) DO UPDATE SET disposition = EXCLUDED.disposition`,
      [
        run.tenantId,
        run.repo,
        run.pullRequestId,
        run.runId,
        f.finding_id,
        f.severity,
        f.category,
        f.file,
        f.line,
        f.title,
        f.evidence,
        f.recommendation,
        f.suggested_patch ?? null,
        f.confidence,
        f.agent_source,
        f.root_cause_id,
        f.root_cause_family,
        f.taxonomy_version,
        disposition,
      ],
    );
  }
}
