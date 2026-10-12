// sync-guard.ts — check Obsidian Sync before a write (Nelson's pick A,
// 2026-10-12, on "Make vault-mcp check Obsidian Sync before a write, behind a
// setting", 01.43).
//
// The version check (`if_rev`) holds only inside one Mac: each Mac has its own
// copy of the vault and Sync merges them later. On 2026-10-10 a folder was
// renamed on the Pro while the Pro's Sync still said "Indexing…", the rename
// never reached the server, and the Air's writes under the old path came back
// as a twin folder. This guard waits for "Fully synced" before a write, then
// refuses a STRUCTURE write (rename, move, delete, create) that is still
// behind, and lets a CONTENT write (edit, append) go on with a warning.
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
  /** How long to wait for "Fully synced", in seconds. */
  waitSeconds: number;
  /** When the Sync object is missing or its fields have changed shape. */
  onUnknown: SyncGuardOnUnknown;
}

export const DEFAULT_SYNC_GUARD: Readonly<SyncGuardSettings> = Object.freeze({
  enabled: false,
  mode: "refuse",
  waitSeconds: 30,
  onUnknown: "warn",
});

/** The longest wait the setting accepts, so a typo cannot hold a write for hours. */
export const MAX_WAIT_SECONDS = 600;

/** Coerce a stored (possibly hand-edited or partial) value to valid settings. */
export function normalizeSyncGuard(v: unknown): SyncGuardSettings {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const mode = o.mode === "refuse" || o.mode === "wait" || o.mode === "warn" ? o.mode : DEFAULT_SYNC_GUARD.mode;
  const onUnknown = o.onUnknown === "warn" || o.onUnknown === "refuse" ? o.onUnknown : DEFAULT_SYNC_GUARD.onUnknown;
  const w = typeof o.waitSeconds === "number" && Number.isFinite(o.waitSeconds) ? o.waitSeconds : DEFAULT_SYNC_GUARD.waitSeconds;
  return {
    enabled: o.enabled === true,
    mode,
    waitSeconds: Math.min(MAX_WAIT_SECONDS, Math.max(0, w)),
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
  syncStatus: unknown;
  /** The length of `newServerFiles`, or undefined when it is not an array. */
  newServerFiles: unknown;
  /** `server.lastMessageTs`, ms since the epoch. */
  lastMessageTs: unknown;
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
 * and salt, so only the six fields below are copied, and the instance is never
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
    return {
      state: "fields",
      fields: {
        ready: inst.ready,
        error: inst.error,
        pause: inst.pause,
        syncStatus: inst.syncStatus,
        newServerFiles: Array.isArray(nsf) ? nsf.length : undefined,
        lastMessageTs: inst.server?.lastMessageTs,
      },
    };
  } catch {
    return { state: "unknown", why: "reading the Sync plugin threw" };
  }
}

/** "Fully synced" can stay on screen after the socket drops: a server message older than this means the link is not alive. */
export const STALE_SERVER_MS = 2 * 60 * 1000;

export type SyncVerdict = { kind: "off" } | { kind: "synced" } | { kind: "behind"; status: string } | { kind: "unknown"; why: string };

/**
 * Judge a snapshot. Behind when `ready` is false, or `error` or `pause` is
 * true, or `syncStatus` is not "Fully synced", or server changes wait to be
 * pulled, or the last server message is older than STALE_SERVER_MS. Unknown
 * when a field the test needs is missing or of another type.
 */
