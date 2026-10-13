// The single interception point every registerTool call passes through (see the
// monkeypatch in server.ts). Six things bind here, in order:
//
//   1. uid addressing — `uid:<value>` path arguments resolve to real paths
//      through the uid index (slice 2.1), for READS and WRITES alike
//   2. scheme addressing — `jd:<address>` (and other configured scheme ids)
//      path arguments resolve to real paths through the scope-provider
//      registry, AFTER uid resolution (uid: is reserved and takes
//      precedence) and, like uid addressing, for READS and WRITES alike
//   3. guardCall  — read-only mode + path allowlist (pre-existing)
//   4. kernel arguments — `if_rev` / `idempotency_key` are peeled off the args
//      (kernel v0) so no tool handler ever sees them
//   5. write queue — mutating calls serialize plugin-wide (kernel v0)
//   6. write journal — one audit record per mutating call (kernel v0)
//
// Reads take paths 1–3 only and return immediately. Lives in its own module (not
// inline in server.ts) so it imports nothing from `obsidian` and can be
// unit-tested headlessly — server.ts cannot, since its tool registrars pull in
// live Obsidian classes.

import { protectionRefusal, requirementNote } from "../kernel/write-protection.js";
import type { SyncDecision } from "../kernel/sync-guard.js";
import { z } from "zod";
import { guardCall, collectPaths, type GuardSettings } from "../guard.js";
import {
  IdempotencyMismatchError,
  RecordImmutableError,
  RevConflictError,
  UidAmbiguousError,
  UidUnresolvedError,
  WriteTimeoutError,
  resolveUidArgs,
  UID_PREFIX,
  type Kernel,
  type JournalActor,
  type JournalEffects,
  type UidIndex,
} from "../kernel/index.js";
import {
  AddressAmbiguousError,
  AddressUnresolvedError,
  SchemeUnavailableError,
  resolveSchemeArgs,
  type SchemeRegistry,
} from "../kernel/scheme/registry.js";
import { OperationRefusedError, type OperationExecutor } from "../kernel/operations/executor.js";
import { extendInput, inputShapeOf, CHARACTER_LIMIT, cutReadError, wholeNoteOverwriteRefusal, wholeReadToken, normalizeWriteScope, writeScopeRefusal, type WholeReads } from "@vault-mcp/core";

/** Guard/queue-level failure envelope: matches the `Error [code]: message` shape guardCall already emits. */
function codedError(code: string, message: string) {
  return { content: [{ type: "text" as const, text: `Error [${code}]: ${message}` }], isError: true as const };
}

// Argument keys that identify a NON-path target, MOST IDENTIFYING FIRST — a
// tool taking both `id` and `name` should journal the id. Pathless mutators
// (run a command, toggle a plugin, open a workspace) would otherwise journal
// `target: {}`. The mapping lives here, at the interception point, and is keyed
// on argument names rather than tool names — the kernel stays generic and an
// external tool taking `commandId` gets the same treatment for free.
const REF_KEYS = [
  "command_id",
  "commandId",
  "plugin_id",
  "pluginId",
  "command",
  // Advisory claims: `obsidian_claim_scope` journals `scope:<prefix>` and
  // `obsidian_release_scope` journals `lock:<id>` — the release call names only
  // the lock, so the scope it covers is not among its arguments.
  "lock_id",
  "lockId",
  "scope",
  "id",
  "workspace",
  "name",
  "kind",
];
const MAX_REF = 120;

/**
 * `plugin:dataview`, `command:editor:toggle-bold`, … — the label is the key
 * with any `_id`/`Id` suffix dropped, so no per-tool knowledge is encoded.
 */
function refOf(args: Record<string, unknown>): string | undefined {
  for (const key of REF_KEYS) {
    const value = args?.[key];
    if (typeof value !== "string" || !value) continue;
    const label = key.replace(/_?[Ii]d$/, "") || key;
    return `${label}:${value}`.slice(0, MAX_REF);
  }
  return undefined;
}

// ── reported effects ─────────────────────────────────────────────────────────
//
// The journal's `target` is derived from the paths an operation NAMES, which is
// right for nearly everything. `obsidian_repoint_link` is the exception: it
// names one target path and then discovers, rewrites and reports a set of notes
// of its own, so an argument-derived record describes a one-file operation that
// may have changed forty. The audit stream has to carry what actually happened.
//
// The convention is RESULT-shaped and lives here for the same reason REF_KEYS
// does: the kernel stays generic and only records what it is handed, while the
// knowledge of what this tool surface's envelopes look like stays at the
// boundary. A handler opts in simply by reporting `filesChanged` (and
// optionally `files`) in its structured result — nothing is inferred.
//
// A DRY RUN reports nothing: `filesChanged` then means "would change", and a
// record asserting effects for an operation that wrote nothing is worse than a
// record with no effects field at all.
const EFFECT_COUNT_KEY = "filesChanged";
const EFFECT_PATHS_KEY = "files";
// Same cap the journal applies to `target.paths` — the record keeps the shape,
// not the payload; `filesChanged` stays exact.
const MAX_EFFECT_PATHS = 20;

