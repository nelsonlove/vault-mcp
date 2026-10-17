import { Plugin, FileSystemAdapter, Modal, Notice, type Component } from "obsidian";
import * as fs from "node:fs";
import { UnixSocketListener } from "./socket-transport.js";
import { buildMcpServer } from "./mcp/server.js";
import type { CapturedRegistry } from "./mcp/tools-code-mode.js";
import { openToolRunner } from "./tool-runner.js";
import { vaultSlug, socketPath, stateDir, bridgeDestPath, configurePaths } from "./paths.js";
import { writeDiscovery, removeDiscovery, writeBridge, type Discovery } from "./discovery.js";
import { ConnectionSetupModal, VaultMcpSettingTab } from "./connection-ui.js";
import { findClaudeBinary, claudeIsRegistered, claudeRegister, claudeRemove, claudeEnsureConnectPlugin } from "./claude-cli.js";
import { ExternalToolRegistry, type VaultMcpApi } from "./mcp/external-tools.js";
import { createGovernanceSeam, type GovernanceSeam } from "./mcp/seam.js";
import { DEFAULT_VOCABULARIES, splitSettings, resolveTerritories, type VocabInstanceSettings } from "@vault-mcp/core";
import { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore, UidIndex, loadInstallId, migrateLegacyModuleIds, monthKey, type ModuleSettings } from "./kernel/index.js";
import { seedFromJournal, type SeedRecord } from "./kernel/idempotency.js";
import { createSessionLog } from "./kernel/sessions/session-log.js";
import { obsidianProbe, obsidianServerIdentity, obsidianUidSource } from "./kernel/obsidian-probe.js";
import { DEFAULT_SCHEMES, type SchemeInstanceConfig } from "./kernel/scheme/registry.js";
import { DEFAULT_PROTECTED_PROPERTIES, setDeclaredProtectedProperties } from "@vault-mcp/core";
// Host-side since S2 (condition 9): the mount decision is generic, and the
// HOST uses it for the scheme panes.
import { mountAction } from "./mount-state.js";
import { wireSchemePanes, registerSchemeCommands } from "./scheme/wiring.js";
import { runHostAdoption, LEGACY_PLUGIN_ID, PLUGIN_ID } from "./id-migration.js";
import { territoriesOnLoad } from "./territory-policy.js";
import { recordFoldersOnLoad } from "./record-folders-policy.js";
import { DEFAULT_SYNC_GUARD, normalizeSyncGuard, type SyncGuardSettings } from "./kernel/sync-guard.js";
import { DEFAULT_HOST_SETTINGS, normalizeHostSettings, declaredHeadless, autoRegisterAllowed, type HostSettings } from "./headless.js";
import { DEFAULT_WRITE_SCOPE, normalizeWriteScope, type WriteScope } from "@vault-mcp/core";
import {
  DEFAULT_RECORD_IDENTIFICATION,
  DEFAULT_RECORD_FOLDERS,
  normalizeRecordIdentification,
  type RecordFolders,
  type RecordIdentification,
} from "./kernel/record-guard.js";

/** How a note declares itself a record — the operator's convention, see
 * `kernel/record-guard.ts` where the decision lives. Re-exported so the type
 * keeps its old address. */
export type { RecordIdentification };

