// ============================================================================
//  THE HARD SECURITY INVARIANT  (read before touching this file)
// ----------------------------------------------------------------------------
//  Ported from obsidian-stewardship/src/accept.ts as part of the governance
//  (Acceptance) module fold (#83, cycle 2). Obsidian-free by construction, so it is
//  headless-testable exactly as it was in Stewardship.
//
//  Accept, Revert AND Adopt-baseline are the powers that confer standing and
//  mutate the baseline (adopt mutates EVERY governed note's baseline at once —
//  it silences the whole queue). All three MUST only ever be reachable as DOM
//  click handlers on buttons (the review pane), each gated on `isRealGesture` so a
//  synthesized `.click()` cannot fire them, with adopt additionally behind a
//  human-confirmation modal. They must NOT be:
//    - registered as an Obsidian command (addCommand) — vault-mcp ships
//      `obsidian_run_command`, so any command is agent-invokable via
//      app.commands.executeCommandById(...). A command that reaches accept is a
//      self-approval primitive one prompt-injection away.
//    - exposed as a public plugin API method (plugin.api.accept = ...),
//    - registered as a URI handler (registerObsidianProtocolHandler),
//    - published as an MCP tool.
//
//  CLOSURE-CAPTURE REACHABILITY (the whole point).
//  TypeScript `private` is NOT runtime-private: a `private doAccept()` method is a
//  plain enumerable prototype method at runtime, so `app.plugins.plugins['vault-mcp']
//  .doAccept(path)` would work from ANY renderer-JS context (js-engine / execute-code
//  / meta-bind / quickadd all run arbitrary JS this vault loads). An agent can plant a
//  note via a normal MCP write whose embedded JS calls that method; if the human
//  renders it, it self-accepts — the exact "one prompt injection away from
//  self-approval" the design (Assent ch.5) forbids. Therefore accept/revert (and the
//  baseline-advance primitive, BaselineStore.setBaseline, which silences the queue and
//  is accept-equivalent) MUST NOT be reachable from any object a renderer-JS attacker
//  can walk from `app`:
//    - NO doAccept/doRevert/accept/revert/acceptDeps method or property on the
//      Plugin instance, its prototype, the ItemView instance, or anything stored on
//      app.workspace / a leaf / app.plugins.plugins['vault-mcp'].
//    - The BaselineStore lives in a module-scope WeakMap keyed by the plugin instance
//      (governor/wiring/wiring.ts `baselineStores`), NOT as `this.store`, so it is not an
//      enumerable own property of the plugin.
//    - accept/revert are performed by module-scope functions (governor/wiring/wiring.ts
//      performAccept/performRevert + these exported acceptNote/revertNote). The view
//      holds its deps in a module-scope WeakMap (governor/wiring/pane.ts `viewDeps`), never
//      as an instance field. The ONLY live reference to an accept-capable callable is
//      inside each pane button's addEventListener('click') closure, closed over the
//      specific already-displayed note row.
//  Net: the only way to accept is a real click on a real button in the pane.
//
//  This module therefore imports NOTHING from Obsidian and is never wired to a command.
//  It exports plain functions that the pane's button handlers call (through the
//  module-scope performAccept/performRevert closures) directly. The tripwire
//  (tests/governance-module.test.mjs, tests/governance-accept.test.mjs) enforces that no
//  command/enumerable/MCP path reaches them.
// ============================================================================

import { acceptanceStatusOf, missingRequiredKeys } from "./frontmatter.js";
import type { Baseline } from "./baseline-store.js";

export interface AcceptStore {
  get(path: string): Baseline | null;
  setBaseline(path: string, content: string, by: string, at?: string): Promise<Baseline>;
}

export interface StewardshipLogRecord {
  action: "accept" | "revert";
  path: string;
  ts: string;
  by: string;
  /** Written by builds before #599 only (they stamped the accepted family); never written now, still read from old log lines. */
  stamped?: boolean;
  quarantine?: string;
  hash?: string;
}

