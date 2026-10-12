// settings.ts — the satellite's own settings shape, its field definitions, and
// the ONE-SHOT adoption of the host's `modules.skills.config`.
//
// ── Why adoption exists ──────────────────────────────────────────────────────
//
// Before this extraction the skills compiler was a capability MODULE inside the
// Governor host, and its configuration lived in the host's data.json at
// `modules.skills.config` — output dir, plugin name, detection mode, field
// namespacing, assets root, release dir, export-on-save, preload cap. A user who
// upgrades gets a brand-new plugin with a brand-new, EMPTY data.json, and would
// silently start exporting to the default `~/.claude/skills/vault-skills`
// instead of wherever they actually publish. That is a data-shaped surprise, so
// the satellite adopts the host's values once, on first load.
//
// Three rules, all deliberate:
//
//   1. IT NEVER WRITES THE HOST'S SETTINGS. Not to delete the adopted keys, not
//      to mark them migrated, not at all. The host's settings shape is the
//      host's; a satellite reaching into another plugin's data.json to tidy up
//      is exactly the boundary this split exists to draw. The host's copy stays
//      where it is and simply stops being read (the module is gone from the
//      host, so nothing reads it there either).
//   2. IT RUNS ONCE. `adoptedFromHost` latches, so a later host edit does not
//      reach back in and overwrite what the user has since set here.
//   3. THE SATELLITE'S OWN VALUES WIN. If this plugin already has config keys
//      (host installed after the satellite, say), adoption fills only the gaps.
//
// If the host is ABSENT at first load, nothing is adopted and the latch is NOT
// set — the satellite works standalone, and if the host shows up later the
// adoption still gets its one chance.

import { DEFAULT_SKILLS_CONFIG } from "./kernel/index.js";
import { parseTypeMapLines } from "./kernel/skills-config.js";

/** The satellite's persisted settings (its own data.json). */
export interface SkillsPluginSettings {
  /** Config overrides, keyed exactly as the host's `modules.skills.config` was —
   *  same key names, same meanings — so adoption is a straight copy and a
   *  hand-migrated file works too. Missing keys fall back to
   *  DEFAULT_SKILLS_CONFIG via `skillsConfigOf`. */
  config: Record<string, unknown>;
  /** The one-shot adoption latch (rule 2 above). */
  adoptedFromHost: boolean;
}

export const DEFAULT_PLUGIN_SETTINGS: SkillsPluginSettings = { config: {}, adoptedFromHost: false };

/** Coerce whatever `loadData()` returned into a settings object. A hand-edited
 *  or corrupt data.json degrades to the defaults rather than throwing during
 *  onload — the same skip-and-report discipline the config coercion uses. */
export function settingsOf(raw: unknown): SkillsPluginSettings {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const config = r.config && typeof r.config === "object" && !Array.isArray(r.config)
    ? { ...(r.config as Record<string, unknown>) }
    : {};
  return { config, adoptedFromHost: r.adoptedFromHost === true };
}

/** The config keys adoption carries across — exactly the fields the host's
 *  skills module manifest declared. An unknown key in the host's record is NOT
 *  copied: it was never a skills config field, and copying it would import
 *  someone else's mistake. */
export const ADOPTABLE_KEYS: readonly string[] = Object.keys(DEFAULT_SKILLS_CONFIG);

/**
 * The pure half of adoption. Returns the settings to persist, or `null` when
 * there is nothing to do (already adopted, or the host is absent).
 *
 * `hostSettings` is the host plugin's own settings object, read but never
 * written. A host that is present with no skills config still LATCHES: the
 * question was asked and answered, and re-asking every load would let a much
 * later host edit reach in.
 */
export function adoptHostConfig(
  current: SkillsPluginSettings,
  hostSettings: unknown,
): SkillsPluginSettings | null {
  if (current.adoptedFromHost) return null;
  if (!hostSettings || typeof hostSettings !== "object") return null; // host absent — try again next load
  const modules = (hostSettings as { modules?: unknown }).modules;
  const skills = modules && typeof modules === "object"
    ? (modules as Record<string, unknown>).skills
    : undefined;
  const hostConfig = skills && typeof skills === "object"
    ? (skills as { config?: unknown }).config
    : undefined;
  const adopted: Record<string, unknown> = {};
  if (hostConfig && typeof hostConfig === "object" && !Array.isArray(hostConfig)) {
    for (const key of ADOPTABLE_KEYS) {
      const value = (hostConfig as Record<string, unknown>)[key];
      // Rule 3: the satellite's own value wins where it already has one.
      if (value !== undefined && !(key in current.config)) adopted[key] = value;
    }
  }
  return { config: { ...current.config, ...adopted }, adoptedFromHost: true };
}

// ── settings-tab field definitions (pure data; rendered by settings-tab.ts) ──
//
// Ported verbatim from SKILLS_CONFIG_FIELDS in the host's mcp/modules-mount.ts —
// same keys, same labels, same help text. The host rendered them through its
// generic manifest-driven config tab; this plugin renders them itself, which is
// the settings tab the standalone vault-skills plugin had before the fold. The
// help text is the user-facing documentation of each key, so it moves with the
// keys rather than being rewritten.

