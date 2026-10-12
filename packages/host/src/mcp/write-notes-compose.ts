// Pure composition + stamping logic for obsidian_write_notes (slice B1).
//
// Obsidian-free by construction: everything here operates on plain objects and
// injected functions (`mintUid`, `formatTs`, `stringifyYaml`), so the whole
// stamp/accept-forbidden/canonical-order surface is unit-testable headlessly,
// exactly like the rest of the kernel-adjacent logic. The one Obsidian-touching
// concern — reading a note's existing frontmatter from the metadata cache and
// serializing YAML — is injected by tools-write-notes.ts.
//
// ── The invariants this file is the point of ─────────────────────────────────
//
//  1. `stamp` NEVER writes acceptance. It adds NO `acceptance-status` of its own
//     (#519: the vault retired the key; a note is confirmed by a `verified` entry
//     only Nelson writes), and it NEVER mints or elevates to `accepted`. An existing acceptance-status
//     on disk is PRESERVED verbatim (including a human-granted `accepted`) —
//     changing it would destroy the human's decision, which the invariant equally
//     forbids ("never change an existing acceptance-status value"). The only way
//     `accepted` reaches disk through this tool is if it was already there; a
//     caller can never inject it (invariant 2).
//
//  2. Accept-forbidden guard (stamped or not): a payload whose frontmatter sets
//     `acceptance-status: accepted` (or an `accepted-*` variant) or carries any
//     `accepted` / `accepted-by` / `accepted-on` field is REJECTED before any
//     write. The transport must never persist acceptance — this defends the
//     "the accept verb goes in no API" scar at the write path.
//
//  3. `stamp` is opt-in per call — the caller passes it; nothing here turns it
//     on. A uid on a template merge-payload mass-corrupts instance uids, so a
//     write that must not be stamped simply omits the flag.

// ── the accept-forbidden guard, over RESULTING vs on-disk frontmatter ─────────
//
// The scar is "the accept verb is in no API": no MCP write may INTRODUCE or
// CHANGE a note's acceptance to the accepted-family. ONE definition, in
// packages/core/src/accept-guard.ts (issue #104) — packages/core has no
// dependency on the host package, so core is the correct home for the single
// definition and this module imports it, never the other way around. This
// also carries PR #129's fix (#126): `stripLeadingBom` + the BOM-free
// `LEADING_FRONTMATTER_RE` are the ONE recognizer of a note's leading
// frontmatter fence, so a guard can never again be narrower than what the
// write path (and Obsidian) actually honors. Re-exported here unchanged so
// every existing import of this module (obsidian-backend.ts, tools-cli.ts,
// tests/accept-fence-parity.test.mjs) keeps working without a call-site
// change.
import {
  AcceptForbiddenError,
  acceptTransitionReason,
  acceptForbiddenReason,
  isVerifiedKey,
  isBlankVerification,
  frontmatterOf,
  stripLeadingBom,
  LEADING_FRONTMATTER_RE,
  renderNoteWithFrontmatter,
} from "@vault-mcp/core";
export { AcceptForbiddenError, acceptTransitionReason, acceptForbiddenReason, frontmatterOf, stripLeadingBom, LEADING_FRONTMATTER_RE };

// ── canonical frontmatter field order ────────────────────────────────────────
//
// name/title, uid, created, modified, then everything else in its existing
// order, with acceptance-status pinned LAST — matching the vault's own
// convention (see any stamped note's frontmatter). This makes the SERVER the
// single owner of field order, so every agent stops reimplementing it.
const CANONICAL_HEAD = ["name", "title", "uid", "created", "modified"];
const CANONICAL_TAIL = ["acceptance-status"];

/** Reorder a frontmatter object into canonical field order; object identity of values is preserved. */
export function canonicalOrder(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const head = new Set(CANONICAL_HEAD);
  const tail = new Set(CANONICAL_TAIL);
  for (const k of CANONICAL_HEAD) if (k in fm) out[k] = fm[k];
  for (const k of Object.keys(fm)) if (!head.has(k) && !tail.has(k)) out[k] = fm[k];
  for (const k of CANONICAL_TAIL) if (k in fm) out[k] = fm[k];
  return out;
}

