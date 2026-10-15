// packs/structure.ts — the structure rule pack: a verbatim TypeScript port of
// conformance_check.py, the blueprint-conformance guard.
//
// The Blueprint plugin owns a note's body structure. On apply, a heading the
// blueprint does not emit is not emitted at all — its content is gone. This
// pack derives each blueprint's emitted H2 set from its source (literal `## `
// lines, `{# #}` comments removed, one level of `{% include %}` resolved,
// `___REST___` fork sections stripped) and compares it to the H2 set of every
// note whose `blueprint:` frontmatter names it.
//
// Findings the ratchet keys (conformance_ratchet.py's `parse_conformance`):
//   - DROPPED — the note carries an H2 its blueprint does not emit; an apply
//     deletes that section. Key ("conformance_check","DROPPED",<path>,<bp base>).
//   - NO-BLUEPRINT — the note names a blueprint file that does not exist. Key
//     ("conformance_check","NO-BLUEPRINT",<path>,<full wikilink inner>).
//   - UNRESOLVED-INCLUDE (#112c, TS-native — no Python counterpart) — a
//     governed blueprint's `{% include %}` names a target absent from the
//     blueprint listing. The Python read include targets straight off disk;
//     the TS resolves them against the snapshot's blueprint set and used to
//     no-op silently on a miss, so `emittedH2s` returned a SMALLER emitted set
//     than the blueprint declares and every note checked against it was linted
//     against incomplete headings — a silent false negative, measured live in
//     the governed tree (a `ScopeNoteHeader.blueprint` include beginning with
//     a literal `…` placeholder). Same absence-vs-emptiness class as
//     #125/#133/#136. Reported as a finding — never a throw (one bad include
//     must not kill the pack's whole run) — the rail's idiom: detect, humans
//     fix. Key ("conformance_check","UNRESOLVED-INCLUDE",<bp path>,<target>).
// REFILL (blueprint emits an H2 the note lacks — a warning) and SKIPPED (a
// dynamic-H2 blueprint that cannot be checked statically) are NOT findings, so
// the pack emits neither, exactly as the ratchet parser dropped them. The pack
// id IS the `script` field: "conformance_check".

import { leadingFrontmatterBlock, stripLeadingFrontmatter } from "@vault-mcp/core";
import type { VaultConventions } from "../vault-conventions.js";
import type { Finding } from "../finding.js";
import type { RulePack, SourceFile, VaultSnapshot } from "../rule-pack.js";
import { requireSources, requireBlueprints } from "../rule-pack.js";
import { firstSegment, hasDotOrTrashSegment, isUnderRoot } from "./legacy-scope.js";

export const STRUCTURE_PACK_ID = "conformance_check";

/** Where the blueprint registry lives (conformance_check.py's BP_ROOTS).
 * Vault-relative; the note→blueprint basename index is built from `.blueprint`
 * files under here. `{% include %}` still resolves against the full blueprint
 * listing, matching the Python (which reads include targets off disk by path). */
// (#403) There is no default blueprint root: `structurePack` takes the
// operator's conventions as a REQUIRED option; the former constant was a
// second reader of the shipped layout.