function reportedEffects(args: Record<string, unknown>, result: unknown): JournalEffects | undefined {
  if (args?.dry_run === true) return undefined;
  const structured = (result as { structuredContent?: unknown } | null | undefined)?.structuredContent;
  if (structured === null || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const body = structured as Record<string, unknown>;
  const count = body[EFFECT_COUNT_KEY];
  if (typeof count !== "number" || !Number.isFinite(count)) return undefined;
  const raw = body[EFFECT_PATHS_KEY];
  const paths = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string").slice(0, MAX_EFFECT_PATHS) : [];
  return { filesChanged: count, ...(paths.length > 0 ? { paths } : {}) };
}

// ── kernel arguments ─────────────────────────────────────────────────────────
//
// `if_rev`, `idempotency_key` and `intent` are KERNEL arguments, not tool arguments: no
// handler knows about them, and adding them by hand to ~25 mutating schemas
// would guarantee that the next mutating tool forgets one. They are declared
// generically (withKernelArgs, applied to every mutating registration) and
// consumed generically (stripped from args here, passed to Kernel.runMutation).
//
// The declaration is not optional decoration: the MCP SDK validates a call's
// arguments against the tool's zod schema. A raw shape becomes z.object, which
// STRIPS unknown keys, so an undeclared `if_rev` would be silently discarded
// before the handler — and this wrapper — ever saw it; a strict schema
// (`strictInput`, #500) would REFUSE it instead. Code Mode's obsidian_call_tool
// parses against the same captured schema, so declaring once covers both
// surfaces.

const IF_REV = z
  .number()
  .optional()
  .describe(
    "Optimistic concurrency: only apply if the target is still at this `rev` (from a read). " +
      "A mismatch fails with Error [rev_conflict] and writes nothing. For multi-target ops, applies to the first target."
  );

const IDEMPOTENCY_KEY = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Retry safety for calls that RETURNED: a repeat call with the same key returns the first call's result " +
      "instead of running again, and a repeat sent while the first is still in flight waits for it and shares its " +
      "outcome. It does NOT cover a call that failed with Error [write_timeout] — that operation was abandoned " +
      "server-side and may still have landed, so its key is not held and a retry re-executes; re-read before " +
      "retrying. Same key + different arguments — or a different (or dropped) if_rev — is " +
      "Error [idempotency_mismatch], never a replay. " +
      "10-minute window. A plugin reload keeps every key; after a full Obsidian restart a key that ran answers 'already done' (from the journal) without its first result. Use a fresh key per logical operation."
  );

const INTENT = z
  .string()
  .min(1)
  .max(2000)
  .optional()
  .describe(
    "Why this change is being made — advisory, agent-authored free text recorded in the write journal beside the " +
      "operation (the PR-description of a proposed change; review surfaces display it as \"agent says\"). " +
      "Journal-only: it is never written to the note, never trusted, and never an acceptance signal of any kind. " +
      "Unlike idempotency identity, a retried call may reword it freely."
  );

/** The kernel argument names, stripped from every mutating call's args.
 * RESERVED: the peel below strips these from every mutating call at runtime
 * regardless of the tool's own schema — withKernelArgs preserving a tool's own
 * declaration keeps the SCHEMA honest, but the value still never reaches the
 * handler. A mutating tool (built-in or external) must not name an argument
 * after one of these. */
export const KERNEL_ARG_KEYS = ["if_rev", "idempotency_key", "intent"] as const;

