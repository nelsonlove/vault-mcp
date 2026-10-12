import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
import { archivePatternRegExp } from "./kernel/record-guard.js";
import { MAX_WAIT_SECONDS } from "./kernel/sync-guard.js";
import type VaultMcpPlugin from "./main.js";
import { buildRegisterCommand } from "./register-command.js";
import { bridgeDestPath } from "./paths.js";
import {
  findClaudeBinary,
  claudeIsRegistered,
  claudeLegacyIsRegistered,
  MCP_SERVER_NAME,
  LEGACY_MCP_SERVER_NAME,
} from "./claude-cli.js";
import { DANGEROUS_LIST_DESC } from "./mcp/tools-cli.js";
import { OPAQUE_ACCEPT_CLI_COMMANDS, OPAQUE_ACCEPT_COMMAND_IDS } from "./mcp/cli-policy.js";
import { CommandSuggest } from "./command-suggest.js";
import { builtinModules } from "./mcp/modules-mount.js";
import {
  ModuleRegistry,
  collect,
  mergeModuleConfig,
  safeValidate,
  type HostedField,
  type HostedModule,
  type VaultModule,
} from "./kernel/modules/index.js";
import { ensureSettingsStyles } from "./settings-styles.js";
import {
  DEFAULT_PROTECTED_PROPERTIES,
  formatProtectedPropertyLines,
  normalizeProtectedProperties,
  parseProtectedPropertyLines,
  resolveTerritories,
} from "@vault-mcp/core";
import { hasGuardedTerritory } from "./territory-policy.js";
import { CONVENTION_FIELDS, commitConvention } from "./conventions-policy.js";
import { resolveConventions } from "./conformance/vault-conventions.js";

// ── tabbed settings UI: the pure, DOM-free half ─────────────────────────────
//
// The settings tab is one long scroll no more: it's split into a Connection
// tab, a Security tab, and one tab PER registered module (generated from the
// same module set the generic renderer already iterates, so a new module gets
// a tab with zero extra code). The two functions below are the entire
// non-DOM half — tab-list derivation from the module set, and active-tab
// resolution — so they're exported and headless-tested; only the DOM wiring
// and click-switching in `display()` is obsidian-coupled (verified by build +
// reasoning, per the same boundary as every other field in this file).

/** One tab in the settings UI: a stable `id` and the visible `name`. */
export interface SettingsTab {
  id: string;
  name: string;
}

/** The two fixed leading tabs, in order, before the per-module tabs. */
export const STATIC_SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "connection", name: "Connection" },
  { id: "security", name: "Security" },
  // #403: the conformance rail's vault conventions, three fields since #412, no shipped values.
  { id: "conformance", name: "Conformance" },
];

/** Prefix distinguishing a per-module tab id from a static one, so a module
 * whose id happened to be "connection"/"security" could never collide. */
export const MODULE_TAB_PREFIX = "module:";

/** The tab id for a module — its registry id under the module prefix. */
export function moduleTabId(moduleId: string): string {
  return `${MODULE_TAB_PREFIX}${moduleId}`;
}

/** Derive the full ordered tab list from the module set: the fixed Connection
 * and Security tabs, then one tab per module in registry order (id and name
 * both the module's `id`, matching the section header the module renderer
 * already uses). Pure — the derivation is data-driven off the module set, so
 * a newly-registered module automatically yields a new tab. */
export function buildSettingsTabs(modules: ReadonlyArray<{ id: string }>): SettingsTab[] {
  return [
    ...STATIC_SETTINGS_TABS,
    ...modules.map((m) => ({ id: moduleTabId(m.id), name: m.id })),
  ];
}

/** Resolve which tab is active: the `remembered` id if it still exists in the
 * current tab list, else the first tab (the default). An empty tab list yields
 * `undefined` (never happens in practice — the two static tabs are always
 * present). Pure, so the "remember last, but fall back when a remembered
 * module tab disappears" logic is headless-testable. */
export function resolveActiveTab(
  tabs: ReadonlyArray<SettingsTab>,
  remembered: string | undefined,
): string | undefined {
  if (remembered !== undefined && tabs.some((t) => t.id === remembered)) return remembered;
  return tabs.length > 0 ? tabs[0].id : undefined;
}

/** Parse a comma-separated text field into a trimmed, non-empty string list.
 * An all-blank input (or one that trims to nothing) yields `undefined` rather
 * than `[]` — "blank means the provider default", matching the
 * contentDecimalFloor field's "blank = default" convention, not "explicitly
 * override to nothing". Pure so it's usable outside the (obsidian-only,
 * headlessly-untestable) settings tab if ever needed. */
export function parseCommaList(value: string): string[] | undefined {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length === 0 ? undefined : items;
}

/** Parse the "Excluded roots" textarea (one folder prefix per line) into a
 * trimmed, non-empty string list. Blank lines are dropped; an all-blank
 * input yields `undefined` rather than `[]` — same "blank means nothing to
 * override" convention as `parseCommaList`, so a scheme instance with no
 * excluded territory looks identical to one the field was never touched on
 * (the persisted config never carries a bare `excludedRoots: []`). */
export function parseLineList(value: string): string[] | undefined {
  const items = value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length === 0 ? undefined : items;
}

/** Parse a "number"-typed config field: blank -> undefined (removes the key
 * — "use the provider default"), otherwise the parsed number. Generalizes
 * the old JD-specific `parseFloorField` to any manifest number field (#81's
 * generic renderer replaces the hand-built content-decimal-floor field this
 * was written for, but the parsing rule — and the field-level problem it
 * pairs with below — is the same for every number field). */
