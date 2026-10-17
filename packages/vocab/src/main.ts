// VAULT VOCABULARY — the controlled vocabulary's read surface as its own
// Obsidian plugin.
//
// Published to the Vault MCP host through vault-mcp-api as four MCP tools:
//
//   vaultmcp_vocab_vocabularies    — enumerate the configured vocabulary sources
//   vaultmcp_vocab_resolve_term    — token → entry; path → that note's own terms
//   vaultmcp_vocab_validate_terms  — one note's frontmatter → findings
//   vaultmcp_vocab_list_vocabulary — the registered entries of one kind
//
// SATELLITE OF THE SUITE (suite-split design §6, row "Vocabulary provider |
// public optional | satellite"). Extracted out of the host at S7, following the
// quickadd-choices-compile pilot, vaultmcp-skills (S4), vaultmcp-triage (S5) and
// vaultmcp-crosssession (S6). Consequences of the publishing contract, each
// deliberate:
//
//   * THE KERNEL DID NOT COME WITH IT. `packages/core/src/vocab/` holds the
//     providers, the registry and the findings, because the host's conformance
//     rail is a SECOND consumer of exactly that code and always was. There is
//     no `src/kernel/` here and there must not be one — see tools.ts.
//   * THE PUBLISHED TOOL NAMES CHANGED. `obsidian_vocabularies` and its three
//     siblings are now `vaultmcp_vocab_*`, with the `obsidian_` prefix stripped
//     because it was the HOST's built-in namespace and not this module's name.
//     Recorded in CLAUDE.md with the reversal, not buried here.
//   * THE ALLOWLIST BOUNDARY MOVED TO THE HOST, and unlike every prior
//     satellite it is NOT uniform across the surface: two tools carry no path
//     argument and are blocked outright under an allowlist, one always carries
//     one and stays scoped, and one is blocked or scoped DEPENDING ON THE
//     ARGUMENTS OF THE INDIVIDUAL CALL. See tools.ts, and the settings tab,
//     which says so to the human.
//   * REFUSALS THROW; the host renders a thrown error's lowercase-snake `code`
//     as `Error [code]: message`. Two envelopes changed on purpose (the
//     argument-shape errors gained `invalid_argument`); the rest are
//     byte-compatible with the folded era.
//   * The host's queue, journal and kernel args still apply — external tools
//     ride the guarded registration path like every built-in, and an untrusted
//     `readOnly: true` claim means all four register as MUTATING.
//
// THIS PLUGIN NEEDS THE HOST, like the triage and crosssession satellites and
// unlike skills. It has no pane, no palette command and no ribbon: its entire
// surface is the four published tools. With the host absent it loads, keeps and
// validates its settings, and does nothing — `publishTools` waits on the host's
// ready event and registers the moment a host appears.
//
// ONE ADOPTION, of an ARRAY. The difference from the three predecessors is the
// SHAPE of the source, not its fate: `settings.vocabularies` is a TOP-LEVEL
// host setting rather than a `modules.<id>.config` record, because it is a list
// of structured instances the host's scalar manifest-field renderer could not
// express. Its fate is the ordinary one — the host stops reading it, and the
// host's bespoke editor for it was removed at this extraction. It is still
// DECLARED and DEFAULTED there deliberately, as the adoption source, so that
// deleting it cannot destroy a user's configuration before this plugin has read
// it. Fully argued in settings.ts.
//
// RE-PUBLISHING ON CONFIG CHANGE, as in the triage and crosssession
// satellites. `ctx.getVocabularies` is a thunk read PER CALL, so the handlers
// always see the live rows — but the host SNAPSHOTS a published spec's schema
// and description when it registers it, and the descriptions are what an agent
// reads to decide whether to call a tool at all. Disposing and re-publishing on
// every settings write is what restores the per-connection freshness the module
// had. (Today none of the four descriptions interpolates a configured value.
// The rule still applies: `vocabularies` is precisely the tool that ENUMERATES
// the configured rows, so its description is one edit away from wanting them,
// and re-publishing costs nothing.)

import { Plugin } from "obsidian";
import { publishTools } from "vault-mcp-api";
import type { VocabInstanceSettings } from "@vault-mcp/core";
import { buildVocabTools } from "./tools.js";
import { obsidianVocabSource } from "./obsidian-source.js";
import { VocabSettingTab } from "./settings-tab.js";
import {
  adoptHostConfig,
  settingsOf,
  DEFAULT_PLUGIN_SETTINGS,
  type VocabPluginSettings,
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

export default class VaultVocabPlugin extends Plugin {
  settings: VocabPluginSettings = { ...DEFAULT_PLUGIN_SETTINGS };

  /** The live `publishTools` disposer, or null when nothing is published.
   *  Held rather than handed straight to `this.register` because a settings
   *  change has to revoke and re-publish — see the header. */
  private unpublish: (() => void) | null = null;

  async onload(): Promise<void> {
    this.settings = settingsOf(await this.loadData());

    await this.adoptFromHostOnce();

    this.addSettingTab(
      new VocabSettingTab(
        this.app,
        {
          getVocabularies: () => this.settings.vocabularies,
          setVocabularies: async (next: VocabInstanceSettings[]) => {
            this.settings = { ...this.settings, vocabularies: next };
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
        buildVocabTools(obsidianVocabSource(this.app as never), {
          // Read per call, never captured: the host holds a spec snapshot per
          // connection, so captured rows would freeze the settings tab's values
          // at plugin load. An EMPTY array reaches tools.ts, which reads it as
          // "use the shipped defaults" — see the `rows()` comment there.
          getVocabularies: () => this.settings.vocabularies,
          // `getSettings` and `visible` are deliberately NOT supplied — a
          // satellite cannot reach the host's guard settings, and the host's
          // external-tool gate is the enforced boundary. tools.ts states
          // precisely what that costs for the two tools the host lets through.
        }),
      );
    } catch (e) {
      console.error("[vaultmcp-vocab] publishing the tool surface failed", e);
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
   * One-shot settings adoption from the host's TOP-LEVEL `vocabularies` array
   * (not `modules.vocab.config` — that never existed; see settings.ts).
   *
   * The host's copy is READ and never written, and after this extraction the
   * host stops reading it too — it is kept there only so this adoption has
   * something to adopt FROM.
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
    // Failure paths hold the latch OPEN so the next load retries: the latch is
    // only persisted once the write succeeds, and a throwing `saveData`
    // propagates out of onload's await rather than being swallowed into a
    // burnt latch with nothing on disk.
    await this.saveData(this.settings);
    console.info(
      `[vaultmcp-vocab] adopted ${this.settings.vocabularies.length} vocabulary row(s) from the Vault MCP host's ` +
        "top-level `vocabularies` setting (one shot; the host's copy is untouched and is no longer read by the host)",
    );
  }
}
