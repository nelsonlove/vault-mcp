import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { VaultMux } from "./mux.js";

export interface Discovery {
  vault_name: string;
  socket_path: string;
  [k: string]: unknown;
}

const ENABLE_HINT =
  "open Obsidian and enable the 'Vault MCP' plugin (Settings → Community plugins)";

export function selectVault(
  discoveries: Discovery[],
  opts: { flag?: string; env?: string }
): Discovery {
  const pick = opts.flag ?? opts.env;
  if (pick) {
    const found = discoveries.find((d) => d.vault_name === pick);
    if (!found) {
      throw new Error(
        `no vault named "${pick}"; available: ${discoveries.map((d) => d.vault_name).join(", ") || "(none)"}`
      );
    }
    return found;
  }
  if (discoveries.length === 1) return discoveries[0];
  if (discoveries.length === 0)
    throw new Error(`no vault is currently serving MCP — ${ENABLE_HINT}`);
  throw new Error(
    `multiple vaults open; specify --vault <name>: ${discoveries.map((d) => d.vault_name).join(", ")}`
  );
}

// A discovery is "live" only if its Unix socket still exists. A disabled plugin
// or closed Obsidian leaves a stale *.json behind pointing at a socket that's gone.
export function filterLive(
  discoveries: Discovery[],
  exists: (p: string) => boolean = fs.existsSync
): Discovery[] {
  return discoveries.filter((d) => {
    try {
      return exists(d.socket_path);
    } catch {
      return false;
    }
  });
}

// --- Actionable diagnostics (pure, so they can be unit-tested) ---

export function noLiveMessage(all: Discovery[]): string {
  return all.length > 0
    ? `vault-mcp: found vault discovery but no live socket — the 'Vault MCP' plugin is ` +
        `disabled or Obsidian is closed.\n  Fix: ${ENABLE_HINT}.\n` +
        `  (stale discovery for: ${all.map((d) => d.vault_name).join(", ")})`
    : `vault-mcp: no vault is currently serving MCP — ${ENABLE_HINT}.`;
}

export function staleRequestedMessage(pick: string): string {
  return (
    `vault-mcp: vault '${pick}' has a discovery but no live socket — the 'Vault MCP' ` +
    `plugin is disabled or Obsidian isn't running.\n  Fix: ${ENABLE_HINT}.`
  );
}

export function connectFailMessage(chosen: Discovery): string {
  return (
    `vault-mcp: can't connect to vault '${chosen.vault_name}' — the 'Vault MCP' plugin ` +
    `is disabled or Obsidian isn't running.\n  Fix: ${ENABLE_HINT}.\n  (socket: ${chosen.socket_path})`
  );
}

