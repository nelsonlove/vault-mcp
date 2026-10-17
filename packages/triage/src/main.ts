// VAULT TRIAGE — inbox triage as its own Obsidian plugin.
//
// The disposition substrate's second instance (#221, phase-3 shape per #241),
// published to the Vault MCP host through vault-mcp-api as two MCP tools:
//
//   vaultmcp_triage_queue    — the agent's view of a triage queue (read-only in
//                           intent; the host distrusts that claim, see below);
//   vaultmcp_triage_dispose  — the one guarded mutating verb, dry-run by default.
//
// SATELLITE OF THE SUITE (suite-split design §6: "Triage | private operator |
// satellite"). Extracted out of the host at S5, following the
// quickadd-choices-compile pilot and the vaultmcp-skills satellite. Consequences
// of the publishing contract, each deliberate:
//
//   * THE PUBLISHED TOOL NAMES CHANGED — `triage_queue` / `triage_dispose`
//     became `vaultmcp_triage_queue` / `vaultmcp_triage_dispose`. The host publishes
//     an external tool as `<sanitized publisher id>_<bare name>`, so the plugin
//     id IS the tool namespace; `vaultmcp-triage` sanitizes to `vaultmcp_triage`.
//     This is the extraction's one breaking change and it is recorded in
//     CLAUDE.md, not buried here.
//   * THE ALLOWLIST BOUNDARY MOVED TO THE HOST. An external tool's
//     `readOnlyHint: true` is a claim the host distrusts unless the raw
//     publisher id is in its `trustedReadOnlyPlugins` list, so BOTH tools
//     register as mutating; and a mutating external tool whose arguments carry
//     no recognized path key is blocked outright while a path allowlist is
//     active. `queue` carries none, so under an allowlist it is refused
//     wholesale. `dispose` carries `path` — and, since this extraction,
//     `target_path` rather than `target`, so the host's guard checks the
//     destination folder the caller names. See the long note in tools.ts.
//   * REFUSALS THROW; the host renders a thrown error's lowercase-snake `code`
//     as `Error [code]: message`, the envelope the module already produced.
//   * The host's queue, journal and kernel args still apply — external mutating
//     tools ride the guarded registration path like every built-in.
//
// THIS PLUGIN NEEDS THE HOST, which is the opposite of the skills satellite.
// Triage has no pane, no palette command and no ribbon: its entire surface is
// the two published tools. With the host absent it loads, keeps its settings,
// adopts nothing, and does nothing — `publishTools` waits on the host's ready
// event and registers if one appears. The settings tab says so plainly.
//
// RE-PUBLISHING ON CONFIG CHANGE is the one structural difference from the
// skills satellite, and it is not decoration. `vaultmcp_triage_dispose`'s
// `disposition` argument is a zod ENUM over the merged (built-in ∪ declared)
// table, and its description renders one line per verb — both computed from
// config. As a host module the specs were rebuilt per CONNECTION, so a declared
// row added in settings appeared on the next agent connect. A published spec is
// snapshotted by the host when it is registered, so without this the enum would
// freeze at plugin load and a newly declared row would be unreachable through
// the schema. Disposing and re-publishing on every settings write restores that
// freshness at a finer granularity than before.

import { Plugin } from "obsidian";
import { publishTools } from "vault-mcp-api";
import { buildTriageTools } from "./tools.js";
import { obsidianTriageSource } from "./obsidian-source.js";
import { TriageSettingTab } from "./settings-tab.js";
import {
  adoptHostConfig,
  settingsOf,
  DEFAULT_PLUGIN_SETTINGS,
  type TriagePluginSettings,
} from "./settings.js";

/** The host plugin's ids, CURRENT FIRST — the same pair vault-mcp-api reads, in
 *  the same order, and for the same reason: the host id moved `vault-mcp` →
 *  `governor` at 0.12.0 and back to `vault-mcp` at the suite split's S3c.
 *  Used ONLY to find the settings to adopt from; publishing itself is entirely
 *  vault-mcp-api's business.
 *
 *  THE ORDER AND THE `api` CHECK BELOW ARE BOTH PART OF THE ANSWER. Post-split
 *  `app.plugins.plugins["governor"]` is the governance PROVIDER, which exposes
 *  no `api` object, so a bare-presence match over the old `["governor",
 *  "vault-mcp"]` order resolved the PROVIDER as the host — this satellite would
 *  then have adopted the provider's settings as the host's. The discriminator is
 *  vault-mcp-api's own (`getApi`, packages/vault-mcp-api/src/index.ts): a plugin
 *  counts as the host only if it exposes the api surface.
 *
 *  THE SUITE'S ONE BEHAVIOURAL TEST of this lookup is
 *  `packages/conformance/tests/host-lookup.test.mjs`, over the extracted
 *  `packages/conformance/src/host-lookup.ts` — same two lines, same reasoning,
 *  written out in full in the test. Nine identical suites would be nine copies of one
 *  assertion; a change here belongs in that file too. */
