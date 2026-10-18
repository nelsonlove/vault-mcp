// sync-guard.ts — check Obsidian Sync before a write (Nelson's pick A,
// 2026-10-12, on "Make vault-mcp check Obsidian Sync before a write, behind a
// setting", 01.43).
//
// The version check (`if_rev`) holds only inside one Mac: each Mac has its own
// copy of the vault and Sync merges them later. On 2026-10-10 a folder was
// renamed on the Pro while the Pro's Sync still said "Indexing…", the rename
// never reached the server, and the Air's writes under the old path came back
// as a twin folder. This guard waits, before a write, while this Mac is
// disconnected from the Sync server or has a server change waiting at a path
// the write names; then it refuses a STRUCTURE write (rename, move, delete,
// create) that is still behind, and lets a CONTENT write (edit, append) go on
// with a warning. Since #528 it does not judge Sync's status text, which says
// "Indexing..." for most of a busy day, except for a rename, move or delete,
// which waits (up to `strictWaitSeconds`, 120 s) for "Fully synced" again
// (#533), or for Sync's own flags to say it is idle (`syncing` and `dirty`
// both false): that is the 2026-10-10 case.
//
// Obsidian-free and pure: the Sync state arrives as a plain snapshot
// (server.ts reads it from Obsidian's internal Sync plugin, one named field at
// a time), and the clock and the sleep are injected, so every branch is tested
// headlessly. The Sync plugin's object also holds the vault's encryption key
// and salt: nothing here receives that object, and nothing here logs or returns
// anything but the named fields below.
//
// What "behind" proves, and what it cannot: it proves only that THIS Mac has
// pushed its changes and pulled what the server has. The server does not tell
// one device what another has pulled, so a Mac that is asleep, or a write that
// does not go through vault-mcp, is not covered (01.43 rule 7).

import { MCP_SURFACE_INVENTORY, type SyncKindSpec } from "./operations/inventory-mcp.js";
import { collectPaths } from "../guard.js";
import type { DeclaredSync } from "./tool-declaration.js";

// ── settings ─────────────────────────────────────────────────────────────────

export type SyncGuardMode = "refuse" | "wait" | "warn";
export type SyncGuardOnUnknown = "warn" | "refuse";

export interface SyncGuardSettings {
  /** Off when the plugin ships, so no other vault changes. */
  enabled: boolean;
  /**
   * For the structure kinds (rename, move, delete, create): `refuse` waits,
   * then refuses; `wait` waits, then goes on with a warning; `warn` does not
   * wait and only warns. Content writes always wait, then warn.
   */
  mode: SyncGuardMode;
  /** How long to wait for Sync to catch up (connected, nothing pending at the write's paths), in seconds. */
  waitSeconds: number;
  /**
   * How long a rename, move or delete (the `STATUS_STRICT` tools) waits, in seconds, in place of
   * `waitSeconds`. Longer, because it waits for a moment Sync is idle, and on a busy day those moments
   * are short and far apart: measured, 354 "Fully synced" moments in about 16.6 h, the longest gap 58 min.
   */
  strictWaitSeconds: number;
  /** When the Sync object is missing or its fields have changed shape. */
  onUnknown: SyncGuardOnUnknown;
}

export const DEFAULT_SYNC_GUARD: Readonly<SyncGuardSettings> = Object.freeze({
  enabled: false,
  mode: "refuse",
  waitSeconds: 30,
  strictWaitSeconds: 120,
  onUnknown: "warn",
});

/** The longest wait the setting accepts, so a typo cannot hold a write for hours. */
export const MAX_WAIT_SECONDS = 600;

/** Coerce a stored (possibly hand-edited or partial) value to valid settings. */
export function normalizeSyncGuard(v: unknown): SyncGuardSettings {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const mode = o.mode === "refuse" || o.mode === "wait" || o.mode === "warn" ? o.mode : DEFAULT_SYNC_GUARD.mode;
  const onUnknown = o.onUnknown === "warn" || o.onUnknown === "refuse" ? o.onUnknown : DEFAULT_SYNC_GUARD.onUnknown;
  const seconds = (x: unknown, dflt: number) => Math.min(MAX_WAIT_SECONDS, Math.max(0, typeof x === "number" && Number.isFinite(x) ? x : dflt));
  return {
    enabled: o.enabled === true,
    mode,
    waitSeconds: seconds(o.waitSeconds, DEFAULT_SYNC_GUARD.waitSeconds),
    strictWaitSeconds: seconds(o.strictWaitSeconds, DEFAULT_SYNC_GUARD.strictWaitSeconds),
    onUnknown,
  };
}