// Discovery jsons live in BOTH ~/.claude/vault-mcp/ and ~/.claude/governor/,
// and this shared bridge is rewritten by whichever vault loaded last — so it
// cannot assume which of the two is any given vault's canonical dir. Which one
// is canonical has flipped twice: `vault-mcp` before 0.12.0, `governor` from
// 0.12.0 to the suite split, `vault-mcp` again after it.
//
// **The `legacy: true` flag is what decides, not the directory.** A plugin
// writes its real discovery unflagged into its canonical dir and a FLAGGED
// copy (same `socket_path`) into the other one, so a flagged entry is always
// the duplicate twin of an unflagged entry that is also on disk. Skipping
// flagged entries in EVERY dir is therefore both correct and version-proof.
//
// It was `skipLegacy` per-dir until the S3c wire rename, keyed on the
// 0.12.0-era assumption that `governor` was canonical — which the split
// inverted, so post-split every vault was read twice, unflagged from
// `~/.claude/vault-mcp/` and flagged from `~/.claude/governor/`, and a single
// open vault failed as "multiple vaults open; specify --vault".
export function loadDiscoveryDir(dir: string): Discovery[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Discovery[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      // Only an object with a string socket_path is a vault: a stray JSON file in the folder is skipped (#582 review 1).
      if (!d || typeof d !== "object" || typeof (d as { socket_path?: unknown }).socket_path !== "string") continue;
      if ((d as { legacy?: boolean }).legacy === true) continue;
      out.push(d);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** The folder this bridge.mjs runs from, or undefined when it cannot be told. */
function ownDir(): string | undefined {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

export function loadDiscoveries(): Discovery[] {
  // A host that keeps its state outside ~/.claude/ (the plugin's `host.stateDir`
  // setting, a headless vaultd-host) names it in VAULT_MCP_STATE_DIR, the variable
  // the plugin and the HTTP front read too; then only that folder is read.
  return uniqueBySocket(discoveryDirs().flatMap((d) => loadDiscoveryDir(d)));
}

/**
 * One entry per socket. The bridge's own folder is its real path (node resolves a
 * symlinked main module), and a default folder may be spelled through a symlink, so
 * one folder can be read twice; two copies of one vault would then fail as "multiple
 * vaults open" (#540 review 2). The socket path is what a discovery points at.
 */
export function uniqueBySocket(ds: Discovery[]): Discovery[] {
  const seen = new Set<string>();
  return ds.filter((d) => {
    const key = typeof d?.socket_path === "string" ? d.socket_path : JSON.stringify(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The folders the bridge reads discovery files from, in order. Pure, for tests. */
export function discoveryDirs(own: string | undefined = ownDir(), env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const custom = env.VAULT_MCP_STATE_DIR?.trim();
  if (custom) return [path.resolve(custom)];
  // The bridge's own folder too: the plugin writes bridge.mjs beside its discovery file, so a
  // Claude Code registration that runs `<stateDir>/bridge.mjs` with no environment still finds
  // a vault whose state folder is set in its settings (#540 review). Each folder is read once.
  return [own, path.join(home, ".claude", "vault-mcp"), path.join(home, ".claude", "governor")].filter(
    (d, i, all): d is string => typeof d === "string" && all.indexOf(d) === i,
  );
}

function parseFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// Given the current discovery snapshot, decide what to do. Separated from the
// wait loop so it stays pure and unit-testable.
//   ok    — a vault is live and unambiguously chosen; connect to it.
//   wait  — nothing usable *yet*, but a live vault could still appear
//           (Obsidian mid-launch, plugin re-enabling). Retry until the deadline.
//   fatal — waiting cannot help (multiple live vaults, none pinned). Fail now.
export type Target =
  | { kind: "ok"; chosen: Discovery }
  | { kind: "wait"; for?: string; why?: string }
  | { kind: "fatal"; message: string };

export function resolveTarget(
  live: Discovery[],
  pick: string | undefined,
  cwd?: string,
  fallback?: string,
  rootOf: (dir: string) => string | undefined = vaultRootOf
): Target {
  if (fallback === "") fallback = undefined;
  if (pick) {
    const hit = live.find((d) => d.vault_name === pick);
    // A pinned vault that isn't live yet is retryable — it may still register.
    return hit ? { kind: "ok", chosen: hit } : { kind: "wait" };
  }
  if (live.length === 0) return { kind: "wait" };
  // None pinned: the session's directory decides, so one unpinned
  // registration serves whichever vault the session runs in.
  const here = cwd === undefined ? undefined : vaultForDir(live, cwd);
  // The session runs inside a vault folder that is not live: its plugin is
  // reloading (a reload deletes the discovery file) or the vault is closed.
  // Wait for it; never hand its session to another vault (#643). A live vault
  // that only contains that folder (nested vaults) does not count.
  const root = cwd === undefined ? undefined : rootOf(cwd);
  if (here && !deeperThan(root, here)) return { kind: "ok", chosen: here };
  if (root !== undefined) return { kind: "wait", for: path.basename(root), why: "the session runs inside it" };
  // Outside every vault: the registration's soft default. When it is
  // not live (its plugin reloading, Obsidian restarting) the bridge waits for
  // it; it never takes "the only vault open" instead, which would send this
  // session's writes to a vault nobody chose (#643).
  if (fallback !== undefined) {
    const dflt = live.find((d) => d.vault_name === fallback);
    return dflt ? { kind: "ok", chosen: dflt } : { kind: "wait", for: fallback, why: "set by --default-vault" };
  }
  if (live.length === 1) return { kind: "ok", chosen: live[0] };
  return {
    kind: "fatal",
    message: `vault-mcp: multiple vaults open; specify --vault <name> or run inside one of them: ${live
      .map((d) => d.vault_name)
      .join(", ")}`,
  };
}

// The vault whose `vault_path` contains `dir` (the deepest one, if vaults
// nest). Paths compare after realpath where possible, so a symlinked checkout
// or macOS's /private/var alias still matches. Undefined when none contains it.
export function vaultForDir(
  vaults: Discovery[],
  dir: string,
  real: (p: string) => string = realOrResolved
): Discovery | undefined {
  const target = real(dir);
  let best: Discovery | undefined;
  let bestLen = -1;
  for (const d of vaults) {
    if (typeof d.vault_path !== "string" || d.vault_path === "") continue;
    const root = real(d.vault_path);
    const rel = path.relative(root, target);
    const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    if (inside && root.length > bestLen) {
      best = d;
      bestLen = root.length;
    }
  }
  return best;
}

/**
 * The nearest folder at or above `dir` that holds an Obsidian config folder
 * (`.obsidian`), that is, the root of the vault the directory is in, whether
 * or not that vault is serving now. Undefined outside every vault folder.
 */
export function vaultRootOf(
  dir: string,
  isVaultRoot: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(path.join(p, ".obsidian")).isDirectory();
    } catch {
      return false;
    }
  },
  real: (p: string) => string = realOrResolved
): string | undefined {
  let cur = real(dir);
  for (;;) {
    if (isVaultRoot(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

// True when the vault folder `root` lies strictly inside `d`'s vault (nested
// vaults): then `root`, not `d`, is the vault the session runs in.
function deeperThan(root: string | undefined, d: Discovery): boolean {
  return root !== undefined && typeof d.vault_path === "string" && root.length > realOrResolved(d.vault_path).length;
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// The directory the client session runs in. Claude Code sets
// CLAUDE_PROJECT_DIR for the processes it spawns; the bridge's own cwd is the
// fallback (stdio MCP servers inherit the session's working directory).
export function sessionDir(env: NodeJS.ProcessEnv = process.env, cwd: () => string = process.cwd): string {
  return env.CLAUDE_PROJECT_DIR || cwd();
}

// The diagnostic to emit once the wait budget is exhausted, mirroring the
// precise cause the original one-shot bridge would have reported.
export function deadlineMessage(
  all: Discovery[],
  pick: string | undefined
): string {
  if (pick) {
    return all.some((d) => d.vault_name === pick)
      ? staleRequestedMessage(pick)
      : `vault-mcp: no vault named "${pick}"; available: ${all.map((d) => d.vault_name).join(", ") || "(none)"}`;
  }
  // Exactly one discovery we still couldn't reach: name it and its socket.
  if (all.length === 1) return connectFailMessage(all[0]);
  return noLiveMessage(all);
}

export function defaultMissingMessage(name: string, why = "set by --default-vault"): string {
  const source = why === "set by --default-vault" ? "set by --default-vault or VAULT_MCP_DEFAULT_VAULT" : why;
  return (
    `vault-mcp: the vault this session should use, '${name}' (${source}), is not serving MCP.\n` +
    `  Fix: open '${name}' in Obsidian with the 'Vault MCP' plugin on, or pass --vault <name>.`
  );
}

// Synchronous write to fd 2 so the message flushes before exit even when stderr
// is a POSIX pipe (as it is when Claude Code spawns the bridge as an MCP server).
function fail(msg: string): never {
  try {
    fs.writeSync(2, `${msg}\n`);
  } catch {
    /* ignore */
  }
  process.exit(1);
}

// Millisecond knobs from the environment. `??` alone is wrong here: an empty
// env var would become Number("") = 0 and a typo NaN, silently defeating the
// knob — fall back to the default unless the value is a real non-negative
// number (an explicit "0" is a valid opt-out, e.g. VAULT_MCP_RECONNECT_MS=0
// restores the old die-on-disconnect behavior).
export function envMs(raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// How long to keep polling for a live vault socket before giving up, and how
// often to poll. The wait closes the startup-order race: Claude Code often
// spawns the bridge a moment before Obsidian's plugin has bound its socket, and
// the original bridge failed instantly instead of waiting it out.
const WAIT_MS = envMs(process.env.VAULT_MCP_WAIT_MS, 30000);
const POLL_MS = envMs(process.env.VAULT_MCP_POLL_MS, 500);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves to a connected socket, or null if the socket file exists but isn't
// accepting yet (stale/just-restarted) — a retryable condition. Rejects only on
// unexpected errors worth surfacing immediately.
//
// Every connect-phase error is treated as retryable, including EACCES/EPERM:
// during a plugin reload the socket is briefly recreated and a permission errno
// can be transient (wrong owner/mode for a moment, AV/sandbox interposition).
// Fast-failing on it would kill the whole session on a blip that clears in
// milliseconds; the wait deadline already bounds a genuinely permanent error.
function tryConnect(chosen: Discovery): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection(chosen.socket_path);
    sock.once("connect", () => resolve(sock));
    sock.once("error", () => {
      sock.destroy();
      resolve(null);
    });
  });
}

// --- Reconnect-aware relay ---
//
// The bridge used to be a dumb byte pipe that exited when the socket closed,
// so every Obsidian restart (or plugin reload) killed the MCP server
// for the whole Claude Code session. Instead we parse the NDJSON stream just
// enough to survive a restart: capture the client's `initialize` handshake,
// and when the socket dies with the client still attached, fail in-flight
// requests (they may have had partial effects, so they can't be resent), queue
// new ones briefly, wait for the vault socket to return, replay the handshake
// to the fresh per-connection McpServer (swallowing the duplicate response the
// client already got), and flush the queue.

// NDJSON framing lives in one shared module so the bridge and the server
// transport can't diverge (see src/ndjson.ts). Imported for local use and
// re-exported for callers/tests that import it from here.
import { splitLines } from "../src/ndjson.js";
export { splitLines };
import { buildPreamble } from "../src/preamble.js";
export { buildPreamble };

// --- Code Mode selection (pure, exported for tests) ---

// Accept `--code-mode`, `--code-mode=<value>`, and the VAULT_MCP_CODE_MODE env
// var. Falsy `=` values (`0`, `false`, `no`, `off`) opt out; anything else set
// opts in — an exact-token-only match would silently ignore `--code-mode=1`
// and hand the session the full surface with no indication why.
export function parseCodeModeFlag(argv: string[], env?: string): boolean {
  for (const a of argv) {
    if (a === "--code-mode") return true;
    const m = /^--code-mode=(.*)$/.exec(a);
    if (m) return !["0", "false", "no", "off"].includes(m[1].toLowerCase());
  }
  return ["1", "true", "yes", "on"].includes((env ?? "").toLowerCase());
}

// The preamble may only be sent to a plugin build that knows how to consume
// it: an older listener would deliver it to the MCP SDK as a bogus message.
// ~/.claude/vault-mcp/bridge.mjs (and its grace-period governor twin) is one
// shared file rewritten by whichever
// vault's plugin loaded last, so a newer bridge CAN meet an older plugin —
// gate on the discovery's advertised capabilities, not on hope.
export function supportsPreamble(d: Discovery): boolean {
  const caps = (d as { capabilities?: unknown }).capabilities;
  return Array.isArray(caps) && caps.includes("preamble");
}

// A connection profile (#521) may only be sent to a plugin that applies it: a plugin with the
// preamble but not the profile would read the line, drop the profile and build the FULL surface.
// So a bridge that was given a profile refuses to connect to such a plugin, at start and on every
// reconnect — it fails closed, never open.
export function supportsProfile(d: Discovery): boolean {
  const caps = (d as { capabilities?: unknown }).capabilities;
  return Array.isArray(caps) && caps.includes("preamble") && caps.includes("profile");
}

/** The profile this bridge was told to ask for (VAULT_MCP_PROFILE, set by the remote front), or undefined for a local bridge. */
export function profileFromEnv(env: string | undefined): string | undefined {
  const v = env?.trim();
  return v ? v : undefined;
}

type JsonRpcId = string | number;

interface JsonRpcMsg {
  id?: JsonRpcId | null;
  method?: string;
  result?: unknown;
  error?: unknown;
}

// Parse a client/server line ONCE into both views the relay needs, instead of
// JSON.parse-ing it twice (a single-message check + a batch-items list):
//   single — the message iff the line is a lone JSON-RPC object, else null.
//   items  — the flat message list: a batch's object elements, or [single], or
//            [] for a primitive / unparseable / empty-array line.
function parseFrame(raw: string): { single: JsonRpcMsg | null; items: JsonRpcMsg[] } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { single: null, items: [] };
  }
  if (Array.isArray(v)) {
    return {
      single: null,
      items: v.filter((x): x is JsonRpcMsg => x !== null && typeof x === "object"),
    };
  }
  if (v !== null && typeof v === "object") {
    const msg = v as JsonRpcMsg;
    return { single: msg, items: [msg] };
  }
  return { single: null, items: [] };
}

// `id: null` is JSON-RPC's "unidentifiable request" sentinel (error responses
// to unparseable input) — treat it as absent so it can never match a real id.
function msgId(msg: JsonRpcMsg): JsonRpcId | undefined {
  return msg.id === null ? undefined : msg.id;
}

// The single disconnect-error JSON-RPC response shape, so the `-32000` literal
// and its message format live in exactly one place across failOutstanding /
// failRequest (single + batch).
function disconnectError(
  id: JsonRpcId,
  method: string,
  reason: string
): { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } } {
  return { jsonrpc: "2.0", id, error: { code: -32000, message: `${reason} (request: ${method})` } };
}

// What to do with a server→client line:
//   forward       — pass it to the client.
//   drop          — the duplicate success response to a replayed initialize;
//                   the client already has one.
//   replay-error  — the fresh server REJECTED the replayed initialize. The
//                   session cannot continue; surface it, don't hide it.
export type ServerVerdict = "forward" | "drop" | "replay-error";

export class RelayState {
  private initializeRaw: string | null = null;
  private initializedRaw: string | null = null;
  private initializeId: JsonRpcId | undefined = undefined;
  private initResponseSeen = false;
  private awaitingReplayResponse = false;
  private outstanding = new Map<JsonRpcId, string>();

  // An unanswered `initialize` is exempt from failure — the reconnect replay
  // resends it and the fresh response is forwarded instead. Copied nowhere:
  // the one predicate the fail* paths share.
  private isExemptInitialize(id: JsonRpcId | undefined): boolean {
    return (
      this.initializeId !== undefined &&
      id === this.initializeId &&
      !this.initResponseSeen
    );
  }

  onClientMessage(raw: string): void {
    const { single, items } = parseFrame(raw);
    if (single) {
      const id = msgId(single);
      if (
        single.method === "initialize" &&
        id !== undefined &&
        this.initializeRaw === null
      ) {
        this.initializeRaw = raw;
        this.initializeId = id;
      } else if (
        single.method === "notifications/initialized" &&
        this.initializedRaw === null
      ) {
        this.initializedRaw = raw;
      }
    }
    // Track every request — batched or not — so failOutstanding can answer
    // them. Only requests (id + method) await a response; client→server
    // responses to server-initiated requests carry an id but no method.
    for (const msg of items) {
      const id = msgId(msg);
      if (id !== undefined && msg.method !== undefined) {
        this.outstanding.set(id, msg.method);
      }
    }
  }

  onServerMessage(raw: string): ServerVerdict {
    const { single, items } = parseFrame(raw);
    if (!single) {
      // Batch responses resolve their items; the replayed initialize is never
      // sent in a batch, so batches always pass through.
      for (const item of items) {
        const id = msgId(item);
        if (id !== undefined && item.method === undefined) {
          this.outstanding.delete(id);
        }
      }
      return "forward";
    }
    const id = msgId(single);
    // Server-initiated requests/notifications have a method; only responses
    // (id, no method) resolve outstanding client requests.
    if (id === undefined || single.method !== undefined) return "forward";
    this.outstanding.delete(id);
    if (this.initializeId !== undefined && id === this.initializeId) {
      if (this.awaitingReplayResponse) {
        this.awaitingReplayResponse = false;
        return single.error !== undefined ? "replay-error" : "drop";
      }
      this.initResponseSeen = true;
    }
    return "forward";
  }

  /**
   * JSON-RPC error lines to emit for requests that were in flight when the
   * socket died. An unanswered `initialize` is exempt — the replay resends it
   * and the fresh response is forwarded instead.
   */
  failOutstanding(reason: string): string[] {
    const out: string[] = [];
    for (const [id, method] of [...this.outstanding]) {
      if (this.isExemptInitialize(id)) continue;
      out.push(JSON.stringify(disconnectError(id, method, reason)));
      this.outstanding.delete(id);
    }
    return out;
  }

  /**
   * Decide how to handle a queued client line when the vault won't answer it:
   *   `error` — a JSON-RPC error line to send now (the line's failable
   *             requests, already removed from outstanding); null if none.
   *   `keep`  — the part of the line to re-queue for delivery once the vault
   *             returns (notifications, responses, an unanswered initialize);
   *             null if nothing survives.
   * A single request yields `{error, keep: null}`; a single notification yields
   * `{error: null, keep: line}`. A batch is split: its requests are errored and
   * its notifications are preserved in a `keep` batch — so a `notifications/
   * cancelled` riding alongside a failed request is never lost.
   */
  failRequest(line: string, reason: string): { error: string | null; keep: string | null } {
    const { single, items } = parseFrame(line);
    if (single) {
      const id = msgId(single);
      if (id === undefined || single.method === undefined) return { error: null, keep: line };
      if (this.isExemptInitialize(id)) return { error: null, keep: line };
      this.outstanding.delete(id);
      return { error: JSON.stringify(disconnectError(id, single.method, reason)), keep: null };
    }
    // Unparseable / primitive / empty-array line: nothing to classify. Keep it
    // verbatim so it still reaches a fresh server after reconnect (which will
    // answer it, e.g. with a parse error) instead of silently vanishing.
    if (items.length === 0) return { error: null, keep: line };
    // Batch: error its requests, but keep its non-request items (notifications,
    // responses) so they can still be delivered after reconnect.
    const errors: unknown[] = [];
    const kept: JsonRpcMsg[] = [];
    for (const msg of items) {
      const id = msgId(msg);
      if (id === undefined || msg.method === undefined || this.isExemptInitialize(id)) {
        kept.push(msg);
        continue;
      }
      this.outstanding.delete(id);
      errors.push(disconnectError(id, msg.method, reason));
    }
    return {
      error: errors.length > 0 ? JSON.stringify(errors) : null,
      keep: kept.length > 0 ? JSON.stringify(kept) : null,
    };
  }

  /** Handshake lines to send to a fresh server before resuming traffic. */
  replayMessages(): string[] {
    const out: string[] = [];
    if (this.initializeRaw !== null) {
      out.push(this.initializeRaw);
      // Swallow the duplicate response only if the client already got one;
      // otherwise the fresh response answers the still-outstanding request.
      if (this.initResponseSeen) this.awaitingReplayResponse = true;
    }
    if (this.initializedRaw !== null) out.push(this.initializedRaw);
    return out;
  }
}

export interface RelayIO {
  clientIn: NodeJS.ReadableStream;
  clientOut: NodeJS.WritableStream;
  log?: (msg: string) => void;
  exit: (code: number) => void;
}

export interface RelayOpts {
  /** How long queued requests wait for a reconnect before failing (ms). */
  queueGraceMs?: number;
  /** Give up after this many consecutive connections that die young. */
  rapidFailMax?: number;
  /** A connection younger than this at death counts as a rapid failure (ms). */
  rapidFailWindowMs?: number;
  /** Cap on lines held in the disconnected queue before backpressure kicks in
   * (0 disables the cap — unbounded, never pauses the client). */
  maxPending?: number;
  /** Ceiling on how long shutdown waits for stdout to flush before force-exiting (ms). */
  exitFlushTimeoutMs?: number;
  /** Connection preamble line (no trailing newline) written first on every
   * attach — initial connect AND each reconnect, since every connection gets a
   * fresh per-connection server that must learn its surface again. */
  preamble?: string;
}

// The second sentence is core's NO_DIRECT_WRITES, copied, not imported: the
// bridge is bundled on its own and pulls nothing from @vault-mcp/core.
// tests/session-rotate.test.mjs pins the two texts together.
export const DISCONNECT_REASON =
  "vault-mcp: connection to Obsidian lost (restarting?) — retry shortly. " +
  "Do not write vault files directly; stop and retry, then report to your superior.";

export class BridgeRelay {
  readonly state = new RelayState();
  private sock: net.Socket | null = null;
  private inBuf = "";
  private sockBuf = "";
  private clientEnded = false;
  private pending: string[] = [];
  private graceTimer: NodeJS.Timeout | null = null;
  private graceExpired = false;
  private connectedAt = 0;
  private rapidFails = 0;
  private clientPausedForQueue = false;
  private readonly queueGraceMs: number;
  private readonly rapidFailMax: number;
  private readonly rapidFailWindowMs: number;
  private readonly maxPending: number;
  private readonly exitFlushTimeoutMs: number;
  private readonly preamble: string | undefined;

  constructor(
    private io: RelayIO,
    private reconnect: () => Promise<net.Socket>,
    opts: RelayOpts = {}
  ) {
    this.queueGraceMs = opts.queueGraceMs ?? 30000;
    this.rapidFailMax = opts.rapidFailMax ?? 5;
    this.rapidFailWindowMs = opts.rapidFailWindowMs ?? 5000;
    this.maxPending = opts.maxPending ?? 10000;
    this.exitFlushTimeoutMs = opts.exitFlushTimeoutMs ?? 5000;
    this.preamble = opts.preamble;
  }

  // Fail the requests in `line`, writing their JSON-RPC error responses, and
  // return the part to re-queue for delivery after reconnect (notifications,
  // responses, unclassifiable lines), or null. Single source of the
  // disconnect-fail contract so its three callers can't drift (bug #54.3).
  private failAndWrite(line: string): string | null {
    const { error, keep } = this.state.failRequest(line, DISCONNECT_REASON);
    if (error) this.io.clientOut.write(`${error}\n`);
    return keep;
  }

  // Queue a line for later delivery, applying backpressure: once the
  // disconnected queue fills, pause the client so an outage can't grow memory
  // without bound (the connected path pauses on sock overflow the same way).
  // maxPending <= 0 disables the cap (unbounded) rather than pausing forever.
  private enqueue(line: string): void {
    this.pending.push(line);
    if (
      this.maxPending > 0 &&
      this.pending.length >= this.maxPending &&
      !this.clientPausedForQueue
    ) {
      this.clientPausedForQueue = true;
      this.io.clientIn.pause();
    }
  }

  // Undo an enqueue-induced pause. Unconditional (not gated on queue size): the
  // only callers are the reconnect flush (queue already drained) and grace
  // expiry, where we MUST resume even with a still-large retained queue —
  // otherwise a notification flood that paused stdin before grace would keep it
  // paused and starve the post-grace fast-fail path. Past grace we never
  // re-pause (the fast-fail branch retains bounded and never enqueues), so
  // resuming here can't reintroduce unbounded growth.
  private resumeClient(): void {
    if (this.clientPausedForQueue) {
      this.clientPausedForQueue = false;
      this.io.clientIn.resume();
    }
  }

  start(first: net.Socket): void {
    // utf8 via setEncoding, NOT per-chunk Buffer.toString(): a multi-byte
    // character split across chunks must be carried, not mangled to U+FFFD.
    this.io.clientIn.setEncoding("utf8");
    this.io.clientIn.on("data", (chunk: Buffer | string) =>
      this.onClientData(typeof chunk === "string" ? chunk : chunk.toString())
    );
    this.io.clientIn.on("end", () => {
      this.clientEnded = true;
      // The old pipe forwarded every byte before half-closing; flush an
      // unterminated final message rather than dropping it.
      if (this.inBuf.length > 0) this.onClientData("\n");
      // Socket up: half-close and let onSocketClose exit. Socket down (mid-
      // reconnect): shutdown() answers anything still queued before exiting —
      // a bare exit(0) here would silently drop requests the client awaits.
      if (this.sock) this.sock.end();
      else this.shutdown(0);
    });
    this.attach(first);
  }

  private onClientData(chunk: string): void {
    const { lines, rest } = splitLines(this.inBuf, chunk);
    this.inBuf = rest;
    const sock = this.sock;
    let overflowed = false;
    for (const line of lines) {
      this.state.onClientMessage(line);
      if (sock) {
        if (!sock.write(`${line}\n`)) overflowed = true;
      } else if (this.graceExpired) {
        // Past the grace budget: answer new requests immediately rather than
        // letting the client hang on the queue. Retain the non-request
        // remainder for delivery after reconnect, but bounded and WITHOUT
        // backpressure — dropping once the queue is full instead of pausing
        // stdin, which would starve this very fast-fail path.
        const keep = this.failAndWrite(line);
        if (keep && (this.maxPending <= 0 || this.pending.length < this.maxPending)) {
          this.pending.push(keep);
        }
      } else {
        this.enqueue(line);
      }
    }
    // pipe()-equivalent backpressure: pause the source until the sink drains.
    if (overflowed && sock && sock === this.sock) {
      this.io.clientIn.pause();
      sock.once("drain", () => this.io.clientIn.resume());
    }
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.sockBuf = "";
    this.connectedAt = Date.now();
    // The preamble must be the connection's first line — written here, before
    // the reconnect path replays the handshake and before any client traffic
    // is forwarded (both happen after attach returns).
    if (this.preamble !== undefined) sock.write(`${this.preamble}\n`);
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onServerData(chunk, sock));
    sock.on("error", () => {
      /* 'close' always follows; the reconnect path handles it */
    });
    sock.on("close", () => this.onSocketClose());
  }

  private onServerData(chunk: string, sock: net.Socket): void {
    const { lines, rest } = splitLines(this.sockBuf, chunk);
    this.sockBuf = rest;
    let overflowed = false;
    for (const line of lines) {
      const verdict = this.state.onServerMessage(line);
      if (verdict === "replay-error") {
        this.io.log?.(`vault rejected the replayed initialize: ${line}`);
        this.shutdown(1);
        return;
      }
      if (verdict === "forward" && !this.io.clientOut.write(`${line}\n`)) {
        overflowed = true;
      }
    }
    if (overflowed && sock === this.sock) {
      sock.pause();
      this.io.clientOut.once("drain", () => sock.resume());
    }
  }

  private onSocketClose(): void {
    this.sock = null;
    if (this.clientEnded) {
      // The vault may have just written its final response (still buffered in
      // the async stdout pipe); flush before exiting so it isn't truncated.
      this.flushThenExit(0);
      return;
    }
    // A stream paused for backpressure would otherwise stay paused forever;
    // the queue-pause flag is cleared with it so enqueue can re-arm cleanly.
    this.clientPausedForQueue = false;
    this.io.clientIn.resume();
    // Connections that keep dying young mean the vault plugin is unhealthy —
    // reconnect deadlines never bind (each connect "succeeds"), so bound the
    // cycle count instead of looping the replay forever. Keyed on per-connection
    // LIFETIME, not death spacing: a healthy vault that merely gets restarted a
    // few times in quick succession (a plugin reload/auto-update cycle) served
    // traffic each time and must not be torn down — only crash-on-accept loops
    // (young deaths) are, at any reconnect latency.
    if (Date.now() - this.connectedAt < this.rapidFailWindowMs) {
      this.rapidFails += 1;
    } else {
      this.rapidFails = 0;
    }
    for (const line of this.state.failOutstanding(DISCONNECT_REASON)) {
      this.io.clientOut.write(`${line}\n`);
    }
    if (this.rapidFails >= this.rapidFailMax) {
      this.io.log?.(
        `giving up: ${this.rapidFailMax} consecutive connections died within ` +
          `${this.rapidFailWindowMs}ms — the vault plugin looks unhealthy`
      );
      this.shutdown(1);
      return;
    }
    this.graceExpired = false;
    if (this.queueGraceMs > 0) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        this.graceExpired = true;
        const kept: string[] = [];
        for (const line of this.pending) {
          const keep = this.failAndWrite(line);
          if (keep) kept.push(keep);
        }
        this.pending = kept;
        this.resumeClient();
      }, this.queueGraceMs);
    }
    this.io.log?.("socket closed; waiting for Obsidian to come back");
    this.reconnect().then(
      (sock) => {
        // The client EOF'd while we were reconnecting: the session is already
        // shut down. Don't attach/replay against a dead client — just drop the
        // freshly-won socket (and leave no orphaned live connection behind).
        if (this.clientEnded) {
          sock.destroy();
          return;
        }
        if (this.graceTimer) {
          clearTimeout(this.graceTimer);
          this.graceTimer = null;
        }
        this.graceExpired = false;
        this.attach(sock);
        // All synchronous, so nothing can interleave: handshake replay first,
        // then everything queued while the vault was down. A handshake message
        // that arrived DURING the outage sits in both places — replay wins,
        // the queued copy is skipped, so the fresh server sees it once.
        const replayed = this.state.replayMessages();
        for (const m of replayed) sock.write(`${m}\n`);
        for (const line of this.pending.splice(0)) {
          if (replayed.includes(line)) continue;
          sock.write(`${line}\n`);
        }
        this.resumeClient();
        this.io.log?.("reconnected");
      },
      (e: unknown) => {
        // Already shut down by the EOF path — nothing left to fail or exit.
        if (this.clientEnded) return;
        this.io.log?.((e as Error).message);
        this.shutdown(1);
      }
    );
  }

  private shutdown(code: number): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    // Answer whatever is still queued so the client isn't left hanging.
    // (We're terminating, so the kept remainder can't be delivered — drop it.)
    for (const line of this.pending.splice(0)) this.failAndWrite(line);
    this.flushThenExit(code);
  }

  // Exit only after clientOut has flushed. clientOut is process.stdout, an
  // async pipe when Claude Code spawns us; process.exit() truncates its
  // unflushed writes, so synthesized error/response lines written this tick
  // would never reach the client and it would hang instead of seeing the error.
  // Write callbacks fire in order, so deferring the exit to a final flush's
  // callback guarantees every prior write landed first. A timeout backstop
  // guarantees termination even if the client stopped draining stdout (then the
  // callback would never fire and the bridge would linger as an orphan). Unref'd
  // so the backstop never keeps the process alive on the happy path.
  private flushThenExit(code: number): void {
    let done = false;
    const exit = (): void => {
      if (done) return;
      done = true;
      this.io.exit(code);
    };
    this.io.clientOut.write("", exit);
    const t = setTimeout(exit, this.exitFlushTimeoutMs);
    (t as { unref?: () => void }).unref?.();
  }
}

