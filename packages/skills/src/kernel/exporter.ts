import * as fs from "node:fs";
import * as path from "node:path";
import {
  transformAll, SKILL_PASSTHROUGH_FIELDS, NO_SKILLS_FIELD, PRELOAD_FIELD,
  type Attachment, type EmittedKind, type Generated, type NoteInput, type PolicyPlacement,
  type PreloadPlacement, type TreeNode,
} from "./transform.js";
import { resolveTransclusions, stripFrontmatter } from "./transclude.js";
import type { SkillsSource } from "./skills-source.js";
import { STATIC_FILES } from "./static-skills.js";
import { assetDirFor, collectAssets, copyAsset, type CollectAssetsOptions } from "./assets.js";
import { matchesTerritoryPrefix, hasHumanVerification, humanVerificationOf, parseGuardFrontmatter } from "@vault-mcp/core";

const MANIFEST_NAME = ".vault-skills-manifest.json";

/** How the vault-skills fields are namespaced in a note's frontmatter. */
export interface FieldConfig {
  mode: "prefix" | "nested";
  prefix: string; // e.g. "vs-" → vs-type, vs-parent (prefix mode)
  key: string;    // e.g. "vault-skills" → nested object (nested mode)
}

/** FieldConfig plus how a note's *kind* (skill/agent/policy) is declared. In "tags" mode the
 *  kind comes from a `#{tagPrefix}{kind}` tag and any `type:` frontmatter is ignored; every other
 *  field (parent, description, …) is still read from frontmatter per the FieldConfig. Both extras
 *  are optional so a bare FieldConfig behaves exactly like frontmatter mode with the default prefix. */
export interface DetectConfig extends FieldConfig {
  typeSource?: "frontmatter" | "tags";
  tagPrefix?: string; // e.g. "agent/" → #agent/skill, #agent/agent, #agent/policy
  /** Frontmatter mode: the vault's OWN `type` spellings → the kind each compiles as
   *  (`Note/AgentPolicy` → `policy`, `Person/Agent` → `agent`, …). Absent means the
   *  kernel's identity map (bare `skill`/`agent`/`policy`/`command`), which is what
   *  every direct caller of the pure core gets; the PLUGIN ships an EMPTY map
   *  (#404 — one vault's spelling must not be baked into a plugin), so a fresh
   *  install compiles nothing until the operator names their classes. Case-sensitive:
   *  a class path is an identifier. */
  typeMap?: Readonly<Record<string, ExportableKind>>;
  /** Vault-relative folder prefixes the compiler reads. Absent means the whole
   *  vault (pure-core callers); the plugin ships EMPTY, which means NOTHING is read
   *  — the same "empty guards nothing, honestly" rule the host's territories use,
   *  and the reason the six rank files in 03.18 (loaded natively by Claude Code
   *  through ~/.claude/agents) are not compiled twice until the switch is made. */
  includeRoots?: readonly string[];
  /** Folders under an include root the compiler must NOT read (a template folder,
   *  a natively-loaded folder). Same boundary rule. */
  excludeRoots?: readonly string[];
  /** GUARDED TERRITORIES (01.61 rule 8a): folders whose notes never reach the
   *  fleet-wide plugin, at any depth: not as a compile unit, and not through an
   *  embed (`![[X]]` of a note there is refused, and neither its text nor its
   *  name is written into the output or a warning). Same boundary rule as the
   *  roots. A guarded territory's policies travel only in its own lead's
   *  charter, which this compile does not build. */
  guardedRoots?: readonly string[];
  /** THE ONE EXCEPTION to `guardedRoots` (01.61 rule 8a as amended 2026-10-12,
   *  on Nelson's ruling on "Revise the divorce-area rules around data loss"):
   *  the vault paths, EXACTLY (no folders, no prefixes), of the policy notes
   *  under a guarded territory that state its data-loss rules and hold no case
   *  content. Each compiles into the fleet-wide plugin like any policy, whether
   *  or not an include root covers it; it must still pass rule 8 and be typed
   *  `policy`, and it still needs a parent agent in the compile. A listed path
   *  that is not a policy is refused, and a listed path outside every guarded
   *  root is ignored as an exception (named in a warning). The operator writes
   *  the list; nothing in a note can put itself on it. */
  fleetWideRules?: readonly string[];
}

export const DEFAULT_FIELDS: FieldConfig = { mode: "prefix", prefix: "", key: "vault-skills" };
export const DEFAULT_TAG_PREFIX = "agent/";

/** The note `type` values that produce plugin output (skills, agents, the policies folded into
 *  agents, and the flat slash commands). Single source of truth for "does this note participate
 *  in the export" — shared by collection (collectNotes), kind detection, and the export-on-save
 *  relevance check. */
export const EXPORTABLE_TYPES = ["skill", "agent", "policy", "command"] as const;
export type ExportableKind = (typeof EXPORTABLE_TYPES)[number];

/** The kernel's own type map: each kind spelled bare. NOT the plugin's default —
 *  see `DetectConfig.typeMap`. */
export const IDENTITY_TYPE_MAP: Readonly<Record<string, ExportableKind>> = Object.freeze({
  skill: "skill", agent: "agent", policy: "policy", command: "command",
});

/** The kind a frontmatter `type` value compiles as under `map`, or null. A value
 *  that is not a string (a list, a number) never matches: a class path is one
 *  identifier, and coercing would let `["policy"]` read as a policy. */
