// modules-mount.ts — the module host's mount: the built-in capability modules
// assembled as VaultModules and registered THROUGH the ModuleRegistry (ruled
// decision #2 realized — they are settings-toggleable units behind the host's
// tripwire/collision checks, no longer direct registerXTools calls in
// server.ts).
//
// Pure and headless-testable: no `obsidian` imports — the vault-facing
// dependencies arrive injected via MountDeps, exactly as tools-scheme already
// takes them; server.ts contributes only the live adapters and the patched
// registerTool. MountDeps is down to two fields — the settings thunk and the
// scheme module's note listing — because the nine modules that needed their
// own adapters all left for their own plugins.
//
// ── The hard security gate this file answers (recorded by the orchestrator
//    on the module-host merge; verified by test where testable) ─────────────
//
//  1. HANDLER reachability: every tool a module contributes is
//     `readOnlyHint: true` UNLESS the module itself declares `mutating: true`
//     — a read-only registration cannot reach the write queue, the write
//     primitive, or the accept-guard's territory at all (the guard routes
//     ONLY `readOnlyHint === false` calls to the kernel's mutation path).
//     `mutating: true` is a real, deliberate escape hatch, not a bypass of
//     this gate — a module that does NOT declare it still gets the original
//     all-read-only enforcement. NO module declares it today: provenance,
//     fileclass and jd-scaffold were the three that did, and all three left
//     as satellite plugins at the suite split's mutating tier. The flag, this
//     gate's branch and their tests are kept rather than deleted — a
//     documented module-host capability with three shipped users behind it,
//     not perimeter surface that was never used — so a module needing it
//     again declares it exactly as they did. Pinned by test: the mount's
//     registerAll gate refuses a non-mutating module's tool whose
//     annotations are not read-only (see `mountModules`), so a future module
//     slipping a mutating handler in without the declaration fails loudly (a
//     `problems` entry, surfaced by server.ts) rather than registering
//     quietly.
//  2. The host ctx handed to modules is MINIMAL: `getSettings` + `visible`
//     and nothing else — no kernel, no raw server, no registerTool, no
//     baseline/accept surface. Pinned by test over `mountHost`'s keys.
//  3. Modules register ONLY through the registry: server.ts no longer calls
//     registerSchemeTools directly (pinned by a source scan in the test
//     suite), so the tripwire and collision checks cannot be bypassed for
//     module tools. (The same scan used to name registerVocabTools; the vocab
//     module left for the `vaultmcp-vocab` satellite at S7.)
//  4. Capability modules only — nothing here declares (or could smuggle) a
//     governance posture; the registry refuses that posture at construction
//     anyway.