// ── UUIDv7 ────────────────────────────────────────────────────────────────────
//
// Promoted into @vault-mcp/core (S3, condition 9); re-exported so existing
// importers keep working. For note uids the timestamp is seeded from the
// note's `created`, so a uid minted for an old note sorts by when the note
// was authored, not when it was stamped.
export { uuidv7 } from "@vault-mcp/core";

// ── local timestamp formatting ────────────────────────────────────────────────
//
// `YYYY-MM-DDTHH:mm:ss`, local time, no zone suffix — matching the vault's
// visible convention (Templater/Obsidian defaults). Injected into compose so a
// test can pin the value; production uses this.
export function formatLocalTimestamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface ComposeArgs {
  /** The caller's frontmatter payload for this note (may be omitted). */
  frontmatter?: Record<string, unknown>;
  /** The markdown body below the frontmatter. */
  body: string;
  /** Opt-in server-side stamping. Never automatic. */
  stamp: boolean;
  /** The note's existing on-disk frontmatter (from the metadata cache), for stamp preservation. */
  existing?: Record<string, unknown> | null;
  /** Wall-clock now, ms — `modified` and any defaulted `created` derive from it. */
  now: number;
  /** Mint a uid seeded from a created-timestamp (ms). Injected; production = uuidv7. */
  mintUid: (createdMs: number) => string;
  /** Format an ms timestamp for frontmatter. Injected; production = formatLocalTimestamp. */
  formatTs: (ms: number) => string;
  /** Serialize a frontmatter object to YAML (trailing newline). Injected; production = obsidian.stringifyYaml. */
  stringifyYaml: (obj: Record<string, unknown>) => string;
  /**
   * Parse a YAML frontmatter block — production = obsidian.parseYaml. Used ONLY
   * to read a body-embedded leading `---` fence for the accept-forbidden guard
   * (the stamp:false injection path). Optional: when absent, a body that carries
   * its own frontmatter is not parsed here — the shared backend write primitive
   * re-checks the final content with a real parser regardless, so the guarantee
   * does not rest on this seam being wired.
   */
  parseYaml?: (yaml: string) => unknown;
}

export interface ComposeResult {
  content: string;
  /** The final frontmatter that was written — for the per-item report. */
  frontmatter: Record<string, unknown>;
  /** True when stamping actually ran (i.e. args.stamp). */
  stamped: boolean;
}

/** Parse a `created` value to ms for the uid seed; fall back to `now` when it is missing or unparseable. */
function seedMs(created: unknown, now: number): number {
  if (typeof created === "string") {
    const p = Date.parse(created);
    if (!Number.isNaN(p)) return p;
  } else if (typeof created === "number" && Number.isFinite(created)) {
    return created;
  }
  return now;
}

/**
 * Compose the final note text for one write item.
 *
 * Throws AcceptForbiddenError (invariant 2) when the note that WOULD LAND ON DISK
 * introduces or changes acceptance to the accepted-family — checked over the
 * resulting frontmatter (a body-embedded leading fence included, so the
 * stamp:false injection path is caught) against the note's existing on-disk
 * frontmatter, so preserving a human-granted `accepted` verbatim is allowed.
 *
 * Under `stamp`, fills uid (uuidv7, created-seeded, only when absent — an
 * existing on-disk uid always wins so it is NEVER overwritten), `created` (when
 * missing) and `modified` (always now), carries an existing on-disk
 * `acceptance-status` forward when the payload is silent (it never adds one,
 * #519), and enforces canonical field order. Without `stamp`, the note is written verbatim from the payload.
 */