export function judgeSync(s: SyncSnapshot, now: number): SyncVerdict {
  if (s.state === "off") return { kind: "off" };
  if (s.state === "unknown") return { kind: "unknown", why: s.why };
  const f = s.fields;
  const bad: string[] = [];
  if (typeof f.ready !== "boolean") bad.push("ready");
  if (typeof f.pause !== "boolean") bad.push("pause");
  if (typeof f.syncStatus !== "string") bad.push("syncStatus");
  if (typeof f.newServerFiles !== "number") bad.push("newServerFiles");
  if (typeof f.lastMessageTs !== "number" || !Number.isFinite(f.lastMessageTs)) bad.push("server.lastMessageTs");
  if (bad.length) return { kind: "unknown", why: `Sync fields missing or changed: ${bad.join(", ")}` };
  const status = f.syncStatus as string;
  if (f.ready === false) return { kind: "behind", status: `not ready (${status})` };
  // Measured 2026-10-12 on the Pro: `error` is a boolean (false when well). Only a literal true counts.
  if (f.error === true) return { kind: "behind", status: `error (${status})` };
  if (f.pause === true) return { kind: "behind", status: "paused" };
  if (status !== "Fully synced") return { kind: "behind", status };
  if ((f.newServerFiles as number) > 0) return { kind: "behind", status: `${f.newServerFiles} server change(s) not yet pulled` };
  const age = now - (f.lastMessageTs as number);
  if (age > STALE_SERVER_MS) return { kind: "behind", status: `no message from the Sync server for ${Math.round(age / 1000)} s` };
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
export function syncKindOf(tool: string, args: Record<string, unknown>): SyncKind | null {
  const k = KIND_BY_TOOL.get(tool);
  if (k === undefined) return null;
  if (typeof k === "string") return k;
  const v = args[k.arg];
  const key = typeof v === "boolean" ? String(v) : typeof v === "string" ? v : undefined;
  return (key !== undefined && k.values[key]) || k.otherwise;
}

// ── the decision ─────────────────────────────────────────────────────────────

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
  /** Told when a wait ran out with Sync still behind. */
  onWaitExpired?: () => void;
}

/**
 * Decide one call. Waits first (unless the structure mode is `warn`), up to
 * `waitSeconds`, for the Sync state to be synced; then refuses a structure
 * write in `refuse` mode, and lets everything else go on with a warning.
 * Returns null when the call goes on with nothing to say.
 */
export async function decideSync(tool: string, args: Record<string, unknown>, deps: SyncGuardDeps): Promise<SyncDecision> {
  const { settings } = deps;
  if (!settings.enabled) return null;
  const kind = syncKindOf(tool, args);
  if (kind === null) return null;
  let v = judgeSync(deps.read(), deps.now());
  if (v.kind === "off" || v.kind === "synced") return null;
  if (v.kind === "unknown") return unknownDecision(tool, v.why, settings);
  const shouldWait = !deps.skipWait && (kind === "content" || settings.mode !== "warn");
  if (shouldWait) {
    const deadline = deps.now() + settings.waitSeconds * 1000;
    const poll = Math.max(50, deps.pollMs ?? 500);
    while (v.kind === "behind" && deps.now() < deadline) {
      await deps.sleep(Math.min(poll, Math.max(0, deadline - deps.now())));
      v = judgeSync(deps.read(), deps.now());
    }
    if (v.kind === "off" || v.kind === "synced") return null;
    if (v.kind === "unknown") return unknownDecision(tool, v.why, settings);
    deps.onWaitExpired?.();
  }
  const waited = shouldWait ? ` after waiting ${settings.waitSeconds} s` : "";
  if (kind === "structure" && settings.mode === "refuse") {
    return {
      refuse: {
        code: SYNC_BEHIND,
        message:
          `'${tool}' is a structure write (it can rename, move, delete or create a note), and this Mac's Obsidian Sync is behind${waited}: ${v.status}. ` +
          "Nothing was written. Such a write holds only once the other devices pull it, and made while Sync is behind it can come back as a twin. " +
          "Retry when Sync says Fully synced. (vault-mcp setting: Sync guard.)",
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
 * wait has run out with Sync still behind, the calls that follow within the
 * next `waitSeconds` are judged at once, with no second wait, so a batch (each
 * `obsidian_write_notes` item is its own guarded call) or a burst of calls pays
 * the wait once, not once per call. A call that finds Sync synced clears it.
 */
export function createSyncGuard(base: () => Omit<SyncGuardDeps, "skipWait" | "onWaitExpired">) {
  let holdUntil = 0;
  return async (tool: string, args: Record<string, unknown>): Promise<SyncDecision> => {
    const deps = base();
    const d = await decideSync(tool, args, {
      ...deps,
      skipWait: deps.now() < holdUntil,
      onWaitExpired: () => {
        holdUntil = deps.now() + deps.settings.waitSeconds * 1000;
      },
    });
    if (d === null) holdUntil = 0;
    return d;
  };
}
