// settings-tab.ts — the plugin's own settings tab.
//
// It has NO SETTINGS TO RENDER, and that is correct: the jd-scaffold module
// declared no config block, so there is nothing to configure (see settings.ts).
// The tab ships anyway, and is worth shipping, because a user who installs this
// plugin needs to be told two things they cannot discover any other way:
//
//   1. It does nothing without the Vault MCP host. The plugin's entire surface is
//      the seven MCP tools it publishes — no pane, no palette command, no
//      ribbon. With the host absent it loads and sits there.
//   2. Under an ACTIVE Vault MCP path allowlist, five of the seven are refused
//      outright and the two that name a note are scoped to it (round 2,
//      2026-09-07) — including reindex's ratified sibling-read residual.
//      That is deliberate and fail-closed (no argument here is a path key the
//      host can scope by), but a user watching every call refuse deserves to
//      know it is the posture rather than a bug.

import { PluginSettingTab, type App } from "obsidian";

export class JdScaffoldSettingTab extends PluginSettingTab {
  constructor(app: App, pluginRef: import("obsidian").Plugin) {
    super(app, pluginRef);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // "Is the Vault MCP host loaded?" — the same two-part answer every satellite
    // gives, and this package's only copy of it (jd-scaffold adopts no host
    // settings, so `main.ts` has no lookup at all).
    //
    //   • the ids are CURRENT FIRST: `vault-mcp` is the host again since the
    //     suite split's S3c, and `governor` is the pre-0.12.0-to-S3c host id
    //     which is now the governance PROVIDER's id;
    //   • a plugin counts as the host only if it exposes the plugin-to-plugin
    //     `api` object. This line used to test bare presence of `"governor"`
    //     alone, so on a post-split vault it reported "Governor is installed"
    //     whenever the PROVIDER was enabled — with or without a host to publish
    //     these seven tools to.
    //
    // The suite's one behavioural test of this lookup is
    // `packages/conformance/tests/host-lookup.test.mjs`.
    const loaded = (this.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: unknown } | undefined> };
    }).plugins?.plugins;
    const hostLoaded = ["vault-mcp", "governor"].some((id) => !!loaded?.[id]?.api);

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: hostLoaded
        ? "The Vault MCP host is installed: the vaultmcp_jd_scaffold_standard_zeros, _ensure_category_indexes, _promote_to_folder, _reindex_category, _new_standard_zero, _new_generic_id and _new_stem MCP tools are published to it."
        : "The Vault MCP host is NOT installed. This plugin's entire surface is the seven MCP tools it publishes to that host, so nothing here does anything until Vault MCP is installed and enabled. (Governor, the acceptance plugin, is a separate, optional plugin and is not the host — installing it alone does not make these tools reachable.)",
    });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "There is nothing to configure. This plugin has no settings of its own — every tool takes what it needs (the category folder, the prefix, the templates folder) as a call argument.",
    });

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Under an ACTIVE Vault MCP path allowlist, five of the seven tools are refused outright — they name no note, so the host has nothing to scope them by, and the folders and files they write are computed rather than named. The two that DO name a note (promote to folder, reindex category) name it `note_path`, which the host recognizes as a path, so those two are scoped to that note and its record-immutability guard, lock consult and journal target all see it. One residual, stated plainly: reindex's area and system tiers read every sibling XX.00 index file in the vault, and that read is not scoped by the note argument — so under an allowlist those tiers can fold hidden siblings' names into a visible note. With no allowlist configured all seven behave exactly as before.",
    });
  }
}
