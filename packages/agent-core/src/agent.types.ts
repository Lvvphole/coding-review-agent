import type { RunIdentity } from '@review-bot/shared';
import type { FileDecision } from '@review-bot/context-engine';

/**
 * Agent contract — FR-AGENT-007..012.
 * Agents receive full run identity plus a cancellation signal, call the
 * Gateway only, output strict JSON findings, and never post (HARD-RULE-009).
 */

export interface AgentContext {
  run: RunIdentity;
  /** Files selected by the context budgeter. */
  files: FileDecision[];
  /** Raw unified diff limited to selected files. */
  diffText: string;
  /** Stable global prompt prefix — FR-CTX-013/030; reusable across PRs. */
  stablePrefix: string;
  cancellation: AbortSignal;
}

export interface AgentResult {
  agentName: string;
  taskType: string;
  /** Raw JSON string returned by the model; parsed/validated downstream. */
  rawOutput: string;
  ok: boolean;
  error?: string;
}

export interface ReviewAgent {
  name: string;
  taskType: string;
  run(ctx: AgentContext): Promise<AgentResult>;
}