// ── the Sync state ───────────────────────────────────────────────────────────

/**
 * The named fields of Obsidian Sync's internal instance that the guard reads,
 * copied out one by one by server.ts. Nothing else of that object travels.
 * Every field is `unknown`: it is an undocumented internal API, and an update
 * can rename or remove any of them.
 */
export interface SyncFields {
  ready: unknown;
  error: unknown;
  pause: unknown;
  /** The status text ("Fully synced", "Indexing...", "Uploading …"). Judged only for a rename, move or
   *  delete (#533), where `syncing`/`dirty` both false is a second proof; measured 2026-10-12, it says
   *  "Indexing..." for most of the day while the fleet writes (#528). */
  syncStatus: unknown;
  /** The paths of `newServerFiles` (server changes not yet pulled), or undefined when it is not an array. */
  pendingPaths: unknown;
  /** Whether the socket to the Sync server is open (`server.socket.readyState === 1`); false when there is no socket. */
  socketOpen: unknown;
  /** `server.lastMessageTs`, ms since the epoch. */
  lastMessageTs: unknown;
  /** `syncing`: true while Sync is in a sync pass. With `dirty`, a second proof that this Mac is idle, for a rename, move or delete. */
  syncing: unknown;
  /** `dirty`: true while this Mac has local changes not yet synced. */
  dirty: unknown;
}

/** The Sync plugin is off (or absent) in this vault: the guard does nothing. */
export type SyncSnapshot =
  | { state: "off" }
  | { state: "unknown"; why: string }
  | { state: "fields"; fields: SyncFields };

/**
 * Read the Sync state from Obsidian's app object, one named field at a time.
 * `app.internalPlugins.plugins.sync`: absent or not enabled ⇒ `off` (the
 * guard does nothing in a vault without Sync); enabled with no instance, or
 * any throw ⇒ `unknown`. The instance also holds the vault's encryption key
 * and salt, so only the named fields below are copied, and the instance is never
 * returned, logged or put in an error message.
 */
export function readSyncSnapshot(app: unknown): SyncSnapshot {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (app as any)?.internalPlugins?.plugins?.sync;
    if (!plugin || plugin.enabled !== true) return { state: "off" };
    const inst = plugin.instance;
    if (!inst || typeof inst !== "object") return { state: "unknown", why: "the Sync plugin is on but has no instance" };
    const nsf = inst.newServerFiles;
    const socket = inst.server?.socket;
    return {
      state: "fields",
      fields: {
        ready: inst.ready,
        error: inst.error,
        pause: inst.pause,
        syncStatus: inst.syncStatus,
        // Only the path of each waiting server change (a vault path), never the record.
        pendingPaths: Array.isArray(nsf) ? nsf.map((e: { path?: unknown }) => (typeof e?.path === "string" ? e.path : "")).filter(Boolean) : undefined,
        socketOpen: socket == null ? false : socket.readyState === 1,
        lastMessageTs: inst.server?.lastMessageTs,
        syncing: inst.syncing,
        dirty: inst.dirty,
      },
    };
  } catch {
    return { state: "unknown", why: "reading the Sync plugin threw" };
  }
}

/** A status can stay on screen after the socket drops: a server message older than this means the link is not alive. */
export const STALE_SERVER_MS = 2 * 60 * 1000;

/** `scope` says what the cause hangs on: the link to the server (every write meets it), one write's paths, or the status text (judged only for the `STATUS_STRICT` tools, #533). */
export type SyncVerdict =
  | { kind: "off" }
  | { kind: "synced" }
  | { kind: "behind"; status: string; scope: "connection" | "path" | "status" }
  | { kind: "unknown"; why: string };

/**
 * Structure writes that rename, move or delete an existing note (#533, Nelson's pick A): for them
 * the status text is judged again, so they wait for "Fully synced" (or Sync's flags saying idle). Creates are not in this set:
 * judging the text for them refused nearly every create on a busy day (#528).
 */
export const STATUS_STRICT: ReadonlySet<string> = new Set([
  "obsidian_move_note",
  "obsidian_move_notes",
  "obsidian_assign_address",
  "obsidian_refile_address",
  "obsidian_renumber_address",
  "obsidian_delete_note",
  "obsidian_trash",
]);

/**
 * Structure tools that name only the note they move, not where it goes (the
 * scheme tools compute the destination folder) or no path at all
 * (`obsidian_periodic_note`). For them a server change waiting ANYWHERE in the
 * vault counts, as before #528: the destination may be a folder the other
 * device just made or renamed (#529 review 1). They are rarely used, so the
 * wider check costs little.
 */
