/** Review finding — PRD v6.5 §18 (id="review-finding-schema-v65"). */
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'bug',
  'security',
  'test_gap',
  'performance',
  'maintainability',
  'style',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type FindingDisposition =
  | 'VALIDATED'
  | 'REJECTED_SCHEMA'
  | 'REJECTED_EVIDENCE'
  | 'REJECTED_LINE_MAPPING'
  | 'REJECTED_CONFIDENCE'
  | 'DEDUPED'
  | 'NEEDS_TAXONOMY_MAPPING'
  | 'POSTED'
  | 'STALE_DISCARDED';

export type RootCauseSource = 'global' | 'organization_extension' | 'repository_extension';

/** Which dedupe tier matched — FR-AST-004. */
export type DedupeTier = 'exact' | 'ast' | 'line-overlap' | 'embedding-candidate';

export interface ReviewFinding {
  finding_id: string;
  severity: Severity;
  category: Category;
  file: string;
  line: number;
  title: string;
  evidence: string;
  recommendation: string;
  suggested_patch?: string;
  confidence: number;
  agent_source: string;
  root_cause_id: string;
  root_cause_family: string;
  root_cause_source: RootCauseSource;
  taxonomy_version: string;
  repo_root_cause_id?: string;
  merged_from?: string[];
  disposition?: FindingDisposition;
  /** FR-AST-003: whether AST support was used for this finding's file. */
  ast_supported?: boolean;
  /** FR-AST-004: dedupe tier that merged this finding, when merged. */
  dedupe_tier?: DedupeTier;
  /**
   * Deterministic evidence flag — HARD-RULE-039. True only when evidence was
   * corroborated by a deterministic source (diff text match, lint, static scan),
   * never by LLM assertion alone.
   */
  deterministic_evidence?: boolean;
}
