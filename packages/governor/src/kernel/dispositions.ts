// ============================================================================
//  DISPOSITIONS AS DATA — the acceptance instance's declared disposition set
//  (#101, phase 1 of #221)
// ----------------------------------------------------------------------------
//  Every verb the governance surface offers is DECLARED here as a descriptor:
//  `{ id, authority, surface, label, effect, … }`. The pane renders its human
//  controls from this set (membership, order, labels) and the one agent verb's
//  tool name is derived from it — so "what dispositions exist, and who may
//  exercise each" is a reviewable data table, not knowledge scattered across
//  button-creation call sites.
//
//  THE AUTHORITY AXIS (#221): a disposition that confers standing — that decides
//  what enters or leaves the accepted knowledge base — is `authority: "human"`
//  and exists ONLY as a gesture-gated pane control (addEventListener +
//  isRealGesture; see gesture.ts and governor/wiring/pane.ts). A mechanical,
//  reversible write that merely SUPPLIES a candidate is `authority: "agent"`
//  and exists ONLY as an ordinary guarded MCP tool. Nothing here changes the
//  gating: descriptors are DATA. Deliberately:
//
//    - NO callable rides a descriptor. `effect` is a documentation string, not
//      a function — an accept-capable callable on module-exported data would be
//      exactly the app-walkable accept gadget the reachability invariant
//      (governor/wiring/wiring.ts header) forbids.
//    - NO registry / plugin API for third-party dispositions. The set below is
//      frozen; extending it is a reviewed code change, same as
//      AUTHORIZED_CLASSES (auto-accept/classes.ts).
//
//  Obsidian-free, pure data — headless-testable (tests/governance-
//  dispositions.test.mjs pins completeness + authority classes).
//
//  The GENERIC descriptor shape was extracted to the disposition substrate
//  (#221 phase 2) and, at the suite split's S3 (condition 9), published to
//  `@vault-mcp/core` — the provider must not depend on the triage instance,
//  which was destined to become its own satellite plugin and DID at S5
//  (`packages/triage`, id `vaultmcp-triage`). The foresight paid off exactly as
//  intended: triage left the host without this file changing a line of code,
//  because both instances already declared against a published shape rather
//  than against each other. This file keeps the
//  ACCEPTANCE-SPECIFIC halves — the closed id/surface unions, the frozen
//  seven-verb table, and the accept-effect display text — and its exports
//  are unchanged (same names, same shapes, same behavior). The substrate
//  types are referenced through inline `import(…)` TYPE positions only,
//  deliberately: this file stays a pure-data LEAF with no import statement
//  and no runtime module edge (the governance tripwire pins that), so the
//  shared shape binds at compile time while reachability is exactly what it
//  was. The substrate's generic helpers are equivalent to the one-line
//  filters below; that equivalence is pinned by test in
//  tests/governance-dispositions.test.mjs. (The triage instance uses the
//  shared helpers too, and pins the same equivalence for its own table in
//  packages/triage — one shape, two suites, no shared build.)
// ============================================================================

export type DispositionId =
  | "accept"
  | "revert"
  | "adopt"
  | "request-changes"
  | "withdraw"
  | "submit-revision"
  | "skip";

/** Re-exported from the substrate (type-position reference only — see the
 * header comment for why this file carries no import statement). */
export type DispositionAuthority = import("@vault-mcp/core").DispositionAuthority;

/** Where a disposition surfaces. */
export type DispositionSurface =
  /** A button on a pending item's detail view (per-note). */
  | "pending-item"
  /** A control on the queue header (whole-queue). */
  | "queue"
  /** A button on a Revising-section row (per-note). */
  | "revising-item"
  /** An MCP tool — the ONE agent-expressible disposition. */
  | "mcp-tool"
  /** Stateless navigation (skip/back) — mutates nothing. */
  | "navigation";

/** The acceptance instance's descriptor: the substrate shape closed over this
 * instance's own id/surface unions (adopt is the one `confirm` verb,
 * request-changes the one `input` verb, skip the one `stateless` verb). */
export type DispositionDescriptor = import("@vault-mcp/core").DispositionDescriptorShape<
  DispositionId,
  DispositionSurface
>;

/** The agent-facing revision tool's name — derived from the one `authority: "agent"` descriptor. */
export const SUBMIT_REVISION_TOOL = "governance_submit_revision";

/**
 * The acceptance instance's full disposition set (#101's authority table).
 * Frozen: the pane renders FROM this; nothing may add to it at runtime.
 */
export const DISPOSITIONS: ReadonlyArray<DispositionDescriptor> = Object.freeze([
  Object.freeze({
    id: "accept",
    authority: "human",
    surface: "pending-item",
    label: "Accept",
    effect:
      "advance this note's baseline to its current content. The note itself is never edited: Accept writes " +
      "no acceptance-status, accepted-by or accepted-on (those keys are retired; only a `verified` entry " +
      "confirms a note, and only Nelson writes it)",
  } as const),
  Object.freeze({
    id: "revert",
    authority: "human",
    surface: "pending-item",
    label: "Revert",
    effect: "restore the note to its accepted baseline; quarantine (never delete) the rejected version",
  } as const),
  Object.freeze({
    id: "request-changes",
    authority: "human",
    surface: "pending-item",
    label: "Request changes…",
    input: true,
    effect:
      "insert the feedback as a [!revision-request] callout below the note's H1 (writes no frontmatter)",
  } as const),
  Object.freeze({
    id: "adopt",
    authority: "human",
    surface: "queue",
    label: "Adopt baseline",
    confirm: true,
    effect: "snapshot ALL current content as the reviewed baseline and clear the queue (mass-silence)",
  } as const),
  Object.freeze({
    id: "withdraw",
    authority: "human",
    surface: "revising-item",
    label: "Withdraw",
    effect: "remove the [!revision-request] callout(s) this pane inserted (writes no frontmatter)",
  } as const),
  Object.freeze({
    id: "submit-revision",
    authority: "agent",
    surface: "mcp-tool",
    label: SUBMIT_REVISION_TOOL,
    effect:
      "a revising agent resubmits: addressed [!revision-request] callouts removed (no frontmatter written), " +
      "optional [!revision-report] summary inserted — lands in the pending channel for human review",
  } as const),
  Object.freeze({
    id: "skip",
    authority: "human",
    surface: "navigation",
    label: "← Back to queue",
    stateless: true,
    effect: "rotate/deselect only — reads and writes nothing",
  } as const),
]);

/** The descriptors for one surface, in declared (render) order. */
export function dispositionsFor(surface: DispositionSurface): DispositionDescriptor[] {
  return DISPOSITIONS.filter((d) => d.surface === surface);
}

/** Lookup by id — undefined for an unknown id (the set is closed). */
export function dispositionById(id: DispositionId): DispositionDescriptor | undefined {
  return DISPOSITIONS.find((d) => d.id === id);
}

/**
 * The human dispositions that MUTATE state — exactly the set that must be
 * gesture-gated (addEventListener + isRealGesture, never `.onclick =`).
 * Stateless navigation (skip) is exempt; the one agent disposition is not a
 * pane control at all.
 */
export function gestureGatedDispositions(): DispositionDescriptor[] {
  return DISPOSITIONS.filter((d) => d.authority === "human" && !d.stateless);
}

/**
 * The Accept button's effect text, surfaced on the button (tooltip/aria) so the human sees what
 * the click will do before it. Pure display string — no callable, no capability; still exactly
 * one click. Accept never edits the note, whatever its status.
 */
export function acceptEffectFor(): string {
  return "Accept: advances the baseline only — the note itself is not edited";
}
