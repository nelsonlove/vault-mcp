// packs/shape.ts — the `shape` rule pack: the heading shape of every typed note,
// read from its class note in the fileclasses folder. Check (a) of the vault
// task "Replace the four Forge-only checks" (Nelson's verify of 2026-10-14,
// pick A: the checks live in this satellite, not in the vault-mcp host). It
// replaces Forge's shape lint, which Nelson ruled retired on 2026-10-04 ("A,
// retire forge").
//
// What it does, in the plan's words: "for each note whose `type` names a
// class, find the class note in `00.10 Fileclasses`, take its `## Shape`
// fence, or derive a shape from its `## Template` fence when it has no
// `## Shape`, and report each required heading the note is missing or has
// out of order. A class with neither fence is reported once as 'unchecked',
// never read as clean." The derivation and the matcher are Forge's own (nl.11
// plus forge#5, ported under ./../shapes with the MIT notice), so a template's
// leading `# {{TITLE}}` is optional, as 01.14 rule 7a now says.
//
// The fileclasses folder is a vault convention (`fileclassesRoot`), never a
// folder name in code: blank or missing means this pack is NOT MEASURED, and
// the run says so (a dead convention), so an unset folder can never read as
// "every note has its shape".
//
// A `type` that names no class (the "unbound" count of check (b)) is reported
// here too, because this pack is the one that reads the class list on each
// run. The plan put it in the drift pack; it sits here so that a blank
// `fileclassesRoot` leaves drift's E and J measured (proposed, see the PR).
//
// Finding keys (`script` = "shape"; the key is free of line numbers):
//   missing_heading  target <note path>   kind "<class>: [<parent> > ]<#…> <heading>"
//   heading_order    target <note path>   kind "<class>: [<parent>]"
//   unchecked_class  target <class note>  kind "<class>"
//   unbound_type     target <note path>   kind "<type value>"

import type { Finding } from "../finding.js";
import type { RulePack, VaultSnapshot } from "../rule-pack.js";
import { requireSources } from "../rule-pack.js";
import type { VaultConventions } from "../vault-conventions.js";
import { firstSegment, hasDotOrTrashSegment, isUnderscoreRoot } from "./legacy-scope.js";
import { shapeHeadingsForClassNote } from "../shapes/derive.js";
import { shapeGaps, type ParsedHeading } from "../shapes/match.js";

export const SHAPE_PACK_ID = "shape";

export interface ShapeClass {
  /** The class name, as a note's `type` names it: the class note's path under the root, without `.md`. */
  name: string;
  /** The class note's vault-relative path. */
  path: string;
  /** The shape (empty when the class has neither a `## Shape` nor a `## Template` fence). */
  shape: ParsedHeading[];
}

/** What a shape run checked — stated in every report, so a run that checked nothing cannot read as clean (cap 4). */
export interface ShapeCoverage {
  /** Class notes found under the fileclasses root. */
  classes: number;
  /** Classes with neither fence: reported, not checked. */
  uncheckedClasses: number;
  /** Notes in scope whose `type` named a class with a shape, and so were checked. */
  checkedNotes: number;
  /** Notes in scope whose `type` named no class. */
  unboundNotes: number;
}

/** The class list: every `.md` note under `root`, its name its path below the root without `.md`. */
export function shapeClasses(sources: { path: string; text: string }[], root: string): Map<string, ShapeClass> {
  const prefix = root.replace(/\/+$/, "") + "/";
  const out = new Map<string, ShapeClass>();
  for (const s of sources) {
    if (!s.path.startsWith(prefix) || !s.path.endsWith(".md")) continue;
    const name = s.path.slice(prefix.length, -3);
    out.set(name, { name, path: s.path, shape: shapeHeadingsForClassNote(s.text) });
  }
  return out;
}

