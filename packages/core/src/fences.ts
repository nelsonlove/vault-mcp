// fences.ts — where fenced code blocks sit in a note's text, by line.
//
// One rule, shared: the link rewriter (host `link-rewrite.ts`, which a move
// uses to find links Obsidian indexes) and the patch tools' heading and block
// parser (`note-sections.ts`, #593) both use it, so a fence means the same
// thing to both. It was checked against Obsidian's live index when the link
// rewriter was written (2026-09-29): a fence may open after indentation, after
// blockquote markers and after a list marker (`- ```js`), and closes on a line
// holding only a run of the same character at least as long.

/** Where a line's content starts: after indentation and any blockquote markers (`> > `). */
export const LEAD = /^[ \t]*(?:>[ \t]?)*/;
/** The same, and also past a list marker: a fence may open on a list item's first line (`- ```js`). */
export const FENCE_LEAD = /^[ \t]*(?:>[ \t]?)*(?:(?:[-*+]|\d+[.)])[ \t]+)?/;

/** [start, end) of every line from `from` on. */
export function linesOf(text: string, from: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = from; ; ) {
    const nl = text.indexOf("\n", i);
    out.push([i, nl < 0 ? text.length : nl]);
    if (nl < 0) return out;
    i = nl + 1;
  }
}

/**
 * Fenced code blocks, by line: a fence opens on a line of three or more
 * backticks or tildes (after any indentation or blockquote markers, so a fence
 * inside a list item or a quote counts), and closes on a line holding only a
 * run of the same character at least as long. An unclosed fence runs to the end
 * of the note.
 */
export function fencedSpans(text: string, from: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let open: { start: number; ch: string; len: number } | null = null;
  for (const [a, b] of linesOf(text, from)) {
    // A list marker may precede an opening fence, never a closing one.
    const line = text.slice(a, b).replace(open ? LEAD : FENCE_LEAD, "");
    if (!open) {
      const m = /^(`{3,}|~{3,})/.exec(line);
      // A backtick fence's info string may not hold a backtick (then it is inline code).
      if (m && !(m[1][0] === "`" && line.slice(m[0].length).includes("`"))) open = { start: a, ch: m[1][0], len: m[1].length };
    } else {
      const m = /^(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (m && m[1][0] === open.ch && m[1].length >= open.len) { spans.push([open.start, b]); open = null; }
    }
  }
  if (open) spans.push([open.start, text.length]);
  return spans;
}

