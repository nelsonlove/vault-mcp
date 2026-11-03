// manifest.ts — ModuleManifest: a module's user-facing configuration
// contract (typed, renderable fields + cross-field validation) plus its
// capability directory (structured per-tool metadata). Grows
// `VaultModule.settingsSchema` into the "subscription" the config-host
// design describes: config = discoverability = docs, one source
// (docs/superpowers/specs/2026-08-10-config-host-design.md).
//
// Pure data types only — no Obsidian import, no UI code. The generic
// settings-tab renderer (connection-ui.ts) and, later, a docs emitter both
// read this shape; neither defines it. Kernel-module rules apply.

export type ConfigFieldType = "text" | "lines" | "csv" | "number" | "toggle" | "select";

/** One renderable, typed config field. The settings UI is generated from a
 * module's `fields` list — no per-module bespoke UI code. */
export interface ConfigField {
  /**
   * Path within this module's own FLAT config namespace — not a literal
   * settings.json path. By default it resolves to
   * `modules.<id>.config.<key>`; a module whose config predates the module
   * host (scheme, vocab) supplies a `ConfigBinding` (config-host.ts) that
   * resolves the same key against wherever the value actually lives
   * instead, so the generated UI reads/writes the EXISTING settings shape
   * with no data migration (design §3).
   */
  key: string;
  label: string;
  /** One sentence rendered under the field. */
  help?: string;
  type: ConfigFieldType;
  placeholder?: string;
  /** Required, and the only legal values, for `type: "select"`. */
  options?: string[];
  /** Rendered as a warning list under the field. A caveat is a STANDING
   * property of the field ("matching is case-sensitive"), independent of
   * the current value — validation problems (data-dependent) come from
   * `validate` instead, never from here. */
  caveats?: string[];
}

/** One agent-facing MCP tool, documented for the human-facing directory. */
export interface ToolDoc {
  /** Must name a tool the module actually registers — checked by
   * `toolDocDrift`, never assumed; the manifest cannot silently rot
   * relative to what really got registered. */
  name: string;
  /** One sentence. Convention (loosely checked, not enforced by types):
   * this is the tool's own `description`'s first sentence, so the human
   * layer and the agent-facing layer never diverge into two voices. */
  purpose: string;
  /** Must match the registered tool's `annotations.readOnlyHint` —
   * checked by `toolDocReadOnlyDrift`. */
  readOnly: boolean;
  /** Notable args, not a schema dump. */
  options?: Array<{ name: string; what: string }>;
  caveats?: string[];
  /** One call worth showing. */
  example?: string;
}

/** A non-tool surface: an address form (such as `uid:<value>`), a rule pack, or a
 * kernel arg a module contributes. */
export interface SurfaceDoc {
  name: string;
  purpose: string;
  caveats?: string[];
}

/**
 * A module's config storage location, for a module whose config predates
 * the module host (`settings.schemes[0]`, `settings.vocabularies`) rather
 * than living at `modules.<id>.config`. See design §3: no data migration in
 * v1 — the SAME manifest field keys resolve through this binding to
 * whatever settings shape already exists. `settings` is the plugin's FULL
 * settings object (not the `modules` slice, which is all `ModuleRegistry`
 * itself ever sees); `read`/`write` are pure and non-mutating (fresh
 * objects out — the discipline connection-ui's pre-existing
 * `updateJdConfig` already followed for the hand-built scheme section this
 * binding replaces).
 */
export interface ConfigBinding {
  /** Current values for every field this module declares, keyed by
   * `ConfigField.key`, pulled from wherever they actually live. */
  read(settings: unknown): Record<string, unknown>;
  /** Apply `patch` (changed keys only; a value of `undefined` REMOVES that
   * key — the same "blank means use the default" convention every
   * textarea field already used) and return a NEW settings object;
   * `settings` itself is never mutated. */
  write(settings: unknown, patch: Record<string, unknown>): unknown;
}