export function mappedKind(type: unknown, map: Readonly<Record<string, ExportableKind>>): ExportableKind | null {
  if (typeof type !== "string") return null;
  const k = map[type];
  return k && isExportableType(k) ? k : null;
}

/** The vault spelling to WRITE for a kind under `map` — the reverse lookup the
 *  `mark` write path needs. The first entry mapping to that kind, in map order;
 *  null when the map names no spelling for it (then nothing can be marked as it). */
export function spellingFor(kind: ExportableKind, map: Readonly<Record<string, ExportableKind>>): string | null {
  for (const [spelling, k] of Object.entries(map)) if (k === kind) return spelling;
  return null;
}

/** Whether a vault-relative path is inside the configured roots: in some include
 *  root and in no exclude root. The boundary rule is core's `matchesTerritoryPrefix`
 *  — the one rule the host's guarded territories use, so `03 Agents/03.18` covers
 *  that folder and not `03 Agents/03.180 …`. Absent include roots read the whole
 *  vault; an EMPTY list reads nothing. */
export function inRoots(path: string, include: readonly string[] | undefined, exclude: readonly string[] = []): boolean {
  if (exclude.some((r) => matchesTerritoryPrefix(path, r))) return false;
  if (include === undefined) return true;
  return include.some((r) => matchesTerritoryPrefix(path, r));
}

/** A vault path as the exception list compares it: NFC, case folded, no
 *  leading `/` or `./`. The Mac's disk ignores case and Unicode form, so the
 *  list must too, or a respelled path would leave a rule out in silence. */
function listKey(p: string): string {
  return p.normalize("NFC").replace(/^(\.\/|\/)+/, "").toLowerCase();
}

/** Where a vault path stands against the guarded territories (01.61 rule 8a):
 *  `"outside"` (no guarded root covers it), `"rule"` (it is on the
 *  `fleetWideRules` list and under a guarded root), or `"territory"` (under a
 *  guarded root and not on the list: it never reaches the fleet-wide plugin). */
export type GuardedReach = "outside" | "rule" | "territory";
export function guardedReach(path: string, fields: Pick<DetectConfig, "guardedRoots" | "fleetWideRules">): GuardedReach {
  const guarded = fields.guardedRoots ?? [];
  const pn = path.normalize("NFC");
  if (!guarded.some((r) => matchesTerritoryPrefix(pn, r.normalize("NFC")))) return "outside";
  const key = listKey(path);
  return (fields.fleetWideRules ?? []).some((p) => listKey(p) === key) ? "rule" : "territory";
}

/** Whether the compile reads a path: a guarded territory never, a listed
 *  fleet-wide rule always (subject to the exclude roots), anything else by the
 *  roots. The one predicate collection, the agent picker and the export
 *  trigger share. */
export function compiles(path: string, fields: DetectConfig): boolean {
  const reach = guardedReach(path, fields);
  if (reach === "territory") return false;
  if (reach === "rule") return !(fields.excludeRoots ?? []).some((r) => matchesTerritoryPrefix(path, r));
  return inRoots(path, fields.includeRoots, fields.excludeRoots);
}
/** The vault paths of the AGENT notes a mark could attach to: inside the roots and
 *  mapped to `agent`, exactly as the compile would see them. Pure, so the GUI
 *  picker's filter (commands.ts) is pinned headlessly rather than read as a claim. */
export function agentCandidates(notes: ReadonlyArray<{ path: string; frontmatter?: Record<string, unknown> | null }>, fields: DetectConfig): string[] {
  return notes
    .filter((n) => n.frontmatter && compiles(n.path, fields))
    .filter((n) => detectKind(fieldView(n.frontmatter!, fields).view, n.frontmatter!, fields) === "agent")
    .map((n) => n.path);
}
export function isExportableType(type: unknown): type is ExportableKind {
  return (EXPORTABLE_TYPES as readonly unknown[]).includes(type);
}

/** Normalize a note's frontmatter `tags` (Obsidian stores them without `#`, as a list or a
 *  string) into `#tag` strings. Body/inline tags are intentionally NOT read: a kind declaration
 *  is metadata, so it lives in frontmatter — this avoids classifying a note that merely mentions
 *  `#agent/skill` in prose, and matches the "tags only in frontmatter" vault convention. Pure. */
export function extractTags(fm: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (v == null) return; // skip null/empty list entries rather than emitting `#null`
    const s = String(v).trim();
    if (s) out.push(s.startsWith("#") ? s : `#${s}`);
  };
  // Obsidian accepts both the plural `tags:` and singular `tag:` frontmatter keys.
  for (const raw of [fm?.tags, fm?.tag]) {
    if (Array.isArray(raw)) for (const t of raw) push(t);
    else if (typeof raw === "string") for (const t of raw.split(/[,\s]+/)) push(t);
  }
  return out;
}

/** Which kind a set of tags declares under `prefix` (case-insensitive, exact leaf), or null;
 *  "ambiguous" when more than one distinct kind tag is present. */
export function tagKind(tags: string[], prefix: string): ExportableKind | null | "ambiguous" {
  const have = new Set(tags.map((t) => t.toLowerCase()));
  const hits = EXPORTABLE_TYPES.filter((k) => have.has(`#${prefix}${k}`.toLowerCase()));
  return hits.length === 0 ? null : hits.length > 1 ? "ambiguous" : hits[0];
}

/** Resolve a note's kind per the detection mode. `view` is the field-mode frontmatter view;
 *  `fm` is the raw note frontmatter (for tags mode). */
