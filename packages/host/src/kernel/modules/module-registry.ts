// module-registry.ts — ModuleRegistry: the host. Instantiates the ENABLED
// capability modules from plugin settings and exposes their tools to a served
// connection through the (guard-patched) registrar it is handed.
//
// Discipline mirrors the vocab registry's: settings and module lists are
// user-shaped inputs, so every defect — duplicate id, unknown id in settings,
// governance posture, tool-name collision, forbidden tool name, a throwing
// register() — is SKIPPED AND REPORTED via `problems` — with one carve-out: a settings row naming an EXTRACTED module id (see EXTRACTED_MODULE_IDS below) is skipped SILENTLY, because those rows are the satellites' preserved adoption sources, not defects, never thrown. One bad
// module must not take the tool surface down, and a bad tool must not take
// its module down.
//
// Two refusals here are load-bearing policy, not hygiene:
//
//   1. Governance modules are refused at construction. The consolidation
//      ruling gates folding Stewardship in on a FRESH accept-reachability
//      review of the merged topology; until that review exists, the v1 host
//      simply cannot instantiate a governance module. (The posture is in the
//      type so the contract already models the asymmetry.)
//
//   2. The accept tripwire: "no module may contribute a baseline-advancing
//      callable to the shared surface" (the one hard rule of the merge). The
//      enforceable, testable form is a name check at registration — a tool
//      whose name mentions accept/approve/baseline is refused and reported.
//      This is a TRIPWIRE, not the security boundary: the boundary is that no
//      accept-capable code is reachable from any module the v1 registry will
//      instantiate. The tripwire exists so a future module that tries grows a
//      loud, greppable, test-pinned failure instead of a quiet registration.
//
// Kernel-module rules: pure TypeScript, no "obsidian" or SDK imports,
// headless-testable end to end.

import type {
  ModuleHostCtx,
  ModuleSettingsSchema,
  ToolDef,
  ToolHandler,
  ToolRegistrar,
  VaultModule,
} from "./module.js";
import { mergeModuleConfig, type ModuleSettings } from "./settings.js";

/** Tool names no module may register, whatever its posture: anything that
 * reads as advancing a baseline or minting acceptance. Case-insensitive
 * substring match on the registered name. */
const FORBIDDEN_NAME_FRAGMENTS = ["accept", "approve", "baseline"];

/**
 * The schema this module's `modules.<id>.config` is actually merged/
 * validated against: `manifest.config` when present, else the deprecated
 * `settingsSchema` (config-host design: "registry reads manifest.config
 * first, falls back"). A module carrying BOTH (mid-migration) has its
 * manifest win outright rather than merging the two — one schema in
 * effect, never a silent blend of an old and a new one.
 */
function effectiveSchema(m: VaultModule): ModuleSettingsSchema | undefined {
  if (m.manifest?.config) return { defaults: m.manifest.config.defaults, validate: m.manifest.config.validate };
  return m.settingsSchema;
}

export function forbiddenToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_NAME_FRAGMENTS.some((f) => lower.includes(f));
}

/** One module's registry-eye view, for enumeration and the settings UI. */
export interface ModuleDescription {
  id: string;
  posture: VaultModule["posture"];
  capabilities: string[];
  enabled: boolean;
  /** Tool names the module actually contributed on the last registerAll
   * (empty before one ran, or when disabled). */
  tools: string[];
}

/**
 * Module ids that left the host as satellite plugins (the suite split,
 * S4–S8). A `modules.<id>` row for one of these is the satellite's
 * PRESERVED ADOPTION SOURCE, not a typo — kept forever because satellites
 * never write the host's settings. Grows only when a module is extracted;
 * never remove an entry while any vault might still carry the row.
 */
export const EXTRACTED_MODULE_IDS: ReadonlySet<string> = new Set([
  "skills", "triage", "crosssession", "vocab", "health", "bases",
  "fileclass", "provenance", "jd-scaffold",
  // Never a mounted module: the conformance-debt tools were registered by hand
  // in server.ts, but their config sat at `modules["conformance-debt"].config`.
  // The vaultmcp-conformance satellite adopts it from there (2026-10-14).
  "conformance-debt",
]);

export class ModuleRegistry {
  private readonly constructionProblems: string[] = [];
  /** Defects from the LAST registerAll — reset per call, like `contributed`,
   * so a long-lived registry serving many connections reflects the current
   * state instead of accumulating every reconnect's duplicates. */
  private runProblems: string[] = [];
  private readonly modules: VaultModule[] = [];
  private readonly settings: ModuleSettings;
  /** module id → tool names it contributed on the last registerAll. */
  private contributed = new Map<string, string[]>();

  /** Every defect currently standing — construction findings (permanent for
   * the registry's lifetime) plus the last registerAll's. User-facing. */
  get problems(): string[] {
    return [...this.constructionProblems, ...this.runProblems];
  }


