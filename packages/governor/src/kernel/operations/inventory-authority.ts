// The declared AUTHORITY SURFACE INVENTORY — Gate 0, WP0, provider half.
//
// This is the half of the old `inventory-non-mcp.ts` that declares the ACCEPT
// PERIMETER. It moved here at S3c, when the old `packages/plugin` became
// `packages/host` plus `packages/governor` and the functions this file
// describes stopped being host source: they live in `src/wiring/wiring.ts` of
// THIS package now, so a file in the host that claimed to describe them was
// describing a tree the host no longer has.
//
// What the move cost, said plainly: the old file could compute one registry
// over commands, automation and authority together, and one test could assert
// that the whole non-MCP surface validated as a set. That set is now two sets
// in two packages, and nothing checks them jointly at runtime — the joint
// claim survives only because the provider's test imports the host's registry
// and its MCP inventory across the package boundary and re-asserts the
// cross-package parts there. When the two packages stop sharing a worktree,
// that import is the thing that breaks, and the claims it carries are the ones
// that will need republishing as contracts.
//
// Three kinds of door are declared here, the same three the combined inventory
// named:
//
//   ui          a review-pane control or a settings button — something a human
//               clicks
//   automation  a vault or metadata event subscription, or the journal poll —
//               work that starts with no caller at all
//   internal    a Governor-to-Governor call
//
// The AUTHORITY rows are the point of the exercise. They are the only actions
// in this suite declared `governorOnly` with the `authority` change class, and
// the host's `registry.ts` refuses at build time to bind any of them to an
// `mcp` or `external` surface. That is the static counterpart to the two
// runtime controls the pane already enforces: every capability-bearing control
// is wired with `addEventListener` rather than `.onclick =` (so the function is
// not a reachable property), and every handler calls `isRealGesture(evt)`,
// which requires a genuine `Event` with `isTrusted === true`.
//
// Two structural facts this inventory depends on are asserted by its test
// rather than assumed, because both are load-bearing and neither was checked
// by anything before:
//
//   • `src/wiring/` registers ZERO Obsidian commands. Every command is
//     agent-invocable through `obsidian_run_command`'s `executeCommandById`,
//     so an accept command would be a self-approval primitive one
//     prompt-injection away. Note what the split did to this one: the host's
//     scanner filtered its own tree for `src/governor/wiring/`, a prefix that
//     no longer exists there, so after the move it matched nothing and passed
//     for the wrong reason. An emptiness claim that cannot fail is not a
//     claim, so the scan now runs over THIS package's tree and its test plants
//     a command inside `src/wiring/` to prove the scan still sees one.
//   • none of the ten accept-perimeter functions is exported, and the file's
//     export set is pinned. Export is what would make one reachable from a
//     plugin instance, a view instance, or any other object an agent-facing
//     path can obtain — and pinning the whole set closes the class rather than
//     the ten instances.
//
// WHY THIS FILE REACHES INTO `packages/host/src` RATHER THAN A PUBLISHED
// CONTRACT. S3c's rule for a provider→host dependency is `@vault-mcp/core`'s
// `action-contract.ts`: publish the part two plugins must agree on
// BYTE-FOR-BYTE, because a second copy of it would be a correctness bug —
// `CHANGE_CLASSES` (whose order feeds subject hashing) and `NOTE_WRITE_ACTION`
// (whose identity the write observer matches on) qualify, and were published.
//
// `ActionDefinition`, `compatibilityAction` and `SurfaceBinding` do not, and
// publishing them to satisfy this file would drag most of the registry's
// vocabulary into a shared package to serve a declaration that no shipped code
// path reads. This file is imported by its test and by nothing under `src/`,
// exactly like the host's `inventory-non-mcp.ts` — so the crossing costs the
// built plugin nothing, and a relative path that a reader can follow is a
// smaller lie than a "contract" invented for one importer. It becomes a real
// work item the day the two packages stop sharing a worktree, and the honest
// statement until then is that this is a test-time dependency on host source.

