// Kernel v0 — the capabilities that ship in the transport: a serialized write
// queue (the transaction pipeline's embryo), a write journal (the audit
// stream), `if_rev` optimistic concurrency (precondition checking), idempotency
// keys (safe retries), and advisory locks (the claims mechanism). One instance
// per plugin, shared by every connection's server.
//
// Kernel.runMutation is the single place they all meet: it reserves or replays
// an idempotency key without executing anything, derives the operation's
// target, checks the caller's revision precondition at dequeue, runs the
// handler through the queue, and journals exactly one record per mutating
// operation whatever the outcome.
//
// ── idempotency: reserve at entry, share one outcome ─────────────────────────
//
// A key is claimed SYNCHRONOUSLY on the way in (IdempotencyStore.claim), before
// any await, so simultaneous retries of one dropped request cannot all become
// owners. Exactly one caller runs the operation; the rest await that owner's
// settlement and return the SAME envelope it produced (journaled `deduped`,
// with `dedupeOf` naming the owner's record).
//
// Waiters share the owner's outcome WHATEVER IT IS — one logical request, one
// outcome. If the owner throws (rev_conflict, write_timeout, probe failure),
// every waiter already attached rethrows that same error rather than racing to
// re-run the operation behind it. The free-key-on-thrown-failure rule applies
// only AFTER settlement: a thrown failure stores nothing and releases the key,
// so the NEXT call re-executes, while a returned envelope (ok or isError) is
// stored and replayed.

import { collectPaths } from "../guard.js";
import { WriteQueue, WriteTimeoutError } from "./write-queue.js";
import {
  digestArgs,
  WriteJournal,
  type JournalActor,
  type JournalEffects,
  type JournalOutcome,
  type JournalRecord,
  type JournalTarget,
} from "./journal.js";
import { argsHashOf, fingerprintArgs, IdempotencyMismatchError, IdempotencyStore, type IdempotencySettlement } from "./idempotency.js";
import { holderOf, lockNoticeText, LockStore, expiresInSeconds, type Lock, type LockNotice } from "./locks.js";
import { recordImmutableRefusal } from "./record-guard.js";
import type { UidIndex } from "./uid-index.js";
import { isDequeueRefusal, refusalCodeOf, refusalCodeOfThrown, refusalFamily, refusalPath, RefusalRateLimiter } from "@vault-mcp/core";

export { WriteQueue, WriteTimeoutError, WRITE_TIMEOUT_MS } from "./write-queue.js";
export type { LateSettlement } from "./write-queue.js";
export { WriteJournal, digestArgs, monthKey } from "./journal.js";
export type {
  JournalRecord,
  JournalActor,
  JournalAdapter,
  JournalEffects,
  JournalOutcome,
  JournalTarget,
} from "./journal.js";
export {
  IdempotencyStore,
  IdempotencyMismatchError,
  fingerprintArgs,
  IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_MAX,
} from "./idempotency.js";
export type {
  IdempotencyEntry,
  IdempotencyClaim,
  IdempotencySettlement,
  MismatchReason,
} from "./idempotency.js";
export {
  LockStore,
  LockCapError,
  holderOf,
  normalizeScope,
  scopeCovers,
  scopesOverlap,
  lockNoticeText,
  expiresInSeconds,
  LOCK_TTL_DEFAULT_MS,
  LOCK_TTL_MAX_MS,
  LOCK_TTL_MIN_MS,
  LOCK_MAX,
  LOCK_MAX_PER_HOLDER,
} from "./locks.js";
export type { Lock, LockClaim, LockNotice } from "./locks.js";
export {
  RecordImmutableError,
  recordImmutableRefusal,
  isRecordFlag,
  RECORD_EXEMPT_OPS,
} from "./record-guard.js";
export {
  UidIndex,
  UidUnresolvedError,
  UidAmbiguousError,
  resolveUidArgs,
  uidRef,
  UID_PREFIX,
} from "./uid-index.js";
export type { UidSource, UidResolution, UidDuplicate, UidAddressing } from "./uid-index.js";
export { loadInstallId, mintInstallId, INSTALL_ID_FILE } from "./install-id.js";
export type { InstallIdAdapter, LoadedInstallId, ServerIdentity } from "./install-id.js";
// The vocabulary kernel was re-exported HERE until the read-tier satellite
// extraction (suite split, S7). It now lives in `@vault-mcp/core`
// (`packages/core/src/vocab/`), because it has two consumers in two plugins:
// the four vocabulary tools, which left for the `vaultmcp-vocab` satellite, and
// the host's own conformance rail, which stayed. Import it from core — a
// second copy of a rule core is how one vault gets two vocabularies, which is
// the same reasoning that kept `queryBaseRows` in one place at S5.
//
// The module host (#68) — re-exported here as part of the mount step, the
// integration its barrel comment deferred to.
export {
  ModuleRegistry,
  forbiddenToolName,
  moduleFromRegistrar,
  DEFAULT_MODULE_SETTINGS,
  mergeModuleConfig,
  migrateLegacyModuleIds,
  toolDocDrift,
  toolDocReadOnlyDrift,
  safeValidate,
  collect,
} from "./modules/index.js";
export type {
  ModuleDescription,
  ModuleHostCtx,
  ModuleInstanceSettings,
  ModulePosture,
  ModuleSettings,
  ModuleSettingsSchema,
  ToolDef,
  ToolHandler,
  ToolRegistrar,
  VaultModule,
  AdapterMeta,
  RegistrarServer,
  ConfigBinding,
  ConfigField,
  ConfigFieldType,
  ModuleManifest,
  SurfaceDoc,
  ToolDoc,
  HostedDirectory,
  HostedField,
  HostedModule,
} from "./modules/index.js";

