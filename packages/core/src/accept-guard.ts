// The accept-forbidden guard — the "the accept verb is in no API" invariant.
//
// Extracted from packages/host/src/mcp/write-notes-compose.ts (issue #104):
// this predicate previously lived ONLY in the plugin, so ObsidianBackend was
// guarded but the shared filesystem write primitive (fs-backend/vault.ts,
// wrapping VaultImpl — the implementation BOTH FilesystemBackend and
// packages/server's fs-failover mode's module-level singleton functions call)
// passed content straight through. Moving the pure decision logic here lets
// every VaultBackend implementation call the SAME predicate. DRY — one
// predicate, every write path.
//
// Obsidian-free by construction: everything here operates on plain objects
// and an injected YAML-parse function, so it is a real unit-testable module
// with no `obsidian` import, usable from packages/core and packages/server.
//
// ── The invariant this file is the point of ─────────────────────────────────
//
// No write may INTRODUCE or CHANGE a note's acceptance to the accepted-family:
// a payload/result whose frontmatter sets `acceptance-status: accepted` (or an
// `accepted-*` variant) or carries any `accepted` / `accepted-by` /
// `accepted-on` field, or introduces / changes / blanks the live `verified`
// field (#406), is REJECTED before any write lands. The transport must
// never persist acceptance — acceptance is a human gesture only, granted
// directly in Obsidian, never through an API.
//
// The one thing the guard must NOT break: a legitimate edit that carries an
// existing (human-granted) accepted value forward UNCHANGED. So the rule is a
// TRANSITION over (before, after) — preserve is allowed, introduce/change is
// not.

/**
 * Typed refusal for the accept-forbidden guard — rendered as `Error [accept_forbidden]`.
 *
 * The SAME code covers the declared protected-property perimeter (#224): both are
 * "an agent may not write this frontmatter through a guarded transport", and reusing
 * the one code every transport already renders (several catch sites hardcode the
 * string, not `e.code`) means a declared-property refusal cannot type differently on
 * one transport than another. Only the guidance trailer differs, keyed on the
 * reason the shared predicate produced — the accepted-family message is
 * byte-identical to what it always was.
 */
export class AcceptForbiddenError extends Error {
  readonly code = "accept_forbidden";
  constructor(reason: string) {
    super(`${reason}. ${acceptForbiddenTrailer(reason)}`);
    this.name = "AcceptForbiddenError";
  }
}

/**
 * The guidance trailer for one refusal family, keyed on the REASON the shared
 * predicate produced (#408): the accepted-family text is byte-identical to
 * what it always was; a declared-property refusal gets property guidance; and
 * a `verified` refusal (the live key, #406) names the field the reason refused
 * and the remedy that fits its case, instead of telling the agent to remove
 * the retired `accepted`/`accepted-by`/`accepted-on` keys — which for the
 * blank case contradicted the remedy the reason itself had just given.
 */
export function acceptForbiddenTrailer(reason: string): string {
  if (/protected propert/.test(reason)) {
    return (
      `Declared protected frontmatter properties are human-only: no agent transport may ` +
      `introduce, change, or remove one (byte-identical carry-forward is allowed). Leave the property ` +
      `exactly as it is on disk and retry; a human sets it by editing the note directly in Obsidian.`
    );
  }
  const v = /verification field '([^']+)'/.exec(reason);
  if (v) {
    const key = v[1];
    const remedy = /present but empty/.test(reason)
      ? `Remove the blank '${key}' and retry`
      : /frontmatter carries the verification field/.test(reason)
        ? `Leave '${key}' out of the payload and retry`
        : /cannot be confidently parsed/.test(reason)
          ? `Repair the note's frontmatter in Obsidian, or leave '${key}' exactly as it is on disk, and retry`
          : `Leave '${key}' exactly as it is on disk and retry`;
    return `The transport never persists acceptance — the accept verb is in no API. ${remedy}; a verification is a human's record, written only by a human.`;
  }
  // The YAML-unclassifiable refusal names its own remedy (correct the
  // frontmatter, or edit in Obsidian); repeating the retired keys after it
  // would point at the wrong problem. The invariant alone.
  if (/cannot read as YAML does/.test(reason)) {
    return `Write that key or value in a plain form (no backslash escapes, no tag or anchor, on one line) and retry; the accept guard compares what a YAML reader sees, and this form it cannot read the same way.`;
  }
  if (/frontmatter repeats the key/.test(reason)) {
    return `Write each key once and retry; the accept guard compares what a reader sees, and two copies of a key make that unknowable.`;
  }
  if (/could not be confidently inspected/.test(reason)) {
    return `The transport never persists acceptance — the accept verb is in no API; acceptance is a human gesture only.`;
  }
  return (
    `The transport never persists acceptance — the accept verb is in no API. ` +
    `Remove the accepted/accepted-by/accepted-on field and retry; acceptance is a human gesture only.`
  );
}

/**
 * True for a frontmatter VALUE that ASSERTS acceptance (`accepted`, `accepted-*`),
 * across every value-TYPE it can take: a scalar string, an array of them
 * (`[accepted]`), or a map wrapping one (`{value: accepted}`). String-only was
 * the S3 hole — an array/map form asserted acceptance while slipping the guard.
 */
function isAcceptedValue(v: unknown): boolean {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "accepted" || s.startsWith("accepted-") || s.startsWith("accepted ");
  }
  if (Array.isArray(v)) return v.some(isAcceptedValue);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).some(isAcceptedValue);
  return false;
}

/** A frontmatter KEY that is an acceptance-provenance field: `accepted`, `accepted-by`, `accepted-on`, `accepted_by`, … */
function isAcceptedKey(key: string): boolean {
  return /^accepted([-_ ].*)?$/.test(key.trim().toLowerCase());
}

/** The LIVE verification key (#406, ruled 2026-09-26): `verified`, `verified-by`,
 *  `verified_on`, … Since the vault retired the `accepted*` family, what confirms
 *  a note is a `verified` entry only a human writes (01.41 The accept perimeter,
 *  rule 2a) — and the guard had never learned the new key, so an agent write of
 *  `verified: [...]` passed while `accepted-by` was refused. The retired family
 *  stays guarded beside it: a stray old-format note must not be re-accepted by
 *  accident, and a floor never shrinks. */
export function isVerifiedKey(key: string): boolean {
  return /^verified([-_ ].*)?$/.test(key.trim().toLowerCase());
}

/** Present-but-empty: `verified: []`, `verified:` (null), `verified: ""`,
 *  `verified: {}`. Rule 2a refuses that shape on purpose — "a key that is
 *  present and empty reads as a field somebody may fill in" — so it is refused
 *  OUTRIGHT, carry-forward included: an empty value is never a human's record. */
export function isBlankVerification(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  // Only a PLAIN empty object is blank: a Date (what a YAML timestamp parses
  // to under Obsidian's parser) has no own enumerable keys and is a value.
  if (typeof v === "object") return Object.getPrototypeOf(v) === Object.prototype && Object.keys(v as object).length === 0;
  return false;
}

/** Whether one `verified` entry names a HUMAN actor (01.41 rule 1f): an object
 *  whose `by` is a string with the `human:` prefix. An agent's own check
 *  (`<producer>/<version>`) and a scheduled job's (`process:<id>`) are entries
 *  too, and never count: the trust tier keys on the prefix and nothing else. */
export function isHumanVerification(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const by = (entry as Record<string, unknown>).by;
  // NAMING a human actor: the prefix alone is not a person (`by: "human:"` is
  // a blank with a costume on), so the name after it must be non-empty.
  return typeof by === "string" && by.startsWith("human:") && by.slice("human:".length).trim() !== "";
}

/** The human verification a note carries, for the record: the LAST entry in
 *  the `verified` list whose actor names a human (01.41 rule 1f), as
 *  `{by, at}` — `at` rendered as the vault wrote it (a string as-is, a parsed
 *  YAML timestamp as ISO), null when the entry has none. Null when the note
 *  carries no human verification: the same answer `hasHumanVerification`
 *  gives, so a note one reads as accepted the other can always describe
 *  (01.61 rule 11: the compiled artifact records each source's acceptance). */
export function humanVerificationOf(fm: Record<string, unknown> | null | undefined): { by: string; at: string | null } | null {
  if (!fm) return null;
  const key = Object.keys(fm).find((k) => k.trim().toLowerCase() === "verified");
  if (key === undefined) return null;
  const v = fm[key];
  const entries = (Array.isArray(v) ? v : [v]).filter(isHumanVerification) as Record<string, unknown>[];
  const last = entries[entries.length - 1];
  if (!last) return null;
  const at = last.at;
  return {
    by: String(last.by),
    at: at instanceof Date ? at.toISOString() : typeof at === "string" && at.trim() !== "" ? at.trim() : at === undefined || at === null ? null : String(at),
  };
}

