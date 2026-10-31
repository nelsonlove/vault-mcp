// The refusal log (#618): an optional setting that writes one journal line for
// each refused write call, so a later sweep can count how often each guard fires
// by reading the journal, never by running a guard.
//
// OFF by default on both servers: the host plugin's `refusalLog` setting, the
// file-system server's VAULT_MCP_REFUSAL_LOG variable. Off, nothing here runs
// and the journal is what it was before.
//
// Two kinds of mark, and only two:
//
// - A call refused BEFORE the queue (nothing ran, no idempotency key was
//   taken) gets a NEW line: `outcome: "refused"`, `refusal` (the error code)
//   and `codeFamily`, with the stamp, the tool, the actor (and its session),
//   the target path (each capped like the journal's digest) and no argument
//   value: no `argsDigest`, no `error` text, no `intent`. A loop of such calls
//   is capped per session and code (RefusalRateLimiter).
// - A call refused AT OR AFTER dequeue already has its record. That record is
//   never replaced or reshaped: it keeps everything it has today (its key,
//   argsHash, returned, revs, effects), and gains only `refusal` and
//   `codeFamily`, and only when its code is on DEQUEUE_REFUSALS, the codes
//   known to mean "refused, nothing written". A code off that list (a failure
//   after a write landed, such as a partial batch or a failed reload) gets no
//   mark at all, so the journal never says "refused" about a call that wrote.
//
// This module holds only what both servers share. Each server reads its own
// switch and writes through its own journal.

/**
 * The code a refused line carries when the SDK's input validation refused the
 * call (an unknown argument to a strict write tool, a wrong type), before any
 * vault-mcp code ran. The SDK's own message has no code.
 */
export const INPUT_VALIDATION_CODE = "input_validation";

/**
 * Codes that are failures, not refusals, for a call refused BEFORE the queue:
 * a line for one would count a guard that never fired. (Before the queue
 * nothing ran, so none of these should arrive there; the list and the pattern
 * below are a floor, not the test. At dequeue the test is DEQUEUE_REFUSALS.)
 */
const NOT_REFUSALS = new Set(["write_timeout", "partial", "error", "probe_failed"]);
const FAILURE_CODE = /(^|_)(failed|partial|partially_applied)($|_)/;

/**
 * The codes that mean "refused, nothing written" when they come back at or
 * after dequeue: the kernel's own checks, the guards a handler runs before it
 * writes, and the tools' own refusals of a call they did not run. Only these
 * mark a dequeue record. A code that is not here (a failure after a write, a
 * new code nobody has classed yet) marks nothing: an unmarked refusal is a
 * missed count; a marked write would be a false record.
 */
export const DEQUEUE_REFUSALS: ReadonlySet<string> = new Set([
  "rev_conflict",
  "record_immutable",
  "idempotency_mismatch",
  "protection_required",
  "accept_forbidden",
  "truncated_read",
  "h1_replace",
  "cache_mismatch",
  "no_match",
  "many_matches",
  "frontmatter_edit",
  "invalid_replace",
  "unsafe_name",
  "overwrite_refused",
  "invalid_file",
  "invalid_edit",
  "unsupported_file",
  "base_under_scope",
  "invalid_path",
  "write_scope",
  "read_only",
  "out_of_allowlist",
  "sync_behind",
  "sync_unknown",
  "session_not_live",
  "session_revoked",
  "plugin_unloaded",
]);

/** Whether a code met at or after dequeue marks its record as a refusal (DEQUEUE_REFUSALS). */
export function isDequeueRefusal(code: string | undefined): code is string {
  return code !== undefined && DEQUEUE_REFUSALS.has(code);
}

/** Code → family: the guard stage that refused. A code not listed is `tool`, a tool's own refusal. */
const FAMILIES: Record<string, string> = {
  [INPUT_VALIDATION_CODE]: "schema",
  read_only: "allowlist",
  out_of_allowlist: "allowlist",
  denied_territory: "allowlist",
  write_scope: "write_scope",
  profile_refused: "profile",
  protection_required: "protection",
  precondition_unsupported: "protection",
  uid_unresolved: "address",
  uid_ambiguous: "address",
  address_unresolved: "address",
  address_ambiguous: "address",
  scheme_unavailable: "address",
  invalid_path: "address",
  truncated_read: "read_limit",
  record_immutable: "record",
  rev_conflict: "rev",
  idempotency_mismatch: "idempotency",
  accept_forbidden: "accept",
  sync_behind: "sync",
  sync_unknown: "sync",
  h1_replace: "h1",
  cache_mismatch: "cache",
  session_not_live: "session",
  session_revoked: "session",
  session_mismatch: "session",
  headless_unsupported: "headless",
  fs_writes_disabled: "fs_writes",
  plugin_unloaded: "queue",
};

/** The short family of a refusal code. */
export function refusalFamily(code: string): string {
  return FAMILIES[code] ?? "tool";
}

