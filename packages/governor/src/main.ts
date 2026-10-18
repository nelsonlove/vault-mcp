// GOVERNOR — the governance provider, as its own Obsidian plugin.
//
// Everything that decides authority: proposals, verification, admission,
// cohorts, mandates, transformations and promotion, the Git-backed history
// store, the legacy acceptance machinery with its cutover and store binding,
// and the human-only review pane. It plugs into the Vault MCP host through the
// governance seam and publishes five MCP tools through `vault-mcp-api`.
//
// ── WHAT CROSSES THE SEAM, AND WHY EACH DIRECTION IS SAFE ───────────────────
//
// CANDIDATES flow OUTWARD: the host hands over the exact bytes of a completed
// write and this plugin turns them into a proposal. A proposal confers nothing —
// agents and machinery supply candidates, humans decide.
//
// REFUSALS flow INWARD: this plugin answers "refuse this session or not", and a
// refusal can only make the host refuse MORE. `null` is silence, not an allow;
// the type cannot express permission.
//
// Nothing else crosses. The host never asks this plugin for permission to write,
// never learns why a session was refused beyond the refusal's own detail string,
// and works completely with this plugin absent — every seam consultation on a
// provider-less host iterates an empty list.
//
// ── WHY THIS PLUGIN KEPT THE ID `governor` ──────────────────────────────────
//
// Because the authority state did not move. `.obsidian/plugins/governor/governance/`
// — baselines, the acceptance log, the pending index, proposals, mandates,
// sessions, the cutover marker — and `~/.claude/governor/history/<vault-slug>/`
// (the standing chain, and the store identity the marker names) are the
// operator's live evidence, and the safest migration for them was none. The HOST
// took the id `vault-mcp` back instead, and copies its journal, its install id
// and its own settings keys out of this folder once, without moving or deleting
// anything.
//
// ── WHAT THIS PLUGIN DOES NOT DO ────────────────────────────────────────────
//
// It does not open the socket, write the bridge, guard reads, run the write
// queue, or append to the write journal. All of that is the host's, and the
// journal in particular is the host's file in the host's directory — this plugin
// only READS it, to derive the review queue.

import { Notice, Plugin, TFile, type Component } from "obsidian";
import * as fs from "node:fs";
import { registerGovernance, publishTools, type WriteFacts } from "vault-mcp-api";
import { uuidv7, resolveTerritories } from "@vault-mcp/core";

import { createSessionStore } from "./kernel/sessions/session-store.js";
import { createProposalStore } from "./kernel/proposals/proposal-store.js";
import { createMandateStore } from "./kernel/mandates/lifecycle.js";
import { budgetBreach } from "./kernel/mandates/budgets.js";
import { createTransformationRegistry } from "./kernel/transformations/transformation.js";
import { createPromotionStore } from "./kernel/transformations/promotion.js";
import { createDefaultPredicateRegistry } from "./kernel/verification/predicates.js";
import { governanceAcceptanceSettings } from "./kernel/settings.js";
import { effectiveScope, isTracked } from "./kernel/history-store/history-scope.js";
import { proposalRef } from "./kernel/history-store/refs.js";
import type { HistoryRepository } from "./kernel/history-store/repository.js";

import { createProposalObserver } from "./wiring/write-observer.js";
import { sessionRefusalFrom } from "./wiring/session-refusal.js";
import { buildAdmission, type AdmissionUiDeps } from "./wiring/admission-wiring.js";
import { buildMandateUi, type MandateUiDeps } from "./wiring/mandate-wiring.js";
import { buildPromotionUi, type PromotionUiDeps } from "./wiring/promotion-wiring.js";
import { buildMigration, type Migration } from "./wiring/migration-wiring.js";
import { openGitRepository } from "./wiring/history-store/git-repository.js";
import { historyDir } from "./wiring/history-store/local-data-root.js";
import { wireGovernance, nudgeGovernanceQueue, setLegacyWriteGuard, baselinesOf } from "./wiring/wiring.js";

import { buildMandateTools } from "./tools/mandate.js";
import { buildPendingReviewTools, obsidianPendingReviewSource } from "./tools/pending-review.js";
import { buildRevisionTools } from "./tools/revision.js";
import { GovernorSettingTab } from "./settings-tab.js";
import { DEFAULT_GOVERNOR_SETTINGS, mergeGovernorSettings, readGovernorSettings, type GovernorSettings } from "./settings.js";
import { vaultSlug } from "./paths.js";
import { hostPluginDir, type HostPluginLike, hostGuardedTerritories } from "./host-lookup.js";