const DESTINATION_UNNAMED = new Set([
  "obsidian_assign_address",
  "obsidian_refile_address",
  "obsidian_renumber_address",
  "obsidian_periodic_note",
  // Names only the .base file; the new item lands in the folder the base's own config picks (#529 review 2).
  "obsidian_base_create",
]);

/** True when a waiting server change is at `path`, under it (a folder), or is a folder that holds it. */
function pendingTouches(pending: string, target: string): boolean {
  target = target.replace(/\/+$/, "");
  return pending === target || pending.startsWith(target + "/") || target.startsWith(pending + "/");
}

/**
 * Judge a snapshot for a write that names `targets` (vault paths; none for a
 * general reading such as obsidian_doctor's). Behind when Sync is not ready,
 * has an error, is paused, has no open socket to its server, has had no
 * server message for STALE_SERVER_MS, or has a server change waiting to be
 * pulled at one of the targets (or a folder holding one, or a note under a
 * target folder). The status text is not judged for a create (#528): measured
 * on the Pro on 2026-10-12, it said "Indexing..." through 45 minutes of fleet
 * writes while the socket was open and changes flowed, so judging it refused
 * nearly every create. With `strictStatus` (a rename, move or delete, #533)
 * it is behind unless the status text says "Fully synced" or Sync's own flags
 * say `syncing === false && dirty === false`, because a rename made while this
 * Mac's own changes are still going up is how the 2026-10-10 twin came back.
 * Unknown when a field the test needs is missing or of another type.
 */
export function judgeSync(s: SyncSnapshot, now: number, targets: readonly string[] = [], anyPending = false, strictStatus = false): SyncVerdict {
  if (s.state === "off") return { kind: "off" };
  if (s.state === "unknown") return { kind: "unknown", why: s.why };
  const f = s.fields;
  const bad: string[] = [];
  if (typeof f.ready !== "boolean") bad.push("ready");
  if (typeof f.pause !== "boolean") bad.push("pause");
  if (!Array.isArray(f.pendingPaths)) bad.push("newServerFiles");
  if (typeof f.socketOpen !== "boolean") bad.push("server.socket");
  if (typeof f.lastMessageTs !== "number" || !Number.isFinite(f.lastMessageTs)) bad.push("server.lastMessageTs");
  if (bad.length) return { kind: "unknown", why: `Sync fields missing or changed: ${bad.join(", ")}` };
  const status = typeof f.syncStatus === "string" ? f.syncStatus : "?";
  if (f.ready === false) return { kind: "behind", status: `not ready (${status})`, scope: "connection" };
  // Measured 2026-10-12 on the Pro: `error` is a boolean (false when well). Only a literal true counts.
  if (f.error === true) return { kind: "behind", status: `error (${status})`, scope: "connection" };
  if (f.pause === true) return { kind: "behind", status: "paused", scope: "connection" };
  if (f.socketOpen === false) return { kind: "behind", status: "disconnected from the Sync server", scope: "connection" };
  const age = now - (f.lastMessageTs as number);
  if (age > STALE_SERVER_MS) return { kind: "behind", status: `no message from the Sync server for ${Math.round(age / 1000)} s`, scope: "connection" };
  const pending = f.pendingPaths as string[];
  if (anyPending && pending.length > 0) {
    return { kind: "behind", status: `${pending.length} server change(s) not yet pulled, and this tool does not name where it writes`, scope: "path" };
  }
  for (const t of targets) {
    // The message names the caller's own path, never the other device's: that
    // one may be a note the caller's allowlist hides (#529 review).
    if (pending.some((p) => pendingTouches(p, t))) {
      return { kind: "behind", status: `a server change at or under '${t}' is not yet pulled`, scope: "path" };
    }
  }
  // A rename, move or delete also waits for this Mac's own changes to go up (#533, Nelson's pick A):
  // the 2026-10-10 twin was a rename made while this Mac still said "Indexing...", and Sync gives no
  // per-file upload signal. Two proofs count: the status text "Fully synced", or Sync's own flags
  // `syncing === false && dirty === false` (not in a sync pass, no local change waiting). The flags count
  // only when both are booleans; absent or of another type, only the text counts. Creates judge neither.
  if (strictStatus) {
    if (f.syncing === false && f.dirty === false) return { kind: "synced" };
    if (typeof f.syncStatus !== "string") return { kind: "unknown", why: "Sync fields missing or changed: syncStatus" };
    if (f.syncStatus !== "Fully synced") return { kind: "behind", status: `this Mac's own changes are still going up (${f.syncStatus})`, scope: "status" };
  }
  return { kind: "synced" };
}