/** What a textarea field's raw text means, pure so the tab's commit rule is
 *  headless-testable: a `typemap` parses `<vault type> = <kind>` lines and
 *  reports every bad line as a problem; `lines` is one entry per non-blank
 *  line. The tab commits `value` only when `problems` is empty — a mistyped
 *  line must stay in front of the user, never be dropped in silence. */
export function textAreaValue(field: SkillsField, raw: string): { value: unknown; problems: string[] } {
  if (field.type === "typemap") {
    const { map, problems } = parseTypeMapLines(raw);
    return { value: map, problems };
  }
  return { value: raw.split("\n").map((l) => l.trim()).filter(Boolean), problems: [] };
}

export type SkillsFieldType = "text" | "select" | "toggle" | "number" | "lines" | "typemap";

export interface SkillsField {
  key: string;
  label: string;
  type: SkillsFieldType;
  help: string;
  options?: string[];
}

export const SKILLS_FIELDS: SkillsField[] = [
  { key: "outputDir", label: "Output plugin directory", type: "text", help: "Where vaultmcp_skills_export writes the generated Claude Code plugin (skills/ + agents/). ~ is expanded." },
  { key: "pluginName", label: "Plugin name", type: "text", help: "Claude Code plugin name — also the command/subagent namespace." },
  { key: "typeSource", label: "Type source", type: "select", options: ["frontmatter", "tags"], help: "How a note declares its kind: the `type` frontmatter field, or a kind tag." },
  { key: "typeMap", label: "Type map", type: "typemap", help: "Frontmatter mode only. One line per vault type, `<vault type> = <kind>`, kind one of skill / agent / policy / command — e.g. `Note/AgentPolicy = policy`, `Person/Agent = agent`. Ships EMPTY: this plugin does not assume your class names, so nothing compiles until you map them. Case-sensitive." },
  { key: "includeRoots", label: "Folders to compile", type: "lines", help: "One vault folder per line. Only notes under these are read. Ships EMPTY, which means nothing is read. An entry covers its folder and everything below it, but not a name that merely continues it (`03.18` does not cover `03.180 …`); end it with / to pin the folder name exactly (`Archive/` does not cover `Archive Old/`, and still covers everything below Archive). Matching ignores case. Leave OUT any folder Claude Code already loads natively (for example one symlinked as ~/.claude/agents), or its agents load twice." },
  { key: "excludeRoots", label: "Folders to skip", type: "lines", help: "Folders under a compiled folder the compiler must not read — a template folder, a natively-loaded folder. Same matching rule as above." },
  { key: "guardedRoots", label: "Guarded territories", type: "lines", help: "01.61 rule 8a. One vault folder per line whose notes NEVER reach this fleet-wide plugin: not as a skill, agent, policy or command, and not through an embed in another note (a marker naming no path stands in its place). Its policies travel only in the territory's own lead's charter. Same matching rule as above. Name the territory here, not under Folders to skip, or the exception below cannot reach it." },
  { key: "fleetWideRules", label: "Fleet-wide rules from a guarded territory", type: "lines", help: "01.61 rule 8a's one exception (Nelson, 2026-10-12): the exact vault path, one per line, of each policy note under a guarded territory that states its data-loss rules and holds no case content. Each compiles fleet-wide like any policy, if it is accepted and typed as a policy. A folder or a non-policy note here compiles nothing. A policy note that carries case facts must never be listed." },
  { key: "tagPrefix", label: "Tag prefix", type: "text", help: "Tags mode: kind tags are #{prefix}skill / #{prefix}agent / … (e.g. agent/ → #agent/skill)." },
  { key: "fieldMode", label: "Frontmatter field mode", type: "select", options: ["prefix", "nested"], help: "How vault-skills fields are namespaced: prefix (bare/prefixed top-level fields) or nested (all under one key)." },
  { key: "fieldPrefix", label: "Field prefix", type: "text", help: "prefix mode: prefixes each field, e.g. vs- → vs-type. Blank ⇒ bare top-level fields (type, parent, …)." },
  { key: "fieldKey", label: "Field key", type: "text", help: "nested mode: nests every field under this one key, e.g. vault-skills." },
  { key: "assetsRoot", label: "Supporting-files tree", type: "text", help: "Root of a parallel filesystem tree of skills' supporting files. Blank ⇒ none. ~ is expanded." },
  { key: "releaseDir", label: "Release repo directory", type: "text", help: "A git checkout vaultmcp_skills_release targets. Blank ⇒ release disabled. ~ is expanded." },
  { key: "exportOnSave", label: "Export on save", type: "toggle", help: "When on, this plugin re-exports automatically (debounced) whenever a skill/agent/policy/command note changes. Off ⇒ export only when you run it. Ignored by the MCP tool surface." },
  { key: "preloadCap", label: "Preload cap (warn above)", type: "number", help: "How many `preload: true` skills may be compiled into one agent's `skills:` list before the compile warns. A warning, not a refusal — preloading is context provisioning, and a large set spends the fresh context window a subagent is delegated for." },
];
