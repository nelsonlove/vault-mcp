// replace-text.ts — the plan behind `obsidian_replace_text`: replace one exact string in one note
// (or every occurrence with `all: true`), and refuse what a replace must not do. Pure: it takes the
// note's text and returns the text to write, or throws a typed refusal. Both backends call it, then
// write the result through their own whole-note `writeNote`, so the accept guard, the protected
// properties and the frontmatter floor run on the result exactly as on `obsidian_write_note`; no
// guard is copied here.
//
// Matching is on the exact text (no regex, no case folding, no newline normalisation), counted on
// the note's own text from left to right, and matches never overlap: after a match the search
// goes on from its end. In a note with CRLF line endings an `old` that spans lines must use "\r\n".
// A leading byte-order mark is part of the note's text but is never matched or removed.
//
// What this module adds to the whole-note guards, because a text edit can reach places a
// whole-note write would leave to the author:
//   - the FRONTMATTER rule: a match must lie wholly in the body, or wholly inside the YAML between
//     the two `---` fences (the line break before the closing fence included); it may not touch a
//     fence. A replace inside the YAML must leave the
//     same block (the same closing fence) holding one YAML mapping that parses. A note with no
//     frontmatter may not gain one. (obsidian_manage_frontmatter edits one key and always leaves a
//     valid block; this keeps a text edit to the same shape, and the acceptance rules run on the
//     result through writeNote.)
//   - the LONG-NOTE rule: on a note longer than the read limit, a match that ends past the limit
//     is refused unless the transport proved a whole read of the note at the rev the call names
//     (the anchored road's rule, `assertPatchRangeRead`, applied to each match).
//   - the cut-read rule over the caller's `new` text (`assertNotTruncatedRead`).

import { parseDocument, isMap } from "yaml";
import { LEADING_FRONTMATTER_RE } from "./accept-guard.js";
import { assertNotTruncatedRead, TruncatedReadError } from "./truncation.js";

/** The tool's name, on both servers. */
export const REPLACE_TEXT_TOOL = "obsidian_replace_text";

/** Characters of context shown on each side of a changed span. */
export const REPLACE_SPAN_CONTEXT = 40;
/** Longest `old` or `new` text shown in a span; a longer one is shown as its head and tail. */
export const REPLACE_SPAN_TEXT_CAP = 400;
/** Most spans listed in a result; `spans_truncated` says when there were more. */
export const REPLACE_MAX_SPANS = 20;

export type ReplaceTextCode = "no_match" | "many_matches" | "invalid_replace" | "frontmatter_edit";
const NO_MATCH: ReplaceTextCode = "no_match";
const MANY_MATCHES: ReplaceTextCode = "many_matches";
const INVALID_REPLACE: ReplaceTextCode = "invalid_replace";
const FRONTMATTER_EDIT: ReplaceTextCode = "frontmatter_edit";

/** A typed refusal: rendered `Error [code]: …`. Nothing was written. */
export class ReplaceTextError extends Error {
  readonly code: ReplaceTextCode;
  /** How many times `old` was found, for `no_match` and `many_matches`. */
  readonly count?: number;
  constructor(code: ReplaceTextCode, message: string, count?: number) {
    super(message);
    this.name = "ReplaceTextError";
    this.code = code;
    if (count !== undefined) this.count = count;
  }
}

/** One changed span: where it was, and the text around it before and after. */
export interface ReplaceSpan {
  /** Character offset of the match in the note as it was. */
  offset: number;
  /** 1-based line of the match in the note as it was. */
  line: number;
  /** Context + `old` + context, from the note as it was. */
  before: string;
  /** Context + `new` + context, from the note as written. */
  after: string;
}

export interface ReplaceTextResult {
  path: string;
  /** How many matches were replaced. */
  count: number;
  /** Whether a match was inside the frontmatter block. */
  frontmatter_touched: boolean;
  /** The note's line endings, so a caller whose `old` found nothing can see why. */
  line_endings: "lf" | "crlf" | "mixed" | "none";
  spans: ReplaceSpan[];
  /** True when there were more than REPLACE_MAX_SPANS matches and only the first are listed. */
  spans_truncated: boolean;
}

export interface ReplacePlanOpts {
  all: boolean;
  /** The read limit (CHARACTER_LIMIT). */
  limit: number;
  /** The transport proved a whole read of this note at its current rev (#443); the long-note rule stands aside. */
  rangeRuleStandsAside?: boolean;
}

