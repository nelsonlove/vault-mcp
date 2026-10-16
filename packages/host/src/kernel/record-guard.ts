// The record-immutability guard (#264) — the durable, server-side half of the
// record-class write protection. A note the operator's record identifier marks
// (by default frontmatter `record: true`; a property/value or a tag, see
// `RecordIdentification` below) is a RECORD: historical, byte-verified, never
// edited in place. The convention
// for extending one is a dated END-OF-FILE append (a new `## YYYY-MM-DD …`
// section), so the one mutation a record admits is `obsidian_append_note`; every
// other mutating operation that names a record note refuses with
// `Error [record_immutable]` before its handler runs.
//
// Same family as the accept-forbidden guard (@vault-mcp/core's
// acceptForbiddenReason): a protective refusal for FALLIBLE agents, not
// adversaries — the client-side hooks narrow the window, and this is the layer
// that holds for every client. It binds at the kernel's dequeue closure
// (kernel/index.ts, Kernel.runMutation), the same interception point where
// `if_rev` and the advisory-lock consult sample live vault state: an
// enqueue-time check would inspect the world the operations ahead of you are
// still changing.
//
// FAIL OPEN, deliberately — the mirror image of `if_rev`'s fail-closed. The
// check is protective, not load-bearing: a missing file, an unparsed
// frontmatter cache, or a throwing probe means "cannot show this is a record",
// and refusing unrelated operations over an unreadable probe would make a
// broken cache a vault-wide write outage. (`if_rev` fails closed because the
// caller EXPLICITLY asked for a precondition; nobody asked this check to
// block a note it cannot read.)
//
// Obsidian-free by construction, like every other kernel module: the decision
// runs over an injected `isRecord` lookup; the only adapter that touches
// `obsidian` is the probe in obsidian-probe.ts.

/**
 * Typed refusal: a mutating operation named a record note and is not the
 * append tool. Nothing ran; rendered as `Error [record_immutable]: …` by the
 * interception layer (mcp/guarded.ts), like the other kernel refusals.
 */
export class RecordImmutableError extends Error {
  readonly code = "record_immutable";
  constructor(
    readonly op: string,
    readonly path: string
  ) {
    // "names", not "would modify": collectPaths walks every path-key argument,
    // including ones an op only reads (a template_path flagged record: true
    // refuses the whole call — over-blocking is the safe direction, but the
    // message must not assert a write that wasn't going to happen).
    super(
      `'${op}' names '${path}', whose frontmatter carries record: true. Record notes are historical and ` +
        `append-only: nothing was written. Extend the record with a dated end-of-file append ` +
        `(obsidian_append_note, a new '## YYYY-MM-DD …' section) or write a NEW record note — never edit, ` +
        `move, or delete an existing one.`
    );
    this.name = "RecordImmutableError";
  }
}

/**
 * The operations exempt from the record check, by TOOL IDENTITY — the one
 * mutation a record note admits is a pure end-of-file append, and
 * `obsidian_append_note` is the only tool on the surface whose whole contract
 * is that. Deliberately keyed on the op name and never on argument shapes: an
 * argument-sniffed exemption ("looks like an append") is exactly the kind of
 * guess a different tool's arguments could satisfy while rewriting the file.
 * (`obsidian_append_at_heading` CAN insert mid-file — its heading-absent +
 * create_if_missing branch happens to append at EOF, but the common branch
 * does not, and an exemption keyed on a tool whose contract is only
 * sometimes an append is exactly the guess this set avoids.)
 *
 * KNOWN, deliberately NOT exempted: `vaultmcp_crosssession_post` — the cross-
 * session channel plugin's posting tool (`packages/crosssession/src/tools.ts`;
 * spelled `crosssession_post` before the S6 satellite extraction, when it was
 * this plugin's own module tool). It is the one other tool whose whole
 * contract is a dated end-of-file append.
 * That satellite was retired on 2026-10-15 (Nelson's verify of "Retire
 * vaultmcp-crosssession"), so the tool no longer exists; the reasoning below
 * is kept as the record of why the set stayed closed.
 *
 * It is UNREACHABLE by this check, and the extraction did not change that.
 * Two facts, both re-verified at S6:
 *
 *   1. IT WAS NEVER OUTSIDE THE KERNEL. As a module tool it registered on the
 *      same guard-patched `server.registerTool` every built-in rides, and as a
 *      published external tool it registers through the very same path
 *      (`external-tools.ts` → `makeGuarded`). "Unreachable" was never a claim
 *      that it bypassed the dequeue closure — it always ran through it.
 *   2. IT IS UNREACHABLE ON ARGUMENTS. Its target arrives as `channel`, which
 *      is not in guard.ts's PATH_KEYS, so `collectPaths({handle, channel,
 *      body})` yields an EMPTY list and the loop below has nothing to test.
 *      The file it actually appends to is DISCOVERED inside the handler (the
 *      channel folder's single entry-bearing log file) and is named by no
 *      argument at all.
 *
 * So exempting it would change no behavior now while WIDENING a protective set
 * on a guess about a future argument shape. The tripwire that ACTUALLY fires
 * lives host-side: guard.test.mjs asserts `collectPaths` over the
 * crosssession argument names is empty against the LIVE PATH_KEYS — the
 * satellite's own pin runs against a snapshot copy (its host-shim), which is
 * a review aid rather than a live check, and claiming otherwise was an
 * inflated guard-rail the 2026-09-05 review corrected. Pinned by a test below the
 * exemption test; the day `channel` becomes path-keyed (or the tool gains a
 * `path`), appending to a record-flagged channel note starts refusing and this
 * set is where that gets decided, on purpose, by a human.
 */
