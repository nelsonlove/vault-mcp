// settings-tab.ts — the plugin's own settings tab.
//
// While the vocabulary surface was a capability module inside the Vault MCP
// host, its configuration was NOT rendered by the host's generic,
// manifest-driven config tab (which only knows scalars): it was a BESPOKE
// per-instance form in the host's connection-ui.ts, because the setting is a
// LIST of `{id, provider, root, config}` rows. That form is ported here, split
// the way this repo splits every satellite tab — the pure parse / coerce /
// validate / mutate helpers live in settings.ts and are headless-tested, and
// this file is only the DOM.
//
// Validation is LOUD, never coercing: `validateVocabInstances` reports a blank
// id, a duplicate id, an unknown provider and a whitespace-only root under the
// list rather than silently repairing them, so the user sees exactly what the
// runtime will skip. A config textarea that does not parse as a JSON object is
// refused in place and the previous good config survives.

import { PluginSettingTab, Setting, type App } from "obsidian";
import { VOCAB_PROVIDERS, isVocabProvider, type VocabInstanceSettings } from "@vault-mcp/core";
import {
  addVocabInstance,
  coerceVocabInstances,
  parseVocabConfig,
  removeVocabInstanceAt,
  stringifyVocabConfig,
  updateVocabInstanceAt,
  validateVocabInstances,
} from "./settings.js";

/** What the tab needs from the plugin — kept structural so the tab never
 *  imports main.ts (and main.ts's import of the tab stays one-directional). */
export interface VocabSettingsHost {
  getVocabularies(): VocabInstanceSettings[];
  setVocabularies(next: VocabInstanceSettings[]): Promise<void>;
}

