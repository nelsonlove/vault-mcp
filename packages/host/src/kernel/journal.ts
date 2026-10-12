// Write journal — kernel v0's audit stream.
//
// One JSONL record per mutating operation, appended to
// `<plugin data dir>/journal/YYYY-MM.jsonl` (rolled monthly). The record is
// OPERATION-centric, not filesystem-centric: git already says which bytes
// changed, this says what happened — which operation, against which target, on
// whose behalf, with what outcome.
//
// Append-only by construction: `append` is the only method that touches the
// file, and no edit/delete/compact API exists anywhere in this module. Rolling
// is by filename, so pruning is a manual, out-of-band act on whole months.
//
// Note bodies never enter the journal. Arguments are reduced to `argsDigest`
// (see digestArgs) so the journal stays a log of operations rather than a
// shadow copy of the vault.

import type { LockNotice } from "./locks.js";
import type { ServerIdentity } from "./install-id.js";

/**
 * Outcome of a journaled operation.
 *
 * `late-ok` / `late-error` belong to CORRECTIVE records: an operation the write
 * queue abandoned on timeout (journaled `error`) settled afterwards, and the
 * corrective record — linked by `corrects` — says how. Append-only means the
 * original record is never rewritten; the correction is a new line.
 *
 * `conflict` is an `if_rev` precondition failure: the target's revision at
 * dequeue was not the one the caller expected, so NO write ran (`revBefore`
 * holds the revision actually found).
 *
 * `deduped` is an idempotency-key replay: a call whose key was already seen
 * returned the original call's result without executing anything, and
 * `dedupeOf` names the `ts` of the record it replays.
 */
export type JournalOutcome = "ok" | "error" | "late-ok" | "late-error" | "conflict" | "deduped";

/**
 * Who did it. Established by the transport, never claimed by the caller:
 * everything reaching this module came over the MCP socket, so `transport` is
 * a constant and the client identity comes from the connection's initialize
 * handshake rather than from tool arguments.
 *
 * `server` is the other half of that assertion — not who called, but which
 * transport answered: which vault, which install of the plugin, which version.
 * A journal shipped between machines, or two vaults' journals concatenated,
 * stays attributable.
 */
export interface JournalActor {
  transport: "mcp";
  /** `name/version` from the MCP client's initialize handshake, when it sent one. */
  client?: string;
  /** Per-connection id, minted when this connection's server was built. */
  connection: string;
  /** The connection's durable session id (WP5), once sessions are wired. */
  session?: string;
  /** Server identity: `{vault, install, version}`. See kernel/install-id.ts. */
  server?: ServerIdentity;
}

/** What it acted on. `uid` is read from frontmatter only when the cache already has it. */
export interface JournalTarget {
  path?: string;
  uid?: string;
  /** Present only for multi-target operations (batch moves); capped. */
  paths?: string[];
  /**
   * Non-path target, e.g. `command:editor:toggle-bold` or `plugin:dataview`.
   * Present only when the operation names no vault path at all, so a pathless
   * mutator (run a command, toggle a plugin) still says what it acted on.
   */
  ref?: string;
}

/**
 * What the operation actually touched, for the operations whose blast radius is
 * NOT in their arguments.
 *
 * `target` is derived from the paths the arguments name, which is the right
 * answer for almost everything: a write names its note, a move names both ends.
 * But `obsidian_repoint_link` names only the link target and then discovers,
 * reads and rewrites a set of notes for itself — so a record built from its
 * arguments alone would describe a one-file operation that changed forty. That
 * is not a small inaccuracy in an audit stream; it is the difference between
 * "what happened" and "what was asked for".
 *
 * Recorded only when the handler REPORTED it (see effectsOf in mcp/guarded.ts,
 * where the tool surface's result conventions live) — never inferred, and never
 * for an operation that declared itself a dry run.
 *
 * Read it as SELF-REPORTING: this is what the handler said it did, exactly as
 * claimed, not something the kernel observed or verified. The kernel has no
 * independent view of a repoint's blast radius — that is the whole reason the
 * field exists — so a wrong handler produces a wrong record here and the
 * journal cannot tell. `target` is the argument-derived claim; `effects` is the
 * handler's. Both are claims; neither is a measurement.
 */
export interface JournalEffects {
  /**
   * Files the operation changed, as the handler counted them. EXACT-AS-CLAIMED:
   * never truncated to match the (capped) `paths` list below, and never checked.
   */
  filesChanged: number;
  /** The changed paths, capped — the shape, not the payload. Absent when none. */
  paths?: string[];
}