  constructor(modules: VaultModule[], settings: ModuleSettings = {}) {
    this.settings = settings;
    const seen = new Set<string>();
    for (const m of modules) {
      if (seen.has(m.id)) {
        this.constructionProblems.push(`duplicate module id '${m.id}' — first declaration wins`);
        continue;
      }
      // A refused module still RESERVES its id: a later module reusing it is a
      // packaging bug worth its own report, not a fresh registration.
      seen.add(m.id);
      if (m.posture === "governance") {
        this.constructionProblems.push(
          `module '${m.id}' declares posture 'governance' — refused: the v1 host holds capability modules only ` +
            `(governance integration is gated on an accept-reachability review)`,
        );
        continue;
      }
      this.modules.push(m);
    }
    // Settings rows naming a module that does not exist are inert by
    // construction; say so rather than leaving the row silently dead — UNLESS
    // the id names an EXTRACTED module. Those rows are not typos: each
    // satellite's one-shot settings adoption reads its old `modules.<id>`
    // row from this data.json and, by design, never deletes it (the
    // "never write the host" rule every satellite pins). So the rows stay
    // forever, and warning about them — eight times per connection, on the
    // operator's live console, the day after the extraction shipped — is the
    // instrument crying wolf about state the design requires. The typo
    // warning stays for every OTHER unknown id.
    for (const id of Object.keys(settings)) {
      if (modules.some((m) => m.id === id)) continue;
      if (EXTRACTED_MODULE_IDS.has(id)) continue;
      this.constructionProblems.push(`settings name unknown module '${id}' — ignored`);
    }
  }

  /** Effective enabled state: the settings override when present, else the
   * module's default. Unknown ids are not enabled. */
  isEnabled(id: string): boolean {
    const m = this.modules.find((x) => x.id === id);
    if (!m) return false;
    return this.settings[id]?.enabled ?? m.enabled;
  }

  /** The modules registerAll will call, in declaration order. */
  enabledModules(): VaultModule[] {
    return this.modules.filter((m) => this.isEnabled(m.id));
  }

  /** The module's schema defaults merged under the user's config. */
  configFor(id: string): Record<string, unknown> {
    const m = this.modules.find((x) => x.id === id);
    return mergeModuleConfig(m && effectiveSchema(m)?.defaults, this.settings[id]?.config);
  }

  /**
   * Contribute every enabled module's tools through `reg` — per built server,
   * exactly like the hand-registered `registerXTools` calls, so per-connection
   * snapshots and conditional registration keep working unchanged.
   *
   * The registrar each module sees is WRAPPED: the host records what the
   * module contributed (for describe()), refuses cross-module name collisions
   * (first registration wins — two modules disagreeing about one name is a
   * packaging bug, not a runtime race), and refuses forbidden names (the
   * accept tripwire above). A module whose register() throws loses its own
   * remaining tools and nothing else.
   *
   * `opts.gate` lets the CALLER refuse a registration too (the mount's
   * read-only-only rule): return a problem string to refuse, null to accept.
   * The contributing module's id is passed as the third argument so the gate
   * can apply a PER-MODULE policy (the mount permits a mutating tool only from
   * a module that declares `mutating`). It runs BEFORE the registration is
   * recorded, so a gate-refused tool never appears in describe() and never
   * reserves its name — the bookkeeping describes what actually reached the
   * registrar, not what was attempted. (This is why the gate is an option here
   * rather than a wrapper around `reg`: an outer wrapper refusing AFTER the
   * fact would leave describe() claiming a tool that was never registered.)
   */
  registerAll(
    reg: ToolRegistrar,
    host: ModuleHostCtx,
    opts: { gate?: (name: string, def: ToolDef, moduleId: string) => string | null } = {},
  ): void {
    this.contributed = new Map();
    this.runProblems = [];
    const taken = new Set<string>();
    for (const m of this.enabledModules()) {
      const config = this.configFor(m.id);
      // validate() is module-author code over user-edited settings — contained
      // exactly like register() below: a throwing validator is one module's
      // defect, reported, and must not cost the modules after it their tools.
      let configProblems: string[] = [];
      try {
        configProblems = effectiveSchema(m)?.validate?.(config) ?? [];
      } catch (e) {
        this.runProblems.push(
          `module '${m.id}' config validate() threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      for (const p of configProblems) this.runProblems.push(`module '${m.id}' config: ${p}`);
      const names: string[] = [];
      this.contributed.set(m.id, names);
      const scoped: ToolRegistrar = (name: string, def: ToolDef, handler: ToolHandler) => {
        if (forbiddenToolName(name)) {
          this.runProblems.push(
            `module '${m.id}' tried to register '${name}' — refused: accept/baseline-shaped tool names are ` +
              `forbidden on the shared surface`,
          );
          return;
        }
        if (taken.has(name)) {
          this.runProblems.push(`module '${m.id}' tried to register '${name}' — refused: name already registered`);
          return;
        }
        const refusal = opts.gate?.(name, def, m.id) ?? null;
        if (refusal !== null) {
          this.runProblems.push(`module '${m.id}' tried to register '${name}' — refused: ${refusal}`);
          return;
        }
        taken.add(name);
        names.push(name);
        reg(name, def, handler);
      };
      try {
        m.register(scoped, host, config);
      } catch (e) {
        this.runProblems.push(`module '${m.id}' register() threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Every known module (enabled or not), with what it contributed last. */
  describe(): ModuleDescription[] {
    return this.modules.map((m) => ({
      id: m.id,
      posture: m.posture,
      capabilities: [...m.capabilities],
      enabled: this.isEnabled(m.id),
      tools: [...(this.contributed.get(m.id) ?? [])],
    }));
  }
}