// D2 — a silent baseline advance (the human-edit classify path, or a self-baseline
// settle) mutates the baseline WITHOUT the human clicking Accept. Accept/revert already
// log; this record makes a silent advance auditable after the fact so nothing mutates the
// baseline off-audit. Appended to the same acceptance-log.jsonl.
export interface SilentAdvanceRecord {
  event: "silent-advance";
  ts: string;
  path: string;
  reason: "human-edit" | "self-baseline";
  fromHash: string | null; // prior baseline hash, or null if there was no baseline
  toHash: string;          // hash the baseline advanced to
  /** The D12 origin record backing this advance (WP5). Optional: pre-WP5 log lines lack it. */
  origin?: { origin: string; confidence: string };
}

// #101 — the request-changes / withdraw human dispositions log to the SAME
// acceptance-log.jsonl (uniform audit records for every disposition). Pure
// record shape only: the actions live in governor/wiring/wiring.ts as module-scope
// functions reached solely from gesture-gated pane handlers. Neither advances
// a baseline — they write the agent-legal `revising`/`proposed` transitions —
// but both confer standing ("a human asked for changes"), so they are audited.
export interface RevisionDispositionRecord {
  action: "request-changes" | "withdraw-request";
  path: string;
  ts: string;
  by: string;
}

// #284/#306 — a baseline RE-KEY: the note moved, so its acceptance was re-addressed to
// follow it. This advances nothing — `content`, `hash`, `acceptedAt`, `acceptedBy` cross
// verbatim — but the acceptance perimeter's own evidence store is being rewritten, and a
// repair that hides itself is indistinguishable from tampering. `hash` is recorded
// precisely so a reader can confirm it did NOT change.
export interface BaselineRekeyRecord {
  event: "baseline-rekey";
  ts: string;
  /** The path the baseline is keyed at now (so `path` means the same thing in every record). */
  path: string;
  from: string;
  to: string;
  /** The note identity the move was resolved on; null for the rename-event path, which
   * follows Obsidian's own move rather than matching on uid. */
  uid: string | null;
  /** Unchanged by the move, by construction. Present so an auditor can verify that. */
  hash: string;
  /** Which half moved it: the observed rename, or the startup repair of drift nobody saw. */
  reason: "rename" | "reconcile";
}

export type LogRecord =
  | StewardshipLogRecord
  | SilentAdvanceRecord
  | RevisionDispositionRecord
  | BaselineRekeyRecord;

// Pure builder for the silent-advance audit record (kept pure so it is headless-testable
// and reused verbatim by wiring.ts's reconcile path).
export function silentAdvanceRecord(args: {
  ts: string;
  path: string;
  reason: SilentAdvanceRecord["reason"];
  fromHash: string | null;
  toHash: string;
  origin?: { origin: string; confidence: string };
}): SilentAdvanceRecord {
  return {
    event: "silent-advance",
    ts: args.ts,
    path: args.path,
    reason: args.reason,
    fromHash: args.fromHash,
    toHash: args.toHash,
    ...(args.origin ? { origin: args.origin } : {}),
  };
}

/** Pure builder for the baseline-rekey audit record. Kept pure for the same reason
 * `silentAdvanceRecord` is: the shape is the audit contract, and it is asserted headlessly. */
export function baselineRekeyRecord(args: {
  ts: string;
  from: string;
  to: string;
  uid: string | null;
  hash: string;
  reason: BaselineRekeyRecord["reason"];
}): BaselineRekeyRecord {
  return {
    event: "baseline-rekey",
    ts: args.ts,
    path: args.to,
    from: args.from,
    to: args.to,
    uid: args.uid,
    hash: args.hash,
    reason: args.reason,
  };
}