export interface ModuleManifest {
  /** One paragraph, user-facing: what this module is for. The settings
   * tab's per-module section intro. */
  summary: string;
  config?: {
    /** Renderable, typed fields. */
    fields: ConfigField[];
    /**
     * Cross-field validation over the CURRENT merged config (defaults +
     * stored override). Findings surface inline in the UI — an invalid
     * value is REPORTED, never silently coerced away or dropped to a
     * default with no visible trace. Subsumes any per-provider
     * `validateConfig` (e.g. `validateJdConfig` becomes the scheme
     * manifest's `validate`). Never throws in practice; a throw is
     * contained by the caller exactly like `ModuleRegistry.registerAll`
     * contains a throwing `ModuleSettingsSchema.validate` — one bad
     * module's validator must not take the settings tab down.
     */
    validate?(config: Record<string, unknown>): string[];
    /** Defaults merged UNDER the stored override — same semantics as
     * `ModuleSettingsSchema.defaults`. A module that wants its FIELD to
     * render blank when unset (rather than pre-filled with the default)
     * simply omits that key here — the field's placeholder/help text is
     * where "blank means the provider default" gets said instead. */
    defaults?: Record<string, unknown>;
  };
  /** Everything this module does, structured — the settings tab's
   * capability directory. A module with no `config` (or a `config` with no
   * fields) still renders its directory: a capability-directory-only
   * module is a legitimate manifest, not a degenerate one — the generic
   * renderer must produce its section regardless. */
  directory?: {
    /** Agent-facing MCP tools. */
    tools?: ToolDoc[];
    /** Non-tool surfaces this module recognizes, e.g. `uid:<value>`
     * anywhere a path argument is accepted. */
    addressForms?: SurfaceDoc[];
    /** Unregistered rule-pack contributions (findings surfaced
     * elsewhere, e.g. the conformance engine's packs). */
    rulePacks?: SurfaceDoc[];
    /** Cross-cutting kernel args this module adds. */
    kernelArgs?: SurfaceDoc[];
  };
}

/**
 * Manifest/registration drift check — pulled into phase 1 per the design's
 * own phasing list ("generic renderer ... + drift tests"), even though the
 * DOCS EMITTER that would also read this is explicitly deferred to a later
 * PR. Symmetric: every declared `ToolDoc.name` must be a tool the module
 * actually contributed, and every contributed tool must carry a `ToolDoc` —
 * the manifest can neither over-claim nor silently fall behind. Pure, so
 * it's testable without a server.
 */
export function toolDocDrift(manifestTools: ToolDoc[], contributedNames: string[]): string[] {
  const declared = new Set(manifestTools.map((t) => t.name));
  const contributed = new Set(contributedNames);
  const problems: string[] = [];
  for (const name of declared) {
    if (!contributed.has(name)) problems.push(`ToolDoc '${name}' does not match any tool the module actually contributed`);
  }
  for (const name of contributed) {
    if (!declared.has(name)) problems.push(`tool '${name}' was contributed but has no ToolDoc in the manifest`);
  }
  return problems;
}

/**
 * The other half of drift: `ToolDoc.readOnly` must match the tool's real
 * `annotations.readOnlyHint`. `annotations` is loosely typed (mirroring
 * `ToolDef.annotations` in module.ts) to avoid an import cycle; a
 * missing/non-boolean annotation counts as a mismatch against any declared
 * `readOnly` value — silence is not agreement.
 */
export function toolDocReadOnlyDrift(
  manifestTools: ToolDoc[],
  annotationsByName: Record<string, { readOnlyHint?: boolean } | undefined>,
): string[] {
  const problems: string[] = [];
  for (const t of manifestTools) {
    const actual = annotationsByName[t.name]?.readOnlyHint;
    if (actual !== t.readOnly) {
      problems.push(
        `ToolDoc '${t.name}' declares readOnly: ${t.readOnly} but the registered tool's readOnlyHint is ${String(actual)}`,
      );
    }
  }
  return problems;
}

/**
 * Run a (possibly absent, possibly throwing) `config.validate` over
 * `config`, containing a throw as one problem string instead of letting it
 * propagate — the exact discipline `ConfigHost.collect` and the settings
 * tab's own re-derivation of the current problems both need identically, so
 * this is the one place that logic lives rather than two copies drifting.
 * (`ModuleRegistry.registerAll` deliberately does NOT use this: its two-tier
 * message shape — a per-problem `module '<id>' config: <p>` prefix for real
 * findings, a differently-worded `module '<id>' config validate() threw:
 * <msg>` for a throw, no double-wrapping either way — doesn't reduce to one
 * `describeThrow` callback without re-introducing the double-wrap this
 * helper exists to avoid; it keeps its own equivalent try/catch instead.)
 * `describeThrow` defaults to the config-host/settings-tab wording; absent
 * `validate` always yields `[]`, matching every caller's prior behavior.
 */
export function safeValidate(
  validate: ((config: Record<string, unknown>) => string[]) | undefined,
  config: Record<string, unknown>,
  describeThrow: (message: string) => string = (m) => `config validate() threw: ${m}`,
): string[] {
  if (!validate) return [];
  try {
    return validate(config);
  } catch (e) {
    return [describeThrow(e instanceof Error ? e.message : String(e))];
  }
}
