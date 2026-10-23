// ============================================================================
//  REVISION ROUND-TRIP — pure callout + content machinery (#101)
// ----------------------------------------------------------------------------
//  The request-changes / withdraw / submit-revision dispositions carry their
//  human feedback in the NOTE BODY, not frontmatter (Nelson's 2026-08-17
//  amendment: there is NO `requested-changes` property):
//
//    > [!revision-request] Requested changes (YYYY-MM-DD)
//    > <the reviewer's free text, quoted line by line>
//
//  inserted DIRECTLY BELOW the note's H1 (or at the top of the body when the
//  note has no H1). `withdraw` and `submit-revision` remove exactly the
//  `[!revision-request]` callout blocks and nothing else; `submit-revision`
//  optionally inserts a `[!revision-report]` callout the same way. This
//  module writes NO frontmatter at all (#599: the retired accept keys are never
//  written; the caller additionally re-checks via the shared accept guard).
//
//  FRONTMATTER BOUNDARIES come from the shared core recognizer
//  (`stripLeadingBom` + `LEADING_FRONTMATTER_RE`, @vault-mcp/core) — never a
//  bespoke `/^---/` (#126/#189/#223: a recognizer narrower than what the vault
//  honors mis-reads exactly the notes whose bytes are least ordinary). Body
//  splitting mirrors `stripLeadingFrontmatter`: the body begins after the
//  closing fence plus exactly ONE line terminator.
//
//  Pure functions over strings — obsidian-free, headless-testable
//  (tests/governance-revision.test.mjs). CRLF notes keep their CRLF: inserted
//  lines use the note's own DOMINANT line ending. A genuinely MIXED-EOL region
//  (some \r\n, some \n in one frontmatter block or body) is normalized to that
//  dominant ending by the rejoin — a deliberate trade (per-line EOL bookkeeping
//  is not worth its complexity for a byte pattern Obsidian itself normalizes on
//  the next processFrontMatter touch).
// ============================================================================

import { stripLeadingBom, LEADING_FRONTMATTER_RE } from "@vault-mcp/core";

/** The two callout types this round-trip owns. */
export const REVISION_REQUEST_CALLOUT = "revision-request";
export const REVISION_REPORT_CALLOUT = "revision-report";

/** First line of a `[!revision-request]` callout block (case-insensitive type, per Obsidian). */
const REVISION_REQUEST_HEAD_RE = /^>\s*\[!revision-request\]/i;

/** Any callout-continuation line: the block runs while lines keep their `>` marker. */
const QUOTE_LINE_RE = /^\s{0,3}>/;

