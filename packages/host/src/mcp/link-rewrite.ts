// link-rewrite.ts — the pure half of a move that rewrites its own backlinks
// (Nelson's "B", 2026-09-29, relayed: move without core's onCleanCache wait).
//
// Obsidian's fileManager.renameFile rewrites backlinks, but first waits for the
// metadata cache to be completely clean; with the fleet writing all the time
// that wait lasted 1 to 25 minutes per move. The move now renames at the file
// level and rewrites the backlinks itself. This module holds the text rules:
// finding links in a note's text (for notes whose cache entry is stale), and
// writing a link's new text so that only its target changes. Obsidian-free, so
// the rules are tested without an app.

// The fence rule lives in core (`fences.ts`), shared with the patch tools'
// heading parser (#593), so a fence means the same thing to both.
import { LEAD, linesOf, fencedSpans } from "@vault-mcp/core";

/** One link found in a note's text. Offsets are into the text it was found in. */
export interface TextLink {
  start: number;
  end: number;
  /** The link exactly as written. */
  original: string;
  kind: "wiki" | "markdown";
  embed: boolean;
  /** The target part, decoded (markdown links are decodeURI'd, as the cache does). */
  linkpath: string;
  /** `#heading` or `#^block`, with the `#`, or "". */
  subpath: string;
}

// The target and alias may hold single bracket pairs (`[[[draft] Note]]` is a
// real link) but never `[[`: in `[[a [[b]] c]]` Obsidian reads the innermost
// `[[b]]`, and so does this.
const WIKI = /(!?)\[\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*?)\]\]/g;
// A destination may hold one level of balanced parentheses (`Note (1).md`, as
// Obsidian writes it: it encodes spaces but not parentheses).
const DEST = String.raw`<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))*`;
// The display text may hold one level of brackets (`[![badge](url)](Note.md)`). It is
// bounded, so a long line of stray brackets cannot make the scan quadratic.
const TEXT = String.raw`(?:[^\[\]\n\\]|\\.|\[(?:[^\[\]\n\\]|\\.){0,1000}\]){0,1000}`;
const MARKDOWN = new RegExp(String.raw`(!?)\[(${TEXT})\]\((${DEST})(\s+"[^"\n]*")?\)`, "g");
/** One markdown link, whole: embed marker, display text, destination, title. */
const MARKDOWN_ONE = new RegExp(String.raw`^(!?)\[(${TEXT})\]\((${DEST})(\s+"[^"]*")?\)$`);

/** A link path written relative to the note it is in (`./x`, `../x`). */
export const isRelativeLinkpath = (p: string): boolean => /^\.\.?\//.test(p);

/** Sorted, merged [start, end) spans, and an O(log n) "is i inside one". */
function coverage(spans: Array<[number, number]>): (i: number) => boolean {
  const sorted = [...spans].sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return (i) => {
    let lo = 0, hi = merged.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (merged[mid][1] <= i) lo = mid + 1;
      else if (merged[mid][0] > i) hi = mid - 1;
      else return true;
    }
    return false;
  };
}

/**
 * Inline code, paired as CommonMark pairs it: within one block (a paragraph may
 * run over several lines), a run of n backticks is closed by the next run of
 * exactly n; a run with no partner is plain text. A blank line, a list item, a
 * heading and a table row each start a new block, so a lone backtick in one list
 * item never pairs with one in the next.
 */
