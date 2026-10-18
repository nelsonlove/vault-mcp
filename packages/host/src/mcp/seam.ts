// THE GOVERNANCE SEAM — the host's hook API for an optional governance provider.
//
// Built by S2 of the suite split (docs/suite-split-design.md §5, as amended by
// the independent perimeter review of 2026-08-27 and retriaged against §0's
// threat model). It lives in `src/mcp/` because it ships on the SAME
// plugin-to-plugin api object `external-tools.ts` defines — one directory holds
// the whole boundary another plugin can reach — and because both consultation
// points (`server.ts`, `guarded.ts`) are here too.
//
// ── WHAT CROSSES, AND WHY EACH DIRECTION IS SAFE (§3) ────────────────────────
//
// Exactly two classes of thing cross the seam:
//
//   • CANDIDATES flow OUTWARD. The host tells the provider "a write completed;
//     here are the exact base and proposed bytes". The provider turns that into
//     a proposal. A proposal confers nothing — agents and machinery supply
//     candidates, humans decide.
//   • REFUSALS flow INWARD. The provider answers refuse-or-not, and a refusal
//     can only make the host refuse MORE. Fail closed by construction.
//
// The third hook class — anything that can mutate a write in flight or ASSERT
// acceptance — is what this module must never offer. §5's rule 6 generalises
// it: the seam accepts registrations that can only ADD A REFUSAL, never a
// predicate the host consults for PERMISSION. That is why the session hook
// returns `{code, detail} | null` and not `{live: boolean}`: the type cannot
// express an allow, so a registrant cannot un-refuse a session the host or
// another registrant already refused.
//
// ── WHY THERE IS NO `registerWriteVeto` (condition 8) ───────────────────────
//
// §5 sketched a pre-write veto and named two registrants for it. Both were
// wrong on the code: the fuller accept-transition guard is `acceptTransitionReason`,
// which is HOST-side in `@vault-mcp/core` and already runs on every guarded
// write; the legacy-writer guard is a provider-internal `BaselineStore`
// predicate (`setLegacyWriteGuard`, governor/wiring/wiring.ts) that gates the
// provider's OWN baseline writes and never touches the MCP write path. S2
// searched for a real registrant and found none, so the veto is not built.
// Unused perimeter surface is dead code, and at a perimeter dead code is worse
// than absent code — it is a shape reviewers reason about and nothing proves.
// When a real registrant appears, it lands with its round-trip test.
//
// ── THE SIX RULES, AND WHERE EACH ONE LIVES ─────────────────────────────────
//
//  1. No mutation hooks. The host never reads a hook's return value except a
//     refusal's `{code, detail}` — pinned by tests/seam.test.mjs's source scan
//     over this module's declared return types.
//  2. Refusals fail CLOSED, observers fail OPEN. A throwing session-refusal hook
//     refuses (a hook that cannot answer must not be read as consent); a
//     throwing or hanging observer is logged and the write stands.
//  3. Observers run after the host's own record. `notifyWrite` is called from
//     the executor's post-handler path, after the journal append — nothing a
//     provider does can precede or suppress the host's audit.
//  4. The host works with ZERO hooks registered. Every consultation iterates a
//     possibly-empty list; the standalone host is the vacuous case, not a
//     special one.
//  5. Bytes and identifiers cross, never capabilities. `WriteFacts` carries no
//     callback, no store handle, and no app reference.
//  6. Registration is app-reachable; the registered CLOSURES are not. The hook
//     lists live in a module-private WeakMap keyed by a token no caller holds —
//     the same pattern `governor/wiring/wiring.ts` uses for the accept
//     perimeter. A reachable observer would be a proposal factory callable with
//     forged facts, which is strictly more than the `app.vault` equivalence
//     covers.
//
// ── PLACEMENT AND BUDGETS (condition 5) ─────────────────────────────────────
//
// The session refusal is consulted INSIDE the kernel's queued closure, where
// `sessionLive` was consulted before it — so `WRITE_TIMEOUT_MS` already bounds
// it and a hanging refusal costs the caller a typed timeout rather than a
// wedged queue. Observers are the opposite case: the write has already landed,
// so they are dispatched OFF the caller's result path (`queueMicrotask`, one
// task per hook, every failure caught) and nothing awaits them.
//
// ── REVOCATION (condition 3) ────────────────────────────────────────────────
//
// Every `register*` returns a disposer, and the disposer is the ONLY way to
// revoke. There is no id-addressed `unregisterHook(id)` — the `id` argument is
// diagnostic labelling and an owner LABEL, never an address. An address-based
// revoke is forgeable by anyone holding the api object, which is exactly the
// defect S2 also fixed in `ExternalToolRegistry` (its `unregisterTools(owner)`
// let any caller unhook any publisher's tools).

