/**
 * fs-write-kernel.ts — issue #92: the FS-fallback write path's serialized write
 * queue + append-only JSONL write journal.
 *
 * LIVE mode funnels every write through the plugin kernel's WriteQueue +
 * WriteJournal (packages/host/src/kernel/{write-queue,journal}.ts). FS
 * fallback mode had neither — a hole in the "every write is journaled" audit
 * claim (kernel-audit finding MEDIUM-6). This module is the lean, server-local
 * counterpart: packages/server depends on @vault-mcp/core + third-party only —
 * it does not, and must not, depend on the host plugin package — so the primitives are
 * re-stated here at the scale the FS write set needs (six backend methods)
 * rather than imported. The journal RECORD SHAPE deliberately matches the
 * plugin's JournalRecord field-for-field where the field is meaningful in FS
 * mode (ts, op, target, actor, argsDigest, outcome, error, durationMs,
 * queueWaitMs, revBefore, revAfter), so the two streams stay jointly greppable.
 *
 * Deliberate divergences from the plugin kernel (documented, not accidental):
 *
 * - **No write timeout / no corrective records.** The plugin's 30s timeout
 *   exists because Obsidian's app.* APIs expose no cancellation and a wedged
 *   call would wedge the bridge for every session. FS mode's writes are plain
 *   node:fs operations — they cannot wedge behind a UI thread, and a disk that
 *   hangs them hangs the whole process regardless. So the outcome domain here
 *   is just `ok | error` (no late-ok/late-error/conflict/deduped: FS mode has
 *   no if_rev and no idempotency keys to produce them).
 *
 * - **The cut-read refusal runs BEFORE this kernel, in fs-mode.ts's `mutate`
 *   (#441), as the plugin's guard does before its queue:** a `content` that
 *   carries the read trailer is `Error [truncated_read]` thrown before
 *   `runMutation`, so it takes no queue slot and leaves no journal record.
 *   **The whole-note-overwrite rule runs AT DEQUEUE here** (#443), as on the
 *   plugin: the note's length must be the one the write meets, after every
 *   write queued ahead has landed. So that refusal is journaled as an error.
 *   No proof of a whole read stands it aside on this transport (nor the
 *   replace-past-the-limit rule): its writes carry no if_rev, so nothing
 *   could tie a proof to the caller; #446 is that road.
 *
 * - **`actor.connection` is per-PROCESS, not per-connection.** FS mode builds a
 *   stateless McpServer per HTTP request; no per-session identity reaches the
 *   backend. The id still discriminates server restarts in a concatenated
 *   journal, which is what the field is for here.
 *
 * - **In-process serialization only.** The queue serializes every FS-mode write
 *   across all connections OF THIS PROCESS. Cross-PROCESS serialization (e.g.
 *   against an Obsidian instance racing the same files, or a second server
 *   process) is out of scope — nothing in a plain filesystem gives us a
 *   cross-process lock worth trusting, and the FS_ALLOW_WRITES gate (fs-mode.ts)
 *   exists precisely because that residual gap remains.
 *
 * - **No record immutability (#264).** The plugin kernel refuses non-append
 *   mutation of `record: true` notes at its dequeue closure
 *   (packages/host/src/kernel/record-guard.ts); FS mode has no metadata
 *   cache to probe the flag from cheaply and, like if_rev/idempotency above,
 *   does not re-state the check. With FS_ALLOW_WRITES on, a record note is
 *   mutable through this path — same residual class as the rest of this list.
 *
 * Shared semantics kept from the plugin kernel, pinned by tests:
 * - one FIFO queue per process; reads never queue; enqueue order is run order;
 * - exactly one journal record per mutating operation, error outcomes included;
 * - `append` is the journal's only write path — no edit/delete/compact API;
 * - a journal that can't be written is logged and swallowed, never failing the
 *   vault operation;
 * - note bodies never enter the journal (digestArgs).
 *
 * Journal location: `<state dir>/journal/<vault-slug>/YYYY-MM.jsonl`, beside
 * the server's other state (`~/.claude/vault-mcp/` or $VAULT_MCP_STATE_DIR) —
 * NOT inside the vault tree, where it would sync as content and where the
 * plugin's own journal already lives. Override with $VAULT_MCP_FS_JOURNAL_DIR.
 */

