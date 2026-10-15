// provider.ts — the VocabularyProvider contract: the seam between the kernel's
// vocab-agnostic term operations and a concrete controlled-vocabulary source.
// The registry blueprints (blueprint.ts) and the glossary (glossary.ts) are the
// first implementations; other sources plug in behind the same shape later.
// Kernel-module rules apply: nothing here imports from "obsidian", not even
// types — every provider is pure and unit-testable without a vault.
//
// The counterpart split (scope-provider design doc, "The primitives"): the
// scope provider's grammar ranges over ITEM IDENTITIES (addresses); this
// module's ranges over CLASSIFICATION TOKENS — registered tags, property keys,
// type names, glossary terms. A provider never mints identity and never
// mutates a note: validation and resolution only.

/** What a provider can do. `validate` is always true — every vocabulary can at
 * least recognize an unregistered token. The rest are source-dependent:
 *   - resolveDefinition: entries carry a gloss (glossary: yes; a bare tag
 *     list would not).
 *   - hierarchical: entries nest (tag namespaces, type `extends` chains).
 *   - deprecations: the source distinguishes superseded/retired entries.
 */
export interface VocabCapabilities {
  validate: true;
  resolveDefinition: boolean;
  hierarchical: boolean;
  deprecations: boolean;
}

/** The kinds of vocabulary this module ranges over. `tag` / `property` /
 * `type` come from the registry blueprints; `term` from the glossary. GTD-style
 * `@context` classification tokens are tags by another name and need no kind of
 * their own. */
export type VocabKind = "tag" | "property" | "type" | "term";

/**
 * One entry of the controlled vocabulary.
 *
 * `canonical` is the resolved token — the form a conforming note uses
 * (`meta/type` for a tag, `acceptance-status` for a property, `Task` for a
 * type, `Canonical` for a term). `path` is the vault note that DECLARES the
 * entry (the registry entry / fileclass / definitional note), null only when
 * an entry has no declaring note of its own. `parent` is the enclosing entry's
 * canonical form where the vocabulary nests (`meta` for `meta/type`; the
 * `extends` target for a type), null at a root or in a flat vocabulary.
 */
export interface VocabEntry {
  canonical: string;
  kind: VocabKind;
  path: string | null;
  aliases: string[];
  /** The gloss — for a registry entry its `description`, for a term its
   * definition sentence. Null when the source carries none. */
  definition: string | null;
  parent: string | null;
  deprecated: boolean;
}

/** One thing wrong (or worth flagging) about a token or a note's vocabulary
 * use. `path` is the note the finding is ABOUT (null for a bare-token check);
 * `token` is the offending vocabulary token. */
export interface VocabFinding {
  code:
    | "unregistered_tag"
    | "undefined_property"
    | "unknown_type"
    | "unknown_term"
    | "deprecated"
    | "ambiguous"
    | "malformed_token"
    // the scope-tags provider's whole-vault pack (the `## Tags` table model,
    // #551; it replaced #251's allowedTags_unregistered, registry_entry_untagged
    // and registry_duplicate, which described the retired Meta/Tag registry)
    | "tag_unregistered"
    | "tag_out_of_scope"
    | "tag_declared_twice_on_chain"
    | "tag_declared_on_two_branches"
    | "scope_root_missing";
  token: string;
  path: string | null;
  detail: string;
}

/** Frontmatter list-or-scalar coercion: Obsidian accepts both `tags: x` and
 * `tags:\n  - x`, so every consumer of a list-shaped key goes through this one
 * helper — two sibling surfaces must never disagree about the same note. */
export function asStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return [v];
  return [];
}

/** Resolution found more than one sense and refuses to pick — the caller
 * decides, exactly like uid/address ambiguity. `candidates` names the
 * declaring paths (or, pathless, the senses) so the refusal is actionable. */
export class VocabAmbiguousError extends Error {
  constructor(
    readonly token: string,
    readonly kind: VocabKind,
    readonly candidates: string[]
  ) {
    super(
      `'${token}' (${kind}) has ${candidates.length} senses — refusing to pick: ${candidates.join(", ")}`
    );
    this.name = "VocabAmbiguousError";
  }
}

/**
 * A pluggable controlled-vocabulary source. Every method is pure — no I/O, no
 * `obsidian` import. A provider is CONSTRUCTED over a supplied note listing
 * (the tool layer feeds it vault state); the provider never reads the vault
 * itself.
 */
export interface VocabularyProvider {
  readonly capabilities: VocabCapabilities;
  /** The kinds this provider actually serves (a registry serves tag /
   * property / type; a glossary serves term). */
  readonly kinds: VocabKind[];

  /** The comparison form of a raw token: trimmed, `#`-stripped for tags —
   * NOT case-folded for kinds whose canonical form is cased. */
  normalize(raw: string): string;

  /** Findings about one token in isolation (unregistered, malformed,
   * deprecated). Empty means the token is fine. */
  validateToken(token: string, kind: VocabKind): VocabFinding[];

  /** The entry a token resolves to. Null when unknown; throws
   * `VocabAmbiguousError` when more than one sense claims the token —
   * resolution never picks. */
  resolve(token: string, kind: VocabKind): VocabEntry | null;

  /** Every entry of a kind, optionally only those declared under the `scope`
   * path prefix. */
  list(kind: VocabKind, scope?: string): VocabEntry[];

  /** OPTIONAL: provider-specific findings about one whole note — checks that
   * need the note's path or its full frontmatter, beyond per-token
   * validation (the scope-tags provider's placement gate lives here). Called
   * by `noteVocabFindings` for every provider that implements it; findings
   * carry the note's path. */
  noteFindings?(note: { path: string; frontmatter: Record<string, unknown> | null }): VocabFinding[];
}