import type { ActionDefinition, Distribution, SurfaceKind } from "../../../../host/src/kernel/operations/action.js";
import { compatibilityAction } from "../../../../host/src/kernel/operations/compatibility.js";
import type { SurfaceBinding } from "../../../../host/src/kernel/operations/surface-binding.js";

// ── the accept perimeter ─────────────────────────────────────────────────────

/**
 * The module-scope functions in `wiring/wiring.ts` that can change authority
 * state. Named here so the test can assert they still exist and are still
 * unexported — an inventory that describes deleted code is worse than none,
 * and an exported one is a hole.
 *
 * `wiring.ts`'s own header gives the membership test: "A capability that
 * advances a baseline, accepts a change, adopts a baseline, or flips an
 * auto-accept class is accept-equivalent: it silences the review queue."
 * Applied literally, that is every writer of `setBaseline`, `rekey` or the
 * auto-accept allowlist. There are ten.
 *
 * The first draft of this list had seven, and the three it missed are the
 * three with NO gesture anywhere:
 *
 *   maybeAutoAccept     advances a baseline for an allowlisted mechanical
 *                       class, driven by a 2.5s poll — no click, no
 *                       isRealGesture, nothing
 *   sweepAutoAccept     its driver, over the cached pending queue
 *   reconcileBaselines  re-addresses baselines whose notes moved while the
 *                       plugin was off
 *
 * Missing them is instructive rather than embarrassing: the gesture-gated
 * capabilities are easy to find because a human clicks them, and the ones that
 * run by themselves are exactly the ones an inventory built by reading the UI
 * will overlook.
 */
export const ACCEPT_PERIMETER_FUNCTIONS = [
  "performAccept",
  "performRevert",
  "performAdopt",
  "setClassEnabled",
  "performRequestChanges",
  "performWithdraw",
  "reconcile",
  "maybeAutoAccept",
  "sweepAutoAccept",
  "reconcileBaselines",
] as const;

/**
 * The exports of `wiring/wiring.ts`, pinned.
 *
 * Checking that the ten perimeter functions are unexported closes those ten
 * instances. Pinning the whole export set closes the CLASS: a new export is a
 * visible decision rather than something a reviewer has to notice.
 *
 * `nudgeGovernanceQueue` is exported deliberately and does reach the
 * auto-accept chain — but only by changing WHEN the poll runs, never what it
 * may accept. Eligibility is decided inside `maybeAutoAccept` by the
 * objective-bytes, allowlist and rail checks, which no caller can influence.
 */
export const WIRING_EXPORTS = [
  "GovernanceWireDeps",
  "isGovernanceMounted",
  "nudgeGovernanceQueue",
  "wireGovernance",
  "renderGovernanceSettings",
  // WP8 (each confirmed accept-closure-free): setLegacyWriteGuard REGISTERS a
  // boolean predicate (main.ts's cutover check) consulted by the BaselineStore
  // — it holds no accept callable. It is NOT monotone (a later call installing
  // () => true would re-enable legacy writes post-cutover); what protects it
  // is the module-privacy threat model — the WeakMap and this export are
  // unreachable from `app`, same as every accept-perimeter closure (review
  // finding: say the real reason, not a monotonicity the function lacks).
  // baselinesOf is a read-only view of the loaded baseline records for the
  // migration import (no store handle escapes).
  "setLegacyWriteGuard",
  "baselinesOf",
] as const;

export interface AuthorityRow {
  /** Surface identity — where the human gesture or automation lives. */
  id: string;
  kind: Extract<SurfaceKind, "ui" | "automation" | "internal">;
  /** Registered action id. */
  action: string;
  title: string;
  postcondition: string;
  /** The `wiring/wiring.ts` function this surface ultimately calls. */
  implementation: (typeof ACCEPT_PERIMETER_FUNCTIONS)[number];
  paths?: string[];
  /** Change classes beyond `authority`, when the act also alters content. */
  alsoChanges?: Array<"content" | "structural">;
  /** How reachability is restricted, in one phrase. */
  reachability: string;
}