interface VaultMcpSettings {
  setupAcknowledged: boolean;
  readOnly: boolean;
  allowlist: string[];
  enabled: boolean;
  allowDangerousCli: boolean;
  /**
   * Register the raw `obsidian_cli` proxy. DEFAULT OFF: the dedicated
   * pinned-subcommand tools (obsidian_note_history/diff, obsidian_base_create,
   * the snippet tools, obsidian_plugin_install/uninstall) cover the observed
   * real usage with typed args and path scoping, and the proxy's free-text
   * command string is the root of a whole guard-complexity family
   * (#76/#79/#107/#110/#137/#153). When ON, the proxy behaves exactly as
   * before — command policy, danger gate, accept guard, deny sets all intact.
   * Takes effect on the next session connect.
   */
  rawCliProxy: boolean;
  /**
   * Plugin ids whose tools may declare themselves read-only and be believed.
   * Empty by default: an external tool's `readOnlyHint: true` is otherwise
   * treated as mutating (queued, journaled, allowlist-scoped, blocked in
   * read-only mode) — see mcp/external-tools.ts.
   *
   * SINCE THE HOST/PROVIDER SPLIT this list is also how an operator restores
   * read-only-mode availability to the governance provider's three read tools
   * (`governance_pending_review`, `governance_revisions`, `governance_mandates`),
   * by listing `governor` here. It does NOT restore them under a path
   * allowlist: the F3 gate blocks any external tool whose arguments carry no
   * recognized path key, trusted or not, and that is the documented posture
   * every satellite extraction has shipped.
   */
  trustedReadOnlyPlugins: string[];
  /**
   * Declared protected frontmatter properties (#224): `{key, grade}` rows the
   * accept guard enforces on EVERY guarded transport (grade `agent-forbidden`
   * — introduce/change/remove refused, byte-identical carry-forward allowed —
   * or `authority-conferring`, which additionally honors the value only once
   * blessed). Human-only-mutable by construction (settings tab; no MCP path
   * writes plugin config). The accepted family + acceptance-status are a
   * HARDCODED floor underneath — entries naming them are ignored loudly
   * (@vault-mcp/core normalizeProtectedProperties); this list can only EXTEND
   * the perimeter. Synced into the core guard registry on load and save.
   *
   * NOTE the floor is the HOST's, and stays the host's after the split: even a
   * governance-less host refuses an agent stamping `accepted`. The provider
   * adds review on top of that floor; it does not supply it.
   */
  protectedProperties: Array<{ key: string; grade: string }>;
  /**
   * Controlled-vocabulary sources: `{ id, provider, root, config }` rows,
   * mirroring the scheme settings shape.
   *
   * MIGRATION-ONLY SINCE S7. Nothing in this plugin reads it any more — the
   * four vocabulary tools and their settings form left for the `vaultmcp-vocab`
   * satellite at the read-tier extraction, and the conformance rail (now the
   * `vaultmcp-conformance` satellite) builds its registry from `DEFAULT_VOCABULARIES` (it always did; it never
   * read this field). It is deliberately still declared, still defaulted, and
   * still persisted, because it is the ADOPTION SOURCE: `vaultmcp-vocab` copies
   * it once on its first load and never writes back. Deleting it here would
   * destroy a user's configuration before the plugin that inherits it had a
   * chance to read it. Remove it only after the adoption window is closed,
   * which is a separate, dated decision.
   */
  vocabularies: VocabInstanceSettings[];
  /**
   * Scope-provider instances (scheme id + provider name + per-provider
   * config). Defaults to DEFAULT_SCHEMES — the single "jd" instance backed by
   * the Johnny Decimal provider with its own default config. Scheme semantics
   * are configuration, not hardwired (Nelson's ruling): only the default
   * instance's JD config gets a settings-tab UI (comma-separated expanded
   * areas/categories + content-decimal floor); additional instances or
   * exotic overrides stay data.json-editable, no UI (YAGNI) — see
   * kernel/scheme/registry.ts for the deep-merge-over-defaults and
   * skip-and-report-on-invalid-config behavior this list feeds.
   */
  schemes: SchemeInstanceConfig[];
  /**
   * The module host's per-module rows (`{ enabled?, config? }` keyed by
   * module id). An absent row means the module's default; `enabled: false`
   * unmounts that module's whole tool surface on the next connection. See
   * kernel/modules/ and mcp/modules-mount.ts.
   *
   * ONE built-in capability module remains after the host/provider split:
   * `scheme`. The `acceptance` row travelled to the governance provider, which
   * now owns the review pane's enabled flag and its config block in its own
   * `data.json`. A surviving `modules.acceptance` row here is an unknown id —
   * reported by the module host's skip-and-report, never mounted.
   */
  modules: ModuleSettings;
  /**
   * Command policy for the arbitrary-execution surfaces (obsidian_cli +
   * obsidian_run_command): a deny list (always wins) and the per-command
   * re-enable list for the deny-by-default opaque-accept set (quickadd/eval/
   * command; quickadd:* and js-engine:* run_command ids). Human-only by construction — no MCP
   * surface writes plugin settings, and the surfaces that could reach one
   * indirectly are what this policy denies. See mcp/cli-policy.ts.
   */
  cliPolicy: { deny: string[]; allowOpaque: string[]; neverOpaque: string[] };
  /**
   * Enforce record immutability (#264): refuse non-append mutation of a note
   * the record identifier marks (`record: true` by default; see
   * `recordIdentification`). Default ON — the guard exists
   * because a mis-quoted write destroyed a byte-verified record archive. The
   * off switch is here because the check is deliberately over-inclusive (it
   * refuses on ANY named path, including one an operation only reads), so a
   * legitimate workflow it blocks needs a way through that isn't hand-editing
   * frontmatter. Read live per call — no reconnect needed.
   */
  enforceRecordImmutability: boolean;
  /**
   * Capture the exact bytes the host returns from a native read, so a reviewer can replay what an agent was actually shown.
   *
   * DEFAULT OFF, and it stays off until a human turns it on. Capturing note bodies writes vault content to `~/.claude/vault-mcp/observations/<vault>/` — outside the vault, outside Sync — and that is a privacy decision a plugin must not make on somebody's behalf by shipping it enabled.
   *
   * HOST-SIDE by ruling (suite-split condition 9, S3b): capture records what the host's own transport read, which is the same class of fact as the session scope digest the host already asserts about a connection. The provider reasons over observation REFERENCES and never sees the store.
   *
   * Only NATIVE actions are captured. The 123 derived contracts claim nothing about their observations, so turning this on does not suddenly start recording every tool in the product; today it means `obsidian_read_note` alone.
   */
  captureObservations: boolean;
  /**
   * Ceiling on total captured bytes, per vault. A stopgap, and named as one: real retention does not exist yet, so without a cap the store grows forever. Capture stops and says why rather than filling the disk.
   */
  captureMaxBytes: number;
  /**
   * The vault areas no host feature may RETAIN a copy of. EMPTY BY DEFAULT and
   * empty means "guard nothing" — honestly, and visibly: capture refuses to turn
   * on while this is empty. The plugin used to ship a default here that was one
   * operator's four folder names; that was a vault convention baked into a
   * public plugin, and #397 retired it. An install that predates this setting
   * has those four written into its OWN data.json once, on upgrade, so nothing
   * changes for it (`loadSettings`).
   *
   * Owned by the HOST, not Governor: observation capture writes note bodies to
   * `~/.claude/vault-mcp/observations/`, outside the vault and outside Sync, and
   * it runs whether or not Governor is installed. Governor reads this through
   * `guardedTerritories()` on the api and keeps no copy.
   */
  guardedTerritories: string[];
  // `vaultConventions` (#403) was declared here until the conformance rail left
  // for the vaultmcp-conformance satellite (2026-10-14). The host no longer
  // declares, seeds, forwards or reads it, but it never deletes it: an existing
  // data.json keeps the key (loadSettings merges the stored record and
  // saveSettings writes it back), because the satellite adopts it once from
  // there — the same preserved-adoption-source rule as `modules.<id>` rows of
  // extracted modules (EXTRACTED_MODULE_IDS).
  /**
   * How a note declares itself a RECORD — historical, byte-verified, extended
   * only by end-of-file append (see `enforceRecordImmutability`). The same
   * three knobs TaskNotes exposes for its task identifier: a frontmatter
   * PROPERTY (name + value) or a TAG. `record: true` was hardcoded until #397;
   * it is now this setting's default, so an existing install is unchanged.
   * `enabled` (#482) turns this NOTE indicator off as a whole.
   */
  recordIdentification: RecordIdentification;
  /**
   * The FOLDER indicator (#482, Nelson 2026-10-02): a note under one of
   * `folders` (by whole vault path), or under a folder whose NAME matches
   * `archivePattern`, is a record for the moves (never for the write guard).
   * `enabled` turns it off (and with it the archives the bracket rule sees).
   * The plugin ships it EMPTY; an install that predates the key is seeded once
   * with what #455 hard-coded (record-folders-policy.ts).
   */
  recordFolders: RecordFolders;
  /**
   * The Sync guard (kernel/sync-guard.ts; 01.43, Nelson's pick A of
   * 2026-10-12): before a write, wait while this Mac's Obsidian Sync is
   * disconnected or has a server change waiting at the write's paths (#528),
   * and a rename, move or delete also until it says "Fully synced" (#533),
   * then refuse a rename, move, delete or create that is still behind (`mode`), and let an edit or append go on with a warning. Off when
   * the plugin ships; coerced through `normalizeSyncGuard` on load.
   */
  syncGuard: SyncGuardSettings;
  /**
   * The vault-relative path of the vault's construction module `flow.js`, for
   * obsidian_create_note (#531). Empty when the plugin ships (no vault folder
   * name in live code); the tool is registered only when it is set.
   */
  createNoteFlow: string;
  /**
   * What agents may WRITE, separate from what they may read (core's
   * write-scope.ts): `mode` "all" (no rule) or "create-only" (a new note at a
   * path matching one of `paths`, glob patterns; every other write refused).
   * Default "all". No folder name is written into code: the values are the
   * operator's. Coerced through `normalizeWriteScope` on load.
   */
  writeScope: WriteScope;
  /**
   * Running with no Obsidian window (vaultd-host, headless.ts): `headless`
   * ("auto" | "on" | "off"), `stateDir` and `socketPath` (where the socket,
   * bridge.mjs and the discovery file go; empty = `~/.claude/vault-mcp/`), and
   * `autoRegisterClaude` (the load-time `claude mcp` registration). Coerced
   * through `normalizeHostSettings` on load.
   */
  host: HostSettings;
  /**
   * The in-Obsidian dev tool-runner ("Vault MCP: Run tool…" — src/tool-runner.ts).
   * Default ON: it grants nothing the MCP surface doesn't already grant — it
   * invokes the same guarded captured tools a code-mode connection gets, so
   * every rail (read-only mode, allowlist, queue, journal, accept-forbidden)
   * binds identically. The toggle exists so a locked-down vault can remove the
   * in-app surface anyway; it is read live by the command's checkCallback, so
   * flipping it needs no reload.
   */
  devToolRunner: boolean;
}

