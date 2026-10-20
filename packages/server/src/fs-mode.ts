/**
 * fs-mode.ts — stateless FS-mode MCP handler factory.
 *
 * Extracts the per-request MCP handling from index.ts into a reusable factory
 * so the unified front (Task 5) can call it when Obsidian is offline.
 *
 * Usage:
 *   const fs = createFsHandler();
 *   await fs.ready();         // one-time: buildIndex + startVaultWatcher
 *   app.post("/mcp", (req, res) => fs.handle(req, res));
 *   // on shutdown:
 *   await fs.stop();          // closes the vault watcher
 *
 * The factory is behavior-preserving: handle() reproduces the per-request
 * logic that index.ts:buildServer() + the POST /mcp handler used to inline.
 * Response shapes are identical.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import {
  listNotes,
  readNote,
  writeNote,
  appendNote,
  searchNotes,
  findByTag,
  vaultRoot,
  getFrontmatterField,
  setFrontmatterField,
  deleteFrontmatterField,
  patchNote,
  deleteNote,
  moveNote,
  listFolders,
  buildIndex,
  indexStatus,
  resolveRefs,
  getBacklinks,
  getOutlinks,
  searchByFrontmatter,
  startVaultWatcher,
  registerFsTools,
  cutReadError,
  wholeNoteOverwriteRefusal,
  noteLengthFrom,
  readNoteWhole,
  CHARACTER_LIMIT,
  resolveInVault,
  normalizeWriteScope,
  writeScopeRefusal,
  resolveProfile,
  messageConfigFromEnv,
  scannerFor,
  writeFile,
  editFile,
  moveFile,
  registerFileTools,
} from "@vault-mcp/core";
import type { Redaction } from "@vault-mcp/core";
import { loadRedaction } from "./redaction-env.js";
import { profileOf } from "./profiles.js";
import { existsSync } from "node:fs";
import type { VaultBackend, VaultWatcherHandle, FileBackend } from "@vault-mcp/core";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { FsWriteKernel, defaultJournalDir } from "./fs-write-kernel.js";

/** This server's version, as asserted in MCP serverInfo and journal identity. */
const SERVER_VERSION = "1.0.0";

// ── Public interface ──────────────────────────────────────────────────────────

export interface FsHandler {
  /** Per-request handler: builds a fresh stateless McpServer and serves it. */
  handle(req: express.Request, res: express.Response): Promise<void>;

  /**
   * One-time startup: runs buildIndex() + startVaultWatcher(). Idempotent —
   * calling twice returns the same Promise without rebuilding.
   */
  ready(): Promise<void>;

  /**
   * Close the vault watcher, and cancel a ready() still in flight (#583): a
   * build or watcher start that has not finished when stop() runs never leaves
   * a watcher behind. Resolves once that in-flight ready() has settled and
   * every watcher it started is closed. Idempotent; re-arms ready().
   */
  stop(): Promise<void>;

  /** Whether a vault watcher is open, or a ready() that may open one is still running (the front's EBADF check, tests). */
  watching(): boolean;
}

export interface FsHandlerOpts {
  /**
   * The connection profile's name (#521; core's profile.ts). Absent ⇒ `full`. The handler sets it
   * per request from the front's profile gate; an unknown name builds no tools at all.
   */
  profile?: string;
  /**
   * When true (the default), pass `indexStatus` to registerFsTools so every
   * read-tool response includes an `index_status` block. Set to false to
   * suppress it (e.g., when the live Obsidian backend is active).
   */
  indexStatus?: boolean;
  /**
   * Explicit override for whether FS-mode writes are permitted (issue #92).
   * Omitted (the normal case) ⇒ resolved from `isFsWritesEnabled()` (the
   * `VAULT_MCP_FS_ALLOW_WRITES` env var) at the moment `buildFsServer()`
   * constructs the backend — so every FS-server entry point picks up the
   * same deployment-wide setting without being wired individually. The
   * granularity differs by caller: `createFsHandler().handle()` calls
   * `buildFsServer(opts)` fresh per HTTP request, so it re-reads the env var
   * every time; `semantic-proxy.ts`'s `getFsClient()` builds its FS backend
   * once and caches it for the process's lifetime (until `stop()`), so a
   * mid-process env var change there only takes effect after a restart. Set
   * `allowWrites` explicitly only for tests or callers that need a value
   * independent of the env var.
   */
  allowWrites?: boolean;
  /**
   * Explicit FsWriteKernel override (tests). Omitted ⇒ the process-wide
   * singleton from getFsWriteKernel(), which is what gives FS-mode writes
   * cross-connection serialization — every per-request server built by this
   * factory shares the one queue and the one journal.
   */
  kernel?: FsWriteKernel;
  /**
   * The secret scanner settings (core's redaction.ts). Omitted ⇒ read from the environment
   * (redaction-env.ts: VAULT_MCP_REDACT_PROFILES, VAULT_MCP_REDACT_CONFIG; off when unset);
   * `null` ⇒ off. Settings that are refused throw when the server is built (fail closed).
   */
  redaction?: Redaction | null;
  /**
   * Whether the vault watcher may start now (#583). The front passes "presence is down": in LIVE
   * mode no watcher may run, so a ready() run while the plugin is reachable (an FS request routed
   * just before "up") builds the index but starts no watcher, and the next ready() tries again.
   * Checked before the watcher starts and again once it has started. Absent ⇒ always allowed.
   */
  watchAllowed?: () => boolean;
}

