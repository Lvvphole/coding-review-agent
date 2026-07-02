import type { AgentContext, AgentResult, ReviewAgent } from './agent.types.js';

/**
 * Agent orchestration with all-settled collection — FR-AGENT-011/012.
 * A failed agent is isolated and does not crash the full review
 * (FR-DEDUP-002); failures surface as failed AgentResults.
 */
export async function runAgentsAllSettled(
  agents: ReviewAgent[],
  ctx: AgentContext,
): Promise<AgentResult[]> {
  const settled = await Promise.allSettled(agents.map((a) => a.run(ctx)));
  return settled.map((s, i) => {
    const agent = agents[i]!;
    if (s.status === 'fulfilled') return s.value;
    return {
      agentName: agent.name,
      taskType: agent.taskType,
      rawOutput: '',
      ok: false,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });
}
