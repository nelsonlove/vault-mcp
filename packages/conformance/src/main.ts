// VAULT MCP CONFORMANCE — the conformance rail as its own Obsidian plugin.
//
// The rail runs the rule packs over the vault, compares the findings with the
// accepted-debt baseline, and reports what is carried, cleared and new. It
// lived in the Vault MCP host until 2026-10-14 (Nelson: "the conformance and
// scheme features still in core (i see em on the settings pages) need to be
// split out into satellites"; conformance was always planned as one, suite-split
// design §6). The scheme surface stays in the host by the 2026-09-05 ruling.
//
// Surface:
//
//   vaultmcp_conformance_debt        — the read-only debt report (MCP tool);
//   vaultmcp_conformance_debt_render — renders the debt register note (MCP tool,
//                                      mutating);
//   the Drift pane                   — the scheme pack's NEW findings, a
//                                      sidebar view with a ribbon icon and a
//                                      command (moved from the host's scheme
//                                      pane wiring);
//   the settings tab                 — the vault conventions (the host's former
//                                      Conformance tab) and the debt config;
//   the CLI                          — src/kernel/main.ts, run with
//                                      `node --import tsx` (not bundled).
//
// Consequences of the move, each deliberate:
//
//   * THE TOOL NAMES CHANGED — `obsidian_conformance_debt` →
//     `vaultmcp_conformance_debt`, `obsidian_conformance_debt_render` →
//     `vaultmcp_conformance_debt_render`. The plugin id is the tool namespace.
//   * THE ALLOWLIST BOUNDARY MOVED TO THE HOST, and closes harder: neither tool
//     carries a path key, so under an active path allowlist the host refuses
//     both outright (tools.ts). That takes the last tool off issue #381's list.
//   * THE SETTINGS MOVED HERE, adopted once from the host's data.json
//     (settings.ts); the host's copy is never written.
//   * THE GUARDED TERRITORIES STAY THE HOST'S, read per run through
//     `api.guardedTerritories()`. With no host (or an old one) the rail
//     REFUSES rather than walking the vault unguarded (host-lookup.ts).
//
// RE-PUBLISHING ON CONFIG CHANGE, as in the other satellites: the host
// snapshots a published spec when it registers it, so the tools are disposed
// and re-published on every settings write.

import { Plugin, Notice, type WorkspaceLeaf } from "obsidian";
import { publishTools } from "vault-mcp-api";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildConformanceTools } from "./tools.js";
import { obsidianDebtRenderSource } from "./obsidian-debt-source.js";
import { obsidianDriftSource } from "./obsidian-drift-source.js";
import { DRIFT_VIEW_TYPE, DriftPaneView, type DriftPaneController } from "./drift-pane.js";
import { ConformanceSettingTab } from "./settings-tab.js";
import { conventionsNow, runAdoption, settingsOf, DEFAULT_PLUGIN_SETTINGS, type ConformancePluginSettings } from "./settings.js";
import { declaredHeadless, findHostPlugin, hostSettingsOf, territoriesOrRefuse, type PluginsMap } from "./host-lookup.js";

export default class VaultConformancePlugin extends Plugin {
  settings: ConformancePluginSettings = { ...DEFAULT_PLUGIN_SETTINGS, config: {} };

  /** The live `publishTools` disposer, or null when nothing is published. */
  private unpublish: (() => void) | null = null;

  /** The loaded plugins map, read fresh each time (plugins come and go). */
  private plugins(): PluginsMap {
    return (this.app as unknown as { plugins?: { plugins?: PluginsMap } }).plugins?.plugins;
  }

  /** The vault's on-disk root, or "" when the adapter has none. */
  private vaultRoot(): string {
    const adapter = this.app.vault.adapter as unknown as { basePath?: string; getBasePath?: () => string };
    return adapter.basePath ?? adapter.getBasePath?.() ?? "";
  }

  /** "Is this vault-relative note on disk" — the #493 baseline seed's question. */
  private exists = (rel: string): boolean => {
    const root = this.vaultRoot();
    return root !== "" && existsSync(join(root, rel));
  };