// The externally-published tool registry and the governance seam, both held in
// module-private WeakMaps (§9, suite-split condition 1): a `private` class field
// is compile-time privacy only, so `app.plugins.plugins['vault-mcp'].externalRegistry`
// handed renderer JS every third-party handler — and would have handed it every
// REGISTERED HOOK once the seam existed. A reachable write observer is a proposal
// factory callable with forged facts, which is strictly more than the `app.vault`
// equivalence covers: writing bytes through `app.vault` produces a loud queue
// entry, while a forged proposal is quiet by design.
//
// Registration stays reachable (through `api` below) and that is harmless —
// registering grants the registrant nothing. What must not be reachable is the
// LIST of what everyone else registered.
const externalRegistries = new WeakMap<Plugin, ExternalToolRegistry>();
const governanceSeams = new WeakMap<Plugin, ReturnType<typeof createGovernanceSeam>>();

function externalRegistryOf(plugin: Plugin): ExternalToolRegistry {
  let registry = externalRegistries.get(plugin);
  if (!registry) externalRegistries.set(plugin, (registry = new ExternalToolRegistry()));
  return registry;
}

function seamOf(plugin: Plugin): ReturnType<typeof createGovernanceSeam> {
  let seam = governanceSeams.get(plugin);
  if (!seam) governanceSeams.set(plugin, (seam = createGovernanceSeam()));
  return seam;
}

const DEFAULT_SETTINGS: VaultMcpSettings = {
  setupAcknowledged: false,
  readOnly: false,
  allowlist: [],
  enabled: true,
  allowDangerousCli: false,
  rawCliProxy: false,
  trustedReadOnlyPlugins: [],
  protectedProperties: DEFAULT_PROTECTED_PROPERTIES.map((p) => ({ ...p })),
  // Cloned so settings edits can never mutate the module-level default rows
  // (item 6: schemes now clones symmetrically with vocabularies — a shallow
  // `.map((s) => ({...s}))` would miss a nested `config` object were one ever
  // added to DEFAULT_SCHEMES's entries, so this uses structuredClone for a
  // real deep copy rather than assuming the shape stays flat).
  vocabularies: DEFAULT_VOCABULARIES.map((v) => ({ ...v })),
  schemes: structuredClone(DEFAULT_SCHEMES),
  modules: {},
  cliPolicy: { deny: [], allowOpaque: [], neverOpaque: [] },
  enforceRecordImmutability: true,
  devToolRunner: true,
  captureObservations: false,
  captureMaxBytes: 50 * 1024 * 1024,
  guardedTerritories: [],
  recordIdentification: { ...DEFAULT_RECORD_IDENTIFICATION },
  recordFolders: { ...DEFAULT_RECORD_FOLDERS, folders: [...DEFAULT_RECORD_FOLDERS.folders] },
  syncGuard: { ...DEFAULT_SYNC_GUARD },
  createNoteFlow: "",
  writeScope: { ...DEFAULT_WRITE_SCOPE, paths: [] },
  host: { ...DEFAULT_HOST_SETTINGS },
};

class DiagnosticsModal extends Modal {
  constructor(app: any, private readonly lines: string[]) { super(app); }
  onOpen() {
    this.titleEl.setText("Vault MCP diagnostics");
    for (const l of this.lines) this.contentEl.createEl("p", { text: l });
  }
  onClose() { this.contentEl.empty(); }
}

export default class VaultMcpPlugin extends Plugin {
  private listener: UnixSocketListener | null = null;
  private slug = "";
  declare settings: VaultMcpSettings;
  /**
   * Settings the host ADOPTED from the pre-split plugin's `data.json` but has
   * not yet persisted. Held between `loadSettings` and the first save so the
   * adoption is not lost if nothing ever calls `saveSettings`.
   */
  private adoptedSettings: Record<string, unknown> | null = null;
  // Live-mount handle for the scheme Inbox pane (jd-dashboard fold Stage B,
  // governor#286): one shared Component for the scheme panes, gated by the
  // "scheme" module toggle. (The Drift pane, Stage C, left with the conformance
  // rail for the vaultmcp-conformance satellite on 2026-10-14.) `schemePanesReconcile` serializes mount/unmount so a rapid
  // enable→disable can't interleave a half-finished mount with a teardown.
  private schemePanesComponent: Component | null = null;
  private schemePanesReconcile: Promise<void> = Promise.resolve();
  // Public plugin-to-plugin API: app.plugins.plugins['vault-mcp'].api.
  //
  // apiVersion is 3 since #550: the v1 surface (registerTools plus the
  // additive governance seam and guardedTerritories), the partial-result
  // envelope and the per-call CallContext (2, #402 step B), and the write
  // declarations a spec may carry (`protection`, `sync`, `paths`), which the
  // host enforces exactly as a host tool's inventory row. The SDK reads the number as a FLOOR
  // since 1.1.0 (step A), so a satellite rebuilt against that SDK keeps
  // registering; a satellite still bundling an older SDK refuses to register,
  // loudly, in the console — the one ordering constraint the design names.
  // What the object LOST at S2 is `unregisterTools(ownerPluginId)` — an
  // id-addressed revocation anyone holding this object could aim at anyone
  // else's tools; the disposer `registerTools` returns is now the only way to
  // revoke, and it can only revoke what its holder registered.
  api: VaultMcpApi & GovernanceSeam = {
    apiVersion: 3,
    registerTools: (owner, tools) => externalRegistryOf(this).registerTools(owner, tools),
    registerWriteObserver: (id, observe) => seamOf(this).seam.registerWriteObserver(id, observe),
    registerSessionRefusal: (id, refuse) => seamOf(this).seam.registerSessionRefusal(id, refuse),
    // Resolved on every call, never captured: an operator edit reaches the
    // provider without either plugin reloading. A copy is returned so a caller
    // cannot mutate the host's own array through the reference.
    guardedTerritories: () => [...resolveTerritories(this.settings.guardedTerritories)],
  };