/** The class names a note's `type` claims: a string, or a list of strings; trimmed, blanks and repeats dropped. Anything else claims nothing. */
export function typeNames(value: unknown): string[] {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** The governed walk drift's E check uses (no dot or trash segment, no `_` root, not the old
 * `Assent/` root), and nothing more: the pack reads ONE convention, `fileclassesRoot`, so no
 * other dead path can stop it measuring. An archive the operator does not want checked is an
 * `--exclude` (or GOVERNOR_EXCLUDED_ROOTS), which the walk prunes and the report names. */
function inScope(path: string): boolean {
  return path.endsWith(".md") && !hasDotOrTrashSegment(path) && !isUnderscoreRoot(path) && firstSegment(path) !== "Assent";
}

function gapKind(cls: string, parent: string | null, rest: string): string {
  return `${cls}: ${parent ? `${parent} > ` : ""}${rest}`;
}

/** The pack's findings and its coverage, from one pass. Pure over the snapshot. */
export function runShape(snapshot: VaultSnapshot, conv: VaultConventions): { findings: Finding[]; coverage: ShapeCoverage } {
  const sources = requireSources(snapshot, SHAPE_PACK_ID);
  const classes = shapeClasses(sources, conv.fileclassesRoot);
  const fm = new Map(snapshot.notes.map((n) => [n.path, n.frontmatter ?? null]));
  const findings: Finding[] = [];
  const coverage: ShapeCoverage = { classes: classes.size, uncheckedClasses: 0, checkedNotes: 0, unboundNotes: 0 };

  for (const c of [...classes.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (c.shape.length > 0) continue;
    coverage.uncheckedClasses++;
    findings.push({
      script: SHAPE_PACK_ID,
      check: "unchecked_class",
      target: c.path,
      kind: c.name,
      detail: `class '${c.name}' has neither a ## Shape nor a ## Template fence: its notes are NOT checked (not clean)`,
    });
  }

  for (const s of sources) {
    if (!inScope(s.path)) continue;
    const names = typeNames(fm.get(s.path)?.type);
    let checked = false;
    let unbound = false;
    for (const name of names) {
      const c = classes.get(name);
      if (!c) {
        unbound = true;
        findings.push({
          script: SHAPE_PACK_ID,
          check: "unbound_type",
          target: s.path,
          kind: name,
          detail: `type '${name}' names no class under ${conv.fileclassesRoot}`,
        });
        continue;
      }
      if (c.shape.length === 0) continue; // reported once, as unchecked_class
      checked = true;
      for (const g of shapeGaps(s.text, c.shape)) {
        if (g.kind === "missing") {
          const heading = `${"#".repeat(g.level)} ${g.text}`;
          findings.push({
            script: SHAPE_PACK_ID,
            check: "missing_heading",
            target: s.path,
            kind: gapKind(name, g.parent, heading),
            detail: `missing heading '${heading}'${g.parent ? ` under '${g.parent}'` : ""} (required by class '${name}')`,
          });
        } else {
          findings.push({
            script: SHAPE_PACK_ID,
            check: "heading_order",
            target: s.path,
            kind: gapKind(name, null, g.parent ?? ""),
            detail: `headings out of order${g.parent ? ` within '${g.parent}'` : ""} for class '${name}'. Expected: ${g.expected.map((t) => `'${t}'`).join(" → ")}`,
          });
        }
      }
    }
    if (checked) coverage.checkedNotes++;
    if (unbound) coverage.unboundNotes++;
  }
  return { findings, coverage };
}

/** The pack. `coverage()` answers what the LAST run checked (null before a run, or when it threw), so the report can state it without a second pass. */
export function shapePack(conv: VaultConventions): RulePack & { coverage(): ShapeCoverage | null } {
  let last: ShapeCoverage | null = null;
  return {
    id: SHAPE_PACK_ID,
    run(snapshot) {
      last = null;
      const r = runShape(snapshot, conv);
      last = r.coverage;
      return r.findings;
    },
    coverage: () => last,
  };
}