/** The one file every authority surface's implementation lives in. */
export const WIRING_FILE = "src/wiring/wiring.ts";

export const AUTHORITY_SURFACES: AuthorityRow[] = [
  {
    id: "governance.pane.accept",
    kind: "ui",
    action: "governance.accept",
    title: "Accept a proposal",
    postcondition: "Stamp the accepted family on one note and advance its baseline to the exact reviewed content.",
    implementation: "performAccept",
    paths: ["path"],
    reachability: "pane detail-view and Proposed-section buttons, wired with addEventListener + isRealGesture",
  },
  {
    id: "governance.context-menu.accept",
    kind: "ui",
    action: "governance.accept",
    title: "Accept a proposal from the file menu",
    postcondition: "Open a confirmation modal whose own confirm button performs the accept.",
    implementation: "performAccept",
    paths: ["path"],
    // Obsidian renders file-menu items natively and delivers no trusted Event
    // to the menu callback, so `isRealGesture` there was permanently inert and
    // was removed. The menu item can therefore only OPEN a modal; the accept
    // happens from that modal's own click, which restores both gesture layers.
    // Worst case for a forged menu trigger is that a dialog appears.
    reachability: "menu item opens a ConfirmModal only; the write happens from the modal's gesture-gated confirm",
  },
  {
    id: "governance.pane.revert",
    kind: "ui",
    action: "governance.revert",
    title: "Revert to the admitted baseline",
    postcondition: "Restore one note's prior admitted content, creating new history rather than erasing the admission.",
    implementation: "performRevert",
    paths: ["path"],
    alsoChanges: ["content"],
    reachability: "pane detail-view button, addEventListener + isRealGesture",
  },
  {
    id: "governance.pane.adopt-baseline",
    kind: "ui",
    action: "governance.adopt-baseline",
    title: "Adopt current content as the baseline",
    postcondition: "Advance every pending note's baseline to its current content in one act.",
    implementation: "performAdopt",
    reachability: "pane button, addEventListener + isRealGesture + a confirm step",
  },
  {
    id: "governance.settings.adopt-baseline",
    kind: "ui",
    action: "governance.adopt-baseline",
    title: "Adopt current content as the baseline (settings tab)",
    postcondition: "The same mass advance, reached from the settings tab.",
    implementation: "performAdopt",
    reachability: "settings-tab button sharing the pane's wireAdoptButton, same two gesture layers",
  },
  {
    id: "governance.pane.auto-accept-class",
    kind: "ui",
    action: "governance.set-auto-accept-class",
    title: "Enable or disable an auto-accept class",
    postcondition: "Change which mechanical change classes Governor may admit without a further gesture.",
    implementation: "setClassEnabled",
    reachability: "pane allowlist checkboxes, addEventListener + isRealGesture",
  },
  {
    id: "governance.settings.auto-accept-class",
    kind: "ui",
    action: "governance.set-auto-accept-class",
    title: "Enable or disable an auto-accept class (settings tab)",
    postcondition: "The same policy change, reached from the settings tab.",
    implementation: "setClassEnabled",
    reachability: "settings-tab checkboxes sharing the pane's renderAllowlist",
  },
  {
    id: "governance.pane.request-changes",
    kind: "ui",
    action: "governance.request-changes",
    title: "Request changes on a proposal",
    postcondition: "Move a proposal to revising and record the human's feedback, conferring no standing.",
    implementation: "performRequestChanges",
    paths: ["path"],
    alsoChanges: ["content"],
    reachability: "pane button and modal, addEventListener + isRealGesture",
  },
  {
    id: "governance.pane.withdraw",
    kind: "ui",
    action: "governance.withdraw",
    title: "Withdraw a proposal",
    postcondition: "Remove a proposal from review without accepting it.",
    implementation: "performWithdraw",
    paths: ["path"],
    alsoChanges: ["content"],
    reachability: "pane button, addEventListener + isRealGesture",
  },
  {
    // The one baseline advance with NO click anywhere. It is gated instead on
    // a POSITIVE signal — `recentGenuineHumanInput`, derived from real
    // `beforeinput`/`paste` DOM events — which is exactly the
    // "local-human-observed" origin class: observed, not cryptographically
    // proven, and trusted within the documented same-user threat model.
    id: "governance.automation.reconcile-observed-edit",
    kind: "automation",
    action: "governance.reconcile-observed-human-edit",
    title: "Reconcile an observed human edit",
    postcondition:
      "Advance a note's baseline silently when the edit is attributable to recent genuine human input in the editor.",
    implementation: "reconcile",
    paths: ["path"],
    reachability: "vault 'modify' event, debounced; gated on recentGenuineHumanInput rather than on any gesture",
  },
  {
    // No gesture anywhere. Driven by the 2.5s journal poll and by
    // `nudgeGovernanceQueue` after every journal append.
    id: "governance.automation.auto-accept-sweep",
    kind: "automation",
    action: "governance.auto-accept",
    title: "Auto-accept sweep",
    postcondition:
      "Advance the baseline of every pending note whose diff is confined to an enabled mechanical change class.",
    // `maybeAutoAccept`, not `sweepAutoAccept`: the sweep is only the driver
    // that walks the pending queue, and the act — the baseline advance and its
    // audit record — happens one level down. Attributing the row to the driver
    // made the audit claim come out wrong, which is how the distinction
    // surfaced.
    implementation: "maybeAutoAccept",
    reachability:
      "sweepAutoAccept over the cached pending queue, driven by the journal poll and the post-append nudge; safety comes from the objective-bytes comparison, the mechanical-class allowlist and the rail check inside maybeAutoAccept, NOT from a gesture",
  },
  {
    id: "governance.automation.rekey-on-rename",
    kind: "automation",
    action: "governance.rekey-baseline",
    title: "Follow a renamed note",
    postcondition: "Re-address a baseline when Governor witnesses the rename.",
    // The call is an inline closure inside the vault 'rename' handler rather
    // than a named function, so the perimeter entry it is attributed to is
    // `reconcileBaselines`, which owns the same rekey contract.
    implementation: "reconcileBaselines",
    paths: ["from", "to"],
    reachability: "vault 'rename' event; rekey carries acceptance across verbatim and never routes through setBaseline",
  },
  {
    id: "governance.automation.reconcile-baselines",
    kind: "automation",
    action: "governance.rekey-baseline",
    title: "Repair baselines orphaned while the plugin was off",
    postcondition:
      "Re-address baselines whose notes moved unwitnessed, matching on the uid inside the stored baseline content.",
    implementation: "reconcileBaselines",
    reachability: "one-shot metadataCache 'resolved' event at mount",
  },
];

