// note-structure.ts — where the live host places a patch: on Obsidian's own
// reading of the text it just read (#593, review round 3 of #596).
//
// `obsidian_patch_note` and `obsidian_append_at_heading` read a note and then
// write into it at a heading or a block. The positions must describe that
// exact text. The metadata cache describes the text Obsidian last parsed,
// which after a recent write is not this one; the shared parser in core is a
// close reading of Obsidian's Markdown, but not Obsidian's own. So:
//
//   1. The text is parsed with Obsidian's own parser, through
//      `metadataCache.computeMetadataAsync(buffer)`: the call Obsidian's
//      canvas index makes to parse a text that is not a file. It queues the
//      buffer on the same worker that builds the cache, returns the metadata
//      for exactly that text, and stores nothing. That reading is the truth.
//   2. Where that call is missing, fails or does not answer within
//      `parseTimeoutMs`, the cache is used only when it still holds for the
//      text (core's `verifyCachedHeadings` / `verifyCachedBlock`). When it does
//      not, the host waits up to `cacheWaitMs` for the cache's "changed" event
//      for the note and checks again. If the two still disagree, nothing is
//      written: the call fails with `cache_mismatch`, which is safe to retry.
//
// The shared parser's own reading is never written at on this host.

import {
  outlineNote,
  verifyCachedHeadings,
  verifyCachedBlock,
  findBlock,
  type CachedHeading,
  type CachedBlock,
  type ResolvedHeading,
} from "@vault-mcp/core";

/** The patch could not be placed: Obsidian's index of the note does not
 *  match the text just read. Nothing was written; a retry is safe. */
export class CacheMismatchError extends Error {
  readonly code = "cache_mismatch";
  constructor(path: string) {
    super(
      `${path}: Obsidian's index of this note does not match its text yet (the note changed since Obsidian last read it), so the place to write could not be checked. Nothing was written. Retry in a moment.`,
    );
    this.name = "CacheMismatchError";
  }
}

/** How long each step may take. Tests shorten them. */
export const structureTiming = { parseTimeoutMs: 5000, cacheWaitMs: 2000 };

/** The parts of Obsidian's `CachedMetadata` this module reads. */
interface MetaLike {
  headings?: CachedHeading[];
  blocks?: Record<string, CachedBlock>;
}

/** The parts of Obsidian's `MetadataCache` this module reads.
 *  `computeMetadataAsync` is not in the published typings. */
export interface MetadataSource {
  getFileCache(file: { path: string }): MetaLike | null;
  computeMetadataAsync?: (buffer: ArrayBuffer) => Promise<MetaLike | undefined | null>;
  on?: (name: "changed", callback: (file: { path: string }) => void) => unknown;
  offref?: (ref: unknown) => void;
}

/** What a patch is placed by. */
export interface NoteStructure {
  headings: ResolvedHeading[];
  /** The block asked for, when one was. */
  block?: { start: number; end: number };
  /** "obsidian": Obsidian's parse of this text; "cache": the cache, checked against it. */
  source: "obsidian" | "cache";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

const offsetOk = (o: unknown, max: number): o is number => typeof o === "number" && Number.isInteger(o) && o >= 0 && o <= max;

/** Obsidian's own parse of `text`, its offsets indexing `text`; null when
 *  the call is missing, fails, times out or answers with something unusable. */
async function parseWithObsidian(mc: MetadataSource, text: string): Promise<{ headings: ResolvedHeading[]; blocks: Record<string, { start: number; end: number }> } | null> {
  if (typeof mc.computeMetadataAsync !== "function") return null;
  let meta: MetaLike | undefined | null;
  try {
    const bytes = new TextEncoder().encode(text);
    // The worker takes the buffer over (it is transferred), so it is a copy.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    meta = await withTimeout(mc.computeMetadataAsync.call(mc, buffer), structureTiming.parseTimeoutMs);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object") return null;
  // The worker decodes the bytes with a TextDecoder, which drops a leading
  // BOM, so its offsets start one character later than this text's.
  const shift = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const headings: ResolvedHeading[] = [];
  for (const h of meta.headings ?? []) {
    const s = h?.position?.start?.offset, e = h?.position?.end?.offset;
    if (!offsetOk(s, text.length) || !offsetOk(e, text.length) || typeof h.heading !== "string" || typeof h.level !== "number") return null;
    headings.push({ heading: h.heading, level: h.level, start: s + shift, end: e + shift });
  }
  const blocks: Record<string, { start: number; end: number }> = {};
  for (const [id, b] of Object.entries(meta.blocks ?? {})) {
    const s = b?.position?.start?.offset, e = b?.position?.end?.offset;
    if (!offsetOk(s, text.length) || !offsetOk(e, text.length)) return null;
    blocks[id] = { start: s + shift, end: e + shift };
  }
  return { headings, blocks };
}

/** Wait until the cache reports a change to `path`, or `ms` pass. */
function waitForChange(mc: MetadataSource, path: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let ref: unknown = null;
    const done = () => { clearTimeout(timer); if (ref !== null) mc.offref?.(ref); resolve(); };
    const timer = setTimeout(done, ms);
    if (typeof mc.on === "function") ref = mc.on.call(mc, "changed", (f) => { if (f?.path === path) done(); });
  });
}

/**
 * The headings (and, for a block anchor, the block, by its lowercased id) of
 * `text`, the text just read from `file`, for placing a write. Throws
 * `CacheMismatchError` when no reading of this text can be checked.
 */
export async function noteStructure(mc: MetadataSource, file: { path: string }, text: string, blockId?: string): Promise<NoteStructure> {
  const want = blockId?.toLowerCase();
  const parsed = await parseWithObsidian(mc, text);
  if (parsed) return { headings: parsed.headings, block: want === undefined ? undefined : parsed.blocks[want], source: "obsidian" };

  const outline = outlineNote(text);
  const fromCache = (): NoteStructure | null => {
    const cache = mc.getFileCache(file);
    const cached = cache?.headings ?? [];
    if (!Array.isArray(cached) || !verifyCachedHeadings(text, outline, cached)) return null;
    const headings = cached.map((h) => ({ heading: h.heading, level: h.level, start: h.position.start.offset, end: h.position.end.offset }));
    if (want === undefined) return { headings, source: "cache" };
    const b = cache?.blocks?.[want];
    if (b) return verifyCachedBlock(text, outline, want, b) ? { headings, block: { start: b.position.start.offset, end: b.position.end.offset }, source: "cache" } : null;
    // The cache has no such block: it agrees only if the text has none either.
    return findBlock(outline, (id) => id.toLowerCase() === want) ? null : { headings, source: "cache" };
  };
  const now = fromCache();
  if (now) return now;
  await waitForChange(mc, file.path, structureTiming.cacheWaitMs);
  const later = fromCache();
  if (later) return later;
  throw new CacheMismatchError(file.path);
}
