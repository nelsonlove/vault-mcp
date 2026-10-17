// VAULT HEALTH — the vaultmcp-health scanner as its own Obsidian plugin.
//
// Published to the Vault MCP host through vault-mcp-api as two MCP tools:
//
//   vaultmcp_health_scan — the full tiered health scan → structured findings
//                       (read-only in intent; the host distrusts that claim,
//                       see below);
//   vaultmcp_health_lint — the same scan, findings restricted to one folder/note.
//
// SATELLITE OF THE SUITE (suite-split design §6). Extracted out of the host at
// S7, following the quickadd-choices-compile pilot, the vaultmcp-skills satellite
// (S4), vaultmcp-triage (S5) and vaultmcp-crosssession (S6). Consequences of the
// publishing contract, each deliberate:
//
//   * THE PUBLISHED TOOL NAMES CHANGED — `obsidian_health` → `vaultmcp_health_scan`
//     and `obsidian_lint` → `vaultmcp_health_lint`. The host publishes an external
//     tool as `<sanitized publisher id>_<bare name>`, so the plugin id IS the
//     tool namespace; `vaultmcp-health` sanitizes to `vaultmcp_health`. The bare names
//     shed `obsidian_` because that prefix was the HOST's built-in namespace,
//     never this module's own name — keeping it would publish a tool named after
//     two owners (`vaultmcp_health_obsidian_health`). That WAS available: F1 tests
//     the PUBLISHED name, which would not have started with `obsidian_`. So this
//     is a choice, not a constraint, and it is breaking for callers. Recorded in
//     CLAUDE.md with the one-line reversal.
//   * THE ALLOWLIST BOUNDARY MOVED TO THE HOST, and for this surface it closes
//     harder than the module's NON-filtering it replaces: neither tool carries a
//     recognized path key (`scan` takes no arguments at all; `lint`'s `scope` is
//     not a `PATH_KEY`), so under an active path allowlist the host blocks both
//     outright. Fail-closed. That is what resolves issue #381 for these two
//     tools — see README.md. See tools.ts for why `scope` was deliberately NOT
//     renamed into a path key.
//   * REFUSALS THROW; the host renders a thrown error's lowercase-snake `code`
//     as `Error [code]: message`, the envelope the module already produced.
//   * The host's read-only mode, queue, journal and kernel args still apply —
//     external tools whose read-only claim is untrusted ride the guarded
//     registration path like every built-in mutating tool.
//
// THIS PLUGIN NEEDS THE HOST, like the triage and crosssession satellites. It has
// no pane, no palette command and no ribbon: its entire surface is the two
// published tools. With the host absent it loads, keeps its settings, adopts
// nothing, and does nothing — `publishTools` waits on the host's ready event and
// registers the moment a host appears. The settings tab says so plainly.
//
// ONE ADOPTION, not two. Unlike the crosssession satellite there is NO live
// operator state to migrate: the health module kept nothing on disk — no
// receipts, no baseline, no cursor — because every call recomputes the whole scan
// from Obsidian's live metadata cache and the notes themselves. The host's
// `modules.health.config` is the entire migration surface.
//
// RE-PUBLISHING ON CONFIG CHANGE, as in the triage and crosssession satellites,
// and here it is load-bearing twice over. Both tool DESCRIPTIONS render the
// configured empty-note threshold, and the host snapshots a published spec when
// it registers it — so without a republish the number an agent reads would freeze
// at plugin load. Disposing and re-publishing on every settings write restores
// the per-connection freshness the module had. (The HANDLERS read the config
// through a thunk, per call — see tools.ts, where that is the S7 bug fix.)

import { Plugin } from "obsidian";
import { publishTools } from "vault-mcp-api";
import { buildHealthTools } from "./tools.js";
import { obsidianHealthBackend } from "./obsidian-source.js";
import { HealthSettingTab } from "./settings-tab.js";
import {
  adoptHostConfig,
  settingsOf,
  DEFAULT_PLUGIN_SETTINGS,
  type HealthPluginSettings,
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

interface HostPluginLike {
  /** The plugin-to-plugin api object. Its PRESENCE is what makes a plugin the
   *  host — the governance provider has none. See HOST_PLUGIN_IDS. */
  api?: unknown;
  settings?: unknown;
}

export default class VaultHealthPlugin extends Plugin {
  settings: HealthPluginSettings = { ...DEFAULT_PLUGIN_SETTINGS };

  /** The live `publishTools` disposer, or null when nothing is published. Held
   *  rather than handed straight to `this.register` because a config change has
   *  to revoke and re-publish — see the header. */
  private unpublish: (() => void) | null = null;

  async onload(): Promise<void> {
    this.settings = settingsOf(await this.loadData());

    await this.adoptFromHostOnce();

    this.addSettingTab(
      new HealthSettingTab(
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

    // Unpublish on unload however we got here — including a republish that never
    // happened because publishing threw.
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
        buildHealthTools(obsidianHealthBackend(this.app as never), {
          // Read per call, never captured: there is no per-connection rebuild
          // for a satellite, so a captured config would freeze at plugin load
          // forever. (The descriptions are necessarily build-time snapshots
          // regardless, which is why this method exists.)
          config: () => this.settings.config,
          // `getSettings` is deliberately NOT supplied — a satellite cannot
          // reach the host's guard settings, and the host's external-tool gate
          // is the enforced boundary. `resolveScope` still refuses a MALFORMED
          // scope without it. See tools.ts.
        }),
      );
    } catch (e) {
      console.error("[vaultmcp-health] publishing the tool surface failed", e);
    }
  }

  /** The host plugin instance, current id first, or undefined. */
  private hostPlugin(): HostPluginLike | undefined {
    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, HostPluginLike> };
    }).plugins?.plugins;
    for (const id of HOST_PLUGIN_IDS) {
      const host = plugins?.[id];
      // A plugin under a host id exposing no `api` is the governance PROVIDER,
      // not a host — skip it and fall through. See HOST_PLUGIN_IDS above.
      if (!host || !host.api) continue;
      return host;
    }
    return undefined;
  }

  /**
   * One-shot settings adoption from the host's `modules.health.config`.
   *
   * The host's copy is READ and never written — see settings.ts for the three
   * rules. A failure path holds the latch OPEN so the next load retries.
   */
  private async adoptFromHostOnce(): Promise<void> {
    if (this.settings.adoptedFromHost) return;
    // `settings` is declared without an initializer on the host and only
    // assigned mid-onload — a plugin instance can be visible in the map before
    // that assignment runs. Treating that as "host present, empty settings"
    // would burn the one-shot latch on nothing and the user's config would never
    // adopt. An undefined settings bag reads as HOST NOT READY, exactly like an
    // absent host: adoption retries next load. The check is `!== undefined`,
    // never a truthiness test.
    const host = this.hostPlugin();
    const hostSettings = host && host.settings !== undefined ? host.settings : undefined;
    const adopted = adoptHostConfig(this.settings, hostSettings);
    if (!adopted) return;
    try {
      await this.saveData(adopted);
    } catch (e) {
      // The latch lives in the same record that failed to persist, so leaving
      // `this.settings` untouched keeps the one chance alive for the next load
      // rather than latching in memory over a write that never landed.
      console.error("[vaultmcp-health] adopted config could not be persisted; will retry next load", e);
      return;
    }
    this.settings = adopted;
    console.info("[vaultmcp-health] adopted the Vault MCP host's modules.health.config (one shot; the host's copy is untouched)");
  }
}