import type { JournalActor } from "../kernel/index.js";

/**
 * The exact facts of a completed write, as the host observed them.
 *
 * `baseBytes: null` means creation. The byte arrays are the host's own buffers,
 * handed over WITHOUT a per-hook copy: copying every write's bytes once per
 * registered hook is a per-write cost paid against an actor §0's threat model
 * excludes (hostile code already running in the renderer, which can read the
 * whole vault through `app.vault` anyway). The cheap half of the defensive-copy
 * condition survives and is applied — `operation` and `actor` are deep-frozen,
 * which also catches a BUGGY hook mutating state its neighbours will read.
 */
export interface WriteFacts {
  path: string;
  baseBytes: Uint8Array | null;
  proposedBytes: Uint8Array;
  /** The producing operation's identity — ids and versions, no handles. */
  operation: { id: string; action: string; actionVersion: number; sessionId: string | null };
  /** The journal's own attribution for this operation, verbatim. */
  actor: JournalActor;
}

/**
 * A typed refusal. Shape-identical to the coded errors the guard already
 * renders (`Error [code]: detail`), so a provider's refusal reaches an agent in
 * the same form as a host refusal.
 *
 * `null` is "nothing to say" — deliberately NOT "allow". No seam hook can
 * express an allow, which is the whole point of rule 6.
 */
export interface SeamRefusal {
  code: string;
  detail: string;
}

export type WriteObserver = (facts: WriteFacts) => void | Promise<void>;
/**
 * Why the host is asking. `"dequeue"` (the default) is the check inside the
 * write queue. `"rotate"` is asked before the host replaces an EXPIRED session
 * with a new one (`kernel/sessions/connection-session.ts`): a rotation needs a
 * positive answer that the old session is not revoked, so a hook that cannot
 * read its revocation state should REFUSE for `"rotate"`, even where it
 * degrades to silence for `"dequeue"`. A hook that ignores the argument keeps
 * its old behaviour.
 */
export type SessionRefusalPurpose = "dequeue" | "rotate";

/**
 * What a session-refusal hook declares about itself at registration. A hook
 * that lists `"rotate"` in `purposes` says it reads the second argument and
 * answers `"rotate"` with a positive "not revoked" (it refuses when it cannot
 * tell). A hook that does not declare it, such as an older provider build or a
 * third-party one, may return silence on a store failure, and the host cannot
 * tell that silence from "not revoked"; so for such a hook every `"rotate"`
 * consultation refuses, and no session rotates while it is registered. With no
 * hook at all a rotation goes ahead: nothing can revoke a session then.
 */
export interface SessionRefusalOptions {
  purposes?: readonly SessionRefusalPurpose[];
}
export type SessionRefusalHook = (
  sessionId: string | null,
  purpose?: SessionRefusalPurpose
) => SeamRefusal | null | Promise<SeamRefusal | null>;

/**
 * The REGISTRATION surface — reachable from `app` through the host plugin's
 * api object, and harmless there (§3): registering a hook grants the registrant
 * nothing it did not already have, and every hook class can only observe or
 * refuse.
 *
 * `id` names the registering plugin. It is used for diagnostics, and by the
 * plugin-management tools to refuse switching off a registered provider
 * (condition 6). It is self-asserted, exactly like `registerTools`'
 * `ownerPluginId` — and, exactly like it, it addresses nothing: revocation is
 * the returned disposer and only the returned disposer.
 */