/** Whether a note's frontmatter carries at least one human verification: the
 *  `verified` key (case-insensitive, the live key alone — not the retired
 *  family), a list of entries or one entry, any of them naming a `human:`
 *  actor. This is the ACCEPTED state of 01.41 ("a note carrying a `verified`
 *  entry whose actor has the `human:` prefix"), the test the skills compiler
 *  gates on (rule 8: nothing unaccepted reaches a compiled agent prompt). It
 *  is kept HERE, beside the accept guard, so the compiler's definition of the
 *  accepted state cannot drift from the perimeter's vocabulary; the guard
 *  itself refuses agent writes to `verified` and does not call this. Blank,
 *  absent, or machine-only ⇒ false. */
export function hasHumanVerification(fm: Record<string, unknown> | null | undefined): boolean {
  if (!fm) return false;
  const key = Object.keys(fm).find((k) => k.trim().toLowerCase() === "verified");
  if (key === undefined) return false;
  const v = fm[key];
  const entries = Array.isArray(v) ? v : [v];
  return entries.some(isHumanVerification);
}

// ── the ONE recognizer for a note's leading frontmatter fence ───────────────
//
// #126 (fixed in the plugin by PR #129, `write-notes-compose.ts`): a guard
// that recognizes LESS frontmatter than the write path honors is a bypass,
// not caution. `stripLeadingBom` + `LEADING_FRONTMATTER_RE` are THIS
// package's copy of that same canonical shape (packages/core cannot import
// from the host package — the dependency runs the other way), kept here as
// the single definition every recognizer/editor in packages/core binds to,
// so a second, narrower copy can't quietly reappear and reopen the hole in
// a different backend. See accept-guard.test.ts's parity suite.
//
// A literal U+FEFF byte is never written into this file's source — `0xfeff`
// is compared by code point, matching PR #129's own `stripLeadingBom`.

/** A leading byte-order mark, removed. Obsidian's own parser looks past a BOM to find the opening `---`; so must anything deciding what the vault will honor. Strips exactly ONE — a second BOM is content, not a marker, and must not be stripped. */
export function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The one definition of a note's leading frontmatter fence.
 *
 * **The opener and the closer are not symmetric, and that asymmetry is the
 * vault's, not a convenience.** Verified against a live Obsidian by writing
 * probe notes and reading them back through its own parser:
 *
 *   - The OPENER must be exactly `---` (after `stripLeadingBom`, at byte 0),
 *     with only spaces/tabs before the line break. `----` does not open a
 *     block; neither does `--- yaml`.
 *   - The CLOSER is the first later line whose first three bytes are `---`.
 *     Whatever follows those three dashes on that line is **body**, not part
 *     of the fence: `----` closes and leaves `-`, `---x` closes and leaves
 *     `x`, `--- ` closes and leaves a line holding one space. An INDENTED
 *     ` ---` does not close — the dashes must start the line.
 *   - A LINE BREAK is `\r\n`, `\n`, **or a lone `\r`**. Obsidian's fence scan
 *     honors a classic-Mac line ending on either fence: `---\nzz: 9\r---\n`
 *     and an all-CR document both parse (probed). This is the one place where
 *     the fence scan and the YAML parser genuinely disagree — a lone `\r`
 *     *inside* a scalar stays content (`parseYaml` does not split on it), so
 *     the same byte is a line break to the fence and content to the value.
 *     That asymmetry is not ours to reconcile; it is the vault's, and both
 *     halves are pinned in the oracle. `parseGuardFrontmatter` still REFUSES
 *     a block carrying a lone `\r` it cannot classify (#104), so widening the
 *     fence here does not widen what the subset parser will silently accept.
 *
 * This pattern therefore ends immediately after the closing `---`, and callers
 * that split on `match[0].length` get the vault's own body boundary. That is
 * deliberate: the remainder of the closer line is content, and a pattern that
 * swallowed it would make every reader drop a line the vault shows.
 *
 * The closer used to require `[ \t]*` and then a line break, which recognized
 * LESS than the vault honors — the #126 class on the other fence. Content whose
 * frontmatter asserted acceptance behind such a closer drew no refusal from the
 * accept guard while Obsidian parsed and honored it. Do not re-narrow this
 * without re-probing the vault; the oracle table in
 * `packages/host/tests/frontmatter-boundary-oracle.test.mjs` is the spec and
 * this regex is only the implementation.
 */
export const LEADING_FRONTMATTER_RE = /^---[ \t]*(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)---/;

/**
 * The raw YAML text of `markdown`'s leading frontmatter, or null when it has
 * none — the ONE recognition step, factored out so the parsers below and every
 * guard outside this package share it rather than each writing
 * `LEADING_FRONTMATTER_RE.exec(stripLeadingBom(…))` again. Three copies of one
 * expression is how the shape drifts.
 *
 * Callers must pass the bytes that will actually be honored, never a
 * normalized copy. That clause is #126's second lesson, learned after the
 * first fix: the guard had closed a BOM mismatch while the identical class
 * stayed open on `\r`, because it scanned a line-ending-folded copy while the
 * write path decided over raw bytes. Recognizing the right shape is only half
 * of it — both sides must be looking at the same document.
 */
export function leadingFrontmatterBlock(markdown: string): string | null {
  const m = LEADING_FRONTMATTER_RE.exec(stripLeadingBom(markdown));
  return m ? m[1] : null;
}

/**
 * `markdown` with its leading frontmatter fence removed — the body as a reader
 * sees it. The counterpart to `leadingFrontmatterBlock`, sharing the one
 * recognizer so a *reader* cannot disagree with a *guard* about where the body
 * starts.
 *
 * Read paths get this wrong in the opposite direction from guards, which is
 * why they need it too (#150): a narrower recognizer treats a BOM/CRLF/
 * trailing-whitespace fence as absent, so instead of scanning a body it scans
 * the frontmatter as though it were prose — indexing YAML keys as content,
 * hunting wikilinks inside the fence. Not a bypass, but a silent mis-read of
 * exactly the notes whose bytes are least ordinary.
 *
 * A leading BOM is dropped along with the fence: it is a byte-order mark, not
 * body text, and no reader wants it as content.
 *
 * The recognizer stops at the closing `---`, so the raw remainder still begins
 * with whatever the vault treats as body — including anything sitting on the
 * closer's own line. Exactly ONE line terminator is consumed here (`\r\n`,
 * `\n`, or a lone `\r` — the same set the fence scan honors), which reproduces
 * what Obsidian reports as a note's body: `---\na: 1\n---\nbody` reads as
 * `body`, while `---\na: 1\n----\nbody` reads as `-\nbody`, the leftover dash
 * being content. Consuming the whole closer line would silently delete a line
 * the vault displays; consuming nothing would prefix every body with a blank
 * line.
 */
export function stripLeadingFrontmatter(markdown: string): string {
  const text = stripLeadingBom(markdown);
  const m = LEADING_FRONTMATTER_RE.exec(text);
  return m ? text.slice(m[0].length).replace(/^(?:\r\n|\n|\r)/, "") : text;
}

/** Extract & parse the leading YAML frontmatter of a markdown string; null when there is none. `parseYaml` injected. */
export function frontmatterOf(
  markdown: string,
  parseYaml: (yaml: string) => unknown
): Record<string, unknown> | null {
  const block = leadingFrontmatterBlock(markdown);
  if (block === null) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** Stable deep-equal over JSON-serializable frontmatter values (for the preserve-unchanged allowance). */
function fmEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && fmEqual(ao[k], bo[k]));
}

/** Case-insensitive lookup: the presence + value of `key` in `fm`, keys matched by trimmed lowercase. */
function lookupCI(fm: Record<string, unknown> | null | undefined, key: string): { present: boolean; value: unknown } {
  if (fm) {
    const want = key.trim().toLowerCase();
    for (const k of Object.keys(fm)) if (k.trim().toLowerCase() === want) return { present: true, value: fm[k] };
  }
  return { present: false, value: undefined };
}