export function composeNote(args: ComposeArgs): ComposeResult {
  const payload: Record<string, unknown> = { ...(args.frontmatter ?? {}) };

  let structuredFm: Record<string, unknown>;
  let content: string;
  let stamped: boolean;

  if (!args.stamp) {
    structuredFm = payload;
    content = renderNote(payload, args.body, args.stringifyYaml);
    stamped = false;
  } else {
    const existing = args.existing ?? {};
    const merged: Record<string, unknown> = { ...payload };

    // created: keep payload's, else preserve existing, else default to now.
    const created = merged.created ?? existing.created ?? args.formatTs(args.now);
    merged.created = created;

    // modified: always now.
    merged.modified = args.formatTs(args.now);

    // uid: never overwrite an existing uid — the on-disk uid wins, then the
    // payload's, then a fresh created-seeded uuidv7. Minted only when truly absent.
    const existingUid = typeof existing.uid === "string" && existing.uid ? existing.uid : undefined;
    const payloadUid = typeof merged.uid === "string" && merged.uid ? (merged.uid as string) : undefined;
    merged.uid = existingUid ?? payloadUid ?? args.mintUid(seedMs(created, args.now));

    // acceptance-status: payload's value, else preserve the existing on-disk
    // value VERBATIM (never changed — including a human-granted `accepted`),
    // else NOTHING: stamp never adds the key (#519; it is retired, and a note is
    // confirmed by a `verified` entry only Nelson writes). The accept-forbidden
    // guard below rejects an accepted value the payload introduces; a preserved
    // existing one is allowed.
    //
    // DEMOTION RULE — when the payload is silent (as it is on every ordinary
    // stamped write that isn't itself editing acceptance), stamping must never
    // invent a change to acceptance-status: preserve-existing, not refuse-typed
    // or default-away. This is the ONLY correct reading here because `existing`
    // must be keyed on the note's real on-disk path for it to mean anything —
    // an `existing` that is empty because the caller addressed the note by
    // `uid:`/`jd:` and the lookup missed the resolved path is NOT "no existing
    // acceptance-status", it is a wrong answer, and defaulting to `proposed` in
    // that case silently demotes a human's `accepted` (the bug this guards
    // against — see tools-write-notes.ts's resolveTarget wiring). This matches
    // the SHARED accept-guard convention `acceptTransitionReason` implements
    // (also `obsidian_write_note`/`obsidian_manage_frontmatter`/`obsidian_patch_note`
    // via ObsidianBackend's guardWrittenContent/guardResultingFrontmatter): a
    // TYPED, explicit acceptance-status value in the payload — proposed,
    // rejected, anything non-accepted — is always honored as the caller's own
    // edit and is never itself refused (acceptTransitionReason only blocks
    // introducing or changing INTO the accepted family); it is only stamp's own
    // SILENT default-filling, when the payload says nothing at all, that must
    // preserve rather than invent.
    if (!("acceptance-status" in merged) && "acceptance-status" in existing) {
      merged["acceptance-status"] = existing["acceptance-status"];
    }

    // verified (#406): the payload's value, else preserve a FILLED existing
    // record VERBATIM — the shared guard refuses its removal, so a stamped
    // rewrite that is silent on it (every ordinary write) must carry it
    // forward or be refused. A BLANK existing one is dropped: an agent may
    // remove a blank `verified`, never a record, and carrying the blank forward
    // would be refused. The recognizers are core's, never a local copy.
    for (const k of Object.keys(existing)) {
      if (!isVerifiedKey(k) || k in merged || isBlankVerification(existing[k])) continue;
      merged[k] = existing[k];
    }

    structuredFm = canonicalOrder(merged);
    content = renderNote(structuredFm, args.body, args.stringifyYaml);
    stamped = true;
  }

  // Invariant 2 — accept-forbidden guard over the note that WOULD LAND ON DISK.
  // The resulting frontmatter is the structured block when there is one; when
  // there is none, the body's own leading `---` fence becomes the note's real
  // frontmatter (the stamp:false body-injection path), so it is parsed and
  // checked too. Rejection is a TRANSITION: introducing or changing acceptance
  // to the accepted-family is blocked, preserving an existing value verbatim
  // (compared against args.existing) is allowed.
  const resultingFm =
    Object.keys(structuredFm).length > 0
      ? structuredFm
      : frontmatterOf(args.body, args.parseYaml ?? (() => null)) ?? {};
  const reason = acceptTransitionReason(args.existing ?? null, resultingFm);
  if (reason) throw new AcceptForbiddenError(reason);

  return { content, frontmatter: structuredFm, stamped };
}

/** `---\n<yaml>---\n<body>`, or just the body when there is no frontmatter. */
// One definition in core, shared with obsidian_write_note's `frontmatter` (#500).
const renderNote = renderNoteWithFrontmatter;