export interface GovernanceSeam {
  /**
   * Post-write, observe-only. The return value is IGNORED; a throw or a hang
   * costs the caller nothing, because nothing on the result path awaits this.
   */
  registerWriteObserver(id: string, observe: WriteObserver): () => void;
  /**
   * Session liveness, REFUSAL-SHAPED. Consulted where the host consulted
   * `sessionLive` before: inside the kernel's queued closure, at dequeue.
   * Return a refusal to abort the mutation, `null` to say nothing. A throw is a
   * refusal — a hook that cannot answer must not be read as consent.
   */
  registerSessionRefusal(id: string, refuse: SessionRefusalHook, options?: SessionRefusalOptions): () => void;
}

/**
 * The CONSULTATION surface — host-internal. Threaded to the per-connection
 * server through `ServerCtx`, which is a closure-held object in `main.ts`'s
 * `onload` and is not reachable from `app`.
 */
export interface SeamConsult {
  /**
   * Hand a completed write to every registered observer, OFF the caller's
   * result path. Returns immediately, always; never throws.
   */
  notifyWrite(facts: WriteFacts): void;
  /**
   * Ask every registered hook whether this session must be refused. The FIRST
   * refusal wins (deny-wins: a later `null` cannot undo an earlier refusal,
   * and the type could not express an allow even if it wanted to).
   */
  refuseSession(sessionId: string | null, purpose?: SessionRefusalPurpose): Promise<SeamRefusal | null>;
  /**
   * The ids that currently hold at least one registration — a registered
   * governance provider is a plugin the host must not let an agent switch off
   * as cleanup (condition 6). Read-only; a copy, so a caller cannot edit the
   * host's view of who is registered.
   */
  providerIds(): string[];
}

interface HookEntry<T> {
  id: string;
  fn: T;
  /** Session-refusal hooks only: whether the hook declared the `"rotate"` purpose. */
  rotate?: boolean;
}

interface HookState {
  observers: Array<HookEntry<WriteObserver>>;
  sessionRefusals: Array<HookEntry<SessionRefusalHook>>;
}

/**
 * THE HOOK LISTS, module-private (condition 1).
 *
 * Keyed by a token minted inside `createGovernanceSeam` and captured only by
 * the two objects it returns — so neither the api object, nor the plugin
 * instance, nor anything else walkable from `app` holds a reference to a
 * registered closure. Renderer JS can call `registerWriteObserver`; it cannot
 * enumerate, replace, or invoke what anyone else registered.
 */
const HOOKS = new WeakMap<object, HookState>();

/** Freeze an object and every plain-object value inside it. Cycles are safe. */
function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v, seen);
  return Object.freeze(value);
}

/** Remove `entry` from `list` by object identity — the disposer's only mechanism. */
function drop<T>(list: Array<HookEntry<T>>, entry: HookEntry<T>): void {
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
}

/**
 * Build one seam. Called ONCE per plugin instance, in `main.ts`; the returned
 * `seam` goes on the plugin's api object and the returned `consult` goes into
 * the closure-held `ServerCtx`.
 */