/**
 * Declare the kernel arguments on a MUTATING tool's input schema. Read-only
 * tools are returned untouched — neither argument means anything without a
 * write. A tool that already declares one of the names keeps its own
 * declaration (nothing here may quietly redefine a tool's contract).
 * Given the tool's NAME, each argument's description opens with the
 * requirement its inventory row states (01.33 rule 6f), so the schema says
 * what the guard will enforce. The schema keeps its form: a raw shape stays a
 * shape, a strict object (`strictInput`, #500) stays a strict object, so a
 * reader of `inputSchema` goes through core's `inputShapeOf` / `inputObjectOf`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withKernelArgs(def: any, name?: string): any {
  if (def?.annotations?.readOnlyHint !== false) return def;
  // Either form (#500): a strict object schema stays strict once extended.
  const shape = inputShapeOf(def.inputSchema);
  const extra: Record<string, z.ZodTypeAny> = {};
  const noted = (schema: z.ZodTypeAny, which: "if_rev" | "idempotency_key") => {
    const note = name ? requirementNote(name, which) : null;
    return note ? schema.describe(`${note} ${schema.description ?? ""}`) : schema;
  };
  if (!("if_rev" in shape)) extra.if_rev = noted(IF_REV, "if_rev");
  if (!("idempotency_key" in shape)) extra.idempotency_key = noted(IDEMPOTENCY_KEY, "idempotency_key");
  if (!("intent" in shape)) extra.intent = INTENT;
  return { ...def, inputSchema: extendInput(def.inputSchema, extra) };
}

/** Split a call's arguments into the kernel's and the tool's. */
function splitKernelArgs(args: Record<string, unknown>): {
  toolArgs: Record<string, unknown>;
  ifRev?: number;
  idempotencyKey?: string;
  intent?: string;
} {
  const { if_rev: ifRev, idempotency_key: idempotencyKey, intent, ...toolArgs } = args;
  return {
    toolArgs,
    ...(typeof ifRev === "number" ? { ifRev } : {}),
    ...(typeof idempotencyKey === "string" && idempotencyKey ? { idempotencyKey } : {}),
    ...(typeof intent === "string" && intent ? { intent } : {}),
  };
}

export interface GuardedOpts {
  getSettings: () => GuardSettings;
  /**
   * Plugin-singleton kernel. Absent (tests, bare embeds) ⇒ no queue, no journal
   * — the guard still applies, and a mutating call carrying `if_rev` is refused
   * rather than written unconditionally (the precondition is unenforceable).
   */
  kernel?: Kernel | null;
  /** Actor for the journal, resolved per call: client identity is only known after initialize. */
  actor: () => JournalActor;
  /**
   * The uid index backing `uid:<value>` addressing. Defaults to the kernel's,
   * which is where it lives in the plugin; overridable so this wrapper can be
   * tested against an index without a kernel.
   */
  uids?: UidIndex | null;
  /**
   * For the whole-note-overwrite rule (#441): no read over MCP returns a
   * note longer than CHARACTER_LIMIT whole, so overwriting one whole is
   * refused before the queue. Returns the note's length in characters when
   * it exceeds CHARACTER_LIMIT, any number not above CHARACTER_LIMIT when it
   * cannot exceed it (server.ts returns the byte size then, which is never
   * fewer than the characters), and undefined when the note does not exist.
   * Only the comparison with the limit is meaningful. Absent ⇒ the rule is
   * skipped (tests, bare embeds).
   */
  noteLength?: (path: string) => Promise<number | undefined>;
  /**
   * This connection's memory of whole reads and the note's current rev
   * (#443): the whole-note-overwrite rule stands aside for a call whose
   * if_rev is a remembered whole read's rev for that path AND the note's
   * current rev. Absent ⇒ no whole read is ever proven.
   */
  wholeReads?: Pick<WholeReads, "has">;
  /** The note's mtime (its rev) and size from ONE lookup, composed into the
   *  token a whole read is remembered under (see server.ts). */
  noteStat?: (path: string) => { mtime: number; size: number } | undefined;
  /** Whether anything (a note or a folder) is at a vault path: the write scope's "is this a create?" (write-scope.ts). Falls back to noteStat. */
  noteExists?: (path: string) => boolean;
  /**
   * The scope-provider registry backing `jd:<address>` (and other configured
   * scheme ids) addressing. Resolved PER CALL, like `getSettings`, so a
   * scheme config edit lands live — mirrors `registerSchemeTools`'s own
   * `registry()`. Absent ⇒ scheme addressing is skipped entirely and args
   * pass through byte-identical (tests, bare embeds).
   */
  schemes?: () => SchemeRegistry | null;
  /**
   * The session refusal, consulted AT DEQUEUE (WP5). A mutation that waited in
   * the queue past its session's expiry — or whose session was revoked while
   * it waited — refuses instead of executing under an authority context that
   * no longer exists. Absent ⇒ no session machinery (tests, bare embeds); the
   * check is skipped, exactly like the kernel itself.
   *
   * REFUSAL-SHAPED, not boolean (suite split, S2, condition 2). It returns
   * `{code, detail}` or `null`, and `null` means "nothing to say" rather than
   * "allowed": the previous `{live: boolean}` shape could express an ALLOW, and
   * once the governance provider answers this question across a plugin
   * boundary, an allow is a permission a registrant could assert. A type that
   * cannot say yes cannot be talked into saying yes. server.ts composes the
   * host's own expiry floor with the seam's provider refusals behind this one
   * function; the guard only renders whatever refusal comes back.
   */
  sessionRefusal?: () => Promise<{ code: string; detail: string } | null> | { code: string; detail: string } | null;
  /**
   * The shared operation executor (WP1). Every guarded call runs inside one
   * operation, so action identity, actor binding and phase history are the
   * same whichever surface a call came in through.
   *
   * OPTIONAL, and its absence is a supported configuration rather than an
   * oversight: unit tests and bare embeds construct `makeGuarded` without one,
   * exactly as they already do without a kernel. Without an executor the
   * behaviour is byte-identical to before this seam existed — which is what
   * makes the seam safe to introduce into a working product.
   */
  executor?: OperationExecutor | null;
  /**
   * Vault markdown paths scheme addressing resolves an address against.
   * Called LAZILY by resolveSchemeArgs — only once per call, on the first
   * scheme-shaped value encountered, then reused for the rest of that call —
   * so an ordinary call never pays for enumerating the vault. Same source
   * `registerSchemeTools` uses. `opts.schemes` present without this ⇒ defaults
   * to `() => []`, so a scheme-shaped value FAILS CLOSED as `address_unresolved`
   * (0 candidates) rather than throwing — server.ts always wires both together,
   * so this is a defensive default for a misconfigured embed, not a supported
   * combination with its own test.
   */
  schemeNotes?: () => string[];
  /**
   * The Sync guard (kernel/sync-guard.ts; 01.43, Nelson's pick A of
   * 2026-10-12), consulted after the protection check and BEFORE the write
   * queue: a wait for Obsidian Sync never holds the queue, and a refusal never
   * reaches it (so it is not journaled). A warning goes on the journal record
   * (`syncWarning`) and on the result. Absent ⇒ no check (tests, bare embeds,
   * a host without Sync).
   */
  syncGuard?: (tool: string, args: Record<string, unknown>) => Promise<SyncDecision>;
}