// How long a live session waits for the vault socket to come back after it
// drops (Obsidian restart, plugin reload) before giving up and exiting.
const RECONNECT_MS = envMs(process.env.VAULT_MCP_RECONNECT_MS, 300000);
// How long queued requests wait for that reconnect before failing fast.
const QUEUE_GRACE_MS = envMs(process.env.VAULT_MCP_QUEUE_GRACE_MS, 30000);
// Cap on lines held in the disconnected queue before the client is paused, so
// a long outage streaming notifications can't grow memory without bound.
const MAX_PENDING = envMs(process.env.VAULT_MCP_MAX_PENDING, 10000);

// The startup wait loop, reused for reconnects: poll discoveries until the
// pinned (or sole) vault accepts a connection, else throw the same actionable
// diagnostic the one-shot bridge reported.
async function waitForVault(
  pick: string | undefined,
  deadline: number,
  fallback?: string
): Promise<{ sock: net.Socket; chosen: Discovery }> {
  for (;;) {
    const all = loadDiscoveries();
    // When pinned, only the matching vault can ever be chosen — don't touch
    // (or later, probe) unrelated vaults on every poll tick.
    const candidates = pick ? all.filter((d) => d.vault_name === pick) : all;
    const target = resolveTarget(filterLive(candidates), pick, sessionDir(), fallback);
    if (target.kind === "fatal") throw new Error(target.message);
    if (target.kind === "ok") {
      const sock = await tryConnect(target.chosen);
      if (sock) return { sock, chosen: target.chosen };
      // Socket file present but not accepting yet — fall through and retry.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        target.kind === "wait" && target.for !== undefined
          ? defaultMissingMessage(target.for, target.why)
          : deadlineMessage(all, pick)
      );
    }
    await sleep(POLL_MS);
  }
}