export interface JournalRecord {
  ts: string;
  op: string;
  target: JournalTarget;
  actor: JournalActor;
  argsDigest: Record<string, unknown>;
  outcome: JournalOutcome;
  error?: string;
  /** Handler execution only — measured from dequeue, so it never includes queue wait. */
  durationMs: number;
  /** Enqueue→dequeue: how long the operation waited behind other writes. */
  queueWaitMs: number;
  /** mtime (ms) of target.path before/after the operation; absent when the file didn't exist. */
  revBefore?: number;
  revAfter?: number;
  /** On a corrective record: the `ts` of the record it corrects. */
  corrects?: string;
  /** The caller's `if_rev` precondition, when one was supplied. */
  ifRev?: number;
  /** The caller's `idempotency_key`, when one was supplied. */
  idempotencyKey?: string;
  /**
   * With `idempotencyKey`: the hash half of the call's args fingerprint
   * (`fingerprintArgs` = stable argsDigest + "#" + this). Lets a reloaded
   * instance rebuild the key's identity from the journal (#435).
   */
  argsHash?: string;
  /** With `idempotencyKey`: the operation RETURNED an envelope (ok or isError) rather than throwing (#435 seeding). */
  returned?: boolean;
  /**
   * The caller's advisory `intent` text, when one was supplied (B2): the
   * agent's own description of why it made this change, for review surfaces to
   * display as "agent says". Untrusted free text — recorded verbatim, never
   * interpreted, never an acceptance signal.
   */
  intent?: string;
  /**
   * The caller's ADDRESS FORM(s), when the call addressed by `uid:<value>` or
   * a scheme ref (`jd:<address>`) rather than a raw path: each entry pairs the
   * ref as passed with the path it resolved to at call time. Audit-of-intent
   * beside `target`'s audit-of-effect — if the index was stale or wrong, the
   * record shows the caller addressed something other than what was touched.
   * Absent for plain-path calls. Capped like `target.paths`.
   */
  addressedAs?: Array<{ ref: string; path: string }>;
  /** The Sync guard's warning, when the write went on while Obsidian Sync was behind or unreadable (kernel/sync-guard.ts). */
  syncWarning?: string;
  /** On a `deduped` record: the `ts` of the record whose result was replayed. */
  dedupeOf?: string;
  /**
   * The operation's real blast radius, when the handler reported one that its
   * arguments could not (a vault-wide link repoint). See JournalEffects.
   */
  effects?: JournalEffects;
  /**
   * Present when the operation's PRIMARY target fell inside another holder's
   * live advisory claim. The operation still ran — claims never block — so this
   * records what it walked into, not why it stopped. Most specific claim only
   * when several overlap.
   */
  lockNotice?: LockNotice;
}

/**
 * The slice of Obsidian's DataAdapter the journal needs. Narrowed to a duck
 * type so the journal is testable without Obsidian (and so nothing here can
 * reach a delete/remove API by accident).
 */
export interface JournalAdapter {
  exists(normalizedPath: string): Promise<boolean>;
  mkdir(normalizedPath: string): Promise<void>;
  write(normalizedPath: string, data: string): Promise<void>;
  append(normalizedPath: string, data: string): Promise<void>;
}

// ── argument digest ───────────────────────────────────────────────────────────

// Keys whose string values are note bodies — always summarized, never recorded.
const BODY_KEYS = new Set(["content", "body", "data", "text", "template_content"]);
const MAX_STRING = 120;
const MAX_ARRAY = 10;
const MAX_DEPTH = 3;

function digestValue(key: string, value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return BODY_KEYS.has(key) || value.length > MAX_STRING ? `<${value.length} chars>` : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `<array:${value.length}>`;
    const head = value.slice(0, MAX_ARRAY).map((v) => digestValue(key, v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `<+${value.length - MAX_ARRAY} more>`] : head;
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "<object>";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = digestValue(k, v, depth + 1);
    return out;
  }
  // functions/symbols/undefined can't arrive over JSON-RPC; drop them.
  return undefined;
}

/**
 * Reduce tool arguments to a small, body-free summary: known body-bearing keys
 * and any over-long string become `<N chars>`, long arrays are truncated, deep
 * nesting collapses. Shape is preserved so a record stays greppable by path,
 * flag, and key name.
 */
export function digestArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    const d = digestValue(k, v, 0);
    if (d !== undefined) out[k] = d;
  }
  return out;
}

// ── file naming ───────────────────────────────────────────────────────────────

/**
 * `YYYY-MM` — the monthly roll key. UTC, so a file name always agrees with the
 * `ts` of every record inside it (records are ISO/UTC); a local-time key would
 * put a record stamped 2026-09-01T00:30Z into 2026-08.jsonl west of Greenwich.
 */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── the journal ───────────────────────────────────────────────────────────────

export class WriteJournal {
  // Appends are chained so two operations can never interleave half-lines.
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: JournalAdapter,
    /** Directory for journal files, vault-relative (e.g. `.obsidian/plugins/governor/journal`). */
    private readonly dir: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Current month's journal file, vault-relative. */
  currentFile(): string {
    return `${this.dir}/${monthKey(this.now())}.jsonl`;
  }

  /**
   * Append one record. THE ONLY WRITE PATH — there is deliberately no API to
   * edit, rewrite, or delete a record.
   *
   * Never rejects: a journal that can't be written is logged and dropped, so a
   * full disk or a missing folder can't turn a successful vault operation into
   * a failed one. The returned promise resolves when the write has been
   * attempted (tests await it; callers fire-and-forget).
   */
  append(record: JournalRecord): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    const file = this.currentFile();
    const next = this.tail
      .then(() => this.writeLine(file, line))
      .catch((e: unknown) => {
        console.error("[vault-mcp] journal append failed", e);
      });
    this.tail = next;
    return next;
  }

  private async writeLine(file: string, line: string): Promise<void> {
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    // write() only ever creates the month's first line — an existing file is
    // always appended to, so no journal file can be truncated by this path.
    if (await this.adapter.exists(file)) await this.adapter.append(file, line);
    else await this.adapter.write(file, line);
  }
}
