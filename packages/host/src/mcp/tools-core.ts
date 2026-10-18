// obsidian_resolve and obsidian_get_backlinks have been migrated to
// registerFsTools + ObsidianBackend in server.ts (fs-expressible tools).
// This file retains only obsidian_doctor and obsidian_get_active_note
// (live-only: they use workspace/app state not expressible on the filesystem).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App, TFile } from "obsidian";
import { ok, fail } from "./helpers.js";
import { isVisible, type GuardSettings } from "../guard.js";
import type { ExternalToolEntry } from "./external-tools.js";
import type { Kernel, ModuleSettings, ServerIdentity } from "../kernel/index.js";
import { findObsidianBinary } from "./tools-cli.js";
import type { SchemeInstanceConfig } from "../kernel/scheme/registry.js";
import type { CliCommandPolicy } from "./cli-policy.js";
import type { SeamConsult } from "./seam.js";
import { judgeSync, normalizeSyncGuard, readSyncSnapshot, type SyncGuardSettings, type SyncSnapshot, type SyncVerdict } from "../kernel/sync-guard.js";

export interface ServerCtx {
  pluginVersion: string;
  socketPath: string;
  vaultName: string;
  /** The plugin's own directory (`<config dir>/plugins/vault-mcp` unless Obsidian's manifest
   * says otherwise) — where plugin-owned state files live (journal, governance). Optional:
   * absent in tests; consumers fall back to the default plugin path. */
  pluginDir?: string;
  enabledPlugins: () => string[];
  /**
   * Guard settings plus policy gates:
   *   `allowDangerousCli`        — obsidian_cli's danger gate.
   *   `trustedReadOnlyPlugins`   — plugin ids whose `readOnlyHint: true` is
   *                                believed. Any other publisher's read-only
   *                                claim is distrusted; see external-tools.ts.
   *   `schemes`                  — scope-provider instance configs (id +
   *                                provider + per-provider config), fed to
   *                                kernel/scheme/registry.ts's makeRegistry.
   *                                Optional here for the same reason the rest
   *                                of this bag is optional: absent in tests
   *                                that don't exercise scheme tools.
   */
  getSettings: () => GuardSettings & {
    allowDangerousCli?: boolean;
    /** Register the raw `obsidian_cli` proxy. DEFAULT OFF — the dedicated
     * pinned-subcommand tools (tools-cli-dedicated.ts / tools-snippets.ts)
     * cover the real usage; the free-text proxy is a surface a human opts
     * back into (Security › "Raw CLI proxy"). */
    rawCliProxy?: boolean;
    trustedReadOnlyPlugins?: string[];
    /** The connection profiles whose replies pass through the secret scanner (core's
     * redaction.ts). Absent or empty ⇒ off, the default. Read when a connection is built. */
    redactProfiles?: string[];
    /** The secret scanner config as JSON text (core's SecretScanConfig). Blank ⇒ the shipped defaults. */
    redactConfig?: string;
    schemes?: SchemeInstanceConfig[];
    /** Module-host rows (`modules.<id>.enabled` / `.config`) — the mount
     * (mcp/modules-mount.ts) reads these; absent ⇒ every built-in module at
     * its default. */
    modules?: ModuleSettings;
    /** Command policy for obsidian_cli / obsidian_run_command
     * (mcp/cli-policy.ts). Absent ⇒ the defaults: the opaque-accept set
     * denied, everything else allowed. */
    cliPolicy?: CliCommandPolicy;
  /** Capture the exact bytes a native read returned. Default off — see main.ts. */
  captureObservations?: boolean;
  /** Stopgap ceiling on total captured bytes, pending real retention. */
  captureMaxBytes?: number;
  /** Guarded territories, as the operator configured them. There is no
   * default: blank/absent means NOTHING is guarded (#397). Resolve with
   * `resolveTerritories` and never match on the raw array — a stray blank
   * entry would match every path. */
  guardedTerritories?: string[];
  // `historyEnabled` / `historyScope` were here until S3c. They were always the
  // GOVERNANCE PROVIDER's facts — the Git history store, its D10 scope, and the
  // decision to record at all belong to whoever owns the standing chain — and
  // nothing host-side ever read them except the composition root that built the
  // provider's proposal observer. They now live in the provider's own settings.
  };
  /**
   * The two record settings, each read live per call through its OWN thunk,
   * the way main.ts hands them to the kernel's guard probe — not through
   * `getSettings`, which withholds them on purpose (tests/settings-projection
   * WITHHELD). They were `getSettings` fields until PR #455's review found the
   * projection never forwarded them: every connection then judged records by
   * the shipped default whatever the operator had set.
   *   `enforceRecordImmutability` (#264): absent, or anything but an explicit
   *     `false` ⇒ ENFORCED, so a caller that never wired it fails toward
   *     protection.
   *   `recordIdentification` (#397): how a note declares itself a record;
   *     coerced through `normalizeRecordIdentification` wherever read, absent ⇒
   *     the shipped default (`record: true`).
   */
  enforceRecordImmutability?: () => boolean;
  recordIdentification?: () => unknown;
  /** `recordFolders` (#482): the folder indicator; coerced through `normalizeRecordFolders`, absent ⇒ today's defaults. */
  recordFolders?: () => unknown;
  /** The Sync guard's settings (kernel/sync-guard.ts), live per call; coerced through `normalizeSyncGuard`; absent ⇒ off. */
  syncGuard?: () => unknown;
  /** The vault-relative path of flow.js for obsidian_create_note (#531); empty or absent ⇒ the tool is not registered. */
  createNoteFlow?: () => string;
  /** The `host` setting (headless.ts): headless mode, path overrides, the claude registration switch. */
  host?: () => unknown;
  // `getVocabularies` was here until the read-tier satellite extraction (suite
  // split, S7). It carried `settings.vocabularies` to the vocab module's tool
  // layer; that module is now the `vaultmcp-vocab` plugin, which owns its own
  // copy of the list, so nothing on this context needs it.
  /** Externally-published tools (other Obsidian plugins via plugin.api). Optional: absent in tests that don't exercise it. */
  getExternalTools?: () => ExternalToolEntry[];
  /**
   * Kernel v0: the PLUGIN-SINGLETON write queue + journal. It must be created
   * once in main.ts and shared by every connection's server — a per-connection
   * kernel would serialize nothing, since concurrent sessions are exactly what
   * the queue exists to order. Optional: absent in tests that don't exercise it.
   */
  kernel?: Kernel;
  /**
   * Kernel v0 server identity — `{vault, install, version}`, stamped into every
   * journal record's actor block. Resolved once at plugin load (main.ts);
   * absent in tests that don't exercise it.
   */
  serverIdentity?: ServerIdentity;
  /**
   * Session machinery (WP5): the durable store plus the facts needed to open
   * one per connection. Absent in tests/bare embeds — everything session-
   * shaped degrades to "no session", never to a crash.
   *
   * LIFECYCLE ONLY, since S2 (condition 7 — the host mints). The port records
   * what the host does to a session it owns: opened, closed, expired. There is
   * no `get`, deliberately: reading the durable record to decide whether a
   * queued mutation may proceed is asking PERMISSION, and permission is the
   * governance provider's question, answered through the seam's refusal hook.
   * The host keeps only its own expiry floor, which needs no store at all.
   */
  sessions?: {
    open(session: import("@vault-mcp/core").SessionV1, now: number): Promise<void>;
    close(sessionId: string, now: number): Promise<void>;
    markExpired(sessionId: string, now: number): Promise<void>;
    replicaId: string;
    vaultId: string;
    /** The journal's current head marker, for the session's base state. */
    journalHead(): string | null;
  };
  /**
   * THE GOVERNANCE SEAM's consultation half (S2, docs/suite-split-design.md
   * §5). Absent ⇒ no provider is installed and nothing is consulted: every
   * consultation iterates a possibly-empty hook list, so the standalone host is
   * the vacuous case rather than a special one (rule 4).
   *
   * This carries no provider type and no provider capability — `mcp/seam.ts` is
   * host-owned, and what crosses it is bytes, identifiers and refusals.
   */
  seam?: SeamConsult;
  /**
   * NOTE what is deliberately ABSENT here, and where it went (suite split, S2):
   *
   *   `mandates`  — the WP9 draft/list port. It exists so the mandate TOOLS can
   *                 reach the provider's store, and it named three provider
   *                 types to do it. Those tools now register through
   *                 `BuildOpts.providerTools`, as registrars the composition
   *                 root closes over its own stores — so the host's context no
   *                 longer describes the provider's data model.
   *   `proposals` — the WP6b-1 production port. Proposal production moved
   *                 behind the seam entirely (`registerWriteObserver`), so the
   *                 host reports write facts and knows nothing about what is
   *                 made of them.
   *
   * Between them plus the session contract moving host-side, `ServerCtx` names
   * ZERO governance-provider types, which is S2's exit criterion. The remaining
   * host→governor imports are concentrated in `main.ts` (the composition root
   * S3 replaces with two plugin manifests) and a short list in `server.ts`.
   */
}