export function parseNumberField(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * What `parseNumberField` cannot express on its own: a non-numeric entry
 * (e.g. "abc") parses to `undefined`, indistinguishable from a deliberately
 * blank field. Unlike the old `floorFieldProblem` (which surfaced this
 * ALONGSIDE still saving the silently-emptied value), the renderer that
 * calls this REFUSES the save outright on a non-null result — loud, not a
 * silent coerce-to-default with a footnote (the task's own constraint: an
 * invalid value must be reported, never dropped to a default with no
 * visible trace). Blank and genuinely-numeric input (any value — RANGE
 * checking is the module's `manifest.config.validate`'s job, applied
 * separately to the built config) are never a problem here. Pure, testable
 * without a Setting tab. */
export function numberFieldProblem(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (Number.isNaN(Number(trimmed))) {
    return `${label}: "${trimmed}" is not a number — not saved; the previous value is kept.`;
  }
  return null;
}

// ── the vocab instance settings form USED TO LIVE HERE ──────────────────────
//
// `parseVocabConfig` / `stringifyVocabConfig` / `coerceVocabInstances` /
// `validateVocabInstances` / `add|remove|updateVocabInstanceAt`, plus the
// bespoke per-instance DOM form below them, edited `settings.vocabularies` —
// a LIST of `{id, provider, root, config}` rows the scalar manifest-field
// renderer could not express.
//
// They left at the read-tier satellite extraction (suite split, S7), MOVED not
// copied: the four vocabulary tools now ship as `packages/vocab` (plugin id
// `vaultmcp-vocab`), which renders its own settings tab over its own copy of the
// list. The form here became unreachable the moment the vocab module left
// `builtinModules` — it was appended to that module's generated section, and
// there is no such section any more — and unreachable UI with passing tests is
// the drift that makes a settings surface lie about itself.
//
// `settings.vocabularies` itself is DELIBERATELY still declared in main.ts.
// It is the migration source: the satellite adopts it once, on its first load,
// and never writes it back. Deleting the field here would destroy a user's
// configuration before the plugin that inherits it had a chance to read it.

/**
 * Append `value` to the allowOpaque re-enable list, from the "Add a command"
 * picker. Pure; returns the SAME array (not a copy) when nothing changes, so
 * a caller can tell "added" from "no-op" by reference — same convention the
 * kernel's mapPaths/visiblePaths use elsewhere in this repo. Two guards
 * beyond plain dedup: `value` must be a key of `validCommandIds` (this is
 * what keeps the picker strictly additive convenience rather than a laxer
 * path than the free-text textarea below it, which still accepts anything
 * typed), and `value` must not contain a newline — allowOpaque round-trips
 * through a one-per-line textarea (join("\n") / split("\n")), so a stored id
 * containing "\n" would silently split into two independent entries the next
 * time the textarea re-parses on any unrelated edit.
 */
export function addAllowOpaqueEntry(
  current: string[],
  value: string,
  validCommandIds: Record<string, unknown>
): string[] {
  if (!(value in validCommandIds) || value.includes("\n") || current.includes(value)) return current;
  return [...current, value];
}

// (`addVocabInstance` / `removeVocabInstanceAt` / `updateVocabInstanceAt` sat
// here, out of alphabetical order with the block above them; they moved to
// `packages/vocab/src/settings.ts` with the rest of the vocab settings form at
// S7.)

export function registerCommandFor(app: App): string {
  // Pin the current vault so the command stays unambiguous once a second vault
  // starts serving MCP. To point Claude Code at a different vault, re-run this
  // from that vault (or edit the `--vault <name>` value in the registered config).
  return buildRegisterCommand({ bridgePath: bridgeDestPath(), vaultName: app.vault.getName() });
}

// Shown alongside the manual command so the pinned `--vault` isn't a surprise.
export const SWITCH_VAULT_NOTE =
  "This command pins Claude Code to this vault via `--vault`. To switch vaults later, run Connect from the other vault, or edit the `--vault <name>` value in the config.";

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  new Notice("Copied. Paste it in a terminal, then restart any open Claude Code session.");
}

export class ConnectionSetupModal extends Modal {
  constructor(app: App, private onAck?: () => void) { super(app); }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Connect Vault MCP to Claude Code (manual fallback)");
    contentEl.createEl("p", {
      text: "Couldn't auto-register (claude CLI not found or multiple vaults). Run this once in a terminal:",
    });
    const cmd = registerCommandFor(this.app);
    contentEl.createEl("pre").createEl("code", { text: cmd });
    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    const copyBtn = btns.createEl("button", { text: "Copy command", cls: "mod-cta" });
    copyBtn.onclick = () => copyToClipboard(cmd);
    const ackBtn = btns.createEl("button", { text: "I've run it — don't show again" });
    ackBtn.onclick = () => { this.onAck?.(); this.close(); };
    contentEl.createEl("p", { cls: "mod-warning", text: SWITCH_VAULT_NOTE });
    contentEl.createEl("p", {
      cls: "mod-warning",
      text: "Paste in a terminal where the `claude` CLI is available. Restart any running Claude Code session afterward.",
    });
  }
  onClose() { this.contentEl.empty(); }
}

