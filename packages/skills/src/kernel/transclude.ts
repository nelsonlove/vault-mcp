// Transclusion (embed) resolution: `![[X]]` → the body of X.md, inlined.
//
// Compiled artifacts leave the vault, so embed syntax that Obsidian would render inline
// arrives at Claude Code as dead markup. This module inlines it at collection time.
// Pure — the vault lookup is injected, so it's unit-testable without `obsidian`.

import { stripLeadingFrontmatter } from "@vault-mcp/core";

export interface EmbedSource {
  /** Vault path of the resolved target (cycle detection key). */
  path: string;
  /** Raw file content (frontmatter is stripped here). */
  content: string;
  /** The target's frontmatter AS THE VAULT PARSES IT (Obsidian's metadata
   *  cache), when the lookup can supply it: `null` when the cache holds none.
   *  The acceptance gate prefers this to re-parsing `content`, so a note is
   *  judged by the same reader whether it is a compile unit or an embed
   *  target. Absent (undefined) means the lookup has no cache; the gate then
   *  parses the raw text and fails closed on what it cannot read. */
  frontmatter?: Record<string, unknown> | null;
}

/** Resolve an Obsidian linkpath relative to the note it appears in; null ⇒ unresolved.
 *  Return null for non-markdown targets (images, PDFs) — those embeds are left as-is
 *  by returning null from the lookup only for *missing* notes, so instead signal
 *  non-markdown targets by simply not matching them (see isMarkdownTarget). */
export type EmbedLookup = (linkpath: string, fromPath: string) => Promise<EmbedSource | null>;

/** Embeds nested deeper than this are left unresolved (with a warning). */
export const MAX_EMBED_DEPTH = 5;

const EMBED_RE = /!\[\[([^\[\]]+?)\]\]/g;

/** HTML comments terminate at the first `-->` (or `--!>`), so a heading/path containing
 *  one would close the marker early and leak the rest as prose; soften just those
 *  sequences. The same rule as transform.ts's `soft`. */
const safeLabel = (s: string): string => s.replace(/--(!?)>/g, "--$1›");

/** Provenance marker builders — single source of truth for the marker format, shared with
 *  the transform's agent-facing prose and the tests. Markers state where inlined text came
 *  FROM; they do not promise every embed inside it also resolved (unresolved inner embeds
 *  are left raw and warned). */
export const transclusionOpen = (label: string): string => `<!-- transcluded from: ${safeLabel(label)} -->`;
export const transclusionClose = (label: string): string => `<!-- end transclusion: ${safeLabel(label)} -->`;
/** The marker that stands where an embed of a guarded-territory note would
 *  have been (01.61 rule 8a): it names no path, because the name is case
 *  material too. */
export const TRANSCLUSION_GUARDED = "<!-- transclusion refused: a note in a guarded territory (01.61 rule 8a) -->";
/** The marker that stands where a refused embed would have been inlined (the
 *  acceptance gate): names the path, carries none of its text. */
export const transclusionRefused = (path: string): string => `<!-- transclusion refused: ${safeLabel(path)} is not accepted -->`;

/** Strip a single leading YAML frontmatter block. (Shared with exporter.ts.)
 *  Bound to the shared recognizer in @vault-mcp/core (#189) — the old local
 *  regex was BOM-blind, so a BOM-authored note carried its frontmatter fence
 *  verbatim into transcluded/exported output. A leading BOM is dropped either
 *  way (it is a byte-order mark, not body); the `^\s+` trim after is this
 *  site's own semantics, unchanged. */
export function stripFrontmatter(content: string): string {
  return stripLeadingFrontmatter(content).replace(/^\s+/, "");
}

/** Targets with a non-md file extension (images, PDFs, canvas) are attachment embeds,
 *  not note transclusions — leave them alone. A trailing `.md` is treated as part of
 *  the note name by Obsidian only when the file is literally named `X.md.md`, so a
 *  bare extensionless linkpath is the normal note case. */
function isMarkdownTarget(target: string): boolean {
  const base = target.split("/").pop() ?? target;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return true;
  return base.slice(dot).toLowerCase() === ".md";
}

/** Positions inside fenced code blocks or inline code spans are documentation about
 *  embeds, not embeds — compute a per-offset mask of "inside code". */
function codeMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  const lines = text.split("\n");
  let offset = 0;
  let inFence = false;
  let fenceMarker = "";
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      // A closing fence must use the same character and be at least as long as the
      // opening fence (CommonMark) — a ``` inside a ```` block is content, not a close.
      if (!inFence) { inFence = true; fenceMarker = fenceMatch[1]; }
      else if (fenceMatch[1][0] === fenceMarker[0] && fenceMatch[1].length >= fenceMarker.length) inFence = false;
      for (let i = 0; i < line.length; i++) mask[offset + i] = true;
    } else if (inFence) {
      for (let i = 0; i < line.length; i++) mask[offset + i] = true;
    } else {
      // Inline code: toggle on backticks within the line.
      let inSpan = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "`") { inSpan = !inSpan; mask[offset + i] = true; }
        else mask[offset + i] = inSpan;
      }
    }
    offset += line.length + 1;
  }
  return mask;
}

/** Extract the section under `heading` (case-insensitive match on the heading text),
 *  from the heading line to just before the next heading of the same or higher level. */
function extractHeadingSection(body: string, heading: string): string | null {
  const lines = body.split("\n");
  const want = heading.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m || m[2].trim().toLowerCase() !== want) continue;
    const level = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const h = lines[j].match(/^(#{1,6})\s/);
      if (h && h[1].length <= level) { end = j; break; }
    }
    return lines.slice(i, end).join("\n").trim();
  }
  return null;
}

/** Extract the paragraph (blank-line delimited) containing the `^blockId` marker,
 *  with the marker itself removed. */
