// note-sections.ts — where a heading's section or a `^id` block sits in a
// note's text, found on the text itself (#593).
//
// `obsidian_patch_note` and `obsidian_append_at_heading` write into a note at
// a heading or a block. The live host used to take those positions from
// Obsidian's metadata cache while it took the text from disk; after a write
// the cache describes the previous text until Obsidian parses the file
// again, so a second patch soon after the first cut the new text at the old
// offsets. The filesystem server read the text but took any `#` line,
// including one inside a code fence, for a heading.
//
// This module is the one parser both servers use. It reads the exact text a
// call just read, and:
//
//   - skips the leading front matter (the same recognizer the accept guard
//     uses, `LEADING_FRONTMATTER_RE`);
//   - hides what Obsidian does not parse as Markdown blocks: code fences
//     (``` or ~~~, three or more, an info string allowed, closed by the same
//     character at least as long, or open to the end), `$$` math blocks,
//     `%%` comment blocks and HTML blocks (`<!-- … -->`, `<script>`-like
//     elements, and CommonMark's tag blocks, which run to the next blank
//     line);
//   - finds ATX headings (`#` to `######`, up to three spaces of indent, a
//     space or the line end after the hashes, a closing run of hashes
//     dropped), and setext headings (a one-line paragraph over a `===` or
//     `---` underline) where the line plainly starts a block. Obsidian reads
//     setext headings too, so they end sections as ATX ones do; a setext
//     heading in the middle of a paragraph is not looked for;
//   - finds `^id` block ids at the end of a line.
//
// A heading's text is what Obsidian's cache calls `heading`: the inline
// content, trimmed, without the closing hashes.
//
// `verifyCachedHeadings` and `verifyCachedBlock` let the live host keep using
// the cache when it still describes the text: then the section and the bytes
// written are exactly what they were before this module. When the cache and
// the text disagree, the host takes the positions this parser finds instead,
// and never writes at an offset it has not checked.
//
// Obsidian-free and pure, so both servers and the tests share it.

import { LEADING_FRONTMATTER_RE } from "./accept-guard.js";
import { FENCE_LEAD, FenceTracker, INTERRUPTS } from "./fences.js";

/** One heading found in the text. Offsets index the text the outline was
 *  made from; `end` is the end of the heading's last line (the underline for
 *  a setext heading), before its line break. */
export interface TextHeading {
  heading: string;
  level: number;
  /** First line of the heading (0-based). */
  line: number;
  /** Last line of the heading: `line`, or the underline of a setext one. */
  lastLine: number;
  start: number;
  end: number;
  /** Indent of the first `#`, in spaces; 0 for a heading at the line start. */
  indent: number;
  setext: boolean;
}

/** The parsed shape of one note's text. */
export interface NoteOutline {
  /** The text split on `\n`; a line keeps any `\r` it ends with. */
  lines: string[];
  /** Offset of the first character of each line. */
  lineStarts: number[];
  /** First line after the front matter (0 when there is none). */
  bodyLine: number;
  /** True for a line inside (or opening or closing) a fence, a math block, a
   *  comment block or an HTML block, and for a front-matter line. */
  hidden: boolean[];
  /** True for a line that is part of a heading. */
  headingLine: boolean[];
  /** For a line on which a `%%` comment closes, the column after the
   *  closing `%%` (Obsidian reads the rest as a new block); else -1. */
  commentClose: number[];
  headings: TextHeading[];
}

