import { randomUUID } from 'node:crypto';
import type { GatewayClient, GatewayRequest } from '@review-bot/llm-client';
import { renderChunkPreamble } from '@review-bot/context-engine';
import type { AgentContext, AgentResult, ReviewAgent } from './agent.types.js';

/**
 * Shared reviewer implementation. Sprint 1 ships the Diff Reviewer
 * (FR-AGENT-002) and Security Reviewer (FR-AGENT-003); both share this
 * Gateway-calling core with different task types, risk levels, and role
 * instructions appended to the stable prefix per the prompt layout
 * (id="prompt-layout-v65"): stable prefix stays byte-identical across PRs,
 * all PR-specific content goes in the dynamic user message (FR-CTX-013/014).
 */
class GatewayReviewerAgent implements ReviewAgent {
  constructor(
    public readonly name: string,
    public readonly taskType: string,
    private readonly riskLevel: 'low' | 'medium' | 'high',
    private readonly gateway: GatewayClient,
  ) {}

  async run(ctx: AgentContext): Promise<AgentResult> {
    const dynamicSuffix = [
      `repo: ${ctx.run.repo}`,
      `pull_request_id: ${ctx.run.pullRequestId}`,
      `head_sha: ${ctx.run.headSha}`,
      // Requirement-aware review criteria (dynamic per-run, HARD-RULE-021).
      ...(ctx.prdCriteria ? ['', ctx.prdCriteria, ''] : []),
      `files under review:`,
      ...ctx.files.map(
        (f) => `- ${f.file.path}${f.highRisk ? ` [HIGH RISK: ${f.highRiskCategory}]` : ''}`,
      ),
      '',
      'diff:',
      ctx.diffText,
      // Chunked high-risk files with Symbol Skeletons — dynamic per-file
      // preamble per prompt layout (id="prompt-layout-v65").
      ...ctx.chunks.map((chunk) => `\n${renderChunkPreamble(chunk)}`),
    ].join('\n');

    const request: GatewayRequest = {
      tenant_id: ctx.run.tenantId,
      app_id: 'ci-review-bot',
      workflow_id: 'pr_review',
      request_id: randomUUID(),
      run_id: ctx.run.runId,
      repo: ctx.run.repo,
      pull_request_id: ctx.run.pullRequestId,
      head_sha: ctx.run.headSha,
      run_epoch: ctx.run.runEpoch,
      task_type: this.taskType,
      risk_level: this.riskLevel,
      data_class: 'internal',
      latency_class: 'batch',
      streaming_mode: 'disabled',
      expected_output: 'json_schema',
      cache_policy: 'provider_prefix_only',
      metadata_signature: 'unsigned-sprint1-stub',
      messages: [
        { role: 'system', content: ctx.stablePrefix },
        { role: 'user', content: dynamicSuffix },
      ],
    };

    try {
      const response = await this.gateway.complete(request, ctx.cancellation);
      return {
        agentName: this.name,
        taskType: this.taskType,
        rawOutput: response.content,
        ok: true,
        tokenInput: response.token_input,
        tokenOutput: response.token_output,
      };
    } catch (err) {
      return {
        agentName: this.name,
        taskType: this.taskType,
        rawOutput: '',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        tokenInput: 0,
        tokenOutput: 0,
      };
    }
  }
}

export function createDiffReviewerAgent(gateway: GatewayClient): ReviewAgent {
  return new GatewayReviewerAgent('diff-reviewer', 'code_review', 'medium', gateway);
}

export function createSecurityReviewerAgent(gateway: GatewayClient): ReviewAgent {
  return new GatewayReviewerAgent('security-reviewer', 'security_review', 'high', gateway);
}