const HOST_PLUGIN_IDS = ["vault-mcp", "governor"] as const;

export default class VaultTriagePlugin extends Plugin {
  settings: TriagePluginSettings = { ...DEFAULT_PLUGIN_SETTINGS };

  /** The live `publishTools` disposer, or null when nothing is published.
   *  Held rather than handed straight to `this.register` because a config
   *  change has to revoke and re-publish — see the header. */
  private unpublish: (() => void) | null = null;

  async onload(): Promise<void> {
    this.settings = settingsOf(await this.loadData());
    await this.adoptFromHostOnce();

    this.addSettingTab(
      new TriageSettingTab(
        this.app,
        {
          getConfig: () => this.settings.config,
          setConfig: async (key, value) => {
            // `undefined` clears the override so the shipped default applies
            // again — persisting `undefined` would be a JSON hole, not a reset.
            if (value === undefined) delete this.settings.config[key];
            else this.settings.config[key] = value;
            await this.saveData(this.settings);
            this.republish();
          },
        },
        this,
      ),
    );

    // Unpublish on unload however we got here — including a republish that
    // never happened because publishing threw.
    this.register(() => {
      this.unpublish?.();
      this.unpublish = null;
    });

    this.republish();
  }

  /**
   * Revoke whatever is published and publish a freshly built pair of specs.
   *
   * `publishTools` is internally defensive (it registers now or on the host's
   * ready event and never throws out of onload), but a failure here must not be
   * able to take down the settings tab either, so it is caught and reported.
   */
  private republish(): void {
    try {
      this.unpublish?.();
      this.unpublish = null;
      this.unpublish = publishTools(
        this,
        buildTriageTools(obsidianTriageSource(this.app), {
          // Read per call, never captured: the host holds a spec snapshot per
          // connection, so a captured config would freeze the settings tab's
          // values at plugin load. (The enum and descriptions are necessarily
          // build-time snapshots regardless, which is why this method exists.)
          config: () => this.settings.config,
          // `getSettings` and `visible` are deliberately NOT supplied — a
          // satellite cannot reach the host's guard settings, and the host's
          // external-tool gate is the enforced boundary. `baseQuery` and
          // `schemeExpected` are not supplied either: both were host-module
          // seams with no published equivalent, and `baseQuery`'s counterpart
          // has since moved out of the host too — into the `vaultmcp-bases`
          // satellite, which is no more reachable from here. See tools.ts.
        }),
      );
    } catch (e) {
      console.error("[vaultmcp-triage] publishing the tool surface failed", e);
    }
  }

  /**
   * One-shot settings adoption from the host's `modules.triage.config`.
   *
   * Before the extraction this plugin's configuration lived inside the host's
   * data.json. A user who upgrades would otherwise get an empty config — which
   * for triage means an empty `moveWhitelist`/`moveBlacklist`, i.e. no bound on
   * where a disposition may send a note. The host's copy is READ and never
   * written — see settings.ts for the three rules.
   */
  private async adoptFromHostOnce(): Promise<void> {
    if (this.settings.adoptedFromHost) return;
    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: unknown; settings?: unknown }> };
    }).plugins?.plugins;
    let hostSettings: unknown;
    for (const id of HOST_PLUGIN_IDS) {
      const host = plugins?.[id];
      // `settings` is declared without an initializer on the host and only
      // assigned mid-onload — a plugin instance can be visible in the map
      // before that assignment runs. Treating that as "host present, empty
      // settings" would burn the one-shot latch on nothing and the user's
      // config would never adopt. An undefined settings bag reads as HOST NOT
      // READY, exactly like an absent host: adoption retries next load.
      // A plugin under a host id exposing no `api` is the governance PROVIDER,
      // not a host — skip it and fall through. See HOST_PLUGIN_IDS above.
      if (!host || !host.api) continue;
      if (host.settings !== undefined) { hostSettings = host.settings; break; }
    }
    const adopted = adoptHostConfig(this.settings, hostSettings);
    if (!adopted) return;
    this.settings = adopted;
    await this.saveData(this.settings);
    console.info("[vaultmcp-triage] adopted the Vault MCP host's modules.triage.config (one shot; the host's copy is untouched)");
  }
}