import { appendFile, mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

// ── Journal record shape ──────────────────────────────────────────────────────

export type FsJournalOutcome = "ok" | "error";

/**
 * Who did it. Mirrors the plugin's JournalActor: `transport` is a constant
 * (everything reaching this module came over the MCP HTTP front), `connection`
 * is the per-process id minted at kernel construction (see header), and
 * `server` says which deployment answered — with `mode: "fs-fallback"` so a
 * record can never be mistaken for a kernel-routed LIVE write.
 */
export interface FsJournalActor {
  transport: "mcp";
  connection: string;
  server: { mode: "fs-fallback"; vault: string; version: string };
}

/** What it acted on. `paths` present only for multi-target operations (move). */
export interface FsJournalTarget {
  path?: string;
  paths?: string[];
}

export interface FsJournalRecord {
  ts: string;
  op: string;
  target: FsJournalTarget;
  actor: FsJournalActor;
  argsDigest: Record<string, unknown>;
  outcome: FsJournalOutcome;
  error?: string;
  /** Handler execution only — measured from dequeue, never includes queue wait. */
  durationMs: number;
  /** Enqueue→dequeue: how long the operation waited behind other writes. */
  queueWaitMs: number;
  /** mtime (ms) of target.path before/after; absent when the file didn't exist. */
  revBefore?: number;
  revAfter?: number;
}

// ── Argument digest ───────────────────────────────────────────────────────────
//
// Ported from packages/host/src/kernel/journal.ts (digestArgs) so both
// journals summarize identically. Note bodies never land: known body-bearing
// keys and over-long strings become `<N chars>`, long arrays truncate, deep
// nesting collapses. Shape is preserved so a record stays greppable by path,
// flag, and key name.

// `old` and `new` are obsidian_replace_text's note text: like a body, never recorded.
const BODY_KEYS = new Set(["content", "body", "data", "text", "template_content", "old", "new"]);
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
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = digestValue(k, v, depth + 1);
    }
    return out;
  }
  // functions/symbols/undefined can't arrive over JSON-RPC; drop them.
  return undefined;
}

/** Reduce tool arguments to a small, body-free summary. */
export function digestArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    const d = digestValue(k, v, 0);
    if (d !== undefined) out[k] = d;
  }
  return out;
}

// ── File naming ───────────────────────────────────────────────────────────────

/**
 * `YYYY-MM` — the monthly roll key. UTC, matching the plugin's journal, so a
 * filename always agrees with the `ts` of every record inside it.
 */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Slug for a vault name — mirrors `resolveSocketPath` in front.ts (which itself
 * mirrors the plugin's `vaultSlug()`), so the journal directory sits beside the
 * socket it corresponds to.
 */
export function vaultSlug(vaultName: string): string {
  return vaultName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Env var overriding the FS-write journal directory (absolute path). */
export const FS_JOURNAL_DIR_ENV_VAR = "VAULT_MCP_FS_JOURNAL_DIR";

/**
 * Default journal directory for a vault:
 *   $VAULT_MCP_FS_JOURNAL_DIR                    — used exactly as given
 *   $VAULT_MCP_STATE_DIR/journal/<slug>          — beside the socket state
 *   ~/.claude/vault-mcp/journal/<slug>           — the default state dir
 */
export function defaultJournalDir(vaultName: string): string {
  const override = process.env[FS_JOURNAL_DIR_ENV_VAR];
  if (override) return override;
  const stateDir =
    process.env.VAULT_MCP_STATE_DIR ?? path.join(homedir(), ".claude", "vault-mcp");
  return path.join(stateDir, "journal", vaultSlug(vaultName));
}

// ── Serialized write queue ────────────────────────────────────────────────────

/**
 * One FIFO queue per process: only one FS-mode vault mutation is in flight at a
 * time across ALL connections. Promise-chained — enqueue order is run order,
 * and a failed operation never poisons the chain (its rejection reaches its own
 * caller; the tail continues).
 */
export class FsWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private depth_ = 0;

  /** Operations enqueued and not yet settled (including the running one). */
  get depth(): number {
    return this.depth_;
  }

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.depth_++;
    const result = this.tail.then(() => fn());
    // The tail swallows this operation's failure (the caller still sees it via
    // `result`) so the next enqueued operation runs regardless.
    this.tail = result.then(
      () => {
        this.depth_--;
      },
      () => {
        this.depth_--;
      },
    );
    return result;
  }
}

// ── Append-only JSONL journal ─────────────────────────────────────────────────