  async loadSettings() {
    const own = (await this.loadData()) as Record<string, unknown> | null;
    // The one-shot adoption from the pre-split plugin's folder (see onload):
    // used ONLY when this plugin has no data.json of its own, so a host that
    // has ever saved settings never re-reads the provider's copy.
    const seed = own ? null : this.adoptedSettings;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, seed ?? {}, own ?? {});
    // #397 — guarded territories. There is no shipped default any more, so an
    // install that predates the setting must be seeded ONCE with what the old
    // default guarded for it, or upgrading would silently unguard its legal
    // material. The discriminator is "does this plugin already have a
    // data.json": a fresh install has none and starts EMPTY (guard nothing;
    // capture refuses to enable); an existing install has one without the key
    // and gets the four seeded. The key is then always persisted — even as []
    // — so this branch runs at most once per install, and a new user who saves
    // any other setting before configuring territories can never inherit the
    // legacy operator's folder names on a later load.
    const territories = territoriesOnLoad(own, seed);
    this.settings.guardedTerritories = territories.territories;
    // #482 — the record folders, the same shape: no shipped folder names; an
    // install that predates the key is seeded once with what #455 hard-coded.
    const recordFoldersLoad = recordFoldersOnLoad(own, seed);
    this.settings.recordFolders = recordFoldersLoad.recordFolders;
    // The record identifier: coerce a partial or malformed value to the default
    // rather than crashing the probe or the settings tab. The rule is the
    // kernel's (`normalizeRecordIdentification`), tested there.
    this.settings.recordIdentification = normalizeRecordIdentification(this.settings.recordIdentification);
    // The Sync guard: a partial or hand-edited value is coerced, never a crash; absent ⇒ off.
    this.settings.syncGuard = normalizeSyncGuard(this.settings.syncGuard);
    if (typeof this.settings.createNoteFlow !== "string") this.settings.createNoteFlow = "";
    this.settings.writeScope = normalizeWriteScope(this.settings.writeScope);
    this.settings.host = normalizeHostSettings(this.settings.host);
    // A hand-edited/corrupt data.json must not silently DISABLE a guard: any
    // value that isn't an explicit `false` reads as enforced (same
    // fail-toward-the-safe-default discipline as the cliPolicy/protected-
    // property normalization below, where a dropped malformed entry can only
    // mean more denied, never less).
    this.settings.enforceRecordImmutability = this.settings.enforceRecordImmutability !== false;
    // Explicit opt-in: anything other than a literal `true` reads as off, so a corrupt or partial settings file can never turn capture on by accident.
    this.settings.captureObservations = this.settings.captureObservations === true;
    if (typeof this.settings.captureMaxBytes !== "number" || this.settings.captureMaxBytes <= 0) {
      this.settings.captureMaxBytes = DEFAULT_SETTINGS.captureMaxBytes;
    }
    // 0.12.0 module-id rename (`governance` → `acceptance`): adopt a legacy
    // `modules.governance` row under the new id when no `modules.acceptance`
    // row exists yet, dropping the old key so the next save persists the new
    // shape (one-time migrate-on-save; the row's live config rides across
    // verbatim). Kept after the host/provider split even though the host no
    // longer MOUNTS an acceptance module: the row is what the PROVIDER reads
    // out of this same file, and normalizing its id here is what keeps the
    // provider from having to know about the 0.12.0 spelling too.
    this.settings.modules = migrateLegacyModuleIds(this.settings.modules);
    // Object.assign is shallow: a hand-edited data.json carrying a PARTIAL
    // cliPolicy (one list, not both) would leave the other undefined and
    // crash the settings tab; a WRONG-TYPED one (a string where a list
    // belongs) would crash the policy matcher mid-call. Normalize to fresh
    // arrays of strings — dropping malformed values, never throwing — and
    // never alias DEFAULT_SETTINGS' own arrays (the schemes structuredClone
    // discipline). Policy semantics are unaffected: a dropped malformed
    // entry can only mean MORE denied, never less.
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    this.settings.cliPolicy = {
      deny: list(this.settings.cliPolicy?.deny),
      allowOpaque: list(this.settings.cliPolicy?.allowOpaque),
      neverOpaque: list(this.settings.cliPolicy?.neverOpaque),
    };
    // #224: coerce the declared protected-property rows to the storable shape
    // first (a hand-edited data.json carrying a non-array or junk rows must not
    // crash the settings-tab render — the cliPolicy discipline above). Raw
    // grade STRINGS are preserved as typed so the textarea round-trips; full
    // validation stays in the registry setter.
    this.settings.protectedProperties = Array.isArray(this.settings.protectedProperties)
      ? this.settings.protectedProperties
          .filter((r): r is { key: string; grade: string } => !!r && typeof (r as { key?: unknown }).key === "string")
          .map((r) => ({ key: r.key, grade: typeof r.grade === "string" ? r.grade : "agent-forbidden" }))
      : DEFAULT_PROTECTED_PROPERTIES.map((p) => ({ ...p }));
    // Sync the list into the core guard registry (the setter normalizes —
    // floor keys and unknown grades are dropped loudly, so a tampered
    // data.json can extend the perimeter but never shrink or restate the
    // hardcoded accepted-family floor).
    setDeclaredProtectedProperties(this.settings.protectedProperties);
    // Persist NOW if the territories key was absent (seeded or fresh), so the
    // seeding branch above can never run a second time for this install.
    if (territories.persist || recordFoldersLoad.persist) await this.saveSettings();
  }
  async saveSettings() {
    await this.saveData(this.settings);
    // Adoption is spent the moment the host owns a data.json of its own.
    this.adoptedSettings = null;
    // Keep the core guard registry live with settings-tab edits (#224).
    setDeclaredProtectedProperties(this.settings.protectedProperties);
  }

  private discoveryCount(): number {
    try { return fs.readdirSync(stateDir()).filter((f) => f.endsWith(".json")).length; }
    catch { return 0; }
  }

  async autoRegister(force = false): Promise<void> {
    // The load-time run asks the `host` setting first: off, or headless declared, or
    // VAULT_MCP_NO_AUTOREGISTER=1, and no `claude` process is started (headless.ts).
    if (!force && !autoRegisterAllowed(normalizeHostSettings(this.settings.host))) return;
    const bin = findClaudeBinary();
    if (!bin) {
      if (force) new Notice("Vault MCP: `claude` CLI not found. Use the manual command in settings.");
      else this.showFallbackOnce();
      return;
    }
    if (!force && this.discoveryCount() > 1) { this.showFallbackOnce(); return; } // ambiguous: multiple vaults
    try {
      if (await claudeIsRegistered(bin)) {
        // `claude mcp add` errors on a duplicate name, so never re-add.
        if (force) new Notice("Vault MCP: already connected to Claude Code.");
        this.ensureConnectPlugin(bin, force);
        return;
      }
      await claudeRegister(bin, bridgeDestPath(), this.app.vault.getName());
      new Notice(
        "Vault MCP: connected to Claude Code (server name 'vault-mcp'). Restart any open Claude Code session to use it.",
      );
      this.ensureConnectPlugin(bin, force);
    } catch (e) {
      new Notice(`Vault MCP: auto-register failed — ${(e as Error).message}. Use the manual command in settings.`);
      this.showFallbackOnce();
    }
  }

  // #38: fire-and-forget provisioning of the vault-mcp-connect Claude Code
  // plugin (SessionStart health hook + /vault-mcp-status) alongside the MCP
  // registration. Idempotent + quiet: a Notice only on a forced run or when
  // something was actually installed; failures log once, never nag.
  private ensureConnectPlugin(bin: string, force: boolean): void {
    void claudeEnsureConnectPlugin(bin)
      .then((r) => {
        if (r === "installed") new Notice("Vault MCP: installed the vault-mcp-connect Claude Code plugin.");
        else if (force) new Notice("Vault MCP: vault-mcp-connect plugin already installed.");
      })
      .catch((e: unknown) => {
        console.error("[vault-mcp] connect-plugin provisioning skipped —", e instanceof Error ? e.message : e);
      });
  }

  async claudeRemoveRegistration(): Promise<void> {
    const bin = findClaudeBinary();
    if (!bin) { new Notice("Vault MCP: `claude` CLI not found."); return; }
    await claudeRemove(bin);
    new Notice("Vault MCP: removed Claude Code registration.");
  }

  private showFallbackOnce(): void {
    if (this.settings.setupAcknowledged) return;
    new ConnectionSetupModal(this.app, async () => { this.settings.setupAcknowledged = true; await this.saveSettings(); }).open();
  }

  /**
   * Keep the uid index fresh off Obsidian's own events — no polling, no timers,
   * no filesystem reads.
   *
   *   • build once when the layout is ready, because before that the metadata
   *     cache is still warming and a build would index a fraction of the vault;
   *   • `metadataCache.changed` covers every uid EDIT — added, changed, removed
   *     — and every newly created note, since the cache parses it on arrival;
   *   • `vault.rename` is the one that matters most: it is precisely the event
   *     a path-keyed store loses to, and the whole reason the index exists;
   *   • `vault.delete` drops the mapping.
   *
   * registerEvent so every handler is detached when the plugin unloads.
   *
   * `onLayoutReady` is the exception: it takes a plain callback and returns no
   * EventRef, so there is nothing for registerEvent to detach. A plugin unloaded
   * before the layout settles would otherwise still run its rebuild — indexing a
   * vault on behalf of an instance that no longer exists — so the callback is
   * gated on a disposed flag that `register` flips at unload. Wired only when
   * something can READ it — a live socket (`settings.enabled`) or the dev
   * tool-runner (whose captured tools resolve `uid:` addressing and report uid
   * coverage over this same index; an unwired index would make those answers
   * silently empty, precisely in the socket-off mode the runner supports) —
   * via `ensureUidIndexWired`, so an instance serving neither does no upkeep.
   */
  private uidIndexWired = false;
  private ensureUidIndexWired(index: UidIndex): void {
    if (this.uidIndexWired) return;
    this.uidIndexWired = true;
    this.wireUidIndex(index);
  }

  private wireUidIndex(index: UidIndex): void {
    let disposed = false;
    this.register(() => { disposed = true; });
    this.app.workspace.onLayoutReady(() => { if (!disposed) index.rebuild(); });
    this.registerEvent(this.app.metadataCache.on("changed", (file) => index.onChanged(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => index.onRenamed(oldPath, file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => index.onDeleted(file.path)));
  }

  async onload() {
    // ── the host's one-shot adoption from the pre-split plugin folder ────────
    //
    // The suite split gave the host back the id `vault-mcp` and left the
    // governance provider holding `governor` — and, with it, the folder both
    // halves used to share. So the host COPIES three things out of
    // `.obsidian/plugins/governor/`: the write journal, the install id, and the
    // host-owned keys of `data.json`. It never moves and never deletes, and it
    // never touches `governance/` — the authority state stays with the plugin
    // that kept the id, which is the whole reason it kept it. See
    // src/id-migration.ts for the plan, the copy discipline and the
    // COPY-not-MOVE rollback argument.
    //
    // EVERY non-success outcome raises a STICKY Notice (`new Notice(msg, 0)`),
    // not just a console line. The reason is specific: when adoption does not
    // happen, `loadSettings()` below falls back to DEFAULT_SETTINGS — socket
    // enabled, read-only OFF, allowlist EMPTY — i.e. the guard config silently
    // resets to OPEN, and the first `saveSettings()` writes a fresh data.json
    // into the new dir, which permanently closes the one-shot adoption window
    // (every later load then hits the "already provisioned" skip). A
    // console.error nobody opens is not a signal for that.
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const adoptionNotice = (msg: string) => {
      console.error(`[vault-mcp] ${msg}`);
      try { new Notice(`Vault MCP: ${msg}`, 0); } catch { /* pre-layout; the console line stands */ }
    };
    try {
      const sourceDir = `${this.app.vault.configDir}/plugins/${LEGACY_PLUGIN_ID}`;
      const result = await runHostAdoption(this.app.vault.adapter, sourceDir, pluginDir);
      if (result.plan.action === "adopt") {
        if (result.failedEntry) {
          adoptionNotice(
            `adoption from ${sourceDir} INCOMPLETE — '${result.failedEntry}' failed to copy; ` +
              `copied so far: ${result.copied.join(", ") || "(none)"}. Nothing was moved or deleted, and ` +
              `${sourceDir} is untouched. Settings are running at DEFAULTS until this is resolved.`,
          );
        } else {
          if (result.settingsJson) {
            try {
              this.adoptedSettings = splitSettings(JSON.parse(result.settingsJson)).host;
            } catch (e) {
              adoptionNotice(
                `the '${LEGACY_PLUGIN_ID}' data.json could not be parsed, so NO settings were adopted and this ` +
                  `host is running at DEFAULTS — socket enabled, read-only OFF, allowlist EMPTY. ${
                    e instanceof Error ? e.message : String(e)
                  }`,
              );
            }
          }
          console.log(`[vault-mcp] adopted from ${sourceDir}: ${[...result.copied, ...(this.adoptedSettings ? ["settings"] : [])].join(", ")}`);
        }
      } else if (result.plan.warn) {
        adoptionNotice(`adoption needs attention: ${result.plan.reason}`);
      }
    } catch (e) {
      adoptionNotice(
        `adoption FAILED — continuing with DEFAULT settings; nothing was moved and the '${LEGACY_PLUGIN_ID}' folder is untouched. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    // Load settings FIRST so the enabled gate and guard settings are available.
    await this.loadSettings();
    // Persist an adoption immediately rather than waiting for a settings edit:
    // an adopted-but-unsaved allowlist would be lost on the next reload, and
    // "the guard config silently reset to OPEN" is the failure this whole
    // block exists to prevent.
    if (this.adoptedSettings) await this.saveSettings();

    // Before anything is bound or written: a headless host names its own state dir and socket (headless.ts).
    configurePaths({ stateDir: this.settings.host.stateDir, socketPath: this.settings.host.socketPath });
    const headlessAtLoad = declaredHeadless(this.settings.host.headless);

    const vaultName = this.app.vault.getName();
    this.slug = vaultSlug(vaultName);
    const sock = socketPath(this.slug);

    const adapter = this.app.vault.adapter;
    const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";

    // Write the build-time-embedded bridge into ~/.claude/vault-mcp/ (and a
    // grace-period copy into ~/.claude/governor/, where every registration
    // made between 0.12.0 and the split still points — see discovery.ts).
    try { writeBridge(); }
    catch (e) { console.error("[vault-mcp] writeBridge failed", e); }

    // Kernel v0 — ONE queue and ONE journal per plugin instance, shared by
    // every per-connection server built below. The journal lives beside the
    // plugin's own data (`.obsidian/plugins/vault-mcp/journal/YYYY-MM.jsonl`),
    // out of the note tree so it can never be mistaken for vault content.
    //
    // The identity substrate's uid index — one per plugin instance, like the
    // queue: it is a map of the vault, not of a connection.
    const uidIndex = new UidIndex(obsidianUidSource(this.app));
    // #272: every journal append nudges the WRITE QUEUE's wall-clock deadline check.
    // Some journal records land without taking a queue slot (idempotent replays,
    // deduped waiters, key mismatches), so an append can happen while an operation
    // is wedged mid-queue — one timer-free event that abandons an overdue
    // operation instead of leaving it holding the queue in an occluded window.
    //
    // #261's second consumer — nudging the governance review queue's poll — left
    // with the provider, and it is worth being exact about what that cost.
    // Renderer timer throttling is real: Chromium suspends the 2.5s poll while
    // the window is occluded, which is when agents write. The host used to fix
    // that from right here, by nudging the queue on every append. It cannot
    // now, and NO journal-growth hook was added to the seam for it — the
    // provider drives its queue from the write observer instead, which is the
    // same event arriving through a hook that already exists. That is
    // NARROWER: the observer fires only where write facts were produced, so
    // appends that take no queue slot and mutations that are not native
    // note-writes no longer drive it. Documented on the provider's
    // registration and in docs/s3c-migration-plan.md; closing it properly is a
    // journal-growth fact on the seam, which is a design conversation.
    const writeQueue = new WriteQueue();
    const journal = new WriteJournal(this.app.vault.adapter, `${pluginDir}/journal`);
    // A cheap monotonic head marker for session base states (WP5): the count
    // of appends observed since this plugin instance loaded, anchored by the
    // load instant. Approximate on purpose — evidence for reconciliation,
    // not a lock — and honest about its scope: it orders points WITHIN one
    // plugin lifetime and identifies the lifetime across restarts.
    const journalBoot = new Date().toISOString();
    let journalAppends = 0;
    const journalHeadMarker = () => `${journalBoot}#${journalAppends}`;
    const journalAppend = journal.append.bind(journal);
    journal.append = (record) => {
      const done = journalAppend(record);
      void done.then(() => {
        journalAppends++;
        writeQueue.nudge();
      });
      return done;
    };
    // #435: ONE key store per vault, kept on globalThis so a reload hands it to
    // the new instance. A write still RUNNING on the unloaded instance keeps its
    // reservation here, so a retry on the new instance waits for it instead of
    // running it again; seeding from the journal (below) covers a full restart.
    // The name carries a version: a build whose store class changes shape must
    // bump it, so it starts a fresh store instead of adopting an old object.
    const stores: Map<string, IdempotencyStore> = ((globalThis as Record<string, unknown>).__vaultMcpIdempotencyV1 ??= new Map()) as Map<string, IdempotencyStore>;
    const idempotency = stores.get(this.slug) ?? new IdempotencyStore();
    stores.set(this.slug, idempotency);
    const kernel = new Kernel(
      writeQueue,
      journal,
      obsidianProbe(this.app, () => this.settings.enforceRecordImmutability, () => this.settings.recordIdentification),
      idempotency,
      new LockStore(),
      uidIndex,
    );
    // #435: a reload must not leave this instance's queue running. Obsidian
    // calls registered callbacks at unload; closing refuses every write still
    // waiting ("not run; safe to retry"). The write already running cannot be
    // cancelled and settles on its own.
    this.register(() => writeQueue.close());
    // #435: the key store is in memory, so a reload forgot every key and a
    // retry across it ran the write again. Seed it from the journal's keyed
    // records inside the TTL (this month's file and last month's, for a reload
    // just after midnight UTC on the 1st), BEFORE the socket accepts a call.
    // A journal that cannot be read seeds nothing and never fails the load.
    try {
      const now = new Date();
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const records: SeedRecord[] = [];
      for (const key of [monthKey(prev), monthKey(now)]) {
        const path = `${pluginDir}/journal/${key}.jsonl`;
        if (!(await this.app.vault.adapter.exists(path))) continue;
        for (const line of (await this.app.vault.adapter.read(path)).split("\n")) {
          if (!line.includes('"idempotencyKey"')) continue;
          try { records.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
        }
      }
      seedFromJournal(idempotency, records, now.getTime());
    } catch (e) {
      console.error("[vault-mcp] seeding idempotency keys from the journal failed; keys start empty", e);
    }

    // Server identity — the transport asserting which vault and which install.
    // The install id is a small file beside the journal (`install-id.json`), so
    // the identity that stamps every record lives with the records; it survives
    // restarts, and a failure to persist degrades to an ephemeral id rather than
    // failing the load. Adopted (copied) from the pre-split folder above, so the
    // audit stream does not report a new install at the split.
    const { install } = await loadInstallId(this.app.vault.adapter, pluginDir);
    const serverIdentity = obsidianServerIdentity(this.app, install, this.manifest.version);

    // ── the session lifecycle log (WP5; host-owned since the split) ──────────
    //
    // Condition 7 ruled the host mints and named what the host keeps:
    // identifiers, scope digest, lifecycle. This is that record, append-only
    // beside the journal. It is EVIDENCE, not a gate — no `get`, because
    // reading it to decide whether a mutation may proceed is asking permission,
    // and the host asks nobody. Expiry is the host's own pure floor; revocation
    // is the provider's, answered through the seam.
    //
    // Appends are serialized through one chain: the exists?append:write pair
    // is not atomic, and two concurrent connection opens on a fresh vault
    // could otherwise both take the `write` branch, silently losing one
    // `opened` event.
    const sessionsFile = `${pluginDir}/sessions.jsonl`;
    const sessionAdapter = this.app.vault.adapter;
    let sessionIoChain: Promise<unknown> = Promise.resolve();
    const sessionLog = createSessionLog({
      appendLine: (line) => {
        const task = async () => {
          if (await sessionAdapter.exists(sessionsFile)) await sessionAdapter.append(sessionsFile, line + "\n");
          else await sessionAdapter.write(sessionsFile, line + "\n");
        };
        const next = sessionIoChain.then(task, task);
        sessionIoChain = next.catch(() => undefined);
        return next;
      },
    });

    const ctx = {
      pluginVersion: this.manifest.version,
      socketPath: sock,
      vaultName,
      pluginDir,
      enabledPlugins: () => Array.from((this.app as any).plugins.enabledPlugins as Set<string>),
      getSettings: () => ({
        readOnly: this.settings.readOnly,
        allowlist: this.settings.allowlist,
        allowDangerousCli: this.settings.allowDangerousCli,
        rawCliProxy: this.settings.rawCliProxy,
        trustedReadOnlyPlugins: this.settings.trustedReadOnlyPlugins,
        schemes: this.settings.schemes,
        modules: this.settings.modules,
        cliPolicy: this.settings.cliPolicy,
        captureObservations: this.settings.captureObservations,
        captureMaxBytes: this.settings.captureMaxBytes,
        // Forwarded RAW, resolved at the call site. Projecting the resolved list
        // here would freeze it per connection, so an operator's edit would not
        // reach capture until the next reconnect — the inert-toggle shape again.
        guardedTerritories: this.settings.guardedTerritories,
        // Live per call: an operator who narrows or widens the write scope does not wait for a reconnect.
        writeScope: this.settings.writeScope,
      }),
      // The record settings, live per call through their own thunks — the same
      // two getters the kernel's guard probe above takes — and deliberately not
      // in the getSettings projection (settings-projection WITHHELD). The moves'
      // record test and obsidian_rename_heading read them through server.ts.
      enforceRecordImmutability: () => this.settings.enforceRecordImmutability,
      recordIdentification: () => this.settings.recordIdentification,
      recordFolders: () => this.settings.recordFolders,
      syncGuard: () => this.settings.syncGuard,
      createNoteFlow: () => this.settings.createNoteFlow,
      host: () => this.settings.host,
      serverIdentity,
      sessions: {
        // LIFECYCLE ONLY (condition 7 — the host mints). `get` is deliberately
        // absent: reading the durable record to decide whether a queued
        // mutation may proceed is asking PERMISSION, and that question goes to
        // the seam's session-refusal hook, which a provider answers from its
        // own revocation state.
        open: (session: import("@vault-mcp/core").SessionV1, now: number) => sessionLog.open(session, now),
        close: (sessionId: string, now: number) => sessionLog.close(sessionId, now),
        markExpired: (sessionId: string, now: number) => sessionLog.markExpired(sessionId, now),
        replicaId: install,
        vaultId: vaultName,
        journalHead: () => journalHeadMarker(),
      },
      // The consultation half of the governance seam. The REGISTRATION half
      // rides `this.api`; this side is closure-held and reaches no further than
      // the per-connection servers built below. With no provider installed
      // every consultation is vacuous, which is the ordinary case, not a
      // special one.
      seam: seamOf(this).consult,
      getExternalTools: () => externalRegistryOf(this).entries(),
      kernel,
    };

    // The uid index is kept fresh only while something can actually read it:
    // a live socket, or the dev tool-runner (which resolves uid: addressing
    // over the same index, socket or no socket). Neither ⇒ no reader ⇒ no
    // upkeep. The runner command below also calls ensureUidIndexWired on use,
    // covering a devToolRunner toggle flipped ON mid-session.
    if (this.settings.enabled || this.settings.devToolRunner) this.ensureUidIndexWired(uidIndex);

    if (this.settings.enabled) {
      // One MCP server per connection → concurrent Claude Code sessions and
      // background agents share the plugin without evicting each other.
      this.listener = new UnixSocketListener(sock, (transport, connOpts) => {
        const server = buildMcpServer(this.app, ctx, { codeMode: connOpts.codeMode });
        server.connect(transport).catch((e) => console.error("[vault-mcp] connect failed", e));
      });
      await this.listener.listen();

      const discovery: Discovery = {
        socket_path: sock,
        vault_path: basePath,
        vault_name: vaultName,
        plugin_version: this.manifest.version,
        obsidian_version: (this.app as any).appVersion ?? "",
        started_at: new Date().toISOString(),
        capabilities: ["preamble"],
      };
      writeDiscovery(this.slug, discovery);
      console.log(`[vault-mcp] listening on ${sock}`);
    } else {
      console.log("[vault-mcp] disabled in settings; socket not started");
    }

    this.addSettingTab(new VaultMcpSettingTab(this.app, this));

    // ── scheme Inbox pane (jd-dashboard fold, Stage B) ─────────────────────────
    // Mounted on the scheme module's own enabled flag, matching its
    // default-true semantics elsewhere (modules-mount.ts:
    // `settings.modules?.scheme?.enabled === false` is the disabled check, so
    // an absent settings row means on) — the pane is meaningless without
    // scheme addressing configured. LIVE mount/unmount (governor#286): flipping
    // the toggle in settings mounts or unmounts it immediately, no
    // plugin reload, via `setSchemePanesMounted` below. The pane does not force a
    // leaf open on its own — the ribbon icon / command opens it on demand.
    // Headless (declared): no panes, and none of the commands below that open a view or a modal.
    if (!headlessAtLoad && this.settings.modules?.scheme?.enabled !== false) {
      void this.setSchemePanesMounted(true);
    }
    // Commands register unconditionally, once, regardless of live mount
    // state — see scheme/wiring.ts's registerSchemeCommands doc comment for
    // why (no public Obsidian API to live-unregister a command).
    if (!headlessAtLoad) registerSchemeCommands(this, () => this.settings.modules?.scheme?.enabled !== false);

    if (!headlessAtLoad) this.addCommand({
      id: "connect-claude-code",
      name: "Connect to Claude Code",
      callback: () => this.autoRegister(true),
    });

    // ── dev tool-runner: "Vault MCP: Run tool…" ────────────────────────────────
    // ONE command over the whole tool surface, not one command per tool: ~68
    // commands would spam the palette, and — since every Obsidian command is
    // agent-reachable via obsidian_run_command — would multiply the policy
    // surface for zero gain. The registry is built LAZILY per invocation via a
    // fresh codeMode capture build (the same registration path a new MCP
    // connection runs), so conditional tools reflect the live plugin state.
    // The built server is never connected to any transport — only its captured
    // guarded handlers are used — and its journal actor carries
    // client: "tool-runner" so runner writes are distinguishable in the audit
    // stream while still landing exactly like MCP writes.
    //
    // This command being agent-invokable via obsidian_run_command is fine BY
    // CONSTRUCTION: it grants nothing MCP doesn't already grant (an agent with
    // run_command has the MCP tools directly, under the same guard), and the
    // modal chain requires real UI interaction anyway. Registered regardless of
    // `settings.enabled` (the socket) — dev use with the transport off is the
    // point — but gated live on the devToolRunner setting via checkCallback,
    // which also gates executeCommandById.
    if (!headlessAtLoad) this.addCommand({
      id: "run-tool",
      name: "Run tool…",
      checkCallback: (checking) => {
        if (!this.settings.devToolRunner) return false;
        if (!checking) {
          // A late toggle-on must not leave the runner reading a never-built
          // uid index (empty answers for uids that exist). Idempotent; and
          // onLayoutReady fires immediately when the layout is already ready,
          // so a mid-session first wire rebuilds right away.
          this.ensureUidIndexWired(uidIndex);
          openToolRunner(this.app, () => {
            let registry: CapturedRegistry = new Map();
            buildMcpServer(this.app, ctx, {
              codeMode: true,
              clientLabel: "tool-runner",
              onRegistry: (r) => (registry = r),
            });
            return registry;
          });
        }
        return true;
      },
    });

    void this.autoRegister();

    if (!headlessAtLoad) this.addCommand({
      id: "show-diagnostics",
      name: "Show diagnostics",
      callback: () => {
        const enabled = Array.from((this.app as any).plugins.enabledPlugins as Set<string>);
        const integrations = ["dataview", "templater-obsidian", "omnisearch", "metadata-menu"]
          .map((id) => `${id}: ${enabled.includes(id) ? "yes" : "no"}`);
        new DiagnosticsModal(this.app, [
          `Vault: ${this.app.vault.getName()}`,
          `Socket: ${socketPath(this.slug)}`,
          `Version: ${this.manifest.version}`,
          `Governance provider: ${seamOf(this).consult.providerIds().join(", ") || "none registered"}`,
          ...integrations,
        ]).open();
      },
    });

    // Signal publishers (vault-mcp-api SDK) and the governance provider that
    // the api is (re-)available. `vault-mcp:ready` is canonical again — the id
    // returned to `vault-mcp` at the split — and `governor:ready` keeps firing
    // for anything built against the 0.12.0-era id. Both carry the same object;
    // the SDK resolves the host by id and not by which event woke it.
    this.app.workspace.trigger(`${PLUGIN_ID}:ready`, this.api);
    this.app.workspace.trigger(`${LEGACY_PLUGIN_ID}:ready`, this.api);
  }

  /**
   * The settings tab calls this when a module's enable toggle flips (connection-ui.ts's per-module
   * "Enabled" toggle). `scheme` is the one module whose Obsidian surface mounts/unmounts LIVE from
   * here, with no plugin reload — its Inbox pane (governor#286). Every other module is
   * tool-only: its MCP surface mounts per connection, so its toggle takes effect on the next
   * session connect and there is nothing to mount or unmount in-app.
   *
   * `acceptance` used to be handled here too. Its pane left with the governance provider at the
   * host/provider split, and so did the toggle that mounts it: the provider's own settings tab
   * owns that control now, over the provider's own `data.json`.
   */
  async onModuleEnabledChanged(moduleId: string, enabled: boolean): Promise<void> {
    if (moduleId === "scheme") await this.setSchemePanesMounted(enabled);
  }

  /**
   * Drive the scheme Inbox pane's mount state to `enabled`, live, without a plugin reload.
   * Idempotent (enabling when already mounted, or disabling when already unmounted, is a no-op) and
   * serialized so a rapid enable→disable can't interleave a mount with a teardown. Mount runs
   * `wireSchemePanes` (the view + its ribbon, on one shared child Component); unmount is
   * `removeChild`, which detaches any open leaves and unregisters the view type.
   */
  async setSchemePanesMounted(enabled: boolean): Promise<void> {
    const next = this.schemePanesReconcile.then(() => this.applySchemePanesMount(enabled));
    this.schemePanesReconcile = next.catch(() => {});
    await next;
  }

  private async applySchemePanesMount(enabled: boolean): Promise<void> {
    const action = mountAction(this.schemePanesComponent !== null, enabled);
    if (action === "none") return;
    if (action === "mount") {
      try {
        this.schemePanesComponent = wireSchemePanes(this, {
          getSchemes: () => this.settings.schemes ?? DEFAULT_SCHEMES,
        });
      } catch (e) {
        console.error("[vault-mcp] scheme panes wiring failed", e);
        this.schemePanesComponent = null;
      }
    } else {
      this.removeChild(this.schemePanesComponent!);
      this.schemePanesComponent = null;
    }
  }

  async onunload() {
    await this.listener?.close();
    removeDiscovery(this.slug);
  }
}
