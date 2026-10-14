// settings-tab.ts — the plugin's own settings tab.
//
// Two sections:
//
//   * VAULT CONVENTIONS — moved verbatim from the host's fixed "Conformance"
//     tab (connection-ui.ts `renderConformanceTab`, #403): one field per key
//     from `CONVENTION_FIELDS`, committed on BLUR, so a half-typed path is never
//     what the next debt or drift run measures against. Blank is honest: that
//     convention is dead and the report says so; there is no built-in layout
//     behind an empty box.
//   * DEBT REGISTER — the debt tools' config, `DEBT_FIELDS` (settings.ts). The
//     host had no field for these (a hand edit of
//     `modules["conformance-debt"].config`); a blank box clears the override.
//
// Then one line on the host: the two MCP tools need it; the Drift pane does not
// (but it needs the host's guarded territories, so it refuses without a host).

import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import { CONVENTION_FIELDS, commitConvention } from "./kernel/conventions-policy.js";
import { resolveConventions, type VaultConventions } from "./kernel/vault-conventions.js";
import { DEBT_FIELDS } from "./settings.js";

/** What the tab needs from the plugin — structural, so the tab never imports main.ts. */
export interface ConformanceSettingsHost {
  getConventions(): VaultConventions | undefined;
  setConventions(next: VaultConventions): Promise<void>;
  getConfig(): Record<string, unknown>;
  setConfig(key: string, value: unknown): Promise<void>;
  hostLoaded(): boolean;
}

export class ConformanceSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: ConformanceSettingsHost, pluginRef: Plugin) {
    super(app, pluginRef);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Vault conventions" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Where the conformance rail's legacy checks look. There is no built-in layout: a blank folder path means that convention is DEAD — the checks that read it register, are not measured, and the report says so — until you point it at your vault. The baseline note is different: blank means no baseline, and the debt and drift views refuse until you name it. The in-app debt and drift views read these live. The standalone CLI reads VAULT_MCP_CONVENTIONS; for the baseline it reads GOVERNOR_BASELINE_REL first, then VAULT_MCP_CONVENTIONS, then this setting.",
    });
    for (const field of CONVENTION_FIELDS) {
      const current = resolveConventions(this.host.getConventions())[field.key];
      const shown = Array.isArray(current) ? current.join("\n") : current;
      const commit = (raw: string) => {
        void this.host.setConventions(commitConvention(this.host.getConventions(), field, raw));
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

    containerEl.createEl("h3", { text: "Debt register" });
    const config = this.host.getConfig();
    for (const field of DEBT_FIELDS) {
      const setting = new Setting(containerEl).setName(field.label).setDesc(field.help);
      if (field.type === "toggle") {
        setting.addToggle((t) =>
          t.setValue(config[field.key] === true).onChange((v) => void this.host.setConfig(field.key, v ? true : undefined)),
        );
        continue;
      }
      const value = config[field.key];
      setting.addText((t) => {
        t.setValue(value === undefined ? "" : String(value));
        t.inputEl.addEventListener("blur", () => {
          const raw = t.inputEl.value.trim();
          if (raw === "") {
            void this.host.setConfig(field.key, undefined);
            return;
          }
          if (field.type === "number") {
            const n = Number(raw);
            // A non-number is stored as typed: the resolvers ignore it and the default applies, as a hand edit did in the host.
            void this.host.setConfig(field.key, Number.isFinite(n) ? n : raw);
            return;
          }
          void this.host.setConfig(field.key, raw);
        });
      });
    }

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: this.host.hostLoaded()
        ? "The Vault MCP host is installed: the vaultmcp_conformance_debt and vaultmcp_conformance_debt_render MCP tools are published to it. " +
          "Under an active Vault MCP path allowlist the host refuses both — neither takes an argument the host can scope. With no allowlist configured nothing changes."
        : "The Vault MCP host is NOT installed. The two MCP tools this plugin publishes need it (plugin id `vault-mcp`), and the Drift pane refuses to run without it, " +
          "because the rail does not walk the vault without the host's guarded territories.",
    });
  }
}