interface AuthoritySpec {
  id: string;
  title: string;
  postcondition: string;
  paths: string[];
  alsoChanges?: Array<"content" | "structural">;
  /**
   * Whether this act reaches `appendLog` and therefore leaves a durable
   * operation record. VERIFIED against source by the test, not asserted here —
   * the previous draft claimed all seven were logged and two were not.
   */
  audited: boolean;
  /**
   * Targets found at runtime rather than received as arguments. `none` is only
   * correct for an act on one named note.
   */
  discovered: "none" | "bounded" | "unbounded";
}

/** One native authority action per distinct `action` id above. */
function authorityAction({
  id,
  title,
  postcondition,
  paths,
  alsoChanges = [],
  audited,
  discovered,
}: AuthoritySpec): ActionDefinition {
  return {
    id,
    version: 1,
    title,
    postcondition,
    owner: "acceptance",
    // Never public in the MCP sense — there is no client-facing door at all.
    // `private` here means "operator/human surface", not "operator pack".
    distribution: "private",
    modes: ["authority"],
    // Canonical order: content before authority.
    changeClasses: [...alsoChanges, "authority"],
    // Deliberately the weakest capture, and deliberately NOT `replayable`.
    //
    // The target contract says authority inputs are replayable — but no
    // observation substrate exists yet, so declaring `replayable` here would
    // assert a guarantee no code provides. Raised in WP2, when there is
    // something to raise it to.
    observations: { defaultCapture: "ephemeral", supportsProposal: false },
    effects: { direct: ["standing", "accepted-frontmatter", "baseline"], discovered },
    authority: { governorOnly: true, automaticAdmission: "never" },
    scope: {
      argumentKeys: paths,
      resolvesAddresses: false,
      enumeration: paths.length > 0 ? "not-applicable" : "filter-before-read",
      whenScoped: "available",
    },
    // `durable` ONLY where the act actually reaches `appendLog`. Two do not,
    // and saying otherwise would claim an audit trail that does not exist —
    // see the AUTHORITY_ACTIONS entries and the test that verifies each
    // `audited` flag against source.
    retention: { operation: audited ? "durable" : "ephemeral" },
    inputs: paths,
    // Authored against this registry rather than derived from a registration —
    // there IS no registration metadata to derive from, because the accept
    // path is deliberately a set of module-scope closures with no tool, no
    // command and no exported symbol.
    //
    // `native` means the CONTRACT was authored. It does NOT mean the action is
    // routed through the operation executor — nothing is, yet. WP1 does that.
    native: true,
  };
}