const CODE = /^[a-z][a-z0-9_]*$/;
const CODED_TEXT = /^Error \[([a-z][a-z0-9_]*)\]:/;

function refusal(code: string | undefined): string | undefined {
  return code !== undefined && CODE.test(code) && !NOT_REFUSALS.has(code) && !FAILURE_CODE.test(code) ? code : undefined;
}

/**
 * The refusal code of a RETURNED result: an error envelope whose first text
 * opens `Error [code]:`. Undefined for a success, an uncoded error, or a code
 * that is a failure rather than a refusal.
 */
export function refusalCodeOf(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const r = result as { isError?: unknown; content?: unknown };
  if (r.isError !== true || !Array.isArray(r.content)) return undefined;
  const first = r.content[0] as { text?: unknown } | undefined;
  if (typeof first?.text !== "string") return undefined;
  return refusal(CODED_TEXT.exec(first.text)?.[1]);
}

/**
 * The refusal code of a THROWN value: its `code` property, or a message that
 * opens `Error [code]:`. Undefined for an uncoded throw.
 */
export function refusalCodeOfThrown(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return refusal(code);
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? refusal(CODED_TEXT.exec(message)?.[1]) : undefined;
}

/** The journal digest's string cap: a longer path on a refused line is recorded as `<N chars>`. */
export const REFUSAL_PATH_MAX = 120;

/**
 * A path as a NEW refused line records it. The args of a call refused before
 * the queue were never checked (the schema refusal above all), so a value under
 * a path key may be anything, a note body included; capped like the journal's
 * digest caps a long string, it cannot carry one.
 */
export function refusalPath(p: string): string {
  return p.length > REFUSAL_PATH_MAX ? `<${p.length} chars>` : p;
}

// ── the cap on refused lines ─────────────────────────────────────────────────

/** At most this many refused lines per session and code in one window; the rest are counted. */
export const REFUSAL_LOG_MAX_PER_WINDOW = 20;
/** The window, in milliseconds: one minute. */
export const REFUSAL_LOG_WINDOW_MS = 60_000;
/** The most (session, code) windows held at once; past it the oldest windows are flushed and dropped. */
const MAX_WINDOWS = 1000;

interface RefusalWindow {
  start: number;
  written: number;
  suppressed: number;
  scheduled: boolean;
  flush: (count: number) => void;
}

/**
 * The cap on NEW refused lines (#618 review 1): a loop of calls refused before
 * the queue would otherwise append at full speed. Per key (the session, or the
 * connection when there is none, and the code): the first
 * REFUSAL_LOG_MAX_PER_WINDOW in a REFUSAL_LOG_WINDOW_MS window are written; the
 * rest are counted, and when the window ends the count is written as one line
 * (`suppressed: <count>`) through the flush the first suppressed call gave.
 * In memory; a reload starts fresh. The clock and the timer are injectable.
 */
export class RefusalRateLimiter {
  private readonly windows = new Map<string, RefusalWindow>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(opts: { max?: number; windowMs?: number; now?: () => number; schedule?: (fn: () => void, ms: number) => void } = {}) {
    this.max = opts.max ?? REFUSAL_LOG_MAX_PER_WINDOW;
    this.windowMs = opts.windowMs ?? REFUSAL_LOG_WINDOW_MS;
    this.now = opts.now ?? (() => Date.now());
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms) as unknown as { unref?: () => void };
        t.unref?.();
      });
  }

  /**
   * Whether to write this refused line. False ⇒ it is counted, and `flush`
   * (the line a window's count is written as) runs once when the window ends.
   */
  admit(key: string, flush: (count: number) => void): boolean {
    const now = this.now();
    let w = this.windows.get(key);
    if (w && now - w.start >= this.windowMs) {
      this.close(key, w);
      w = undefined;
    }
    if (!w) {
      if (this.windows.size >= MAX_WINDOWS) {
        const [oldestKey, oldest] = this.windows.entries().next().value as [string, RefusalWindow];
        this.close(oldestKey, oldest);
      }
      this.windows.set(key, { start: now, written: 1, suppressed: 0, scheduled: false, flush });
      return true;
    }
    if (w.written < this.max) {
      w.written++;
      return true;
    }
    w.suppressed++;
    w.flush = flush;
    if (!w.scheduled) {
      w.scheduled = true;
      const win = w;
      this.schedule(() => {
        if (this.windows.get(key) === win) this.close(key, win);
      }, Math.max(0, w.start + this.windowMs - now));
    }
    return false;
  }

  private close(key: string, w: RefusalWindow): void {
    this.windows.delete(key);
    if (w.suppressed > 0) {
      const n = w.suppressed;
      w.suppressed = 0;
      try {
        w.flush(n);
      } catch {
        /* a journal failure never fails a call */
      }
    }
  }
}