// ── the kind of each write ───────────────────────────────────────────────────

export type SyncKind = "structure" | "content";

const KIND_BY_TOOL: ReadonlyMap<string, SyncKindSpec | undefined> = new Map(MCP_SURFACE_INVENTORY.map((r) => [r.tool, r.syncKind]));

/**
 * The kind of a call, read from the surface inventory (`syncKind` on each
 * row: one table, as `protection` is). Null for a tool the guard does not
 * check: a read, a non-note write, or a tool the inventory does not know.
 */
export function syncKindOf(tool: string, args: Record<string, unknown>, declared?: DeclaredSync): SyncKind | null {
  // The inventory wins; a v3 satellite tool's declaration rules only a tool it does not know (#550).
  const k = KIND_BY_TOOL.has(tool) ? KIND_BY_TOOL.get(tool) : declared?.kind;
  if (k === undefined) return null;
  if (typeof k === "string") return k;
  const v = args[k.arg];
  const key = typeof v === "boolean" ? String(v) : typeof v === "string" ? v : undefined;
  // Own keys only (#553 review 1): an inherited name such as "constructor" must not stand in for a kind.
  return (key !== undefined && Object.hasOwn(k.values, key) && k.values[key]) || k.otherwise;
}

// ── the decision ─────────────────────────────────────────────────────────────

/** The paths a call writes: its path arguments, and for obsidian_create_note (#531) the note its `folder` and `title` name. */
function targetsOf(tool: string, args: Record<string, unknown>): string[] {
  const paths = collectPaths(args);
  if (tool === "obsidian_create_note" && typeof args.folder === "string") {
    const values = (args.values ?? {}) as Record<string, unknown>;
    const title = typeof args.title === "string" ? args.title : typeof values.title === "string" ? values.title : "";
    const folder = args.folder.replace(/^\/+|\/+$/g, "");
    paths.push(title ? (folder ? `${folder}/${title}.md` : `${title}.md`) : folder);
  }
  return paths.filter(Boolean);
}

/** The code a refusal carries. */
export const SYNC_BEHIND = "sync_behind";
/** The code a refusal carries when the Sync state cannot be read and `onUnknown` is `refuse`. */
export const SYNC_UNKNOWN = "sync_unknown";

export type SyncDecision = null | { refuse: { code: string; message: string } } | { warn: string; code: string };

export interface SyncGuardDeps {
  settings: SyncGuardSettings;
  /** A fresh snapshot of the Sync state. Never throws (server.ts catches and reports unknown). */
  read: () => SyncSnapshot;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How often to look again while waiting. */
  pollMs?: number;
  /** Judge at once, with no wait: set by createSyncGuard while a recent wait has already run out. */
  skipWait?: boolean;
  /** Told when a wait ran out with Sync still behind, and how long that wait was, in seconds. */
  onWaitExpired?: (v: SyncVerdict, waitedSeconds: number) => void;
}

/**
 * Decide one call. Waits first (unless the structure mode is `warn`), up to
 * `waitSeconds` (`strictWaitSeconds` for a rename, move or delete), looking
 * again every `pollMs`, for the Sync state to be synced, and goes on at the
 * first look that finds it so; then refuses a structure
 * write in `refuse` mode, and lets everything else go on with a warning.
 * Returns null when the call goes on with nothing to say.
 */