// "Which loaded plugin is the host?" lives in `host-lookup.ts` — Obsidian-free,
// so it is testable headlessly, which is what `tests/host-lookup.test.mjs`
// needed. The id list, the order, and the `api`-presence discriminator (WITHOUT
// which this provider matched ITSELF under the `governor` id) are all documented
// there. It is used ONLY to locate the host's plugin directory, so the review
// queue can be derived from the host's write journal; publishing and seam
// registration are entirely the SDK's business.

// The UI-deps factories, keyed off the plugin instance in module-local WeakMaps
// (the wiring.ts pattern) — NOT plugin properties, so renderer JS walking
// `app.plugins` finds no admit-capable function (§9). Unchanged by the split:
// the same reasoning applies to a plugin that is nothing BUT the perimeter.
const admissionFactories = new WeakMap<Plugin, () => AdmissionUiDeps>();
const mandateUiFactories = new WeakMap<Plugin, () => MandateUiDeps>();
const promotionUiFactories = new WeakMap<Plugin, () => PromotionUiDeps>();
const migrations = new WeakMap<Plugin, Migration>();

export default class GovernorPlugin extends Plugin {
  declare settings: GovernorSettings;
  private paneComponent: Component | null = null;
  private paneReconcile: Promise<void> = Promise.resolve();

  async loadSettings(): Promise<void> {
    this.settings = readGovernorSettings(await this.loadData());
  }

  /**
   * MERGE, NEVER REPLACE. `data.json` in this folder is the pre-split plugin's
   * file and still holds every HOST setting until the host has adopted its half
   * — and holds them forever afterwards, because that is the rollback path. See
   * settings.ts's header for the two failure modes a replacing save would cause.
   */
  async saveSettings(): Promise<void> {
    await this.saveData(mergeGovernorSettings(await this.loadData(), this.settings));
  }