  async onload(): Promise<void> {
    const loaded = settingsOf(await this.loadData(), process.env, this.exists);
    this.settings = loaded.settings;
    if (loaded.persist) {
      try { await this.saveData(this.settings); }
      catch (e) { console.error("[vaultmcp-conformance] could not persist the seeded baseline path", e); }
    }

    await this.adoptFromHostOnce();

    this.addSettingTab(
      new ConformanceSettingTab(
        this.app,
        {
          getConventions: () => this.settings.vaultConventions,
          setConventions: async (next) => {
            this.settings.vaultConventions = next;
            await this.saveData(this.settings);
            this.republish();
          },
          getConfig: () => this.settings.config,
          setConfig: async (key, value) => {
            if (value === undefined) delete this.settings.config[key];
            else this.settings.config[key] = value;
            await this.saveData(this.settings);
            this.republish();
          },
          hostLoaded: () => findHostPlugin(this.plugins()) !== null,
        },
        this,
      ),
    );

    this.register(() => {
      this.unpublish?.();
      this.unpublish = null;
    });
    this.republish();

    // The Drift pane is chrome: skip it where there is no window to show it in.
    // Headless is DECLARED at load by the host's `host.headless` setting or
    // VAULT_MCP_HEADLESS — the host's own rule (host-lookup.ts).
    if (!declaredHeadless(this.plugins())) this.wireDriftPane();
  }

  /** The two thunks every conformance source takes, read per run. */
  private territories = (): readonly string[] => territoriesOrRefuse(this.plugins());
  private conventions = () => conventionsNow(this.settings);

  /** Revoke whatever is published and publish freshly built specs. */
  private republish(): void {
    try {
      this.unpublish?.();
      this.unpublish = null;
      this.unpublish = publishTools(
        this,
        buildConformanceTools(obsidianDebtRenderSource(this.app, this.territories, this.conventions), {
          config: () => this.settings.config,
        }),
      );
    } catch (e) {
      console.error("[vaultmcp-conformance] publishing the tool surface failed", e);
    }
  }

  /** The Drift pane: view, ribbon icon and command, for the plugin's lifetime
   *  (Obsidian unregisters all three when the plugin unloads). */
  private wireDriftPane(): void {
    const source = obsidianDriftSource(this.app, this.territories, this.conventions);
    const controller: DriftPaneController = {
      scan: () => source.scan(),
      openNote: (path) => void this.app.workspace.openLinkText(path, ""),
    };
    this.registerView(DRIFT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DriftPaneView(leaf, controller));
    this.addRibbonIcon("alert-triangle", "Open conformance drift", () => void this.activateDriftView());
    this.addCommand({ id: "open-drift", name: "Open conformance drift", callback: () => void this.activateDriftView() });
  }

  private async activateDriftView(): Promise<void> {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType(DRIFT_VIEW_TYPE);
    if (existing.length > 0) { ws.revealLeaf(existing[0]); return; }
    const leaf = ws.getRightLeaf(false);
    if (!leaf) { new Notice("Vault MCP Conformance: no sidebar is available to open the drift pane in."); return; }
    await leaf.setViewState({ type: DRIFT_VIEW_TYPE, active: true });
    ws.revealLeaf(leaf);
  }

  /** One-shot adoption of the host's `vaultConventions` and
   *  `modules["conformance-debt"].config` (settings.ts). The host's copy is READ
   *  and never written; every failure path holds the latch open. */
  private async adoptFromHostOnce(): Promise<void> {
    if (this.settings.adoptedFromHost) return;
    const { settings, adopted } = await runAdoption(
      this.settings,
      hostSettingsOf(this.plugins()),
      (s) => this.saveData(s),
      process.env,
      this.exists,
    );
    this.settings = settings;
    if (adopted) console.info("[vaultmcp-conformance] adopted the Vault MCP host's conformance settings (one shot; the host's copy is untouched)");
  }
}
