// The ACTION contract — Gate 0, WP0.
//
// An action is a stable, versioned semantic contract named by its
// POSTCONDITION: one bounded statement of what becomes true in the vault. It is
// deliberately NOT a tool, a handler, or a UI control. Those are SURFACES —
// doors onto an action — and several of them may open onto the same action.
//
// Why the indirection exists (docs/action-registry.md, "Why the registry is the
// owner"): tool-shaped architecture drifts. A tool acquires a side effect while
// its documentation, safety classification, compact-discovery entry and test
// matrix stay unchanged; or it appears through a second surface that bypasses
// the first surface's wrapper. This repo already has three registration paths
// (the patched `registerTool`, `origRegister` for `obsidian_write_notes` and
// the Code Mode meta-tools, and `mountModules`' registrar), which is exactly
// the shape that drift hides in. Declaring the action ONCE and generating or
// validating every surface from it is what closes that class.
//
// This module is pure data and types. It imports nothing — not `obsidian`, not
// the kernel — so it can be consumed by the registry, by the compatibility
// adapter, by generated projections, and by headless tests alike.

/** The six change classes, in their CANONICAL ORDER.
 *
 * PUBLISHED into `@vault-mcp/core` at the host/provider split (S3c) and
 * re-exported here, so no call site in this package moved. The order is
 * load-bearing rather than cosmetic — canonical proposal subjects sort an
 * item's classes this way before hashing (coding guide section 8), so two
 * producers computing the same subject must agree on it — and after the split
 * those two producers are in two plugins. A forked copy whose order drifted
 * would hash the same change to two different subjects, which is the standing
 * chain silently forking. */
export { CHANGE_CLASSES } from "@vault-mcp/core";
export type { ChangeClass } from "@vault-mcp/core";
import type { ChangeClass } from "@vault-mcp/core";

/** Where an action may ship. `private` and `excluded` differ: a private action
 * exists in an operator build and is ABSENT from the Community bundle; an
 * excluded one is a known capability class deliberately never exposed. */
export const DISTRIBUTIONS = ["public-default", "public-optional", "private", "excluded"] as const;
export type Distribution = (typeof DISTRIBUTIONS)[number];

/** Operation mode is NOT change class (docs/operation-contract.md): mode is how
 * an invocation proceeds, class is what it changes. A proposal mutation may be
 * content or structural; a read is neither. */
export const OPERATION_MODES = ["read", "plan", "proposal-mutation", "mandated-mutation", "authority"] as const;
export type OperationMode = (typeof OPERATION_MODES)[number];

/** Observation durability (D16). Ordered weakest to strongest — `capture` may
 * be raised by policy but never lowered by a caller. */
export const CAPTURE_LEVELS = ["ephemeral", "evidence", "replayable"] as const;
export type CaptureLevel = (typeof CAPTURE_LEVELS)[number];

/** Surface kinds. `mcp` and `external` are AGENT-REACHABLE; `ui` is a human
 * gesture; `automation` is Governor's own scheduled work; `internal` is a
 * Governor-to-Governor call. The split is what the authority fence is defined
 * over — see AGENT_REACHABLE_SURFACES in surface-binding.ts. */