/** Injectable fs seams so the journal is testable without touching disk. */
export interface FsJournalIo {
  append(file: string, data: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

const realIo: FsJournalIo = {
  append: (file, data) => appendFile(file, data, "utf8"),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
};

/**
 * Append-only by construction: `append` is the only method that touches the
 * file, and no edit/delete/compact API exists anywhere in this module. Rolling
 * is by filename (monthly), so pruning is a manual, out-of-band act on whole
 * months — same contract as the plugin's WriteJournal.
 */
export class FsWriteJournal {
  // Appends are chained so two operations can never interleave half-lines.
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly io: FsJournalIo = realIo,
  ) {}

  /** Current month's journal file, absolute. */
  currentFile(): string {
    return path.join(this.dir, `${monthKey(this.now())}.jsonl`);
  }

  /**
   * Append one record. Never rejects: a journal that can't be written is
   * logged and dropped, so a full disk or a missing folder can't turn a
   * successful vault operation into a failed one. The returned promise
   * resolves when the write has been attempted.
   */
  append(record: FsJournalRecord): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    const file = this.currentFile();
    const next = this.tail
      .then(async () => {
        await this.io.mkdir(this.dir);
        await this.io.append(file, line);
      })
      .catch((e: unknown) => {
        console.error("[vault-mcp-server] fs-write journal append failed", e);
      });
    this.tail = next;
    return next;
  }
}

// ── The kernel ────────────────────────────────────────────────────────────────

export interface FsWriteKernelOpts {
  /** Absolute directory for journal files (see defaultJournalDir). */
  journalDir: string;
  /** Server identity stamped on every record's actor. */
  identity: { vault: string; version: string };
  /**
   * Resolve a vault-relative path to an absolute one, for revBefore/revAfter
   * mtime sampling. Omitted ⇒ rev fields are never recorded.
   */
  resolvePath?: (relPath: string) => string;
  /** Clock seam for tests. */
  now?: () => Date;
  /** Journal I/O seam for tests. */
  journalIo?: FsJournalIo;
  /** mtime probe seam for tests. Defaults to fs.stat. */
  statMtimeMs?: (absPath: string) => Promise<number>;
}

export class FsWriteKernel {
  readonly queue = new FsWriteQueue();
  readonly journal: FsWriteJournal;
  /** Per-process actor id (see header — FS mode has no per-session identity). */
  readonly connection = randomUUID();

  private readonly identity: { vault: string; version: string };
  private readonly resolvePath?: (relPath: string) => string;
  private readonly now: () => Date;
  private readonly statMtimeMs: (absPath: string) => Promise<number>;

  constructor(opts: FsWriteKernelOpts) {
    this.identity = opts.identity;
    this.resolvePath = opts.resolvePath;
    this.now = opts.now ?? (() => new Date());
    this.journal = new FsWriteJournal(opts.journalDir, this.now, opts.journalIo);
    this.statMtimeMs = opts.statMtimeMs ?? (async (abs) => (await stat(abs)).mtimeMs);
  }

  /** mtime (ms) of a vault-relative path, or undefined (missing file, no resolver). */
  private async revOf(relPath: string | undefined): Promise<number | undefined> {
    if (!relPath || !this.resolvePath) return undefined;
    try {
      return await this.statMtimeMs(this.resolvePath(relPath));
    } catch {
      return undefined;
    }
  }

  /**
   * Run one mutating operation through the queue and journal exactly one
   * record for it — ok and error outcomes alike. The caller sees `fn`'s own
   * result or failure; the journal append happens inside the queue slot (so
   * record order is operation order) and never rejects, so a broken journal
   * can never fail the vault operation.
   *
   * `target.path`/`target.paths` and the clock sample at DEQUEUE, inside the
   * queued closure — an enqueue-time probe would describe the world before the
   * operations ahead of this one changed it (same rule as the plugin kernel).
   */
  runMutation<T>(
    op: string,
    target: FsJournalTarget,
    args: Record<string, unknown>,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const enqueuedAt = this.now().getTime();
    return this.queue.run(async () => {
      const startedAt = this.now().getTime();
      const revBefore = await this.revOf(target.path);
      let outcome: FsJournalOutcome = "ok";
      let error: string | undefined;
      try {
        return await fn();
      } catch (e) {
        outcome = "error";
        error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        const revAfter = await this.revOf(target.path);
        const record: FsJournalRecord = {
          ts: new Date(startedAt).toISOString(),
          op,
          target,
          actor: {
            transport: "mcp",
            connection: this.connection,
            server: { mode: "fs-fallback", ...this.identity },
          },
          argsDigest: digestArgs(args),
          outcome,
          ...(error !== undefined ? { error } : {}),
          durationMs: this.now().getTime() - startedAt,
          queueWaitMs: startedAt - enqueuedAt,
          ...(revBefore !== undefined ? { revBefore } : {}),
          ...(revAfter !== undefined ? { revAfter } : {}),
        };
        // append() never rejects; awaiting it means "the record is on disk (or
        // dropped with a console.error) by the time the caller gets a result".
        await this.journal.append(record);
      }
    });
  }
}
