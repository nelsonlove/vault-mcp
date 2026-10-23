// fences.ts — where fenced code blocks sit in a note's text, by line.
//
// The patch tools' heading and block parser (`note-sections.ts`, #593) steps
// this rule line by line. It grew out of the link rewriter's rule (host
// `link-rewrite.ts`, checked against Obsidian's live index on 2026-09-29) and
// follows Obsidian's container rules more closely, so that a `#` line inside
// code is never taken for a heading. The link rewriter keeps its own, simpler
// rule: for a move a hidden real link is damage and a rewritten link inside
// code is not, so a change to that rule is measured on its own (the Fable
// review of #596). The basics are the same: a fence may open after
// indentation, after blockquote markers and after a list marker (`- ```js`),
// and closes on a line holding only a run of the same character at least as
// long.

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

// What ends a fence's container early (a quote or a list item): a line,
// after the lead it still has, that starts a block Obsidian lets interrupt the
// container: an ATX heading, a thematic break, a fence, a `%%` comment or a
// list item. Plain text is a lazy continuation and stays in the fence.
export const INTERRUPTS = /^(?:#{1,6}(?:[ \t]|$)|(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$|`{3,}|~{3,}|%%[^%]*$|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

// A quote also ends at a line that opens an HTML block, a `$$` math block or
// indented code (Obsidian lets these interrupt a quote, but not a list item).
const QUOTE_INTERRUPTS = /^(?: {4}|\t|\$\$|<(?:script|pre|style|textarea)(?:\s|>|$)|<!--|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>|$))/i;

/** The indentation of `s` in columns: a tab moves to the next multiple of four. */
export function columnsOf(s: string): number {
  let col = 0;
  for (const ch of s) {
    if (ch === " ") col++;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** What one line is to a fence: it opens one, is inside one, closes one, or
 *  none of these. `endedBefore` is set when the open fence's container ended
 *  before this line (the fence ends at the line before). */
export interface FenceStep {
  kind: "open" | "inside" | "close" | "none";
  endedBefore: boolean;
}

/**
 * The fence rule as a line-by-line state machine, so a caller that also
 * tracks other blocks (comments, math) can step it only where code can start.
 * A fence opens on three or more backticks or tildes after any indentation,
 * blockquote markers and one list marker; a backtick fence's info string may
 * not hold a backtick. It closes on a line holding only a run of the same
 * character at least as long (after indentation and quote markers). A fence
 * opened inside a quote or on a list item ends with that container: for a
 * quote, at a blank line or at a line with fewer `>` markers that starts an
 * interrupting block; for a list item, at a line indented less than the
 * fence's column that starts an interrupting block, or, after a blank line,
 * at any line indented less. Checked against Obsidian 1.14.4's parser. A line
 * keeps any `\r` it ends with; the rule reads it without.
 */
export class FenceTracker {
  private open: { ch: string; len: number; quotes: number; column: number | null; closeCol: number; sawBlank: boolean } | null = null;

  get isOpen(): boolean { return this.open !== null; }

  /** `nextLine`, when given, is the line after: a line under a quote that a
   *  setext underline follows is a heading, which ends the quote.
   *  `context.column`, when given, is the content column of the list item
   *  the line is in (0 outside a list): a fence then opens only within three
   *  spaces of it, as Obsidian reads one (four spaces more is indented code),
   *  and a fence opened inside the item ends with it. Without `context` a
   *  fence opens at any indent. */
  step(rawLine: string, nextLine?: string, context?: { column: number }): FenceStep {
    const raw = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    let endedBefore = false;
    if (this.open) {
      const o = this.open;
      const lead = LEAD.exec(raw)![0];
      const quotes = (lead.match(/>/g) ?? []).length;
      const rest = raw.slice(lead.length);
      const blank = rest.trim() === "";
      const indent = columnsOf(raw);
      let ends = false;
      // Indentation counts for indented code, so it is read on the unquoted line.
      if (o.quotes > 0 && quotes < o.quotes && QUOTE_INTERRUPTS.test(quotes === 0 ? raw : rest)) ends = true;
      if (o.quotes > 0) {
        if (blank && quotes < o.quotes) ends = true;
        else if (quotes < o.quotes && (INTERRUPTS.test(rest) || (!blank && nextLine !== undefined && /^(=+|-+)\r?$/.test(nextLine)))) ends = true;
      }
      if (!ends && o.column !== null && !blank && indent < o.column) {
        if (o.sawBlank || INTERRUPTS.test(raw.slice(indent))) ends = true;
      }
      if (ends) { this.open = null; endedBefore = true; }
      else if (blank) o.sawBlank = true;
    }
    if (this.open) {
      // A list marker may precede an opening fence, never a closing one; the
      // closer sits in the opener's quote (as many `>` markers), indented at
      // most three columns past the fence's container (four or a tab more
      // is code, as Obsidian reads it).
      const lead = LEAD.exec(raw)![0];
      const quotes = (lead.match(/>/g) ?? []).length;
      const afterQuotes = quotes === 0 ? raw : raw.slice(lead.length);
      const indent = columnsOf(afterQuotes);
      const line = afterQuotes.replace(/^[ \t]*/, "");
      const m = /^(`{3,}|~{3,})[ \t]*$/.exec(line);
      const sameQuote = quotes === this.open.quotes;
      if (m && sameQuote && indent <= this.open.closeCol + 3 && m[1][0] === this.open.ch && m[1].length >= this.open.len) { this.open = null; return { kind: "close", endedBefore }; }
      return { kind: "inside", endedBefore };
    }
    const line = raw.replace(FENCE_LEAD, "");
    const m = /^(`{3,}|~{3,})/.exec(line);
    if (m && !(m[1][0] === "`" && line.slice(m[0].length).includes("`"))) {
      const fenceLead = raw.length - line.length;
      const quoteLead = LEAD.exec(raw)![0];
      const marker = fenceLead > quoteLead.length;
      const indent = columnsOf(raw);
      const col = context?.column ?? 0;
      // With a context, the fence (or the list marker before it) sits at
      // most three columns past the item's content column (a tab counts to
      // the next four).
      if (context && !quoteLead.includes(">") && (indent < (marker ? 0 : col) || indent > col + 3)) return { kind: "none", endedBefore };
      this.open = {
        ch: m[1][0], len: m[1].length, sawBlank: false,
        quotes: (quoteLead.match(/>/g) ?? []).length,
        column: marker ? fenceLead : context && col > 0 ? col : null,
        closeCol: marker ? fenceLead - quoteLead.length : context ? col : 0,
      };
      return { kind: "open", endedBefore };
    }
    return { kind: "none", endedBefore };
  }
}