// ── FS-mode write gate + write kernel (issue #92) ───────────────────────────
//
// FS-fallback mode used to have no journal and no serialized write queue:
// those live in the plugin's kernel (packages/host/src/kernel/), and
// packages/server depends on @vault-mcp/core + third-party only — it does not,
// and must not, depend on the host plugin package. That gap is now closed at the
// queue+journal level by fs-write-kernel.ts, a lean server-local counterpart:
// every FS-mode mutation runs through one process-wide FIFO queue and appends
// exactly one JSONL record to the server-side journal
// (`~/.claude/vault-mcp/journal/<slug>/YYYY-MM.jsonl` by default).
//
// The opt-in gate REMAINS, because journal+queue is not full kernel parity:
// FS-mode writes still bypass the plugin kernel's governance surface (if_rev
// preconditions, idempotency keys, advisory locks, the pending-review flow),
// and serialization is in-process only — nothing here can serialize against a
// concurrently running Obsidian or a second server process. Writes are
// refused by default, with a typed refusal that names the residual gap and
// how to opt in. Reads are never gated — FS-mode read fallback keeps working
// exactly as before.

/**
 * The process-wide FS write kernel — lazy, so a read-only FS session (or a
 * deployment that never opts into FS writes) creates nothing. Env-derived
 * configuration (journal dir, vault name) is read once at first use and cached
 * for the process's lifetime, same convention as semantic-proxy's cached FS
 * backend.
 */
let processKernel: FsWriteKernel | null = null;

export function getFsWriteKernel(): FsWriteKernel {
  if (!processKernel) {
    const vaultName = path.basename(vaultRoot());
    processKernel = new FsWriteKernel({
      journalDir: defaultJournalDir(vaultName),
      identity: { vault: vaultName, version: SERVER_VERSION },
      // Through the vault's resolver: an escaping path is never stat'ed for
      // the journal's revBefore (its throw is swallowed by the kernel's
      // revOf, which then records no rev) (#444).
      resolvePath: (relPath) => resolveInVault(relPath),
    });
  }
  return processKernel;
}

/**
 * The write scope on this transport (core's write-scope.ts): the same value as the
 * plugin's `writeScope` setting, as JSON in one environment variable, e.g.
 * `{"mode":"create-only","paths":["**\/[0-9][0-9].01 Inbox/*.md"]}`. Unset or
 * unreadable ⇒ no write rule (mode "all"), as the plugin's default. Read per call.
 */
export const WRITE_SCOPE_ENV_VAR = "VAULT_MCP_WRITE_SCOPE";

export function fsWriteScope(env: NodeJS.ProcessEnv = process.env) {
  const raw = env[WRITE_SCOPE_ENV_VAR]?.trim();
  if (!raw) return normalizeWriteScope(undefined);
  try {
    return normalizeWriteScope(JSON.parse(raw));
  } catch {
    // A value that does not parse must not OPEN writes it was meant to close: refuse every write.
    return { mode: "create-only" as const, paths: [] };
  }
}

/** A write-scope refusal, rendered `Error [write_scope]: …` by core's fail(). */
export class WriteScopeError extends Error {
  readonly code = "write_scope";
  constructor(message: string) {
    super(message);
    this.name = "WriteScopeError";
  }
}