// ── uid addressing ───────────────────────────────────────────────────────────
//
// `path: "uid:019f…"` resolves through the index to the real path before
// ANYTHING else sees the call. Deliberately here and not in ~30 tool handlers:
// like the kernel arguments, per-tool support would mean the next path-taking
// tool silently lacks it. Because it is defined over the guard's own path walker
// (mapPaths), every argument the allowlist scopes is addressable and vice versa.
//
// It runs BEFORE guardCall so the allowlist checks the RESOLVED path — a uid
// must not be a way around a path sandbox. The REAL disclosure control is at
// the source, not at the refusal: resolution itself runs over the
// allowlist-VISIBLE candidates only (UidIndex.requireOne), so a resolved path
// is always already inside the allowlist and can never be the path guardCall
// itself blocks on — `uid_ambiguous` can only ever name paths this session
// could have named itself, and a uid carried solely outside the sandbox reads
// as `uid_unresolved` rather than confirming it exists. That is also what
// obsidian_resolve_uid reports, so looking a uid up and addressing by it agree.
//
// Resolved paths are ALSO folded back to their `uid:` form in the guard's
// refusal text (addressSafe, below, extended for scheme addressing) —
// belt-and-suspenders against a future guardCall message naming more than the
// one path it blocks on, not a hole open today.

// ── scheme addressing ────────────────────────────────────────────────────────
//
// `path: "jd:06.11"` (or any other configured scheme id) resolves through the
// scope-provider registry to the real path, mirroring uid addressing exactly
// and running immediately AFTER it — `uid:` is reserved (SchemeRegistry.parseRef
// returns null for it), so uid resolution always gets first look, and by the
// time scheme resolution runs no unresolved `uid:` value remains in the args:
// it either became a real path or the call already refused above.
//
// Also runs BEFORE guardCall, for the identical reason: the allowlist must
// check the RESOLVED path, not the address, or `jd:06.11` would be a sandbox
// bypass. Resolution itself runs over the allowlist-VISIBLE notes only
// (resolveSchemeArgs -> requireOneAddress over visiblePaths), so — exactly
// like a resolved uid path above — a resolved scheme path is always already
// inside the allowlist and can never be the path guardCall itself blocks on;
// that visibility gate is the real disclosure control, not the fold-back.
// What it actually buys: `address_ambiguous` can only ever name notes this
// session could have named itself, and an address whose only claimant is
// hidden reads as `address_unresolved` — never `out_of_allowlist`, which would
// confirm the address exists. That is also what obsidian_resolve_address
// reports, so looking an address up and addressing by it agree.
//
// Resolved scheme paths are ALSO folded back to their `jd:<address>` ref form
// in the guard's refusal text (addressSafe, below) — the same
// belt-and-suspenders as the uid case, combined into one pass rather than a
// second copy of the loop.
//
// A value that isn't scheme-shaped at all — an ordinary path, or one that
// merely contains a colon ("Notes/a:b.md") — is left untouched: parseRef
// returns null and resolveSchemeArgs never calls requireOneAddress on it.