/** Start offsets of `old` in `text`, left to right, never overlapping. */
export function findMatches(text: string, old: string): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  let at = text.indexOf(old, 0);
  while (at !== -1) {
    out.push(at);
    at = text.indexOf(old, at + old.length);
  }
  return out;
}

function lineEndings(text: string): ReplaceTextResult["line_endings"] {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  if (crlf === 0 && lf === 0) return "none";
  if (crlf === 0) return "lf";
  if (lf === 0) return "crlf";
  return "mixed";
}

/** Where the leading frontmatter block is, by the ONE recognizer the accept guard uses. */
interface FmRegion {
  /** Offset where the YAML between the fences starts. */
  innerStart: number;
  /** Offset where it ends (the line break before the closing fence). */
  innerEnd: number;
  /** Offset of the closing fence's `---`. */
  closeAt: number;
  /** Offset just past the closing fence's line, its line break included. */
  blockEnd: number;
}

function frontmatterRegion(text: string): FmRegion | null {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stripped = bom ? text.slice(1) : text;
  const m = LEADING_FRONTMATTER_RE.exec(stripped);
  if (!m) return null;
  const opening = /^---[ \t]*(?:\r\n|\n|\r)/.exec(stripped);
  if (!opening) return null;
  const innerStart = bom + opening[0].length;
  const innerEnd = innerStart + m[1].length;
  // The rest of the closing fence's line, and its line break, belong to the block.
  const closeAt = bom + m[0].length - 3;
  let blockEnd = bom + m[0].length;
  const rest = /^[^\r\n]*(?:\r\n|\n|\r)?/.exec(text.slice(blockEnd));
  blockEnd += rest ? rest[0].length : 0;
  return { innerStart, innerEnd, closeAt, blockEnd };
}

/** `s` cut to the cap as its head and tail, never splitting a surrogate pair. */
function capped(s: string): string {
  if (s.length <= REPLACE_SPAN_TEXT_CAP) return s;
  const half = REPLACE_SPAN_TEXT_CAP / 2;
  let a = half;
  if (isHigh(s.charCodeAt(a - 1))) a--;
  let b = s.length - half;
  if (isLow(s.charCodeAt(b))) b++;
  return `${s.slice(0, a)}…[${s.length - a - (s.length - b)} chars]…${s.slice(b)}`;
}
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** `text[a, b)` with context on each side, the context never splitting a surrogate pair. */
function spanText(text: string, a: number, b: number): string {
  let l = Math.max(0, a - REPLACE_SPAN_CONTEXT);
  if (l > 0 && isLow(text.charCodeAt(l))) l--;
  let r = Math.min(text.length, b + REPLACE_SPAN_CONTEXT);
  if (r < text.length && isLow(text.charCodeAt(r))) r++;
  return text.slice(l, a) + capped(text.slice(a, b)) + text.slice(b, r);
}

/**
 * Plan the replace: the text to write and the result to return, or a typed refusal. The caller
 * writes `text` through its whole-note write (the accept guard and protected properties run there).
 */
