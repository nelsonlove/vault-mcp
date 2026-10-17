// VAULT FILECLASS — the typed-frontmatter CLI proxy as its own Obsidian plugin.
//
// Published to the Vault MCP host through vault-mcp-api as eight MCP tools:
//
//   vaultmcp_fileclass_list      — every fileClass
//   vaultmcp_fileclass_schema    — a fileClass's options + resolved fields
//   vaultmcp_fileclass_explain   — a note's fileClasses + field values
//   vaultmcp_fileclass_query     — rows for a fileClass, filtered
//   vaultmcp_fileclass_get       — one field's value on a note
//   vaultmcp_fileclass_validate  — schema violations
//   vaultmcp_fileclass_set       — validated single-note field write (MUTATING)
//   vaultmcp_fileclass_set_where — validated bulk write, dry-run by default (MUTATING)
//
// SATELLITE OF THE SUITE (suite-split design §6, "Fileclass CLI proxy | public
// optional | satellite"). Extracted out of the host after the
// quickadd-choices-compile pilot and the vaultmcp-skills (S4), vaultmcp-triage (S5),
// vaultmcp-crosssession (S6) and vaultmcp-vocab / vaultmcp-health / vaultmcp-bases (S7)
// satellites. Consequences of the publishing contract, each deliberate:
//
//   * THE PUBLISHED TOOL NAMES CHANGED — `fileclass_*` became
//     `vaultmcp_fileclass_*`, and the bare names shed the `fileclass_` prefix so
//     nothing publishes as `vaultmcp_fileclass_fileclass_list`. The host publishes
//     an external tool as `<sanitized publisher id>_<bare name>`, so the plugin
//     id IS the tool namespace. Recorded in CLAUDE.md and README.md, not buried
//     here.
//   * THE ALLOWLIST BOUNDARY MOVED TO THE HOST, and after round 2 (2026-09-07)
//     it lands ALMOST where the module's own refusal did — seven of the eight
//     tools refused outright, one scoped. The two READS that name a note call
//     it `note`, which is not a host path key, and the five bulk/engine tools
//     name no note at all: all seven are blocked outright under an active
//     allowlist. `set` calls it `note_path`, which IS a key, so the host scopes
//     that one write per-path AND the kernel's record guard, lock consult and
//     journal target see the note it rewrites. The asymmetry is the decision:
//     a read gains nothing from kernel visibility, a write does. See tools.ts.
//   * REFUSALS THROW; the host renders a thrown error's lowercase-snake `code`
//     as `Error [code]: message`, the envelope the module already produced. ONE
//     envelope changed: a FAILED CLI run used to be `okError` (a report plus
//     `isError: true`), which the boundary cannot express — it now returns the
//     same report with `succeeded: false`. Read `succeeded`, not `isError`.
//   * The host's queue, journal and kernel args still apply — external mutating
//     tools ride the guarded registration path like every built-in, and the
//     host distrusts an external `readOnly: true` claim, so all eight register
//     as mutating unless `vaultmcp-fileclass` is listed in the host's
//     `trustedReadOnlyPlugins`.
//
// THIS PLUGIN NEEDS THE HOST, and it needs two more things besides — which is
// one more silence than any other satellite has. With the host absent it loads,
// keeps its settings, adopts nothing, and does nothing. With the host present
// but the Fileclass plugin unloaded, or the `fileclass` CLI binary not found, it
// publishes NOTHING: absent, not broken, which is the gate the module always
// had. The settings tab names whichever of the three states you are in.
//
// THE GATE'S GRAIN CHANGED. As a module it was evaluated per connection build,
// so a session that reconnected after installing the plugin or the binary got
// the tools. Here it is evaluated at publish time — plugin load, and every
// settings write. Installing either without reloading this plugin leaves the
// tools absent until a reload. Same caveat the bases satellite carries, same
// reason, stated in the README and the settings tab rather than left to be
// discovered.

import { Plugin } from "obsidian";
import { publishTools } from "vault-mcp-api";
import { buildFileclassTools } from "./tools.js";
import { fileclassPluginPresent, vaultNameOf } from "./obsidian-source.js";
import { FileclassSettingTab } from "./settings-tab.js";
import {
  adoptHostConfig,
  fileclassConfigOf,
  settingsOf,
  DEFAULT_PLUGIN_SETTINGS,
  type FileclassPluginSettings,
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

export default class VaultFileclassPlugin extends Plugin {
  settings: FileclassPluginSettings = { ...DEFAULT_PLUGIN_SETTINGS };

  /** The live `publishTools` disposer, or null when nothing is published. Held
   *  rather than handed straight to `this.register` because a config change has
   *  to revoke and re-publish — the binary path is a config key, and the
   *  published SET depends on it. */
  private unpublish: (() => void) | null = null;

  async onload(): Promise<void> {
    this.settings = settingsOf(await this.loadData());

    await this.adoptFromHostOnce();

    this.addSettingTab(
      new FileclassSettingTab(
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
   * Revoke whatever is published and publish a freshly built set of specs.
   *
   * This is not tidiness: `binaryPath` is config, and the whole spec LIST is
   * gated on resolving a binary, so a settings write can turn eight tools on or
   * off. The host snapshots a published spec's schema and description when it
   * registers it, so without a republish a changed binary path would not land
   * until an Obsidian reload. Do not "simplify" this back into a single
   * `this.register(publishTools(...))` in onload.
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
        buildFileclassTools({
          // Read per call, never captured.
          config: () => fileclassConfigOf(this.settings.config),
          present: () => fileclassPluginPresent(this.app),
          vaultName: () => vaultNameOf(this.app),
          // `getSettings` is deliberately NOT supplied — a satellite cannot
          // reach the host's guard settings, and the host's F3 gate is the
          // enforced boundary. See tools.ts.
        }),
      );
    } catch (e) {
      console.error("[vaultmcp-fileclass] publishing the tool surface failed", e);
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
   * One-shot settings adoption from the host's `modules.fileclass.config`.
   *
   * The host's copy is READ and never written — see settings.ts for the three
   * rules. Two failure paths hold the latch OPEN so the next load retries: an
   * absent-or-not-ready host (handled inside `adoptHostConfig`, which returns
   * null), and a `saveData` that throws — the latch lives in `this.settings`
   * and is only accepted AFTER the write resolves, so a failed persist leaves
   * the in-memory settings untouched and the question gets asked again. That is
   * the cross-session review's lesson: a latch burned on a failed write drops
   * the user's configuration while the log says it was adopted.
   */
  private async adoptFromHostOnce(): Promise<void> {
    if (this.settings.adoptedFromHost) return;
    // `settings` is declared without an initializer on the host and only
    // assigned mid-onload — a plugin instance can be visible in the map before
    // that assignment runs. Treating that as "host present, empty settings"
    // would burn the one-shot latch on nothing and the user's config would never
    // adopt. An undefined settings bag reads as HOST NOT READY, exactly like an
    // absent host: adoption retries next load.
    const host = this.hostPlugin();
    const hostSettings = host && host.settings !== undefined ? host.settings : undefined;
    const adopted = adoptHostConfig(this.settings, hostSettings);
    if (!adopted) return;
    try {
      await this.saveData(adopted);
    } catch (e) {
      console.error("[vaultmcp-fileclass] adopted config could not be persisted; will retry next load", e);
      return;
    }
    this.settings = adopted;
    console.info(
      "[vaultmcp-fileclass] adopted the Vault MCP host's fileclass module config (one shot; the host's copy is untouched)",
    );
  }
}
