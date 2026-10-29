// The refusal log (#618): an optional setting that writes one journal line for
// each refused write call, so a later sweep can count how often each guard fires
// by reading the journal, never by running a guard.
//
// OFF by default on both servers: the host plugin's `refusalLog` setting, the
// file-system server's VAULT_MCP_REFUSAL_LOG variable. Off, nothing here runs
// and the journal is what it was before.
//
// A refused line is a journal record with `outcome: "refused"`, the error
// `code` and its short `codeFamily`. It carries the stamp, the operation (the
// tool), the actor (which includes the session), the target path or address as
// the journal records it, and no argument value: no `argsDigest`, no `error`
// text, no `intent`. So no note text, no frontmatter value and no token in an
// argument can reach the line.
//
// This module holds only what both servers share: what counts as a refusal and
// the families. Each server reads its own switch and writes the line through
// its own journal.

/**
 * The code a refused line carries when the SDK's input validation refused the
 * call (an unknown argument to a strict write tool, a wrong type), before any
 * vault-mcp code ran. The SDK's own message has no code.
 */
export const INPUT_VALIDATION_CODE = "input_validation";

/**
 * Codes that are failures, not refusals: the call may have written (a timeout,
 * a partial result) or broke for a reason no guard decided. A line for one of
 * these would count a guard that never fired. The same rule as the operation
 * executor's outcomes (`write_timeout` is uncertain, `partial` did work).
 */
const NOT_REFUSALS = new Set(["write_timeout", "partial", "error", "probe_failed"]);

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
  return code !== undefined && CODE.test(code) && !NOT_REFUSALS.has(code) ? code : undefined;
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