/** The note's dominant line ending — used for every line this module inserts. */
function eolOf(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Split a note into its frontmatter head (BOM + fence + exactly one line
 * terminator, "" when the note has none) and its body — the same boundary
 * `stripLeadingFrontmatter` computes, kept as a SPLIT so the head bytes can be
 * carried through verbatim and re-joined without normalizing anything.
 */
export function splitNote(content: string): { head: string; body: string } {
  const bomless = stripLeadingBom(content);
  const bom = content.length === bomless.length ? "" : content.slice(0, content.length - bomless.length);
  const m = LEADING_FRONTMATTER_RE.exec(bomless);
  if (!m) return { head: bom, body: bomless };
  const after = bomless.slice(m[0].length);
  const term = /^(?:\r\n|\n|\r)/.exec(after)?.[0] ?? "";
  return { head: bom + bomless.slice(0, m[0].length) + term, body: after.slice(term.length) };
}

/** Build the quoted callout lines for one revision callout. `text` may be multi-line. */
export function buildRevisionCallout(type: string, title: string, text: string, date: string): string[] {
  const lines = [`> [!${type}] ${title} (${date})`];
  for (const line of text.split(/\r\n|\n|\r/)) {
    lines.push(line === "" ? ">" : `> ${line}`);
  }
  return lines;
}

/**
 * Index of the line AFTER which a revision callout belongs: the note's first
 * ATX H1 (`# …`) outside a code fence, or -1 when the note has none (insert at
 * the top of the body instead).
 */
export function h1LineIndex(bodyLines: string[]): number {
  // Fence tracking is per MARKER: only the marker that opened a fence can close it (a ``` line
  // inside a ~~~ fence is content, and vice versa — the "``` example wrapped in ~~~" doc pattern).
  let fence: "```" | "~~~" | null = null;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const m = /^\s*(```|~~~)/.exec(line);
    if (m) {
      const marker = m[1] as "```" | "~~~";
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (/^#[ \t]/.test(line)) return i;
  }
  return -1;
}

/**
 * Insert `calloutLines` into `body` directly below its H1, or at the very top
 * when there is no H1 — with one blank line separating the callout from what
 * surrounds it (so it stays its own block and never glues onto adjacent
 * content). Preserves the body's own line endings.
 */
export function insertCalloutBelowH1(body: string, calloutLines: string[]): string {
  const eol = eolOf(body);
  const lines = body.split(/\r\n|\n/);
  const h1 = h1LineIndex(lines);
  if (h1 >= 0) {
    const block = ["", ...calloutLines];
    const next = lines[h1 + 1];
    if (next !== undefined && next.trim() !== "") block.push("");
    lines.splice(h1 + 1, 0, ...block);
  } else {
    const block = [...calloutLines];
    if (lines.length > 0 && lines[0].trim() !== "") block.push("");
    lines.unshift(...block);
  }
  return lines.join(eol);
}

/**
 * Remove every `[!revision-request]` callout block from `body` — the head line
 * plus its `>`-quoted continuation lines, plus ONE adjacent blank line so the
 * insertion round-trips cleanly. Removes NOTHING else: other callout types
 * (including `[!revision-report]`) and all surrounding content are preserved
 * verbatim. Returns the new body and how many blocks were removed.
 */
/** One parsed `[!revision-request]` callout: the head-line date (when the title
 * carries a `(...)` group, however precise) and the request text — continuation
 * lines with their `>` markers stripped, joined on the body's own EOL. */
export interface ParsedRevisionRequest {
  date: string | null;
  text: string;
}

/**
 * Extract every `[!revision-request]` callout from a note BODY, non-destructively —
 * the read-side mirror of `removeRevisionRequestCallouts` (same head/continuation
 * detection, so anything the remover would remove, this reports). Feeds the
 * read-only `governance_revisions` listing so a dispatcher can read the human's
 * requests without opening each note.
 */
export function parseRevisionRequestCallouts(body: string): ParsedRevisionRequest[] {
  const eol = eolOf(body);
  const lines = body.split(/\r\n|\n/);
  const out: ParsedRevisionRequest[] = [];
  let i = 0;
  while (i < lines.length) {
    if (REVISION_REQUEST_HEAD_RE.test(lines[i].trimStart()) && QUOTE_LINE_RE.test(lines[i])) {
      const head = lines[i].trimStart().replace(REVISION_REQUEST_HEAD_RE, "").trim();
      const date = /\(([^)]+)\)\s*$/.exec(head)?.[1] ?? null;
      i++;
      const textLines: string[] = [];
      while (i < lines.length && QUOTE_LINE_RE.test(lines[i])) {
        textLines.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      out.push({ date, text: textLines.join(eol).trim() });
      continue;
    }
    i++;
  }
  return out;
}

export function removeRevisionRequestCallouts(body: string): { body: string; removed: number } {
  const eol = eolOf(body);
  const lines = body.split(/\r\n|\n/);
  const out: string[] = [];
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    if (REVISION_REQUEST_HEAD_RE.test(lines[i].trimStart()) && QUOTE_LINE_RE.test(lines[i])) {
      removed++;
      i++; // the head line
      while (i < lines.length && QUOTE_LINE_RE.test(lines[i])) i++; // continuation lines
      // Collapse ONE adjacent blank so insert→remove round-trips: the following
      // blank (the separator insertion added), or — ONLY for a callout at EOF —
      // the preceding one. When non-blank content follows directly, pop
      // NOTHING: eating the preceding blank would merge unrelated paragraphs.
      if (i < lines.length && lines[i].trim() === "") {
        i++;
      } else if (i >= lines.length && out.length > 0 && out[out.length - 1].trim() === "") {
        out.pop();
      }
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return { body: out.join(eol), removed };
}

/** Full-content transform: insert a `[!revision-request]` callout below the H1 (request-changes). */
export function insertRevisionRequest(content: string, text: string, date: string): string {
  const { head, body } = splitNote(content);
  const callout = buildRevisionCallout(REVISION_REQUEST_CALLOUT, "Requested changes", text, date);
  return head + insertCalloutBelowH1(body, callout);
}

/** Full-content transform: remove the `[!revision-request]` callout(s) (withdraw). */
export function withdrawRevisionRequests(content: string): { content: string; removed: number } {
  const { head, body } = splitNote(content);
  const { body: newBody, removed } = removeRevisionRequestCallouts(body);
  return { content: head + newBody, removed };
}

export interface SubmitRevisionPlan {
  content: string;
  /** How many `[!revision-request]` callout blocks were removed. */
  removedRequests: number;
  /** Whether a `[!revision-report]` callout was inserted (a summary was given). */
  reportInserted: boolean;
}

/**
 * The submit-revision content transform, in one pure step:
 *   1. (no frontmatter write: `acceptance-status` is left exactly as it is, #599);
 *   2. remove the addressed `[!revision-request]` callout(s);
 *   3. when `summary` is given, insert a `[!revision-report]` callout below
 *      the H1 (the predecessor flow's contract — the reviewer disposes of the
 *      report at review; Accept never auto-removes it).
 */
export function planSubmitRevision(
  content: string,
  opts: { summary?: string; date: string }
): SubmitRevisionPlan {
  const { head, body } = splitNote(content);
  const { body: cleaned, removed } = removeRevisionRequestCallouts(body);
  let finalBody = cleaned;
  let reportInserted = false;
  const summary = opts.summary?.trim();
  if (summary) {
    const callout = buildRevisionCallout(REVISION_REPORT_CALLOUT, "Revision report", summary, opts.date);
    finalBody = insertCalloutBelowH1(cleaned, callout);
    reportInserted = true;
  }
  return { content: head + finalBody, removedRequests: removed, reportInserted };
}