/**
 * Put `uid:<value>` and `<scheme>:<address>` back where a resolved path
 * appears, so a refusal discloses neither. One pass over the combined
 * resolution lists — an allowlist refusal must hide everything either
 * addressing scheme resolved, not just whichever ran first.
 *
 * Exported so it can be tested DIRECTLY, independent of whether any given
 * guardCall message shape currently happens to route a resolved path through
 * it — see the "addressSafe" unit tests in scheme-addressing.test.mjs.
 */
export function addressSafe(
  message: string,
  uidResolved: Array<{ uid: string; path: string }>,
  schemeResolved: Array<{ ref: string; path: string }> = []
): string {
  let out = message;
  for (const { uid, path } of uidResolved) out = out.split(path).join(`uid:${uid}`);
  for (const { ref, path } of schemeResolved) out = out.split(path).join(ref);
  return out;
}

/**
 * Steps 1, 1b and 3 of the interception above — uid resolution, scheme
 * resolution, then guardCall (read-only + allowlist) — pulled out of the
 * per-call wrapper below so a caller that must run its OWN pre-dispatch logic
 * against the RESOLVED, GUARD-CHECKED args can share the IDENTICAL resolution
 * and refusal `makeGuarded` itself applies, rather than a second
 * implementation that could drift from it.
 *
 * `obsidian_write_notes` is the reason this exists (see resolveGuardedPath
 * below and tools-write-notes.ts): its per-item stamping reads a note's
 * EXISTING frontmatter before dispatching through a guarded single-writer, so
 * that read has to be keyed on the same resolved path the guarded dispatch
 * will use, and the allowlist refusal has to run before anything about the
 * note's content — including its acceptance fields — is inspected at all.
 *
 * Returns the resolved args on success, or the SAME typed refusal shape
 * `makeGuarded` returns to the transport (`{code, message}`) — never throws
 * for a refusal, only for a genuinely unexpected error, exactly like the
 * inline steps this replaces.
 */
function resolveAndGuard(
  args: Record<string, unknown>,
  isMutating: boolean,
  opts: GuardedOpts
):
  | { blocked: { code: string; message: string } }
  | { args: Record<string, unknown>; uidResolved: Array<{ uid: string; path: string }>; schemeResolved: Array<{ ref: string; path: string }> } {
  const settings = opts.getSettings();
  // 1. uid addressing. A call using none is handed back the SAME args object,
  //    so nothing below can behave differently for an ordinary path call.
  //    Resolution is bounded by the session's own allowlist (see requireOne):
  //    a uid carried by a note this session cannot see is not a candidate, so
  //    neither refusal below can name a path the caller was never entitled to.
  let addressed;
  try {
    addressed = resolveUidArgs(args ?? {}, opts.uids ?? opts.kernel?.uids ?? null, settings);
  } catch (e) {
    // Unknown or duplicated uid: refuse, and run nothing. Both are typed, and
    // the ambiguous one names the candidates so the caller can disambiguate.
    if (e instanceof UidUnresolvedError || e instanceof UidAmbiguousError) return { blocked: { code: e.code, message: e.message } };
    throw e;
  }
  // 1b. scheme addressing (`jd:<address>`), over the possibly uid-rewritten
  //     args. opts.schemes absent ⇒ skipped entirely, so callArgs stays the
  //     SAME object resolveUidArgs handed back and behavior is unchanged.
  let callArgs = addressed.args;
  let schemeResolved: Array<{ ref: string; path: string }> = [];
  if (opts.schemes) {
    try {
      const schemed = resolveSchemeArgs(callArgs, opts.schemes(), opts.schemeNotes ?? (() => []), settings);
      callArgs = schemed.args;
      schemeResolved = schemed.resolved;
    } catch (e) {
      // Unresolvable or ambiguous address, or a ref naming a SKIPPED
      // instance (#88 — configured but no live instance, e.g. an unknown
      // provider or invalid config): refuse, and run nothing — same
      // contract as the uid case above.
      if (e instanceof AddressUnresolvedError || e instanceof AddressAmbiguousError || e instanceof SchemeUnavailableError) {
        return { blocked: { code: e.code, message: e.message } };
      }
      throw e;
    }
  }
  const blocked = guardCall({ isMutating, args: callArgs, settings });
  if (blocked) return { blocked: { code: blocked.code, message: addressSafe(blocked.message, addressed.resolved, schemeResolved) } };
  return { args: callArgs, uidResolved: addressed.resolved, schemeResolved };
}