const MATH_OPEN = /^ {0,3}(\${2,})[^$]*$/;
const COMMENT_OPEN = /^ {0,3}%%[^%]*$/;
const HTML_RAW_OPEN = /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i;
const HTML_COMMENT_OPEN = /^ {0,3}<!--/;
// CommonMark's HTML block kinds 6 (a block-level tag, which may interrupt a
// paragraph) and 7 (a line that is one whole tag, which may not); both run
// to the next blank line.
const HTML_BLOCK_TAGS = new Set("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul".split(" "));
const HTML_TAG6_OPEN = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|\/?>|$)/;
const HTML_TAG7_LINE = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][\w.:-]*(?:[ \t]*=[ \t]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;
const ATX = /^( {0,3})(#{1,6})(?=[ \t]|$)(.*)$/;
// Obsidian's setext underline is the marker alone: no indent, nothing after.
const SETEXT_UNDERLINE = /^(=+|-+)$/;
const LIST_ITEM = /^ *(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const QUOTE = /^ {0,3}>/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const BLOCK_ID_AT_END = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/;

function bare(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The heading text of an ATX line's content (after the hashes): the
 *  closing run of hashes dropped, then trimmed. */
function atxText(content: string): string {
  const stripped = content.replace(/(?:^|[ \t])#+[ \t]*$/, "");
  return stripped.trim();
}

/** Parse one line as an ATX heading, or null. */
export function parseAtxLine(line: string): { level: number; heading: string; indent: number } | null {
  const m = ATX.exec(bare(line));
  if (!m) return null;
  return { level: m[2].length, heading: atxText(m[3]), indent: m[1].length };
}

function frontmatterEnd(text: string): number {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const m = LEADING_FRONTMATTER_RE.exec(bom ? text.slice(1) : text);
  return m ? bom + m[0].length : -1;
}

/**
 * Outline `text`: its lines, the lines hidden from Markdown, and its headings.
 * `frontmatter: false` treats the whole text as body (a caller that has cut
 * the front matter off already).
 */
export function outlineNote(text: string, opts: { frontmatter?: boolean } = {}): NoteOutline {
  const lines = text.split("\n");
  const lineStarts: number[] = new Array(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    lineStarts[i] = off;
    off += lines[i].length + 1;
  }
  const hidden: boolean[] = new Array(lines.length).fill(false);
  const headingLine: boolean[] = new Array(lines.length).fill(false);
  const headings: TextHeading[] = [];

  let bodyLine = 0;
  if (opts.frontmatter !== false) {
    const fmEnd = frontmatterEnd(text);
    if (fmEnd >= 0) {
      // The closing fence's line is front matter too, whatever follows the
      // dashes on it.
      let i = 0;
      while (i + 1 < lines.length && lineStarts[i + 1] <= fmEnd) i++;
      bodyLine = i + 1;
      for (let j = 0; j < bodyLine && j < lines.length; j++) hidden[j] = true;
    }
  }

  // Fences follow the shared rule (`fences.ts`, the one the link rewriter
  // uses), stepped here line by line so that, as in Obsidian, a fence opens
  // only where a block can start: never inside a `%%` comment or `$$` math,
  // and a `%%` inside a fence is code.
  const fence = new FenceTracker();

  type Open =
    | { kind: "math"; len: number }
    | { kind: "comment" }
    | { kind: "html-raw"; tag: string }
    | { kind: "html-comment" }
    | { kind: "html-block" };
  let open: Open | null = null;
  // What the line before was: a block may start (a setext heading or an
  // HTML block) only after a blank line, a heading, a closed hidden block or
  // the start of the body.
  let prev: "start" | "blank" | "boundary" | "text" = "start";
  // The list items the line may be inside, as their content columns (the
  // marker's indent and width plus the spaces after it), outermost first. A
  // heading inside an item belongs to the item, and Obsidian does not list
  // it among the note's headings.
  const items: number[] = [];

  // A line on which a `%%` comment closes: where the text after the closing
  // `%%` starts. Obsidian parses that rest as a new block (it may be a heading).
  const commentClose: number[] = new Array(lines.length).fill(-1);
  // The rest of line `i` after column `c`, read as the start of a block: an
  // ATX heading, or a setext heading over the next line. Returns the lines
  // consumed after `i`.
  const restOfLine = (i: number, c: number): number => {
    const rest = bare(lines[i]).slice(c);
    if (rest.trim() === "") { prev = "boundary"; return 0; }
    const atx = parseAtxLine(rest);
    if (atx) {
      headings.push({ heading: atx.heading, level: atx.level, line: i, lastLine: i, start: lineStarts[i] + c, end: lineStarts[i] + bare(lines[i]).length, indent: atx.indent, setext: false });
      headingLine[i] = true;
      prev = "boundary";
      return 0;
    }
    const u = i + 1 < lines.length ? SETEXT_UNDERLINE.exec(bare(lines[i + 1])) : null;
    if (u) {
      headings.push({ heading: rest.trim(), level: u[1][0] === "=" ? 1 : 2, line: i, lastLine: i + 1, start: lineStarts[i] + c, end: lineStarts[i + 1] + bare(lines[i + 1]).length, indent: 0, setext: true });
      headingLine[i] = headingLine[i + 1] = true;
      prev = "boundary";
      return 1;
    }
    prev = "text";
    return 0;
  };

  for (let i = bodyLine; i < lines.length; i++) {
    const s = bare(lines[i]);
    if (!open && fence.isOpen) {
      const st = fence.step(lines[i], lines[i + 1], { column: items.length ? items[items.length - 1] : 0 });
      if (st.kind !== "none") {
        hidden[i] = true;
        if (st.kind === "close") prev = "boundary";
        continue;
      }
      // The fence's container ended before this line: read it as usual.
      prev = "boundary";
    }
    if (open) {
      hidden[i] = true;
      switch (open.kind) {
        case "math": {
          const t = s.replace(/[ \t]+$/, "");
          let n = 0;
          while (n < t.length && t[t.length - 1 - n] === "$") n++;
          if (n >= open.len && t.indexOf("$") === t.length - n) { open = null; prev = "boundary"; }
          break;
        }
        case "comment": {
          const at = s.indexOf("%%");
          if (at >= 0) {
            open = null;
            commentClose[i] = at + 2;
            i += restOfLine(i, at + 2);
          }
          break;
        }
        case "html-raw":
          if (s.toLowerCase().includes(`</${open.tag}>`)) { open = null; prev = "boundary"; }
          break;
        case "html-comment":
          if (s.includes("-->")) { open = null; prev = "boundary"; }
          break;
        case "html-block":
          if (s.trim() === "") { hidden[i] = false; open = null; prev = "blank"; }
          break;
      }
      continue;
    }

    if (s.trim() === "") { prev = "blank"; continue; }

    // Indentation in columns: a tab moves to the next multiple of four.
    const indent = /^[ \t]*/.exec(s)![0].split("").reduce((col, ch) => (ch === "\t" ? col + 4 - (col % 4) : col + 1), 0);
    const top = () => (items.length ? items[items.length - 1] : 0);
    const listItem = LIST_ITEM.test(s) && !THEMATIC_BREAK.test(s) && indent <= top() + 3;
    // A lazy line: plain text right after text, which stays in the item
    // whatever its indent. A heading, a break, a fence, a comment or an item
    // is never lazy.
    const lazy = prev === "text" && !listItem && !INTERRUPTS.test(s.replace(/^[ \t]*/, ""));
    if (!lazy) while (items.length && indent < top()) items.pop();
    const lazyInList = lazy && items.length > 0 && indent < top();
    // The content column the line is in, before any item it opens.
    const column = top();
    if (listItem) {
      const m = /^( *)([-+*]|\d{1,9}[.)])([ \t]*)/.exec(s)!;
      const gap = m[3].length;
      items.push(m[1].length + m[2].length + (gap === 0 || gap > 4 ? 1 : gap));
    }
    const nested = items.length > 0;
    // Indented code (four spaces past the content column, at the start of a
    // block): nothing opens inside it.
    if (!listItem && indent >= column + 4 && prev !== "text") { prev = "boundary"; continue; }
    const math = lazyInList ? null : MATH_OPEN.exec(s);
    if (math) {
      hidden[i] = true;
      open = { kind: "math", len: math[1].length };
      continue;
    }
    if (COMMENT_OPEN.test(s)) {
      hidden[i] = true;
      open = { kind: "comment" };
      continue;
    }
    if (fence.step(lines[i], lines[i + 1], { column }).kind === "open") {
      hidden[i] = true;
      continue;
    }
    const atx = nested ? null : parseAtxLine(s);
    if (atx) {
      headings.push({
        heading: atx.heading, level: atx.level, line: i, lastLine: i,
        start: lineStarts[i], end: lineStarts[i] + s.length, indent: atx.indent, setext: false,
      });
      headingLine[i] = true;
      prev = "boundary";
      continue;
    }

    if (THEMATIC_BREAK.test(s)) { prev = "boundary"; continue; }

    // A setext heading: one line that plainly starts a paragraph, over an
    // underline. Anything that could be a list, a quote, a table row, a
    // thematic break or a lazy continuation is left alone. Obsidian tries a
    // setext heading before an HTML block, and a line that opens an HTML
    // block may interrupt a paragraph, so such a line over an underline is a
    // heading even right after text.
    // A lazy line of a list item's paragraph opens no HTML block either.
    const htmlInterrupts = !lazyInList && (HTML_RAW_OPEN.test(s) || HTML_COMMENT_OPEN.test(s) || ((t) => !!t && HTML_BLOCK_TAGS.has(t[1].toLowerCase()))(HTML_TAG6_OPEN.exec(s)));
    // A setext heading may also interrupt a quote: the line after a quote
    // line, not itself quoted.
    const afterQuote = i > bodyLine && QUOTE.test(bare(lines[i - 1])) && !QUOTE.test(s);
    if (
      (prev !== "text" || htmlInterrupts || afterQuote) && !nested && i + 1 < lines.length &&
      /^ {0,3}\S/.test(s) && !LIST_ITEM.test(s) && !QUOTE.test(s)
    ) {
      const u = SETEXT_UNDERLINE.exec(bare(lines[i + 1]));
      if (u) {
        const under = bare(lines[i + 1]);
        headings.push({
          heading: s.trim(), level: u[1][0] === "=" ? 1 : 2, line: i, lastLine: i + 1,
          start: lineStarts[i], end: lineStarts[i + 1] + under.length, indent: 0, setext: true,
        });
        headingLine[i] = headingLine[i + 1] = true;
        i++;
        prev = "boundary";
        continue;
      }
    }

    const raw = lazyInList ? null : HTML_RAW_OPEN.exec(s);
    if (raw) {
      hidden[i] = true;
      const tag = raw[1].toLowerCase();
      if (!s.toLowerCase().includes(`</${tag}>`)) open = { kind: "html-raw", tag };
      else prev = "boundary";
      continue;
    }
    if (!lazyInList && HTML_COMMENT_OPEN.test(s)) {
      hidden[i] = true;
      if (!s.slice(s.indexOf("<!--") + 4).includes("-->")) open = { kind: "html-comment" };
      else prev = "boundary";
      continue;
    }
    const tag6 = lazyInList ? null : HTML_TAG6_OPEN.exec(s);
    if ((tag6 && HTML_BLOCK_TAGS.has(tag6[1].toLowerCase())) || (prev !== "text" && HTML_TAG7_LINE.test(s))) {
      hidden[i] = true;
      open = { kind: "html-block" };
      continue;
    }

    prev = "text";
  }

  return { lines, lineStarts, bodyLine, hidden, headingLine, commentClose, headings };
}

/** A heading's section: from just after the heading to the next heading of
 *  the same or a higher level (outside fences), or the end of the text. */
export interface HeadingSection {
  heading: TextHeading;
  /** Index of the heading in `outline.headings`. */
  index: number;
  /** Offset just after the heading's last line (before its line break). */
  start: number;
  /** Offset of the next same-or-higher heading's first line, or the text's length. */
  end: number;
  /** First line after the heading. */
  startLine: number;
  /** First line of the next same-or-higher heading, or the line count. */
  endLine: number;
}

/** The first heading whose text is exactly `headingText`, and its section;
 *  undefined when no heading has that text. */
export function findHeadingSection(outline: NoteOutline, textLength: number, headingText: string): HeadingSection | undefined {
  const { headings } = outline;
  const at = sectionAt(headings, textLength, headingText);
  if (!at) return undefined;
  const h = headings[at.index];
  const endLine = at.next < 0 ? outline.lines.length : headings[at.next].line;
  return { heading: h, index: at.index, start: at.start, end: at.end, startLine: h.lastLine + 1, endLine };
}

/** A `^id` block found in the text. */
export interface TextBlock {
  id: string;
  /** The line carrying the `^id`. */
  anchorLine: number;
  /** First line of the block. */
  startLine: number;
  /** One past the last line of the block. */
  endLine: number;
  /** Offset of the block's first line. */
  start: number;
  /** End of the block's last line, before its line break. */
  end: number;
  /** True when the id stands alone on its line after a blank line, and so
   *  names the block above it (Obsidian gives it to the previous block). */
  standalone: boolean;
}

function isBlankLine(outline: NoteOutline, i: number): boolean {
  return bare(outline.lines[i]).trim() === "";
}

/** Can line `i` belong to a block's run of lines? Not blank, not hidden,
 *  not a heading, and inside the body. */
function inRun(outline: NoteOutline, i: number): boolean {
  return i >= outline.bodyLine && i < outline.lines.length && !outline.hidden[i] && !outline.headingLine[i] && !isBlankLine(outline, i);
}

/**
 * The first block whose `^id` the predicate accepts. The id must end its
 * line (after a space, or alone on the line), outside fences and the front
 * matter. The block is the run of lines around it, bounded by blank lines,
 * headings and hidden blocks; when the id sits on a list item, the block
 * starts at that item's marker line. An id alone on its line after a blank
 * line names the block above it, as Obsidian reads it: the table, list,
 * quote or paragraph run above, a fenced block, or a heading.
 */
export function findBlock(outline: NoteOutline, accept: (id: string) => boolean): TextBlock | undefined {
  const { lines, lineStarts } = outline;
  const span = (id: string, anchorLine: number, startLine: number, endLine: number, standalone: boolean): TextBlock => ({
    id, anchorLine, startLine, endLine, standalone,
    start: lineStarts[startLine],
    end: lineStarts[endLine - 1] + bare(lines[endLine - 1]).length,
  });
  for (let i = outline.bodyLine; i < lines.length; i++) {
    if (outline.hidden[i] || outline.headingLine[i]) continue;
    const m = BLOCK_ID_AT_END.exec(bare(lines[i]));
    if (!m || !accept(m[1])) continue;
    if (bare(lines[i]).trim() === `^${m[1]}` && i - 1 >= outline.bodyLine && isBlankLine(outline, i - 1)) {
      let last = i - 1;
      while (last >= outline.bodyLine && isBlankLine(outline, last)) last--;
      if (last >= outline.bodyLine) {
        let first = last;
        if (outline.hidden[last]) {
          while (first - 1 >= outline.bodyLine && outline.hidden[first - 1]) first--;
        } else if (outline.headingLine[last]) {
          first = outline.headings.find((h) => h.lastLine === last)?.line ?? last;
        } else {
          while (inRun(outline, first - 1)) first--;
        }
        return span(m[1], i, first, last + 1, true);
      }
    }
    let startLine = i;
    while (inRun(outline, startLine - 1)) startLine--;
    let endLine = i + 1;
    while (inRun(outline, endLine)) endLine++;
    for (let j = i; j >= startLine; j--) {
      if (LIST_ITEM.test(bare(lines[j]))) { startLine = j; endLine = i + 1; break; }
    }
    return span(m[1], i, startLine, endLine, false);
  }
  return undefined;
}

// ── Checking a metadata cache against the text ─────────────────────────────

/** The parts of an Obsidian `HeadingCache` this module reads. */
export interface CachedHeading {
  heading: string;
  level: number;
  position: { start: { offset: number }; end: { offset: number } };
}

/** The parts of an Obsidian `BlockCache` this module reads. */
export interface CachedBlock {
  position: { start: { offset: number }; end: { offset: number } };
}

function lineIndexAt(outline: NoteOutline, offset: number): number {
  const { lineStarts } = outline;
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Only spaces and tabs between `from` and `to` in `text`. */
function onlyBlanks(text: string, from: number, to: number): boolean {
  return /^[ \t\r]*$/.test(text.slice(from, to));
}

/** The start and end offsets of a cache position, or null when either is
 *  missing or not a whole number (a cache entry this module cannot check). */
function offsetsOf(position: CachedHeading["position"] | undefined): [number, number] | null {
  const s = position?.start?.offset;
  const e = position?.end?.offset;
  return Number.isInteger(s) && Number.isInteger(e) ? [s as number, e as number] : null;
}

/** Is everything from the start of `offset`'s line up to `offset` a
 *  container lead (indentation, quote markers, one list marker)? */
function leadOnly(text: string, outline: NoteOutline, line: number, offset: number): boolean {
  const before = text.slice(outline.lineStarts[line], offset);
  if (before.replace(FENCE_LEAD, "") === "") return true;
  // A block that starts after a `%%` comment closes on the same line.
  const c = outline.commentClose[line];
  return c >= 0 && before.length >= c && before.slice(c).trim() === "";
}

/**
 * Does the cached heading still sit, with the same text and level, at its
 * recorded offsets in `text`? The check reads only the text at those
 * offsets, so it accepts a heading this parser would not place itself (one
 * on a list item, in a callout or quote, or a setext heading over several
 * lines): a parser gap never rejects a cache that matches the text.
 */
function cachedHeadingHolds(text: string, outline: NoteOutline, h: CachedHeading): boolean {
  const o = offsetsOf(h?.position);
  if (!o) return false;
  const [s, e] = o;
  if (s < 0 || e < s || e > text.length) return false;
  const line = lineIndexAt(outline, s);
  if (line < outline.bodyLine) return false;
  if (!leadOnly(text, outline, line, s)) return false;
  const lastLine = lineIndexAt(outline, e);
  const lastEnd = outline.lineStarts[lastLine] + bare(outline.lines[lastLine]).length;
  if (e > lastEnd || !onlyBlanks(text, e, lastEnd)) return false;
  if (lastLine === line) {
    const atx = parseAtxLine(text.slice(s, lastEnd));
    return !!atx && atx.level === h.level && atx.heading === h.heading;
  }
  // A setext heading: its text lines, then the underline on the last line
  // (after any container lead).
  const under = bare(outline.lines[lastLine]).replace(FENCE_LEAD, "");
  const u = SETEXT_UNDERLINE.exec(under);
  if (!u || (u[1][0] === "=" ? 1 : 2) !== h.level) return false;
  const body = text.slice(s, outline.lineStarts[lastLine]).replace(/\r?\n$/, "");
  const stripped = body.split("\n").map((l, k) => (k === 0 ? l : l.replace(FENCE_LEAD, ""))).join("\n");
  return body.trim() === h.heading || stripped.trim() === h.heading;
}

/**
 * Does a metadata cache's heading list still describe `text`? True when
 * every cached heading sits at its recorded offsets with its recorded text
 * and level, the list is in text order, and every heading this parser finds
 * (any form: ATX at any allowed indent, or setext) starts on a line where
 * the cache has one. The cache may hold headings this parser does not find
 * (it is the stricter Markdown reader); it may not miss one, because a
 * heading written since the cache was made would end a section early.
 */
export function verifyCachedHeadings(text: string, outline: NoteOutline, cached: readonly CachedHeading[]): boolean {
  let last = -1;
  const lines = new Set<number>();
  for (const h of cached) {
    if (!cachedHeadingHolds(text, outline, h)) return false;
    if (h.position.start.offset <= last) return false;
    last = h.position.start.offset;
    lines.add(lineIndexAt(outline, h.position.start.offset));
  }
  for (const p of outline.headings) {
    if (!lines.has(p.line)) return false;
  }
  return true;
}

/**
 * Does a cached block still sit at its recorded offsets in `text`, carrying
 * `^id` (any case) at its end or on a line of its own just after it?
 */
export function verifyCachedBlock(text: string, outline: NoteOutline, id: string, block: CachedBlock): boolean {
  const o = offsetsOf(block?.position);
  if (!o) return false;
  const [s, e] = o;
  if (s < 0 || e < s || e > text.length) return false;
  const first = lineIndexAt(outline, s);
  if (first < outline.bodyLine) return false;
  if (!leadOnly(text, outline, first, s)) return false;
  const lastLine = lineIndexAt(outline, e);
  const lastEnd = outline.lineStarts[lastLine] + bare(outline.lines[lastLine]).length;
  if (e > lastEnd || !onlyBlanks(text, e, lastEnd)) return false;
  const want = id.toLowerCase();
  const own = BLOCK_ID_AT_END.exec(text.slice(outline.lineStarts[lastLine], e));
  if (own && own[1].toLowerCase() === want) return true;
  // The id alone on a line after the block (a table or a list takes it so).
  for (let i = lastLine + 1; i < outline.lines.length; i++) {
    const t = bare(outline.lines[i]).trim();
    if (t === "") continue;
    return !outline.hidden[i] && t.toLowerCase() === `^${want}`;
  }
  return false;
}

/** A heading list for writing: the cache's when it still holds for the
 *  text, else the parser's. Offsets index `text`. */
export interface ResolvedHeading {
  heading: string;
  level: number;
  /** Offset of the heading's first line. */
  start: number;
  /** End of the heading's last line. */
  end: number;
}

/**
 * The headings to place a write by, checked against `text`: the cached list
 * when `verifyCachedHeadings` holds (so a fresh cache gives the same section
 * as before), else the headings parsed from `text`. `source` says which.
 */
export function resolveHeadings(
  text: string,
  cached: readonly CachedHeading[] | undefined,
  outline: NoteOutline = outlineNote(text),
): { headings: ResolvedHeading[]; source: "cache" | "text" } {
  if (Array.isArray(cached) && verifyCachedHeadings(text, outline, cached)) {
    return {
      headings: cached.map((h) => ({ heading: h.heading, level: h.level, start: h.position.start.offset, end: h.position.end.offset })),
      source: "cache",
    };
  }
  return {
    headings: outline.headings.map((h) => ({ heading: h.heading, level: h.level, start: h.start, end: h.end })),
    source: "text",
  };
}

/** The section under the first heading named `headingText`, over a resolved
 *  heading list: `start` just after the heading, `end` at the next heading of
 *  the same or a higher level, or `textLength`. */
export function sectionIn(
  headings: readonly ResolvedHeading[],
  textLength: number,
  headingText: string,
): { start: number; end: number; level: number } | undefined {
  const at = sectionAt(headings, textLength, headingText);
  return at ? { start: at.start, end: at.end, level: headings[at.index].level } : undefined;
}

/** The line ending a patch writes in `text`: CRLF when every line break in
 *  the note is CRLF, else LF (a note that mixes them is written as before). */
export function lineEndingOf(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "\r\n" : "\n";
}

/** A `replace` on a level-1 heading without `whole_section: true` (#601).
 *  Rendered as `Error [h1_replace]`. */
export class H1ReplaceError extends Error {
  readonly code = "h1_replace";
  constructor(path: string, heading: string) {
    super(
      `${path}: a replace on the level-1 heading '${heading}' would replace the whole note. ` +
        "A heading's section runs to the next heading of equal or higher level, so the H1's section holds every section below it. Nothing was written. " +
        "To add text under the H1, use prepend or append; to replace the whole section on purpose, pass whole_section: true.",
    );
    this.name = "H1ReplaceError";
  }
}

/** The patch tools' H1 rule (#601), for both servers: a `replace` on a
 *  level-1 heading is refused unless the caller passed `whole_section`.
 *  Prepend and append stay allowed. */
export function assertNotH1Replace(path: string, heading: string, level: number, op: string, wholeSection: boolean | undefined): void {
  if (op === "replace" && level === 1 && wholeSection !== true) throw new H1ReplaceError(path, heading);
}

/** The one section-end rule: the first heading named `headingText`, its
 *  section from just after it to the next heading of the same or a higher
 *  level (`next`, or -1 and `textLength` when there is none). */
function sectionAt(
  headings: readonly ResolvedHeading[],
  textLength: number,
  headingText: string,
): { index: number; next: number; start: number; end: number } | undefined {
  const index = headings.findIndex((h) => h.heading === headingText);
  if (index < 0) return undefined;
  const h = headings[index];
  for (let j = index + 1; j < headings.length; j++) {
    if (headings[j].level <= h.level) return { index, next: j, start: h.end, end: headings[j].start };
  }
  return { index, next: -1, start: h.end, end: textLength };
}

/**
 * The offsets of block `id` in `text`, for a write: the cached position when
 * `verifyCachedBlock` holds, else the block this parser finds (the id and
 * the anchor both compared lowercased, as Obsidian keys its block cache),
 * else undefined.
 */
export function resolveBlock(
  text: string,
  id: string,
  cached: CachedBlock | undefined,
  outline: NoteOutline = outlineNote(text),
): { start: number; end: number; source: "cache" | "text" } | undefined {
  if (cached && verifyCachedBlock(text, outline, id, cached)) {
    return { start: cached.position.start.offset, end: cached.position.end.offset, source: "cache" };
  }
  // Obsidian takes an id as a block's only at the block's end, so a run
  // that goes on past the id's line is not that block.
  const want = id.toLowerCase();
  const found = findBlock(outline, (b) => b.toLowerCase() === want);
  return found && (found.standalone || found.anchorLine === found.endLine - 1) ? { start: found.start, end: found.end, source: "text" } : undefined;
}