// ── Declared protected properties (#224) ────────────────────────────────────
//
// The accepted family above is ONE hardcoded instance of a general rule: some
// frontmatter properties are human-only, and every guarded transport must refuse
// an agent write that would move one. #224 generalizes the mechanism into a
// DECLARED list that threads in from plugin settings (human-only-mutable — no
// agent path writes plugin config) and is enforced HERE, inside the same two
// predicates every transport already reaches. No call site changes, no second
// definition, no per-transport reimplementation — a transport that enforces the
// accepted family enforces the declared list by construction.
//
// THE FLOOR IS NOT CONFIG. The accepted-family checks above run unconditionally,
// before and independently of the declared list: nothing a config can say —
// including an empty list — touches them. `normalizeProtectedProperties`
// additionally DROPS (loudly) any config entry naming an accepted-family key or
// `acceptance-status`: the family is already at maximum protection and must not
// look configurable, and `acceptance-status`'s non-accepted values are
// deliberately agent-writable workflow state (#228) that one bad config line
// must not be able to freeze. Config can only EXTEND the perimeter to NEW keys.
//
// Two grades per declared property:
//   • `agent-forbidden`     — introduce/change/remove refused through every
//     guarded transport; byte-identical carry-forward allowed. (Removal IS
//     refused for declared keys — stripping a human's declaration through an
//     agent transport is as much a mutation as changing it. The accepted family
//     keeps its historical exact semantics untouched.)
//   • `authority-conferring` — agent-forbidden PLUS honor-only-if-blessed: the
//     value only takes EFFECT once the write that set it is human-attributed or
//     accepted in review. The honor rule itself lives with the governance
//     module (`honoredValueFromBlessed` reads the accepted BASELINE, never raw
//     frontmatter); this guard supplies the write-side half and the grade.

export type ProtectedPropertyGrade = "agent-forbidden" | "authority-conferring";

export interface ProtectedProperty {
  key: string; // canonical form (trimmed, lowercased, `_` folded to `-`)
  grade: ProtectedPropertyGrade;
}

/**
 * Canonical form of a frontmatter key for declared-property matching: trimmed,
 * lowercased, `_` folded to `-` — the same separator forgiveness the accepted
 * family's own recognizer applies (`accepted_by` ≡ `accepted-by`,
 * `acceptance_status` ≡ `acceptance-status`), so a declared key cannot be
 * dodged by a case or separator variant.
 */
export function canonicalPropertyKey(key: string): string {
  return key.trim().toLowerCase().replace(/_/g, "-");
}

/** Keys the config may NOT declare: the hardcoded floor governs them already. */
function isFloorKey(canonical: string): boolean {
  return isAuthorityFamilyKey(canonical);
}

/**
 * Whether a CANONICAL key (see canonicalPropertyKey) belongs to the authority
 * family — the accepted provenance fields plus acceptance-status. Exported so
 * the class firewall (plugin kernel) classifies authority-touching diffs with
 * THIS recognizer rather than a second, driftable copy — the exact hazard the
 * one-recognizer comment above documents for the frontmatter fence.
 */
export function isAuthorityFamilyKey(canonical: string): boolean {
  return isAcceptedKey(canonical) || isVerifiedKey(canonical) || canonical === "acceptance-status";
}

const GRADES: ReadonlyArray<ProtectedPropertyGrade> = ["agent-forbidden", "authority-conferring"];

/**
 * The DEFAULT declared list. `auto-accept` is the first authority-conferring
 * consumer (#135's per-note auto-accept policy): a human declares delegation by
 * writing `auto-accept: appends|all` in a note's own frontmatter; the value is
 * honored only once blessed (see the governance module), and no agent transport
 * may set it.
 */
export const DEFAULT_PROTECTED_PROPERTIES: ReadonlyArray<ProtectedProperty> = Object.freeze([
  Object.freeze({ key: "auto-accept", grade: "authority-conferring" as ProtectedPropertyGrade }),
]);

/**
 * Coerce an UNTRUSTED declared list (plugin settings / hand-edited data.json)
 * into a safe canonical list. Never throws.
 *   - a non-array input → the DEFAULT list (fail toward the shipped default);
 *     an EMPTY array is respected (a human may declare nothing);
 *   - entries that are not `{key, grade}` with a non-empty string key → dropped, loudly;
 *   - an unknown grade → dropped, loudly (never guessed: coercing an intended
 *     `authority-conferring` down to `agent-forbidden` would silently shed the
 *     honor rule);
 *   - floor keys (`accepted*`, `verified*`, `acceptance-status`) → dropped, loudly — the
 *     hardcoded floor cannot be shrunk, downgraded, or restated by config;
 *   - duplicates (canonical) → first wins, loudly.
 */
export function normalizeProtectedProperties(
  input: unknown,
  warn: (msg: string) => void = (msg) => console.warn(msg)
): ProtectedProperty[] {
  if (!Array.isArray(input)) return [...DEFAULT_PROTECTED_PROPERTIES];
  const out: ProtectedProperty[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const entry = raw as { key?: unknown; grade?: unknown } | null | undefined;
    const keyRaw = typeof entry?.key === "string" ? entry.key : "";
    const key = canonicalPropertyKey(keyRaw);
    if (!key) {
      warn(`vault-mcp: protected-property entry with no key ignored: ${JSON.stringify(raw)}`);
      continue;
    }
    if (isFloorKey(key)) {
      warn(
        `vault-mcp: protected-property entry '${key}' ignored — the accepted family and acceptance-status are ` +
          `governed by the hardcoded floor and are not configurable (config can only extend the perimeter to new keys)`
      );
      continue;
    }
    const grade = entry?.grade;
    if (typeof grade !== "string" || !GRADES.includes(grade as ProtectedPropertyGrade)) {
      warn(`vault-mcp: protected-property entry '${key}' ignored — unknown grade ${JSON.stringify(grade)}`);
      continue;
    }
    if (seen.has(key)) {
      warn(`vault-mcp: duplicate protected-property entry '${key}' ignored (first declaration wins)`);
      continue;
    }
    seen.add(key);
    out.push({ key, grade: grade as ProtectedPropertyGrade });
  }
  return out;
}

// The module-level registry the predicates consult. Set from plugin settings at
// load and on every settings save (main.ts); defaults to the shipped list so an
// embed that never wires settings (packages/server's fs-failover, bare core
// users) still enforces the default perimeter. The setter normalizes, so even a
// direct mis-set cannot smuggle a floor key or an unknown grade in. There is
// deliberately NO agent-reachable path to this setter: it is not a tool, not a
// command, and not reachable by walking `app` — the only production caller is
// the plugin's own settings load/save.
/**
 * Settings-textarea codec: one declaration per line, `key: grade` (or a bare
 * `key`, which reads as `agent-forbidden`). Parsing is deliberately RAW — it
 * preserves what the human typed (unknown grades included) so the textarea
 * round-trips; validation happens once, in `normalizeProtectedProperties`, when
 * the list is set on the registry. `formatProtectedPropertyLines` is its
 * inverse over the stored shape.
 */
export function parseProtectedPropertyLines(text: string): Array<{ key: string; grade: string }> {
  const out: Array<{ key: string; grade: string }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) {
      out.push({ key: line, grade: "agent-forbidden" });
    } else {
      out.push({ key: line.slice(0, colon).trim(), grade: line.slice(colon + 1).trim() || "agent-forbidden" });
    }
  }
  return out;
}

export function formatProtectedPropertyLines(list: ReadonlyArray<{ key: string; grade: string }>): string {
  return list.map((p) => `${p.key}: ${p.grade}`).join("\n");
}

let declared: ReadonlyArray<ProtectedProperty> = DEFAULT_PROTECTED_PROPERTIES;

export function setDeclaredProtectedProperties(input: unknown, warn?: (msg: string) => void): void {
  declared = Object.freeze(normalizeProtectedProperties(input, warn));
}

export function declaredProtectedProperties(): ReadonlyArray<ProtectedProperty> {
  return declared;
}

/** The declared grade of `key` (canonical match), or null when it is not declared. */
export function declaredGradeOf(key: string): ProtectedPropertyGrade | null {
  const want = canonicalPropertyKey(key);
  for (const p of declared) if (p.key === want) return p.grade;
  return null;
}

/**
 * EVERY entry of `fm` whose key canonically matches `key` — plural on purpose:
 * a frontmatter object can carry `auto-accept` AND `auto_accept` as two literal
 * keys at once, and a guard that inspected only the first match would let the
 * second ride in beside it (the variant-aliasing hole, caught by the fs
 * transport sweep). The transition rule below compares the full multiset.
 */