/**
 * Typed failure for an `if_rev` precondition that did not hold: the target's
 * revision at DEQUEUE was not the one the caller read. No write ran.
 */
export class RevConflictError extends Error {
  readonly code = "rev_conflict";
  constructor(
    readonly op: string,
    readonly path: string | undefined,
    readonly expected: number,
    readonly actual: number | undefined
  ) {
    super(
      `'${op}' expected ${path ? `'${path}'` : "the target"} at rev ${expected}, but found ` +
        (actual === undefined
          ? "no revision (the target does not exist, or this build cannot read revisions)"
          : `rev ${actual}`) +
        `. Nothing was written — re-read the note and retry with the current rev.`
    );
    this.name = "RevConflictError";
  }
}

/**
 * A TargetProbe call threw at dequeue. Wrapping it keeps the journaled error
 * attributable: `probe: …` says the identity/revision lookup failed, not the
 * vault operation (which never ran).
 */
export class ProbeError extends Error {
  readonly code = "probe_failed";
  constructor(readonly cause: unknown) {
    super(`probe: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ProbeError";
  }
}

/**
 * Cheap, synchronous lookups against live vault state, for the journal's
 * identity and revision fields. Implemented over Obsidian's metadata cache in
 * obsidian-probe.ts; kept as an interface so the kernel stays Obsidian-free.
 */
export interface TargetProbe {
  /** Frontmatter `uid` for a vault path, when the metadata cache already holds it. */
  uid(path: string): string | undefined;
  /** Revision token for a vault path — file mtime in ms. Undefined when absent. */
  rev(path: string): number | undefined;
  /**
   * Whether the note is a record under the operator's record identifier (by
   * default frontmatter `record: true`; record-guard.ts's `identifiesRecord`
   * decides what counts, over a property/value or a tag). `undefined` when the
   * flag cannot be read (no file, frontmatter not in the cache) — the record
   * check FAILS OPEN on it, so absence of an answer never refuses an
   * operation. Optional: a probe without it (older fakes, bare embeds) simply
   * doesn't enforce record immutability.
   */
  record?(path: string): boolean | undefined;
}

export interface MutationContext {
  /** Tool name — the operation identity in the journal. */
  op: string;
  args: Record<string, unknown>;
  actor: JournalActor;
  /**
   * Non-path target for an operation whose arguments name no vault path
   * (`command:editor:toggle-bold`, `plugin:dataview`). Derived at the
   * interception layer, where the tool surface's argument conventions live; the
   * kernel only records it, and only when no path was found.
   */
  ref?: string;
  /**
   * Optimistic-concurrency precondition: the revision the caller believes the
   * target holds (the `rev` a read returned). Checked at DEQUEUE against the
   * live revision; a mismatch fails with RevConflictError before the handler
   * runs. For a MULTI-TARGET operation (a batch move) it applies to the
   * PRIMARY target only — `target.path`, the first path the arguments name.
   */
  ifRev?: number;
  /**
   * Advisory agent-authored description of WHY this change is being made (B2:
   * the PR-description of the proposal-is-a-PR model). Journal-only: recorded
   * on the record beside op/actor, surfaced by review UIs as "agent says",
   * never trusted, never written to the note, and NEVER an acceptance signal —
   * nothing in the kernel reads it back. Deliberately NOT part of idempotency
   * identity: advisory text does not change what was written, so a replay may
   * reword it and each record keeps its own call's text.
   */
  intent?: string;
  /**
   * The address form(s) the caller actually used (`uid:<value>` / scheme refs
   * like `jd:<address>`), paired with the paths they resolved to at the
   * interception point — enqueue-time CALL metadata like `argsDigest`, not
   * vault state, so no dequeue sampling applies. Journal-only, audit-of-intent
   * (issue #91): `target` says what was touched; this says what was ASKED for.
   * Like `intent`, deliberately NOT part of idempotency identity, and recorded
   * on terminal records too — it describes this caller's own ask.
   */
  addressedAs?: Array<{ ref: string; path: string }>;
  /**
   * The Sync guard's warning (kernel/sync-guard.ts), when the call went on
   * while this Mac's Obsidian Sync was behind or could not be read.
   * Journal-only, like `intent`; NOT part of idempotency identity.
   */
  syncWarning?: string;
  /**
   * Retry-collapsing key. A second call carrying a key this kernel has already
   * completed replays that result without executing anything or taking a queue
   * slot; one that is still IN FLIGHT awaits the first call and adopts its
   * outcome. The key's identity is (key, op, arguments, `if_rev`) — a divergent
   * op, divergent arguments, or a divergent (including newly absent)
   * precondition is an error, never a silent replay. Per plugin instance,
   * TTL'd — see idempotency.ts.
   */
  idempotencyKey?: string;
  /**
   * Read the operation's REAL blast radius off its result, for operations whose
   * arguments cannot state it (a link repoint discovers the notes it rewrites).
   *
   * Supplied by the interception layer, where the tool surface's result
   * conventions live (mcp/guarded.ts) — the kernel only records what it is
   * handed, exactly as it does with `ref`. Absent ⇒ nothing is recorded; a
   * throw here is swallowed, since a journal field must never cost a caller
   * their result.
   */
  effectsOf?: (result: unknown) => JournalEffects | undefined;
}

/**
 * A call refused before it reached the write queue, for the refusal log
 * (#618): what the record says about it. `args` only feeds the target (the
 * paths it names, through the same walker as every other record); no
 * argument value is recorded.
 */
export interface RefusalContext {
  op: string;
  args: Record<string, unknown>;
  actor: JournalActor;
  ref?: string;
  addressedAs?: Array<{ ref: string; path: string }>;
}

// A batch move can name 100 paths; the journal records the shape, not the payload.
const MAX_JOURNALED_PATHS = 20;
const MAX_JOURNALED_ERROR = 500;

/**
 * Pull the error text out of a tool result. Tool handlers report failure by
 * RETURNING `{isError: true}` (ok()/fail() convention), not by throwing, so the
 * journal's outcome must be read off the envelope.
 */
function errorTextOf(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const r = result as { isError?: unknown; content?: unknown };
  if (r.isError !== true) return undefined;
  const first = Array.isArray(r.content) ? (r.content[0] as { text?: unknown } | undefined) : undefined;
  return typeof first?.text === "string" ? first.text.slice(0, MAX_JOURNALED_ERROR) : "error";
}

/**
 * The effects a handler reported, if any — never allowed to fail the operation
 * or lose the record. The convention it reads is the CALLER's (mc.effectsOf);
 * this only makes it safe.
 */
function safeEffects(mc: MutationContext, result: unknown): JournalEffects | undefined {
  try {
    return mc.effectsOf?.(result);
  } catch (e) {
    console.error("[vault-mcp] journal effects failed", e);
    return undefined;
  }
}

/** Journal text for a THROWN failure (as opposed to a returned isError envelope). */
function errorTextOfThrown(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_JOURNALED_ERROR);
}

/**
 * Attach the advisory notice for foreign claims to a tool result envelope.
 *
 * ADDITIVE ONLY, and only to something already shaped like a result: one extra
 * `content` text block (so `content[0]`'s JSON stays parseable byte-for-byte)
 * and, when the envelope carries a plain-object `structuredContent` that does
 * not already use the key, an `advisory_locks` array. A handler that returns
 * something else — a bare value, an array — is passed through untouched rather
 * than reshaped: the notice is a courtesy and must never be the reason a
 * caller's parse breaks.
 *
 * Several claims are ONE block, one claim per LINE. Space-joining ran them into
 * a single unreadable run-on the moment two claims overlapped a write, which is
 * exactly the case the notice exists for; a separate content block each would
 * make the block count vary with vault state, which callers index into.
 */
function withLockNotice<T>(result: T, locks: Lock[], now: number): T {
  if (locks.length === 0 || result === null || typeof result !== "object") return result;
  const r = result as { content?: unknown; structuredContent?: unknown };
  if (!Array.isArray(r.content)) return result;
  const text = locks.map((l) => lockNoticeText(l, now)).join("\n");
  const structured =
    r.structuredContent !== null &&
    typeof r.structuredContent === "object" &&
    !Array.isArray(r.structuredContent) &&
    !("advisory_locks" in (r.structuredContent as Record<string, unknown>))
      ? {
          structuredContent: {
            ...(r.structuredContent as Record<string, unknown>),
            advisory_locks: locks.map((l) => ({
              id: l.id,
              scope: l.scope,
              holder: l.holder,
              reason: l.reason,
              expires_in_s: expiresInSeconds(l, now),
            })),
          },
        }
      : {};
  return { ...(result as object), content: [...r.content, { type: "text", text }], ...structured } as T;
}

export class Kernel {
  constructor(
    readonly queue: WriteQueue = new WriteQueue(),
    private readonly journal: WriteJournal | null = null,
    private readonly probe: TargetProbe | null = null,
    /** Replay store for `idempotency_key`. In memory; main.ts seeds it from the journal at load, so a key that ran survives a reload (#435). */
    readonly idempotency: IdempotencyStore = new IdempotencyStore(),
    /**
     * Advisory scope claims. Consulted (never enforced) on every mutating
     * operation: a write inside another holder's live claim still runs, and
     * gains a notice saying whose work it landed in. In memory, cleared by a
     * plugin reload — see locks.ts.
     */
    readonly locks: LockStore = new LockStore(),
    /**
     * The identity substrate's `uid → path` map (uid-index.ts). Supplies the
     * journal's `target.uid` — from the index rather than a per-write
     * frontmatter probe — and backs `uid:<value>` addressing at the tool
     * boundary. Null in builds/tests without one: the probe remains the
     * fallback, and uid addressing fails closed.
     */
    readonly uids: UidIndex | null = null
  ) {}

  /**
   * The refusal log (#618): whether refused calls are marked in the journal
   * (see core's refusal-log.ts for the two kinds of mark). OFF unless the host
   * wires it to its `refusalLog` setting (main.ts), read live per call; off,
   * every record is what it was before and no line is added.
   */
  refusalLog: () => boolean = () => false;

  /** The cap on NEW refused lines, per session and code (core's RefusalRateLimiter). Replaceable in tests. */
  refusalLimiter: RefusalRateLimiter = new RefusalRateLimiter();

  /** The code that marks a DEQUEUE record, or undefined: the log is on and the code is on core's DEQUEUE_REFUSALS. */
  private dequeueRefusal(code: string | undefined): { refusal: string; codeFamily: string } | Record<string, never> {
    if (!isDequeueRefusal(code) || !this.journal || !this.refusalLogOn()) return {};
    return { refusal: code, codeFamily: refusalFamily(code) };
  }

  /** The switch, read safely: a throwing settings read is off, never a failed call. */
  refusalLogOn(): boolean {
    try {
      return this.refusalLog() === true;
    } catch {
      return false;
    }
  }

  /**
   * Journal a call refused BEFORE the queue (the strict schema, the profile,
   * the allowlist, the write scope, the protection, the Sync guard, …), when
   * the refusal log is on. A no-op when it is off, when the code is not a
   * refusal, or with no journal. Never throws.
   */
  journalRefusal(rc: RefusalContext, code: string): void {
    const journal = this.journal;
    if (!journal || !this.refusalLogOn()) return;
    if (refusalCodeOfThrown({ code }) === undefined) return;
    try {
      const key = `${rc.actor.session ?? rc.actor.connection}|${code}`;
      const flush = (count: number) => {
        void journal.append({ ts: new Date().toISOString(), op: rc.op, target: {}, actor: rc.actor, outcome: "refused", refusal: code, codeFamily: refusalFamily(code), suppressed: count, durationMs: 0, queueWaitMs: 0 });
      };
      if (!this.refusalLimiter.admit(key, flush)) return;
      const target = this.capTarget(this.withUid(this.resolveTarget(rc.args, rc.ref)));
      void journal.append({
        ts: new Date().toISOString(),
        op: rc.op,
        target,
        actor: rc.actor,
        outcome: "refused",
        refusal: code,
        codeFamily: refusalFamily(code),
        durationMs: 0,
        queueWaitMs: 0,
        ...(rc.addressedAs !== undefined && rc.addressedAs.length > 0
          ? { addressedAs: rc.addressedAs.slice(0, MAX_JOURNALED_PATHS).map((a) => ({ ref: refusalPath(a.ref), path: refusalPath(a.path) })) }
          : {}),
      });
    } catch (e) {
      console.error("[vault-mcp] refusal journal failed", e);
    }
  }

  /**
   * A refused call's target with every path capped (core's refusalPath): its
   * args were never checked, so a value under a path key may hold anything.
   */
  private capTarget(t: JournalTarget): JournalTarget {
    return {
      ...t,
      ...(t.path !== undefined ? { path: refusalPath(t.path) } : {}),
      ...(t.paths !== undefined ? { paths: t.paths.map(refusalPath) } : {}),
      ...(t.ref !== undefined ? { ref: refusalPath(t.ref) } : {}),
    };
  }

  /**
   * Run one mutating operation: serialized behind every other mutating
   * operation on this plugin instance, and journaled exactly once.
   *
   * Rethrows what the queue rejects with — including WriteTimeoutError and
   * RevConflictError, which the caller renders as typed tool errors (see
   * mcp/guarded.ts). An operation abandoned on timeout is journaled `error`; if
   * it later settles anyway, a second, CORRECTIVE record is appended (the
   * journal never rewrites a line).
   *
   * A call carrying an `idempotencyKey` either OWNS that key (and runs), waits
   * on the owner and adopts its outcome — return or throw alike — or fails with
   * IdempotencyMismatchError. See the file header for why waiters share the
   * owner's failure rather than re-running behind it.
   */
  async runMutation<T>(mc: MutationContext, run: () => Promise<T>): Promise<T> {
    // Computed once and reused by every record this call may produce, so a
    // replay's digest and the original's cannot drift apart.
    const argsDigest = digestArgs(mc.args);
    // Set when this call OWNS its idempotency key; called exactly once, from
    // the `finally` below, to release every waiter with this call's outcome.
    let settleKey: ((s: IdempotencySettlement) => void) | undefined;

    // Idempotency is settled BEFORE the queue: a retry that is going to be
    // replayed must not take a queue slot behind real work, let alone run. The
    // claim is synchronous — no await between the lookup and the reservation —
    // so concurrent retries of one request cannot all come away as owner.
    if (mc.idempotencyKey !== undefined) {
      // `ifRev` travels alongside the args fingerprint rather than inside it, so
      // a divergent precondition is reported as its own reason ("if_rev") with
      // both revisions named — see the ruling in idempotency.ts's header.
      const claim = this.idempotency.claim(
        mc.idempotencyKey,
        mc.op,
        fingerprintArgs(argsDigest, mc.args),
        mc.ifRev
      );
      if (claim.kind === "mismatch") {
        // One key, two operations (or two argument sets, or two preconditions):
        // the caller's retry bookkeeping is wrong, and either interpretation
        // could be the wrong write — or, worse, a silently discarded one.
        const mismatch = new IdempotencyMismatchError(
          mc.idempotencyKey,
          claim.firstOp,
          mc.op,
          claim.reason,
          claim.firstIfRev,
          mc.ifRev
        );
        this.journalTerminal(mc, argsDigest, "error", { error: mismatch.message, ...this.dequeueRefusal(mismatch.code) });
        throw mismatch;
      }
      if (claim.kind === "replay") {
        this.journalTerminal(mc, argsDigest, "deduped", { dedupeOf: claim.entry.ts });
        return claim.entry.result as T;
      }
      if (claim.kind === "wait") {
        // The key is in flight. Await the owner and adopt its outcome verbatim
        // — including a throw. Nothing ran here, so this is a `deduped` record
        // whichever way the owner went; `dedupeOf` points at the record that
        // holds the real story (and carries the error text, when there was one).
        const settlement = await claim.settlement;
        this.journalTerminal(mc, argsDigest, "deduped", {
          dedupeOf: settlement.ts,
          ...(settlement.ok ? {} : { error: errorTextOfThrown(settlement.error) }),
        });
        if (settlement.ok) return settlement.result as T;
        throw settlement.error;
      }
      settleKey = claim.settle;
    }
    const enqueued = Date.now();
    // Everything below is sampled AT DEQUEUE, inside the queued closure: with a
    // queue depth ≥ 1 the vault changes between enqueue and execution, so a
    // revBefore (or uid) read here would describe some earlier operation's
    // world, not this one's. `started` likewise, so durationMs measures the
    // handler and queueWaitMs measures the wait.
    let target: JournalTarget = {};
    let revBefore: number | undefined;
    let started = enqueued;
    let queueWaitMs = 0;
    // The most specific foreign claim this operation's primary target fell
    // inside, if any. Set at dequeue with everything else, for the same reason:
    // a claim taken (or expired) while this call sat in the queue is part of the
    // world the operation actually ran in, not the one it was submitted into.
    let lockNotice: LockNotice | undefined;

    let outcome: JournalOutcome = "ok";
    let error: string | undefined;
    // Read by the late-settlement handler to link its corrective record back.
    let ts: string | undefined;
    // Set only when the handler RETURNED an envelope; a throw leaves it unset,
    // so nothing gets stored for replay under an idempotency key.
    let settled: { value: T } | undefined;
    // The thrown value itself (not just its text) — waiters on this call's
    // idempotency key rethrow exactly what the owner threw.
    let thrown: { error: unknown } | undefined;
    try {
      const result = await this.queue.run(
        mc.op,
        () => {
          started = Date.now();
          queueWaitMs = started - enqueued;
          // Collected once and kept whole: `target.paths` is CAPPED for the
          // record, but the advisory-claim consult below must see every path the
          // operation names, or a claim covering only the fifty-first is missed.
          const paths = collectPaths(mc.args ?? {});
          target = this.targetOf(paths, mc.ref);
          try {
            // A delete or move destroys the source's identity, so uid/revBefore
            // have to be read while it still exists — but no earlier than this.
            const path = target.path;
            if (path) {
              // Index first, probe as fallback: the index is the identity
              // substrate's answer, and it still knows the uid of a path whose
              // frontmatter the metadata cache has not (re)parsed.
              const uid = this.uids?.uidFor(path) ?? this.probe?.uid(path);
              if (uid !== undefined) target = { ...target, uid };
              revBefore = this.probe?.rev(path);
            }
          } catch (e) {
            // A throwing probe is a probe failure, not a vault-operation
            // failure — say so, or the journal blames a write that never ran.
            throw new ProbeError(e);
          }
          // Record immutability (#264): a note whose frontmatter carries
          // `record: true` refuses every mutation except the append tool
          // (exemption by TOOL identity — see record-guard.ts). Checked at
          // dequeue like `if_rev`, over EVERY named path like the lock consult
          // below (a move ONTO a record overwrites it as surely as a write to
          // it), and against live cache state through the probe. FAIL OPEN:
          // no probe, no `record` method, or an unreadable flag never refuses
          // — the check is protective, not load-bearing, and its own
          // try/catch sits inside recordImmutableRefusal so a throwing record
          // probe is not promoted to a ProbeError that would fail the call.
          // Checked BEFORE `if_rev`: a categorically forbidden operation
          // should say so rather than report staleness.
          const recordProbe = this.probe?.record?.bind(this.probe);
          if (recordProbe) {
            const refusal = recordImmutableRefusal(mc.op, paths, recordProbe);
            if (refusal) throw refusal;
          }
          // The precondition, checked HERE and nowhere earlier: an enqueue-time
          // check would compare against a world the operations ahead of us in
          // the queue have already changed, which is precisely the lost update
          // `if_rev` exists to catch.
          if (mc.ifRev !== undefined && revBefore !== mc.ifRev) {
            throw new RevConflictError(mc.op, target.path, mc.ifRev, revBefore);
          }
          // Advisory claims: consulted, never enforced. The operation PROCEEDS
          // whatever it finds — a claim that could block would be a promise
          // Obsidian cannot keep (a rogue process writes bytes regardless), so
          // the mechanism's whole value is disclosure. What foreign claims buy
          // is a notice on the result and a `lockNotice` on the record.
          //
          // EVERY path is consulted, not just the primary: a move INTO a claimed
          // scope lands in somebody's work just as much as a move out of one.
          const foreign = paths.length > 0 ? this.locks.coveringAny(paths, holderOf(mc.actor)) : [];
          if (foreign.length > 0) {
            const [closest] = foreign;
            lockNotice = { holder: closest.holder, scope: closest.scope, reason: closest.reason };
          }
          const handled = run();
          return foreign.length === 0
            ? handled
            : Promise.resolve(handled).then((r) => withLockNotice(r, foreign, Date.now()));
        },
        // The queue abandoned this operation on timeout and we already journaled
        // an `error`; if it settles later, correct the record rather than let
        // the journal keep asserting a failure that may not have happened.
        (settlement) => {
          const lateError = settlement.ok
            ? errorTextOf(settlement.value)
            : settlement.error instanceof Error
              ? settlement.error.message.slice(0, MAX_JOURNALED_ERROR)
              : String(settlement.error).slice(0, MAX_JOURNALED_ERROR);
          const lateRevAfter = this.revAfterOf(target);
          void this.journal?.append({
            ts: new Date().toISOString(),
            op: mc.op,
            target,
            actor: mc.actor,
            argsDigest,
            outcome: lateError === undefined ? "late-ok" : "late-error",
            ...(lateError !== undefined ? { error: lateError } : {}),
            durationMs: Date.now() - started,
            queueWaitMs,
            ...(revBefore !== undefined ? { revBefore } : {}),
            ...(lateRevAfter !== undefined ? { revAfter: lateRevAfter } : {}),
            ...(ts !== undefined ? { corrects: ts } : {}),
            ...(lockNotice !== undefined ? { lockNotice } : {}),
            ...(() => {
              // A late settlement is the FIRST record able to say what the
              // abandoned operation touched — the timeout record was written
              // before it produced a result.
              const late = settlement.ok ? safeEffects(mc, settlement.value) : undefined;
              return late !== undefined ? { effects: late } : {};
            })(),
            ...this.preconditionFields(mc),
          });
        }
      );
      settled = { value: result };
      const text = errorTextOf(result);
      if (text !== undefined) { outcome = "error"; error = text; }
      return result;
    } catch (e) {
      // A failed precondition is its own outcome: nothing was written, and
      // `revBefore` already holds the revision actually found.
      outcome = e instanceof RevConflictError ? "conflict" : "error";
      error = e instanceof Error ? e.message : String(e);
      thrown = { error: e };
      throw e;
    } finally {
      const durationMs = Date.now() - started;
      const revAfter = this.revAfterOf(target);
      // Only a RETURNED envelope can report effects; a throw means the handler
      // never said what it touched, and the record must not guess.
      const effects = settled !== undefined ? safeEffects(mc, settled.value) : undefined;
      ts = new Date().toISOString();
      // The refusal log (#618): a call refused at dequeue keeps its record
      // exactly as it is (key, argsHash, returned, revs, effects), and gains
      // only `refusal` and `codeFamily`, and only for a code on core's
      // DEQUEUE_REFUSALS ("refused, nothing written"). Any other code, a
      // failure after a write above all, gains nothing. Off: nothing.
      const refusal =
        outcome === "ok"
          ? {}
          : this.dequeueRefusal(settled !== undefined ? refusalCodeOf(settled.value) : refusalCodeOfThrown(thrown?.error));
      // Fire-and-forget: WriteJournal.append never rejects, and the operation's
      // result must not wait on (or be affected by) the audit write. Appended
      // BEFORE the key is settled, so this record always precedes the `deduped`
      // records of the waiters that name it (the journal chains appends in call
      // order, and waiters only wake a microtask later).
      void this.journal?.append({
        ts,
        op: mc.op,
        target,
        actor: mc.actor,
        argsDigest,
        outcome,
        ...(error !== undefined ? { error } : {}),
        durationMs,
        queueWaitMs,
        ...(revBefore !== undefined ? { revBefore } : {}),
        ...(revAfter !== undefined ? { revAfter } : {}),
        ...(lockNotice !== undefined ? { lockNotice } : {}),
        ...(effects !== undefined ? { effects } : {}),
        ...this.preconditionFields(mc),
        ...(mc.idempotencyKey !== undefined && settled !== undefined ? { returned: true } : {}),
        ...refusal,
      });
      // Release the key: waiters adopt this outcome verbatim, and only now does
      // the store decide the key's future. A RETURNED envelope (success or a
      // failure envelope alike) is stored for replay — one key means one logical
      // request with one outcome, and a genuine retry of a failed operation
      // takes a fresh key. A THROWN failure (timeout, conflict, probe error)
      // stores nothing and frees the key: it left the vault in an unknown or
      // unchanged state, where re-running is the right answer.
      settleKey?.(settled !== undefined ? { ok: true, result: settled.value, ts } : { ok: false, error: thrown?.error, ts });
    }
  }

  /**
   * The caller-supplied kernel arguments, recorded on every record for a call
   * that actually reached the dequeue check. `ifRev` is deliberately NOT part of
   * the terminal-record path: see journalTerminal.
   */
  private preconditionFields(mc: MutationContext): {
    ifRev?: number;
    idempotencyKey?: string;
    intent?: string;
    addressedAs?: Array<{ ref: string; path: string }>;
    syncWarning?: string;
  } {
    return {
      ...(mc.ifRev !== undefined ? { ifRev: mc.ifRev } : {}),
      ...(mc.idempotencyKey !== undefined ? { idempotencyKey: mc.idempotencyKey, argsHash: argsHashOf(mc.args) } : {}),
      ...(mc.intent !== undefined ? { intent: mc.intent } : {}),
      ...(mc.addressedAs !== undefined && mc.addressedAs.length > 0
        ? { addressedAs: mc.addressedAs.slice(0, MAX_JOURNALED_PATHS) }
        : {}),
      ...(mc.syncWarning !== undefined ? { syncWarning: mc.syncWarning.slice(0, MAX_JOURNALED_ERROR) } : {}),
    };
  }

  /**
   * Journal a record for an operation that never reached the queue — a replayed
   * or deduped idempotency key, or a key reused across operations/arguments.
   * Same shape as any other record; zero durations, because nothing ran.
   *
   * `ifRev` is OMITTED even when the caller supplied one: the precondition is
   * evaluated at dequeue, and nothing here ever dequeued. Recording it would
   * assert a check that never happened. `idempotencyKey` is still recorded —
   * that argument is exactly what produced this record.
   */
  private journalTerminal(
    mc: MutationContext,
    argsDigest: Record<string, unknown>,
    outcome: JournalOutcome,
    extra: { error?: string; dedupeOf?: string; refusal?: string; codeFamily?: string } = {}
  ): void {
    void this.journal?.append({
      ts: new Date().toISOString(),
      op: mc.op,
      target: this.withUid(this.resolveTarget(mc.args, mc.ref)),
      actor: mc.actor,
      argsDigest,
      outcome,
      ...(extra.error !== undefined ? { error: extra.error.slice(0, MAX_JOURNALED_ERROR) } : {}),
      durationMs: 0,
      queueWaitMs: 0,
      ...(extra.dedupeOf !== undefined ? { dedupeOf: extra.dedupeOf } : {}),
      ...(mc.idempotencyKey !== undefined ? { idempotencyKey: mc.idempotencyKey } : {}),
      // `intent` and `addressedAs` ARE recorded here, unlike `ifRev`: they
      // assert nothing about a check — each is this caller's own description
      // of its ask, which is exactly what a deduped/mismatch record documents.
      ...(mc.intent !== undefined ? { intent: mc.intent } : {}),
      ...(mc.addressedAs !== undefined && mc.addressedAs.length > 0
        ? { addressedAs: mc.addressedAs.slice(0, MAX_JOURNALED_PATHS) }
        : {}),
      ...(mc.syncWarning !== undefined ? { syncWarning: mc.syncWarning.slice(0, MAX_JOURNALED_ERROR) } : {}),
      ...(extra.refusal !== undefined ? { refusal: extra.refusal, codeFamily: extra.codeFamily } : {}),
    });
  }

  /**
   * Fresh revision probe for the target, if it names a path at all.
   *
   * Never throws: this runs on the `finally` path (and its late-settlement
   * twin), where a throwing probe would replace a perfectly good result with an
   * exception — or, worse, lose the journal record entirely.
   */
  private revAfterOf(target: JournalTarget): number | undefined {
    if (!target.path) return undefined;
    try {
      return this.probe?.rev(target.path);
    } catch (e) {
      console.error("[vault-mcp] revAfter probe failed", e);
      return undefined;
    }
  }

  /**
   * Derive the operation's target from its arguments, reusing the guard's
   * recursive path collector so the journal sees exactly the paths the
   * allowlist would scope — a tool the guard can see cannot be invisible here.
   *
   * `ref` is the fallback for pathless mutators (run a command, toggle a
   * plugin): it is recorded only when the arguments name no path at all, so a
   * real path always wins.
   *
   * Probe-free by design: `uid` is attached by the caller, which decides how a
   * throwing probe should be treated (fatal-but-attributed at dequeue,
   * swallowed on the record-only paths).
   */
  private resolveTarget(args: Record<string, unknown>, ref?: string): JournalTarget {
    return this.targetOf(collectPaths(args ?? {}), ref);
  }

  /** The journal shape for an already-collected path list. Capped; probe-free. */
  private targetOf(paths: string[], ref?: string): JournalTarget {
    if (paths.length === 0) return ref ? { ref } : {};
    return {
      path: paths[0],
      ...(paths.length > 1 ? { paths: paths.slice(0, MAX_JOURNALED_PATHS) } : {}),
    };
  }

  /** `target` plus its uid, for record-only paths — never throws, nothing ran. */
  private withUid(target: JournalTarget): JournalTarget {
    if (!target.path) return target;
    try {
      const uid = this.uids?.uidFor(target.path) ?? this.probe?.uid(target.path);
      return uid !== undefined ? { ...target, uid } : target;
    } catch {
      return target;
    }
  }
}
