/**
 * Canonical taxonomy compilation — PRD v6.5 §16, HARD-RULE-030.
 *
 * Repository extensions may add IDs under a global parent but may never
 * override or rename global canonical IDs (FORBIDDEN-024, TAX-003/004).
 * Deduplication and validation consume only the compiled result; free-text
 * descriptions are never authoritative (TAXONOMY-INV-001, FR-AGENT-014).
 */

export interface TaxonomyEntry {
  id: string;
  family: string;
  category: string;
  aliases?: string[];
}

export interface RepositoryExtension extends TaxonomyEntry {
  parent_id: string;
}

export interface TaxonomyDocument {
  taxonomy: {
    version: string;
    global: TaxonomyEntry[];
    repository_extensions?: {
      enabled: boolean;
      rules: { repo_id: string; allowed_extensions: RepositoryExtension[] }[];
    };
  };
}

export interface CompiledTaxonomy {
  version: string;
  /** All approved canonical IDs (global + validated extensions). */
  approvedIds: Set<string>;
  /** lowercased alias → canonical id (TAX-005). */
  aliasMap: Map<string, string>;
  /** extension id → global parent id. */
  extensionParents: Map<string, string>;
}

export class TaxonomyCompileError extends Error {
  constructor(
    message: string,
    public readonly code: 'OVERRIDE_GLOBAL_ID' | 'MISSING_PARENT' | 'UNKNOWN_PARENT' | 'DUPLICATE_ALIAS',
  ) {
    super(message);
    this.name = 'TaxonomyCompileError';
  }
}

export function compileTaxonomy(doc: TaxonomyDocument, repoId?: string): CompiledTaxonomy {
  const approvedIds = new Set<string>();
  const aliasMap = new Map<string, string>();
  const extensionParents = new Map<string, string>();

  const addAlias = (alias: string, id: string) => {
    const key = alias.toLowerCase().trim();
    const existing = aliasMap.get(key);
    if (existing !== undefined && existing !== id) {
      throw new TaxonomyCompileError(
        `alias "${alias}" maps to both ${existing} and ${id}`,
        'DUPLICATE_ALIAS',
      );
    }
    aliasMap.set(key, id);
  };

  for (const entry of doc.taxonomy.global) {
    approvedIds.add(entry.id);
    addAlias(entry.id, entry.id);
    for (const alias of entry.aliases ?? []) addAlias(alias, entry.id);
  }

  const rules = doc.taxonomy.repository_extensions?.enabled
    ? (doc.taxonomy.repository_extensions.rules ?? [])
    : [];
  for (const rule of rules) {
    if (repoId !== undefined && rule.repo_id !== repoId) continue;
    for (const ext of rule.allowed_extensions) {
      // TAX-004 / FORBIDDEN-024: extensions may not override global IDs.
      if (approvedIds.has(ext.id) && !extensionParents.has(ext.id)) {
        throw new TaxonomyCompileError(
          `extension ${ext.id} overrides a global canonical taxonomy ID`,
          'OVERRIDE_GLOBAL_ID',
        );
      }
      // TAX-003: every extension requires a parent_id.
      if (!ext.parent_id) {
        throw new TaxonomyCompileError(`extension ${ext.id} has no parent_id`, 'MISSING_PARENT');
      }
      // The parent must be a GLOBAL canonical ID (§15.1 rules).
      if (!doc.taxonomy.global.some((g) => g.id === ext.parent_id)) {
        throw new TaxonomyCompileError(
          `extension ${ext.id} parent ${ext.parent_id} is not a global canonical ID`,
          'UNKNOWN_PARENT',
        );
      }
      approvedIds.add(ext.id);
      extensionParents.set(ext.id, ext.parent_id);
      addAlias(ext.id, ext.id);
      for (const alias of ext.aliases ?? []) addAlias(alias, ext.id);
    }
  }

  return { version: doc.taxonomy.version, approvedIds, aliasMap, extensionParents };
}

/**
 * Root-cause mapper — maps an agent-emitted root_cause_id (canonical ID or
 * known alias) to the canonical taxonomy ID. Returns null when unmappable →
 * the finding receives NEEDS_TAXONOMY_MAPPING (TAX-006, FR-DEDUP-026).
 */
export function mapRootCause(taxonomy: CompiledTaxonomy, rawRootCause: string): string | null {
  if (taxonomy.approvedIds.has(rawRootCause)) return rawRootCause;
  return taxonomy.aliasMap.get(rawRootCause.toLowerCase().trim()) ?? null;
}