function extractBlock(body: string, blockId: string): string | null {
  const lines = body.split("\n");
  const marker = new RegExp(`\\s*\\^${blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!marker.test(lines[i])) continue;
    let start = i;
    while (start > 0 && lines[start - 1].trim() !== "") start--;
    let end = i;
    while (end < lines.length - 1 && lines[end + 1].trim() !== "") end++;
    const block = lines.slice(start, end + 1);
    block[i - start] = lines[i].replace(marker, "");
    return block.join("\n").trim();
  }
  return null;
}

interface ResolveContext {
  lookup: EmbedLookup;
  warnings: string[];
  /** Active embed chain, for cycle detection (paths, source-note first). */
  chain: string[];
  /** When present, collects the vault path of every note whose content was inlined
   *  (all depths) — the compiled artifact's transclusion sources. */
  sources?: Set<string>;
  /** THE ACCEPTANCE GATE ON EMBEDS (01.41 rule 8: nothing unaccepted reaches a
   *  compiled agent prompt — the rule is over the prompt's TEXT, and an embed
   *  inlines a note's text). When present, an embed target it refuses is not
   *  inlined: a marker naming the path stands in its place, the path is
   *  recorded in `refused` and in `sources` (so the export re-runs when the
   *  note is later accepted), and a warning says why. Applies at every depth. */
  accept?: (src: EmbedSource) => boolean;
  refused?: Set<string>;
  /** GUARDED TERRITORIES (01.61 rule 8a): when this says a target is in one,
   *  the embed is refused before the acceptance gate, a marker that names NO
   *  path stands in its place, nothing is added to `sources` or `refused`, and
   *  the count goes up; the caller reports the count only. */
  guarded?: (src: EmbedSource) => boolean;
  guardedCount?: { n: number };
}

async function resolveBody(body: string, fromPath: string, ctx: ResolveContext): Promise<string> {
  const mask = codeMask(body);
  const out: string[] = [];
  let last = 0;
  for (const m of body.matchAll(EMBED_RE)) {
    const idx = m.index ?? 0;
    out.push(body.slice(last, idx));
    last = idx + m[0].length;
    const keep = () => out.push(m[0]);

    if (mask[idx]) { keep(); continue; }

    // target[#section][|alias] — alias is display-only, drop it.
    const inner = m[1].split("|")[0].trim();
    const hash = inner.indexOf("#");
    const target = (hash === -1 ? inner : inner.slice(0, hash)).trim();
    const section = hash === -1 ? null : inner.slice(hash + 1).trim();
    if (!target || !isMarkdownTarget(target)) { keep(); continue; }

    if (ctx.chain.length > MAX_EMBED_DEPTH) {
      ctx.warnings.push(`${fromPath}: transclusion ${m[0]} exceeds depth ${MAX_EMBED_DEPTH} — left unresolved`);
      keep(); continue;
    }
    const src = await ctx.lookup(target, fromPath);
    if (!src) {
      ctx.warnings.push(`${fromPath}: unresolved transclusion ${m[0]} — left as-is`);
      keep(); continue;
    }
    if (ctx.chain.includes(src.path)) {
      ctx.warnings.push(`${fromPath}: transclusion cycle through ${src.path} — left unresolved`);
      keep(); continue;
    }
    if (ctx.guarded?.(src)) {
      if (ctx.guardedCount) ctx.guardedCount.n += 1;
      out.push(TRANSCLUSION_GUARDED);
      continue;
    }
    if (ctx.accept && !ctx.accept(src)) {
      ctx.warnings.push(`${fromPath}: transclusion ${m[0]} refused — ${src.path} is not accepted (no \`verified\` entry naming a \`human:\` actor; 01.41 rule 8), so its text does not reach the compiled prompt`);
      ctx.refused?.add(src.path);
      ctx.sources?.add(src.path);
      out.push(transclusionRefused(src.path));
      continue;
    }

    let content: string | null = stripFrontmatter(src.content).trim();
    if (section) {
      // Nested heading paths (`X#H1#H2`) target the last heading; `#^id` is a block ref.
      const leaf = section.split("#").pop()!.trim();
      content = leaf.startsWith("^")
        ? extractBlock(content, leaf.slice(1))
        : extractHeadingSection(content, leaf);
      if (content == null) {
        ctx.warnings.push(`${fromPath}: transclusion ${m[0]} — section not found in ${src.path}; left as-is`);
        keep(); continue;
      }
    }
    const resolved = await resolveBody(content, src.path, { ...ctx, chain: [...ctx.chain, src.path] });
    // Provenance markers: compiled artifacts leave the vault, and without these the
    // inlined text is indistinguishable from the host note's own prose — an agent
    // editing its definition couldn't tell which note owns the passage (and might
    // paste compiled text back into the host note, flattening the composition).
    // Block-context embeds (alone on their line) get newline-separated markers; embeds
    // inside a line (list items, table cells, mid-sentence block refs) get markers with
    // no added newlines, so the surrounding markdown structure survives exactly as the
    // pre-marker splice did.
    ctx.sources?.add(src.path);
    const label = section ? `${src.path}#${section}` : src.path;
    const lineStart = body.lastIndexOf("\n", idx - 1) + 1;
    const nextNl = body.indexOf("\n", idx + m[0].length);
    const lineEnd = nextNl === -1 ? body.length : nextNl;
    const blockContext =
      /^\s*$/.test(body.slice(lineStart, idx)) && /^\s*$/.test(body.slice(idx + m[0].length, lineEnd));
    out.push(blockContext
      ? `${transclusionOpen(label)}\n${resolved}\n${transclusionClose(label)}`
      : `${transclusionOpen(label)}${resolved}${transclusionClose(label)}`);
  }
  out.push(body.slice(last));
  return out.join("");
}

/** Inline every `![[X]]` / `![[X#Heading]]` / `![[X#^block]]` embed in `body`, wrapping
 *  each inlined block in `<!-- transcluded from: … -->` / `<!-- end transclusion: … -->`
 *  markers so the compiled artifact names the note that owns the passage.
 *  Unresolvable embeds (missing target/section, cycle, depth, attachments, code spans)
 *  are left in place; problems are appended to `warnings`. When `sources` is given, the
 *  vault paths of every inlined note (all depths) are collected into it. */
export async function resolveTransclusions(
  body: string,
  sourcePath: string,
  lookup: EmbedLookup,
  warnings: string[],
  sources?: Set<string>,
  gate?: { accept: (src: EmbedSource) => boolean; refused: Set<string>; guarded?: (src: EmbedSource) => boolean; guardedCount?: { n: number } },
): Promise<string> {
  if (!body.includes("![[")) return body;
  return resolveBody(body, sourcePath, { lookup, warnings, chain: [sourcePath], sources, accept: gate?.accept, refused: gate?.refused, guarded: gate?.guarded, guardedCount: gate?.guardedCount });
}