export function detectKind(
  view: Record<string, unknown>,
  fm: Record<string, unknown> | null | undefined,
  cfg: DetectConfig,
): ExportableKind | null | "ambiguous" {
  if ((cfg.typeSource ?? "frontmatter") === "tags") return tagKind(extractTags(fm), cfg.tagPrefix ?? DEFAULT_TAG_PREFIX);
  return mappedKind(view.type, cfg.typeMap ?? IDENTITY_TYPE_MAP);
}

export interface ExportOptions {
  outputDir: string;
  pluginName: string;
  pluginDescription?: string;
  fields?: DetectConfig;
  /** Root of a parallel filesystem tree holding skills' supporting files (see assets.ts).
   *  Empty/unset ⇒ no supporting files are bundled. */
  assetsRoot?: string;
  /** When set, write this version into the output's .claude-plugin/plugin.json
   *  (creating or updating it) — used by the release export. */
  version?: string;
  /** How many preloaded skills on one agent trip the warning (see TransformOptions). */
  preloadCap?: number;
  /** Test hook: overrides for iCloud materialization (downloader, poll, timeout). */
  assetOptions?: CollectAssetsOptions;
}

export interface ExportSummary {
  skills: number;
  agents: number;
  commands: number;
  assets: number;
  removed: number;
  /** Typed notes the acceptance gate refused (01.41 rule 8) — the count the export report carries. */
  excluded: Excluded;
  warnings: string[];
  errors: string[];
  outputDir: string;
  /** Vault paths of every note transcluded into the exported output — the extra notes
   *  (beyond typed skill/agent/policy/command notes) whose edits should re-trigger an
   *  export-on-save (see main.ts). */
  sources: string[];
}

/** Extract link targets from a frontmatter `parent` value (string or list). */
function parentLinkpaths(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr.map(String)
    .map((s) => s.replace(/\[\[|\]\]/g, "").split("|")[0].split("#")[0].trim())
    .filter(Boolean);
}

/** Resolve each parent wikilink to a target note path; unresolved links get a marker
 *  that won't match any node (so the transform reports them as broken edges). */
function resolveParents(src: SkillsSource, sourcePath: string, v: unknown): string[] {
  return parentLinkpaths(v).map((lp) => src.resolveLink(lp, sourcePath) ?? `⟂unresolved:${lp}`);
}

// The vault-skills fields the transform reads (parent is handled separately, resolved to
// paths), plus the SKILL.md passthrough fields — all namespaced the same way.
const VS_FIELDS = [...new Set(["type", "root", "name", "id", "label", "description", "version", "tools", "model",
  "crosscutting", "slot", "severity", PRELOAD_FIELD, NO_SKILLS_FIELD, ...SKILL_PASSTHROUGH_FIELDS])];

/** Extract a bare view of the vault-skills fields (+ the raw parent value) per the field mode,
 *  so the pure transform stays namespace-agnostic. */
export function fieldView(fm: Record<string, unknown>, cfg: FieldConfig): { view: Record<string, unknown>; parent: unknown } {
  if (cfg.mode === "nested") {
    const nested = (fm[cfg.key] && typeof fm[cfg.key] === "object" ? fm[cfg.key] : {}) as Record<string, unknown>;
    return { view: nested, parent: nested.parent };
  }
  // prefix mode — a blank prefix yields bare top-level fields (type, parent, …)
  const view: Record<string, unknown> = {};
  for (const f of VS_FIELDS) view[f] = fm[cfg.prefix + f];
  return { view, parent: fm[cfg.prefix + "parent"] };
}

/** Collect every note marked a skill/agent/policy — by its `type:` field (frontmatter mode) or a
 *  `#{tagPrefix}{kind}` tag (tags mode). Ambiguous tag notes are skipped, reported via `warnings`.
 *  When `warnings` is given, `![[X]]` transclusions in note bodies are also resolved (inlined),
 *  resolution problems reported through the same sink; without it, bodies keep raw embed syntax
 *  (cheap mode for callers that only need the note list). Reads the vault only through `src`. */
/** A typed note the compile refused because it is not ACCEPTED (01.41 rule 8):
 *  no `verified` entry naming a `human:` actor. Counted and named, never silent. */
export interface ExcludedNote {
  path: string;
  kind: ExportableKind;
}

/** The excluded record the three surfaces report: a total, a count per kind,
 *  and the paths, so an operator sees which notes wait on acceptance. */
export interface Excluded {
  /** Typed notes refused as compile units. */
  total: number;
  byKind: Record<ExportableKind, number>;
  paths: string[];
  /** The DISTINCT notes whose text an accepted note tried to EMBED (`![[X]]`)
   *  and which are not accepted themselves: not inlined, a marker in place of
   *  each embed. One note embedded five times is one entry. Rule 8 is over
   *  the prompt's text, so an embed is gated like a note. */
  transclusions: string[];
}

export function excludedSummary(list: readonly ExcludedNote[], refusedEmbeds: Iterable<string> = []): Excluded {
  const byKind: Record<ExportableKind, number> = { skill: 0, agent: 0, policy: 0, command: 0 };
  for (const e of list) byKind[e.kind] += 1;
  return { total: list.length, byKind, paths: list.map((e) => e.path), transclusions: [...refusedEmbeds] };
}

/** One source's acceptance, as the compiled artifact records it (01.61 rule 11). */
export interface SourceAcceptance { by: string; at: string | null }

/** The acceptance record of an embed target, read through the SAME frontmatter
 *  `acceptedEmbed` judged it by. Null when not accepted. */