const AUTHORITY_ACTIONS: ActionDefinition[] = [
  authorityAction({
    id: "governance.accept",
    title: "Accept a proposal",
    postcondition: "Stamp the accepted family on one note and advance its baseline to the exact reviewed content.",
    paths: ["path"],
    audited: true, // reaches appendLog through acceptNote's injected deps
    discovered: "none",
  }),
  authorityAction({
    id: "governance.revert",
    title: "Revert to the admitted baseline",
    postcondition: "Restore one note's prior admitted content, creating new history rather than erasing the admission.",
    paths: ["path"],
    alsoChanges: ["content"],
    audited: true, // through revertNote
    discovered: "none",
  }),
  authorityAction({
    id: "governance.adopt-baseline",
    title: "Adopt current content as the baseline",
    postcondition: "Advance every governed note's baseline to its current content in one act.",
    paths: [],
    // NOT audited. `performAdopt` loops over `governedMarkdownFiles(plugin)`
    // calling `setBaseline` and never reaches `appendLog` — so the single most
    // consequential capability in the product, the one its own source calls
    // "mass-silence", leaves NO operation record. That is a real gap in the
    // predecessor, surfaced by declaring it honestly rather than smoothed over
    // by a blanket `durable`. WP8's cutover is where it gets fixed; recording
    // it now is what makes it impossible to forget.
    audited: false,
    // It receives no path and discovers its entire target set at runtime —
    // every governed markdown file in the vault. This is the same shape as
    // `obsidian_repoint_link`, the case `action.ts` cites as the reason the
    // field exists.
    discovered: "unbounded",
  }),
  authorityAction({
    id: "governance.set-auto-accept-class",
    title: "Set an auto-accept class",
    postcondition: "Change which mechanical change classes Governor may admit without a further gesture.",
    paths: [],
    // NOT audited either: `setClassEnabled` writes the allowlist through
    // `saveAllowlist` and appends nothing. Changing what may be admitted
    // without review is a policy change with no record of who changed it.
    audited: false,
    discovered: "none",
  }),
  authorityAction({
    id: "governance.request-changes",
    title: "Request changes on a proposal",
    postcondition: "Move a proposal to revising and record the human's feedback, conferring no standing.",
    paths: ["path"],
    alsoChanges: ["content"],
    audited: true,
    discovered: "none",
  }),
  authorityAction({
    id: "governance.withdraw",
    title: "Withdraw a proposal",
    postcondition: "Remove a proposal from review without accepting it.",
    paths: ["path"],
    alsoChanges: ["content"],
    audited: true,
    discovered: "none",
  }),
  authorityAction({
    id: "governance.reconcile-observed-human-edit",
    title: "Reconcile an observed human edit",
    postcondition: "Advance a note's baseline silently when the edit is attributable to recent genuine human input in the editor.",
    paths: ["path"],
    audited: true,
    discovered: "none",
  }),
  authorityAction({
    // The eighth capability, and the one an inventory built by reading the UI
    // will miss: it advances a baseline with NO gesture anywhere, driven by a
    // 2.5s poll and by every journal append. Its safety comes from a different
    // place than the pane's — the objective-bytes comparison, the mechanical-
    // class allowlist and the rail check inside `maybeAutoAccept` — not from
    // `isRealGesture`. Declaring it as its own authority action is what lets
    // the registry fence it at all; folded into a generic automation row, it
    // was classified as an ordinary non-authority mutation.
    id: "governance.auto-accept",
    title: "Auto-accept an allowlisted mechanical change",
    postcondition:
      "Advance a note's baseline without any gesture when its diff is confined to an enabled mechanical change class.",
    paths: ["path"],
    audited: true,
    // The sweep iterates the cached pending queue rather than a named target.
    discovered: "unbounded",
  }),
  authorityAction({
    // Re-addressing, NOT acceptance: `rekey` carries content, hash, acceptedAt
    // and acceptedBy across verbatim and deliberately does not route through
    // `setBaseline`, which would stamp a fresh acceptance nobody gave. It is
    // still an authority act, because it decides which note an existing
    // acceptance now applies to.
    id: "governance.rekey-baseline",
    title: "Re-address a baseline to follow its note",
    postcondition:
      "Move an existing baseline to a renamed note's path, carrying its acceptance across without stamping a new one.",
    paths: ["from", "to"],
    audited: true,
    discovered: "unbounded",
  }),
];