function codeSpans(text: string, from: number, fenced: (i: number) => boolean): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const pair = (a: number, b: number) => {
    const escapedAt = (i: number) => { let n = 0; while (i - 1 - n >= 0 && text[i - 1 - n] === "\\") n++; return n % 2 === 1; };
    const runs = [...text.slice(a, b).matchAll(/`+/g)].map((m) => ({ at: a + m.index!, n: m[0].length, escaped: escapedAt(a + m.index!) }));
    // Where each run length occurs, in order, so finding a closer is a binary search.
    const byLength = new Map<number, number[]>();
    runs.forEach((r, x) => { const l = byLength.get(r.n); if (l) l.push(x); else byLength.set(r.n, [x]); });
    const nextOfLength = (n: number, after: number): number => {
      const l = byLength.get(n);
      if (!l) return -1;
      let lo = 0, hi = l.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (l[mid] <= after) lo = mid + 1; else hi = mid; }
      return lo < l.length ? l[lo] : -1;
    };
    for (let k = 0; k < runs.length; k++) {
      // A backslash cannot escape inside code, so an escaped run still closes a span;
      // it opens one only with the backticks after the escaped first one.
      const at = runs[k].escaped ? runs[k].at + 1 : runs[k].at;
      const n = runs[k].escaped ? runs[k].n - 1 : runs[k].n;
      if (n === 0) continue;
      const j = nextOfLength(n, k);
      if (j < 0) continue;
      spans.push([at, runs[j].at + runs[j].n]);
      k = j;
    }
  };
  let block: [number, number] | null = null;
  const flush = () => { if (block) pair(block[0], block[1]); block = null; };
  for (const [a, b] of linesOf(text, from)) {
    const line = text.slice(a, b).replace(LEAD, "");
    if (fenced(a) || line.trim() === "") { flush(); continue; }
    const single = /^(?:#{1,6}(?:[ \t]|$)|\|)/.test(line);
    if (single || /^(?:[-*+]|\d+[.)])(?:[ \t]|$)/.test(line)) flush();
    block = block ? [block[0], b] : [a, b];
    if (single) flush();
  }
  flush();
  return spans;
}

/**
 * Spans Obsidian does not index links in: fenced code blocks (``` and ~~~),
 * inline code, and math blocks. Returned as [start, end) pairs. NOT %%
 * comments: Obsidian's index does record a link inside one (checked against the
 * live index, 2026-09-29), so a move must rewrite it too.
 */
export function unindexedSpans(text: string): Array<[number, number]> {
  // Frontmatter is YAML, not markdown: nothing in it opens code, a comment or math.
  const fm = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(text);
  const body = fm ? fm[0].length : 0;
  // Code first: a `%%` or `$$` inside code is plain text, not a comment or math.
  const spans: Array<[number, number]> = fencedSpans(text, body);
  const inFence = coverage(spans);
  spans.push(...codeSpans(text, body, (i) => i < body || inFence(i)));
  const inCode = coverage(spans);
  // Then math, from delimiters that are not inside code.
  const pairUp = (re: RegExp, delim: number) => {
    const at = [...text.matchAll(re)].map((m) => m.index!).filter((i) => i >= body && !inCode(i));
    // Pairs only: a delimiter with no partner hides nothing (missing a real link is damage;
    // rewriting one inside a stray comment is not).
    for (let k = 0; k + 1 < at.length; k += 2) spans.push([at[k], at[k + 1] + delim]);
  };
  pairUp(/\$\$/g, 2);
  return spans;
}

function splitTarget(raw: string): { linkpath: string; subpath: string } {
  const i = raw.indexOf("#");
  return i < 0 ? { linkpath: raw, subpath: "" } : { linkpath: raw.slice(0, i), subpath: raw.slice(i) };
}

/** Every wikilink, embed and markdown link in `text` that Obsidian would index. */
export function parseLinks(text: string): TextLink[] {
  const skip = coverage(unindexedSpans(text));
  const out: TextLink[] = [];
  for (const m of text.matchAll(WIKI)) {
    if (skip(m.index!)) continue;
    // The target ends at the first `|`; inside a table the separator is written
    // `\|`, and the backslash belongs to it, not to the target.
    const inner = m[2];
    const bar = inner.indexOf("|");
    const target = (bar < 0 ? inner : inner.slice(0, bar)).replace(/\\$/, "");
    const { linkpath, subpath } = splitTarget(target);
    // Obsidian NFC-normalizes a link target before resolving it; so does this.
    out.push({ start: m.index!, end: m.index! + m[0].length, original: m[0], kind: "wiki", embed: m[1] === "!", linkpath: linkpath.trim().normalize("NFC"), subpath });
  }
  // A markdown link's text may hold a link of its own (`[![alt](Pic.md)](Note.md)`): Obsidian
  // indexes both, so the text is scanned too (one level, as the pattern allows).
  const markdown = [...text.matchAll(MARKDOWN)].filter((m) => !skip(m.index!));
  const nested: Array<{ index: number; m: RegExpMatchArray }> = [];
  for (const m of markdown) {
    if (!m[2].includes("](")) continue;
    const offset = m.index! + m[1].length + 1;
    for (const n of m[2].matchAll(MARKDOWN)) if (!skip(offset + n.index!)) nested.push({ index: offset + n.index!, m: n });
  }
  for (const { index, m } of [...markdown.map((m) => ({ index: m.index!, m })), ...nested]) {
    let dest = m[3];
    if (dest.startsWith("<")) dest = dest.slice(1, -1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) continue; // a URL, not a note
    let decoded: string;
    try { decoded = decodeURI(dest); } catch { decoded = dest; }
    const { linkpath, subpath } = splitTarget(decoded);
    if (linkpath === "" && subpath === "") continue;
    out.push({ start: index, end: index + m[0].length, original: m[0], kind: "markdown", embed: m[1] === "!", linkpath: linkpath.normalize("NFC"), subpath });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The folder of a vault path ("" at the root). */
export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** `to` written relative to the folder `fromFolder`, as a markdown link would. */
export function relativePath(fromFolder: string, to: string): string {
  const a = fromFolder ? fromFolder.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  const rest = b.slice(i).join("/");
  return up === 0 ? `./${rest}` : "../".repeat(up) + rest;
}

/** A markdown destination: spaces and parentheses encoded, the rest left readable. */
export function encodeMarkdownDest(path: string): string {
  return encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/#/g, "%23");
}

/**
 * The link as it should read after its target moved: only the target part
 * changes; embed marker, subpath, alias, display text and title stay as written.
 *
 * - A wikilink gets `wikiTarget` (Obsidian's own link text for the new file from
 *   this source, `fileToLinktext`), keeping a `.md` suffix if the original had one;
 *   one written relative (`./`, `../`) stays relative to `sourcePath`.
 * - A markdown link keeps its style: a destination written relative (`./`, `../`)
 *   is rewritten relative to `sourcePath`; one with a folder is rewritten as the
 *   vault path; a bare name gets `wikiTarget`. A `.md` suffix is kept when the
 *   original had one, and angle brackets are kept when the original used them.
 */
export function rewriteLink(link: TextLink, newPath: string, sourcePath: string, wikiTarget: string): string {
  const hadMd = /\.md$/i.test(link.linkpath);
  const noExt = newPath.replace(/\.md$/i, "");
  if (link.kind === "wiki") {
    const m = /^(!?)\[\[([\s\S]*)\]\]$/.exec(link.original)!;
    const inner = m[2];
    const bar = inner.indexOf("|");
    const tail = bar < 0 ? "" : inner.slice(bar);
    const escapedBar = bar > 0 && inner[bar - 1] === "\\";
    const name = isRelativeLinkpath(link.linkpath)
      ? relativePath(folderOf(sourcePath), hadMd ? newPath : noExt)
      : hadMd && !/\.md$/i.test(wikiTarget) ? `${wikiTarget}.md` : wikiTarget;
    const target = name + link.subpath;
    return `${m[1]}[[${target}${escapedBar ? "\\" : ""}${tail}]]`;
  }
  const m = MARKDOWN_ONE.exec(link.original)!;
  const rawDest = m[3];
  const angled = rawDest.startsWith("<");
  const oldDest = angled ? rawDest.slice(1, -1) : rawDest;
  let target: string;
  if (isRelativeLinkpath(oldDest)) target = relativePath(folderOf(sourcePath), hadMd ? newPath : noExt);
  else if (oldDest.includes("/")) target = hadMd ? newPath : noExt;
  else target = hadMd && !/\.md$/i.test(wikiTarget) ? `${wikiTarget}.md` : wikiTarget;
  const hash = oldDest.indexOf("#");
  const rawSubpath = hash < 0 ? "" : oldDest.slice(hash);
  const dest = angled ? `<${target}${rawSubpath}>` : encodeMarkdownDest(target) + rawSubpath;
  return `${m[1]}[${m[2]}](${dest}${m[4] ?? ""})`;
}

/** One edit: `expected` must still be the text at [start, end) when it is applied. */
export interface Edit { start: number; end: number; expected: string; replacement: string }

/** Apply edits from the end backwards; null when a position no longer holds its expected text. */
export function applyEdits(text: string, edits: Edit[]): string | null {
  // An edit inside another (a link in a link's text) is applied to the outer edit's
  // replacement, which keeps the text at the same offset; null if it does not.
  const outer = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Edit[] = [];
  for (const e of outer) {
    const host = kept.find((h) => e.start >= h.start && e.end <= h.end);
    if (!host) { kept.push({ ...e }); continue; }
    const off = e.start - host.start;
    if (host.replacement.slice(off, off + e.expected.length) !== e.expected) return null;
    host.replacement = host.replacement.slice(0, off) + e.replacement + host.replacement.slice(off + e.expected.length);
  }
  const sorted = kept.sort((a, b) => b.start - a.start);
  let out = text;
  let floor = Infinity;
  for (const e of sorted) {
    if (e.end > floor) return null;
    if (out.slice(e.start, e.end) !== e.expected) return null;
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    floor = e.start;
  }
  return out;
}