export function embedAcceptance(src: { content: string; frontmatter?: Record<string, unknown> | null }): SourceAcceptance | null {
  if (src.frontmatter !== undefined) return humanVerificationOf(src.frontmatter);
  try { return humanVerificationOf(parseGuardFrontmatter(src.content)); } catch { return null; }
}

/** Whether an embed target is accepted: its frontmatter carries a human
 *  verification. The frontmatter is the one the lookup supplies from the
 *  vault's own cache when it can (`EmbedSource.frontmatter`; the shipped
 *  backend always does), so the embed gate and the note gate read the SAME
 *  parse of the same note — a note the cache holds no frontmatter for is not
 *  accepted either way. A lookup with no cache (tests, other backends) falls
 *  back to core's guard parser over the raw text, failing closed on what it
 *  cannot read: a note the perimeter cannot read is not one it can vouch for. */
export function acceptedEmbed(src: { content: string; frontmatter?: Record<string, unknown> | null }): boolean {
  if (src.frontmatter !== undefined) return hasHumanVerification(src.frontmatter);
  try { return hasHumanVerification(parseGuardFrontmatter(src.content)); } catch { return false; }
}

/** The one warning line the gate emits when it excluded anything. */
export function excludedWarning(list: readonly ExcludedNote[], refusedEmbeds: Iterable<string> = []): string {
  const sum = excludedSummary(list, refusedEmbeds);
  const kinds = (Object.keys(sum.byKind) as ExportableKind[]).filter((k) => sum.byKind[k] > 0).map((k) => `${sum.byKind[k]} ${k}`).join(", ");
  const first = (paths: string[]) => paths.slice(0, 8).join(", ") + (paths.length > 8 ? `, … ${paths.length - 8} more` : "");
  const notes = sum.total ? `${sum.total} typed note(s) excluded from the compile — not accepted (no \`verified\` entry naming a \`human:\` actor; 01.41 rule 8: nothing unaccepted reaches a compiled agent prompt): ${kinds}: ${first(sum.paths)}` : "";
  const embeds = sum.transclusions.length ? `${sum.transclusions.length} embedded note(s) refused — not accepted, so a marker stands in place of each embed of it: ${first(sum.transclusions)}` : "";
  return [notes, embeds].filter(Boolean).join("; ");
}

