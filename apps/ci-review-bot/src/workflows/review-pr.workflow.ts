import type { ReviewFinding, RunIdentity } from '@review-bot/shared';
import {
  buildContextPlan,
  buildDiffLineIndex,
  chunkHighRiskFile,
  parseUnifiedDiff,
  type ContextPolicy,
  type FileChunk,
  type HighRiskConfig,
} from '@review-bot/context-engine';
import {
  dedupeFindings,
  validateFinding,
  type ValidationPolicy,
} from '@review-bot/validators';
import {
  runAgentsAllSettled,
  STABLE_REVIEW_PREFIX,
  type ReviewAgent,
} from '@review-bot/agent-core';

/**
 * Core review pipeline: deterministic filters → agents → validators → dedupe.
 * (HARD-RULE-007/008; §4.2 desired-state ordering.)
 * Posting is a separate workflow behind the posting guard.
 */

export interface ReviewPipelineResult {
  validated: ReviewFinding[];
  rejected: { finding: ReviewFinding; disposition: string; reasons: string[] }[];
  needsTaxonomyMapping: ReviewFinding[];
  skippedFiles: { path: string; reason: string }[];
  blockedHighRiskFiles: string[];
  /** High-risk files reviewed via chunking + Symbol Skeleton (FR-CTX-020). */
  chunkedFiles: string[];
  agentErrors: { agentName: string; error: string }[];
}

export async function runReviewPipeline(input: {
  run: RunIdentity;
  diffText: string;
  agents: ReviewAgent[];
  contextPolicy: ContextPolicy;
  highRisk: HighRiskConfig;
  validationPolicy: ValidationPolicy;
  reviewIgnoreContent?: string;
  cancellation: AbortSignal;
}): Promise<ReviewPipelineResult> {
  // Deterministic filters before LLM use (HARD-RULE-007).
  const files = parseUnifiedDiff(input.diffText);
  const planInput: Parameters<typeof buildContextPlan>[1] = {
    policy: input.contextPolicy,
    highRisk: input.highRisk,
  };
  if (input.reviewIgnoreContent !== undefined) {
    planInput.reviewIgnoreContent = input.reviewIgnoreContent;
  }
  const plan = buildContextPlan(files, planInput);

  // High-risk oversized files are chunked, never silently skipped
  // (HARD-RULE-020, FR-CTX-015): each chunk carries the whole-file Symbol
  // Skeleton as dynamic context. Files whose chunking yields nothing are
  // reported blocked (FR-CTX-021/022).
  const chunks: FileChunk[] = [];
  const stillBlocked: string[] = [];
  for (const decision of plan.blockedHighRisk) {
    const fileChunks = chunkHighRiskFile(decision.file, {
      policy: { maxChunkLines: input.contextPolicy.maxChunkLines ?? 200 },
      reason: decision.highRiskCategory ?? 'high_risk',
    });
    if (fileChunks.length > 0) chunks.push(...fileChunks);
    else stillBlocked.push(decision.file.path);
  }

  const includedPaths = new Set([
    ...plan.included.map((d) => d.file.path),
    ...chunks.map((c) => c.filePath),
  ]);
  const diffIndexAll = buildDiffLineIndex(files.filter((f) => includedPaths.has(f.path)));

  // Agents run with all-settled isolation (FR-AGENT-011/012).
  const results = await runAgentsAllSettled(input.agents, {
    run: input.run,
    files: plan.included,
    diffText: input.diffText,
    chunks,
    stablePrefix: STABLE_REVIEW_PREFIX,
    cancellation: input.cancellation,
  });

  const agentErrors = results
    .filter((r) => !r.ok)
    .map((r) => ({ agentName: r.agentName, error: r.error ?? 'unknown' }));

  // Validators after LLM use (HARD-RULE-008).
  const validated: ReviewFinding[] = [];
  const rejected: ReviewPipelineResult['rejected'] = [];
  const needsTaxonomyMapping: ReviewFinding[] = [];

  for (const result of results) {
    if (!result.ok) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.rawOutput);
    } catch {
      rejected.push({
        finding: { finding_id: `${result.agentName}-unparseable` } as ReviewFinding,
        disposition: 'REJECTED_SCHEMA',
        reasons: ['agent output is not valid JSON (FR-AGENT-009)'],
      });
      continue;
    }
    const rawFindings = Array.isArray(parsed) ? parsed : [parsed];
    for (const raw of rawFindings) {
      const v = validateFinding(raw, diffIndexAll, input.validationPolicy);
      if (v.disposition === 'VALIDATED') {
        validated.push(v.finding);
      } else if (v.disposition === 'NEEDS_TAXONOMY_MAPPING') {
        // Blocks the finding, not the run (FORBIDDEN-022); routed to Control
        // Plane asynchronously (FR-DEDUP-029) in a later sprint.
        needsTaxonomyMapping.push(v.finding);
      } else {
        rejected.push({ finding: v.finding, disposition: v.disposition, reasons: v.reasons });
      }
    }
  }

  // Deterministic-first dedupe (§17); runs before final verification (FR-DEDUP-006).
  const deduped = dedupeFindings(
    validated.map((finding) => ({
      finding,
      headSha: input.run.headSha,
      lineRange: { start: finding.line, end: finding.line },
    })),
  );

  return {
    validated: deduped,
    rejected,
    needsTaxonomyMapping,
    skippedFiles: plan.skipped.map((d) => ({ path: d.file.path, reason: d.skipReason ?? 'unknown' })),
    blockedHighRiskFiles: stillBlocked,
    chunkedFiles: [...new Set(chunks.map((c) => c.filePath))],
    agentErrors,
  };
}
