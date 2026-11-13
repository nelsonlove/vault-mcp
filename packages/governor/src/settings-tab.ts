// THE PROVIDER'S OWN SETTINGS TAB.
//
// Every control here used to be rendered by the HOST's settings tab, through the
// module host's generated config section plus one bespoke branch that called
// `renderGovernanceSettings`. That branch existed because the accept-capable
// controller must never be reachable from the code rendering the tab: the host
// handed over a container and nothing else, and the module built its
// gesture-gated controls from its own module-private WeakMap.
//
// That constraint is unchanged and the mechanism is unchanged — `renderGovernanceSettings`
// still builds its own controls from its own private state — but the argument is
// now weaker than it needs to be, and worth saying plainly rather than implying
// it got stronger: this file is in the SAME plugin as the controller. What keeps
// the accept boundary is what always kept it, the module-private WeakMaps in
// `wiring.ts` and `pane.ts`, not the fact that two files sit in different
// bundles.

import { App, PluginSettingTab, Setting, type Plugin } from "obsidian";
import { DEFAULT_ACCEPTANCE_SETTINGS } from "./kernel/settings.js";
import { resolveTerritories } from "@vault-mcp/core";
import { hostGuardedTerritories, findHostPlugin } from "./host-lookup.js";
import { renderGovernanceSettings } from "./wiring/wiring.js";
import type { GovernorSettings } from "./settings.js";

export interface SettingsTabHost extends Plugin {
  settings: GovernorSettings;
  saveSettings(): Promise<void>;
  setPaneMounted(enabled: boolean): Promise<void>;
}

const csv = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : typeof v === "string" ? v : "");