/** Env var that opts a deployment into FS-mode writes. Unset/falsy ⇒ refused. */
export const FS_WRITES_ENV_VAR = "VAULT_MCP_FS_ALLOW_WRITES";

/**
 * True if `VAULT_MCP_FS_ALLOW_WRITES` is set to a truthy value. Read from
 * process.env at call time (same convention as auth.ts's
 * `isAllowAnyAuthenticated` / front.ts's `VAULT_MCP_SEAMLESS` parsing) so
 * entrypoints and tests can check it after startup.
 */
export function isFsWritesEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    (process.env[FS_WRITES_ENV_VAR] ?? "").trim().toLowerCase(),
  );
}

/**
 * Typed refusal for a write attempted in FS-fallback mode without opting in —
 * rendered as `Error [fs_writes_disabled]: …` by core's `fail()`. The message
 * explains the gap and how to enable it deliberately; it names no vault path
 * and no configuration value the caller isn't already entitled to (the env
 * var name is documentation, not a secret).
 */
export class FsWritesDisabledError extends Error {
  readonly code = "fs_writes_disabled";
  constructor() {
    super(
      "FS-fallback mode is a degraded write path: Obsidian is offline, so there is no plugin " +
        "kernel to route through. FS-mode writes are serialized in-process and journaled to the " +
        "server-side write journal, but they still bypass the kernel's governance surface " +
        "(if_rev preconditions, idempotency keys, advisory locks, pending review) and cannot be " +
        `serialized against other processes. Refused by default. Set ${FS_WRITES_ENV_VAR}=true ` +
        "to opt in deliberately, understanding that writes made this way carry only queue+journal " +
        "guarantees until Obsidian reconnects and LIVE mode resumes.",
    );
    this.name = "FsWritesDisabledError";
  }
}

// ── VaultBackend adapter ──────────────────────────────────────────────────────
//
// Wraps the module-level singleton functions from @vault-mcp/core so that
// registerFsTools can drive them through the VaultBackend interface. The
// singletons are pinned to VAULT_PATH at process start, which is the same
// root the vault watcher uses — keeping the index consistent.

/**
 * No memory of whole reads on this transport (#443, #446): its servers are
 * stateless per request and its writes carry no if_rev, so nothing could tie
 * a proof of a whole read to the caller, and a per-process memory would let
 * one client's whole read prove another client's overwrite. `full: true`
 * serves the whole note here; the whole-note policy stays until #446 gives
 * these writes a conditional form.
 */