export function findPropertiesCanonical(
  fm: Record<string, unknown> | null | undefined,
  key: string
): Array<{ key: string; value: unknown }> {
  const out: Array<{ key: string; value: unknown }> = [];
  if (fm) {
    const want = canonicalPropertyKey(key);
    for (const k of Object.keys(fm)) {
      if (canonicalPropertyKey(k) === want) out.push({ key: k, value: fm[k] });
    }
  }
  return out;
}

/** Deep equality over frontmatter values — `fmEqual`, exported for the honor-rule/drift consumers so they cannot fork the comparison. */
export function frontmatterValuesEqual(a: unknown, b: unknown): boolean {
  return fmEqual(a, b);
}

/**
 * The first DECLARED key textually present in `rawBefore`'s leading frontmatter
 * block (either separator form, case-insensitive), or null.
 *
 * The removal-detection backstop for an UNPARSEABLE before: a content-write
 * guard that collapses an unclassifiable before to "no prior frontmatter"
 * decides introduce/change correctly but lets a REMOVAL through (prevs=[] ⇒
 * nothing to remove). When the unreadable block textually mentions a declared
 * key, the write cannot be verified to carry it forward — fail closed. Scoped
 * to the frontmatter block, not the body, so prose mentioning a key name never
 * trips it; no fence ⇒ no prior frontmatter ⇒ genuinely nothing to remove.
 */
/** The reason for the unparseable-BEFORE backstop (#224, #406): the note's
 *  current frontmatter names a guarded key but cannot be confidently parsed,
 *  so the write cannot be proven to carry it forward. One builder for the
 *  three transports that throw it, naming the key by what it IS — the live
 *  verification field or a declared protected property — so the trailer fits
 *  (#408: calling `verified` a "protected property" sent the agent to the
 *  declared-properties setting, where it is not). */
export function unverifiableBeforeReason(key: string): string {
  const noun = isVerifiedKey(key) ? "verification field" : "protected property";
  const what = isVerifiedKey(key) ? "the record" : "the property";
  return `the note's current frontmatter mentions the ${noun} '${key}' but cannot be confidently parsed, so this write cannot be verified to carry ${what} forward unchanged`;
}

export function unverifiableProtectedPropertyIn(rawBefore: string): string | null {
  const block = leadingFrontmatterBlock(rawBefore);
  if (block === null) return null;
  const l = block.toLowerCase();
  // The floor's own removal rule (#406): an unreadable before that mentions
  // `verified` may hold a filled record this write would strip.
  if (/\bverified\b/.test(l)) return "verified";
  if (declared.length === 0) return null;
  for (const p of declared) {
    if (l.includes(p.key) || l.includes(p.key.replace(/-/g, "_"))) return p.key;
  }
  return null;
}

/**
 * Whether a transition guard must fetch the BEFORE frontmatter to prove a write
 * clean, given only the RESULT. The historical fast path — "the result asserts
 * nothing, skip the disk read" — is only sound while absence in the result is
 * harmless; with declared protected properties, absence may be a REMOVAL, which
 * is decidable only against the before-frontmatter. One helper, so the three
 * transports that shortcut (ObsidianBackend, VaultImpl, append_at_heading)
 * cannot drift on when shortcutting is safe.
 */
export function acceptTransitionNeedsBefore(after: Record<string, unknown> | null | undefined): boolean {
  if (declared.length > 0) return true;
  // Since #406 the FLOOR itself has a removal rule (a filled `verified` may not
  // be stripped), so a result that asserts nothing can still be a removal and
  // the before read is always needed. The parameter stays for the callers'
  // shape; the shortcut is retired, not narrowed.
  void after;
  return true;
}

/**
 * The reason a write is accept-forbidden given the note's RESULTING frontmatter
 * and its BEFORE-on-disk frontmatter, or null when the write is clean.
 *
 * REJECTED when the result INTRODUCES or CHANGES an accepted-family assertion:
 *   • any acceptance-provenance key (`accepted`, `accepted-by`, `accepted-on`,
 *     `accepted_*`) present in the result that was not already present on disk
 *     with an EQUAL value; or
 *   • `acceptance-status` (`acceptance_status`) whose resulting value ASSERTS
 *     accepted (string / array / map) and did not already hold that exact value.
 * Preserving an existing (human-set) value verbatim is ALLOWED.
 *
 * ALSO rejected (#224): a result that would introduce, change, or REMOVE a
 * DECLARED protected property (module registry above). Byte-identical
 * carry-forward is allowed exactly as for the accepted family. The floor checks
 * run first and unconditionally — the declared loop can only ever ADD refusals.
 */
export function acceptTransitionReason(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): string | null {
  if (after) {
    for (const key of Object.keys(after)) {
      const kl = key.trim().toLowerCase();
      if (isAcceptedKey(key)) {
        const prev = lookupCI(before, key);
        if (!(prev.present && fmEqual(prev.value, after[key]))) {
          return `write would ${prev.present ? "change" : "introduce"} the acceptance field '${key}'`;
        }
      } else if (isVerifiedKey(key)) {
        // The live key (#406): empty is refused outright (rule 2a); otherwise
        // exactly the accepted family's rule — introduce or change refused,
        // byte-identical carry-forward of a human's record allowed.
        if (isBlankVerification(after[key])) {
          return `write would leave the verification field '${key}' present but empty — a verification is a human's record or absent, never a blank to fill in; remove the key instead (an agent may remove a BLANK '${key}', never a filled one)`;
        }
        const prev = lookupCI(before, key);
        if (!(prev.present && fmEqual(prev.value, after[key]))) {
          return `write would ${prev.present ? "change" : "introduce"} the verification field '${key}'`;
        }
      } else if (kl === "acceptance-status" || kl === "acceptance_status") {
        if (isAcceptedValue(after[key])) {
          const prev = lookupCI(before, key);
          if (!(prev.present && fmEqual(prev.value, after[key]))) {
            return `write would set ${key} to an accepted value`;
          }
        }
      }
    }
  }
  // Removal of a FILLED `verified` record (#406, the #407 review): an agent
  // stripping a human's verification is a change of standing, refused exactly
  // as a declared property's removal is. Removal of a BLANK one is the repair
  // rule 2a asks for and is allowed — a blank is never a record, so nothing is
  // lost, and it is the only way an agent can make such a note writable again.
  if (before) {
    for (const key of Object.keys(before)) {
      if (!isVerifiedKey(key) || isBlankVerification(before[key])) continue;
      if (findPropertiesCanonical(after, key).length === 0) {
        return `write would remove the verification field '${key}' — a human's record leaves only by a human's hand`;
      }
    }
  }
  // Declared protected properties: whole-key protection (introduce / change /
  // remove), decided over BOTH sides so a result that merely OMITS a declared
  // key is caught as a removal. `after` null (the result has no frontmatter at
  // all) removes every key `before` carried, declared ones included. The
  // comparison is over the full MULTISET of canonical matches: adding
  // `auto_accept` beside an existing `auto-accept` is a change, not a
  // carry-forward of the first match.
  for (const prop of declared) {
    const prevs = findPropertiesCanonical(before, prop.key);
    const nexts = findPropertiesCanonical(after, prop.key);
    if (prevs.length === 0 && nexts.length === 0) continue;
    if (prevs.length === 0) return `write would introduce the protected property '${nexts[0].key}'`;
    if (nexts.length === 0) return `write would remove the protected property '${prevs[0].key}'`;
    if (prevs.length !== nexts.length) return `write would change the protected property '${nexts[0].key}'`;
    const remaining = prevs.map((p) => p.value);
    for (const n of nexts) {
      const i = remaining.findIndex((v) => fmEqual(v, n.value));
      if (i < 0) return `write would change the protected property '${n.key}'`;
      remaining.splice(i, 1);
    }
  }
  return null;
}

/**
 * The reason a frontmatter block is accept-forbidden, or null if it is clean.
 * Checks the CALLER's payload — a caller trying to write acceptance through the
 * transport — not the existing on-disk note. Applies whether or not stamping is used.
 */
export function acceptForbiddenReason(fm: Record<string, unknown> | undefined | null): string | null {
  if (!fm) return null;
  for (const key of Object.keys(fm)) {
    if (isAcceptedKey(key)) return `frontmatter carries the acceptance field '${key}'`;
    if (isVerifiedKey(key)) return `frontmatter carries the verification field '${key}'`;
    const k = key.trim().toLowerCase();
    if ((k === "acceptance-status" || k === "acceptance_status") && isAcceptedValue(fm[key])) {
      return `frontmatter sets ${key}='${String(fm[key])}'`;
    }
  }
  // Declared protected properties (#224): on the payload-only paths (CLI
  // property/content, fileclass field writes, debt-register) presence alone
  // refuses — exactly how the accepted family behaves on these same paths,
  // where no before-frontmatter exists to prove a carry-forward.
  for (const prop of declared) {
    const hits = findPropertiesCanonical(fm, prop.key);
    if (hits.length > 0) return `frontmatter carries the protected property '${hits[0].key}'`;
  }
  return null;
}