export const RECORD_EXEMPT_OPS: ReadonlySet<string> = new Set(["obsidian_append_note"]);

/**
 * Whether a frontmatter `record` value marks the note as a record. The
 * metadata cache hands back parsed YAML, so the canonical form is the boolean
 * `true`; the quoted string form is honored too because the guard is
 * protective and a hand-typed `record: "true"` plainly meant to declare one.
 * Anything else — absent, false, prose — is not a record.
 */
export function isRecordFlag(value: unknown, expected: string = "true"): boolean {
  const want = expected.trim().toLowerCase();
  // A YAML boolean `true` matches an expected "true" — that is the shipped
  // default and the way every existing record note is written.
  if (value === true) return want === "true";
  if (typeof value === "string") return value.trim().toLowerCase() === want;
  // Nothing else counts — not `1`, not `"yes"`, not a list. The pin in
  // record-immutable.test.mjs holds this deliberately: this predicate decides
  // what an agent may not overwrite, and a wider match is a wider refusal
  // surface, which must not grow by accident. A tag-identified record does not
  // come through here at all (the probe uses getAllTags for that).
  return false;
}

/**
 * The refusal for one mutating operation, or null when it may proceed.
 *
 * `paths` is EVERY path the operation names (guard.ts's collectPaths — the
 * uncapped list the advisory-lock consult already uses): a move whose
 * DESTINATION is a record note would overwrite it just as surely as a write to
 * it, so any record among the named paths refuses, first hit named.
 *
 * `isRecord` is the injected probe (`TargetProbe.record`). `undefined` means
 * the flag could not be read — no file, no parsed frontmatter — and a THROW is
 * swallowed per path: both fail OPEN (see the header). The check never reads
 * the vault itself.
 */
export function recordImmutableRefusal(
  op: string,
  paths: string[],
  isRecord: (path: string) => boolean | undefined
): RecordImmutableError | null {
  if (RECORD_EXEMPT_OPS.has(op)) return null;
  for (const path of paths) {
    let flagged: boolean | undefined;
    try {
      flagged = isRecord(path);
    } catch {
      flagged = undefined; // unreadable ⇒ not provably a record ⇒ fail open
    }
    if (flagged === true) return new RecordImmutableError(op, path);
  }
  return null;
}

// ── How a note declares itself a record (#397) ────────────────────────────────
//
// The convention used to be hard-coded: frontmatter `record: true`. That is one
// vault's spelling, and a plugin with a community directory cannot ship a
// spelling. So the operator picks — the same choice TaskNotes offers with
// `taskIdentificationMethod` / `taskTag`: a frontmatter property holding a
// value, or a tag. The DECISION lives here, obsidian-free, so it is testable
// without a metadata cache; `obsidian-probe.ts` only gathers the note's
// frontmatter and tags and hands them in.

/** Mirrors TaskNotes' `taskIdentificationMethod` / `taskTag` shape on purpose — one convention. */
export interface RecordIdentification {
  /** The NOTE indicator on or off (#482). Off: no note is a record by its frontmatter or tags (the folder indicator, if on, still applies to moves). */
  enabled: boolean;
  method: "property" | "tag";
  /** Frontmatter key, when `method` is "property". */
  property: string;
  /** Value that key must hold (case-insensitive, trimmed; YAML `true` matches "true"). */
  value: string;
  /** Tag (without `#`), when `method` is "tag". Frontmatter and inline tags both count. */
  tag: string;
}

/** The shipped default — the spelling every existing record note was written in. */
export const DEFAULT_RECORD_IDENTIFICATION: Readonly<RecordIdentification> = Object.freeze({
  enabled: true,
  method: "property",
  property: "record",
  value: "true",
  tag: "record",
});