// ── the provider's own automation and internal surfaces ──────────────────────
//
// Two rows travelled with the perimeter because their FILE did, and leaving
// either behind would have left the host declaring a surface in a tree it does
// not contain.
//
//   • the governance event subscriptions and journal poll — the automation row
//     whose `touchesAuthority` claim is what the perimeter's automation
//     bindings back. It was the only row in the host's AUTOMATION_SURFACES
//     that ever claimed it, so the host's remaining rows are all `false` and
//     the host test now pins exactly that.
//   • the pending-index publisher — an INTERNAL surface, and the producer
//     behind an agent-visible read. It is not authority-bearing itself; it
//     moved because it lives in `wiring/wiring.ts` beside everything else here.
//
// Their shapes are declared locally rather than imported from the host's
// `AutomationRow` / `PlainSurfaceRow`. Those two interfaces describe the
// HOST's inventory, which now has different membership from this one, and a
// shared interface between two inventories that no longer agree is a coupling
// that buys nothing — six plain data fields is a cheaper duplication than a
// contract neither side owns.

export interface AuthorityAutomationRow {
  id: string;
  /** Package-relative file, checked against the scan. */
  file: string;
  title: string;
  postcondition: string;
  owner: string;
  /** True when this automation can change authority state with no gesture. */
  touchesAuthority: boolean;
}

export const AUTHORITY_AUTOMATION_SURFACES: AuthorityAutomationRow[] = [
  {
    id: "automation.governance.events",
    file: WIRING_FILE,
    title: "Governance event subscriptions and journal poll",
    postcondition:
      "Keep the review queue current from vault modify/rename/delete events, a 2.5s journal poll and a layout-ready paint.",
    owner: "acceptance",
    // The poll drives sweepAutoAccept -> maybeAutoAccept, which CAN advance a
    // baseline for an allowlisted mechanical class; the modify handler drives
    // reconcile, which can advance one silently. Both are authority-bearing.
    touchesAuthority: true,
  },
];

export interface AuthorityInternalRow {
  id: string;
  kind: Extract<SurfaceKind, "ui" | "automation" | "internal">;
  file: string;
  title: string;
  postcondition: string;
  owner: string;
  distribution: Distribution;
  readOnly: boolean;
  note?: string;
}