function syncGuardReport(settings: SyncGuardSettings, snap: SyncSnapshot, v: SyncVerdict, rename?: SyncVerdict): Record<string, unknown> {
  // Shown, not judged for a create (#528): the status text and how many server changes wait, vault-wide.
  // `sync_rename` is the verdict a rename, move or delete meets, which also needs "Fully synced" (#533).
  const f = snap.state === "fields" ? snap.fields : null;
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    wait_seconds: settings.waitSeconds,
    strict_wait_seconds: settings.strictWaitSeconds,
    on_unknown: settings.onUnknown,
    sync: v.kind,
    ...(v.kind === "behind" ? { status: v.status } : {}),
    ...(v.kind === "unknown" ? { why: v.why } : {}),
    ...(f && typeof f.syncStatus === "string" ? { status_text: f.syncStatus } : {}),
    ...(f && Array.isArray(f.pendingPaths) ? { pending_downloads: f.pendingPaths.length } : {}),
    ...(rename ? { sync_rename: rename.kind } : {}),
  };
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerCoreTools(server: McpServer, app: App, ctx: ServerCtx) {
  server.registerTool(
    "obsidian_doctor",
    {
      title: "Diagnostics",
      description: "Report vault-mcp health: socket path, bound vault, plugin version, and which integration plugins are detected. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const integrations = ["dataview", "templater-obsidian", "omnisearch", "metadata-menu"];
        const enabled = new Set(ctx.enabledPlugins());
        return ok({
          status: "ok",
          vault_name: ctx.vaultName,
          socket_path: ctx.socketPath,
          plugin_version: ctx.pluginVersion,
          integrations: Object.fromEntries(integrations.map((id) => [id, enabled.has(id)])),
          // obsidian_cli registers only when this is non-null — surfaced here so
          // its absence is diagnosable, like the integration gates above.
          cli_binary: findObsidianBinary(),
          // The Sync guard (01.43): its settings and what it reads of Obsidian
          // Sync now — off, synced, behind (with the status) or unknown (with
          // why: an Obsidian update can change the internal fields). Only the
          // verdict travels, never the Sync plugin's object.
          sync_guard: (() => {
            const snap = readSyncSnapshot(app);
            const now = Date.now();
            return syncGuardReport(normalizeSyncGuard(ctx.syncGuard?.()), snap, judgeSync(snap, now), judgeSync(snap, now, [], false, true));
          })(),
        });
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    "obsidian_get_active_note",
    {
      title: "Get active note",
      description:
        "Return the currently focused note's path, content, and the current editor selection (if any). Read-only. " +
        "Returns {active: null} when nothing is focused — or when what is focused lies outside your path allowlist.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const file = app.workspace.getActiveFile();
        // The focus is the HUMAN's, not the caller's, and this tool takes no
        // argument the guard could check — so an allowlisted session could read
        // any note simply by asking while its owner had it open. A hidden note
        // reads as "nothing is focused": the same answer, so not even the fact
        // that something is open leaks.
        if (!file || !isVisible(file.path, ctx.getSettings())) return ok({ active: null });
        const content = await app.vault.read(file as TFile);
        // Selection, if a markdown editor is focused.
        let selection: string | null = null;
        const mv = app.workspace.activeEditor;
        if (mv?.editor) selection = mv.editor.getSelection() || null;
        return ok({ active: { path: file.path, content, selection } });
      } catch (e) { return fail(e); }
    }
  );
}