export class GovernorSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SettingsTabHost) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Governor is the governance provider for the Vault MCP host. It reviews what agents write; it does not " +
        "serve them. With the host plugin absent or disabled, nothing here has anything to govern — install and " +
        "enable Vault MCP first.",
    });

    containerEl.createEl("h4", { text: "Guarded territories" });
    new Setting(containerEl)
      .setName("Guarded territories")
      .setDesc(
        "A guarded territory is a top-level area Governor must never review, propose against, " +
          "record into local history, or otherwise retain a copy of — archival or legally " +
          "sensitive folders, not live governed content. Every part of this plugin (the review " +
          "pane, proposals, auto-accept, local history) checks the list before touching a note. " +
          "It is EDITED IN VAULT MCP'S SETTINGS, not here: the same list also governs that " +
          "plugin's observation capture, which writes note bodies outside the vault, and that " +
          "runs whether or not this plugin is installed — so the list belongs to the plugin you " +
          "cannot uninstall (#397). This plugin reads it live; an edit there takes effect here " +
          "with no reload."
      )
      .addExtraButton((b) =>
        b
          .setIcon("settings")
          .setTooltip("Open Vault MCP settings")
          .onClick(() => {
            // The host's OWN id, not a hardcoded one: HOST_PLUGIN_IDS still
            // admits a live pre-split host under the id `governor`, and opening
            // a tab that does not exist is a dead button.
            const app = this.plugin.app as any;
            const hostId = findHostPlugin(app?.plugins?.plugins)?.id;
            if (hostId) app?.setting?.openTabById?.(hostId);
          })
      );
    containerEl.createEl("p", {
      text: (() => {
        const t = territoriesInEffect(this.plugin);
        if (t === null) return "In effect now: cannot tell — Vault MCP is not loaded, or is too old to publish its list. Until it is, Governor governs NOTHING: no proposals, no history, nothing auto-accepted.";
        return t.length ? `In effect now: ${t.join(", ")}` : "In effect now: none — nothing is guarded until Vault MCP has at least one territory configured.";
      })(),
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Review pane")
      .setDesc(
        "Mounts or unmounts the review pane and gavel ribbon live — no plugin reload needed. Off by default: the " +
          "accept surface is opt-in. The read-only governance_pending_review tool is published regardless of this " +
          "toggle, so an agent can always see what is waiting; only a human at the pane can accept."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          await this.plugin.setPaneMounted(value);
          // The mount decides whether the gesture-gated section below can render
          // its live controls or only a hint, so re-render once it has settled.
          this.display();
        })
      );

    containerEl.createEl("h4", { text: "Review pane display" });
    this.toggleField(
      containerEl,
      "showRibbonBadge",
      "Ribbon pending-count badge",
      "Show the pending-review count as a badge on the ribbon icon. Off ⇒ the icon still opens the pane, just " +
        "without the count. Takes effect on the next queue refresh (the badge prefs are read live)."
    );
    this.toggleField(
      containerEl,
      "showViewTabBadge",
      "Pane tab pending-count badge",
      "Show the pending-review count as a badge overlaid on the review pane's tab-header icon. Independent of the " +
        "ribbon badge above."
    );

    containerEl.createEl("h4", { text: "Acceptance" });
    new Setting(containerEl)
      .setName("Accepted-by identity")
      .setDesc(
        "The identity recorded on the baseline and in the acceptance log when the pane's Accept advances a " +
          "baseline. Accept does not write it into the note. Human-set by construction — this settings tab " +
          "is not agent-reachable."
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_ACCEPTANCE_SETTINGS.acceptedBy)
          .setValue(typeof this.plugin.settings.config.acceptedBy === "string" ? (this.plugin.settings.config.acceptedBy as string) : "")
          .onChange(async (value) => {
            this.plugin.settings.config.acceptedBy = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Conformance-gate response")
      .setDesc(
        "How Accept responds when a `proposed` note is missing required frontmatter (below). `soft` (default): a " +
          "modal offers Accept anyway / Open note / Cancel — the override is a second explicit human click. `hard`: " +
          "refuse with a notice. `off`: the gate is not checked at all. Never an agent surface — agents cannot " +
          "reach Accept in any mode."
      )
      .addDropdown((dd) =>
        dd
          .addOption("soft", "soft")
          .addOption("hard", "hard")
          .addOption("off", "off")
          .setValue(typeof this.plugin.settings.config.gateMode === "string" ? (this.plugin.settings.config.gateMode as string) : "soft")
          .onChange(async (value) => {
            this.plugin.settings.config.gateMode = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Required frontmatter for acceptance")
      .setDesc(
        "Optional conformance gate: comma-separated frontmatter keys that must be present and non-empty before a " +
          "`proposed` note can be Accepted. While any listed key is missing, Accept refuses with no partial write " +
          "(no stamp AND no baseline advance). Empty (the default) ⇒ no gate."
      )
      .addText((t) =>
        t
          .setPlaceholder("uid, title, description")
          .setValue(csv(this.plugin.settings.config.requiredFrontmatterKeys))
          .onChange(async (value) => {
            this.plugin.settings.config.requiredFrontmatterKeys = value
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // ── local history (WP4, D10) ───────────────────────────────────────────
    //
    // Moved here from the host's settings tab at the split, with the settings
    // it writes. Git RETAINS historical bytes: once recorded, an edit or a
    // deletion in the vault does not remove what history holds. D10 makes
    // enabling that a disclosed human decision, and makes the scope a human
    // choice separate from any connection allowlist the host enforces.
    containerEl.createEl("h4", { text: "Local history" });
    new Setting(containerEl)
      .setName("Record vault history")
      .setDesc(
        "Off by default. When on, Governor keeps a Git history of your notes at ~/.claude/governor/history/ — " +
          "outside your vault, never synced. History RETAINS old bytes: editing or deleting a note later does not " +
          "remove what was already recorded. Guarded territories are never recorded regardless of the scope below."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.historyEnabled).onChange(async (value) => {
          this.plugin.settings.historyEnabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("History scope")
      .setDesc(
        "Whole vault records everything except the exclusions; explicit roots records only the folders you list " +
          "below. The host's connection allowlists never change this — what one agent may see and what history " +
          "records are different decisions."
      )
      .addDropdown((dd) =>
        dd
          .addOption("whole-vault", "Whole vault (minus exclusions)")
          .addOption("explicit", "Only explicit roots")
          .setValue(this.plugin.settings.historyScope.mode)
          .onChange(async (value) => {
            this.plugin.settings.historyScope.mode = value === "explicit" ? "explicit" : "whole-vault";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Included roots")
      .setDesc("One folder per line. Used only when the scope is explicit. A root names the folder and everything under it.")
      .addTextArea((t) =>
        t
          .setPlaceholder("Notes\nProjects")
          .setValue(this.plugin.settings.historyScope.include.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.historyScope.include = value.split("\n").map((x) => x.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excluded roots")
      .setDesc(
        "One prefix per line, always subtracted in either mode. The defaults (.obsidian, .trash) and the guarded " +
          "territories are always excluded — listing more here narrows history further."
      )
      .addTextArea((t) =>
        t
          .setPlaceholder("Private notes/")
          .setValue(this.plugin.settings.historyScope.exclude.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.historyScope.exclude = value.split("\n").map((x) => x.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // The gesture-gated section: adopt-baseline, the auto-accept allowlist, the
    // migration controls. It builds its own controls from its own private state
    // — this file hands it a container and nothing else.
    renderGovernanceSettings(this.plugin, containerEl);
  }

  private toggleField(containerEl: HTMLElement, key: string, name: string, desc: string): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((t) =>
        t.setValue(this.plugin.settings.config[key] !== false).onChange(async (value) => {
          this.plugin.settings.config[key] = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

/** What the pane will actually guard by right now — the host's configured
 * list, or `null` when the host cannot be asked (#397: no built-in default;
 * `null` fails closed everywhere, see `excludedUnderHost`). Shown rather than
 * an editable field so there is visibly ONE list, not two. */
function territoriesInEffect(plugin: { app: unknown }): readonly string[] | null {
  const hostList = hostGuardedTerritories((plugin.app as any)?.plugins?.plugins);
  return hostList === null ? null : resolveTerritories(hostList);
}