export const SURFACE_KINDS = ["mcp", "ui", "automation", "external", "internal"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/**
 * Input names a caller may NEVER supply, because supplying them would let the
 * caller choose an identity or an authority target that only Governor derives.
 *
 * This is the schema-level half of coding-guide authority rule #3 ("an agent
 * cannot choose an authoritative actor or signer … or advance a standing ref").
 * The runtime half — ignoring or refusing such a field if it arrives anyway —
 * belongs to the executor; declaring one here is a BUILD failure so the field
 * never reaches a schema in the first place.
 *
 * Both snake_case and camelCase spellings are listed because the repo's MCP
 * schemas use snake_case while its internal call sites use camelCase, and a
 * tripwire that only recognizes one spelling is not a tripwire.
 */
export const RESERVED_IDENTITY_INPUTS = [
  "actor",
  "actorBinding",
  "actor_binding",
  "principal",
  "signer",
  "signerKey",
  "signer_key",
  "verifier",
  "verifierKey",
  "verifier_key",
  "keyid",
  "keyId",
  "key_id",
  "standingRef",
  "standing_ref",
  "admittedBy",
  "admitted_by",
  "acceptedBy",
  "accepted_by",
] as const;
export type ReservedIdentityInput = (typeof RESERVED_IDENTITY_INPUTS)[number];

/** What an action may observe, and how durably. */
export interface ObservationContract {
  /** The capture level this action's observations get by default. A governed
   * session may raise it; nothing may lower it below what a dependent claim
   * needs. */
  defaultCapture: CaptureLevel;
  /** Whether this action's observations may be named as support for a
   * proposal, verification, or admission. D16 forbids this for `ephemeral`. */
  supportsProposal: boolean;
}

/** What an action may change. `discovered` describes targets the action finds
 * at runtime rather than receiving as arguments — `obsidian_repoint_link` is
 * this repo's live example, and it is why the field exists. */
export interface EffectContract {
  direct: string[];
  discovered: "none" | "bounded" | "unbounded";
}

/** Whether this action can create standing, and who may ask it to. */
export interface AuthorityContract {
  /**
   * True when only Governor itself may invoke the action. Every action whose
   * `changeClasses` include `authority` must set this — that pairing is what
   * makes "Governor alone may admit or advance standing" checkable rather than
   * merely stated.
   */
  governorOnly: boolean;
  /** Whether a mandate could ever admit this action's results automatically.
   * `never` is the correct value for every action until WP10 promotes a named
   * transformation on live evidence (D02, D14). */
  automaticAdmission: "never" | "mandate-required";
}

/** How the read boundary applies to this action. */
export interface ScopeContract {
  /** Argument names carrying a vault path. Drives the allowlist check. */
  argumentKeys: string[];
  /** Whether `uid:` addressing resolves in those arguments (the `<scheme>:` form is retired and refused). */
  resolvesAddresses: boolean;
  /** `filter-before-read` for anything that enumerates the vault; scope must
   * bound the iteration BEFORE content is read. */
  enumeration: "filter-before-read" | "not-applicable";
  /** What happens when a path scope is active and the action cannot be bounded
   * honestly: stay available, or refuse. */
  whenScoped: "available" | "refuse";
}

/** How durable the operation record itself is. Independent of observation
 * capture: a read may journal nothing while still returning a receipt. */
export interface RetentionContract {
  operation: "ephemeral" | "durable-for-mutation" | "durable";
}

/**
 * A registered action.
 *
 * The field set is the subset of docs/action-registry.md's table that Gate 0
 * can state HONESTLY for every existing surface. Richer fields — planner,
 * executor, verification, concurrency, receipt, errors, recovery, dependencies,
 * degraded, docs, tests — are added by the work package that first implements
 * them, and are deliberately absent here rather than stubbed: a field present
 * but empty reads as "declared and satisfied", which is the drift this whole
 * registry exists to prevent.
 */
export interface ActionDefinition {
  /** Stable dotted identity, e.g. `note.append`. Never reused for new meaning. */
  id: string;
  /** Contract version. Incompatible semantic change mints a new version; a
   * version is never redefined in place. */
  version: number;
  title: string;
  /** ONE bounded statement of what becomes true. Not a description of the
   * handler. */
  postcondition: string;
  /** Kernel or module responsible for implementation and migration. */
  owner: string;
  distribution: Distribution;
  modes: OperationMode[];
  changeClasses: ChangeClass[];
  observations: ObservationContract;
  effects: EffectContract;
  authority: AuthorityContract;
  scope: ScopeContract;
  retention: RetentionContract;
  /** Declared input names. Used by the reserved-identity check; the full
   * versioned input SCHEMA stays with the surface until actions are native. */
  inputs: string[];
  /**
   * `true` when the action's contract was authored against this registry.
   * `false` marks a COMPATIBILITY action derived from an existing registration
   * by the adapter — its claims are conservative by construction and it may
   * never assert replayability, observed effects, mandate eligibility, or
   * verified admission (D18).
   */
  native: boolean;
  /** Why a non-native action exists, and what it was derived from. Present
   * only on compatibility actions. */
  compatibility?: { derivedFrom: string; reason: string };
  /** Replacement action id, or an explicit retirement rationale. */
  deprecatedBy?: string;
}

/** `id@version` — the registry's primary key. */
export function actionKey(id: string, version: number): string {
  return `${id}@${version}`;
}
