// The COMPATIBILITY ADAPTER — Gate 0, WP0 (D18).
//
// Every surface that exists today predates the action registry. Rewriting all
// 123 of them before the registry exists would be a big-bang refactor of a
// working product; leaving them unregistered would make "every reachable
// invocation resolves to a registered action" false on day one. D18 settles
// this: establish the seam early, derive a CONSERVATIVE contract for what
// already exists, and migrate to native contracts in risk order.
//
// A compatibility action is derived from what the adapter can actually SEE at
// a registration site: the tool's name, its `readOnlyHint` annotation, its
// owning module, and which of its arguments carry paths. That is genuinely all
// it can see. It cannot see whether a read's payload is worth replaying,
// whether a handler's postcondition is verifiable, or what a diff's change
// class turns out to be — so it says none of those things.
//
// The rule that makes this safe rather than merely convenient: a derived
// contract may claim only what the existing implementation already proves.
// `registry.ts` enforces it (`compatibility_overclaim`), so a future edit that
// quietly upgrades a compat action to `replayable` fails the build instead of
// laundering a guess into evidence.
//
// The migration metric falls out for free: every compat action is
// `compat.<surface>`, so the count of `compat.` ids is exactly the remaining
// migration debt, and it is visible in one grep.

import type { ActionDefinition, ChangeClass, Distribution } from "./action.js";

/** Prefix every derived action id carries. Grep-ably distinct from a native
 * dotted id like `note.append`, so migration progress is countable. */
export const COMPAT_PREFIX = "compat.";

/** Compatibility contracts are all at version 1 and stay there. A derived
 * contract never *evolves* — it is replaced by a native one, which mints its
 * own id and version. */
export const COMPAT_VERSION = 1;

/**
 * What a mutating compatibility action may have changed.
 *
 * Every non-authority class, deliberately. The adapter cannot compute a class
 * from a handler it has not run, and naming one narrow class would be a guess
 * that a narrow-class mandate could later rely on. Claiming all five is the
 * honest statement — "this could be any of these; nothing here has established
 * which" — and it makes the action ineligible for every class-bounded mandate,
 * which is exactly the intended posture until it is native.
 *
 * `authority` is absent because no MCP or agent-reachable surface may carry
 * it; an action that genuinely changes authority is declared natively and
 * Governor-only, never derived.
 */
export const COMPAT_MUTATION_CLASSES: ChangeClass[] = [
  "encoding",
  "presentation",
  "representation",
  "structural",
  "content",
];

export interface CompatibilitySpec {
  /** The surface's own identity — for MCP, the exact tool name. */
  surface: string;
  /** One bounded statement of what becomes true. Taken from the registration's
   * own title/description rather than invented. */
  postcondition: string;
  /** Owning module id, or `core` for a hand-registered surface. */
  owner: string;
  /** D07 distribution profile for this capability. */
  distribution: Distribution;
  /**
   * `annotations.readOnlyHint === true` as LITERALLY declared at the
   * registration site. Not "does it look read-only" — the same discriminant
   * the guard, queue and journal already key on, so the registry's view of
   * what mutates is the runtime's view by construction.
   */
  readOnly: boolean;
  /** Argument names carrying a vault path. */
  paths?: string[];
  /**
   * Blast radius beyond the arguments. Defaults to `unbounded` for a mutating
   * surface: until someone establishes otherwise, "we have not measured this"
   * is the true answer, and `obsidian_repoint_link` is this repo's standing
   * proof that the optimistic default would be wrong.
   */
  discovered?: "none" | "bounded" | "unbounded";
  /** True when the surface refuses outright while a path scope is active. */
  refusesUnderScope?: boolean;
  /** The registration gate, verbatim, when the surface is conditional. */
  gate?: string;
  /** Why this surface still needs a derived contract. */
  reason?: string;
}

/** `compat.obsidian_read_note` */
export function compatibilityActionId(surface: string): string {
  return `${COMPAT_PREFIX}${surface}`;
}

export function isCompatibilityAction(action: ActionDefinition): boolean {
  return action.id.startsWith(COMPAT_PREFIX);
}

/**
 * Derive one conservative action contract from an existing registration.
 *
 * Every claim below is either observed at the registration site or is the
 * weakest value the schema permits. Nothing is optimistic.
 */
export function compatibilityAction(spec: CompatibilitySpec): ActionDefinition {
  const mutating = !spec.readOnly;
  return {
    id: compatibilityActionId(spec.surface),
    version: COMPAT_VERSION,
    title: spec.surface,
    postcondition: spec.postcondition,
    owner: spec.owner,
    distribution: spec.distribution,
    // A read is a read. A mutating surface is a PROPOSAL mutation and nothing
    // more: `mandated-mutation` would imply mandate eligibility, which a
    // derived contract can never have.
    modes: spec.readOnly ? ["read"] : ["proposal-mutation"],
    changeClasses: mutating ? [...COMPAT_MUTATION_CLASSES] : [],
    // The weakest capture level, so nothing downstream can depend on a
    // compatibility observation. Reads through this path are certainly worth
    // replaying — but the adapter cannot promise a payload the current
    // implementation never retained, and promising it is how a proposal comes
    // to cite evidence that does not exist.
    observations: { defaultCapture: "ephemeral", supportsProposal: false },
    effects: {
      direct: mutating ? ["vault-content"] : [],
      discovered: spec.discovered ?? (mutating ? "unbounded" : "none"),
    },
    // No derived surface is Governor-only and none may be admitted
    // automatically. Both stay false/never for the whole life of the
    // compatibility path.
    authority: { governorOnly: false, automaticAdmission: "never" },
    scope: {
      argumentKeys: spec.paths ?? [],
      // uid: addressing (and the retired <scheme>: refusal) binds at the shared interception point
      // for every path-bearing argument, so this is true of all of them at
      // once rather than tool by tool.
      resolvesAddresses: (spec.paths?.length ?? 0) > 0,
      // A surface with no path argument reaches the vault by enumerating it,
      // and the read boundary requires that iteration be filtered before
      // anything is read.
      enumeration: (spec.paths?.length ?? 0) > 0 ? "not-applicable" : "filter-before-read",
      whenScoped: spec.refusesUnderScope ? "refuse" : "available",
    },
    // Mutations are journaled today; reads are not. This one field is the
    // adapter's only non-minimal claim, and it is directly observable: the
    // kernel appends a record for exactly the set `readOnlyHint === false`
    // selects.
    retention: { operation: mutating ? "durable-for-mutation" : "ephemeral" },
    // Only the path-bearing inputs are enumerated. The full versioned input
    // schema stays with the surface until the action is native — which means
    // the registry's reserved-identity check is currently only as strong as
    // this list. Stated plainly rather than papered over: it is a real limit
    // of Gate 0, closed when schemas move into the registry.
    inputs: spec.paths ?? [],
    native: false,
    compatibility: {
      derivedFrom: spec.surface,
      reason:
        spec.reason ??
        `pre-registry surface; conservative contract derived from its registration metadata${spec.gate ? ` (gate: ${spec.gate})` : ""}`,
    },
  };
}