export async function decideSync(tool: string, args: Record<string, unknown>, deps: SyncGuardDeps, declared?: DeclaredSync): Promise<SyncDecision> {
  const { settings } = deps;
  if (!settings.enabled) return null;
  const kind = syncKindOf(tool, args, declared);
  if (kind === null) return null;
  const targets = targetsOf(tool, args);
  // A v3 satellite tool's list membership comes from its declaration (#550), for a tool the inventory does not know.
  const own = KIND_BY_TOOL.has(tool) ? undefined : declared;
  // A structure write that does not name where it writes checks every pending change.
  const anyPending = kind === "structure" && (targets.length === 0 || DESTINATION_UNNAMED.has(tool) || own?.destinationUnnamed === true);
  const strictStatus = kind === "structure" && (STATUS_STRICT.has(tool) || own?.strictStatus === true);
  let v = judgeSync(deps.read(), deps.now(), targets, anyPending, strictStatus);
  if (v.kind === "off" || v.kind === "synced") return null;
  if (v.kind === "unknown") return unknownDecision(tool, v.why, settings);
  // The hold skips the wait only for a cause every write meets; a path cause still waits (#529 review 2).
  // A "status" cause (this Mac still uploading) is held only for the rename, move and delete tools that judge it.
  const held = deps.skipWait === true && v.kind === "behind" && (v.scope === "connection" || (v.scope === "status" && strictStatus));
  const shouldWait = !held && (kind === "content" || settings.mode !== "warn");
  // A rename, move or delete waits longer (`strictWaitSeconds`): it waits for a moment Sync is idle.
  const waitSeconds = strictStatus ? settings.strictWaitSeconds : settings.waitSeconds;
  if (shouldWait) {
    const deadline = deps.now() + waitSeconds * 1000;
    const poll = Math.max(50, deps.pollMs ?? 500);
    while (v.kind === "behind" && deps.now() < deadline) {
      await deps.sleep(Math.min(poll, Math.max(0, deadline - deps.now())));
      v = judgeSync(deps.read(), deps.now(), targets, anyPending, strictStatus);
    }
    if (v.kind === "off" || v.kind === "synced") return null;
    if (v.kind === "unknown") return unknownDecision(tool, v.why, settings);
    deps.onWaitExpired?.(v, waitSeconds);
  }
  const waited = shouldWait ? ` after waiting ${waitSeconds} s` : "";
  if (kind === "structure" && settings.mode === "refuse") {
    return {
      refuse: {
        code: SYNC_BEHIND,
        message:
          `'${tool}' is a structure write (it can rename, move, delete or create a note), and this Mac's Obsidian Sync is behind${waited}: ${v.status}. ` +
          "Nothing was written. Such a write holds only once the other devices pull it, and made while Sync is behind it can come back as a twin. " +
          (v.scope === "status"
            ? "Retry when Sync says Fully synced. (vault-mcp setting: Sync guard.)"
            : "Retry when Sync has pulled that change, or is connected again. (vault-mcp setting: Sync guard.)"),
      },
    };
  }
  return { warn: `Obsidian Sync on this Mac is behind${waited} (${v.status}); the write went on. (vault-mcp setting: Sync guard.)`, code: SYNC_BEHIND };
}

function unknownDecision(tool: string, why: string, settings: SyncGuardSettings): SyncDecision {
  if (settings.onUnknown === "refuse") {
    return {
      refuse: {
        code: SYNC_UNKNOWN,
        message: `'${tool}' was not run: the Sync guard cannot read Obsidian Sync's state (${why}). Nothing was written. (vault-mcp setting: Sync guard, "When Sync cannot be read".)`,
      },
    };
  }
  return { warn: `The Sync guard cannot read Obsidian Sync's state (${why}); the write went on unchecked.`, code: SYNC_UNKNOWN };
}

/**
 * The guard as the host uses it: `decideSync` with one shared memory. Once a
 * wait has run out with Sync still behind for a connection cause (or a status
 * cause, which only a `STATUS_STRICT` tool can meet), the calls that follow within the
 * next `waitSeconds` (`strictWaitSeconds` after a status cause) are judged at once, with no second wait, so a batch (each
 * `obsidian_write_notes` item is its own guarded call) or a burst of calls pays
 * the wait once, not once per call. A call that finds Sync synced clears it.
 */
export function createSyncGuard(base: () => Omit<SyncGuardDeps, "skipWait" | "onWaitExpired">) {
  let holdUntil = 0;
  return async (tool: string, args: Record<string, unknown>, declared?: DeclaredSync): Promise<SyncDecision> => {
    const deps = base();
    const d = await decideSync(tool, args, {
      ...deps,
      skipWait: deps.now() < holdUntil,
      onWaitExpired: (v, waitedSeconds) => {
        // A connection cause meets every write, so it is held for the next calls. A status cause is
        // held too (#533); only a STATUS_STRICT tool can meet it, because decideSync
        // judges the status text for those tools alone. A pending change at one write's paths says nothing of others' (#529 review).
        // A connection hold lasts `waitSeconds`, as before, since every write meets it; a status hold lasts
        // the rename-kind wait that ran out (`strictWaitSeconds`).
        if (v.kind === "behind" && v.scope === "connection") holdUntil = deps.now() + deps.settings.waitSeconds * 1000;
        else if (v.kind === "behind" && v.scope === "status") holdUntil = deps.now() + waitedSeconds * 1000;
      },
    }, declared);
    // Clear the hold only after a call that was really judged and found clean:
    // a tool the guard does not check says nothing about the link (#529 review 2).
    if (d === null && deps.settings.enabled && syncKindOf(tool, args, declared) !== null) holdUntil = 0;
    return d;
  };
}
