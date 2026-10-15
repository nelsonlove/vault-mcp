// registry.ts — VocabRegistry: vocabulary-provider instances from settings.
//
// Mirrors the scope-provider's `schemes` settings shape: a `vocabularies`
// array of `{ id, provider, root, config }`. The registry owns the root
// confinement (it pre-filters the supplied listing before construction, so
// every provider sees only its own territory) and the settings hygiene:
// unknown provider names and duplicate ids are SKIPPED AND REPORTED via
// `problems`, never thrown — settings are user-edited, and one bad row must
// not take the whole vocabulary surface down.
//
// Kernel-module rules: pure, no `obsidian` imports. `build` is called by the
// tool layer with a fresh listing per call — providers are snapshots, not
// live indexes (the vocabulary is small and changes rarely; an index with
// event wiring is the uid store's problem, not this module's).

import { blueprintProvider, type VocabNote } from "./blueprint.js";
import { glossaryProvider, type GlossaryConfig } from "./glossary.js";
import { scopeTagsProvider, validateScopeTagsConfig, resolveScopeTagsConfig } from "./scope-tags.js";
import type { VocabularyProvider } from "./provider.js";

/** The provider names a vocabulary instance may name — the single source of
 * truth for both the registry's skip-unknown check and the settings-tab
 * provider dropdown (connection-ui.ts), so the two cannot drift. */
export const VOCAB_PROVIDERS = ["blueprint", "glossary", "scope-tags"] as const;
export type VocabProviderName = (typeof VOCAB_PROVIDERS)[number];

export function isVocabProvider(name: unknown): name is VocabProviderName {
  return typeof name === "string" && (VOCAB_PROVIDERS as readonly string[]).includes(name);
}

/** Per-provider config validators (a provider validates its OWN config
 * namespace, the scheme registry's `validateJdConfig` pattern). Absent means
 * the provider takes any config shape it can coerce. */
const CONFIG_VALIDATORS: Partial<Record<VocabProviderName, (config: unknown) => string[]>> = {
  "scope-tags": validateScopeTagsConfig,
};

export interface VocabInstanceSettings {
  id: string;
  /** Provider name: "scope-tags" (scope notes' `## Tags` tables), "blueprint"
   * (gen-old registry grammar), or "glossary" (terms). */
  provider: string;
  /** Vault-relative path prefix this vocabulary is read from; "" = whole vault. */
  root: string;
  config?: Record<string, unknown>;
}

export const DEFAULT_VOCABULARIES: VocabInstanceSettings[] = [
  // The live tag model (vault spec 01.13 rules 5a, 6 and 6a; read from the
  // vault 2026-10-14, #551): each scope note's `## Tags` table declares the
  // tags it owns, and a note's allowed set is the union of the tables up its
  // scope chain to the root scope note (`00 System management`, the folder
  // note of category 00), whose table declares the families every note may
  // carry. Served by the scope-tags provider over the whole vault. It replaced
  // the #251 model (`Meta/Tag` registry notes, `allowedTags` frontmatter keys,
  // a vault-root `The system.md`), which the vault retired; that model had in
  // turn replaced the gen-old "registry" blueprint instance, whose
  // `.tag.md` / `.property.md` / `.fileclass` grammar has no live surface. The
  // blueprint provider itself remains available via settings for vaults still
  // on that grammar. The root note's path is the provider's DEFAULT, not a row
  // config, and a dead one is loud: `scope_root_missing`.
  { id: "scope-tags", provider: "scope-tags", root: "" },
  // The glossary serves term notes (`type: Topic/Term`, the live model) and
  // ships with NO `termsRoot`: the plugin ships no vault layout (the #403
  // ruling, applied here). The default used to name one vault's framework
  // folder and went dead three times as that folder was renamed (`Assent` →
  // `00.89 obsidian-governor` → `00.89 obsidian-mcp-suite`), each time failing
  // SILENTLY: a dead termsRoot returns no terms rather than an error. Without
  // it the vocab satellite reads no `## Terms` bodies; an operator who wants
  // the `## Terms` chapters sets `termsRoot` in the satellite's settings, where
  // an install upgrading from the host adopts the value it already had.
  // termsRoot is read by the TOOL layer (it decides which bodies to read); the
  // provider itself parses whatever bodies arrive.
  { id: "glossary", provider: "glossary", root: "" },
];

export interface VocabInstance {
  id: string;
  providerName: string;
  root: string;
  provider: VocabularyProvider;
}

function underRoot(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(root + "/");
}

export class VocabRegistry {
  readonly problems: string[] = [];
  private readonly rows: VocabInstanceSettings[] = [];

  constructor(settings: VocabInstanceSettings[]) {
    const seen = new Set<string>();
    for (const row of settings) {
      if (seen.has(row.id)) {
        this.problems.push(`duplicate vocabulary id '${row.id}' — first declaration wins`);
        continue;
      }
      // Reserve the id BEFORE the provider check: a skipped row still claims
      // its id, so a later reuse reports as the duplicate it is (the sibling
      // module registry's review found exactly this gap — ef94556).
      seen.add(row.id);
      if (!isVocabProvider(row.provider)) {
        this.problems.push(`unknown vocabulary provider '${row.provider}' (id '${row.id}') — skipped`);
        continue;
      }
      // Per-provider config validation, the scheme registry's pattern: an
      // invalid config skips that ONE instance and reports, never throws.
      const validate = CONFIG_VALIDATORS[row.provider as VocabProviderName];
      const configProblems = validate ? validate(row.config) : [];
      if (configProblems.length > 0) {
        this.problems.push(
          `invalid config for vocabulary '${row.id}' (${row.provider}): ${configProblems.join("; ")} — skipped`
        );
        continue;
      }
      this.rows.push(row);
    }
  }

  /** Provider instances over `listing`, one per configured vocabulary, each
   * confined to its own root. */
  build(listing: VocabNote[]): VocabInstance[] {
    return this.rows.map((row) => {
      const scoped = listing.filter((n) => underRoot(n.path, row.root));
      const provider =
        row.provider === "blueprint"
          ? blueprintProvider({ root: "" }, scoped)
          : row.provider === "scope-tags"
            ? scopeTagsProvider(resolveScopeTagsConfig(row.config), scoped)
            : glossaryProvider((row.config ?? {}) as GlossaryConfig, scoped);
      return { id: row.id, providerName: row.provider, root: row.root, provider };
    });
  }
}