// --- Multi-vault mode: one session, every open vault (see mux.ts) ---

/** `--multi-vault` or VAULT_MCP_MULTI=1|true|yes|on. */
export function parseMultiFlag(argv: string[], env?: string): boolean {
  return argv.includes("--multi-vault") || ["1", "true", "yes", "on"].includes((env ?? "").toLowerCase());
}

export type MuxDefault =
  | { name: string; reason: string }
  | { missing: string; reason: string; path?: string }
  | undefined;

/**
 * The vault a call without `vault` goes to, among the connected ones, and why:
 * the pin; then the vault folder the session runs in (the deepest one, found
 * on disk by `vaultRootOf` whether or not it is connected); then the soft
 * default; then the only vault. Undefined when none of these applies.
 * Nothing falls through (#643): when the pin, the session's vault folder or
 * the soft default is not connected the result is `missing` (with `path` for
 * the folder case), the bridge waits for it, and if it never comes the mux
 * refuses calls without `vault` rather than sending them to a vault nobody chose.
 */
export function muxDefault(
  connected: Discovery[],
  pick: string | undefined,
  cwd: string,
  fallback: string | undefined,
  rootOf: (dir: string) => string | undefined = vaultRootOf
): MuxDefault {
  if (pick === "") pick = undefined;
  if (fallback === "") fallback = undefined;
  const has = (n: string): boolean => connected.some((d) => d.vault_name === n);
  if (pick !== undefined) {
    return has(pick) ? { name: pick, reason: "set by --vault" } : { missing: pick, reason: "set by --vault" };
  }
  const here = vaultForDir(connected, cwd);
  // Inside a vault folder that is not connected (reloading, or closed), and
  // deeper than any connected vault that contains it.
  const root = rootOf(cwd);
  if (here && !deeperThan(root, here)) return { name: here.vault_name, reason: "the session runs inside it" };
  if (root !== undefined) return { missing: path.basename(root), reason: "the session runs inside it", path: root };
  if (fallback !== undefined) {
    return has(fallback)
      ? { name: fallback, reason: "set by --default-vault" }
      : { missing: fallback, reason: "set by --default-vault" };
  }
  if (connected.length === 1) return { name: connected[0].vault_name, reason: "the only vault open" };
  return undefined;
}