export const AUTHORITY_INTERNAL_SURFACES: AuthorityInternalRow[] = [
  {
    id: "internal.governance.publish-pending-index",
    kind: "internal",
    file: WIRING_FILE,
    title: "Publish the pending-review index",
    postcondition:
      "Write the review queue to pending-index.json so governance_pending_review can report it — or report it unavailable.",
    owner: "acceptance",
    distribution: "public-default",
    readOnly: false,
    note: "the producer behind the agent-visible read surface; absence must read as unavailable, never as an empty queue",
  },
];

// ── projections ──────────────────────────────────────────────────────────────
//
// The host's `nonMcpActions()` used to return commands, automation AND the
// authored authority actions in one list, so one registry validated the whole
// non-MCP surface. S3c splits that projection along the same line as the code:
// the host keeps `nonMcpActions()` over its commands and automation, and this
// is the provider's half. Each half behaves exactly as the combined one did
// for its own rows — the derived ids are byte-identical, including the
// double-prefixed `compat.automation.automation.governance.events`, which
// reads oddly and is kept because renaming a derived id to look tidier would
// silently retire the old one.

/** Every action the authority half declares: the authored perimeter contracts,
 * plus derived ones for the automation and internal surfaces that came with
 * it. */
export function authorityActions(): ActionDefinition[] {
  const automation = AUTHORITY_AUTOMATION_SURFACES.map((row) =>
    compatibilityAction({
      surface: `automation.${row.id}`,
      postcondition: row.postcondition,
      owner: row.owner,
      // Automation has no caller, so nothing about it is read-only in the
      // sense the guard means; it is declared mutating so it can never be
      // mistaken for a free operation.
      readOnly: false,
      distribution: "private",
      reason: "pre-registry automation entry point; runs with no caller",
    })
  );
  const internal = AUTHORITY_INTERNAL_SURFACES.map((row) =>
    compatibilityAction({
      surface: row.id,
      postcondition: row.postcondition,
      owner: row.owner,
      distribution: row.distribution,
      readOnly: row.readOnly,
      reason: `pre-registry ${row.kind} surface`,
    })
  );
  return [...AUTHORITY_ACTIONS, ...automation, ...internal];
}

export function authorityBindings(): SurfaceBinding[] {
  const authority: SurfaceBinding[] = AUTHORITY_SURFACES.map((row) => ({
    kind: row.kind,
    id: row.id,
    action: row.action,
    actionVersion: 1,
    source: WIRING_FILE,
    note: row.reachability,
  }));
  const automation: SurfaceBinding[] = AUTHORITY_AUTOMATION_SURFACES.map((row) => ({
    kind: "automation",
    id: row.id,
    action: `compat.automation.${row.id}`,
    actionVersion: 1,
    source: row.file,
  }));
  const internal: SurfaceBinding[] = AUTHORITY_INTERNAL_SURFACES.map((row) => ({
    kind: row.kind,
    id: row.id,
    action: `compat.${row.id}`,
    actionVersion: 1,
    source: row.file,
    ...(row.note ? { note: row.note } : {}),
  }));
  return [...authority, ...automation, ...internal];
}

/**
 * Functions that are the BODY of an already-declared action rather than doors
 * of their own. Listed so "why isn't this in the inventory?" has an answer that
 * is written down instead of remembered.
 *
 * All eight live in `wiring/wiring.ts`, so the whole list came here with the
 * perimeter — an exclusion list is only checkable next to the file it excludes
 * from.
 */
export const NOT_SURFACES = [
  { name: "buildAcceptDeps", partOf: "governance.accept" },
  { name: "appendLog", partOf: "every audited authority action" },
  { name: "saveAllowlist", partOf: "governance.set-auto-accept-class" },
  // Shared infrastructure, not one action's helper: `performAdopt` uses it,
  // and so do `refresh()` and `listRevising()`.
  { name: "governedMarkdownFiles", partOf: "shared queue and listing infrastructure" },
  { name: "scheduleReconcile", partOf: "governance.reconcile-observed-human-edit" },
  { name: "quarantineWrite", partOf: "governance.accept" },
  { name: "persistRenameRecords", partOf: "governance.rekey-baseline" },
] as const;
