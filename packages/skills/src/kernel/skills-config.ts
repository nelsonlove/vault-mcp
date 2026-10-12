// skills-config.ts — the skills module's configuration shape and the pure
// mapping from a stored `modules.skills.config` record to the exporter's
// DetectConfig. Obsidian-free (node built-ins only), so it moves with the
// rest of the pure core and is headless-testable.
//
// In the STANDALONE vault-skills plugin this logic lived in `settings.ts`
// (coupled to `PluginSettingTab`) and `paths.ts`. Here only the pure halves
// come across: the settings-tab UI is replaced by the config-host's generic,
// manifest-driven renderer (SKILLS_MANIFEST in mcp/modules-mount.ts).
//
// `exportOnSave` came BACK with the GUI fold (#82 GUI residuals): a vault-mcp
// module has no vault-side save hook of its own, but the in-Obsidian skills GUI
// (src/skills/) does — its debounced export-on-save trigger reads this flag.
// It stays OFF by default (opt-in); the MCP tool surface never reads it, so a
// tool-only deployment behaves exactly as before.

import * as os from "node:os";
import * as path from "node:path";
import { EXPORTABLE_TYPES, isExportableType, type DetectConfig, type ExportableKind } from "./exporter.js";
import { resolveTerritories } from "@vault-mcp/core";
import { DEFAULT_PRELOAD_CAP } from "./transform.js";

/** The skills module's config, as stored under `modules.skills.config` and
 * merged over the manifest defaults. A superset of what the exporter needs:
 * the field/detection config plus the two write destinations (export +
 * release) and the optional supporting-files root. */
export interface SkillsConfig {
  /** Where `vaultmcp_skills_export` writes the generated Claude Code plugin. `~` expanded. */
  outputDir: string;
  /** Claude Code plugin name — also the command/subagent namespace. */
  pluginName: string;
  /** How a note declares its kind: the `type` frontmatter field, or a kind tag. */
  typeSource: "frontmatter" | "tags";
  /** Frontmatter mode: the vault's own `type` spellings → the kind each compiles
   *  as (`Note/AgentPolicy` → `policy`). SHIPS EMPTY (#404): a plugin must not
   *  bake in one vault's class names, so nothing compiles until the operator maps
   *  theirs. Case-sensitive. */
  typeMap: Record<string, ExportableKind>;
  /** Vault-relative folders the compiler reads. SHIPS EMPTY = reads nothing; the
   *  operator names the folders. `03 Agents/03.18 Claude Code agents` stays out
   *  until the fleet's switch (Claude Code loads it natively today). */
  includeRoots: string[];
  /** Folders under an include root the compiler must not read. */
  excludeRoots: string[];
  /** 01.61 rule 8a: folders whose notes never reach the fleet-wide plugin. */
  guardedRoots: string[];
  /** 01.61 rule 8a's exception: exact vault paths of the data-loss rule policies under a guarded root. */
  fleetWideRules: string[];
  /** Tags mode: `#{tagPrefix}{kind}` (e.g. `agent/` -> `#agent/skill`). */
  tagPrefix: string;
  /** How the vault-skills frontmatter fields are namespaced. */
  fieldMode: "prefix" | "nested";
  /** prefix mode: prefixes each field (blank => bare top-level fields). */
  fieldPrefix: string;
  /** nested mode: nests every field under this one key. */
  fieldKey: string;
  /** Root of a parallel filesystem tree of skills' supporting files. Blank => none. `~` expanded. */
  assetsRoot: string;
  /** A git checkout `vaultmcp_skills_release` targets. Blank => release disabled. `~` expanded. */
  releaseDir: string;
  /** GUI only: re-export automatically when a skill/agent/policy/command note
   *  (or a transcluded source note) changes. Debounced; opt-in (default false).
   *  The MCP tool surface never reads this — it is a human-GUI affordance. */
  exportOnSave: boolean;
  /** How many skills may be preloaded (`preload: true`) into ONE agent before the
   *  compile warns. A WARNING, not a refusal — the vault decides — because a large
   *  preload set spends the fresh context window a subagent is delegated for. */
  preloadCap: number;
}

