// VAULT SKILLS — the skills compiler as its own Obsidian plugin.
//
// Compiles the vault's skill / agent / policy / command notes into a Claude
// Code plugin and materializes it to disk. Two surfaces over one compiler core:
//
//   1. the HUMAN surface — a Preview pane, six palette commands, a ribbon icon,
//      and an opt-in export-on-save trigger (wiring.ts);
//   2. the AGENT surface — six MCP tools published to the Vault MCP host through
//      vault-mcp-api (tools.ts), on the wire as `vaultmcp_skills_validate` …
//      `vaultmcp_skills_mark` — spelled `vault_skills_*` from the S4
//      extraction until #394 moved the plugin id into the `vaultmcp-`
//      namespace. See THE NAMESPACE MOVE below.
//
// SATELLITE OF THE SUITE (suite-split design §6: "Skills compiler | private
// operator | satellite — the biggest single extraction; least entangled").
// Extracted out of the host at S4, following the quickadd-choices-compile
// pilot. Consequences of the publishing contract, each deliberate:
//
//   * THE ALLOWLIST BOUNDARY MOVED TO THE HOST, and got stricter. An external
//     tool's `readOnlyHint: true` is a claim the host distrusts unless the raw
//     publisher id is in its `trustedReadOnlyPlugins` list, so all six of these
//     register as mutating; and a mutating external tool whose arguments carry
//     no recognized path key is BLOCKED OUTRIGHT while a path allowlist is
//     active. Five of the six carry no path argument, so under an allowlist
//     they are refused wholesale rather than filtered. `vaultmcp_skills_mark` does
//     carry `path`, so it is scoped normally. The in-tool visibility filter is
//     kept as defence in depth — see the long note in tools.ts.
//   * REFUSALS THROW; the host renders a thrown error as its error envelope.
//   * The host's queue, journal and kernel args still apply — external mutating
//     tools ride the guarded registration path like every built-in.
//
// STANDALONE OPERATION IS A REQUIREMENT, not a nicety. With no host installed
// the pane, the commands, the ribbon and export-on-save all still work; only
// the tools go unpublished. That is why the human wiring is registered FIRST
// and `publishTools` last: `publishTools` is internally defensive (it registers
// now or on the host's ready event, and never throws out of onload), which
// makes the ordering belt rather than fix — but the claim and the code should
// agree. Same reasoning as the pilot's.

import { Plugin } from "obsidian";
import { publishTools } from "vault-mcp-api";
import { wireSkills } from "./wiring.js";
import { buildSkillsTools, obsidianSkillsBackend } from "./tools.js";
import { SkillsSettingTab } from "./settings-tab.js";
import {
  adoptHostConfig,
  settingsOf,
  DEFAULT_PLUGIN_SETTINGS,
  type SkillsPluginSettings,
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

export default class VaultSkillsPlugin extends Plugin {
  settings: SkillsPluginSettings = { ...DEFAULT_PLUGIN_SETTINGS };

  async onload(): Promise<void> {
    this.settings = settingsOf(await this.loadData());
    await this.adoptFromHostOnce();

    this.addSettingTab(
      new SkillsSettingTab(
        this.app,
        {
          getConfig: () => this.settings.config,
          setConfig: async (key, value) => {
            // `undefined` clears the override so the shipped default applies
            // again — persisting `undefined` would be a JSON hole, not a reset.
            if (value === undefined) delete this.settings.config[key];
            else this.settings.config[key] = value;
            await this.saveData(this.settings);
          },
        },
        this,
      ),
    );

    // THE HUMAN PATH FIRST — see the header. A failure here must not be able to
    // take down publishing either, so it is caught and reported the way the
    // host used to catch it.
    try {
      wireSkills(this, { getConfig: () => this.settings.config });
    } catch (e) {
      console.error("[vaultmcp-skills] GUI wiring failed", e);
    }

    this.register(
      publishTools(
        this,
        buildSkillsTools(obsidianSkillsBackend(this.app), {
          // Read per call, never captured: the host holds a spec snapshot per
          // connection, so a captured config would freeze at plugin load.
          config: () => this.settings.config,
          // getSettings is deliberately NOT supplied — a satellite cannot reach
          // the host's guard settings, and the host's external-tool gate is the
          // enforced boundary. See tools.ts.
        }),
      ),
    );
  }

  /**
   * One-shot settings adoption from the host's `modules.skills.config`.
   *
   * Before the extraction this plugin's configuration lived inside the host's
   * data.json. A user who upgrades would otherwise get an empty config and
   * silently start exporting to the default output dir. The host's copy is READ
   * and never written — see settings.ts for the three rules.
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
    console.info("[vaultmcp-skills] adopted the Vault MCP host's modules.skills.config (one shot; the host's copy is untouched)");
  }
}