// ── A minimal frontmatter parser for callers with no full YAML library ──────
//
// packages/core had no YAML dependency when this reader was written (it now
// carries the `yaml` library for file-formats.ts and replace-text.ts; its own
// frontmatter editing in fs-backend/vault.ts and fs-backend/index-store.ts is
// line-based and best-effort by design). Where this reader and YAML would read
// a key or a guarded value differently, it refuses (YamlDivergenceError). `parseGuardFrontmatter` is a SEPARATE, small
// reader — scoped ONLY to feed this guard — that additionally recognizes an
// inline flow-MAP value (`key: {value: accepted}`), which
// fs-backend/index-store.ts's `parseAllFrontmatter` does not (it has no map
// type in its FrontmatterValue model). Without it, a hand-crafted map-wrapped
// accepted value could slip past the guard on the filesystem backend even
// though `isAcceptedValue` above already knows how to recognize one once
// parsed — this parser exists so that recognition is actually reachable on
// the fs write path (parity with S3 in the original plugin-only guard).
//
// It binds to the SAME `LEADING_FRONTMATTER_RE` / `stripLeadingBom` as
// `frontmatterOf` above — one fence recognizer, not two that can drift.
//
// ── Parse what the vault honors; fail closed only where parsing is impossible
// (residual on #104) ────────────────────────────────────────────────────────
//
// The real honorer of this text is Obsidian's own YAML parser, which models
// the FULL language. This reader models a large, deterministic subset of it,
// and — crucially — treats "I could not classify this line" as a REFUSAL
// rather than as ABSENCE.
//
// The bug this closes: the previous reader silently SKIPPED any line it
// couldn't classify, so a construct real YAML honors could carry an
// acceptance assertion straight past the guard while `parseGuardFrontmatter`
// reported zero keys or a garbage value. A guard that recognizes LESS than
// the honorer is a bypass, not caution — the same shape as #126/#137, one
// layer down (the VALUE parser instead of the fence recognizer).
//
// The remedy for "cannot see it" is to SEE it, not to refuse everything
// containing it. Measured over every note WITH frontmatter in both real
// vaults, the refuse-on-nesting reader rejected 336/1468 (22.9%) of
// ~/obsidian and 1741/12072 (14.4%) of ~/obsidian-old — routine shapes, not
// exotic ones. So this reader PARSES, recursively and indentation-aware:
//
//   • nested block mappings (`plugin:\n  name: x\n  id: y`) to arbitrary depth
//   • block sequences, both indented and at the parent key's own column
//   • sequences OF mappings (`- title: Foo\n  date: 2024-01-01`)
//   • flow collections nested inside one another (`[[Wikilink]]`, `[{a: 1}]`)
//   • block scalars (`|`, `>`, with chomping/indent indicators)
//   • multi-line plain and quoted scalars (continuation lines)
//   • quoted scalars containing commas and colons
//
// and the acceptance predicate runs over the WHOLE resulting tree — so an
// `accepted`-family key or value nested inside a block mapping or a
// list-of-maps is now CAUGHT, which it never was before (it was silently
// dropped along with its parent).
//
// Fail-closed remains for the constructs where a confident classification is
// genuinely impossible without a full YAML document model:
//
//   • a raw control character in a line (the lone-`\r`-inside-a-scalar case
//     that is #104's original finding — `/\r?\n/` doesn't consume it, so the
//     byte sequence has already diverged from what the vault will honor)
//   • a tab used as indentation (YAML forbids it; what the honorer does with
//     the block is not something this reader should guess)
//   • YAML anchors/aliases (`&`/`*`) and explicit tags (`!`/`!!`) — an alias
//     resolves against an anchor defined elsewhere in the document, which
//     needs the document model this reader deliberately does not build
//   • an unterminated quoted scalar with no continuation
//   • a multi-document marker (`...`)
//   • an unparseable key line, or an unexpected indentation change
//
// Every one of those was verified absent from BOTH real vaults: at the time of
// PR #143 the refusal rate was 0/1468 and 0/12072 (0.0%). The reader is also
// differential-tested against PyYAML over the same 13,540 notes and agrees on
// the full key structure, nesting included, for every note either can parse
// (one note is invalid YAML that PyYAML itself rejects). Both bugs fixed here
// — the unquoted mapping key and the refused document-root flow collection —
// were found by that oracle, not by hand-written cases. See PR #143 / #104.
//
// Those counts were measured under the OLD, narrower fence recognizer, so
// widening the closer could in principle change which blocks the strict reader
// is handed. Re-measured on the live vault after the widening: 1517 notes,
// 1510 with frontmatter, 0 refusals, and 0 notes where the old and new
// recognizers disagree about the block. That corpus is far smaller than the
// original 13,540, so read it as "no regression observed here", not as a
// re-validation of the original figure.
//
// The widening does create a new refusal class — empirically absent from that
// corpus, but real and verified by hand: a note whose body opens with a long
// thematic rule directly under a fence (`---\nChapter one\n---------------\n`)
// now has the rule recognized as its closer, and the resulting block refuses
// as unclassifiable instead of being ignored. That is the safe direction —
// refusing beats writing past a block the vault will honor — and it matches
// what Obsidian does with the same bytes. But it is a behavior change on notes
// that previously appeared to work.

const FRONTMATTER_UNCLASSIFIABLE_REASON =
  "the frontmatter could not be confidently inspected for an acceptance assertion — it contains a YAML construct " +
  "this guard's parser cannot classify (a raw control character in a line, a tab used as indentation, an " +
  "anchor/alias/tag, an unterminated quoted string, a multi-document marker, or a malformed key line). " +
  "Correct the frontmatter, or make the edit directly in Obsidian, and retry";

/**
 * A frontmatter that repeats a key at its root or inside a `verified` record
 * (#605). Typed apart from the unclassifiable refusal so a road that parses
 * with another reader (the CLI proxy, a write_notes body fence) can run this
 * check alone and keep its own reader for everything else.
 */
export class DuplicateFrontmatterKeyError extends AcceptForbiddenError {
  readonly duplicateKey: string;
  constructor(key: string) {
    super(`the frontmatter repeats the key '${key}', and a reader keeps only one of the two, so the write cannot be checked against what a reader will see`);
    this.name = "DuplicateFrontmatterKeyError";
    this.duplicateKey = key;
  }
}

function duplicateKey(key: string): never {
  throw new DuplicateFrontmatterKeyError(key);
}

/**
 * A frontmatter construct the guard's reader would read differently from a
 * YAML parser (the `yaml` library Obsidian's parseYaml uses), at a place where
 * the guard depends on the reading. Refused, never guessed.
 *
 * The rule: the reader does not decode YAML escapes. It refuses instead
 *   - anywhere: a double-quoted key with a backslash (`"\x76erified"` is
 *     `verified` to YAML), a quoted key over more than one line (YAML folds
 *     it), a plain key that opens with a tag, an anchor, an alias or another
 *     indicator (`!!str verified` is `verified` to YAML), and the merge key `<<`;
 *   - under a guarded top-level key (`guardedKey`), in block and flow form,
 *     a root flow mapping included: a double-quoted value with a backslash, a
 *     value over more than one line, a block scalar (`|`, `>`), a plain value
 *     with a comment (` #`), and a plain value that opens with a YAML indicator.
 * Single-quoted scalars on one line need no rule: their one escape (`''`) is
 * decoded here exactly as YAML decodes it.
 */
export class YamlDivergenceError extends AcceptForbiddenError {
  /** The reason without its trailer, for a road that re-throws it as its own refusal. */
  readonly reason: string;
  constructor(what: string) {
    const reason = `the frontmatter has ${what}, which this guard's reader cannot read as YAML does, so the write cannot be checked against what a reader will see`;
    super(reason);
    this.name = "YamlDivergenceError";
    this.reason = reason;
  }
}

function divergent(what: string): never {
  throw new YamlDivergenceError(what);
}

/**
 * Whether a TOP-LEVEL key's value is one the accept guard decides over: the
 * authority family (`verified*`, `accepted*`, `acceptance-status`) or a
 * declared protected property.
 */