/**
 * Resolve `uid:<value>` / `<scheme>:<address>` addressing for a single PATH
 * argument and check read-only + allowlist for it — the single-path form of
 * `resolveAndGuard`, for a caller that has only a path (not a full args
 * object) and needs the post-resolution, post-allowlist path BEFORE it does
 * anything else with the note. `obsidian_write_notes` uses this to key its
 * stamped-write existing-frontmatter read on the RESOLVED path and to run the
 * allowlist refusal before its accept-transition check ever inspects the
 * note (see tools-write-notes.ts).
 */
export function resolveGuardedPath(path: string, opts: GuardedOpts): { path: string } | { blocked: { code: string; message: string } } {
  const resolved = resolveAndGuard({ path }, true, opts);
  if ("blocked" in resolved) return resolved;
  return { path: (resolved.args as { path: string }).path };
}

/**
 * Build the wrapper applied to every registered tool handler.
 *
 * `def.annotations.readOnlyHint === false` is the sole mutating test — the same
 * discriminant the guard has always used, so queue and journal cover exactly
 * the set read-only mode covers, including externally-published tools.
 */
export function makeGuarded(opts: GuardedOpts) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (def: any, handler: any, name?: string) => async (args: any, extra: any) => {
    const toolName = name ?? def?.title ?? "unknown";
    if (!opts.executor) return runGuarded(opts, def, handler, name, args, extra, () => {});
    try {
      const { result } = await opts.executor.run(
        {
          // No action id. The executor resolves it from this surface's
          // binding — a door knows which door it is, not which contract
          // currently sits behind it. Constructing `compat.<tool>` here meant
          // migrating one surface to a native contract silently broke every
          // call through it.
          surface: { kind: "mcp", id: toolName },
          inputs: args ?? {},
        },
        (mark, ctx) =>
          runGuarded(opts, def, handler, name, args, extra, mark, ctx.setSources)
      );
      return result;
    } catch (e) {
      // An executor refusal is a typed refusal like any other guard decision,
      // and reaches the client in the same `Error [code]: message` envelope the
      // allowlist and the kernel already use — rather than as an exception the
      // transport would render as an unexplained failure.
      if (e instanceof OperationRefusedError) return codedError(e.code, e.message);
      throw e;
    }
  };
}