export function createGovernanceSeam(): { seam: GovernanceSeam; consult: SeamConsult } {
  const token = {};
  HOOKS.set(token, { observers: [], sessionRefusals: [] });
  const state = () => HOOKS.get(token)!;

  const seam: GovernanceSeam = {
    registerWriteObserver(id, observe) {
      if (typeof observe !== "function") throw new TypeError(`vault-mcp: write observer for '${id}' is not a function`);
      const entry: HookEntry<WriteObserver> = { id: String(id), fn: observe };
      state().observers.push(entry);
      let disposed = false;
      return () => {
        if (disposed) return; // idempotent, and a spent disposer can never drop a successor
        disposed = true;
        drop(state().observers, entry);
      };
    },
    registerSessionRefusal(id, refuse, options) {
      if (typeof refuse !== "function") throw new TypeError(`vault-mcp: session refusal for '${id}' is not a function`);
      const purposes = options?.purposes;
      if (purposes !== undefined && !Array.isArray(purposes)) {
        throw new TypeError(`vault-mcp: session refusal options for '${id}': purposes must be an array`);
      }
      // Read once, at registration: a declaration cannot be widened later
      // through a kept reference to the options object.
      const entry: HookEntry<SessionRefusalHook> = { id: String(id), fn: refuse, rotate: purposes?.includes("rotate") === true };
      state().sessionRefusals.push(entry);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        drop(state().sessionRefusals, entry);
      };
    },
  };

  const consult: SeamConsult = {
    notifyWrite(facts) {
      const observers = state().observers;
      if (observers.length === 0) return; // rule 4: the empty list is the ordinary case
      // Frozen ONCE, then shared: `operation` and `actor` cannot be mutated by
      // one hook into what the next hook (or the host's own later use) reads.
      // Bytes are deliberately not copied — see WriteFacts.
      deepFreeze(facts.operation);
      deepFreeze(facts.actor);
      Object.freeze(facts);
      for (const { id, fn } of observers) {
        // One microtask per hook: a hook that hangs holds nothing, a hook that
        // throws is caught here, and neither can reach the caller's result.
        queueMicrotask(() => {
          try {
            const r = fn(facts);
            if (r && typeof (r as Promise<void>).catch === "function") {
              (r as Promise<void>).catch((e) => console.error(`[vault-mcp] write observer '${id}' failed`, e));
            }
          } catch (e) {
            console.error(`[vault-mcp] write observer '${id}' failed`, e);
          }
        });
      }
    },
    async refuseSession(sessionId, purpose = "dequeue") {
      for (const { id, fn, rotate } of state().sessionRefusals) {
        // A hook that never declared the rotate check cannot give the positive
        // "not revoked" a rotation needs: its silence might be a store failure.
        if (purpose === "rotate" && !rotate) {
          return {
            code: "session_rotation_unsupported",
            detail: `the governance provider '${id}' does not declare the rotate check, so an expired session is not rotated; reconnect to open a new session`,
          };
        }
        try {
          const refusal = await fn(sessionId, purpose);
          if (refusal) return { code: refusal.code, detail: refusal.detail };
        } catch (e) {
          // Fail CLOSED (rule 2). A refusal hook that throws has not said
          // "allow" — it has said nothing, and nothing is not consent.
          return {
            code: "session_hook_failed",
            detail: `the governance provider's session check ('${id}') failed, so this mutation is refused rather than allowed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          };
        }
      }
      return null;
    },
    providerIds() {
      const s = state();
      return [...new Set([...s.observers, ...s.sessionRefusals].map((h) => h.id))];
    },
  };

  return { seam, consult };
}

/**
 * The HOST's side of the write report, in one place so it is a tested function
 * rather than an inline closure in the transport.
 *
 * What it decides is attribution, and attribution is a HOST concern even though
 * the consumer is the provider: the write-facts slot is a single-item mailbox
 * the backend fills and the executor empties, and a mismatch means the facts in
 * it belong to some OTHER write. Handing those across would manufacture a
 * proposal about a write that did not happen — internally consistent, wrong,
 * and quiet. So the safe direction is to report NOTHING and say so loudly.
 *
 * Returns whether the facts reached the seam — false for an empty slot, a
 * mismatch, or a host with no seam wired at all — so a caller can log or test
 * the decision without reaching into the seam.
 */
export function reportCompletedWrite(
  consult: SeamConsult | undefined,
  facts: { path: string; baseBytes: Uint8Array | null; proposedBytes: Uint8Array } | null,
  operation: { id: string; action: { id: string; version: number }; sessionId?: string | null },
  sources: string[],
  actor: JournalActor
): boolean {
  if (!facts) return false;
  if (!sources.includes(facts.path)) {
    console.warn(
      `[vault-mcp] write facts for '${facts.path}' do not match operation ${operation.id}'s sources; not reported`
    );
    return false;
  }
  // Attribution is checked BEFORE the provider question, deliberately: a
  // mismatched slot is a HOST bug, and it is worth the console line whether or
  // not anyone is listening on the other side.
  if (!consult) return false;
  consult.notifyWrite({
    path: facts.path,
    baseBytes: facts.baseBytes,
    proposedBytes: facts.proposedBytes,
    operation: {
      id: operation.id,
      action: operation.action.id,
      actionVersion: operation.action.version,
      sessionId: operation.sessionId ?? null,
    },
    actor,
  });
  return true;
}