export function makeBackend(
  opts: { allowWrites?: boolean; kernel?: FsWriteKernel } = {},
): VaultBackend & FileBackend {
  const allowWrites = opts.allowWrites ?? isFsWritesEnabled();
  const requireWrites = (): void => {
    if (!allowWrites) throw new FsWritesDisabledError();
  };

  /**
   * Route one mutating operation through the FS write kernel (issue #92):
   * gate first (a refusal runs nothing, so — like the plugin's pre-queue
   * refusals — it is not journaled), then queue + journal. The kernel resolves
   * lazily so a read-only session never instantiates it; the default is the
   * process-wide singleton, which is what serializes writes ACROSS the
   * stateless per-request servers this factory builds.
   */
  // A note's length in characters for the whole-note-overwrite rule (#441);
  // a file of at most CHARACTER_LIMIT bytes cannot exceed it, so only a
  // larger file is read (the rare case, and only on an overwrite of it). The
  // rule runs at dequeue (`mutate`), so the length is the one the write meets.
  const noteLength = async (rel: string): Promise<number | undefined> => {
    // Through the vault's own resolver, so a path that escapes the vault (or
    // names an ignored folder) is never stat'ed or read here: it throws and
    // the rule stands aside for the backend's own refusal.
    let abs: string;
    try {
      abs = resolveInVault(rel);
    } catch {
      return undefined;
    }
    // A note that does not exist is not bound; any other failure to learn
    // the length fails CLOSED — the rule protects a tail, and an unreadable
    // note must not switch it off.
    let size: number;
    try {
      size = (await fsp.stat(abs)).size;
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return undefined;
      throw e;
    }
    return noteLengthFrom(size, () => fsp.readFile(abs, "utf8"), CHARACTER_LIMIT);
  };
  const mutate = async <T>(
    op: string,
    target: { path?: string; paths?: string[] },
    args: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> => {
    requireWrites();
    // A malformed or escaping path is refused before the queue, typed
    // (`invalid_path`) by the vault's own resolver, unjournaled like every
    // argument refusal (#444): the kernel never queues or records an attempt
    // the vault would refuse. The paths are the op's own `target`, the same
    // set the journal records, so no key list has to be kept by hand.
    const targets = target.paths ?? (target.path ? [target.path] : []);
    for (const p of targets) resolveInVault(p);
    // The write scope, before the queue, as on the plugin: in create-only mode only a new note at
    // a path the scope names; every other write is refused, unjournaled.
    const scope = fsWriteScope();
    if (scope.mode !== "all") {
      const out = writeScopeRefusal(op, args, targets, scope, (p) => existsSync(resolveInVault(p)));
      if (out) throw new WriteScopeError(out.message);
    }
    // A cut read handed back as `content` is refused before the queue, as the
    // host's guard does (#441): unjournaled, like every argument refusal.
    const cut = cutReadError(args);
    if (cut) throw cut;
    const kernel = opts.kernel ?? getFsWriteKernel();
    // The whole-note-overwrite rule runs at DEQUEUE on this transport, as on
    // the plugin: the note's length must hold after every write queued ahead
    // has landed (a write ahead can push a note past the limit). No proof
    // of a whole read stands it aside here: this transport's writes carry no
    // if_rev, so nothing could tie a proof to the caller (#443, #446). A
    // long overwrite refused there is journaled as an error.
    return kernel.runMutation(op, target, args, async () => {
      const long = await wholeNoteOverwriteRefusal(args, noteLength, CHARACTER_LIMIT);
      if (long) throw long;
      return fn();
    });
  };

  return {
    listNotes: (subdir, limit, offset) => listNotes(subdir, limit, offset),

    listFolders: (subdir) => listFolders(subdir),

    readNote: (relPath) => readNote(relPath),

    readNoteWhole: (relPath) => readNoteWhole(relPath),

    searchNotes: (query, limit, mode) => searchNotes(query, limit, mode),

    findByTag: (tag, limit) => findByTag(tag, limit),

    searchByFrontmatter: async (property, value) => {
      const matches = searchByFrontmatter(property, value);
      return matches.map((n) => ({ path: n.path, frontmatter: n.frontmatter }));
    },

    resolve: (refs) => Promise.resolve(resolveRefs(refs)),

    getBacklinks: (notePath) => Promise.resolve(getBacklinks(notePath)),

    getOutlinks: (notePath) => Promise.resolve(getOutlinks(notePath)),

    forceReindex: () => buildIndex(),

    manageFrontmatter: async (relPath, key, op, value) => {
      if (op === "get") {
        return { value: await getFrontmatterField(relPath, key) };
      }
      // op names are the MCP tool names, so the FS journal greps like the
      // plugin's (only `set`/`delete` reach here — `get` returned above and,
      // like every read, is never queued and never journaled).
      return mutate(
        "obsidian_manage_frontmatter",
        { path: relPath },
        { path: relPath, key, op, ...(value !== undefined ? { value } : {}) },
        async () => {
          if (op === "delete") {
            return deleteFrontmatterField(relPath, key);
          }
          // op === "set"
          if (value === undefined) {
            throw new Error("`value` is required for op='set'");
          }
          return setFrontmatterField(relPath, key, value);
        },
      );
    },

    patchNote: async (relPath, anchor, op, content) =>
      mutate(
        "obsidian_patch_note",
        { path: relPath },
        { path: relPath, anchor, op, content },
        () => patchNote(relPath, anchor, op, content),
      ),

    writeNote: async (relPath, content, overwrite) =>
      mutate(
        "obsidian_write_note",
        { path: relPath },
        { path: relPath, content, overwrite },
        () => writeNote(relPath, content, overwrite),
      ),

    appendNote: async (relPath, content) =>
      mutate(
        "obsidian_append_note",
        { path: relPath },
        { path: relPath, content },
        () => appendNote(relPath, content),
      ),

    moveNote: async (fromRel, toRel, options) =>
      mutate(
        "obsidian_move_note",
        { path: fromRel, paths: [fromRel, toRel] },
        {
          from: fromRel,
          to: toRel,
          update_backlinks: options.update_backlinks,
          overwrite: options.overwrite,
        },
        () =>
          moveNote(fromRel, toRel, {
            update_backlinks: options.update_backlinks,
            overwrite: options.overwrite,
            backlinks_provider: getBacklinks,
            resolve_ref: (ref: string) => resolveRefs([ref])[0]?.path,
          }),
      ),

    deleteNote: async (relPath, confirm) =>
      mutate(
        "obsidian_delete_note",
        { path: relPath },
        { path: relPath, confirm },
        () => deleteNote(relPath, confirm),
      ),

    // .base and .canvas files (#575): the same gate, path check, write scope, cut-read check,
    // queue and journal as the note writes. There is no trash on this server, and its one
    // removal tool (obsidian_delete_note, a permanent delete) stays notes-only.
    writeFile: async (relPath, content, overwrite) =>
      mutate(
        "obsidian_write_file",
        { path: relPath },
        { path: relPath, content, overwrite },
        () => writeFile(relPath, content, overwrite),
      ),

    editFile: async (relPath, edit) =>
      mutate(
        "obsidian_edit_file",
        { path: relPath },
        { path: relPath, op: edit.op, ...(edit.key !== undefined ? { key: edit.key } : {}), ...(edit.item !== undefined ? { item_json: edit.item } : {}) },
        () => editFile(relPath, edit),
      ),

    moveFile: async (fromRel, toRel, options) =>
      mutate(
        "obsidian_move_file",
        { path: fromRel, paths: [fromRel, toRel] },
        { from: fromRel, to: toRel, update_backlinks: options.update_backlinks, overwrite: options.overwrite },
        () => moveFile(fromRel, toRel, options),
      ),
  };
}

/** Whether a vault-relative path exists; one the vault's resolver refuses reads as existing, so a create there is refused. */
function existsInVault(rel: string): boolean {
  try {
    return existsSync(resolveInVault(rel));
  } catch {
    return true;
  }
}

// ── Server factory ────────────────────────────────────────────────────────────
//
// Exported so tests can build a server and wire it over InMemoryTransport
// without standing up a full Express + HTTP stack.

export function buildFsServer(opts?: FsHandlerOpts): McpServer {
  const server = new McpServer(
    { name: "obsidian-vault-mcp-server", version: SERVER_VERSION },
    // listChanged: true is required by Phase 2b (notifications/tools/list_changed);
    // harmless in Phase 2a but declared now so the capability is advertised.
    { capabilities: { tools: { listChanged: true } } },
  );

  const profile = opts?.profile === undefined ? undefined : resolveProfile(opts.profile);
  // Off unless the settings name this connection's profile (`full` when none is given). Throws on
  // refused settings, so no server is built that would send replies unscanned.
  const redaction = opts?.redaction === undefined ? loadRedaction() : (opts.redaction ?? undefined);
  const scanner = scannerFor(redaction, profile?.name ?? "full");
  const backend = makeBackend({ allowWrites: opts?.allowWrites, kernel: opts?.kernel });
  registerFsTools(server, backend, {
    // The same per-connection filter the plugin applies at origRegister (#521).
    ...(profile ? { profile, exists: existsInVault } : {}),
    ...(scanner ? { scanner } : {}),
    decodeHtml: true,
    // This server has no kernel and no withKernelArgs: name the kernel arguments here, accepted and not checked.
    kernelArgs: true,
    includeIndexStatus: (opts?.indexStatus ?? true) ? indexStatus : undefined,
    // vaultmcp_send_message: registered only when the operator set a message URL and topic.
    message: messageConfigFromEnv(),
    // No `rev` hook and no whole-read memory: FS writes carry no if_rev, so
    // no read shows a rev and no proof of a whole read can be tied to a
    // caller (#443, #446). `full: true` still serves the whole note.
  });
  // obsidian_write_file / _edit_file / _move_file (#575): .base and .canvas files, under the same
  // profile, decoding and kernel-argument rules as the note tools above.
  // Their replies pass through the secret scanner too when it is on, as every other tool's do.
  const fileReg = scanner
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { registerTool: (name: string, meta: any, h: (args: any) => any) => server.registerTool(name, meta, scanner.wrap(h)) }
    : server;
  registerFileTools(fileReg, backend, {
    ...(profile ? { profile, exists: existsInVault } : {}),
    decodeHtml: true,
    kernelArgs: true,
    // A .base is a query (#580 review 1): not written, edited or moved while the write scope limits
    // paths. This server has no path allowlist; its write scope is the one path rule it has.
    pathScope: () => (fsWriteScope().mode !== "all" ? `the write scope (${WRITE_SCOPE_ENV_VAR})` : null),
  });

  return server;
}

// ── Handler factory ───────────────────────────────────────────────────────────

export function createFsHandler(opts?: FsHandlerOpts): FsHandler {
  let readyPromise: Promise<void> | null = null;
  let watcher: VaultWatcherHandle | null = null;
  // ready() runs not yet settled. A run counts from its first line until any
  // watcher it started and must drop is closed, so watching() is true for the
  // whole time a watcher may be open or about to open.
  let inFlight = 0;
  // The stop() still closing or waiting; every later stop() waits for it too.
  let pendingStop: Promise<void> | null = null;
  // Bumped by stop() (#583). A ready() run that was started under an older
  // generation is cancelled: it starts no watcher, and closes one it started.
  // Without it, a stop() that ran while buildIndex() or the watcher's start was
  // still in flight found `watcher` null, closed nothing, and the watcher that
  // started after it ran on into LIVE mode.
  let generation = 0;
  const watchAllowed = opts?.watchAllowed ?? (() => true);

  // Build the vault index + start the watcher. Idempotent; re-armed by stop().
  function ready(): Promise<void> {
    if (readyPromise) return readyPromise;
    const gen = generation;
    inFlight++;

    // Read inside the run only after its first await, by which time it is assigned.
    let run: Promise<void> | null = null;
    run = (async () => {
      try {
        await buildIndex();
        const s = indexStatus();
        console.error(
          `index: ${s.status} (${s.count} notes)${s.error ? ` — error: ${s.error}` : ""}`,
        );
        if (gen !== generation) {
          console.error("watcher: not started (FS handler stopped while the index was building)");
          return;
        }
        if (s.status !== "ready") {
          console.error("watcher: skipped (index not ready)");
          return;
        }
        if (!watchAllowed()) {
          console.error("watcher: not started (LIVE mode)");
          // Re-arm, so a later ready() in FS mode starts the watcher.
          if (readyPromise === run) readyPromise = null;
          return;
        }
        let w: VaultWatcherHandle;
        try {
          w = await startVaultWatcher({ vaultRoot: vaultRoot() });
        } catch (e) {
          console.error(
            `watcher: failed to start — ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
        if (gen !== generation || !watchAllowed()) {
          // stop() ran, or LIVE mode came back, while the watcher was starting: close it now.
          await closeWatcher(w);
          console.error("watcher: closed at once (stopped or LIVE mode while the watcher was starting)");
          if (gen === generation && readyPromise === run) readyPromise = null;
          return;
        }
        watcher = w;
      } finally {
        inFlight--;
      }
    })();
    readyPromise = run;

    return readyPromise;
  }

  async function closeWatcher(w: VaultWatcherHandle): Promise<void> {
    try {
      await w.stop();
    } catch (e) {
      console.error(
        `watcher: stop failed — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  function stop(): Promise<void> {
    // Re-arm ready() so a later return to FS mode rebuilds the index + restarts
    // the watcher. The watcher must NOT run during LIVE mode: a live vault
    // watcher corrupts child_process fd setup under launchd and EBADFs the
    // bridge spawn (see front.ts wireFailover).
    generation++;
    const run = readyPromise;
    readyPromise = null;
    const w = watcher;
    watcher = null;
    const prev = pendingStop;
    const p = (async () => {
      if (w) await closeWatcher(w);
      // A ready() still in flight sees the new generation and closes any
      // watcher it starts; wait for it, and for a stop() already under way, so
      // that when any stop() resolves no watcher is open.
      if (run) await run.catch(() => {});
      if (prev) await prev;
    })();
    pendingStop = p;
    void p.finally(() => {
      if (pendingStop === p) pendingStop = null;
    });
    return p;
  }

  function watching(): boolean {
    return watcher !== null || inFlight > 0;
  }

  return {
    // ── Per-request handler ─────────────────────────────────────────────────
    async handle(req: express.Request, res: express.Response): Promise<void> {
      // Lazily build the index on first FS-mode use. In LIVE mode the FS
      // machinery (and its watcher) never starts, keeping the bridge spawn safe.
      await ready();
      // Stateless: each request carries its own credential, so its own profile (#521).
      const profile = profileOf(res);
      const server = buildFsServer(profile === undefined ? opts : { ...opts, profile });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error("MCP request error:", err);
        if (!res.headersSent) res.status(500).json({ error: "internal error" });
      }
    },

    ready,
    stop,
    watching,
  };
}
