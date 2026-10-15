// packs/port.ts — the port rule pack: a verbatim TypeScript port of
// port_lint.py, the guard for content ported from retired source vaults.
//
// A ported brief that still names an old-vault address, an old-vault path, or a
// retired plugin sends an agent to a place that no longer exists here. The pack
// scans every governed `.md` source line-by-line (frontmatter and code spans
// INCLUDED, exactly like the Python — a path in a code span still misleads an
// agent that follows it) and flags three families, skipping any line that names
// its reference as historical.
//
// Finding key (the frozen ratchet normalization from conformance_ratchet.py's
// `parse_port`): a gate-mode line `<path>:<lineno>: <name> '<token>' — <ctx>`
// becomes ("port_lint", <name>, <path>, <token>). Line number and context are
// volatile and excluded, so multiple identical-token hits in one file collapse
// to one stable finding. The pack id IS the `script` field: "port_lint".

import type { Finding } from "../finding.js";
import type { RulePack, VaultSnapshot } from "../rule-pack.js";
import { requireSources } from "../rule-pack.js";
import { hasDotOrTrashSegment, isUnderscoreRoot } from "./legacy-scope.js";

export const PORT_PACK_ID = "port_lint";

/** The three flagged families. `name` becomes the finding's `check`; the whole
 * matched substring (Python's `m.group(0)`) becomes `kind`. Order and patterns
 * are verbatim from port_lint.py's PATTERNS.
 *
 * PINNED (#112a): `\b` here is JS's ASCII-only word boundary, where Python's
 * `re` treated `\w` as Unicode — a token glued to a non-ASCII letter
 * ("Templaterö") matches here where the Python did not. The Python rail is
 * retired, so the ASCII semantics ARE the rail's own now, kept deliberately
 * (a Unicode-aware rewrite changes what the lint reports and re-keys
 * findings — a human behavior decision). Pinned by "ASCII word boundaries
 * are the rail's own semantics" in tests/conformance-legacy-packs.test.mjs. */
const PATTERNS: ReadonlyArray<{ name: string; rx: RegExp }> = [
  // Absolute or tilde paths into the retired source vaults (obsidian-old /
  // -new / -newer). NOT the live `~/obsidian`. `newer` precedes `new` in the
  // alternation so the `\b` anchors on the longest match.
  { name: "retired source-vault path", rx: /(~|\/Users\/nelson)\/obsidian-(newer|new|old)\b/ },
  // Old-vault agent-band addresses that do not exist in this vault.
  { name: "old-vault address", rx: /\b(05\.1[137]|05\.5[01]|03\.98)\b/ },
  // Retired or absent tooling.
  {
    name: "retired tooling",
    rx: /\b(Templater|Metadata Menu|metadata-menu|Dataview Serializer|Advanced URI|advanced-uri|note_uid_generator)\b/,
  },
];

/** A line that NAMES a reference as historical passes (matches port_lint.py's
 * HISTORICAL). Case-insensitive. */
const HISTORICAL = /retired|tombstone|superseded|archived|do not reintroduce|uninstalled/i;

/** port_lint.py's `lint()` for one file's text: per-line, per-pattern first
 * match, historical lines skipped. Returns one entry per (line, pattern) hit. */
export function portHits(text: string): { line: number; name: string; token: string; ctx: string }[] {
  const hits: { line: number; name: string; token: string; ctx: string }[] = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (HISTORICAL.test(line)) continue;
    for (const { name, rx } of PATTERNS) {
      const m = line.match(rx);
      if (m) {
        hits.push({ line: n + 1, name, token: m[0], ctx: line.trim().slice(0, 70) });
      }
    }
  }
  return hits;
}

export function portPack(): RulePack {
  return {
    id: PORT_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const out: Finding[] = [];
      // De-dupe (name, path, token) so identical-token hits in one file
      // collapse to one finding — the ratchet key excludes line + context.
      const seen = new Set<string>();
      for (const src of requireSources(snapshot, PORT_PACK_ID)) {
        // port_lint's ratchet feed (gen3_note_paths) excludes dot/.trash
        // segments and `_`-prefixed roots. It does NOT exclude Assent /
        // Vault archaeology (unlike the other two scripts).
        if (hasDotOrTrashSegment(src.path) || isUnderscoreRoot(src.path)) continue;
        for (const h of portHits(src.text)) {
          const dedupe = `${h.name}\u0000${src.path}\u0000${h.token}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          out.push({
            script: PORT_PACK_ID,
            check: h.name,
            target: src.path,
            kind: h.token,
            detail: `${src.path}:${h.line}: ${h.name} '${h.token}' — ${h.ctx}`,
          });
        }
      }
      return out;
    },
  };
}