const COMMENT = /{#[\s\S]*?#}/g;
const INCLUDE = /{%-?\s*include\s+"([^"]+)"\s*-?%}/g;
const REST = /{%-?\s*section\s+["']___REST___["'][\s\S]*?{%-?\s*endsection\s*-?%}/g;

/** All literal `## ` headings in a blueprint body (Python's H2 over the whole
 * assembled text — blueprint code fences are NOT skipped here, unlike a note). */
function h2Set(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^## (.+?)\s*$/gm)) out.add(m[1]);
  return out;
}

export interface EmittedH2 {
  heads: Set<string>;
  dynamic: boolean;
  openEnded: boolean;
}

/** conformance_check.py's `emitted_h2s`: the emitted-H2 set for one blueprint,
 * resolving one level of `{% include %}` (recursively, cycle-guarded by `seen`)
 * and stripping `___REST___` fork sections. `byPath` maps a blueprint's
 * vault-relative path to its raw text. */
export function emittedH2s(startPath: string, byPath: Map<string, string>, seen = new Set<string>()): EmittedH2 {
  if (seen.has(startPath)) return { heads: new Set(), dynamic: false, openEnded: false };
  seen.add(startPath);
  let text = byPath.get(startPath);
  if (text === undefined) return { heads: new Set(), dynamic: false, openEnded: false };
  // Drop the blueprint's own frontmatter (merge payload, not body) — via the
  // shared recognizer (#189), so a BOM/CRLF-authored blueprint's frontmatter is
  // stripped rather than scanned for H2s as if it were body.
  text = stripLeadingFrontmatter(text);
  text = text.replace(COMMENT, "");
  const restStripped = text.replace(REST, "");
  let openEnded = restStripped !== text;
  text = restStripped;
  // Resolve includes: included H2s count as emitted; sub-openEnded propagates.
  for (const inc of text.matchAll(INCLUDE)) {
    const target = inc[1];
    if (byPath.has(target)) {
      const sub = emittedH2s(target, byPath, seen);
      openEnded = openEnded || sub.openEnded;
      text += "\n" + [...sub.heads].map((h) => `## ${h}`).join("\n");
    }
  }
  const heads = h2Set(text);
  const dynamic = [...heads].some((h) => h.includes("{{"));
  const filtered = new Set([...heads].filter((h) => !h.includes("{{")));
  return { heads: filtered, dynamic, openEnded };
}

/** conformance_check.py's `note_info`: the note's declared blueprint (the inner
 * text of the `blueprint: [[…]]` wikilink) and its H2 headings collected from
 * the body OUTSIDE fenced code blocks. Returns `bp: null` when the note has no
 * leading frontmatter or no `blueprint:` wikilink (→ the note is skipped). */
export function noteInfo(text: string): { bp: string | null; heads: string[] } {
  // Both halves bind to the shared recognizer (#189): `leadingFrontmatterBlock`
  // for the YAML text, `stripLeadingFrontmatter` for the body — a PAIR, never
  // re-derived locally, or a BOM/CRLF note is read with its own frontmatter
  // still inside its body (the split-brain snapshot.ts documents).
  const block = leadingFrontmatterBlock(text);
  if (block === null) return { bp: null, heads: [] };
  const bpm = block.match(/^blueprint:\s*"?\[\[([^\]]+?)\]\]"?/m);
  if (!bpm) return { bp: null, heads: [] };
  const body = stripLeadingFrontmatter(text);
  const heads: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const open = line.match(/^(```+|~~~+)/);
    if (fence) {
      if (open && open[1].length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    const hm = line.match(/^## (.+?)\s*$/);
    if (hm) heads.push(hm[1]);
  }
  return { bp: bpm[1], heads };
}

export interface StructurePackOpts {
  /** Vault-shaped conventions (ungoverned roots, registries root). Injected
   * rather than read from the environment at module load: an exported constant
   * that varies with ambient env makes the test suite non-hermetic. */
  conventions: VaultConventions;
  /** Vault-relative blueprint-registry root; defaults to the injected conventions' `registriesRoot`. */
  blueprintRoot?: string;
}

export function structurePack(opts: StructurePackOpts): RulePack {
  const conv = opts.conventions;
  // The INJECTED registries root, not a module constant — a constant
  // ignored every override of this key (the conventions setting, or
  // VAULT_MCP_CONVENTIONS for the CLI, since #403), so the
  // note→blueprint index was built from a root that did not exist and every
  // note read NO-BLUEPRINT (#401 review; the same defect drift.ts had).
  const registryRoot = (opts.blueprintRoot ?? conv.registriesRoot).replace(/\/$/, "");
  return {
    id: STRUCTURE_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const blueprints: SourceFile[] = requireBlueprints(snapshot, STRUCTURE_PACK_ID);
      // byPath: every blueprint (include resolution). byBasename: only those
      // under the registry root (the note→blueprint lookup, Python's BP_ROOTS).
      //
      // PINNED (#112b): on a basename COLLISION (two `.blueprint` files under
      // the registry root sharing a basename) the winner is last-in-sorted-
      // path-order — deterministic by construction, because the snapshot sorts
      // its blueprint listing. The Python's `rglob` order was filesystem-
      // dependent, so on this axis the TS is strictly better; that the
      // arbitration is SILENT (nothing reports that a choice was made) is a
      // known, deliberate residual — surfacing it is a reporting decision, not
      // a port fix. Pinned by "basename collision resolves last-in-sorted-
      // order" in tests/conformance-legacy-packs.test.mjs.
      const byPath = new Map<string, string>();
      const byBasename = new Map<string, string>();
      for (const bp of blueprints) {
        byPath.set(bp.path, bp.text);
        if (bp.path === registryRoot || bp.path.startsWith(registryRoot + "/")) {
          const base = bp.path.split("/").pop() ?? bp.path;
          byBasename.set(base, bp.path);
        }
      }

      const cache = new Map<string, EmittedH2>();
      const emitted = (path: string): EmittedH2 => {
        let e = cache.get(path);
        if (!e) {
          e = emittedH2s(path, byPath);
          cache.set(path, e);
        }
        return e;
      };

      const out: Finding[] = [];

      // UNRESOLVED-INCLUDE (#112c): every governed blueprint's own direct
      // `{% include %}` directives, checked against the listing `emittedH2s`
      // resolves them from. Scanned over the same text `emittedH2s` sees —
      // frontmatter stripped, `{# #}` comments removed, `___REST___` sections
      // dropped (an include inside a stripped section never affects emission,
      // so it is not a silent zero). Each unresolved site reports at the
      // blueprint whose text CONTAINS it (a nested miss reports at the nested
      // blueprint's own entry), scoped like the note scan: no dot/.trash
      // segments, no `_` roots, no ungoverned roots. Known residual of that
      // scoping: a governed blueprint including an UNGOVERNED one whose own
      // include is unresolved still shrinks silently — the nested site sits in
      // a blueprint this scan skips. Deliberate (a cross-governance include is
      // itself the anomaly), not an oversight.
      for (const bp of blueprints) {
        if (hasDotOrTrashSegment(bp.path)) continue;
        if (firstSegment(bp.path).startsWith("_") || isUnderRoot(bp.path, conv.ungovernedRoots)) continue;
        const scanned = stripLeadingFrontmatter(bp.text).replace(COMMENT, "").replace(REST, "");
        const seenTargets = new Set<string>();
        for (const inc of scanned.matchAll(INCLUDE)) {
          const target = inc[1];
          if (byPath.has(target) || seenTargets.has(target)) continue;
          seenTargets.add(target);
          out.push({
            script: STRUCTURE_PACK_ID,
            check: "UNRESOLVED-INCLUDE",
            target: bp.path,
            kind: target,
            detail:
              `UNRESOLVED-INCLUDE: ${bp.path} includes "${target}" which resolves to no blueprint — ` +
              `its emitted-H2 set is silently smaller than declared, so notes checked against it are ` +
              `linted against incomplete headings`,
          });
        }
      }

      for (const src of requireSources(snapshot, STRUCTURE_PACK_ID)) {
        // conformance_check.targets(): no dot/.trash segments, no `_` root, no
        // ungoverned Assent / Vault archaeology roots.
        if (hasDotOrTrashSegment(src.path)) continue;
        if (firstSegment(src.path).startsWith("_") || isUnderRoot(src.path, conv.ungovernedRoots)) continue;

        const { bp, heads } = noteInfo(src.text);
        if (bp === null) continue;
        const bpKey = bp.split("/").pop() ?? bp;
        const bpPath = byBasename.get(bpKey);
        if (bpPath === undefined) {
          out.push({
            script: STRUCTURE_PACK_ID,
            check: "NO-BLUEPRINT",
            // INTENTIONAL DIVERGENCE from the legacy Python (conformance_check.py):
            // the finding key here uses the VAULT-RELATIVE path by design. The
            // Python interpolated an absolute, machine-specific path into this key,
            // which is non-portable; the TS uses the relative path (consistent with
            // DROPPED above) as a deliberate correction. This is safe because the
            // live baseline has ZERO NO-BLUEPRINT findings, so there is no existing
            // ratchet key to strand. Keep this relative — do NOT switch to absolute.
            // (Asserted by tests/conformance-legacy-packs.test.mjs: target === "Notes/bar.md".)
            target: src.path,
            kind: bp, // the full wikilink inner, as the ratchet keyed it
            detail: `NO-BLUEPRINT: ${src.path} names [[${bp}]] which does not exist`,
          });
          continue;
        }
        const e = emitted(bpPath);
        if (e.dynamic) continue; // SKIPPED — a dynamic H2 cannot be checked; not a finding
        const dropped = e.openEnded ? [] : heads.filter((h) => !e.heads.has(h));
        if (dropped.length) {
          out.push({
            script: STRUCTURE_PACK_ID,
            check: "DROPPED",
            target: src.path,
            kind: bpKey, // the blueprint basename, as the ratchet keyed it
            detail: `DROPPED on apply: ${src.path} [${bpKey}]: [${dropped.map((h) => `'${h}'`).join(", ")}]`,
          });
        }
        // REFILL (emitted − note) is a warning only — not a finding.
      }
      return out;
    },
  };
}