import type { GuardSettings } from "../guard.js";
import { visiblePaths } from "../guard.js";
import {
  ModuleRegistry,
  moduleFromRegistrar,
  type ConfigBinding,
  type ConfigField,
  type ModuleHostCtx,
  type ModuleManifest,
  type ModuleSettings,
  type ToolRegistrar,
  type VaultModule,
} from "../kernel/modules/index.js";
import { makeRegistry, DEFAULT_SCHEMES, JD_SCHEME_INSTANCE, validateExcludedRoots, excludeRoots, type SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import { validateJdConfig, type JdConfig } from "../kernel/scheme/jd.js";
import { registerSchemeTools } from "./tools-scheme.js";

// ── manifests (#81: config-host — see
//    docs/superpowers/specs/2026-08-10-config-host-design.md) ──────────────
//
// The scheme module's config PREDATES the module host (it lives at
// `settings.schemes[0].config` / `.excludedRoots`, not
// `settings.modules.scheme.config`) — `schemeBinding` below resolves the
// manifest's flat field keys against that existing shape, per design §3
// ("no data migration in v1"). The vocab module USED to get a manifest with
// no `config` block and a bespoke `renderVocabInstances` form writing to
// `settings.vocabularies`, read per-connection through a `getVocabularies`
// thunk — all three left with the vaultmcp-vocab satellite at S7 (the form and
// the thunk are gone; the setting survives host-side as the satellite's
// migration-only adoption source and is read by nothing here). This
// paragraph keeps the shape as history because the "structured-instance
// list a scalar manifest-field renderer cannot express" problem will recur
// for any future module with list-shaped config.

const SCHEME_CONFIG_FIELDS: ConfigField[] = [
  {
    key: "expandedAreas",
    label: "Expanded areas",
    help:
      'Comma-separated area bands (e.g. "50-59") that use 5-digit sequential ids instead of category/decimal ids. ' +
      "Leave blank to use the provider default (none).",
    type: "csv",
  },
  {
    key: "expandedCategories",
    label: "Expanded categories",
    help:
      'Comma-separated categories (e.g. "34") that use 5-digit flat ids instead of category.decimal ids. Leave ' +
      "blank to use the provider default (none).",
    type: "csv",
  },
  {
    key: "contentDecimalFloor",
    label: "Content-decimal floor",
    help:
      "Lowest two-digit decimal (0-99) a category allocates as content — decimals below it are reserved. Leave " +
      "blank for the default (10).",
    type: "number",
  },
  {
    key: "excludedRoots",
    label: "Excluded roots",
    help:
      "Vault-relative folder prefixes (one per line) whose contents this scheme instance never resolves or lists " +
      "addresses for — territory it does not speak for. The excluded notes themselves are unaffected; every other " +
      "tool still reads, writes and finds them normally. Leave blank for no exclusion.",
    type: "lines",
    caveats: [
      "Matching is case-sensitive — macOS's case-insensitive filesystem does not make \"vault archaeology\" match " +
        '"Vault archaeology".',
    ],
  },
];

/** Splits the manifest's flat merged config back into the JD provider's own
 * namespace plus the instance-level `excludedRoots`, and runs each half's
 * real validator — subsuming `validateJdConfig` per the design (§1's
 * "jd's validateJdConfig becomes the scheme manifest's validate"). Fails
 * loud: an `excludedRoots` value that isn't even an array is reported
 * directly rather than handed to `validateExcludedRoots` (which assumes
 * `string[] | undefined`, not arbitrary `unknown`). */
function validateSchemeManifestConfig(config: Record<string, unknown>): string[] {
  const { excludedRoots, ...jdConfig } = config;
  const problems = [...validateJdConfig(jdConfig)];
  if (excludedRoots !== undefined && !Array.isArray(excludedRoots)) {
    problems.push("excludedRoots must be an array of strings");
  } else {
    problems.push(...validateExcludedRoots(excludedRoots as string[] | undefined).problems);
  }
  return problems;
}

const SCHEME_MANIFEST: ModuleManifest = {
  summary:
    "Scope resolution and address allocation over the configured scheme (Johnny Decimal today; none on a fresh install, and with none these tools are not registered): resolve, allocate, " +
    "validate a filename, and check placement; assigning, refiling and renumbering an address are switched off with it. `jd:` addressing in path arguments is kernel-level and stays " +
    "available even when this module is disabled.",
  config: {
    fields: SCHEME_CONFIG_FIELDS,
    validate: validateSchemeManifestConfig,
    // Deliberately no `defaults` here: the fields render BLANK when unset
    // (not pre-filled with the provider default) — the `help` text says
    // what blank means, matching the pre-existing hand-built section's
    // behavior exactly (a UI regression this migration must not introduce).
  },
  directory: {
    tools: [
      {
        name: "obsidian_schemes",
        purpose: "List every configured scheme instance: id, provider, capabilities, effective config, and example addresses.",
        readOnly: true,
        caveats: [
          "A skipped (misconfigured) instance is listed bare — id and `available: false` only, no config or " +
            "problem detail, to avoid leaking why through a side channel.",
        ],
      },
      {
        name: "obsidian_validate_name",
        purpose:
          "Validate a single filename against the scheme grammar: malformed address token, a colon in the name, or " +
          "trailing whitespace.",
        readOnly: true,
        options: [
          { name: "name", what: 'a filename or basename to check, e.g. "06.11 Vault MCP.md"' },
          { name: "scheme", what: "which configured instance's grammar to check against when more than one is configured" },
        ],
        caveats: [
          "Pure grammar check — reads nothing from the vault and needs no allowlist; validates ONE name, not the " +
            "whole vault (whole-vault scheme conformance is the rail's job).",
        ],
      },
      {
        name: "obsidian_resolve_address",
        purpose: "Resolve a scheme address to its note's path, or a note's path to its address.",
        readOnly: true,
        options: [
          { name: "address", what: "a scheme address to resolve, e.g. \"jd:06.11\"" },
          { name: "path", what: "a vault-relative path to resolve to its address (the reverse direction)" },
        ],
        caveats: [
          'An instance with `excludedRoots` reports `reason: "excluded"` for a path under one of them, rather ' +
            "than the address it would otherwise carry.",
        ],
      },
      {
        name: "obsidian_next_address",
        purpose: "Compute (never reserve) the next free address within a scope.",
        readOnly: true,
        options: [
          { name: "scope", what: 'a scope token in the scheme\'s grammar, e.g. "06", "50-59", "34"' },
          { name: "scheme", what: "which configured instance to use when more than one is configured" },
        ],
        caveats: [
          "Computes only — pair with obsidian_claim_scope to hold the slot; a competing session can compute the " +
            "identical answer.",
          "`allocatable: false` marks a scope that can never allocate (a plain area, an expanded-item, or a " +
            "category folded into an expanded area's band).",
        ],
      },
      {
        name: "obsidian_list_scope",
        purpose: "List a scope's visible members plus its next free address and up to 20 open slots.",
        readOnly: true,
        options: [
          { name: "scope", what: 'a scope token in the scheme\'s grammar, e.g. "06", "50-59", "34"' },
          { name: "scheme", what: "which configured instance to use when more than one is configured" },
        ],
        caveats: [
          "`members` omits notes outside the allowlist or under an excluded root — a slot listed as free may " +
            "already be held by one of them.",
        ],
      },
      {
        name: "obsidian_expected_location",
        purpose: "Report whether a note (or a not-yet-claimed address) is filed where the scheme expects.",
        readOnly: true,
        options: [
          { name: "path", what: "a vault-relative path to check against its own address" },
          { name: "address", what: 'a scheme address to check directly, e.g. "jd:06.11"' },
          { name: "scheme", what: "which configured instance to use for a bare address" },
        ],
        caveats: [
          "`expected_folder` is null when nothing in the vault establishes the container yet — `placed` is then " +
            "also null.",
        ],
      },
    ],
    addressForms: [
      {
        name: "jd:<address>",
        purpose: "Address a note by its scheme address anywhere a path argument is accepted, e.g. `jd:06.11`.",
        caveats: ["Kernel-level like `uid:` — stays available even if this module itself is disabled."],
      },
    ],
  },
};

/** The live `schemes` list the binding operates on (`schemes[0]` is the
 * instance its fields edit). Missing OR explicitly empty — a fresh install
 * since 01.33 pick A step (b) — reads as one plain `JD_SCHEME_INSTANCE`, so
 * the ALWAYS-RENDERED scheme section's fields are never a silent no-op:
 * `read` shows them blank, and the first field a user fills in `write`s that
 * instance into `schemes`, which turns Johnny Decimal on (the old hand-built
 * section simply hid itself when `jdInstance` was falsy; the generic renderer
 * has no such per-instance visibility). */
function currentSchemes(settings: unknown): SchemeInstanceConfig[] {
  const s = (settings as { schemes?: SchemeInstanceConfig[] }).schemes;
  return s && s.length > 0 ? s : [{ ...JD_SCHEME_INSTANCE }];
}

/** Whether any scheme is configured. None (a fresh install) ⇒ the scheme
 * module contributes no tool, and the three scheme write tools are not
 * registered either. */
export function schemesConfigured(settings: { schemes?: SchemeInstanceConfig[] }): boolean {
  return Array.isArray(settings.schemes) && settings.schemes.length > 0;
}

/** Resolves the scheme manifest's flat field keys against the EXISTING
 * settings shape (`settings.schemes[0].config` / `.excludedRoots`) — no new
 * storage, no migration. Non-mutating: `write` always returns a fresh
 * settings object, never touching the one it was handed (the discipline
 * connection-ui's pre-existing `updateJdConfig`/`updateExcludedRoots`
 * already followed for this exact data).
 *
 * Guarded on `provider === "johnny-decimal"`, mirroring the pre-existing
 * hand-built section's own `jdInstance.provider === "johnny-decimal"` check
 * (deleted from connection-ui.ts, re-homed here): today `SchemeInstanceConfig.provider`
 * is a single-value literal type, so a mismatch is unreachable via anything
 * TypeScript lets you construct — but a hand-edited data.json could still
 * carry a foreign provider name, and this manifest's fields are JD-shaped.
 * `read()` reports blank (nothing to show) and `write()` REFUSES (no-op,
 * settings returned unchanged) rather than splicing JD keys into a config
 * namespace a different provider owns — protecting the other provider's
 * config is worth more here than loud-refusal UI plumbing for a case no
 * shipped config can reach; the alternative (silently "fixing" it into a JD
 * instance) would be the exact silent-coercion this PR's own constraint
 * forbids.
 */
const schemeBinding: ConfigBinding = {
  read(settings) {
    const jd = currentSchemes(settings)[0];
    if (!jd || jd.provider !== "johnny-decimal") return {};
    return {
      ...(jd.config ?? {}),
      ...(jd.excludedRoots !== undefined ? { excludedRoots: jd.excludedRoots } : {}),
    };
  },
  write(settings, patch) {
    const schemes = currentSchemes(settings);
    const jd = schemes[0];
    if (!jd || jd.provider !== "johnny-decimal") return settings;
    const { excludedRoots, ...configPatch } = patch;
    const nextConfig: Record<string, unknown> = { ...(jd.config ?? {}) };
    for (const [k, v] of Object.entries(configPatch)) {
      if (v === undefined) delete nextConfig[k];
      else nextConfig[k] = v;
    }
    const nextInstance: SchemeInstanceConfig = { ...jd, config: nextConfig as Partial<JdConfig> };
    if ("excludedRoots" in patch) {
      if (excludedRoots === undefined) delete nextInstance.excludedRoots;
      else nextInstance.excludedRoots = excludedRoots as string[];
    }
    return { ...(settings as object), schemes: [nextInstance, ...schemes.slice(1)] };
  },
};

// ── the vocab module manifest USED TO LIVE HERE ─────────────────────────────
//
// Removed at the read-tier satellite extraction (suite split, S7), with the
// health and bases manifests below it, for the same reason the skills manifest
// left at S4, triage's at S5 and cross-session's at S6: controlled-vocabulary
// validation is now a separate plugin (`packages/vocab`, id `vaultmcp-vocab`)
// publishing through the external-tool registry. Its four tools are on the
// wire as `vaultmcp_vocab_vocabularies` / `_resolve_term` / `_validate_terms` /
// `_list_vocabulary` — the plugin id IS the tool namespace, so the `obsidian_`
// spellings are gone.
//
// TWO THINGS DID NOT LEAVE WITH IT, and both are deliberate:
//
//   • THE KERNEL. `src/kernel/vocab/` moved to `@vault-mcp/core`, not into the
//     satellite, because the conformance rail (then the host's, since
//     2026-10-14 the vaultmcp-conformance satellite's) is its second consumer
//     (`packs/vocab.ts` wraps `noteVocabFindings`, `cli.ts` builds a
//     `VocabRegistry` per run). Same shape as the
//     `queryBaseRows` question at S5, same forbidden answer: two copies of a
//     rule core is how one vault gets two vocabularies.
//   • THE SETTING. `settings.vocabularies` is a TOP-LEVEL host setting, not a
//     `modules.vocab.config` row, and since S7 it is MIGRATION-ONLY: the field
//     stays declared as the satellite's one-shot adoption source, and nothing
//     in the host reads it any more. An earlier draft of this comment said
//     conformance keeps it live — WRONG, and worth recording because the error
//     is re-derivable: the rail's three `runConformance` call sites all pass
//     `DEFAULT_VOCABULARIES` unconditionally and always have (drift-source,
//     debt-source, cli). See `packages/vocab/CLAUDE.md`, which records the
//     same correction.
//
// ── the provenance module manifest USED TO LIVE HERE ───────────────────────
//
// Removed at the MUTATING-tier satellite extraction, with the fileclass and
// jd-scaffold manifests below it. Derived-content provenance is now
// `packages/provenance` (id `vaultmcp-provenance`), publishing
// `vaultmcp_provenance_check` / `_reconcile` / `_regen` — the plugin id IS the
// tool namespace, and the bare names shed the `provenance_` prefix so nothing
// published as `vaultmcp_provenance_provenance_check`. Its three config fields
// (`notesDir`, `notesSource`, `auditNote`) moved to that plugin's own settings
// tab and are adopted once out of `modules.provenance.config`.
//
// One argument changed with them, and it is a scoping decision rather than a
// spelling one: `check`'s `path` became `note_path` at the extraction and is
// now spelled `note` (round 2, 2026-09-07). `path` is a key this guard
// recognizes, so keeping it would have let a session under a path allowlist run
// the check scoped to the note it names — while the answer still listed every
// path that note's `derived-from` globs resolve to. `note_path` is a key too
// SINCE ROUND 1 (see guard.ts), which briefly re-opened exactly that; round 2
// settled the rule — kernel visibility is a MUTATING concern, so a read that
// can name out-of-allowlist paths goes pathless while a mutating tool that
// names a note keeps `note_path`. `check` is a read, so it is `note`, and no
// tool in that plugin carries a recognized path key: F3 blocks all three
// outright under an allowlist. Fail-closed.
//
// ── the health module manifest USED TO LIVE HERE ────────────────────────────
//
// Removed at the read-tier satellite extraction (suite split, S7). The vault
// health scan is now `packages/health` (id `vaultmcp-health`), publishing
// `vaultmcp_health_scan` and `vaultmcp_health_lint`. Its one config field
// (`emptyChars`) moved to that plugin's own settings tab and is adopted once
// out of `modules.health.config`.
//
// Worth recording because it closes an open issue: #381 asked whether the
// whole-vault read exception had grown by precedent rather than by decision,
// and named `obsidian_health` as one of three tools scanning the entire vault
// with no allowlist filtering. For these two the question is now moot — as
// untrusted external tools carrying no recognized path-key argument they are
// blocked WHOLESALE while a path allowlist is active, which is stricter than
// the documented-exception outcome the issue was weighing. The issue's list is
// down to `provenance_reconcile` and `obsidian_conformance_debt`, both still
// here. (Both have since left: `provenance_reconcile` with the mutating tier,
// `obsidian_conformance_debt` with the conformance rail — see below.)
//
// ── the conformance-debt config USED TO LIVE HERE (in settings, not a manifest)
//
// `conformance-debt` was never a mounted module: `obsidian_conformance_debt`
// and `obsidian_conformance_debt_render` were registered by hand in server.ts,
// but they read their config from `modules["conformance-debt"].config`
// (`staleAfterDays`, `debtBudget`, `strictBudget`, `registerDir`,
// `registerMaxRows`), which no manifest declared and no settings field showed.
// On 2026-10-14 the whole conformance rail left the host as `packages/conformance`
// (id `vaultmcp-conformance`), publishing `vaultmcp_conformance_debt` and
// `vaultmcp_conformance_debt_render`; it adopts that config row once, and the
// host's `vaultConventions` with it. The id is in EXTRACTED_MODULE_IDS so the
// preserved row is skipped silently. Under an allowlist both tools are now
// refused outright by the host (no path-key argument), which takes the last
// tool off #381's list.
//
// ── the fileclass module manifest USED TO LIVE HERE ────────────────────────
//
// Removed at the MUTATING-tier satellite extraction. The fileclass CLI proxy is
// now `packages/fileclass` (id `vaultmcp-fileclass`), publishing
// `vaultmcp_fileclass_list` / `_schema` / `_explain` / `_query` / `_get` /
// `_validate` / `_set` / `_set_where` — the bare names shed the `fileclass_`
// prefix so nothing published as `vaultmcp_fileclass_fileclass_list`. Its one
// config field (`binaryPath`) moved to that plugin's own settings tab and is
// adopted once out of `modules.fileclass.config`.
//
// The DOUBLE GATE went with it and still holds: nothing is published unless the
// Fileclass plugin is loaded AND the CLI binary resolves. Only its grain
// changed — publish time rather than per connection build.
//
// Its whole-surface allowlist refusal is the reason the mutating tier renamed
// its note arguments away from `path`. The module refused every one of its
// eight tools while an allowlist was active, because the CLI runs its engine
// over the whole vault and its output cannot be attributed to paths; a
// satellite cannot make that check, so the host's F3 gate had to do it instead.
// After round 2 (2026-09-07) that reproduction is SEVEN of the eight: the two
// reads that name a note spell it `note` and are refused with the five pathless
// ones, while `set` spells it `note_path` — a key — so the host scopes that one
// write per-path and the kernel's record guard sees the note it rewrites. The
// asymmetry is deliberate: a read gains nothing from kernel visibility, a write
// does.
//
// NOT related, and easy to confuse: `obsidian_fileclass_schema` /
// `obsidian_fileclass_insert_fields` in tools-integrations.ts are for the
// metadata-menu plugin. They stay here and were untouched by the extraction.
//
// ── THE ACCEPTANCE MODULE MANIFEST USED TO LIVE HERE ─────────────────────────
//
// Removed at the host/provider split (S3c). The acceptance capability was never
// an MCP surface — its registrar was a NO-OP on the transport, and its whole job
// was to carry an `enabled` flag and a `config` block for a review pane that
// `main.ts` wired somewhere else entirely. Both halves of that are the
// governance PROVIDER's now: the flag, the five config fields (the two badge
// toggles, `acceptedBy`, `gateMode`, `requiredFrontmatterKeys`) and the
// gesture-gated allowlist controls the module rendered itself all live in
// `packages/governor`, in the provider's own `data.json` and its own settings
// tab.
//
// A `modules.acceptance` row surviving in the HOST's `data.json` is therefore an
// UNKNOWN MODULE ID, reported by the skip-and-report below and never mounted.
// That is deliberate and harmless: the row is the provider's adoption source and
// the host must not silently claim it.
//
// ── the bases module manifest USED TO LIVE HERE ─────────────────────────────
//
// Removed at the read-tier satellite extraction (suite split, S7). Evaluated
// Base rows are now `packages/bases` (id `vaultmcp-bases`), publishing
// `vaultmcp_bases_list` and `vaultmcp_bases_query`.
//
// THE CAPTURE SEAM WENT WITH IT, and that is the decision worth carrying. At
// S5 the triage module's base-backed queues were cut loose rather than take
// `queryBaseRows` along, because the capture drives a hidden Bases leaf — a
// GLOBAL resource held to one capture at a time by a module-scoped serializer
// — and a second serializer in a second plugin would race the first over the
// one leaf. That argument does not block THIS extraction: bases OWNS the leaf
// and the serializer, and `base_query`'s own handler was the only production
// caller left once triage was gone. So the whole set moved and NOTHING was
// copied — the mirror-image risk (a host copy racing the satellite's) is
// exactly why it had to be a move.
//
// ── the jd-scaffold module manifest USED TO LIVE HERE ──────────────────────
//
// Removed at the MUTATING-tier satellite extraction. Johnny Decimal scaffolding
// is now `packages/jd-scaffold` (id `vaultmcp-jd-scaffold`), publishing
// `vaultmcp_jd_scaffold_standard_zeros` / `_ensure_category_indexes` /
// `_promote_to_folder` / `_reindex_category` / `_new_standard_zero` /
// `_new_generic_id` / `_new_stem`.
//
// Its seven names are the one rename in the whole split that was FORCED rather
// than chosen: `external-tools.ts` refuses a published tool name beginning
// `obsidian_`, so no plugin id could have reproduced the `obsidian_jd_*`
// spellings. It declared NO config block, so unlike provenance and fileclass
// that plugin has nothing to adopt, and says so rather than shipping an empty
// migration.
//
// Two of its tools named a `path` argument; both are now `note_path`, which
// THIS host recognizes as a path key since round 1 (2026-09-07). So under an
// allowlist those two are scoped per-path and the kernel's record guard, lock
// consult and journal target all see the note they rewrite; the other five name
// no note and F3 refuses them wholesale. Two residuals are documented rather
// than glossed, both in `packages/jd-scaffold`: promote-to-folder writes to
// destinations the plan COMPUTES and no argument names (the obsidian_repoint_link
// boundary — reported back as `filesChanged`/`files` so the journal's `effects`
// names them), and reindex READS every sibling index file vault-wide at the area
// and system tiers, which the argument-derived guard cannot scope. The module
// bounded both itself with `visiblePaths`; a satellite cannot, and the reindex
// case was ratified as an accepted residual rather than closed.
//

/** What the mount needs from the live plugin (server.ts supplies the Obsidian
 * adapters; tests supply fakes). The same per-call freshness discipline as
 * the direct registrations it replaces: config the HANDLERS read (allowlist,
 * scheme rows) is a thunk, so those edits land live — but
 * `modules.<id>.enabled` is read once per mount, i.e. per connection, so a
 * module toggle takes effect on the next session connect (exactly what the
 * settings tab says). */
export interface MountDeps {
  getSettings: () => GuardSettings & {
    schemes?: SchemeInstanceConfig[];
    modules?: ModuleSettings;
  };
  /** Vault markdown paths, for the scheme module's placement/membership answers. */
  schemeNotes: () => string[];
}

/** The ModuleHostCtx modules receive — deliberately minimal (gate point 2).
 * Exported so the test suite can pin its exact key set: a key added here is a
 * key handed to every module, and must survive the same review this shape
 * did. */
export function mountHost(deps: MountDeps): ModuleHostCtx {
  return {
    getSettings: deps.getSettings,
    visible: (paths: string[]) => visiblePaths(paths, deps.getSettings()),
  };
}

/** The built-in capability modules, adapted without touching their tool
 * layers (module-host adapters doc): scope-provider in its exact
 * `register(server, ctx)` shape.
 *
 * Scheme's `ctxOf` closure deliberately ignores the `host`/`config`
 * parameters and builds from `deps` instead: it PRE-DATES the host, so its
 * config rows live in the top-level `schemes` setting (not
 * `modules.<id>.config`) and its tool layer filters via its own `getSettings`
 * + guard imports (not `host.visible`) — preserved verbatim so the mount is a
 * pure re-wiring, zero behavior change. Vocab was the other module in that
 * pair, on the top-level `vocabularies` setting, until it left for the
 * `vaultmcp-vocab` satellite at S7. A NEW module should do the opposite: read
 * `host`/`config` and use `host.visible`, per the adapters doc. */
/** The scheme module's default `enabled` (the settings tab's toggle overrides it). */
const SCHEME_ENABLED_BY_DEFAULT = true;

/**
 * Whether the scheme module is on: `modules.scheme.enabled`, else the
 * module's default. Read once per connection, as the mount reads it, so a
 * toggle lands on the next connect. The three scheme WRITE tools
 * (`obsidian_assign_address`, `obsidian_refile_address`,
 * `obsidian_renumber_address`) are registered by hand in server.ts, not
 * through this mount, and server.ts gates them on this same answer, so the
 * toggle turns off all of the module's tools (01.28 rule 7; Nelson's pick A,
 * 2026-10-09). `jd:` addressing is kernel-level and stays on either way.
 * With no scheme configured (a fresh install, 01.33 pick A step b) the
 * answer is false whatever the toggle says: there is nothing to address.
 */
export function schemeModuleEnabled(settings: { modules?: ModuleSettings; schemes?: SchemeInstanceConfig[] }): boolean {
  return schemesConfigured(settings) && (settings.modules?.scheme?.enabled ?? SCHEME_ENABLED_BY_DEFAULT);
}

export function builtinModules(deps: MountDeps): VaultModule[] {
  return [
    moduleFromRegistrar(
      { id: "scheme", capabilities: ["addressing", "allocation"], enabled: SCHEME_ENABLED_BY_DEFAULT, manifest: SCHEME_MANIFEST, configBinding: schemeBinding },
      // No scheme configured ⇒ no scheme tool (01.33 pick A, step b). Read once per mount, i.e. per connection, like the toggle.
      (server, ctx) => {
        if (schemesConfigured(deps.getSettings())) registerSchemeTools(server, ctx);
      },
      () => ({
        registry: () => makeRegistry(deps.getSettings().schemes ?? DEFAULT_SCHEMES),
        notes: deps.schemeNotes,
        getSettings: deps.getSettings,
      }),
    ),
    // THE VOCAB MODULE IS GONE FROM HERE (suite split, S7). Its four read
    // tools ship as `packages/vocab` (plugin id `vaultmcp-vocab`), published
    // through vault-mcp-api as `vaultmcp_vocab_*`. Its kernel did NOT go with it
    // — it went to `@vault-mcp/core`, because the conformance rail (now the
    // `vaultmcp-conformance` satellite) is its second consumer; the setting `settings.vocabularies` stays declared
    // host-side as the satellite's MIGRATION-ONLY adoption source, read by
    // nothing in the host (conformance builds from DEFAULT_VOCABULARIES and
    // always did). See the note where the manifest used to be.
    //
    // THE SKILLS MODULE IS GONE FROM HERE (suite split, S4). It was the FIRST
    // mutating capability module and it is the precedent several comments below
    // still cite; it now ships as its own plugin, `packages/skills` (plugin id
    // `vaultmcp-skills`), publishing the same six `vaultmcp_skills_*` tools through
    // vault-mcp-api like any third-party publisher. Its config left with it —
    // a stale `modules.skills` row in an existing data.json is simply an
    // unknown module id now, and the satellite adopts a copy of
    // `modules.skills.config` once, on its own first load, without writing
    // anything here.
    //
    // THE PROVENANCE MODULE IS GONE FROM HERE (mutating tier). Derived-content
    // freshness ships as `packages/provenance` (plugin id `vaultmcp-provenance`),
    // publishing `vaultmcp_provenance_check` / `_reconcile` / `_regen`. It took
    // its whole kernel (`src/kernel/provenance/`) with it — nothing else in
    // this plugin imported it — and its config left with it, so a stale
    // `modules.provenance` row in an existing data.json is simply an unknown
    // module id now.
    //
    // THE HEALTH MODULE IS GONE FROM HERE (suite split, S7). The tiered vault
    // health scan ships as `packages/health` (plugin id `vaultmcp-health`),
    // publishing `vaultmcp_health_scan` and `vaultmcp_health_lint`. It took its
    // whole kernel (`src/kernel/health/`) with it — nothing else in this
    // plugin imported it.
    //
    // THE FILECLASS MODULE IS GONE FROM HERE (mutating tier). The fileclass
    // CLI proxy ships as `packages/fileclass` (plugin id `vaultmcp-fileclass`),
    // publishing eight `vaultmcp_fileclass_*` tools. It had no kernel to take —
    // the engine is the CLI's — and its `binaryPath` config left with it. Its
    // double gate (Fileclass plugin loaded AND CLI binary found) went too, and
    // is now evaluated at publish time rather than per connection build.
    //
    // THE ACCEPTANCE MODULE IS GONE FROM HERE (host/provider split, S3c). The
    // human-only review pane ships as `packages/governor` (plugin id
    // `governor`), which owns its own enabled flag, its own config block and
    // its own settings tab. It contributed ZERO MCP tools while it lived here,
    // so nothing on the transport changed when it left — what changed is that
    // the host no longer holds a settings row for a pane it cannot mount.
    //
    // THE BASES MODULE IS GONE FROM HERE (suite split, S7). Evaluated Base
    // rows ship as `packages/bases` (plugin id `vaultmcp-bases`), publishing
    // `vaultmcp_bases_list` and `vaultmcp_bases_query`. The hidden-leaf capture
    // seam and its module-scoped serializer moved WITH it, as one piece and
    // with no copy left behind — see the note where the manifest used to be.
    //
    // THE JD-SCAFFOLD MODULE IS GONE FROM HERE (mutating tier). Johnny Decimal
    // scaffolding ships as `packages/jd-scaffold` (plugin id
    // `vaultmcp-jd-scaffold`), publishing seven `vaultmcp_jd_scaffold_*` tools. It
    // took its whole kernel (`src/kernel/jd-scaffold/`) and its Obsidian
    // adapter with it, and it declared no config at all, so there is not even a
    // stale settings row to leave behind.
  ];
}

/**
 * Mount the built-in modules through a fresh ModuleRegistry and register the
 * enabled ones' tools via `registerTool` — which, from server.ts, is the
 * PATCHED `server.registerTool`, so every module tool lands at the same
 * guard/queue/journal interception point as every hand-registered tool
 * (kernel args declared, allowlist enforced, Code Mode captured alike).
 *
 * The registrar handed to the registry additionally REFUSES any module tool
 * whose annotations are not explicitly read-only (gate point 1): the two v1
 * modules are read-only by design, and a module that stops being so must
 * fail this mount loudly and re-earn it through review, not drift in.
 * Refusals land in `problems` (and the tool is not registered) — the
 * registry's own skip-and-report discipline.
 *
 * Returns the registry so the caller (settings UI, diagnostics) can read
 * `describe()` and `problems`.
 */
export function mountModules(registerTool: ToolRegistrar, deps: MountDeps): ModuleRegistry {
  const modules = builtinModules(deps);
  const registry = new ModuleRegistry(modules, deps.getSettings().modules ?? {});
  // The modules that have EARNED the right to contribute mutating tools, by
  // declaring `mutating` — see VaultModule.mutating. This set is EMPTY today:
  // provenance, fileclass and jd-scaffold were the last three to declare it and
  // all three left for their own plugins at the mutating tier of the suite
  // split (skills, triage and cross-session set the precedent before them). So
  // the gate below currently reduces to its original rule — every module tool
  // must be read-only. The machinery stays anyway: it is a documented
  // module-host capability with six shipped users behind it, not perimeter
  // surface that was never used, and a module needing it again declares it the
  // same way they did.
  const mutatingModules = new Set(modules.filter((m) => m.mutating).map((m) => m.id));
  registry.registerAll(registerTool, mountHost(deps), {
    // The read-only-only rule rides registerAll's gate so a refused tool is
    // never recorded as contributed and never reserves its name — describe()
    // stays truthful and a later, legitimate same-name registration is not
    // blackholed by a refusal. A module that declares `mutating` is exempt (its
    // write tools still go through the guard-patched registrar and, for a
    // frontmatter write, the accept-forbidden guard).
    gate: (name, def, moduleId) =>
      def?.annotations?.readOnlyHint === true || mutatingModules.has(moduleId)
        ? null
        : `not explicitly read-only — a read-only capability module (readOnlyHint: true) may not contribute a ` +
          `mutating tool; a module needs to declare \`mutating\` (accept-reachability review) to do so`,
  });
  return registry;
}
