// VAULT BASES — evaluated Base result sets for agents, as their own Obsidian
// plugin.
//
// Published to the Vault MCP host through vault-mcp-api as two MCP tools:
//
//   vaultmcp_bases_list  — enumerate `.base` files + their declared views
//                       (read-only in intent; the host distrusts that claim,
//                       see below)
//   vaultmcp_bases_query — one declared view's rows, evaluated by Obsidian's own
//                       Bases engine: by its base:query handler (`fast`, the
//                       default when reachable) or in a hidden background leaf
//                       (`view`, full fidelity); see docs/bases.md "Two evaluators"
//
// SATELLITE OF THE SUITE (suite-split design §6/§7, the "Bases | public
// optional | satellite" row). Extracted out of the host at S7, following the
// quickadd-choices-compile pilot and the private-tier satellites vaultmcp-skills
// (S4), vaultmcp-triage (S5) and vaultmcp-crosssession (S6). Consequences of the
// publishing contract, each deliberate:
//
//   * THE TOOL NAMES CHANGED TWICE OVER — `base_list` / `base_query` are now
//     `vaultmcp_bases_list` / `vaultmcp_bases_query`. The host publishes an external
//     tool as `<sanitized publisher id>_<bare name>`, so the plugin id IS the
//     namespace (`vaultmcp-bases` → `vaultmcp_bases`); and the bare names shed their
//     `base_` prefix, because keeping it would have published the stuttering
//     `vaultmcp_bases_base_query`. Recorded in CLAUDE.md and README.md, not buried
//     here.
//   * THE ALLOWLIST BOUNDARY MOVED TO THE HOST, and it lands ASYMMETRICALLY
//     here — unlike the three private-tier satellites, where it closed on the
//     whole surface. `list` takes no arguments, so under an active path
//     allowlist the host blocks it outright (stricter than the module, which
//     filtered its listing). `query` takes `path`, a recognized path key, so
//     the host scopes it instead of blocking it — but the ROW filter is now
//     dormant, so a query on a VISIBLE base can return rows naming notes
//     outside the allowlist, where the module dropped them. One tightened, one
//     loosened. See tools.ts and README.md; neither half is papered over.
//   * REFUSALS THROW; the host renders a thrown error's lowercase-snake `code`
//     as `Error [code]: message`, the envelope the module already produced.
//   * The host's queue, journal and kernel args still apply — external tools
//     ride the guarded registration path like every built-in, and an untrusted
//     `readOnly: true` claim means BOTH tools register as mutating.
//
// THIS PLUGIN NEEDS THE HOST, like the triage and cross-session satellites and
// unlike skills. It has no pane, no palette command and no ribbon: its entire
// surface is the two published tools. With the host absent it loads, keeps and
// validates its settings, and does nothing — `publishTools` waits on the host's
// ready event and registers the moment a host appears. The settings tab says so
// plainly.
//
// ONE ADOPTION, not two. Config adoption is the skills/triage pattern, over the
// host's `modules.bases.config`. There is deliberately NO second adoption: this
// surface is read-only and holds no live operational state outside data.json —
// no receipts, no cache, no state file (checked, not assumed; see settings.ts).
//
// RE-PUBLISHING ON CONFIG CHANGE, as in the triage and cross-session
// satellites. Both tool DESCRIPTIONS render configured values — `query`'s
// renders the row cap and the query timeout — and the host snapshots a
// published spec when it registers it, so without a republish the descriptions
// would freeze at plugin load and a raised timeout would be misreported to
// every agent that reads the tool list. Disposing and re-publishing on every
// settings write restores the per-connection freshness the module had. It also
// re-evaluates the Bases feature gate, which is the one behaviour the
// extraction genuinely changed grain on — see the README.

import { Plugin } from "obsidian";
import { publishTools } from "vault-mcp-api";
import { buildBasesTools, type BasesSource } from "./tools.js";
import { obsidianBasesSource } from "./obsidian-source.js";
import { BasesSettingTab } from "./settings-tab.js";
import {
  adoptHostConfig,
  settingsOf,
  DEFAULT_PLUGIN_SETTINGS,
  type BasesPluginSettings,
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

export default class VaultBasesPlugin extends Plugin {
  settings: BasesPluginSettings = { ...DEFAULT_PLUGIN_SETTINGS };

  /** The live `publishTools` disposer, or null when nothing is published.
   *  Held rather than handed straight to `this.register` because a config
   *  change has to revoke and re-publish — see the header. */
  private unpublish: (() => void) | null = null;

  /** The live vault + engine adapter, built once: it closes over `app`, which
   *  does not change for the life of the instance, and it holds no state
   *  between calls (each view-evaluator capture constructs and detaches its own
   *  leaf; the fast road builds none). */
  private source!: BasesSource;

  async onload(): Promise<void> {
    this.settings = settingsOf(await this.loadData());
    this.source = obsidianBasesSource(this.app);

    await this.adoptFromHostOnce();

    this.addSettingTab(
      new BasesSettingTab(
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
          basesApiAvailable: () => this.source.available(),
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
   * Revoke whatever is published and publish a freshly built set of specs.
   *
   * `publishTools` is internally defensive (it registers now or on the host's
   * ready event and never throws out of onload), but a failure here must not be
   * able to take down the settings tab either, so it is caught and reported.
   *
   * `buildBasesTools` re-checks `source.available()` on every call, so this is
   * also where the Bases feature gate is evaluated. An empty spec list is a
   * legitimate outcome, not an error: no public Bases API ⇒ nothing published.
   */
  private republish(): void {
    try {
      this.unpublish?.();
      this.unpublish = null;
      this.unpublish = publishTools(
        this,
        buildBasesTools(this.source, {
          // Read per call, never captured: the host holds a spec snapshot per
          // connection, so a captured config would freeze the settings tab's
          // values at plugin load. (The descriptions are necessarily build-time
          // snapshots regardless, which is why this method exists.)
          config: () => this.settings.config,
          // `getSettings` and `visible` are deliberately NOT supplied — a
          // satellite cannot reach the host's guard settings, and the host's
          // external-tool gate is the enforced boundary. See tools.ts for what
          // that costs the row filter.
        }),
      );
    } catch (e) {
      console.error("[vaultmcp-bases] publishing the tool surface failed", e);
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
   * One-shot settings adoption from the host's `modules.bases.config`.
   *
   * The host's copy is READ and never written — see settings.ts for the three
   * rules. Failure paths hold the latch OPEN so the next load retries.
   */
  private async adoptFromHostOnce(): Promise<void> {
    if (this.settings.adoptedFromHost) return;
    // `settings` is declared without an initializer on the host and only
    // assigned mid-onload — a plugin instance can be visible in the map before
    // that assignment runs. Treating that as "host present, empty settings"
    // would burn the one-shot latch on nothing and the user's config would
    // never adopt. An undefined settings bag reads as HOST NOT READY, exactly
    // like an absent host: adoption retries next load.
    const host = this.hostPlugin();
    const hostSettings = host && host.settings !== undefined ? host.settings : undefined;
    const adopted = adoptHostConfig(this.settings, hostSettings);
    if (!adopted) return;
    this.settings = adopted;
    await this.saveData(this.settings);
    console.info("[vaultmcp-bases] adopted the Vault MCP host's modules.bases.config (one shot; the host's copy is untouched)");
  }
}