export class VaultMcpSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VaultMcpPlugin) { super(app, plugin); }

  /** Last-selected tab id, remembered across re-renders on the tab INSTANCE
   * (not persisted to settings — a deliberately lightweight persistence per
   * the task). A remembered tab that no longer exists (module removed) falls
   * back to the first tab, resolved by `resolveActiveTab`. */
  private activeTab?: string;

  /** The record-folder fields save when left; these commit them too when the tab closes (Escape can tear the
   * panel down before the field's "change" fires, #485 review). Each commit is idempotent. */
  private recordFieldCommits: Array<() => Promise<void>> = [];

  hide() {
    const commits = this.recordFieldCommits;
    this.recordFieldCommits = [];
    for (const c of commits) void c();
    super.hide();
  }

  display() {
    this.recordFieldCommits = [];
    const { containerEl } = this;
    containerEl.empty();
    ensureSettingsStyles();

    // Everything lives under a single plugin-scoped wrapper so the tab CSS
    // (settings-styles.ts) can never leak to the rest of the app.
    const wrapper = containerEl.createDiv({ cls: "vault-mcp-settings" });

    // Data-driven tab set: the two fixed tabs plus one per registered module,
    // derived from the SAME module list the generic renderer iterates — a new
    // module yields a new tab with no extra code here.
    const modules = this.moduleList();
    const tabs = buildSettingsTabs(modules);
    const active = resolveActiveTab(tabs, this.activeTab) ?? tabs[0]?.id;
    this.activeTab = active;

    // Toolbar with the horizontal, wrap-friendly tab-nav row.
    const toolbar = wrapper.createDiv({ cls: "vault-mcp-settings__toolbar" });
    const nav = toolbar.createDiv({ cls: "settings-tab-nav settings-view__tab-nav" });

    const buttons = new Map<string, HTMLElement>();
    const panes = new Map<string, HTMLElement>();

    for (const tab of tabs) {
      const btn = nav.createEl("button", {
        text: tab.name,
        cls: "settings-tab-button settings-view__tab-button vertical-tab-nav-item",
      });
      btn.id = `tab-button-${tab.id}`;
      buttons.set(tab.id, btn);
      const pane = wrapper.createDiv({ cls: "settings-tab-content settings-view__tab-content" });
      panes.set(tab.id, pane);
      btn.onclick = () => this.selectTab(tab.id, tabs, buttons, panes);
    }

    // Render each tab's content into its own pane. The Connection and Security
    // panes are the former top-of-scroll and Security sections verbatim; the
    // module panes are the same generic, manifest-driven sections as before —
    // one per module instead of a single stacked list.
    this.renderConnectionTab(panes.get("connection")!);
    this.renderSecurityTab(panes.get("security")!);
    this.renderConformanceTab(panes.get("conformance")!);

    const hosted = collect(modules, this.plugin.settings.modules, this.plugin.settings);
    for (const tab of tabs) {
      if (!tab.id.startsWith(MODULE_TAB_PREFIX)) continue;
      const modId = tab.id.slice(MODULE_TAB_PREFIX.length);
      const mod = modules.find((m) => m.id === modId);
      const h = hosted.find((x) => x.id === modId);
      if (mod && h) {
        const pane = panes.get(tab.id)!;
        this.renderModulesIntro(pane);
        this.renderModuleSection(pane, mod, h);
      }
    }

    this.applyActiveTab(active, tabs, buttons, panes);
  }

  /** Show only the `active` tab's pane and mark only its button active —
   * toggling the TaskNotes-style `active`/`--active`/`is-active` classes on the
   * buttons and both `settings-tab-content--active` (the base variant) and
   * `settings-view__tab-content--active` (the variant the stylesheet keys the
   * `display: block` flip on) on the panes. Both are added so the DOM carries
   * the base BEM class AND the CSS's `view__` selector matches — mirroring how
   * the buttons carry a stack of active classes. */
  private applyActiveTab(
    active: string | undefined,
    tabs: ReadonlyArray<SettingsTab>,
    buttons: Map<string, HTMLElement>,
    panes: Map<string, HTMLElement>,
  ): void {
    for (const tab of tabs) {
      const on = tab.id === active;
      const btn = buttons.get(tab.id);
      const pane = panes.get(tab.id);
      if (btn) {
        btn.classList.toggle("active", on);
        btn.classList.toggle("settings-view__tab-button--active", on);
        btn.classList.toggle("is-active", on);
      }
      if (pane) {
        pane.classList.toggle("settings-tab-content--active", on);
        pane.classList.toggle("settings-view__tab-content--active", on);
      }
    }
  }

  /** Remember and switch to `id`, updating the active classes in place (no full
   * re-render, so a click never disturbs the other panes' field state). */
  private selectTab(
    id: string,
    tabs: ReadonlyArray<SettingsTab>,
    buttons: Map<string, HTMLElement>,
    panes: Map<string, HTMLElement>,
  ): void {
    this.activeTab = id;
    this.applyActiveTab(id, tabs, buttons, panes);
  }

  /** The Connection tab: registration status, connect/disconnect, the manual
   * fallback command, and the socket enable/disable toggle. Verbatim the former
   * top-of-scroll connection block plus the trailing "Socket enabled" control,
   * only retargeted from `containerEl` to this tab's pane. */
  private renderConnectionTab(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Claude Code connection" });

    // Async status line: render placeholder then update after await.
    const statusEl = containerEl.createEl("p", { text: "Checking registration status…" });
    const bin = findClaudeBinary();
    if (!bin) {
      statusEl.setText("Registered with Claude Code: claude CLI not found — use the manual command below.");
    } else {
      // Both names are probed, and they are REPORTED SEPARATELY. A surviving
      // 0.12.0-era `governor` entry still works (the bridge resolves the socket
      // through discovery, not through the registration name), so it must not
      // be an error — but it must not read as "registered" either, or the
      // half-migrated state after the S3c wire rename would be invisible.
      Promise.all([claudeIsRegistered(bin), claudeLegacyIsRegistered(bin)]).then(([registered, legacy]) => {
        const legacyNote = legacy
          ? ` — a legacy '${LEGACY_MCP_SERVER_NAME}' registration is still present (its tools appear as ` +
            `mcp__${LEGACY_MCP_SERVER_NAME}__* and still work); remove it with: claude mcp remove ${LEGACY_MCP_SERVER_NAME}`
          : "";
        statusEl.setText(
          `Registered with Claude Code as '${MCP_SERVER_NAME}': ${registered ? "yes" : "no"}${legacyNote}`,
        );
      }).catch(() => {
        statusEl.setText("Registered with Claude Code: (error checking status)");
      });
    }

    // Connect / Disconnect buttons.
    new Setting(containerEl)
      .setName("Registration")
      .setDesc(
        "Connect or disconnect this vault's MCP server from Claude Code (server name 'vault-mcp'; tools appear " +
          "as mcp__vault-mcp__*). Registrations made between 0.12.0 and the host/provider split under the " +
          "'governor' name should be removed: claude mcp remove governor. They keep working until you do, but " +
          "leave you with two entries serving the same socket — and any mcp__governor__* permission entry in " +
          "~/.claude/settings.json needs re-adding as mcp__vault-mcp__*.",
      )
      .addButton((b) =>
        b.setButtonText("Connect to Claude Code").setCta().onClick(() => this.plugin.autoRegister(true))
      )
      .addButton((b) =>
        b.setButtonText("Disconnect").onClick(() => this.plugin.claudeRemoveRegistration())
      );

    // Manual fallback command.
    containerEl.createEl("h4", { text: "Manual setup (fallback)" });
    containerEl.createEl("p", {
      text: "If auto-register didn't work, run this once in a terminal:",
    });
    const cmd = registerCommandFor(this.app);
    containerEl.createEl("pre").createEl("code", { text: cmd });
    containerEl.createEl("p", { cls: "setting-item-description", text: SWITCH_VAULT_NOTE });
    new Setting(containerEl)
      .addButton((b) => b.setButtonText("Copy command").setCta().onClick(() => copyToClipboard(cmd)))
      .addButton((b) => b.setButtonText("Open setup popup").onClick(() => new ConnectionSetupModal(this.app).open()));

    new Setting(containerEl)
      .setName("Socket enabled")
      .setDesc(
        this.plugin.settings.enabled
          ? "The MCP socket is enabled. Toggle to disable (reload required)."
          : "The MCP socket is disabled. Toggle to re-enable (reload required)."
      )
      .addButton((b) => {
        b.setButtonText(this.plugin.settings.enabled ? "Disable socket" : "Enable socket");
        b.onClick(async () => {
          this.plugin.settings.enabled = !this.plugin.settings.enabled;
          await this.plugin.saveSettings();
          new Notice("vault-mcp: reload the plugin (or restart Obsidian) for this change to take effect.");
          this.display();
        });
      });
  }

  /** The Security tab: read-only mode, dangerous-CLI toggle, the command
   * policy (re-enabled opaque / denied), trusted read-only plugins, and the
   * path allowlist. Verbatim the former Security section, retargeted to this
   * tab's pane. */
  /** The vault conventions the conformance rail's legacy packs read (#403).
   *  One field per key, from `CONVENTION_FIELDS`; committed on BLUR like the
   *  guarded territories, so a half-typed path is never what the next debt or
   *  drift run measures against. Blank is honest: that convention is dead and
   *  the report says so; there is no built-in layout behind an empty box. */
  private renderConformanceTab(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Conformance" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Where the conformance rail's legacy checks look. There is no built-in layout: a blank folder path means that convention is DEAD — the checks that read it register, are not measured, and the report says so — until you point it at your vault. The baseline note is different: blank means no baseline, and the debt and drift views refuse until you name it. The in-app debt and drift views read these live. The standalone CLI reads VAULT_MCP_CONVENTIONS; for the baseline it reads GOVERNOR_BASELINE_REL first, then VAULT_MCP_CONVENTIONS, then this setting.",
    });
    for (const field of CONVENTION_FIELDS) {
      const current = resolveConventions(this.plugin.settings.vaultConventions)[field.key];
      const shown = Array.isArray(current) ? current.join("\n") : current;
      const commit = (raw: string) => {
        this.plugin.settings.vaultConventions = commitConvention(this.plugin.settings.vaultConventions, field, raw);
        void this.plugin.saveSettings();
      };
      const setting = new Setting(containerEl).setName(field.label).setDesc(field.help);
      if (field.kind === "paths") {
        setting.addTextArea((t) => {
          t.inputEl.rows = 3;
          t.setValue(shown);
          t.inputEl.addEventListener("blur", () => commit(t.inputEl.value));
        });
      } else {
        setting.addText((t) => {
          t.setValue(shown).setPlaceholder(field.key === "baselineRel" ? "blank = no baseline (the debt views refuse)" : "blank = not measured");
          t.inputEl.addEventListener("blur", () => commit(t.inputEl.value));
        });
      }
    }
  }

  private renderSecurityTab(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Security" });

    new Setting(containerEl)
      .setName("Read-only mode")
      .setDesc("Block all mutating tools (write, move, delete, patch, etc.). Read and search tools remain available.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.readOnly).onChange(async (value) => {
          this.plugin.settings.readOnly = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Raw CLI proxy")
      .setDesc(
        "Register obsidian_cli, the free-text pass-through to the official Obsidian CLI. Off by default: the " +
          "dedicated tools (obsidian_note_history, obsidian_note_diff, obsidian_base_create, the snippet tools, " +
          "obsidian_plugin_install/uninstall) cover the common jobs with typed arguments and path scoping. When on, " +
          "the proxy keeps all of its guards (command policy, danger gate, accept guard, deny lists). Takes effect " +
          "on the next session connect."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.rawCliProxy).onChange(async (value) => {
          this.plugin.settings.rawCliProxy = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Allow dangerous CLI commands")
      .setDesc(
        `Let the CLI surfaces run ${DANGEROUS_LIST_DESC}. These execute arbitrary code or control the app — leave off ` +
          "unless you need them. Also gates the dedicated obsidian_plugin_install / obsidian_plugin_uninstall tools " +
          "(same plugin:install / plugin:uninstall commands, same gate)."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowDangerousCli).onChange(async (value) => {
          this.plugin.settings.allowDangerousCli = value;
          await this.plugin.saveSettings();
        })
      );

    // Command policy (mcp/cli-policy.ts). The opaque-accept set — quickadd,
    // quickadd:run, quickadd:run-template, eval, command, and the quickadd:*
    // / js-engine:* run_command id families — is denied by DEFAULT; the re-enable list below is the
    // one human-only way back in. The deny list always wins over a re-enable.
    //
    // allowOpaque holds run_command IDs, not CLI command names — a picker
    // over app.commands (registered Obsidian commands, e.g. a QuickAdd
    // choice's quickadd:choice:<name> id) covers exactly that half. The CLI
    // side (quickadd/quickadd:run-template/eval/command) still has to be
    // typed by hand below: those aren't registered Obsidian commands, so
    // there's nothing to pick from.
    let allowOpaqueTextarea: HTMLTextAreaElement | undefined;
    new Setting(containerEl)
      .setName("Add a command")
      .setDesc(
        "Search registered Obsidian commands by name or id (e.g. a QuickAdd choice) and pick one to add it to " +
          "the re-enable list below. Adds the moment the box holds a real, currently-registered command id — " +
          "whether that came from picking a suggestion or typing the id out in full."
      )
      .addText((text) => {
        new CommandSuggest(this.app, text.inputEl);
        text.setPlaceholder("Search commands…");
        text.onChange(async (value) => {
          // app.commands.commands is not in the public obsidian types — cast
          // required (same cast the CommandSuggest / obsidian_get_command_ids
          // use).
          const commands = (this.app as any).commands.commands as Record<string, unknown>;
          const current = this.plugin.settings.cliPolicy.allowOpaque;
          const next = addAllowOpaqueEntry(current, value, commands);
          if (next !== current) {
            this.plugin.settings.cliPolicy = { ...this.plugin.settings.cliPolicy, allowOpaque: next };
            await this.plugin.saveSettings();
            if (allowOpaqueTextarea) {
              allowOpaqueTextarea.value = next.join("\n");
            }
          }
          // Clear whenever the box holds a real, currently-registered command
          // id — whether that pick just got added OR was already in the list.
          // Gating the clear on `next !== current` alone (addAllowOpaqueEntry's
          // no-op-by-reference treats "duplicate" and "invalid" identically)
          // left a picked duplicate sitting in the box with no feedback that
          // anything happened. Gating on validity directly instead matches the
          // pre-refactor behavior (an early `return` on invalid input, an
          // unconditional clear otherwise) without losing the keystroke fix.
          if (value in commands) {
            text.setValue("");
          }
        });
      });

    new Setting(containerEl)
      .setName("Re-enabled opaque commands")
      .setDesc(
        `Opaque macro/code commands (${[...OPAQUE_ACCEPT_CLI_COMMANDS].join(", ")}; ${[...OPAQUE_ACCEPT_COMMAND_IDS].join(", ")} ` +
          "command ids) are denied by default — the acceptance guard cannot inspect what they execute. List a " +
          "specific command or exact command id here (one per line; no wildcards — each entry re-enables exactly " +
          "one) to re-enable it, or use the picker above for a registered command id. eval/command additionally " +
          "require the dangerous-CLI toggle above. Takes effect immediately."
      )
      .addTextArea((ta) => {
        allowOpaqueTextarea = ta.inputEl;
        ta.setValue(this.plugin.settings.cliPolicy.allowOpaque.join("\n"));
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings.cliPolicy = {
            ...this.plugin.settings.cliPolicy,
            allowOpaque: value.split("\n").map((s) => s.trim()).filter(Boolean),
          };
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Denied commands")
      .setDesc(
        "Additional obsidian_cli commands or obsidian_run_command ids to deny (one per line; a trailing * makes " +
          "a prefix pattern, e.g. templater:*). Deny always wins — including over the re-enable list above."
      )
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.cliPolicy.deny.join("\n"));
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings.cliPolicy = {
            ...this.plugin.settings.cliPolicy,
            deny: value.split("\n").map((s) => s.trim()).filter(Boolean),
          };
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Trusted read-only plugins")
      .setDesc(
        "Plugin ids (one per line) whose published tools may declare themselves read-only and be believed. " +
          "Every other publisher's read-only claim is treated as mutating: queued, journaled, allowlist-scoped, " +
          "and blocked while read-only mode is on. Takes effect on the next session connect."
      )
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.trustedReadOnlyPlugins.join("\n"));
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings.trustedReadOnlyPlugins = value.split("\n").map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Path allowlist")
      .setDesc("Restrict file operations to these vault-relative prefixes (one per line). Leave empty to allow the whole vault.")
      .addTextArea((ta) => {
        ta.setValue(this.plugin.settings.allowlist.join("\n"));
        ta.inputEl.rows = 5;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          this.plugin.settings.allowlist = value.split("\n").map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    // ── Protected frontmatter properties (#224) ───────────────────────────
    // Human-only-mutable declaration list for the generalized accept-guard
    // perimeter. Saving routes through plugin.saveSettings, which re-syncs the
    // core guard registry (normalizing: floor keys / unknown grades dropped
    // loudly) — so edits land live on the next guarded write.
    new Setting(containerEl)
      .setName("Protected frontmatter properties")
      .setDesc(
        "One per line, as `key: grade`. Grade `agent-forbidden`: no agent transport may introduce, change, or " +
          "remove the property (byte-identical carry-forward is allowed). Grade `authority-conferring`: " +
          "additionally, the value only takes effect once the write that set it is human-attributed or accepted " +
          "in review. The accepted family (accepted / accepted-by / accepted-on / acceptance-status: accepted) " +
          "is a hardcoded floor underneath — it is always enforced and cannot be declared, removed, or downgraded " +
          `here. Default: ${formatProtectedPropertyLines(DEFAULT_PROTECTED_PROPERTIES)} (the RETIRED per-note ` +
          "auto-accept policy — it confers nothing since WP10c (appends propose for review like all content), " +
          "but the key stays protected: historical notes carry it, and agents must not toggle it)."
      )
      .addTextArea((ta) => {
        ta.setValue(formatProtectedPropertyLines(this.plugin.settings.protectedProperties));
        ta.inputEl.rows = 3;
        ta.inputEl.style.width = "100%";
        ta.onChange(async (value) => {
          const raw = parseProtectedPropertyLines(value);
          this.plugin.settings.protectedProperties = raw;
          await this.plugin.saveSettings();
          // Surface what actually took effect (normalization may have dropped
          // floor keys or unknown grades) without fighting the user mid-typing.
          const effective = normalizeProtectedProperties(raw, () => {});
          if (effective.length < raw.length) {
            new Notice(
              `vault-mcp: ${raw.length - effective.length} protected-property line(s) ignored ` +
                `(floor keys and unknown grades cannot be declared) — see the console for details.`
            );
          }
        });
      });

    // Record immutability (#264) — the write-perimeter sibling of the
    // protected-property list above: a whole-note rule rather than a per-key
    // one. Default ON; the toggle exists as the escape hatch for the check's
    // deliberate over-inclusiveness (it refuses on any NAMED path).
    new Setting(containerEl)
      .setName("Enforce record immutability")
      .setDesc(
        "Refuse non-append writes to notes identified as records by the setting below — historical, byte-verified " +
          "archives are extended by a dated end-of-file append (obsidian_append_note) and never edited, moved, or " +
          "deleted. Refusals are typed (record_immutable) and journaled. Turn OFF only to unblock a legitimate " +
          "operation the check over-blocks; it refuses on any path a call names, including one it only reads. " +
          "Takes effect immediately."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enforceRecordImmutability).onChange(async (value) => {
          this.plugin.settings.enforceRecordImmutability = value;
          await this.plugin.saveSettings();
        })
      );

    // How a note declares itself a record — the operator's convention, not the
    // plugin's (#397). Same three knobs TaskNotes gives its task identifier.
    // Its own on/off switch (#482).
    new Setting(containerEl)
      .setName("Records by note marker")
      .setDesc(
        "A note is a record when it carries the marker below. Off: no note is a record by its marker, for the write " +
          "check, the moves and heading renames alike. Applies immediately."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.recordIdentification.enabled !== false).onChange(async (value) => {
          this.plugin.settings.recordIdentification.enabled = value;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Record identifier")
      .setDesc("How a note marks itself as a record. By a frontmatter property with a value, or by a tag. Applies immediately.")
      .addDropdown((d) =>
        d
          .addOptions({ property: "Frontmatter property", tag: "Tag" })
          .setValue(this.plugin.settings.recordIdentification.method)
          .onChange(async (v) => {
            this.plugin.settings.recordIdentification.method = v === "tag" ? "tag" : "property";
            await this.plugin.saveSettings();
            this.display();
          })
      );
    if (this.plugin.settings.recordIdentification.method === "tag") {
      new Setting(containerEl)
        .setName("Record tag")
        .setDesc("Without the #. Frontmatter tags and inline tags both count.")
        .addText((t) =>
          t.setValue(this.plugin.settings.recordIdentification.tag).onChange(async (v) => {
            const tag = v.trim().replace(/^#/, "");
            if (!tag) return; // a blank identifier would mark nothing; leave the last good one
            this.plugin.settings.recordIdentification.tag = tag;
            await this.plugin.saveSettings();
          })
        );
    } else {
      new Setting(containerEl)
        .setName("Record property")
        .setDesc("The frontmatter key, and the value it must hold. The default is record: true.")
        .addText((t) =>
          t.setPlaceholder("record").setValue(this.plugin.settings.recordIdentification.property).onChange(async (v) => {
            const p = v.trim();
            if (!p) return;
            this.plugin.settings.recordIdentification.property = p;
            await this.plugin.saveSettings();
          })
        )
        .addText((t) =>
          t.setPlaceholder("true").setValue(this.plugin.settings.recordIdentification.value).onChange(async (v) => {
            const val = v.trim();
            if (!val) return;
            this.plugin.settings.recordIdentification.value = val;
            await this.plugin.saveSettings();
          })
        );
    }

    // The folder indicator (#482, Nelson 2026-10-02): which folders hold records.
    // Used by the moves (a move never rewrites a link inside a record); the write
    // check above judges by the note marker only. The archive pattern also tells
    // the bracket rule which folders are archives.
    new Setting(containerEl)
      .setName("Records by folder")
      .setDesc(
        "A note under one of the record folders below, or under a folder whose name matches the archive pattern, is a " +
          "record for moves: a move leaves its links as written. A folder's own index note is not a record. Off: no " +
          "note is a record by its folder. Applies immediately."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.recordFolders.enabled).onChange(async (value) => {
          this.plugin.settings.recordFolders.enabled = value;
          await this.plugin.saveSettings();
          this.display(); // the archive pattern's status line follows the switch
        })
      );
    // Both fields save when the field is left (the "change" event: blur or Enter),
    // never on each keystroke, so a half-typed path or pattern is never live.
    new Setting(containerEl)
      .setName("Record folders")
      .setDesc("One vault folder path per line. Every note under it is a record. Saved when you leave the field.")
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.recordFolders.folders.join("\n"));
        const commit = async () => {
          const folders = t
            .getValue()
            .split("\n")
            .map((f) => f.trim().replace(/^\/+|\/+$/g, ""))
            .filter(Boolean);
          if (folders.join("\n") === this.plugin.settings.recordFolders.folders.join("\n")) return;
          this.plugin.settings.recordFolders.folders = folders;
          await this.plugin.saveSettings();
        };
        t.inputEl.addEventListener("change", () => void commit());
        this.recordFieldCommits.push(commit);
      });
    const patternStatus = (v: string): string =>
      !this.plugin.settings.recordFolders.enabled
        ? "Not in force: Records by folder is off."
        : !v.trim()
          ? "Empty: no folder is an archive."
          : archivePatternRegExp(v)
            ? "In force."
            : "This pattern does not compile, so it matches nothing: no folder is an archive until you fix it.";
    const patternSetting = new Setting(containerEl).setName("Archive folder pattern");
    const patternDesc = (v: string) =>
      patternSetting.setDesc(
        "A regular expression matched against each folder NAME on a note's path; a match makes that folder an " +
          "archive (a record folder, and an archive for the bracket rule). Saved when you leave the field. " +
          patternStatus(v)
      );
    patternDesc(this.plugin.settings.recordFolders.archivePattern);
    patternSetting.addText((t) => {
      t.setValue(this.plugin.settings.recordFolders.archivePattern);
      const commit = async () => {
        // Saved as written: a pattern that does not compile matches nothing (archivePatternRegExp),
        // so a typo can never widen what counts as an archive or a record.
        const v = t.getValue();
        if (v === this.plugin.settings.recordFolders.archivePattern) return;
        this.plugin.settings.recordFolders.archivePattern = v;
        await this.plugin.saveSettings();
        patternDesc(v);
      };
      t.inputEl.addEventListener("change", () => void commit());
      this.recordFieldCommits.push(commit);
    });

    // ── Sync guard (01.43, Nelson's pick A of 2026-10-12) ─────────────────────
    // Before a write, wait for this Mac's Obsidian Sync; then refuse a rename,
    // move, delete or create that is still behind, and warn on an edit or
    // append. kernel/sync-guard.ts holds the rule; these four keys drive it.
    containerEl.createEl("h4", { text: "Sync guard" });
    const sg = this.plugin.settings.syncGuard;
    new Setting(containerEl)
      .setName("Check Obsidian Sync before a write")
      .setDesc(
        "On: before an agent's write, vault-mcp waits for this Mac's Obsidian Sync to say Fully synced. A rename, move, delete " +
          "or create that is still behind after the wait is handled as the mode below says; an edit or append goes on with a " +
          "warning. It checks only this Mac: it cannot know what another device has pulled. Off: no check. Applies immediately."
      )
      .addToggle((t) =>
        t.setValue(sg.enabled).onChange(async (value) => {
          this.plugin.settings.syncGuard.enabled = value;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("When a rename, move, delete or create finds Sync behind")
      .setDesc("Refuse: wait, then refuse (nothing written). Wait: wait, then go on with a warning. Warn: do not wait, only warn.")
      .addDropdown((d) =>
        d
          .addOptions({ refuse: "Refuse", wait: "Wait", warn: "Warn" })
          .setValue(sg.mode)
          .onChange(async (v) => {
            this.plugin.settings.syncGuard.mode = v === "wait" || v === "warn" ? v : "refuse";
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("Wait for Fully synced (seconds)")
      .setDesc(`How long a write waits for Sync before the rule above applies. 0 to ${MAX_WAIT_SECONDS}. Saved when you leave the field.`)
      .addText((t) => {
        t.setValue(String(sg.waitSeconds));
        t.inputEl.addEventListener("change", async () => {
          const raw = t.getValue().trim();
          const n = Number(raw);
          if (raw === "" || !Number.isFinite(n)) {
            t.setValue(String(this.plugin.settings.syncGuard.waitSeconds));
            return;
          }
          this.plugin.settings.syncGuard.waitSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, n));
          t.setValue(String(this.plugin.settings.syncGuard.waitSeconds));
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("When Sync cannot be read")
      .setDesc(
        "The Sync state comes from an internal Obsidian API that an update can change. Warn: the write goes on with a warning. " +
          "Refuse: the write is refused. When the Sync plugin is off in this vault, the guard does nothing."
      )
      .addDropdown((d) =>
        d
          .addOptions({ warn: "Warn", refuse: "Refuse" })
          .setValue(sg.onUnknown)
          .onChange(async (v) => {
            this.plugin.settings.syncGuard.onUnknown = v === "refuse" ? "refuse" : "warn";
            await this.plugin.saveSettings();
          })
      );

    // ── observation capture ─────────────────────────────────────────────────
    //
    // DEFAULT OFF, and the copy says plainly what turning it on does. Capturing
    // note bodies writes vault content outside the vault; a user should be able
    // to decide that from the toggle's own description without reading a doc.
    new Setting(containerEl)
      .setName("Record what agents were shown")
      .setDesc(
        "Off by default. When on, Vault MCP keeps the exact text it returns from a note read, so you can later see what an agent was actually shown rather than what it says it saw. " +
          "The text is stored outside your vault, at ~/.claude/vault-mcp/observations/, and is never synced. " +
          "Only tools with a reviewed contract are recorded — today that is reading a note. Nothing is deleted automatically yet, so recording stops at the size limit below."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.captureObservations === true).onChange(async (value) => {
          // Refuse to turn ON while no territory is configured (#397). With an
          // empty list capture would retain ANY note it was shown, legal
          // material included, and there is no built-in list to catch that any
          // more. The runtime gate in server.ts (`captureAllowed`) enforces the
          // same predicate; this is the version that explains itself.
          if (value && !hasGuardedTerritory(this.plugin.settings)) {
            new Notice("Recording stays off: add at least one guarded territory below first, so nothing is ever kept from the areas that must not leave the vault.", 8000);
            t.setValue(false);
            return;
          }
          this.plugin.settings.captureObservations = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Recording size limit (MB)")
      .setDesc(
        "How much recorded text to keep before Vault MCP stops adding more. It stops and says so rather than filling the disk. Deleting old recordings is not automatic yet."
      )
      .addText((t) =>
        t
          .setPlaceholder("50")
          .setValue(String(Math.round((this.plugin.settings.captureMaxBytes ?? 50 * 1024 * 1024) / (1024 * 1024))))
          .onChange(async (value) => {
            const mb = Number(value);
            // A blank or nonsense value leaves the setting alone rather than
            // becoming zero — a zero limit would silently disable a feature the
            // user just switched on.
            if (!Number.isFinite(mb) || mb <= 0) return;
            this.plugin.settings.captureMaxBytes = Math.round(mb * 1024 * 1024);
            await this.plugin.saveSettings();
          })
      );

    // Sits beside the capture settings on purpose: capture is the consumer that
    // makes this list matter, because it is the one that writes note bodies out
    // of the vault. The conformance/adopt-baseline rail reads the same list,
    // and so does the Governor plugin when it is installed (#397) — its own
    // settings tab shows this list read-only and points here, so there is one
    // list with one editor rather than two that can disagree.
    new Setting(containerEl)
      .setName("Areas never to copy out of the vault")
      .setDesc(
        "One folder per line. An entry covers its folder and everything under it, and every folder whose name begins with the entry and then breaks (80-89 covers 80-89 Sensitive); end an entry with / to mean exactly that folder. Nothing here is ever recorded by the setting above, walked by the conformance check, or reviewed by Governor — for archival or legally sensitive areas, not live notes. " +
          "EMPTY MEANS NOTHING IS GUARDED, and recording cannot be switched on while it is empty. There is no built-in list: what belongs here is your vault's business, not the plugin's. " +
          "Reading these notes still works; this only stops copies being kept outside the vault."
      )
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t
          .setPlaceholder("e.g.\nArchive/\n80-89 Sensitive/")
          // Shows the list IN FORCE (resolved: trimmed, blanks dropped), which
          // is the raw setting cleaned up — there is no built-in list behind it
          // (#397), so a blank setting renders an empty box, and the description
          // above says exactly what that means: nothing guarded, recording off.
          .setValue(resolveTerritories(this.plugin.settings.guardedTerritories).join("\n"));
        // Committed on BLUR, not per keystroke: saving mid-edit walks through
        // states like ["P"] — a list of one meaningless prefix, under which the
        // folder being typed is NOT yet guarded — and a concurrent MCP read of
        // a guarded note during those few seconds would be retained to disk.
        // Waiting for the field to lose focus means the value saved is one a
        // human finished typing.
        t.inputEl.addEventListener("blur", () => {
          // Trim and drop blanks BEFORE saving: a trailing newline would
          // otherwise persist an empty prefix, and `"".startsWith` is true for
          // every path — one stray blank line would guard the entire vault and
          // silently stop all capture. Storing [] for "nothing configured"
          // keeps the blank-means-EMPTY rule in one place (core's
          // resolveTerritories), not two.
          this.plugin.settings.guardedTerritories = t.inputEl.value
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean);
          void this.plugin.saveSettings();
        });
      });

    // ── the LOCAL HISTORY settings block used to be here (WP4, D10) ─────────
    //
    // "Record vault history", the whole-vault/explicit scope dropdown and the
    // two root textareas moved to the governance provider at the host/provider
    // split (S3c), with the settings they wrote. They were always the
    // provider's facts — the Git history store is the standing chain's
    // evidence, and D10's "recording is a disclosed human decision" is a
    // decision about governance, not about transport — and nothing host-side
    // ever read them. The repository itself did not move: it stays at
    // `~/.claude/governor/history/<vault-slug>/`, because the provider kept the
    // id `governor`.
    //
    // Developer affordances. The tool-runner defaults ON because it grants no
    // capability beyond the MCP surface itself: it invokes the same guarded
    // captured tools a code-mode connection gets (read-only mode, allowlist,
    // queue, journal and the accept guard all bind identically), so hiding it
    // is a UI-tidiness choice, not a security boundary.
    containerEl.createEl("h4", { text: "Developer" });
    new Setting(containerEl)
      .setName("In-app tool runner")
      .setDesc(
        'Enable the "Run tool…" command: pick any MCP tool, fill its arguments in a form, and see the result in a ' +
          "modal. Runs go through the exact guarded pipeline an agent call takes (and are journaled as " +
          "client: tool-runner). Takes effect immediately."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.devToolRunner).onChange(async (value) => {
          this.plugin.settings.devToolRunner = value;
          await this.plugin.saveSettings();
        })
      );
  }

  // ── #81: the generic, manifest-driven module renderer ──────────────────
  //
  // One `<h4>` section per registered module, built from `HostedModule`
  // (kernel/modules/config-host.ts's `collect`) — no per-module bespoke UI
  // code anywhere below. A module with no `manifest.config` (acceptance
  // today) still renders its section in full: enabled toggle, summary,
  // capability directory — just with zero config fields, never skipped and
  // never a crash.

  /** The live module list + a throwaway registry used ONLY for `isEnabled`
   * resolution — no `registerAll` runs here, so no live vault/server is
   * needed to render the tab (the `schemeNotes` dep below is an unused
   * stand-in: `builtinModules` closes over it, but nothing in THIS file ever
   * calls a module's `register()`). The `provenanceSource` stand-in that used
   * to sit beside it went with the provenance module at the mutating-tier
   * extraction; it was the only REQUIRED field MountDeps ever had. */
  private moduleList(): VaultModule[] {
    return builtinModules({
      getSettings: () => this.plugin.settings,
      schemeNotes: () => [],
    });
  }

  /** The shared "what a module is" help text, rendered at the top of each
   * module tab's pane. Verbatim the paragraph that headed the former single
   * stacked "Modules" section — preserved (not reworded) now that each module
   * has its own tab; the collective `<h3>Modules</h3>` heading it sat under is
   * dropped because the tab nav now labels each module. */
  private renderModulesIntro(containerEl: HTMLElement): void {
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Each module is a settings-toggleable unit of the plugin's tool surface, with its own config and the " +
        "directory of what it does. Toggling a module off unmounts its whole tool surface on the next session " +
        "connect.",
    });
  }

  private renderModuleSection(containerEl: HTMLElement, mod: VaultModule, hosted: HostedModule): void {
    const section = containerEl.createDiv({ cls: "vault-mcp-module" });
    section.createEl("h4", { text: `${mod.id} (${hosted.posture})` });
    if (hosted.summary) section.createEl("p", { cls: "setting-item-description", text: hosted.summary });

    new Setting(section)
      .setName("Enabled")
      // `scheme`'s Obsidian surface (the Inbox + Drift panes) mounts/unmounts LIVE from this
      // toggle — no reload. A tool-only module's surface mounts per connection, so its toggle
      // takes effect on the next session connect.
      .setDesc(
        mod.id === "scheme"
          ? "Mounts or unmounts the Inbox and Drift panes live — no plugin reload needed."
          : "Takes effect on the next session connect."
      )
      .addToggle((t) =>
        t.setValue(hosted.enabled).onChange(async (value) => {
          this.plugin.settings.modules = {
            ...this.plugin.settings.modules,
            [mod.id]: { ...this.plugin.settings.modules[mod.id], enabled: value },
          };
          await this.plugin.saveSettings();
          // Let modules whose in-app surface follows this toggle mount/unmount live. Tool-only
          // modules are unaffected — they take effect on the next connect.
          await this.plugin.onModuleEnabledChanged(mod.id, value);
        })
      );

    // Config validation problems (generalizes the old JD-specific
    // jdWarningEl to every module): cleared when the current merged config
    // is valid, listing every `manifest.config.validate` finding otherwise.
    // Saving proceeds unconditionally — config-not-hardwired means the user
    // rules, but they must SEE the consequence.
    const problemsEl = section.createEl("p", { cls: "mod-warning" });
    const renderProblems = (problems: string[]) => problemsEl.setText(problems.length === 0 ? "" : problems.join(" "));
    renderProblems(hosted.problems);

    for (const field of hosted.fields) {
      this.renderConfigField(section, mod, field, renderProblems);
    }

    // TWO bespoke branches used to hang here and both are gone. The vocab
    // module's LIST-shaped per-instance form left with the module at S7.
    // Acceptance's `renderGovernanceSettings` — which handed a container to a
    // render function that built its gesture-gated adopt-baseline and
    // auto-accept controls from its own module-private accept-capable
    // controller — left at the host/provider split (S3c), and so did the
    // reason it had to be shaped that way: this settings tab never received,
    // held, or could walk the accept-capable deps, and now it is not even in
    // the same plugin as them. The renderer is fully generic again.

    const dir = hosted.directory;
    if (dir.tools.length > 0) {
      section.createEl("h5", { text: "Tools" });
      const list = section.createEl("ul");
      for (const tool of dir.tools) {
        const li = list.createEl("li");
        li.createEl("strong", { text: tool.name });
        li.appendText(` — ${tool.purpose}${tool.readOnly ? " (read-only)" : ""}`);
        for (const c of tool.caveats ?? []) {
          const cave = li.createEl("div", { cls: "setting-item-description" });
          cave.setText(c);
        }
      }
    }
    for (const [label, docs] of [
      ["Address forms", dir.addressForms],
      ["Rule packs", dir.rulePacks],
      ["Kernel args", dir.kernelArgs],
    ] as const) {
      if (docs.length === 0) continue;
      section.createEl("h5", { text: label });
      const list = section.createEl("ul");
      for (const d of docs) {
        const li = list.createEl("li");
        li.createEl("strong", { text: d.name });
        li.appendText(` — ${d.purpose}`);
      }
    }
  }

  // ── the vocab module's bespoke per-instance form USED TO BE HERE ────────
  //
  // It rendered `settings.vocabularies` as an editable list — id / provider /
  // root / config per row, plus add and remove — and it was appended to the
  // vocab module's generated settings section. That section is gone (the
  // module left for the `vaultmcp-vocab` satellite at S7), so the form was
  // unreachable; it now lives in that plugin's own settings tab, over that
  // plugin's own copy of the list. Moved, not copied.

  private renderConfigField(
    section: HTMLElement,
    mod: VaultModule,
    field: HostedField,
    renderProblems: (problems: string[]) => void
  ): void {
    const setting = new Setting(section).setName(field.label);
    if (field.help) setting.setDesc(field.help);

    const commit = async (patch: Record<string, unknown>) => {
      await this.saveModuleField(mod, patch);
      renderProblems(this.moduleProblems(mod));
    };

    switch (field.type) {
      case "toggle":
        setting.addToggle((t) => t.setValue(Boolean(field.value)).onChange((value) => commit({ [field.key]: value })));
        break;
      case "select":
        setting.addDropdown((d) => {
          for (const opt of field.options ?? []) d.addOption(opt, opt);
          // Only call setValue for a value that's actually one of the
          // options — never fabricate a "selected" first option for an
          // unset/unrecognized value. A no-op setValue would visually
          // suggest that option is the saved value when nothing was ever
          // committed; leaving the dropdown at its native default (the
          // browser's own "first option" rendering) doesn't claim that.
          if (typeof field.value === "string" && field.options?.includes(field.value)) {
            d.setValue(field.value);
          }
          d.onChange((value) => commit({ [field.key]: value }));
        });
        break;
      case "number": {
        // Loud refusal (the task's own constraint): an unparseable entry is
        // reported inline and NEVER saved — the previous good value (or
        // "unset") survives untouched, rather than silently coercing to
        // undefined the way the old parseFloorField/floorFieldProblem pair
        // did (it saved `undefined` AND showed a footnote; this refuses the
        // save outright).
        const fieldProblemEl = section.createEl("p", { cls: "mod-warning" });
        setting.addText((t) => {
          t.setValue(field.value === undefined || field.value === null ? "" : String(field.value));
          if (field.placeholder) t.setPlaceholder(field.placeholder);
          t.onChange(async (value) => {
            const problem = numberFieldProblem(field.label, value);
            fieldProblemEl.setText(problem ?? "");
            if (problem) return;
            await commit({ [field.key]: parseNumberField(value) });
          });
        });
        break;
      }
      case "csv":
        setting.addText((t) => {
          t.setValue(Array.isArray(field.value) ? (field.value as string[]).join(", ") : "");
          if (field.placeholder) t.setPlaceholder(field.placeholder);
          t.onChange((value) => commit({ [field.key]: parseCommaList(value) }));
        });
        break;
      case "lines":
        setting.addTextArea((t) => {
          t.setValue(Array.isArray(field.value) ? (field.value as string[]).join("\n") : "");
          t.inputEl.rows = 3;
          t.onChange((value) => commit({ [field.key]: parseLineList(value) }));
        });
        break;
      case "text":
      default:
        setting.addText((t) => {
          t.setValue(typeof field.value === "string" ? field.value : "");
          if (field.placeholder) t.setPlaceholder(field.placeholder);
          t.onChange((value) => commit({ [field.key]: value === "" ? undefined : value }));
        });
        break;
    }

    if (field.caveats?.length) {
      const ul = section.createEl("ul", { cls: "setting-item-description" });
      for (const c of field.caveats) ul.createEl("li", { text: c });
    }
  }

  /** Persist `patch` for `mod`: through its `configBinding` when it has one
   * (scheme — writes into `settings.schemes[0]`, never `modules.<id>.config`),
   * else the plain `modules.<id>.config` patch every future module gets by
   * default. Delete-on-undefined either way, matching every textarea
   * field's "blank means use the default" convention. */
  private async saveModuleField(mod: VaultModule, patch: Record<string, unknown>): Promise<void> {
    if (mod.configBinding) {
      this.plugin.settings = mod.configBinding.write(this.plugin.settings, patch) as typeof this.plugin.settings;
    } else {
      const existing = this.plugin.settings.modules[mod.id]?.config ?? {};
      const nextConfig: Record<string, unknown> = { ...existing };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete nextConfig[k];
        else nextConfig[k] = v;
      }
      this.plugin.settings.modules = {
        ...this.plugin.settings.modules,
        [mod.id]: { ...this.plugin.settings.modules[mod.id], config: nextConfig },
      };
    }
    await this.plugin.saveSettings();
  }

  /** `mod`'s CURRENT merged config (post-save), re-derived the same way
   * `collect` does for a single module, so a field's problems element can
   * be refreshed in place without a full `display()` re-render (which would
   * lose focus/cursor position mid-edit). */
  private currentModuleConfig(mod: VaultModule): Record<string, unknown> {
    if (mod.configBinding) {
      return mergeModuleConfig(mod.manifest?.config?.defaults, mod.configBinding.read(this.plugin.settings));
    }
    const registry = new ModuleRegistry([mod], this.plugin.settings.modules);
    return registry.configFor(mod.id);
  }

  private moduleProblems(mod: VaultModule): string[] {
    return safeValidate(mod.manifest?.config?.validate, this.currentModuleConfig(mod));
  }
}