export class VocabSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: VocabSettingsHost, pluginRef: import("obsidian").Plugin) {
    super(app, pluginRef);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Each row is a controlled-vocabulary source the four vaultmcp_vocab_* tools read. A row with a blank id, an " +
        "unknown provider, or a duplicate id is skipped at runtime (the warnings below say which). With no rows " +
        "configured the built-in defaults apply.",
    });

    const listEl = containerEl.createDiv({ cls: "vaultmcp-vocab-list" });
    const problemsEl = containerEl.createEl("p", { cls: "mod-warning" });

    const current = (): VocabInstanceSettings[] => coerceVocabInstances(this.host.getVocabularies());
    const renderProblems = (): void => {
      const problems = validateVocabInstances(current());
      problemsEl.setText(problems.length === 0 ? "" : problems.join(" "));
    };
    const paint = (): void => {
      listEl.empty();
      const instances = current();
      if (instances.length === 0) {
        listEl.createDiv({
          cls: "setting-item-description",
          text: "No vocabulary instances configured — the tools fall back to the built-in defaults. Add one below to override.",
        });
      }
      instances.forEach((inst, index) => this.renderRow(listEl, inst, index, current, renderProblems, paint));
      renderProblems();
    };

    paint();

    new Setting(containerEl)
      .setName("Add vocabulary instance")
      .setDesc("Append a new, blank vocabulary source to configure.")
      .addButton((b) =>
        b.setButtonText("Add instance").setCta().onClick(async () => {
          await this.host.setVocabularies(addVocabInstance(current()));
          paint();
        }),
      );

    this.renderStatus(containerEl);
  }

  private renderRow(
    listEl: HTMLElement,
    inst: VocabInstanceSettings,
    index: number,
    current: () => VocabInstanceSettings[],
    renderProblems: () => void,
    paint: () => void,
  ): void {
    const row = listEl.createDiv({ cls: "vaultmcp-vocab-instance" });
    row.createEl("h6", { text: `Instance ${index + 1}${inst.id ? `: ${inst.id}` : ""}` });

    // Field edits patch just this instance and re-derive the warning list in
    // place — no full repaint, so typing keeps focus. Add/remove DO repaint
    // (a button click, not mid-edit).
    const commit = async (patch: Partial<VocabInstanceSettings>): Promise<void> => {
      await this.host.setVocabularies(updateVocabInstanceAt(current(), index, patch));
      renderProblems();
    };

    new Setting(row)
      .setName("Id")
      .setDesc("Unique identifier for this source (shown by vaultmcp_vocab_vocabularies). Required.")
      .addText((t) => {
        t.setValue(inst.id);
        t.onChange((value) => void commit({ id: value }));
      });

    new Setting(row)
      .setName("Provider")
      .setDesc(
        "scope-tags = the ## Tags tables on scope notes, unioned up the scope chain (the live model); " +
          "blueprint = the legacy registry grammar (tags / properties / types); " +
          "glossary = Topic/Term notes and ## Terms definitions.",
      )
      .addDropdown((d) => {
        for (const p of VOCAB_PROVIDERS) d.addOption(p, p);
        // Only preselect a recognized provider — an unknown (hand-edited) value
        // leaves the dropdown at its native default rather than fabricating a
        // selection.
        if (isVocabProvider(inst.provider)) d.setValue(inst.provider);
        d.onChange((value) => void commit({ provider: value }));
      });

    new Setting(row)
      .setName("Root")
      .setDesc("Vault-relative path prefix this vocabulary reads from. Blank = the whole vault.")
      .addText((t) => {
        t.setValue(inst.root);
        t.onChange((value) => void commit({ root: value }));
      });

    const configProblemEl = row.createEl("p", { cls: "mod-warning" });
    new Setting(row)
      .setName("Config (JSON)")
      .setDesc('Provider-specific options as a JSON object, e.g. {"termsRoot": "00-09 System"}. Blank = none.')
      .addTextArea((t) => {
        t.setValue(stringifyVocabConfig(inst.config));
        t.inputEl.rows = 3;
        t.inputEl.style.width = "100%";
        t.onChange(async (value) => {
          const parsed = parseVocabConfig(value);
          // Loud refusal on unparseable / non-object JSON — the bad value is
          // NOT saved (the previous good config survives).
          if (!parsed.ok) {
            configProblemEl.setText(parsed.error);
            return;
          }
          configProblemEl.setText("");
          await commit({ config: parsed.config });
        });
      });

    new Setting(row).addButton((b) =>
      b.setButtonText("Remove instance").setWarning().onClick(async () => {
        await this.host.setVocabularies(removeVocabInstanceAt(current(), index));
        paint();
      }),
    );
  }

  /** The host status line, and the two things a user cannot guess: the
   *  allowlist posture is PER TOOL rather than uniform, and the host's
   *  conformance report checks vocabulary against the built-in defaults rather
   *  than the list edited here (a host behaviour, not this plugin's). */
  private renderStatus(containerEl: HTMLElement): void {
    // The host is REQUIRED, as it is for the triage and crosssession
    // satellites: this plugin's whole surface is the four published tools —
    // there is no pane, no command, no ribbon.
    // The host is the Vault MCP plugin (id `vault-mcp`; `governor` was its id
    // from 0.12.0 to the suite split, and is now the separate acceptance
    // plugin's id). Only the host exposes the plugin-to-plugin `api` object, so
    // a plugin counts as the host only if it has one — the same lookup
    // jd-scaffold's settings tab uses.
    const loadedPlugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: unknown } | undefined> };
    }).plugins?.plugins;
    const hostLoaded = ["vault-mcp", "governor"].some((id) => !!loadedPlugins?.[id]?.api);

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: hostLoaded
        ? "The Vault MCP host is installed: the vaultmcp_vocab_vocabularies, _resolve_term, _validate_terms and _list_vocabulary " +
          "MCP tools are published to it. Under an active Vault MCP path allowlist the posture is PER TOOL, not " +
          "uniform: _validate_terms stays available and is scoped on its `path` argument; _resolve_term is scoped " +
          "when called with `path` and blocked when called with `token`; _vocabularies and _list_vocabulary are " +
          "blocked outright, because neither carries a path argument the host can scope by."
        : "The Vault MCP host is NOT installed. This plugin's entire surface is the four MCP tools it publishes to that host, " +
          "so nothing here does anything until Vault MCP (plugin id `vault-mcp`) is installed and enabled. " +
          "(Governor, the acceptance plugin, is a separate, optional plugin and is not the host — installing it alone does not make these tools reachable.)",
    });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "This list moved here from the Vault MCP host (then named Governor). On first load this plugin copied the host's `vocabularies` setting once " +
        "and has owned it ever since — the host no longer reads that setting, and its editor for it is gone. " +
        "The host still stores the old value on purpose, as the thing this plugin adopted from, so nothing is lost " +
        "if you reinstall. Edit the list here.",
    });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "One caveat that is the host's, not this plugin's: the Vault MCP host's conformance report checks vocabulary using the " +
        "BUILT-IN defaults, not the list configured here (it has always worked that way). So in a vault with a " +
        "customised vocabulary, the conformance report and these tools can disagree about which tags, properties or " +
        "types are registered.",
    });
  }
}