/**
 * The pre-existing guarded call path, unchanged.
 *
 * Extracted verbatim so the executor can wrap it without altering it. `mark`
 * is the only addition: it records the phases the executor cannot witness from
 * outside — reaching the queue, and the handler actually running — and is a
 * no-op when no executor is present.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runGuarded(opts: GuardedOpts, def: any, handler: any, name: string | undefined, args: any, extra: any, mark: (phase: "queued" | "attempted") => void, setSources: (paths: string[]) => void = () => {}) {
  // READS never enter the queue, so they are not session-liveness-checked:
  // the WP5 deliverable names dequeue and admission time, and both are
  // mutation phases. The visible consequence — an expired session can read
  // until its connection drops, and its journal/capture attribution keeps
  // naming the expired id — is accepted and stated rather than hidden.
  const isMutating = def?.annotations?.readOnlyHint === false;
  // Steps 1/1b/3 (uid resolution, scheme resolution, read-only+allowlist)
  // live in resolveAndGuard so obsidian_write_notes can share the IDENTICAL
  // resolution and refusal via resolveGuardedPath — one implementation, not two.
  const resolved = resolveAndGuard(args ?? {}, isMutating, opts);
  if ("blocked" in resolved) return codedError(resolved.blocked.code, resolved.blocked.message);
  const callArgs = resolved.args;
  // Provenance is recorded from the RESOLVED arguments, never the raw ones. A
  // caller may address a note as `uid:019f…` or `jd:06.11`; attributing a
  // captured payload to that literal string would record a source that is not
  // a path, and playback authorization — which asks whether the reader can see
  // the source PATH — would then refuse the payload forever.
  setSources(collectPaths(callArgs as Record<string, unknown>));
  // Kernel arguments are always PEELED OFF, kernel or not, so no handler ever
  // sees one. What differs without a kernel is whether they can be honored:
  //
  //   • `if_rev` is FAIL-CLOSED. Without a kernel there is no probe and no
  //     dequeue check, so the precondition cannot be evaluated at all — and
  //     its whole purpose is to stop a write that would clobber someone
  //     else's. Ignoring it would write unconditionally while the caller
  //     believes it was guarded, which is the exact lost update the argument
  //     exists to prevent. Refuse instead.
  //   • `idempotency_key` degrades quietly to no collapsing, because its
  //     failure mode is at-least-once (the pre-kernel status quo), not a
  //     destructive one: the operation still does what the caller asked, a
  //     retry just isn't deduplicated.
  const { toolArgs, ifRev, idempotencyKey, intent } = splitKernelArgs(callArgs);
  // The write scope (core's write-scope.ts): what this session may WRITE, separate from what it may
  // read. In create-only mode a mutating call must create a new note at a path the scope names;
  // anything else that writes is refused here, before the queue, on the RESOLVED arguments.
  if (isMutating) {
    const scope = normalizeWriteScope(opts.getSettings().writeScope);
    if (scope.mode !== "all") {
      const exists = opts.noteExists ?? ((p: string) => opts.noteStat?.(p) !== undefined);
      const out = writeScopeRefusal(name ?? def?.title ?? "unknown", toolArgs as Record<string, unknown>, collectPaths(toolArgs as Record<string, unknown>), scope, exists);
      if (out) return codedError(out.code, out.message);
    }
  }
  if (isMutating && !opts.kernel && ifRev !== undefined) {
    return codedError(
      "precondition_unsupported",
      `'${name ?? def?.title ?? "this tool"}' cannot enforce if_rev: no kernel is active in this build, so the ` +
        `target's revision cannot be checked. Nothing was written — retry without if_rev to write unconditionally.`
    );
  }
  // A cut read handed back as `content` is refused here, before the queue,
  // whatever the tool (#441): the one check that covers every tool that
  // takes text, including a satellite's (the backends carry the same check
  // as the last line for direct callers). A whole-note overwrite of a note
  // longer than the read limit is refused at dequeue, below: such a note is
  // never overwritten whole over MCP (core's truncation.ts says why).
  if (isMutating) {
    const cut = cutReadError(toolArgs as Record<string, unknown>);
    if (cut) return codedError(cut.code, cut.message);
  }
  // The whole-note-overwrite rule reads the note's length, so it runs after
  // the cheaper refusals: with a kernel, at DEQUEUE inside the queued closure
  // (after the idempotency claim, so a keyed retry replays; after the if_rev
  // check and every write queued ahead, so the proof is read against the
  // state the write meets, as the FS server does); without one, right here.
  // Decided at most once per call and path (memoised): the note's stat from
  // one lookup, and the memory's answer for its token.
  const provenMemo = new Map<string, Promise<boolean>>();
  const provenWhole = (path: string): Promise<boolean> => {
    let p = provenMemo.get(path);
    if (!p) {
      p = (async () => {
        if (ifRev === undefined || !opts.wholeReads || !opts.noteStat) return false;
        const st = opts.noteStat(path);
        return !!st && st.mtime === ifRev && opts.wholeReads.has(path, wholeReadToken(st.mtime, st.size));
      })();
      provenMemo.set(path, p);
    }
    return p;
  };
  const longNoteRefusal = async () =>
    isMutating && opts.noteLength
      ? wholeNoteOverwriteRefusal(toolArgs as Record<string, unknown>, opts.noteLength, CHARACTER_LIMIT, provenWhole)
      : null;
  if (!isMutating || !opts.kernel) {
    const long = await longNoteRefusal();
    if (long) return codedError(long.code, long.message);
    return handler(toolArgs, extra);
  }
  // Required write protection (01.43 rules 3–4c, 01.33 rule 6f): a call that
  // omits the if_rev or idempotency_key its operation requires is refused
  // here, before the queue — it never runs unprotected. Only with a kernel:
  // without one neither argument can be honored, and the if_rev refusal above
  // already covers that case. The requirement is the inventory row's
  // `protection` (kernel/write-protection.ts), read over the RESOLVED args.
  const missing = protectionRefusal(name ?? def?.title ?? "unknown", toolArgs as Record<string, unknown>, { ifRev, idempotencyKey });
  if (missing) return codedError(missing.code, missing.message);
  // The Sync guard: wait for this Mac's Obsidian Sync, then refuse a
  // structure write that is still behind, or warn. Here, before the queue.
  // A call whose idempotency key the kernel already holds is a retry it will
  // replay (or join, or refuse as a mismatch) with no new write, so it is not
  // made to wait for Sync or refused for it: the guard steps aside for it.
  const keyKnown = idempotencyKey !== undefined && opts.kernel.idempotency.has(idempotencyKey);
  const sync = opts.syncGuard && !keyKnown ? await opts.syncGuard(name ?? def?.title ?? "unknown", toolArgs as Record<string, unknown>) : null;
  if (sync && "refuse" in sync) return codedError(sync.refuse.code, sync.refuse.message);
  const syncWarning = sync && "warn" in sync ? { text: sync.warn, code: sync.code } : undefined;
  // The operation reaches the write queue here. Marked rather than assumed:
  // every refusal above this line — read-only mode, the allowlist, an
  // unresolved uid or address, an unenforceable if_rev — returns without ever
  // queueing, and an envelope claiming otherwise would describe work nobody
  // did.
  mark("queued");
  // Audit-of-intent (#91): the address forms the caller actually used,
  // paired with what they resolved to at THIS interception — `target`
  // records what was touched; this records what was asked for, so a stale
  // or wrong index is visible in the record rather than silently absorbed.
  const addressedAs = [
    ...resolved.uidResolved.map(({ uid, path }) => ({ ref: `${UID_PREFIX}${uid}`, path })),
    ...resolved.schemeResolved,
  ];
  try {
    return withSyncWarning(await opts.kernel.runMutation(
      {
        op: name ?? def?.title ?? "unknown",
        args: toolArgs,
        actor: opts.actor(),
        ref: refOf(toolArgs),
        effectsOf: (result) => reportedEffects(toolArgs, result),
        ...(ifRev !== undefined ? { ifRev } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(intent !== undefined ? { intent } : {}),
        ...(addressedAs.length > 0 ? { addressedAs } : {}),
        ...(syncWarning !== undefined ? { syncWarning: syncWarning.text } : {}),
      },
      async () => {
        // Inside the queued closure: this runs at DEQUEUE, after the kernel's
        // own revision, record and lock checks have passed. Anything that
        // refuses before this point never attempted an effect.
        //
        // Session liveness is re-checked HERE, not only at enqueue: a
        // mutation can wait in the queue across its session's expiry or
        // revocation, and executing it then would act under an authority
        // context that no longer exists (WP5).
        const refusal = await opts.sessionRefusal?.();
        if (refusal) return codedError(refusal.code, refusal.detail);
        // The whole-note-overwrite rule (#441, #443), decided here at
        // dequeue: journaled as an error when it refuses, like the kernel's
        // own if_rev conflict.
        const long = await longNoteRefusal();
        if (long) return codedError(long.code, long.message);
        mark("attempted");
        // The one proof of a whole read, decided here and handed to the one
        // handler that reads it (obsidian_patch_note passes it to the
        // backend's replace rule): the backend never infers it from ambient
        // state, and no other call pays for it.
        const path = (toolArgs as Record<string, unknown>).path;
        if (name === "obsidian_patch_note" && typeof path === "string") {
          return handler(toolArgs, { ...(extra ?? {}), provenWhole: await provenWhole(path) });
        }
        return handler(toolArgs, extra);
      }
    ), syncWarning);
  } catch (e) {
    // Kernel-level failures are typed tool errors; anything else the handler
    // threw keeps propagating to the SDK exactly as before.
    if (e instanceof WriteTimeoutError) return codedError(e.code, e.message);
    if (e instanceof RevConflictError) return codedError(e.code, e.message);
    if (e instanceof RecordImmutableError) return codedError(e.code, e.message);
    if (e instanceof IdempotencyMismatchError) return codedError(e.code, e.message);
    throw e;
  }
}

/**
 * Put the Sync guard's warning on a result envelope: a `sync_warning` field in
 * `structuredContent` (when the result has one) and one more text item,
 * `Warning [sync_behind]` or `Warning [sync_unknown]`, so a caller that reads
 * either sees it. A result that is not an envelope, an error result, or no
 * warning passes through unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withSyncWarning(result: any, warning: { text: string; code: string } | undefined): any {
  // An error result wrote nothing, so a warning that "the write went on" would be false there.
  if (warning === undefined || !result || typeof result !== "object" || !Array.isArray(result.content) || result.isError) return result;
  return {
    ...result,
    content: [...result.content, { type: "text", text: `Warning [${warning.code}]: ${warning.text}` }],
    ...(result.structuredContent && typeof result.structuredContent === "object"
      ? { structuredContent: { ...result.structuredContent, sync_warning: warning.text } }
      : {}),
  };
}