// Wait, up to the deadline, for one more vault to become connectable. Used
// when the session's intended default is not among those connected at start.
async function connectOne(
  want: { missing: string; path?: string },
  deadline: number
): Promise<{ d: Discovery; sock: net.Socket } | undefined> {
  const matches = (x: Discovery): boolean =>
    want.path !== undefined
      ? typeof x.vault_path === "string" && realOrResolved(x.vault_path) === want.path
      : x.vault_name === want.missing;
  for (;;) {
    const d = filterLive(loadDiscoveries()).find(matches);
    if (d) {
      const sock = await tryConnect(d);
      if (sock) return { d, sock };
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(POLL_MS);
  }
}

// How long, after the first vault answers, to wait for others still binding
// their sockets. A stale socket file (a deleted vault) refuses at once and is
// skipped; this only bounds vaults that are mid-launch.
const MULTI_SETTLE_MS = envMs(process.env.VAULT_MCP_MULTI_SETTLE_MS, 2000);

// How long multi mode waits for the session's intended default vault before it
// answers the client without it. Kept well under a client's MCP start-up
// timeout, so the open vaults stay usable; a plugin reload takes seconds.
const MULTI_DEFAULT_WAIT_MS = envMs(process.env.VAULT_MCP_MULTI_DEFAULT_WAIT_MS, 10000);

async function connectAll(deadline: number): Promise<{ d: Discovery; sock: net.Socket }[]> {
  const got = new Map<string, { d: Discovery; sock: net.Socket }>();
  let settleBy = Infinity;
  for (;;) {
    const live = filterLive(loadDiscoveries());
    const names = live.map((d) => d.vault_name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup !== undefined) {
      for (const c of got.values()) c.sock.destroy();
      throw new Error(`vault-mcp: two open vaults are both named "${dup}"; multi-vault mode needs distinct names`);
    }
    for (const d of live) {
      if (got.has(d.vault_name)) continue;
      const sock = await tryConnect(d);
      if (sock) got.set(d.vault_name, { d, sock });
    }
    if (got.size > 0 && settleBy === Infinity) settleBy = Date.now() + MULTI_SETTLE_MS;
    if (got.size > 0 && (got.size === live.length || Date.now() >= settleBy)) break;
    if (Date.now() >= deadline) {
      if (got.size > 0) break;
      throw new Error(noLiveMessage(loadDiscoveries()));
    }
    await sleep(POLL_MS);
  }
  return [...got.values()].sort((a, b) => a.d.vault_name.localeCompare(b.d.vault_name));
}

async function runMultiVault(
  pick: string | undefined,
  fallback: string | undefined,
  codeModeWanted: boolean,
  profileWanted: string | undefined
): Promise<void> {
  // A profile narrows the tool surface and must fail closed; merging surfaces
  // across vaults would widen it, so the two are not combined.
  if (profileWanted !== undefined) {
    throw new Error("vault-mcp: --multi-vault cannot be combined with a connection profile (VAULT_MCP_PROFILE)");
  }
  const log = (msg: string): void => {
    try {
      fs.writeSync(2, `vault-mcp: ${msg}\n`);
    } catch {
      /* ignore */
    }
  };
  const deadline = Date.now() + WAIT_MS;
  const connected = await connectAll(deadline);
  let dflt = muxDefault(connected.map((c) => c.d), pick, sessionDir(), fallback);
  if (dflt !== undefined && "missing" in dflt) {
    // The intended default is not up yet (a plugin reload, a deploy): wait for
    // it rather than let another vault take its calls.
    log(`multi-vault: waiting for the default vault '${dflt.missing}' (${dflt.reason})`);
    const late = await connectOne(dflt, Math.min(deadline, Date.now() + MULTI_DEFAULT_WAIT_MS));
    if (late && connected.some((c) => c.d.vault_name === late.d.vault_name)) {
      // Two folders with one name: the mux keys vaults by name, so this one
      // cannot join. Close it, and the default stays missing.
      log(`multi-vault: vault '${late.d.vault_name}' at ${late.d.vault_path} has the same name as a connected vault; not joined`);
      late.sock.destroy();
    } else if (late) {
      connected.push(late);
      connected.sort((a, b) => a.d.vault_name.localeCompare(b.d.vault_name));
      dflt = muxDefault(connected.map((c) => c.d), pick, sessionDir(), fallback);
    }
  }
  const missingDefault = dflt !== undefined && "missing" in dflt ? { name: dflt.missing, reason: dflt.reason } : undefined;
  const chosenDefault = dflt !== undefined && "name" in dflt ? dflt : undefined;
  log(
    `multi-vault: ${connected.map((c) => c.d.vault_name).join(", ")}` +
      (chosenDefault
        ? `; default ${chosenDefault.name} (${chosenDefault.reason})`
        : missingDefault
          ? `; the default vault '${missingDefault.name}' (${missingDefault.reason}) is not open: calls without "vault" are refused`
          : "; no default vault")
  );
  const backends = connected.map(({ d }) => ({
    name: d.vault_name,
    path: typeof d.vault_path === "string" ? d.vault_path : undefined,
    input: new PassThrough(),
    output: new PassThrough(),
  }));
  const mux = new VaultMux(
    { clientIn: process.stdin, clientOut: process.stdout, log },
    backends,
    { defaultVault: chosenDefault?.name, defaultReason: chosenDefault?.reason, missingDefault }
  );
  let exiting = false;
  const exitAll = (code: number): void => {
    if (exiting) return;
    exiting = true;
    let done = false;
    const go = (): void => {
      if (done) return;
      done = true;
      process.exit(code);
    };
    process.stdout.write("", go);
    const t = setTimeout(go, 5000);
    (t as { unref?: () => void }).unref?.();
  };
  connected.forEach(({ d, sock }, i) => {
    const name = d.vault_name;
    const b = backends[i];
    let preamble: string | undefined;
    if (codeModeWanted) {
      if (supportsPreamble(d)) preamble = buildPreamble({ codeMode: true });
      else log(`code mode requested but vault '${name}' runs plugin ${d.plugin_version ?? "unknown"} without preamble support — full tool surface there`);
    }
    const relay = new BridgeRelay(
      {
        clientIn: b.input,
        clientOut: b.output,
        log: (msg) => log(`[${name}] ${msg}`),
        // One vault giving up must not end the session for the others; the
        // last one out takes the process with it. Deferred a tick so the error
        // lines it just wrote reach the client first.
        exit: (code) =>
          setImmediate(() => {
            mux.markDead(name);
            if (mux.liveCount() === 0) exitAll(code);
          }),
      },
      async () => (await waitForVault(name, Date.now() + RECONNECT_MS)).sock,
      { queueGraceMs: QUEUE_GRACE_MS, maxPending: MAX_PENDING, preamble }
    );
    relay.start(sock);
  });
  mux.start();
}

// Entry point (skipped under test import; runs when executed as a script).
if (process.argv[1] && process.argv[1].endsWith("bridge.mjs") && parseMultiFlag(process.argv, process.env.VAULT_MCP_MULTI)) {
  runMultiVault(
    parseFlag(process.argv, "vault") || process.env.VAULT_MCP_VAULT || undefined,
    parseFlag(process.argv, "default-vault") || process.env.VAULT_MCP_DEFAULT_VAULT || undefined,
    parseCodeModeFlag(process.argv, process.env.VAULT_MCP_CODE_MODE),
    profileFromEnv(process.env.VAULT_MCP_PROFILE)
  ).catch((e) => {
    const msg = (e as Error).message;
    fail(msg.startsWith("vault-mcp") ? msg : `vault-mcp bridge: ${msg}`);
  });
} else if (process.argv[1] && process.argv[1].endsWith("bridge.mjs")) {
  const pick = parseFlag(process.argv, "vault") || process.env.VAULT_MCP_VAULT || undefined;
  // A soft default: used when the session's directory is inside no vault
  // folder (see resolveTarget). `--vault` is the hard pin.
  const fallback = parseFlag(process.argv, "default-vault") || process.env.VAULT_MCP_DEFAULT_VAULT || undefined;
  // Code Mode: register this session with the compact search/describe/call
  // meta-tool surface instead of the full tool set (token-lean; see preamble.ts).
  const codeModeWanted = parseCodeModeFlag(process.argv, process.env.VAULT_MCP_CODE_MODE);
  // The remote front's connection profile (#521); a local bridge has none and is unchanged.
  const profileWanted = profileFromEnv(process.env.VAULT_MCP_PROFILE);
  (async () => {
    const { sock, chosen } = await waitForVault(pick, Date.now() + WAIT_MS, fallback);
    // Pin reconnects to the vault we first connected to, so another vault
    // appearing mid-session can neither divert nor ambiguate the reconnect.
    const pinned = chosen.vault_name;
    let preamble: string | undefined;
    if (profileWanted !== undefined) {
      if (!supportsProfile(chosen)) {
        throw new Error(
          `vault-mcp: profile '${profileWanted}' requested but vault '${chosen.vault_name}' runs plugin ` +
            `${chosen.plugin_version ?? "unknown"} without profile support — refusing to connect`
        );
      }
      preamble = buildPreamble({ codeMode: false, profile: profileWanted });
    } else if (codeModeWanted) {
      if (supportsPreamble(chosen)) {
        preamble = buildPreamble({ codeMode: true });
        fs.writeSync(2, "vault-mcp: code mode on\n");
      } else {
        fs.writeSync(
          2,
          `vault-mcp: code mode requested but vault '${chosen.vault_name}' runs plugin ` +
            `${chosen.plugin_version ?? "unknown"} without preamble support — continuing with the full tool surface\n`
        );
      }
    }
    const relay = new BridgeRelay(
      {
        clientIn: process.stdin,
        clientOut: process.stdout,
        log: (msg) => {
          try {
            fs.writeSync(2, `vault-mcp: ${msg}\n`);
          } catch {
            /* ignore */
          }
        },
        exit: (code) => process.exit(code),
      },
      async () => {
        const again = await waitForVault(pinned, Date.now() + RECONNECT_MS);
        // A plugin reloaded mid-session as an older build must not receive the profile and ignore it.
        if (profileWanted !== undefined && !supportsProfile(again.chosen)) {
          again.sock.destroy();
          throw new Error(`vault-mcp: vault '${pinned}' no longer advertises profile support — refusing to reconnect`);
        }
        return again.sock;
      },
      { queueGraceMs: QUEUE_GRACE_MS, maxPending: MAX_PENDING, preamble }
    );
    relay.start(sock);
  })().catch((e) => {
    // Diagnostics from waitForVault already carry the vault-mcp prefix;
    // don't stutter it.
    const msg = (e as Error).message;
    fail(msg.startsWith("vault-mcp") ? msg : `vault-mcp bridge: ${msg}`);
  });
}