/** The module's config defaults — mirrors the standalone plugin's
 * DEFAULT_SETTINGS. Fed to the manifest as `config.defaults`, so the config tab
 * renders them and `register()` receives them merged under any user override.
 * `exportOnSave` defaults OFF: the GUI's on-save export is opt-in. */
export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  outputDir: "~/.claude/skills/vault-skills",
  pluginName: "vault-skills",
  typeSource: "frontmatter",
  typeMap: {},
  includeRoots: [],
  excludeRoots: [],
  guardedRoots: [],
  fleetWideRules: [],
  tagPrefix: "agent/",
  fieldMode: "prefix",
  fieldPrefix: "",
  fieldKey: "vault-skills",
  assetsRoot: "",
  releaseDir: "",
  exportOnSave: false,
  preloadCap: DEFAULT_PRELOAD_CAP,
};

/** Coerce a merged config record (defaults + user override, as `register()`
 * receives it) into a typed SkillsConfig, falling back to the default for any
 * value of the wrong shape — a hand-edited data.json must never crash a tool,
 * only degrade to the default (the vocab/scheme skip-and-report discipline). */
export function skillsConfigOf(config: Record<string, unknown>): SkillsConfig {
  const str = (k: keyof SkillsConfig): string =>
    typeof config[k] === "string" ? (config[k] as string) : (DEFAULT_SKILLS_CONFIG[k] as string);
  const typeSource = config.typeSource === "tags" ? "tags" : "frontmatter";
  const fieldMode = config.fieldMode === "nested" ? "nested" : "prefix";
  return {
    outputDir: str("outputDir"),
    pluginName: str("pluginName"),
    typeSource,
    typeMap: typeMapOf(config.typeMap),
    // The same resolver the host's territories use: trimmed, blanks and
    // non-strings dropped, a leading `/` or `./` stripped — so a stray blank
    // line can never read as "the whole vault".
    includeRoots: [...resolveTerritories(config.includeRoots)],
    excludeRoots: [...resolveTerritories(config.excludeRoots)],
    guardedRoots: [...resolveTerritories(config.guardedRoots)],
    // Exact paths, not prefixes: the same trim-and-strip as a root. A line that
    // is not a note path is KEPT, so the compile can say it matches nothing.
    fleetWideRules: [...resolveTerritories(config.fleetWideRules)],
    tagPrefix: str("tagPrefix"),
    fieldMode,
    fieldPrefix: str("fieldPrefix"),
    fieldKey: str("fieldKey"),
    assetsRoot: str("assetsRoot"),
    releaseDir: str("releaseDir"),
    // Only a literal `true` enables it; any other/missing value degrades to off.
    exportOnSave: config.exportOnSave === true,
    // A hand-edited non-number (or a negative) degrades to the default rather than
    // disabling the warning silently.
    preloadCap: typeof config.preloadCap === "number" && Number.isFinite(config.preloadCap) && config.preloadCap >= 0
      ? Math.trunc(config.preloadCap)
      : DEFAULT_SKILLS_CONFIG.preloadCap,
  };
}

/** The detection + field-namespacing config the exporter reads — the single
 * mapping shared by export, the read-only tools, and the mark write path.
 * `typeMap` and the roots ride along so every collector applies them. */
export function fieldsOf(s: SkillsConfig): DetectConfig {
  return {
    mode: s.fieldMode, prefix: s.fieldPrefix, key: s.fieldKey, typeSource: s.typeSource, tagPrefix: s.tagPrefix,
    typeMap: s.typeMap, includeRoots: s.includeRoots, excludeRoots: s.excludeRoots, guardedRoots: s.guardedRoots, fleetWideRules: s.fleetWideRules,
  };
}

/** Coerce a stored type map: an object whose values are exportable kinds. Any
 *  other shape, and any entry with a non-kind value or a blank key, is DROPPED
 *  (reported by `validateSkillsConfig`), never guessed. */