export interface AcceptDeps {
  readNote(path: string): Promise<string>;
  // Link-safe write of full content (vault.process in production).
  writeNote(path: string, content: string): Promise<void>;
  store: AcceptStore;
  // Move `content` into the quarantine store; returns the quarantine file path. NEVER deletes.
  quarantine(path: string, content: string): Promise<string>;
  appendLog(record: StewardshipLogRecord): Promise<void>;
  now(): string;      // ISO timestamp (UTC) — log records + baseline acceptedAt
  user: string;       // the identity recorded on the baseline and the accept log (governance config `acceptedBy`)
  /** The conformance gate (#221/#164): frontmatter keys that must be present and non-empty
   * before a `proposed` note may be accepted. EMPTY (the default) ⇒ no gate. This is where
   * the legacy QuickAdd accept-macro's vault-specific checks (uid, title, description) live
   * now — as per-vault CONFIG, never hardcoded in the plugin. */
  requiredFrontmatterKeys: string[];
}

export interface AcceptResult { baseline: Baseline; }
export interface RevertResult { quarantine: string; restoredHash: string; }

/** The conformance-gate refusal: a `proposed` note is missing required frontmatter. Thrown
 * BEFORE any write — no baseline advance, no log record (nothing happened). */
export class AcceptGateError extends Error {
  constructor(public readonly missing: string[]) {
    super(`accept refused — required frontmatter missing or empty: ${missing.join(", ")}`);
    this.name = "AcceptGateError";
  }
}

// ACCEPT — baseline advance only. Accept never edits the note: it does not write
// `acceptance-status`, `accepted-by` or `accepted-on` (the retired accept keys; Nelson's ruling
// of 2026-10-20, #599). What confirms a note is a `verified` entry that only Nelson writes, and
// this plugin never writes one.
//
//   acceptance-status: proposed  ⇒ conformance-gate check first (refuse BEFORE any write), then
//                                  advance the baseline;
//   anything else                ⇒ advance the baseline.
//
// The note is byte-untouched in every case. The identity the baseline and the accept log carry
// is `deps.user` (governance config `acceptedBy`); it labels the log, it is not written to the
// note.
/** Options for a single accept call. `gateOverride` skips the conformance gate for THIS call
 * only — reachable solely from the pane's gate modal ("Accept anyway"), i.e. a second explicit
 * human gesture after the gate named what is missing. It can never be supplied by an agent:
 * no transport reaches accept at all. */
export interface AcceptOpts { gateOverride?: boolean; }

export async function acceptNote(deps: AcceptDeps, path: string, opts?: AcceptOpts): Promise<AcceptResult> {
  const pre = await deps.readNote(path);

  if (acceptanceStatusOf(pre) === "proposed" && !opts?.gateOverride) {
    // Conformance gate — refuse BEFORE any write, unless the human explicitly overrode it via
    // the pane's gate modal ("Accept anyway" — a second real gesture). The refusal carries the
    // missing keys so the modal can name them.
    const missing = missingRequiredKeys(pre, deps.requiredFrontmatterKeys);
    if (missing.length > 0) throw new AcceptGateError(missing);
  }

  const baseline = await deps.store.setBaseline(path, pre, deps.user, deps.now());
  await deps.appendLog({
    action: "accept",
    path,
    ts: deps.now(),
    by: deps.user,
    hash: baseline.hash,
  });
  return { baseline };
}

// REVERT — restore the note to its accepted baseline and quarantine the rejected current
// version. NEVER deletes: the rejected content is preserved under the quarantine store.
export async function revertNote(deps: AcceptDeps, path: string): Promise<RevertResult> {
  const baseline = deps.store.get(path);
  if (!baseline) throw new Error(`Governance: no baseline to revert to for ${path}`);

  const current = await deps.readNote(path);
  const quarantine = await deps.quarantine(path, current);
  await deps.writeNote(path, baseline.content);

  await deps.appendLog({
    action: "revert",
    path,
    ts: deps.now(),
    by: deps.user,
    quarantine,
  });
  return { quarantine, restoredHash: baseline.hash };
}