export function guardedKey(key: string): boolean {
  const c = canonicalPropertyKey(key);
  return isAuthorityFamilyKey(c) || declaredGradeOf(c) !== null;
}

/** A key token, raw as written, refused when YAML reads it differently from its text (see YamlDivergenceError). */
function refuseDivergentKey(raw: string, key: string): void {
  if (raw.startsWith('"') && raw.includes("\\")) divergent(`a double-quoted key with a backslash escape (${raw})`);
  if ((raw.startsWith('"') || raw.startsWith("'")) && /[\r\n]/.test(raw)) divergent(`a quoted key over more than one line ('${key.replace(/\s+/g, " ")}')`);
  if (!raw.startsWith('"') && !raw.startsWith("'") && NEEDS_DOCUMENT_MODEL_RE.test(raw)) divergent(`a key with a tag, an anchor or another indicator ('${key}')`);
  if (key === "<<") divergent("a merge key ('<<')");
}

/** A plain scalar that opens with a YAML indicator this reader does not model as YAML does (`|`, `>`, `-`/`?`/`:` then a space, `,`, `]`, `}`). */
const DIVERGENT_PLAIN_START_RE = /^(?:[|>,\]}]|[-?:](?:\s|$))/;

/** A value token under the guarded key `key`: refused when YAML reads it differently from this reader. */
function refuseDivergentGuardedValue(raw: string, key: string): void {
  const t = raw.trim();
  if (t.startsWith('"') && t.includes("\\")) divergent(`a double-quoted value with a backslash escape under '${key}'`);
  if (/[\r\n]/.test(t)) divergent(`a value over more than one line under '${key}'`);
  if (t.startsWith('"') || t.startsWith("'")) return;
  if (/(^|[ \t])#/.test(t)) divergent(`a value with a comment under '${key}'`);
  if (DIVERGENT_PLAIN_START_RE.test(t)) divergent(`a value that opens with a YAML indicator under '${key}' (${t.slice(0, 20)})`);
}

/**
 * The reason `markdown`'s leading frontmatter has a form the guard's reader
 * cannot read as YAML does (see YamlDivergenceError), or null. As for
 * `duplicateFrontmatterKeyReason`: any other construct the reader cannot
 * classify is NOT reported here, and the caller keeps its own reader for it.
 */
export function yamlDivergenceReason(markdown: string): string | null {
  try {
    parseGuardFrontmatter(markdown);
  } catch (e) {
    if (e instanceof YamlDivergenceError) return e.reason;
  }
  return null;
}

/**
 * The reason `markdown`'s leading frontmatter repeats a key at its root or
 * inside a `verified` record, or null. Any other construct the guard's reader
 * cannot classify is NOT reported here: the caller keeps its own reader for it.
 */
export function duplicateFrontmatterKeyReason(markdown: string): string | null {
  try {
    parseGuardFrontmatter(markdown);
  } catch (e) {
    if (e instanceof DuplicateFrontmatterKeyError) return `the frontmatter repeats the key '${e.duplicateKey}'`;
  }
  return null;
}

function unclassifiable(): never {
  throw new AcceptForbiddenError(FRONTMATTER_UNCLASSIFIABLE_REASON);
}

/** What this reader can produce. `null` is YAML's empty value, not "absent". */
type GuardValue = string | number | boolean | null | GuardValue[] | { [k: string]: GuardValue };

/**
 * Raw control bytes (excluding tab, and excluding the `\n` the splitter already
 * consumed) anywhere in a frontmatter line — most notably a bare `\r` that
 * `/\r?\n/` did not consume because no `\n` followed it. Real YAML treats a
 * lone `\r` as a line break inside a scalar; this reader cannot, so its
 * presence means the byte sequence has already diverged from what the vault
 * will honor. #104's original finding.
 */
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F]/;