export async function collectNotes(src: SkillsSource, fields: DetectConfig = DEFAULT_FIELDS, warnings?: string[], excluded?: ExcludedNote[], refusedEmbeds?: Set<string>, acceptance?: Map<string, SourceAcceptance>): Promise<NoteInput[]> {
  const notes: NoteInput[] = [];
  const excludedHere: ExcludedNote[] = excluded ?? [];
  const refusedHere: Set<string> = refusedEmbeds ?? new Set<string>();
  // Every source that passes the gate is recorded with its human verification,
  // so the compiled artifact can state each source's acceptance (01.61 rule 11).
  const acceptanceHere: Map<string, SourceAcceptance> = acceptance ?? new Map();
  // Embeds are gated like notes (01.41 rule 8 is over the prompt's TEXT): an
  // embed target without a human verification is not inlined, at any depth.
  // A guarded territory is refused at every embed depth too (01.61 rule 8a):
  // its text and its name stay out of the output and the warnings.
  const guardedEmbeds = { n: 0 };
  const gate = {
    guarded: (p: string) => guardedReach(p, fields) === "territory",
    guardedCount: guardedEmbeds,
    accept: (e: { path: string; content: string; frontmatter?: Record<string, unknown> | null }) => {
      if (!acceptedEmbed(e)) return false;
      const rec = embedAcceptance(e);
      if (rec) acceptanceHere.set(e.path, rec);
      return true;
    },
    refused: refusedHere,
  };
  const resolve = warnings
    ? (body: string, from: string, sources: Set<string>) => resolveTransclusions(body, from, src.embed, warnings, sources, gate)
    : null;
  let guardedSkipped = 0;
  let listedNotPolicy = 0;
  // Frontmatter-mode notes whose `type` the map does not name: counted per
  // spelling and reported ONCE per spelling, so an operator who has not mapped
  // `Note/AgentPolicy` yet sees "17 notes carry it" rather than 17 lines — and
  // sees it at all, which is the point (#404: an unmapped note is skipped and
  // counted, never guessed). Only spellings that LOOK like a class the compiler
  // could want are counted: a string value; `Note` alone or a `Task/...` note is
  // not a candidate and would flood the list.
  const unmapped = new Map<string, number>();
  for (const note of await src.notes()) {
    const reach = guardedReach(note.path, fields);
    if (reach === "territory") {
      if (note.frontmatter) guardedSkipped += 1;
      continue;
    }
    if (!compiles(note.path, fields)) continue;
    const fm = note.frontmatter;
    if (!fm) continue; // both modes key off frontmatter (type: field, or the note's tags: list)
    const { view, parent } = fieldView(fm, fields);
    const kind = detectKind(view, fm, fields);
    if (kind === "ambiguous") {
      warnings?.push(`${note.path}: multiple vault-skills kind tags — skipped (tag it as exactly one of skill/agent/policy)`);
      continue;
    }
    if (!kind) {
      if ((fields.typeSource ?? "frontmatter") === "frontmatter" && typeof view.type === "string" && /agent|skill|policy|command/i.test(view.type)) {
        unmapped.set(view.type, (unmapped.get(view.type) ?? 0) + 1);
      }
      continue;
    }
    // A listed fleet-wide rule compiles only as a POLICY (01.61 rule 8a): the
    // exception is for the data-loss rules, and any other kind stays in the
    // territory. Counted, not named: its path is case material.
    if (reach === "rule" && kind !== "policy") {
      listedNotPolicy += 1;
      continue;
    }
    // THE ACCEPTANCE GATE (01.41 rule 8; 01.61 rule 11 as strict exclusion,
    // ruled 2026-09-27): a typed note that no human has verified does not
    // compile, whatever its kind and whatever the caller — the kernel's own
    // callers included, because the rule is about what reaches a prompt, not
    // about who asked. Checked on the RAW frontmatter (the vault's `verified`
    // key is not a vault-skills field), with the perimeter's own predicate.
    if (!hasHumanVerification(fm)) {
      excludedHere.push({ path: note.path, kind });
      continue;
    }
    acceptanceHere.set(note.path, humanVerificationOf(fm)!);
    let body = stripFrontmatter(note.body);
    const sources = new Set<string>();
    if (resolve) body = await resolve(body, note.path, sources);
    notes.push({
      // Copy the view (never mutate: in nested mode `view` is Obsidian's live cache object) and
      // normalize the kind into `type` so the transform + policy count read one source of truth.
      frontmatter: { ...view, type: kind },
      path: note.path,
      body,
      parentPaths: resolveParents(src, note.path, parent),
      sources: [...sources],
    });
  }
  for (const [spelling, n] of [...unmapped.entries()].sort()) {
    warnings?.push(`${n} note(s) carry type '${spelling}', which the type map does not name — skipped (map it to skill/agent/policy/command in the plugin settings, or leave it unmapped on purpose)`);
  }
  if (excludedHere.length || refusedHere.size) warnings?.push(excludedWarning(excludedHere, refusedHere));
  if (guardedSkipped) warnings?.push(`${guardedSkipped} typed note(s) under a guarded territory kept out of the fleet-wide plugin (01.61 rule 8a); they travel only in the territory's own lead's charter`);
  if (listedNotPolicy) warnings?.push(`${listedNotPolicy} note(s) on the fleet-wide rules list are not policies — kept out (01.61 rule 8a: only the data-loss rules, as policy notes, compile fleet-wide)`);
  if (guardedEmbeds.n) warnings?.push(`${guardedEmbeds.n} embed(s) of a note in a guarded territory refused (01.61 rule 8a); a marker stands in place of each, naming no path`);
  for (const p of fields.fleetWideRules ?? []) {
    if (!(fields.guardedRoots ?? []).some((r) => matchesTerritoryPrefix(p, r))) {
      warnings?.push(`${p}: on the fleet-wide rules list but under no guarded root — the list is only for guarded territories, so it is ignored as an exception`);
    }
  }
  if (fields.includeRoots !== undefined && fields.includeRoots.length === 0) {
    warnings?.push("include roots are EMPTY — nothing was read; name the folders to compile in the plugin settings");
  }
  // An EMPTY map (the plugin's shipped default) makes no note exportable in
  // frontmatter mode, and a vault whose class names do not look like a kind
  // would otherwise compile nothing in silence — the unmapped-spelling warning
  // above only fires for spellings that contain a kind word. Say it once.
  if ((fields.typeSource ?? "frontmatter") === "frontmatter" && fields.typeMap !== undefined && Object.keys(fields.typeMap).length === 0) {
    warnings?.push("type map is EMPTY — in frontmatter mode no note is exportable; map your vault types (e.g. `Person/Agent = agent`) in the plugin settings");
  }
  return notes;
}

