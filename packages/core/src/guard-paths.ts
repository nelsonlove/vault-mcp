// guard-paths.ts — the argument-path walk the guard reads every call by (mapPaths,
// collectPaths) and the disclosure filter (visiblePaths), published into core so a
// satellite that needs the same rule (the scheme registry, conformance) uses this one
// copy rather than a second (moved from the host's guard.ts, 2026-10-14). Pure: no
// obsidian, no node. The host's guard.ts re-exports all three and keeps guardCall.
import { isVisible, type GuardSettings } from "./visibility.js";

// Path-bearing argument keys across the tool surface.
// `output_folder` is obsidian_import_apple_notes' landing folder (every file
// that import creates lands under it) — recognized here so the kernel journals
// it as the operation's target and consults advisory locks over it, exactly
// like any other named path.
// `note_path` joined at S8 (the mutating tier), and the reason is the kernel,
// not the allowlist: the fileclass/jd-scaffold/provenance satellites renamed
// `path` away to get F3's refuse-all under an allowlist, which ALSO removed
// their writes from collectPaths — and collectPaths feeds record immutability,
// the advisory lock consult and the journal's target, none of which is
// allowlist-gated. A satellite field-write could suddenly mutate a
// `record: true` note the kernel used to refuse. Recognizing `note_path`
// restores all three for single-note writes (per-path allowlist scoping, the
// same posture as every host write tool).
//
// THE CONTRACT THAT SPELLING NOW CARRIES, settled at round 2 (2026-09-07) and
// binding on any satellite that adds a note-taking tool: **spell the argument
// `note_path` iff the tool MUTATES the note it names.** Kernel visibility is a
// mutating concern — the record guard, the lock consult and the journal target
// all bind at the mutating dequeue — so a READ gains nothing from being here
// and loses F3's refusal. Reads whose answers can name paths their caller
// cannot see (`vaultmcp_fileclass_explain` / `_get`, `vaultmcp_provenance_check`)
// spell it `note` deliberately, which this list does NOT contain, so F3 refuses
// them wholesale under an allowlist. Bulk tools that name no note stay pathless
// for the same reason. Do not add `note` here.
const PATH_KEYS = ["path", "from", "to", "target_path", "template_path", "subdir", "file_path", "output_folder", "note_path"];
// Keys whose ARRAY values carry paths (refs = obsidian_resolve's batch input).
const ARRAY_PATH_KEYS = ["paths", "refs"];
// Keys whose value is NOTE DATA, never walked (#500): `obsidian_write_note`'s
// `frontmatter` is the caller's own key/values, so a `from`, `to` or `path`
// inside it is a property of the note, not a vault path. Walking it would
// refuse a legitimate write under an allowlist, rewrite a `uid:` value the
// caller meant as text, and name a wrong target to the record guard, the lock
// consult and the journal. Its paths are none: the note is the call's `path`.
const DATA_KEYS = ["frontmatter"];
// Defensive depth cap: MCP args arrive as parsed JSON, so nesting is bounded in
// practice and a cycle is impossible.
const MAX_DEPTH = 8;

// Recursively walk the args, applying `fn` to any non-empty string under a
// PATH_KEYS-named key (and string members of a `paths` array) at ANY depth, and
// returning args with those strings replaced by what `fn` returned.
//
// This is the ONE place the tool surface's path-argument shapes are known. It
// replaces per-shape clauses (flat keys, paths[], moves[{from,to}]): a future
// batch tool with a new nesting can't silently bypass the allowlist — or uid
// addressing — just because nobody added its shape here (#18). Over-collection
// is safe: worst case the guard over-blocks; silent under-collection is the
// failure mode this eliminates.
//
// Structurally sharing: any object or array none of whose descendants changed is
// returned BY REFERENCE, so a call that rewrites nothing hands back the very
// args it was given and callers can test for a no-op with `===`.
export function mapPaths(
  args: Record<string, unknown>,
  fn: (path: string) => string
): Record<string, unknown> {
  const seen = new Set<object>();

  function walk(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;
    if (seen.has(value as object)) return value;
    seen.add(value as object);
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        const mapped = walk(item, depth + 1);
        if (mapped !== item) changed = true;
        return mapped;
      });
      return changed ? out : value;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DATA_KEYS.includes(k)) {
        out[k] = v;
        continue;
      }
      const isPathKey = PATH_KEYS.includes(k) || ARRAY_PATH_KEYS.includes(k);
      let mapped: unknown;
      if (isPathKey && typeof v === "string" && v) {
        mapped = fn(v);
      } else if (isPathKey && Array.isArray(v)) {
        // Arrays under path keys: map string members, recurse the rest —
        // {path: [...]}, paths: [...], refs: [...], and paths: [{path}] all land.
        let inner = false;
        const arr = v.map((p) => {
          if (typeof p === "string" && p) {
            const m = fn(p);
            if (m !== p) inner = true;
            return m;
          }
          const m = walk(p, depth + 1);
          if (m !== p) inner = true;
          return m;
        });
        mapped = inner ? arr : v;
      } else {
        mapped = walk(v, depth + 1);
      }
      if (mapped !== v) changed = true;
      out[k] = mapped;
    }
    return changed ? out : value;
  }

  return walk(args, 0) as Record<string, unknown>;
}

/**
 * Every path the arguments name, in the order the walk meets them. Defined over
 * mapPaths so the collected set and the rewritable set can never drift apart.
 */
export function collectPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  mapPaths(args ?? {}, (p) => {
    out.push(p);
    return p;
  });
  return out;
}

/**
 * The subset of `paths` this session may be TOLD ABOUT — the allowlist applied
 * to disclosure rather than to action.
 *
 * It lives here, beside guardCall, because every disclosing surface needs the
 * identical rule and a second copy of it is a second thing to forget:
 * `obsidian_resolve_uid` filters the candidates AND the totals it reports (an
 * unfiltered index is a path — and cardinality — oracle for the area a
 * sandboxed session is excluded from), uid ADDRESSING decides
 * unresolved/ambiguous over the same visible set (a `uid_ambiguous` naming every
 * carrier disclosed exactly the paths the filter exists to hide), and
 * `obsidian_check_links` filters both halves of its drift report. One rule, so
 * the lookup, the addressing and the report can never disagree about what a
 * session can see.
 *
 * It is ALSO the read boundary for every tool that enumerates the vault without
 * being told where (slice 3.0). `guardCall` checks the paths an operation NAMES,
 * so an argument-less read — search, list, find-by-tag, a plugin's own query —
 * never met it: a session allowlisted to `Projects` could search the whole vault
 * and read a hidden note's contents out of the snippets. Those handlers now bound
 * their own iteration through this function, filtering BEFORE they read, exactly
 * as `obsidian_repoint_link` bounds its scan.
 *
 * No allowlist ⇒ everything is visible, and the SAME ARRAY comes back — callers
 * lean on that identity to skip building a filter set at all, so a call made
 * without an allowlist behaves byte-for-byte as it did before.
 */
export function visiblePaths(paths: string[], settings?: GuardSettings | null): string[] {
  if (!settings?.allowlist?.length) return paths;
  return paths.filter((path) => isVisible(path, settings));
}