/**
 * Coerce a stored (possibly partial, hand-edited, or wrong-typed) value to a
 * complete identification, never throwing: a blank or non-string field takes
 * the default, an unknown method reads as "property", and a leading `#` on the
 * tag is stripped so `#record` and `record` mean the same thing.
 */
export function normalizeRecordIdentification(raw: unknown): RecordIdentification {
  const ri = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof RecordIdentification, unknown>>;
  const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  return {
    enabled: ri.enabled !== false,
    method: ri.method === "tag" ? "tag" : "property",
    property: str(ri.property, DEFAULT_RECORD_IDENTIFICATION.property),
    value: str(ri.value, DEFAULT_RECORD_IDENTIFICATION.value),
    tag: str(ri.tag, DEFAULT_RECORD_IDENTIFICATION.tag).replace(/^#/, ""),
  };
}

/** What the probe gathers from the metadata cache for one note. */
export interface RecordEvidence {
  /** Parsed frontmatter, or null/undefined when the cache has none. */
  frontmatter?: Record<string, unknown> | null;
  /** Every tag on the note, frontmatter and inline, with or without `#`. */
  tags?: readonly string[];
}

/**
 * Whether the note is a record under the operator's identification. Returns
 * `undefined` — "cannot tell", which the kernel treats as NOT a record (fail
 * open, see the header) — when the property method is asked about a note with
 * no frontmatter or without the property at all. The tag method always answers,
 * because an absent tag is a plain "no".
 */
export function identifiesRecord(id: RecordIdentification, note: RecordEvidence): boolean | undefined {
  if (id.enabled === false) return false;
  if (id.method === "tag") {
    const want = id.tag.replace(/^#/, "").trim().toLowerCase();
    if (!want) return false;
    return (note.tags ?? []).some((t) => t.replace(/^#/, "").trim().toLowerCase() === want);
  }
  const fm = note.frontmatter;
  if (!fm || !Object.prototype.hasOwnProperty.call(fm, id.property)) return undefined;
  return isRecordFlag(fm[id.property], id.value);
}

// ── the FOLDER indicator (#482) ─────────────────────────────────────────────
// Nelson, 2026-10-02: "we need to make the indicator that a folder contains
// records — or that a note is a record — both configurable as a constant from
// the plugin settings as well as the setting itself gets an enable/disable
// toggle". A note lies in a record folder when a folder on its path is one of
// `folders` (by its whole vault path) or its name matches `archivePattern`.
// The shipped default is empty; see record-folders-policy.ts for the seed.
// Used by the moves (records.ts), never by the write guard, which judges a
// record by the note indicator only.

export interface RecordFolders {
  /** The FOLDER indicator on or off. */
  enabled: boolean;
  /** Vault-relative folder paths whose notes are records. */
  folders: string[];
  /** A regular expression (source text) matched against each folder NAME on a path; a match makes the folder a record folder. Empty: none. */
  archivePattern: string;
}

/**
 * The shipped default: EMPTY (no record folders, no archive pattern). The plugin
 * ships no folder names (Nelson, 2026-10-03: "No folder names are ever in the
 * live code"); an install that predates the setting is seeded once with what
 * #455 hard-coded (record-folders-policy.ts).
 */
export const DEFAULT_RECORD_FOLDERS: Readonly<RecordFolders> = Object.freeze({
  enabled: true,
  folders: Object.freeze([]) as unknown as string[],
  archivePattern: "",
});

/**
 * Coerce a stored value to a complete folder indicator, never throwing: a
 * non-array list takes the default; entries are trimmed, stripped of a leading
 * or trailing `/`, and blanks dropped; a pattern that is not a string takes the
 * default, and one that does not compile is kept as written but matches nothing
 * (compileRecordFolders), so a typo never widens what counts as a record.
 */
export function normalizeRecordFolders(raw: unknown): RecordFolders {
  const rf = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof RecordFolders, unknown>>;
  const folders = Array.isArray(rf.folders)
    ? rf.folders.filter((f): f is string => typeof f === "string").map((f) => f.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean)
    : [...DEFAULT_RECORD_FOLDERS.folders];
  return {
    enabled: rf.enabled !== false,
    folders,
    archivePattern: typeof rf.archivePattern === "string" ? rf.archivePattern : DEFAULT_RECORD_FOLDERS.archivePattern,
  };
}

/** The archive pattern as a RegExp, or null when it is empty or does not compile. */
export function archivePatternRegExp(pattern: string): RegExp | null {
  if (!pattern.trim()) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