export async function runExport(src: SkillsSource, opts: ExportOptions): Promise<ExportSummary> {
  const { notes, excluded, refusedEmbeds, generated, warnings, errors, vaultPath } = await collectAndTransform(src, opts.fields ?? DEFAULT_FIELDS, opts.pluginName, opts.preloadCap);

  // A compile that read NO note is a misconfiguration, never an intent: with
  // the shipped empty roots or an empty type map the first export after an
  // upgrade would otherwise remove every file of the previous export (the
  // stale-cleanup below deletes whatever the last manifest listed and this run
  // did not produce). Refuse, and say why, before anything on disk is touched.
  if (notes.length === 0) {
    const previous = readManifestFiles(opts.outputDir).length;
    const why = warnings.length ? ` (${warnings.join("; ")})` : "";
    throw new Error(`nothing to export: the compile read no skill/agent/policy/command note${why} — refusing rather than remove the ${previous} file(s) of the previous export in ${opts.outputDir}; name the folders and the type map in the plugin settings`);
  }

  ensurePluginManifest(opts.outputDir, opts.pluginName, opts.pluginDescription, opts.version);

  // Overwrite: remove previously-generated files (tracked in the manifest), then write.
  const manifestPath = path.join(opts.outputDir, MANIFEST_NAME);
  const prev = readManifestFiles(opts.outputDir);

  const files = outputFileSet(generated);

  // Supporting files: each skill note may have a parallel folder of assets (scripts,
  // references) that gets bundled into its generated skills/<name>/ dir. Asset trouble
  // (unreadable dir, iCloud timeout) degrades to a warning for that skill — it must
  // never abort the export. A file that fails to materialize keeps its previously
  // exported copy rather than having stale-cleanup delete it.
  const assetCopies: { src: string; relOut: string }[] = [];
  const retained: string[] = [];
  if (opts.assetsRoot) {
    for (const g of files) {
      if (g.kind !== "skill" || !g.from.endsWith(".md")) continue; // skip static/synthesized
      const dir = assetDirFor(opts.assetsRoot, g.from);
      const skillDir = path.dirname(g.relOut);
      try {
        const { files: assets, failed, warnings: assetWarnings } = await collectAssets(dir, opts.assetOptions);
        warnings.push(...assetWarnings);
        for (const a of assets) {
          if (a.rel === "SKILL.md") { warnings.push(`${dir}/SKILL.md: supporting file would overwrite the generated SKILL.md — skipped`); continue; }
          assetCopies.push({ src: a.abs, relOut: `${skillDir}/${a.rel}` });
        }
        for (const rel of failed) {
          const relOut = `${skillDir}/${rel}`;
          if (prev.includes(relOut)) {
            retained.push(relOut);
            warnings.push(`${relOut}: kept the previously exported copy`);
          }
        }
      } catch (e) {
        warnings.push(`${dir}: could not read supporting files — ${e instanceof Error ? e.message : String(e)}; skipped`);
      }
    }
  }

  const nextFiles = [...files.map((g) => g.relOut), ...assetCopies.map((a) => a.relOut), ...retained];
  const toRemove = prev.filter((p) => !nextFiles.includes(p));
  for (const rel of toRemove) {
    const abs = path.join(opts.outputDir, rel);
    try { fs.rmSync(abs, { force: true }); } catch { /* ignore */ }
    const parent = path.dirname(abs);
    try { if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* ignore */ }
  }

  for (const g of files) {
    const abs = path.join(opts.outputDir, g.relOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, g.content);
  }
  for (const a of assetCopies) {
    try {
      copyAsset(a.src, path.join(opts.outputDir, a.relOut));
    } catch (e) {
      warnings.push(`${a.relOut}: copy failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify({
    generatedFrom: "obsidian-vault-skills",
    vault: vaultPath ?? null,
    count: nextFiles.length,
    files: nextFiles.sort(),
  }, null, 2) + "\n");

  return {
    skills: files.filter((g) => g.kind === "skill").length,
    agents: files.filter((g) => g.kind === "agent").length,
    commands: files.filter((g) => g.kind === "command").length,
    assets: assetCopies.length,
    removed: toRemove.length,
    excluded: excludedSummary(excluded, refusedEmbeds),
    warnings,
    errors,
    outputDir: opts.outputDir,
    sources: [...new Set(generated.flatMap((g) => g.sources ?? []))],
  };
}

export interface Analysis {
  tree: TreeNode[];
  errors: string[];
  warnings: string[];
  counts: { skills: number; agents: number; policies: number; commands: number };
  /** Typed notes the acceptance gate refused (01.41 rule 8): total, per kind, and their paths. */
  excluded: Excluded;
  /** Notes naming more than one parent: primary edge + recorded attachments. */
  attachments: Attachment[];
  /** What each agent's compiled `skills:` (preload) list carries, and the cap it was
   *  checked against — context provisioning, not a permission boundary. */
  preloads: PreloadPlacement[];
  preloadCap: number;
}

/** Collected notes + transform result: the shared prologue for export, analyze, and preview,
 *  so the three surfaces can never disagree about the same vault. */
interface Compiled {
  notes: NoteInput[];
  /** The typed notes the acceptance gate refused (01.41 rule 8). */
  excluded: ExcludedNote[];
  /** The embed targets the gate refused to inline. */
  refusedEmbeds: Set<string>;
  vaultPath: string | undefined;
  generated: Generated[];
  tree: TreeNode[];
  policies: PolicyPlacement[];
  attachments: Attachment[];
  preloads: PreloadPlacement[];
  preloadCap: number;
  warnings: string[];
  errors: string[];
}

/** One emitted output file: a transform Generated or a shipped static. */
type OutputFile = Omit<Generated, "kind"> & { kind: EmittedKind | "hook" };

/** The complete file set an export writes — generated content plus shipped static skills
 *  (static wins on relOut collision). Shared by {@link runExport} and {@link previewVault}
 *  so the preview always describes exactly what the export would do. */
function outputFileSet(generated: Generated[]): OutputFile[] {
  const staticRelOuts = new Set(STATIC_FILES.map((s) => s.relOut));
  return [
    ...generated.filter((g) => !staticRelOuts.has(g.relOut)),
    ...STATIC_FILES.map((s): OutputFile => ({ kind: s.kind, relOut: s.relOut, content: s.content, from: "(static)" })),
  ];
}

async function collectAndTransform(src: SkillsSource, fields: DetectConfig, pluginName: string, preloadCap?: number): Promise<Compiled> {
  const collectWarnings: string[] = [];
  const excluded: ExcludedNote[] = [];
  const refusedEmbeds = new Set<string>();
  const acceptance = new Map<string, SourceAcceptance>();
  const notes = await collectNotes(src, fields, collectWarnings, excluded, refusedEmbeds, acceptance);
  const vaultPath = src.basePath() ?? undefined;
  const result = transformAll(notes, { pluginName, synthesizeRoot: true, vaultPath, preloadCap, acceptance, refused: refusedEmbeds });
  result.warnings.unshift(...collectWarnings);
  return { notes, excluded, refusedEmbeds, vaultPath, ...result };
}

function countsOf(tree: TreeNode[], notes: NoteInput[]): Analysis["counts"] {
  return {
    agents: tree.filter((n) => n.kind === "agent").length,
    skills: tree.filter((n) => n.kind === "skill").length,
    policies: notes.filter((n) => n.frontmatter.type === "policy").length,
    commands: notes.filter((n) => n.frontmatter.type === "command").length,
  };
}

function readManifestFiles(outputDir: string): string[] {
  try { return JSON.parse(fs.readFileSync(path.join(outputDir, MANIFEST_NAME), "utf8")).files ?? []; } catch { return []; }
}

/** Shared read-only core for `validate` and `tree`: collect + transform, no write. */
export async function analyzeVault(src: SkillsSource, fields: DetectConfig = DEFAULT_FIELDS, pluginName = "vault-skills", preloadCap?: number): Promise<Analysis> {
  const c = await collectAndTransform(src, fields, pluginName, preloadCap);
  return {
    tree: c.tree, errors: c.errors, warnings: c.warnings, counts: countsOf(c.tree, c.notes),
    excluded: excludedSummary(c.excluded, c.refusedEmbeds),
    attachments: c.attachments, preloads: c.preloads, preloadCap: c.preloadCap,
  };
}

export type PreviewStatus = "added" | "modified" | "unchanged";

export interface PreviewEntry {
  kind: EmittedKind | "hook";
  relOut: string;
  from: string;
  /** Vault paths of notes transcluded into the source note's body — the other notes an
   *  edit to this compiled file's content might actually belong to. */
  sources?: string[];
  name?: string;
  description?: string;
  content: string;
  bytes: number;
  status: PreviewStatus;
  /** The currently exported content — present only when `status` is "modified". */
  cachedContent?: string;
}

export interface PreviewResult {
  tree: TreeNode[];
  /** Typed notes the acceptance gate refused (01.41 rule 8). */
  excluded: Excluded;
  entries: PreviewEntry[];
  /** Previously exported generated files no export would rewrite (would be deleted). */
  removed: string[];
  diff: { added: number; modified: number; unchanged: number; removed: number };
  policies: PolicyPlacement[];
  /** Notes naming more than one parent: primary edge + recorded attachments. */
  attachments: Attachment[];
  /** What each agent's compiled `skills:` (preload) list carries, and the cap. */
  preloads: PreloadPlacement[];
  preloadCap: number;
  errors: string[];
  warnings: string[];
  counts: Analysis["counts"];
  outputDir: string;
  /** Bundled skill assets are excluded from the preview and from removal detection —
   *  collecting them can trigger iCloud materialization, a side effect preview must not have. */
  assetsNote: string;
}

/** Bundled skill assets live inside a skill's dir alongside its generated SKILL.md — the one
 *  manifest-tracked family the preview can't predict without collecting assets. */
const isAssetPath = (p: string): boolean => p.startsWith("skills/") && !/^skills\/[^/]+\/SKILL\.md$/.test(p);

/** Read-only preview: the exact file set an export would write (same collect + transform +
 *  static merge as {@link runExport}), each entry diffed against the current output dir.
 *  Never writes; never collects assets. */
export async function previewVault(
  src: SkillsSource,
  opts: { outputDir: string; pluginName: string; fields?: DetectConfig; preloadCap?: number },
): Promise<PreviewResult> {
  const { notes, excluded, refusedEmbeds, generated, tree, warnings, errors, policies, attachments, preloads, preloadCap } =
    await collectAndTransform(src, opts.fields ?? DEFAULT_FIELDS, opts.pluginName, opts.preloadCap);

  const files = outputFileSet(generated);

  const entries: PreviewEntry[] = await Promise.all(files.map(async (g) => {
    let cached: string | null = null;
    try { cached = await fs.promises.readFile(path.join(opts.outputDir, g.relOut), "utf8"); } catch { /* not exported yet */ }
    const status: PreviewStatus = cached == null ? "added" : cached === g.content ? "unchanged" : "modified";
    return {
      kind: g.kind, relOut: g.relOut, from: g.from, name: g.name, description: g.description,
      ...(g.sources?.length ? { sources: g.sources } : {}),
      content: g.content, bytes: Buffer.byteLength(g.content), status,
      ...(status === "modified" ? { cachedContent: cached as string } : {}),
    };
  }));

  // Removal mirror of runExport's stale-cleanup: every manifest entry the export would no
  // longer write — including retired static files — except bundled assets, which the preview
  // can't predict (see assetsNote) and therefore never reports.
  const prev = readManifestFiles(opts.outputDir);
  const next = new Set(entries.map((e) => e.relOut));
  const removed = prev.filter((p) => !next.has(p) && !isAssetPath(p));

  return {
    tree, entries, removed,
    excluded: excludedSummary(excluded, refusedEmbeds),
    diff: {
      added: entries.filter((e) => e.status === "added").length,
      modified: entries.filter((e) => e.status === "modified").length,
      unchanged: entries.filter((e) => e.status === "unchanged").length,
      removed: removed.length,
    },
    policies, attachments, preloads, preloadCap, errors, warnings,
    counts: countsOf(tree, notes),
    outputDir: opts.outputDir,
    assetsNote: "bundled skill assets are not previewed",
  };
}

export interface MarkInput {
  type: "skill" | "agent" | "policy" | "command";
  parent?: string;      // agent basename or [[wikilink]]; empty ⇒ root
  description?: string;
  root?: boolean;
}

export interface MarkResult {
  /** Frontmatter keys to Object.assign onto the note (already namespaced per field mode). */
  set: Record<string, unknown>;
  /** Frontmatter keys to delete (already namespaced) — e.g. the tree-only fields when demoting a
   *  note to a flat command, so a stale `parent`/`root`/… doesn't linger as misleading metadata. */
  unset: string[];
  /** Kind tags (with a leading `#`) to append to the note's `tags` — non-empty only in tags mode. */
  addTags: string[];
  /** Kind tags (with a leading `#`) to strip from `tags` before appending — the whole
   *  `#{prefix}{kind}` family, so re-marking replaces the kind rather than adding a second one. */
  removeTags: string[];
}

/** Pure: how to mark a note as a given kind, honoring the field mode and detection mode. In tags
 *  mode the kind becomes a tag (`addTags`) instead of a `type:` field; parent/description/root
 *  stay frontmatter fields in both modes. Apply with {@link applyMark}. */
export function markFrontmatter(input: MarkInput, fields: DetectConfig = DEFAULT_FIELDS): MarkResult {
  const tagsMode = (fields.typeSource ?? "frontmatter") === "tags";
  const addTags: string[] = [];
  const removeTags: string[] = [];
  const flat: Record<string, unknown> = {};
  if (tagsMode) {
    const prefix = fields.tagPrefix ?? DEFAULT_TAG_PREFIX;
    addTags.push(`#${prefix}${input.type}`);
    // strip every sibling kind tag first, so re-marking swaps the kind (not two → "ambiguous")
    for (const k of EXPORTABLE_TYPES) removeTags.push(`#${prefix}${k}`);
  } else {
    // Write the VAULT'S spelling for the kind, never the bare kind: under a
    // type map `policy` may be spelled `Note/AgentPolicy`, and writing `policy`
    // would mark a note the compiler then cannot see (#404). A map that names
    // no spelling for the kind cannot mark it — refuse rather than guess.
    const spelling = spellingFor(input.type, fields.typeMap ?? IDENTITY_TYPE_MAP);
    if (spelling === null) {
      throw new Error(`the type map names no vault spelling for '${input.type}' — add one (e.g. \`Note/AgentPolicy = policy\`) in the plugin settings before marking a note as it`);
    }
    flat.type = spelling;
  }
  const isCommand = input.type === "command";
  if (input.root) flat.root = true;
  // Commands are flat — a parent is meaningless, so never write one (and clear a stale one below).
  if (input.parent && !isCommand) flat.parent = input.parent.startsWith("[[") ? input.parent : `[[${input.parent}]]`;
  if (input.description) flat.description = input.description;

  let set: Record<string, unknown>;
  const unset: string[] = [];
  if (fields.mode === "nested") {
    // Nested mode replaces the whole object, so stale sub-fields drop on their own.
    set = Object.keys(flat).length ? { [fields.key]: flat } : {};
  } else {
    // prefix mode — a blank prefix yields bare top-level fields. Individual keys are set in place,
    // so demoting to a command must explicitly clear the tree-only fields it leaves behind.
    set = {};
    for (const [k, v] of Object.entries(flat)) set[fields.prefix + k] = v;
    if (isCommand) for (const k of ["parent", "root", "crosscutting", "slot"]) unset.push(fields.prefix + k);
  }
  return { set, unset, addTags, removeTags };
}

/** Apply a {@link markFrontmatter} result to a note's frontmatter object in place: assign the
 *  fields, then reconcile `tags` — strip the kind-tag family, then dedup-append the new kind tag
 *  (stored bare, without `#`, as Obsidian does). A scalar/string `tags` value is split the same
 *  way {@link extractTags} reads it, so pre-existing tags survive as distinct entries. */
export function applyMark(fm: Record<string, unknown>, result: MarkResult): void {
  Object.assign(fm, result.set);
  for (const k of result.unset ?? []) delete fm[k];
  const addTags = result.addTags ?? [];
  const removeTags = result.removeTags ?? [];
  if (!addTags.length && !removeTags.length) return;

  const raw = fm.tags;
  let existing: string[] =
    Array.isArray(raw) ? raw.map(String)
    : typeof raw === "string" ? raw.split(/[,\s]+/).filter(Boolean)
    : raw == null ? [] : [String(raw)];
  const bare = (t: string): string => t.replace(/^#/, "").toLowerCase();

  const remove = new Set(removeTags.map(bare));
  existing = existing.filter((t) => !remove.has(bare(t)));
  const have = new Set(existing.map(bare));
  for (const tag of addTags) {
    const b = tag.replace(/^#/, "");
    if (!have.has(b.toLowerCase())) {
      existing.push(b);
      have.add(b.toLowerCase());
    }
  }
  fm.tags = existing;
}

/** Make sure the output dir is a valid Claude Code plugin (create manifest if absent).
 *  When `version` is given (release export), set it on the manifest — creating the file
 *  or updating an existing one in place, preserving its other fields. */
function ensurePluginManifest(outputDir: string, name: string, description?: string, version?: string): void {
  const file = path.join(outputDir, ".claude-plugin", "plugin.json");
  if (fs.existsSync(file)) {
    if (!version) return;
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
      // Never clobber a manifest we can't parse — its fields (description, author, …)
      // would be silently lost.
      throw new Error(`${file} is not valid JSON — fix or remove it, then re-run the release export`);
    }
    fs.writeFileSync(file, JSON.stringify({ name, ...manifest, version }, null, 2) + "\n");
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    name,
    description: description || `Skills and agents exported from an Obsidian vault by ${name}.`,
    version: version ?? "0.1.0",
  }, null, 2) + "\n");
}

/** Read the version from an existing plugin manifest (for suggesting the next release). */
export function readPluginVersion(outputDir: string): string | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(outputDir, ".claude-plugin", "plugin.json"), "utf8")).version;
    return typeof v === "string" ? v : undefined;
  } catch { return undefined; }
}
