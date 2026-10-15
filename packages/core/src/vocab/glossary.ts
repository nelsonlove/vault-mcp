// glossary.ts — the glossary VocabularyProvider: the vault's term vocabulary,
// over a supplied note listing.
//
// Three surfaces feed it (the deleted obsidian-new `defines:`/`Terms.base`
// scheme is deliberately absent — the VocabEntry shape leaves room for it, but
// the provider parses what the vault actually has):
//
//   (a) TERM NOTES — notes whose `type` is `Topic/Term` (the live model: about
//       651 notes, measured 2026-10-14, #551): term = `title` frontmatter
//       (fallback: basename), gloss = `description`, aliases = `aliases`. The
//       key and the class are config (`typeKey`, `termType`). Frontmatter alone
//       carries the sense, so no body read is needed.
//   (b) DEFINITION NOTES — notes carrying a definition tag, the retired
//       `note/definition` convention (0 notes on 2026-10-14). OFF by default
//       (`definitionTag: ""`); a vault still on that convention sets the tag.
//   (c) `## Terms` SECTIONS — `- **term** — definition` bullets under a
//       `## Terms` heading (the framework chapters' controlled-vocabulary
//       lists). Bullets under any other heading are prose, not vocabulary.
//
// Terms resolve case-insensitively (**drift** in running text, `Drift` as a
// title) but the canonical form keeps its declared case. Ambiguity refuses:
// one token carrying two different senses is a vocabulary problem for a human,
// not something resolution may paper over — except EXACT duplicates (same
// term, same definition), which collapse to the first declaration.
//
// Kernel-module rules: pure, no `obsidian` imports, no I/O.

import {
  asStrings,
  VocabAmbiguousError,
  type VocabCapabilities,
  type VocabEntry,
  type VocabFinding,
  type VocabKind,
  type VocabularyProvider,
} from "./provider.js";
import type { VocabNote } from "./blueprint.js";

export interface GlossaryConfig {
  /** The frontmatter key naming a note's class. */
  typeKey?: string;
  /** The class that marks a term note; "" = no term notes. */
  termType?: string;
  /** A tag that also marks a definition note (the retired convention); "" =
   * off. */
  definitionTag?: string;
}

/** Today's live shape (2026-10-14, #551): `type: Topic/Term`; the
 * `note/definition` tag is retired, so it is off. */
export const DEFAULT_GLOSSARY_CONFIG: Required<GlossaryConfig> = {
  typeKey: "type",
  termType: "Topic/Term",
  definitionTag: "",
};

/** `[[A/Topic/Term.md|alias]]` → `A/Topic/Term`; plain values pass through. */
function classInner(v: string): string {
  const inner = v.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
  return inner.replace(/\.fileclass$/, "").replace(/\.md$/, "");
}

/** Does the class value name `termType`? The plain class (`Topic/Term`) or a
 * wikilinked path to it, matched by suffix. */
function isTermType(value: unknown, termType: string): boolean {
  return asStrings(value).some((v) => {
    const inner = classInner(v);
    return inner === termType || inner.endsWith("/" + termType);
  });
}

const SUPERSEDED = /^\[superseded\]/i;

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  const name = i === -1 ? path : path.slice(i + 1);
  return name.replace(/\.md$/, "");
}

/** `- **term** — definition` bullets under a `## Terms` heading (any dash
 * form after the closing `**`). The section ends at the next `## ` heading. */
export function parseTermsSection(body: string): Array<{ term: string; definition: string }> {
  const out: Array<{ term: string; definition: string }> = [];
  let inTerms = false;
  for (const line of body.split("\n")) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      inTerms = heading[1].trim() === "Terms";
      continue;
    }
    if (!inTerms) continue;
    const bullet = line.match(/^-\s+\*\*(.+?)\*\*\s*[—–-]+\s*(.*)$/);
    if (bullet) out.push({ term: bullet[1].trim(), definition: bullet[2].trim() });
  }
  return out;
}

