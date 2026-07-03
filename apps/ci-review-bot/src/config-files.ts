import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { HighRiskConfig } from '@review-bot/context-engine';
import {
  compileTaxonomy,
  type CompiledTaxonomy,
  type TaxonomyDocument,
} from '@review-bot/validators';

/**
 * YAML config loading — PRD v6.5 §9 required config files.
 * Sprint 4 loads the files the review path consumes:
 *   configs/review/high-risk-paths.yaml   (FR-RISK-001)
 *   configs/review/finding-taxonomy.yaml  (§16.3, FR-DEDUP-025)
 * Missing files fail closed to empty/strict defaults rather than guessed
 * values.
 */

export function loadHighRiskConfig(configRoot: string): HighRiskConfig {
  const path = join(configRoot, 'review/high-risk-paths.yaml');
  if (!existsSync(path)) return { categories: {} };
  const doc = parseYaml(readFileSync(path, 'utf8')) as {
    high_risk_paths?: Record<string, string[]>;
  };
  return { categories: doc.high_risk_paths ?? {} };
}

export function loadTaxonomy(configRoot: string, repoId?: string): CompiledTaxonomy {
  const path = join(configRoot, 'review/finding-taxonomy.yaml');
  if (!existsSync(path)) {
    // No taxonomy file → nothing is approved; every finding needs mapping
    // (fail closed, never fail open to arbitrary IDs).
    return { version: 'none', approvedIds: new Set(), aliasMap: new Map(), extensionParents: new Map() };
  }
  const doc = parseYaml(readFileSync(path, 'utf8')) as TaxonomyDocument;
  return compileTaxonomy(doc, repoId);
}