  /** The host plugin's directory, or null when no host is loaded. */
  private hostPluginDir(): string | null {
    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, HostPluginLike | undefined> };
    }).plugins?.plugins;
    return hostPluginDir(plugins, this.app.vault.configDir);
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const adapter = this.app.vault.adapter;
    const vaultName = this.app.vault.getName();

    // ── the stores ───────────────────────────────────────────────────────────
    //
    // All append-only JSONL beside the acceptance log, each serialized through
    // its own chain: the exists?append:write pair is not atomic, and two
    // concurrent writers could otherwise both take the `write` branch and
    // silently lose one event. Every one of these files stayed exactly where it
    // was across the split.
    const chain = (file: string) => {
      let io: Promise<unknown> = Promise.resolve();
      return {
        appendLine: (line: string) => {
          const task = async () => {
            const dir = `${pluginDir}/governance`;
            if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
            if (await adapter.exists(file)) await adapter.append(file, line + "\n");
            else await adapter.write(file, line + "\n");
          };
          const next = io.then(task, task);
          io = next.catch(() => undefined);
          return next;
        },
        readLines: async () => {
          if (!(await adapter.exists(file))) return [];
          return (await adapter.read(file)).split("\n").filter(Boolean);
        },
        /** Append onto the SAME chain, for a second writer of the same file. */
        appendRaw: (line: string) => {
          const task = async () => {
            if (await adapter.exists(file)) await adapter.append(file, line);
            else await adapter.write(file, line);
          };
          const next = io.then(task, task);
          io = next.catch(() => undefined);
          return next;
        },
      };
    };

    const proposalIo = chain(`${pluginDir}/governance/proposals.jsonl`);
    const proposalStore = createProposalStore(proposalIo);
    const sessionStore = createSessionStore(chain(`${pluginDir}/governance/sessions.jsonl`));
    const mandateStore = createMandateStore(chain(`${pluginDir}/governance/mandates.jsonl`));
    const promotionStore = createPromotionStore(chain(`${pluginDir}/governance/promotion-evidence.jsonl`));

    const acceptanceLogFile = `${pluginDir}/governance/acceptance-log.jsonl`;
    const claimsChain = chain(`${pluginDir}/governance/admission-claims.jsonl`);
    const acceptanceChain = chain(acceptanceLogFile);

    // The history repository, opened LAZILY on first recording: an idle vault
    // with history off never touches the gitdir. One instance per plugin — the
    // single-writer assumption the CAS mutex documents. Its location is
    // unchanged by the split, because this plugin kept the id.
    let historyRepoPromise: Promise<HistoryRepository> | null = null;
    const lazyHistoryRepo = () =>
      (historyRepoPromise ??= openGitRepository({
        gitdir: historyDir(vaultSlug(vaultName)),
        worktree: (adapter as unknown as { basePath: string }).basePath,
      }));

    // ── WP8: the migration surface ───────────────────────────────────────────
    // Legacy evidence import plus the human-confirmed authority cutover. State
    // is loaded BEFORE the guard is set, so the BaselineStore's live guard
    // reflects the persisted flip from the first write after load.
    const storeIdPath = `${historyDir(vaultSlug(vaultName))}/governor-store-id.json`;
    const migration: Migration = buildMigration({
      io: {
        exists: (p) => adapter.exists(p),
        read: (p) => adapter.read(p),
        write: (p, d) => adapter.write(p, d),
        append: (p, d) => adapter.append(p, d),
        mkdir: (p) => adapter.mkdir(p),
      },
      paths: {
        govDir: `${pluginDir}/governance`,
        acceptanceLog: acceptanceLogFile,
        pendingIndex: `${pluginDir}/governance/pending-index.json`,
        baselinesDir: `${pluginDir}/governance/baselines`,
        legacyEvidence: `${pluginDir}/governance/legacy-evidence.jsonl`,
        cutoverState: `${pluginDir}/governance/cutover.json`,
      },
      baselines: () => baselinesOf(this),
      now: () => Date.now(),
      // The store-id lives INSIDE the machine-local history dir (node fs —
      // outside the vault, outside the adapter): it rides the #337 chain
      // backup and nothing else, which is the whole binding (store-binding.ts).
      storeIdIo: {
        read: async () => {
          try {
            // STATIC fs, not a dynamic import (live incident, 2026-08-23): a
            // runtime import("node:fs/promises") goes through the renderer's
            // module loader and is CORS-blocked (app://obsidian.md cannot fetch
            // node: URLs) — the bind click failed live on exactly this line's
            // sibling.
            const raw = await fs.promises.readFile(storeIdPath, "utf8");
            const parsed = JSON.parse(raw) as { storeId?: unknown };
            return typeof parsed.storeId === "string" && parsed.storeId ? parsed.storeId : null;
          } catch {
            return null;
          }
        },
        write: async (id) => {
          await fs.promises.mkdir(historyDir(vaultSlug(vaultName)), { recursive: true });
          await fs.promises.writeFile(storeIdPath, JSON.stringify({ storeId: id, mintedAt: new Date().toISOString() }, null, 2));
        },
      },
      mintId: () => uuidv7(Date.now()),
    });
    migrations.set(this, migration);
    // AWAITED, not fire-and-forget: until the persisted state is read,
    // isCutOver() would answer from the default (not cut over), so on a vault
    // that HAS cut over a legacy write could slip through the load window — and
    // a swallowed load failure would leave two standing writers permanently. A
    // loadState failure itself reads as corrupt inside the store and fails
    // toward fewer writers.
    await migration.loadState();
    setLegacyWriteGuard(this, () => !migration.isCutOver());

    // ── the transformation registry + promotion evidence store (WP10a) ───────
    // The registry ships EMPTY: real transformations arrive by their own
    // reviewed registrations. ONE predicate registry, shared by admission
    // verification and the transformation registry — "the declared verifier is
    // registered" and "admission can run it" stay one fact by construction.
    const predicateRegistry = createDefaultPredicateRegistry();
    const transformationRegistry = createTransformationRegistry(predicateRegistry);
    const principal = () => governanceAcceptanceSettings(this.settings.config).acceptedBy;

    promotionUiFactories.set(this, () =>
      buildPromotionUi({ registry: transformationRegistry, store: promotionStore, principal })
    );

    admissionFactories.set(this, () =>
      buildAdmission({
        repo: lazyHistoryRepo,
        predicates: predicateRegistry,
        promotion: {
          transformationOf: (id, version) => transformationRegistry.get(id, version),
          recordEvidence: (tuple, evidence, at) => promotionStore.recordEvidence(tuple, evidence, at),
          verdictOf: (tuple) => promotionStore.verdictOf(tuple),
        },
        // WP10b: the mandate door's stores. The wiring's context resolver reads
        // these; every failure refuses the automatic path, loudly.
        mandates: {
          get: (id) => mandateStore.getMandate(id),
          usageOf: (id) => mandateStore.usageOf(id),
          charge: (id, delta, at) => mandateStore.charge(id, delta, at),
          markExhausted: (id, breach, at) => mandateStore.markExhausted(id, breach, at),
        },
        claimIo: claimsChain,
        proposals: proposalStore,
        readNoteBytes: async (path) => {
          if (!(await adapter.exists(path))) return null;
          return new TextEncoder().encode(await adapter.read(path));
        },
        writeNoteBytes: async (path, bytes) => {
          // Through the VAULT API, not the raw adapter: vault.modify fires the
          // modify event, so the written-back bytes surface through the ordinary
          // review machinery (classifier → queue) instead of landing silently. A
          // revert is a change like any other — D06.
          const file = this.app.vault.getAbstractFileByPath(path);
          const text = new TextDecoder().decode(bytes);
          if (file instanceof TFile) await this.app.vault.modify(file, text);
          else await this.app.vault.create(path, text);
        },
        appendSettlement: (record) => acceptanceChain.appendRaw(JSON.stringify(record) + "\n"),
        refreshProjections: async () => nudgeGovernanceQueue(this),
        bindingGate: async () => {
          const verdict = await migration.binding();
          if (verdict.state === "pre-cutover" || verdict.state === "bound") return { ok: true } as const;
          return { ok: false as const, code: verdict.state === "marker-unbound" ? "marker_unbound" : "store_mismatch", detail: verdict.detail };
        },
      })
    );

    mandateUiFactories.set(this, () =>
      buildMandateUi({
        store: mandateStore,
        attachSessionMandate: (sessionId, mandateId, now) => sessionStore.attachMandate(sessionId, mandateId, now),
        principal,
      })
    );

    // ── the seam registrations ───────────────────────────────────────────────
    //
    // In-tree at S2 these two looked like ordinary wiring in the host's own
    // composition root. That was the point: everything the host used to do FOR
    // the provider already happened THROUGH the seam, so the split changed who
    // calls these two lines and nothing else. This is that change.
    //
    // The disposer is handed to `this.register`, so a plugin unload revokes both
    // hooks — a stale observer holding a dead provider's stores is worse than no
    // observer, and after the split "dead" is a real state a human reaches with
    // one click in Obsidian's settings.
    // #261's DRIVE, re-established on this side of the split. Chromium
    // throttles and suspends renderer timers while the Obsidian window is
    // occluded, so the review queue's 2.5s poll simply does not tick during
    // unattended sessions — which is exactly when agents write. Before the
    // split the host solved that by nudging the queue from inside its
    // `journal.append` wrapper: a timer-free event that fires precisely when
    // there is new work.
    //
    // The host cannot do that any more, and no journal-growth hook was added to
    // the seam for it. The signal it uses instead is the one the seam ALREADY
    // carries: the write observer fires after the host's own journal append, for
    // every completed write, so nudging from there is the same event arriving
    // through an existing hook rather than a new one.
    //
    // THE NARROWING, stated because it is real: the old nudge fired on EVERY
    // journal append, including ones that take no queue slot (idempotent
    // replays, deduped waiters, key mismatches) and mutating operations that
    // are not native note-writes. The observer fires only where the host
    // produced write facts. So an occluded window now sees the queue driven by
    // note-writes alone, and everything else waits for the poll. That covers
    // what the queue is for — proposals come from write facts, and the
    // mandated-admission sweep acts on proposals — but it is less than before,
    // and closing it properly means a journal-growth fact on the seam, which is
    // a design conversation and not a patch.
    const observer = this.buildProposalObserver({ proposalStore, sessionStore, mandateStore, lazyHistoryRepo, vaultName });

    this.register(
      registerGovernance(this, {
        // WHAT CROSSES OUTWARD: the exact bytes of a completed write, turned
        // into a proposal by the WP6b-1 machinery, verbatim.
        writeObserver: async (facts) => {
          try {
            await observer(facts);
          } finally {
            // AFTER the producer, and in a `finally`: a proposal that failed to
            // open is still a journal record the queue should surface, and a
            // nudge is a no-op while the pane is unmounted.
            nudgeGovernanceQueue(this);
          }
        },
        // WHAT CROSSES INWARD: a refusal, and only a refusal, answered from
        // the STORE, where a human's Revoke lands. A store read error is
        // silence at dequeue and a refusal before a rotation: see
        // wiring/session-refusal.ts.
        sessionRefusal: sessionRefusalFrom(sessionStore),
      })
    );

    // ── the published tool surface ───────────────────────────────────────────
    //
    // Five tools, through `vault-mcp-api`, exactly like any third-party
    // publisher — and under their SHIPPED NAMES, because the host carries a
    // closed grandfather table naming these five spellings and this plugin id as
    // the only owner allowed to publish them unprefixed.
    //
    // What that does NOT buy them is any special standing: they register through
    // the same guarded path, the same queue, the same journal and the same
    // kernel arguments as every other external tool, and the same F3 gate blocks
    // the four pathless ones outright while a path allowlist is active.
    this.register(
      publishTools(this, [
        ...buildPendingReviewTools({ source: obsidianPendingReviewSource(this.app, pluginDir) }),
        ...buildRevisionTools(
          {
            read: async (p) => {
              const f = this.app.vault.getAbstractFileByPath(p);
              return f instanceof TFile ? this.app.vault.read(f) : null;
            },
            write: async (p, content) => {
              const f = this.app.vault.getAbstractFileByPath(p);
              if (!(f instanceof TFile)) throw new Error(`not a note: ${p}`);
              await this.app.vault.process(f, () => content);
            },
            now: () => new Date(),
          },
          {
            listNotes: async () =>
              this.app.vault.getMarkdownFiles().map((f) => ({
                path: f.path,
                frontmatter: (this.app.metadataCache.getFileCache(f)?.frontmatter ?? null) as Record<string, unknown> | null,
              })),
            read: async (p) => {
              const f = this.app.vault.getAbstractFileByPath(p);
              return f instanceof TFile ? this.app.vault.read(f) : null;
            },
          }
        ),
        ...buildMandateTools({
          draft: (d, now) => mandateStore.draft(d, now),
          allDrafts: () => mandateStore.allDrafts(),
          allMandates: () => mandateStore.allMandates(),
          usageOf: (id) => mandateStore.usageOf(id),
          // A published tool does not learn which connection is calling, so a
          // draft that omits `delegate` is refused rather than bound to a
          // guess. See MandateToolsSource.sessionId.
          sessionId: () => null,
          client: () => null,
          now: () => Date.now(),
        }),
      ])
    );

    this.addSettingTab(new GovernorSettingTab(this.app, this));

    if (this.settings.enabled) void this.setPaneMounted(true);
  }

  /**
   * The proposal producer, behind the seam. Built here rather than inline so the
   * registration above reads as the two hooks it is.
   */
  private buildProposalObserver(deps: {
    proposalStore: ReturnType<typeof createProposalStore>;
    sessionStore: ReturnType<typeof createSessionStore>;
    mandateStore: ReturnType<typeof createMandateStore>;
    lazyHistoryRepo: () => Promise<HistoryRepository>;
    vaultName: string;
  }): (facts: WriteFacts) => void | Promise<void> {
    const { proposalStore, sessionStore, mandateStore, lazyHistoryRepo, vaultName } = deps;
    return createProposalObserver({
      historyEnabled: () => this.settings.historyEnabled === true,
      proposals: {
        open: (proposal, now) => proposalStore.open(proposal, now),
        uidOf: (path: string) => {
          const uid = (this.app.metadataCache.getCache(path)?.frontmatter as Record<string, unknown> | undefined)?.uid;
          return typeof uid === "string" && uid.length > 0 ? uid : null;
        },
        vaultId: vaultName,
        // Record the proposal's base and proposed snapshots in the history store
        // (WP4 consumed at last), returning the recording ref — the evidence
        // admission-time verification replays base bytes from, because the write
        // itself destroys them. Null when the path is outside the effective
        // history scope: an untracked path is ungoverned by the new system, and
        // the producer skips the proposal rather than opening a dead one.
        record: async (proposalId: string, path: string, baseBytes: Uint8Array | null, proposedBytes: Uint8Array) => {
          // The HOST's configured territories (#397), read live through its api —
          // the same list the pane, proposals and auto-accept use, and the same one
          // the host's own capture gate consults. There is no built-in default to
          // fall back to: when the host cannot be asked (`null` — absent, not yet
          // loaded, too old), NOTHING is recorded, the same fail-closed answer
          // `excludedUnderHost` gives the pane. Reading "no answer" as "no
          // territories" would make a missing host the one state that writes the
          // legal material into the standing chain (review of #396).
          const hostList = hostGuardedTerritories((this.app as any)?.plugins?.plugins);
          if (hostList === null) return null;
          const scope = effectiveScope(this.settings.historyScope, resolveTerritories(hostList));
          if (!isTracked(scope, path)) return null;
          const repo = await lazyHistoryRepo();
          const ref = proposalRef(proposalId);
          // Base first (recorded-missing for a creation), proposed chained on it
          // — the ref chain IS the diff, and stock git can read both.
          const base = await repo.recordSnapshot({
            ref,
            files: [{ path, bytes: baseBytes }],
            message: `base for proposal ${proposalId}`,
            timestamp: Math.floor(Date.now() / 1000),
            expectedRef: null,
          });
          await repo.recordSnapshot({
            ref,
            files: [{ path, bytes: proposedBytes }],
            message: `proposed for proposal ${proposalId}`,
            timestamp: Math.floor(Date.now() / 1000),
            expectedRef: base.oid,
          });
          return ref;
        },
      },
      // The producer's mandate stamp reads the session→mandate binding by ID.
      // Since the split this plugin no longer witnesses session OPEN, so the
      // binding is folded from the `mandated` events it writes itself rather
      // than from a session record — see session-store.ts's authority fold.
      sessions: { get: async (id: string) => ({ mandateId: await sessionStore.mandateOf(id) }) },
      mandates: {
        getMandate: (id: string) => mandateStore.getMandate(id),
        usageOf: (id: string) => mandateStore.usageOf(id),
        // WP10b producer charge: usage recorded, then the breach observed into
        // the durable `exhausted` transition — a spent budget STOPS (normal
        // stop), it never silently keeps counting.
        chargeAndObserve: async (id: string, delta: { items: number; proposals: number; bytes: number }) => {
          const at = Date.now();
          await mandateStore.charge(id, delta, at);
          const m = await mandateStore.getMandate(id);
          if (m && m.status === "active") {
            const breach = budgetBreach(m.terms.budgets, await mandateStore.usageOf(id), m.activatedAt, at);
            if (breach !== null) await mandateStore.markExhausted(id, breach.detail, at);
          }
        },
      },
    });
  }

  /**
   * Drive the review pane's mount state, live, without a plugin reload.
   * Idempotent and serialized so a rapid enable→disable cannot interleave a
   * mount with a teardown. Unmount is `removeChild`, which runs every cleanup
   * the Component registered — detaching open leaves (dropping the sole
   * reference to the accept-capable controller), unregistering the view type,
   * removing the ribbon, cancelling the interval. The accept boundary is
   * preserved across the cycle: mount/unmount changes only WHETHER the pane
   * exists, never HOW its gesture-gated controls are reached.
   */
  async setPaneMounted(enabled: boolean): Promise<void> {
    const next = this.paneReconcile.then(() => this.applyPaneMount(enabled));
    this.paneReconcile = next.catch(() => {});
    await next;
  }

  private async applyPaneMount(enabled: boolean): Promise<void> {
    const mounted = this.paneComponent !== null;
    if (mounted === enabled) return;
    if (enabled) {
      // The review queue is DERIVED from the host's write journal. With no host
      // loaded there is no journal to derive it from, and a pane showing a
      // permanently empty queue while saying nothing about why is the
      // silent-zero class this repo has paid for twice. Refuse to mount and say
      // so.
      const hostDir = this.hostPluginDir();
      if (hostDir === null) {
        new Notice(
          "Governor: the Vault MCP host plugin is not loaded, so there is no write journal to derive the review queue from. Enable Vault MCP, then turn the review pane back on.",
          0
        );
        return;
      }
      try {
        this.paneComponent = await wireGovernance(this, {
          getConfig: () => this.settings.config,
          journalDir: `${hostDir}/journal`,
          // Built fresh per mount, handed as an argument (§9: never a property).
          admission: admissionFactories.get(this)?.(),
          mandates: mandateUiFactories.get(this)?.(),
          promotion: promotionUiFactories.get(this)?.(),
          migration: migrations.get(this),
        });
      } catch (e) {
        console.error("[governor] review pane wiring failed", e);
        this.paneComponent = null;
      }
    } else {
      this.removeChild(this.paneComponent!);
      this.paneComponent = null;
    }
  }
}

export { DEFAULT_GOVERNOR_SETTINGS };