function definitionEntries(cfg: Required<GlossaryConfig>, listing: VocabNote[]): VocabEntry[] {
  const entries: VocabEntry[] = [];
  for (const note of listing) {
    const fm = note.frontmatter;
    if (!fm) continue;
    const byType = cfg.termType !== "" && isTermType(fm[cfg.typeKey], cfg.termType);
    const byTag = cfg.definitionTag !== "" && asStrings(fm.tags).includes(cfg.definitionTag);
    if (!byType && !byTag) continue;
    const canonical = typeof fm.title === "string" && fm.title !== "" ? fm.title : basename(note.path);
    entries.push({
      canonical,
      kind: "term",
      path: note.path,
      aliases: asStrings(fm.aliases),
      definition: typeof fm.description === "string" ? fm.description : null,
      parent: null,
      deprecated: SUPERSEDED.test(basename(note.path)),
    });
  }
  return entries;
}

function sectionEntries(listing: VocabNote[]): VocabEntry[] {
  const entries: VocabEntry[] = [];
  for (const note of listing) {
    if (!note.body) continue;
    for (const { term, definition } of parseTermsSection(note.body)) {
      entries.push({
        canonical: term,
        kind: "term",
        path: note.path,
        aliases: [],
        definition,
        parent: null,
        deprecated: false,
      });
    }
  }
  return entries;
}

/** The effective config: `config` over the defaults, ignoring wrong-typed
 * values. */
export function resolveGlossaryConfig(config: Record<string, unknown> | GlossaryConfig | undefined): Required<GlossaryConfig> {
  const c = (config ?? {}) as Record<string, unknown>;
  const str = (k: keyof GlossaryConfig): string => (typeof c[k] === "string" ? (c[k] as string).trim() : DEFAULT_GLOSSARY_CONFIG[k]);
  const typeKey = str("typeKey");
  return { typeKey: typeKey === "" ? DEFAULT_GLOSSARY_CONFIG.typeKey : typeKey, termType: str("termType"), definitionTag: str("definitionTag") };
}

export function glossaryProvider(config: GlossaryConfig, listing: VocabNote[]): VocabularyProvider {
  const cfg = resolveGlossaryConfig(config);
  const capabilities: VocabCapabilities = {
    validate: true,
    resolveDefinition: true,
    hierarchical: false,
    deprecations: true,
  };

  const entries = [...definitionEntries(cfg, listing), ...sectionEntries(listing)].sort((a, b) =>
    a.canonical.toLowerCase() < b.canonical.toLowerCase() ? -1 : a.canonical.toLowerCase() > b.canonical.toLowerCase() ? 1 : 0
  );

  const normalize = (raw: string): string => raw.trim();

  /** Entries claiming a token — by canonical or alias, case-insensitively —
   * with EXACT duplicates (same canonical, same definition) collapsed to the
   * first declaration. */
  function candidates(token: string): VocabEntry[] {
    const t = token.toLowerCase();
    const found = entries.filter(
      (e) => e.canonical.toLowerCase() === t || e.aliases.some((a) => a.toLowerCase() === t)
    );
    const seen = new Set<string>();
    return found.filter((e) => {
      const key = `${e.canonical.toLowerCase()}\u0000${e.definition ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function validateToken(rawToken: string, kind: VocabKind): VocabFinding[] {
    if (kind !== "term") return [];
    const token = normalize(rawToken);
    const found = candidates(token);
    if (found.length === 0) {
      return [{ code: "unknown_term", token, path: null, detail: `'${token}' is not a defined term` }];
    }
    if (found.every((e) => e.deprecated)) {
      return [
        {
          code: "deprecated",
          token,
          path: null,
          detail: `'${token}' is deprecated — declared at ${found.map((e) => e.path).join(", ")}`,
        },
      ];
    }
    return [];
  }

  function resolve(rawToken: string, kind: VocabKind): VocabEntry | null {
    if (kind !== "term") return null;
    const token = normalize(rawToken);
    const found = candidates(token);
    if (found.length === 0) return null;
    if (found.length > 1) {
      throw new VocabAmbiguousError(token, "term", found.map((e) => e.path ?? "<pathless>"));
    }
    return found[0];
  }

  function list(kind: VocabKind, scope?: string): VocabEntry[] {
    if (kind !== "term") return [];
    if (scope === undefined || scope === "") return entries;
    return entries.filter((e) => e.path !== null && (e.path === scope || e.path.startsWith(scope + "/")));
  }

  return { capabilities, kinds: ["term"], normalize, validateToken, resolve, list };
}
