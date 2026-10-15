// findings.ts — pure conformance findings over one note's vocabulary use.
//
// NOT registered as a tool, deliberately (Conformance README: "capabilities
// arrive as rule packs, never as new surface") — the rail mounts this later;
// until then `obsidian_validate_terms` exposes the same computation for a
// single named note, which is a lookup, not a rail.
//
// Alignment with the rail's existing checks: `unregistered_tag` reproduces
// drift_audit's check H semantics (prefix-permissive via the blueprint
// provider, report-only in spirit); `undefined_property` / `unknown_type` are
// the registration checks the rail does not have today (its check G validates
// naming self-consistency only). Deprecation and ambiguity are this module's
// own additions.
//
// Multiple providers may serve one kind (two registries, say): a token is
// clean when ANY provider serving its kind accepts it — vocabularies are
// additive, not intersecting. Findings carry the NOTE's path (they are about
// the note), where a provider's own validateToken carries null.

import { asStrings, VocabAmbiguousError, type VocabFinding, type VocabKind, type VocabularyProvider } from "./provider.js";

export interface NoteVocabInput {
  path: string;
  frontmatter: Record<string, unknown> | null;
}

/** `[[A/B/Name.fileclass|alias]]` → `Name` (how Obsidian resolves a wikilink:
 * by basename); plain values pass through with any `.fileclass` dropped. */
function typeToken(v: string): string {
  const inner = v.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
  const base = inner.split("/").pop() ?? inner;
  return base.replace(/\.fileclass$/, "");
}

/** The type-bearing frontmatter key. Its VALUE is checked as a type, so the
 * KEY itself is exempt from the property check — flagging it as an undefined
 * property beside the type finding would be noise, twice, forever. */
const TYPE_KEY = "fileClass";

/** One token against every provider serving its kind: clean when any accepts
 * AND resolves cleanly — additive holds through ambiguity too, so one
 * provider's internal duplicate cannot override another's clean acceptance.
 * Otherwise: an ambiguity seen anywhere outranks ordinary findings (it is the
 * more actionable problem), else the FIRST provider's findings, re-anchored
 * to the note. */
function check(
  token: string,
  kind: VocabKind,
  notePath: string,
  providers: VocabularyProvider[]
): VocabFinding[] {
  const serving = providers.filter((p) => p.kinds.includes(kind));
  if (serving.length === 0) return [];
  let first: VocabFinding[] | null = null;
  let ambiguous: VocabFinding | null = null;
  for (const p of serving) {
    const found = p.validateToken(token, kind);
    if (found.length === 0) {
      // Accepted — but an accepted token may still be ambiguous to resolve.
      try {
        p.resolve(token, kind);
        return [];
      } catch (e) {
        if (!(e instanceof VocabAmbiguousError)) throw e;
        ambiguous = ambiguous ?? {
          code: "ambiguous",
          token,
          path: notePath,
          detail: `'${token}' (${kind}) has ${e.candidates.length} senses: ${e.candidates.join(", ")}`,
        };
      }
      continue;
    }
    first = first ?? found;
  }
  if (ambiguous) return [ambiguous];
  return (first ?? []).map((f) => ({ ...f, path: notePath }));
}

const MALFORMED_TAG = /\s/;

export function noteVocabFindings(note: NoteVocabInput, providers: VocabularyProvider[]): VocabFinding[] {
  const fm = note.frontmatter;
  if (!fm) return [];
  const findings: VocabFinding[] = [];

  // tags — frontmatter `tags`, whitespace is malformed before it is unregistered
  for (const raw of asStrings(fm.tags)) {
    const token = raw.trim();
    if (token === "" || MALFORMED_TAG.test(token)) {
      findings.push({
        code: "malformed_token",
        token: raw,
        path: note.path,
        detail: `'${raw}' is not a well-formed tag`,
      });
      continue;
    }
    findings.push(...check(token, "tag", note.path, providers));
  }

  // properties — every top-level frontmatter key except the type-bearing one
  for (const key of Object.keys(fm)) {
    if (key === TYPE_KEY) continue;
    findings.push(...check(key, "property", note.path, providers));
  }

  // types — the fileClass values, wikilink-resolved by basename
  for (const raw of asStrings(fm[TYPE_KEY])) {
    findings.push(...check(typeToken(raw), "type", note.path, providers));
  }

  // provider-specific whole-note checks (the optional `noteFindings` seam —
  // e.g. the scope-tags placement gate, which needs the note's PATH to walk
  // its folder chain to the root scope note)
  for (const p of providers) {
    if (p.noteFindings) findings.push(...p.noteFindings(note));
  }

  return findings;
}

/** The source-level findings of every provider that has them (the optional
 * `registryFindings` seam), once — never per note. Paths, when a finding has
 * one, are the declaring notes'; `scope_root_missing` has none. */
export function vocabularyFindings(providers: VocabularyProvider[]): VocabFinding[] {
  return providers.flatMap((p) => p.registryFindings?.() ?? []);
}