/** Leading indicator characters that need a full YAML document model (anchor, alias, tag, explicit key, directive, reserved). Block scalars (`|`/`>`) and flow openers (`[`/`{`) are deliberately NOT here — this reader parses those. */
const NEEDS_DOCUMENT_MODEL_RE = /^[&*!?%@`]/;

/** Columns of leading whitespace. A TAB in the indentation is refused — YAML forbids it, so what the honorer does with the block is not guessable. */
function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) {
    if (line[n] === "\t") unclassifiable();
    n++;
  }
  return n;
}

function isIgnorable(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** Interpret a bare (already unquoted-or-plain) scalar token as bool / number / string. */
function interpretScalar(s: string): GuardValue {
  if (s === "") return null;
  if (s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (/^-?\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(s)) {
    const n = parseFloat(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

/** A fully quote-wrapped token → its string content; otherwise null (not quoted, or not terminated on this text). */
function unquoteIfQuoted(s: string): string | null {
  if (s.length < 2) return null;
  const q = s[0];
  if (q !== '"' && q !== "'") return null;
  if (!s.endsWith(q)) return null;
  // Reject a token whose closing quote is escaped rather than real.
  if (q === '"') {
    let backslashes = 0;
    for (let k = s.length - 2; k >= 1 && s[k] === "\\"; k--) backslashes++;
    if (backslashes % 2 === 1) return null;
  }
  const inner = s.slice(1, -1);
  return q === '"' ? inner.replace(/\\(.)/g, "$1") : inner.replace(/''/g, "'");
}

/** A scalar token appearing as a whole value: quoted → unquoted string; plain → interpreted. Refuses tokens needing a document model. */
function scalarToken(raw: string): GuardValue {
  const s = raw.trim();
  const unq = unquoteIfQuoted(s);
  if (unq !== null) return unq;
  if (s.startsWith('"') || s.startsWith("'")) unclassifiable(); // opened, never closed
  if (NEEDS_DOCUMENT_MODEL_RE.test(s)) unclassifiable();
  return interpretScalar(s);
}

// ── flow collections (recursive) ────────────────────────────────────────────
//
// A real recursive-descent reader over `[a, [b, c], {k: v}]`. Replaces a
// naive `.split(",")` that both mis-split a quoted element containing a comma
// AND could not see one level down — the latter mattering because
// `projects: [[Some Note]]` (an unquoted Obsidian wikilink) is a NESTED
// sequence to YAML, and an accepted value hidden one level in was invisible.

interface FlowCursor {
  s: string;
  i: number;
}

/**
 * How strict a flow read is. `strict`: a repeated key is refused (#605).
 * `guarded`: the collection is (inside) the value of a guarded key
 * (`guardedKey`), so a divergent value form is refused. `root`: the collection
 * is the whole frontmatter, so each of its keys decides `guarded` for its own
 * value. `owner`: the guarded key, for the message.
 */
interface FlowCtx {
  strict: boolean;
  guarded: boolean;
  root: boolean;
  owner: string;
}

const LOOSE_FLOW: FlowCtx = { strict: false, guarded: false, root: false, owner: "" };

function flowSkipSpace(c: FlowCursor): void {
  while (c.i < c.s.length && /\s/.test(c.s[c.i])) c.i++;
}

/** Read one quoted token starting at the cursor, returning its raw text (quotes included). */
function flowReadQuoted(c: FlowCursor): string {
  const q = c.s[c.i];
  let out = q;
  c.i++;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (q === '"' && ch === "\\" && c.i + 1 < c.s.length) {
      out += ch + c.s[c.i + 1];
      c.i += 2;
      continue;
    }
    out += ch;
    c.i++;
    if (ch === q) {
      // A doubled '' inside a single-quoted scalar is an escaped quote.
      if (q === "'" && c.i < c.s.length && c.s[c.i] === "'") {
        out += "'";
        c.i++;
        continue;
      }
      return out;
    }
  }
  return unclassifiable(); // unterminated
}

function flowParseValue(c: FlowCursor, ctx: FlowCtx = LOOSE_FLOW): GuardValue {
  flowSkipSpace(c);
  if (c.i >= c.s.length) return null;
  const ch = c.s[c.i];
  if (ch === "[") return flowParseSeq(c, ctx);
  if (ch === "{") return flowParseMap(c, ctx);
  if (ch === '"' || ch === "'") {
    const raw = flowReadQuoted(c);
    if (ctx.guarded) refuseDivergentGuardedValue(raw, ctx.owner);
    const unq = unquoteIfQuoted(raw);
    return unq === null ? unclassifiable() : unq;
  }
  // plain scalar: up to the next structural character at this level
  let start = c.i;
  while (c.i < c.s.length && !",[]{}".includes(c.s[c.i])) c.i++;
  const tok = c.s.slice(start, c.i).trim();
  if (ctx.guarded) refuseDivergentGuardedValue(tok, ctx.owner);
  if (NEEDS_DOCUMENT_MODEL_RE.test(tok)) unclassifiable();
  return interpretScalar(tok);
}

function flowParseSeq(c: FlowCursor, ctx: FlowCtx = LOOSE_FLOW): GuardValue[] {
  c.i++; // consume '['
  const out: GuardValue[] = [];
  flowSkipSpace(c);
  if (c.s[c.i] === "]") {
    c.i++;
    return out;
  }
  for (;;) {
    out.push(flowParseValue(c, { ...ctx, root: false }));
    flowSkipSpace(c);
    if (c.i >= c.s.length) unclassifiable();
    if (c.s[c.i] === ",") {
      c.i++;
      flowSkipSpace(c);
      // tolerate a trailing comma
      if (c.s[c.i] === "]") {
        c.i++;
        return out;
      }
      continue;
    }
    if (c.s[c.i] === "]") {
      c.i++;
      return out;
    }
    unclassifiable();
  }
}

function flowParseMap(c: FlowCursor, ctx: FlowCtx = LOOSE_FLOW): Record<string, GuardValue> {
  c.i++; // consume '{'
  const out: Record<string, GuardValue> = {};
  flowSkipSpace(c);
  if (c.s[c.i] === "}") {
    c.i++;
    return out;
  }
  for (;;) {
    flowSkipSpace(c);
    // key
    let key: string;
    let rawKey: string;
    if (c.s[c.i] === '"' || c.s[c.i] === "'") {
      rawKey = flowReadQuoted(c);
      const unq = unquoteIfQuoted(rawKey);
      key = unq === null ? unclassifiable() : unq;
    } else {
      const start = c.i;
      while (c.i < c.s.length && !":,[]{}".includes(c.s[c.i])) c.i++;
      rawKey = c.s.slice(start, c.i).trim();
      key = rawKey;
      // YAML folds a plain key spread over lines; this reader would keep the break.
      if (/[\r\n]/.test(key)) divergent(`a key over more than one line ('${key.replace(/\s+/g, " ")}')`);
    }
    refuseDivergentKey(rawKey, key);
    flowSkipSpace(c);
    if (c.s[c.i] !== ":") unclassifiable();
    c.i++;
    // #605: a repeated key is refused where it can carry a record (the root, a verified entry).
    if (ctx.strict && Object.prototype.hasOwnProperty.call(out, key)) duplicateKey(key);
    // A root flow mapping gets the block form's checks: each of its keys decides for its own value.
    const child: FlowCtx = ctx.root
      ? { strict: ctx.strict, guarded: guardedKey(key), root: false, owner: key }
      : { ...ctx, root: false };
    out[key] = flowParseValue(c, child);
    flowSkipSpace(c);
    if (c.i >= c.s.length) unclassifiable();
    if (c.s[c.i] === ",") {
      c.i++;
      flowSkipSpace(c);
      if (c.s[c.i] === "}") {
        c.i++;
        return out;
      }
      continue;
    }
    if (c.s[c.i] === "}") {
      c.i++;
      return out;
    }
    unclassifiable();
  }
}

/** Parse a complete flow collection occupying the whole of `text`. */
function parseFlow(text: string, ctx: FlowCtx = LOOSE_FLOW): GuardValue {
  const c: FlowCursor = { s: text, i: 0 };
  const v = flowParseValue(c, ctx);
  flowSkipSpace(c);
  if (c.i !== c.s.length) unclassifiable(); // trailing junk after the collection
  return v;
}

// ── block structure (recursive, indentation-aware) ──────────────────────────

/** A PLAIN key line: `key:` or `key: value`. The key is lazy so a colon in the VALUE (`title: Foo: Bar`, `url: https://x`) stays in the value. Quoted keys are handled separately by `parseKeyLine`. */
const BLOCK_KEY_RE = /^([^\s#][^:]*?):(?:[ \t]+(.*))?$/;

/**
 * Split a mapping line into its key and same-line remainder, or null if it is
 * not a key line at all. Handles a QUOTED key (`"accepted-by": x`) as well as
 * a plain one — the quoted form must be unquoted before `isAcceptedKey` sees
 * it, or an acceptance-provenance key written in quotes would read as the
 * literal `"accepted-by"` and slip the guard. (Found by differential-testing
 * this reader against PyYAML over the real vault, where quoted numeric keys
 * `"1": …` exposed the same unquoting gap.)
 */
function parseKeyLine(body: string): { key: string; rest: string; raw: string } | null {
  if (body.startsWith('"') || body.startsWith("'")) {
    const c: FlowCursor = { s: body, i: 0 };
    const raw = flowReadQuoted(c);
    const key = unquoteIfQuoted(raw);
    if (key === null) unclassifiable();
    const after = body.slice(c.i);
    if (!after.startsWith(":")) return null;
    return { key, rest: after.slice(1).trim(), raw };
  }
  const km = BLOCK_KEY_RE.exec(body);
  if (!km) return null;
  return { key: km[1].trim(), rest: (km[2] ?? "").trim(), raw: km[1].trim() };
}

/** `- `, `-` alone, or `- value`. */
const SEQ_ITEM_RE = /^-(?:[ \t]+(.*))?$/;

class BlockReader {
  i = 0;
  /** The top-level key whose value is being read (#605: a repeated key under a `verified` key is refused). */
  top: string | null = null;

  /** Whether a repeated key is refused where the reader is now: the root, or anywhere under a `verified` key. */
  strictAt(indent: number): boolean {
    return indent === 0 || (this.top !== null && isVerifiedKey(this.top));
  }

  /** Whether the reader is inside the value of a guarded top-level key (`guardedKey`). */
  guarded(): boolean {
    return this.top !== null && guardedKey(this.top);
  }
  constructor(readonly lines: string[]) {}

  /** Index of the next significant line, or -1. Validates every line it passes over. */
  peek(): number {
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (CONTROL_CHAR_RE.test(line)) unclassifiable();
      if (isIgnorable(line)) {
        this.i++;
        continue;
      }
      if (line.trim() === "...") unclassifiable(); // document-end marker
      return this.i;
    }
    return -1;
  }

  /** A block mapping whose keys sit at column `indent`. */
  parseMapping(indent: number): Record<string, GuardValue> {
    const out: Record<string, GuardValue> = {};
    for (;;) {
      const at = this.peek();
      if (at < 0) return out;
      const line = this.lines[at];
      const ind = indentOf(line);
      if (ind < indent) return out; // dedent — belongs to a parent
      if (ind > indent) unclassifiable(); // unexpected indent inside a mapping
      const body = line.slice(ind);
      if (SEQ_ITEM_RE.test(body)) unclassifiable(); // a sequence where a mapping's key was due
      const kv = parseKeyLine(body);
      if (!kv) unclassifiable();
      refuseDivergentKey(kv.raw, kv.key);
      this.i = at + 1;
      // #605: the parser kept the LAST of two equal keys, so a forged block written
      // before the real one was compared as unchanged. A repeated key at the root,
      // or anywhere inside a `verified` record, is refused instead.
      if (Object.prototype.hasOwnProperty.call(out, kv.key) && this.strictAt(indent)) duplicateKey(kv.key);
      if (indent === 0) this.top = kv.key;
      out[kv.key] = this.parseValueAfterKey(kv.rest, indent);
    }
  }

  /** A block sequence whose `-` markers sit at column `indent`. */
  parseSequence(indent: number): GuardValue[] {
    const out: GuardValue[] = [];
    for (;;) {
      const at = this.peek();
      if (at < 0) return out;
      const line = this.lines[at];
      const ind = indentOf(line);
      if (ind !== indent) return out;
      const body = line.slice(ind);
      const sm = SEQ_ITEM_RE.exec(body);
      if (!sm) return out;
      const content = (sm[1] ?? "").trim();

      if (content === "") {
        // `-` alone: the item's structure is on the following, more-indented lines.
        this.i = at + 1;
        const nxt = this.peek();
        if (nxt < 0 || indentOf(this.lines[nxt]) <= indent) {
          out.push(null);
          continue;
        }
        out.push(this.parseNestedBlock(indentOf(this.lines[nxt]), indent));
        continue;
      }

      // A flow collection as an item (`- {by: x}`) is a collection to YAML. Under
      // a guarded key it is read as one, so the guard sees what a reader sees;
      // elsewhere the reading stays as it was.
      if (this.guarded() && (content.startsWith("{") || content.startsWith("["))) {
        this.i = at + 1;
        const text = this.gatherContinuation(content, indent, "");
        if (text !== content) divergent(`a flow value over more than one line under '${this.top}'`);
        const verifiedHere = this.top !== null && isVerifiedKey(this.top);
        out.push(parseFlow(text, { strict: verifiedHere, guarded: true, root: false, owner: this.top ?? "" }));
        continue;
      }

      // `- key: value` is a MAPPING item in real YAML (only a quoted token is
      // a plain scalar that happens to contain a colon). Rewrite the `-` to a
      // space so the mapping's keys keep their true column, then recurse —
      // this is what makes `- title: Foo` + `  date: X` read as ONE item.
      if (parseKeyLine(content)) {
        const keyCol = line.length - line.slice(ind).replace(/^-[ \t]+/, "").length;
        const rewritten = " ".repeat(keyCol) + content;
        const saved = this.lines[at];
        (this.lines as string[])[at] = rewritten;
        this.i = at;
        try {
          out.push(this.parseMapping(keyCol));
        } finally {
          (this.lines as string[])[at] = saved;
        }
        continue;
      }

      // A plain/quoted scalar item, possibly continued on more-indented lines.
      this.i = at + 1;
      out.push(this.finishScalar(content, indent));
    }
  }

  /** Whatever block structure begins at `childIndent`: a sequence or a mapping. */
  parseNestedBlock(childIndent: number, parentIndent: number): GuardValue {
    const at = this.peek();
    if (at < 0) return null;
    const body = this.lines[at].slice(childIndent);
    if (SEQ_ITEM_RE.test(body)) return this.parseSequence(childIndent);
    if (childIndent <= parentIndent) unclassifiable();
    return this.parseMapping(childIndent);
  }

  /** The value for `key:` whose same-line remainder was `rest`. */
  parseValueAfterKey(rest: string, keyIndent: number): GuardValue {
    if (rest !== "") {
      // Block scalar header: `|`, `>`, with optional chomping/indent indicators.
      const bs = /^([|>])([+-]?\d*|\d*[+-]?)\s*$/.exec(rest);
      if (bs) {
        if (this.guarded()) divergent(`a block scalar under '${this.top}'`);
        return this.readBlockScalar(bs[1] === ">", keyIndent);
      }
      if (rest.startsWith("[") || rest.startsWith("{")) {
        const text = this.gatherContinuation(rest, keyIndent, "");
        if (this.guarded() && text !== rest) divergent(`a flow value over more than one line under '${this.top}'`);
        const verifiedHere = this.top !== null && isVerifiedKey(this.top);
        return parseFlow(text, { strict: this.strictAt(keyIndent) && verifiedHere, guarded: this.guarded(), root: false, owner: this.top ?? "" });
      }
      return this.finishScalar(rest, keyIndent);
    }
    // `key:` with the value (if any) on following lines.
    const at = this.peek();
    if (at < 0) return null;
    const ind = indentOf(this.lines[at]);
    const body = this.lines[at].slice(ind);
    // A block sequence may sit at the key's OWN column (`tags:\n- a`) or be indented.
    if (ind >= keyIndent && SEQ_ITEM_RE.test(body)) {
      if (ind === keyIndent && this.lines[at].slice(ind).trim() === "-") {
        // fall through to the same handling; parseSequence covers it
      }
      return this.parseSequence(ind);
    }
    if (ind > keyIndent) return this.parseMapping(ind);
    return null; // dedent or sibling — the key's value is empty
  }

  /**
   * A scalar starting with `first`, plus any continuation lines indented past
   * `ownerIndent` (YAML folds a multi-line plain or quoted scalar onto one
   * line, joined by a space).
   */
  finishScalar(first: string, ownerIndent: number): GuardValue {
    const text = this.gatherContinuation(first, ownerIndent, " ");
    if (this.guarded()) {
      // YAML folds a continued scalar (a blank line to a line break, a quoted
      // line end after a backslash to nothing); this reader joins with a space.
      if (text !== first) divergent(`a value over more than one line under '${this.top}'`);
      refuseDivergentGuardedValue(text, this.top as string);
    }
    return scalarToken(text);
  }

  /** `first` plus every following line indented past `ownerIndent`, joined by `sep`. */
  gatherContinuation(first: string, ownerIndent: number, sep: string): string {
    let acc = first;
    for (;;) {
      const at = this.peek();
      if (at < 0) return acc;
      const line = this.lines[at];
      const ind = indentOf(line);
      if (ind <= ownerIndent) return acc;
      const body = line.slice(ind);
      // A more-indented `- item` or `key:` line is structure, not continuation.
      if (SEQ_ITEM_RE.test(body) || parseKeyLine(body)) return acc;
      acc += sep + body.trim();
      this.i = at + 1;
    }
  }

  /** A `|`/`>` block scalar: the following lines indented past `ownerIndent`. */
  readBlockScalar(folded: boolean, ownerIndent: number): string {
    const parts: string[] = [];
    let contentIndent = -1;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (CONTROL_CHAR_RE.test(line)) unclassifiable();
      if (line.trim() === "") {
        // A blank line inside a block scalar is content; peek ahead to see if
        // the scalar actually continues before keeping it.
        let j = this.i + 1;
        while (j < this.lines.length && this.lines[j].trim() === "") j++;
        if (j >= this.lines.length || indentOf(this.lines[j]) <= ownerIndent) break;
        parts.push("");
        this.i++;
        continue;
      }
      const ind = indentOf(line);
      if (ind <= ownerIndent) break;
      if (contentIndent < 0) contentIndent = ind;
      parts.push(line.slice(Math.min(ind, contentIndent)));
      this.i++;
    }
    return parts.join(folded ? " " : "\n").trim();
  }
}

/**
 * Parse the leading `---\n…\n---` frontmatter fence of `markdown` into a plain
 * object suitable for `acceptTransitionReason` / `acceptForbiddenReason`.
 *
 * Returns `null` when there is no leading fence (matching `frontmatterOf`) —
 * that is "confidently no frontmatter", not "couldn't tell". Once a fence HAS
 * matched, the whole block is parsed into a tree (nested mappings, sequences,
 * flow collections, block scalars) so the acceptance predicate can see every
 * key and value in it; a line that cannot be confidently classified throws
 * `AcceptForbiddenError` rather than being silently dropped. See the block
 * comment above for exactly what is parsed and what is refused.
 */
export function parseGuardFrontmatter(markdown: string): Record<string, unknown> | null {
  // main's #146 factored the ONE fence recognizer out as leadingFrontmatterBlock
  // ("callers must pass the bytes that will actually be honored, never a
  // normalized copy"). Bind to it rather than re-deriving the fence here — the
  // whole point of that factoring is that a third copy cannot drift.
  const block = leadingFrontmatterBlock(markdown);
  if (block === null) return null;
  const reader = new BlockReader(block.split(/\r?\n/));

  // A FLOW collection at the document root -- `{}` is the real-world instance
  // (an Apple Notes import writes notes whose entire frontmatter is `{}`). It
  // is a collection, not a block key line, so the block reader below would
  // refuse it; refusing is wrong, because `{}` and `[]` assert nothing at all.
  const first = reader.peek();
  const firstBody = first < 0 ? "" : reader.lines[first].slice(indentOf(reader.lines[first]));
  if (firstBody.startsWith("{") || firstBody.startsWith("[")) {
    const rest = reader.lines.slice(first);
    for (const line of rest) {
      if (CONTROL_CHAR_RE.test(line)) unclassifiable();
      if (line.trim().startsWith("#")) unclassifiable(); // a comment inside a flow collection
    }
    const v = parseFlow(rest.join("\n"), { strict: true, guarded: false, root: true, owner: "" });
    // A MAPPING root is what Obsidian honors as properties, so parse it and let
    // the predicate inspect it. A SEQUENCE root is not honored as properties at
    // all: an EMPTY one provably carries no assertion, so report "no keys"; a
    // NON-empty one is left to fail closed rather than guessed at.
    if (Array.isArray(v)) {
      if (v.length > 0) unclassifiable();
      return {};
    }
    if (!v || typeof v !== "object") unclassifiable();
    return v as Record<string, unknown>;
  }

  const out = reader.parseMapping(0);
  // A dedent below column 0 is impossible, so anything left unconsumed means
  // the reader lost its place rather than finished.
  if (reader.peek() >= 0) unclassifiable();
  return out;
}