export function planReplaceText(
  path: string,
  text: string,
  old: string,
  replacement: string,
  opts: ReplacePlanOpts,
): { text: string; result: ReplaceTextResult } {
  if (old.length === 0) throw new ReplaceTextError(INVALID_REPLACE, "`old` is empty; it must name the exact text to replace. Nothing was written.");
  if (old === replacement) throw new ReplaceTextError(INVALID_REPLACE, "`old` and `new` are the same text, so nothing would change. Nothing was written.");
  // A cut read handed back as the replacement is refused first (#441), as on every text-taking write.
  assertNotTruncatedRead(path, replacement);

  const starts = findMatches(text, old);
  const endings = lineEndings(text);
  if (starts.length === 0) {
    const hint =
      old.includes("\n") && !old.includes("\r\n") && endings !== "lf" && endings !== "none"
        ? " The note has CRLF line endings: an `old` that spans lines must use \"\\r\\n\"."
        : "";
    throw new ReplaceTextError(
      NO_MATCH,
      `'${path}': \`old\` was found 0 times (exact text, case and line endings as written).${hint} Nothing was written. Read the note again and copy the text exactly.`,
      0,
    );
  }
  if (starts.length > 1 && !opts.all) {
    const lineOf = (o: number) => text.slice(0, o).split("\n").length;
    const lines = starts.slice(0, 10).map(lineOf).join(", ");
    throw new ReplaceTextError(
      MANY_MATCHES,
      `'${path}': \`old\` was found ${starts.length} times (at lines ${lines}${starts.length > 10 ? ", …" : ""}). Nothing was written. Add context to \`old\` so it is found once, or pass all: true to replace all ${starts.length}.`,
      starts.length,
    );
  }

  // The byte-order mark stays.
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (bom && starts[0] < bom) {
    throw new ReplaceTextError(INVALID_REPLACE, `'${path}': the match starts with the note's byte-order mark, which a replace does not remove or change. Nothing was written. Leave the mark out of \`old\`.`);
  }

  // The long-note rule: each match must end inside what a cut read showed, unless the whole read is proven.
  if (text.length > opts.limit && !opts.rangeRuleStandsAside) {
    const lastEnd = starts[starts.length - 1] + old.length;
    if (lastEnd > opts.limit) {
      throw new TruncatedReadError(
        path,
        `'${path}' is ${text.length} chars, longer than the read limit of ${opts.limit}, and a match ends at character ${lastEnd}, past what a cut read showed. Nothing was written. ` +
          "Read the note whole first (obsidian_read_note with full: true, on the live Obsidian server), then call again with that read's rev as if_rev and a NEW idempotency_key; or narrow `old` to a match inside the first part.",
      );
    }
  }

  // The frontmatter rule: each match wholly in the body, or wholly inside the YAML; never on a fence.
  const fm = frontmatterRegion(text);
  let fmDelta = 0;
  let touched = false;
  for (const s of starts) {
    const e = s + old.length;
    if (!fm) continue;
    if (s >= fm.blockEnd) continue;
    // Inside the YAML; a match may take the line break before the closing fence (to remove a
    // last line whole), and the check after the edit makes sure the fence is still there.
    if (s >= fm.innerStart && e <= fm.closeAt) {
      touched = true;
      fmDelta += replacement.length - old.length;
      continue;
    }
    throw new ReplaceTextError(
      FRONTMATTER_EDIT,
      `'${path}': a match at character ${s} touches a frontmatter fence (the '---' lines) or crosses from the frontmatter into the body. Nothing was written. ` +
        "A replace may change text inside the frontmatter or inside the body, never the fences; use obsidian_manage_frontmatter to change a property.",
    );
  }

  let next = "";
  let from = 0;
  for (const s of starts) {
    next += text.slice(from, s) + replacement;
    from = s + old.length;
  }
  next += text.slice(from);

  const after = frontmatterRegion(next);
  if (!fm && after) {
    throw new ReplaceTextError(
      FRONTMATTER_EDIT,
      `'${path}': the note has no frontmatter, and this replace would give it a frontmatter block. Nothing was written. Use obsidian_manage_frontmatter to add a property.`,
    );
  }
  if (fm) {
    // The same block: same opening, and the closing fence where the edits put it.
    if (!after || after.innerStart !== fm.innerStart || after.closeAt !== fm.closeAt + fmDelta) {
      throw new ReplaceTextError(
        FRONTMATTER_EDIT,
        `'${path}': this replace would move or remove the frontmatter's closing fence (the new text holds a '---' line, or the block would no longer be recognized). Nothing was written. Use obsidian_manage_frontmatter to change a property.`,
      );
    }
    if (touched) {
      const yaml = next.slice(after.innerStart, after.innerEnd);
      const doc = parseDocument(yaml, { uniqueKeys: true, prettyErrors: false });
      const empty = doc.contents === null;
      if (doc.errors.length > 0 || (!empty && !isMap(doc.contents))) {
        const why = doc.errors.length > 0 ? doc.errors[0].message.split("\n")[0] : "the block is not a mapping of keys to values";
        throw new ReplaceTextError(
          FRONTMATTER_EDIT,
          `'${path}': after this replace the frontmatter would not parse as YAML properties (${why}). Nothing was written. Use obsidian_manage_frontmatter to change a property.`,
        );
      }
    }
  }

  const delta = replacement.length - old.length;
  const spans: ReplaceSpan[] = starts.slice(0, REPLACE_MAX_SPANS).map((s, i) => {
    const s2 = s + i * delta;
    return {
      offset: s,
      line: text.slice(0, s).split("\n").length,
      before: spanText(text, s, s + old.length),
      after: spanText(next, s2, s2 + replacement.length),
    };
  });
  return {
    text: next,
    result: {
      path,
      count: starts.length,
      frontmatter_touched: touched,
      line_endings: endings,
      spans,
      spans_truncated: starts.length > REPLACE_MAX_SPANS,
    },
  };
}