export function typeMapOf(raw: unknown): Record<string, ExportableKind> {
  const out: Record<string, ExportableKind> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (key && isExportableType(v)) out[key] = v;
  }
  return out;
}

/** The settings tab stores the map as lines of `<vault type> = <kind>`; this is
 *  the parse (one entry per line, first `=` splits, blanks ignored) and its
 *  inverse. Kept pure so the tab's round-trip is testable headlessly. */
export function parseTypeMapLines(text: string): { map: Record<string, ExportableKind>; problems: string[] } {
  const map: Record<string, ExportableKind> = {};
  const problems: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) { problems.push(`'${line}': expected '<vault type> = <kind>'`); continue; }
    const key = line.slice(0, eq).trim();
    const kind = line.slice(eq + 1).trim();
    if (!key) { problems.push(`'${line}': the vault type is blank`); continue; }
    if (!isExportableType(kind)) { problems.push(`'${line}': '${kind}' is not one of ${EXPORTABLE_TYPES.join("/")}`); continue; }
    map[key] = kind;
  }
  return { map, problems };
}

export function typeMapLines(map: Readonly<Record<string, ExportableKind>>): string {
  return Object.entries(map).map(([k, v]) => `${k} = ${v}`).join("\n");
}

/** Validate a merged config for the config tab (manifest.config.validate).
 * Loud, never coercing: an empty plugin name or an out-of-range select is
 * REPORTED, so the user sees the consequence. Field-namespace and destination
 * strings are free-form (any path), so they carry no validation. */
export function validateSkillsConfig(config: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof config.pluginName === "string" && config.pluginName.trim() === "") {
    problems.push("pluginName must not be blank — it is the Claude Code plugin/command/subagent namespace");
  }
  if (config.typeSource !== undefined && config.typeSource !== "frontmatter" && config.typeSource !== "tags") {
    problems.push('typeSource must be "frontmatter" or "tags"');
  }
  if (config.fieldMode !== undefined && config.fieldMode !== "prefix" && config.fieldMode !== "nested") {
    problems.push('fieldMode must be "prefix" or "nested"');
  }
  if (config.typeMap !== undefined) {
    if (!config.typeMap || typeof config.typeMap !== "object" || Array.isArray(config.typeMap)) {
      problems.push("typeMap must be an object of '<vault type>': '<kind>' — a hand-edited value of another shape is ignored entirely");
    } else {
      for (const [k, v] of Object.entries(config.typeMap as Record<string, unknown>)) {
        if (!k.trim()) problems.push("typeMap has an entry with a blank vault type — ignored");
        else if (!isExportableType(v)) problems.push(`typeMap: '${k}' → '${String(v)}' is not one of ${EXPORTABLE_TYPES.join("/")} — ignored`);
      }
    }
  }
  if (Object.keys(typeMapOf(config.typeMap)).length === 0 && (config.typeSource ?? "frontmatter") === "frontmatter") {
    problems.push("the type map is EMPTY: in frontmatter mode nothing will be compiled until you map your vault's type values (e.g. Note/AgentPolicy = policy)");
  }
  if (resolveTerritories(config.includeRoots).length === 0) {
    problems.push("include roots are EMPTY: nothing will be read until you name the folders to compile");
  }
  for (const p of resolveTerritories(config.fleetWideRules)) {
    if (!/\.md$/i.test(p)) problems.push(`fleetWideRules: '${p}' is not a note path (no .md) — the list names policy notes exactly, so this line matches nothing`);
  }
  if (resolveTerritories(config.fleetWideRules).length > 0 && resolveTerritories(config.guardedRoots).length === 0) {
    problems.push("fleetWideRules is set but guardedRoots is EMPTY: the list is only an exception inside a guarded territory, so it does nothing");
  }
  if (config.preloadCap !== undefined &&
      !(typeof config.preloadCap === "number" && Number.isFinite(config.preloadCap) && config.preloadCap >= 0)) {
    problems.push("preloadCap must be a number ≥ 0 — how many preloaded skills on one agent trip the warning");
  }
  return problems;
}

/** Expand a leading `~` to the home directory (the export/release write paths). */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
