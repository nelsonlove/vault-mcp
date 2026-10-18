// move-with-links.ts — a move that rewrites its own backlinks, without core's
// wait for a clean metadata cache (Nelson's "B", 2026-09-29, relayed:
// "Let's try be and run tests looking for damage").
//
// Why: `app.fileManager.renameFile` runs its link update behind
// `metadataCache.onCleanCache`, which resolves only when no indexing task is in
// progress and the link-resolver queue is empty. With about twenty agent
// sessions writing to the vault all the time that moment rarely comes: a rename
// of a note with no links took 63 s on a quiet vault and 357 s under load, and
// the area moves of 2026-09-29 took 6 to 25 minutes each.
//
// What it does instead:
//   1. FIND every note that may link the note, from its TEXT: every markdown
//      note whose text contains the note's name (as written, `%20`-encoded, or
//      in either Unicode normal form) is read and parsed. The text is always
//      current, so a note written moments before (its index entry still stale —
//      the risk the ruling named) is found like any other, and so are links
//      Obsidian's index does not track (a link inside a frontmatter string). The
//      index (`resolvedLinks`) is used only as a cross-check.
//   2. RENAME at the file level (`vault.rename`), which does not wait.
//   3. REWRITE each note inside `vault.process`, at the planned positions when
//      its text is unchanged, and from its current text otherwise. The moved
//      note's own relative links (markdown or wiki) are rewritten from its new
//      folder.
//   RECORDS (01.44 rule 8) are never rewritten: a note that links the moved note
//   from inside a record keeps its link as written, and the moved note's own
//   links stay as written when it is a record itself. Each link left is reported
//   in `records_left`; it is not damage, so it does not make `ok` false.
//   4. CHECK for damage and report it, never silently: no link may still name
//      the old path unresolved, every note must reach the moved note as often as
//      before, the moved note must reach each of its relative targets as often
//      as before, and every note the index says links it must have been found.

import { TFile, type App } from "obsidian";
import { indexedLinkers } from "./link-index.js";
import { parseLinks, rewriteLink, applyEdits, isRelativeLinkpath, type TextLink, type Edit } from "./link-rewrite.js";
import { recordTest, type IsRecord } from "./records.js";

/** At most this many records are named in `records_left`; `records_left_total` counts them all. */
export const RECORDS_LEFT_CAP = 100;

/** What the damage check found. `ok` is false whenever any DAMAGE list is non-empty (hidden notes included); `records_left` is not damage and never affects it. */
export interface LinkCheck {
  ok: boolean;
  /** Links rewritten, and in which notes (the moved note's own relative links included). Visible notes only. */
  links_rewritten: number;
  files_rewritten: string[];
  /** Notes read because their text names the note, and how many of them the index had not caught up with. */
  candidates: number;
  stale_sources: number;
  /** A link that still names the old path and now resolves to nothing. */
  still_linking_old: Array<{ path: string; link: string }>;
  /** A note that reached the note fewer times after the move than before. */
  not_reaching_new: Array<{ path: string; before: number; after: number }>;
  /** A note the moved note reached by a relative link fewer times after the move than before. */
  own_links_broken: Array<{ target: string; before: number; after: number }>;
  /** A note the index says links the note, where no link to it was found in its text (or, while its index entry is current, fewer links than the index counts). */
  index_only: string[];
  /** A note that could not be rewritten, and why. */
  failed: Array<{ path: string; reason: string }>;
  /**
   * A record whose links were left as written (01.44 rule 8) and no longer reach
   * their target after the move: each link that reached the note (or, for a
   * moved record, its own link). `index_only`: Obsidian's index says the record
   * links the note but its text gave no link to list. Not damage. At most
   * RECORDS_LEFT_CAP entries; `records_left_total` counts them all.
   */
  records_left: Array<{ path: string; links: string[]; index_only?: true }>;
  records_left_total: number;
  /** Milliseconds spent finding the links, and checking after the move. */
  find_ms: number;
  check_ms: number;
  /** Notes outside the caller's allowlist that the lists above do not name. */
  hidden: number;
}

export interface MoveWithLinksOptions {
  /** false: rename only, rewrite no links, the moved note's own included (the old `update_backlinks: false`, now honoured). */
  updateBacklinks?: boolean;
  /** Which paths the caller may see named; others are counted in `hidden`. Default: all. */
  visible?: (path: string) => boolean;
  /**
   * The vault's text, read once and shared by the moves of one batch. The scan
   * reads every note (about 1 to 2 s on a 22,000-note vault), so a batch of 50
   * moves would otherwise read the vault 50 times inside one 30 s queue slot.
   */
  texts?: TextCache;
  /**
   * false: the moved file's own text is never read for links or rewritten (a `.base` or `.canvas`
   * file, #575: YAML or JSON, which the Markdown link parser must not edit). Default true.
   */
  ownLinks?: boolean;
  /** Which notes are records, never rewritten. Every live road passes the operator's settings (#397, #482). Default: only the shipped note marker `record: true`, and NO folder (the plugin ships no folder names, #482). */
  isRecord?: IsRecord;
}

/**
 * Note text by path, read lazily. An entry is used only while the file's mtime
 * and size are what they were when it was read, so a write by anyone (another
 * plugin, the editor, a sync) makes the next move read the note again.
 */
export class TextCache {
  private readonly map = new Map<string, { text: string; mtime: number; size: number }>();
  constructor(private readonly app: App) {}
  async get(f: TFile): Promise<string> {
    const hit = this.map.get(f.path);
    if (hit && hit.mtime === f.stat.mtime && hit.size === f.stat.size) return hit.text;
    const stat = { mtime: f.stat.mtime, size: f.stat.size };
    const text = await this.app.vault.cachedRead(f);
    this.map.set(f.path, { text, ...stat });
    return text;
  }
  /** Drop a note this move rewrote: its next read comes from the vault. */
  forget(path: string): void { this.map.delete(path); }
  rename(from: string, to: string): void { const t = this.map.get(from); this.map.delete(from); if (t !== undefined) this.map.set(to, t); }
}

interface Plan {
  path: string;
  text: string;
  edits: TextLink[];
  /** The link targets (as written) that reached the note before the move: what the fallback rewrites. */
  linkpaths: Set<string>;
  before: number;
}

const lower = (s: string) => s.toLowerCase();

/** The forms a link to `name` may take in a note's text: as written, `%20`-encoded, and URI-encoded, each in both Unicode normal forms. */
function needles(name: string): string[] {
  const out = new Set<string>();
  for (const n of [name.normalize("NFC"), name.normalize("NFD")]) {
    out.add(lower(n));
    out.add(lower(n.replace(/ /g, "%20")));
    try { out.add(lower(encodeURI(n))); } catch { /* a lone surrogate: the plain form covers it */ }
  }
  return [...out];
}

/** The cache entry is current when Obsidian's recorded mtime and size match the file. */
function cacheIsFresh(app: App, f: TFile): boolean {
  const entry = (app.metadataCache as unknown as { fileCache?: Record<string, { mtime: number; size: number }> }).fileCache?.[f.path];
  return !!entry && entry.mtime === f.stat.mtime && entry.size === f.stat.size;
}

/**
 * True when any other note's CURRENT TEXT links to `file`: the same scan the
 * move's find step makes (every note whose text names it, parsed), so a link
 * written a moment ago counts although Obsidian's index has not caught up.
 */
export async function hasTextLinkers(app: App, file: TFile, texts: TextCache = new TextCache(app)): Promise<boolean> {
  const names = needles(file.basename);
  for (const src of app.vault.getMarkdownFiles()) {
    if (src === file) continue;
    const t = lower(await texts.get(src));
    if (!names.some((n) => t.includes(n))) continue;
    if (parseLinks(await texts.get(src)).some((l) => resolves(app, l.linkpath, src.path) === file)) return true;
  }
  return false;
}

function resolves(app: App, linkpath: string, source: string): TFile | null {
  if (!linkpath) return null;
  return app.metadataCache.getFirstLinkpathDest(linkpath, source);
}

function countBy<T>(xs: T[], key: (x: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
}

/**
 * Move `file` to `to` and rewrite every link to it. Throws only when the rename
 * itself fails (nothing moved). Every link-level problem is reported in the
 * returned LinkCheck instead.
 */
export async function moveWithLinks(app: App, file: TFile, to: string, opts: MoveWithLinksOptions = {}): Promise<LinkCheck> {
  const visible = opts.visible ?? (() => true);
  const update = opts.updateBacklinks !== false;
  const oldPath = file.path;
  const names = needles(file.basename);
  const check: LinkCheck = { ok: true, links_rewritten: 0, files_rewritten: [], candidates: 0, stale_sources: 0, still_linking_old: [], not_reaching_new: [], own_links_broken: [], index_only: [], failed: [], records_left: [], records_left_total: 0, find_ms: 0, check_ms: 0, hidden: 0 };
  const isRecord = opts.isRecord ?? recordTest();
  // Records whose links are left as written, with the links that reached the note (or, for the moved note, their targets).
  const recordLinks = new Map<string, TextLink[]>();
  const recordIndexOnly: string[] = [];

  // ── 1. find ───────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const texts = opts.texts ?? new TextCache(app);
  const plans = new Map<string, Plan>();
  // The moved note's own relative links break when its folder changes: their targets, by link path as written.
  const ownTargets = new Map<string, TFile>();
  const ownLinks: TFile[] = [];
  // The moved note's own links, left as written because it is a record before AND after the move, with what each reached.
  const ownLeft: Array<{ link: TextLink; target: TFile }> = [];
  let ownText = "";
  let movedIsRecord = false;
  if (update) {
    ownText = opts.ownLinks === false ? "" : await texts.get(file);
    // A record by its key travels with it; by folder, it stays a record only if it lands in a record folder too.
    // An un-archived note is living at its new path, so its links are healed as any other.
    movedIsRecord = isRecord(oldPath, ownText) && isRecord(to, ownText);
    for (const src of app.vault.getMarkdownFiles()) {
      const text = await texts.get(src);
      const t = lower(text);
      if (!names.some((n) => t.includes(n))) continue;
      check.candidates++;
      if (!cacheIsFresh(app, src)) check.stale_sources++;
      const edits = parseLinks(text).filter((l) => resolves(app, l.linkpath, src.path) === file);
      if (edits.length === 0) continue;
      if (src === file ? movedIsRecord : isRecord(src.path, text)) {
        if (src === file) for (const l of edits) ownLeft.push({ link: l, target: file });
        else recordLinks.set(src.path, edits);
        continue;
      }
      plans.set(src.path, { path: src.path, text, edits, linkpaths: new Set(edits.map((l) => l.linkpath)), before: edits.length });
    }
    // Cross-check with the index: a note it says links the note where the text scan found
    // nothing, or (while its index entry is current) fewer links than the index counts. The
    // parser and Obsidian's index can disagree on rare markdown; this makes a miss loud.
    for (const { src, count: indexed } of indexedLinkers(app, oldPath)) {
      if (recordLinks.has(src)) continue; // left as written, and listed in records_left
      const plan = plans.get(src);
      const f = app.vault.getAbstractFileByPath(src);
      if (!plan && f instanceof TFile && isRecord(src, await texts.get(f))) { recordIndexOnly.push(src); continue; }
      if (!plan || (plan.before < indexed && f instanceof TFile && cacheIsFresh(app, f))) check.index_only.push(src);
    }
    for (const l of parseLinks(ownText)) {
      if (!isRelativeLinkpath(l.linkpath)) continue;
      const target = resolves(app, l.linkpath, oldPath);
      if (!target || target === file) continue;
      if (movedIsRecord) { ownLeft.push({ link: l, target }); continue; }
      ownTargets.set(l.linkpath, target); ownLinks.push(target);
    }
  }
  const ownBefore = countBy(ownLinks, (t) => t.path);
  check.find_ms = Date.now() - t0;

  // ── 2. rename, without waiting for the metadata cache ────────────────────
  await app.vault.rename(file, to);
  texts.rename(oldPath, to);

  // ── 3. rewrite ────────────────────────────────────────────────────────────
  const newPathOf = (p: string) => (p === oldPath ? to : p);
  const sources = [...plans.values()];
  if (ownTargets.size > 0 && !plans.has(oldPath)) sources.push({ path: oldPath, text: "", edits: [], linkpaths: new Set(), before: 0 });
  const rewritten = new Map<string, number>();

  for (const plan of sources) {
    const srcPath = newPathOf(plan.path);
    const src = app.vault.getAbstractFileByPath(srcPath);
    if (!(src instanceof TFile)) { check.failed.push({ path: srcPath, reason: "note not found after the move" }); continue; }
    let n = 0;
    let becameRecord = false;
    try {
      await app.vault.process(src, (data) => {
        // Judged again on the text about to be written: a note made a record since the scan is left as written.
        if (srcPath !== to && isRecord(srcPath, data)) { becameRecord = true; return data; }
        // Planned positions when the text is what we read; else the links, re-found, whose target reached the note.
        const current = data === plan.text ? null : parseLinks(data);
        const links = current === null ? plan.edits : current.filter((l) => plan.linkpaths.has(l.linkpath));
        const edits: Edit[] = [];
        for (const l of links) {
          if (resolves(app, l.linkpath, srcPath) === file) continue; // the old text still reaches it by name
          edits.push({ start: l.start, end: l.end, expected: l.original, replacement: rewriteLink(l, to, srcPath, app.metadataCache.fileToLinktext(file, srcPath, true)) });
        }
        if (srcPath === to) {
          for (const l of current ?? parseLinks(data)) {
            const target = ownTargets.get(l.linkpath);
            if (!target || resolves(app, l.linkpath, to) === target) continue;
            edits.push({ start: l.start, end: l.end, expected: l.original, replacement: rewriteLink(l, target.path, to, app.metadataCache.fileToLinktext(target, to, true)) });
          }
        }
        const next = applyEdits(data, edits);
        if (next === null) throw new Error("the note's links overlap or moved while it was being rewritten");
        n = edits.length;
        return next;
      });
    } catch (e) {
      check.failed.push({ path: srcPath, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    texts.forget(srcPath);
    if (becameRecord) { plans.delete(plan.path); recordLinks.set(srcPath, plan.edits); continue; }
    if (n > 0) rewritten.set(srcPath, n);
  }

  // ── 4. check for damage ───────────────────────────────────────────────────
  const t1 = Date.now();
  if (update) {
    for (const plan of plans.values()) {
      const p = newPathOf(plan.path);
      const f = app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      let reaching = 0;
      for (const l of parseLinks(await app.vault.read(f))) {
        const dest = resolves(app, l.linkpath, p);
        if (dest === file) reaching++;
        // Only a link that reached the note before counts: one that was already broken is not this move's damage.
        else if (dest === null && plan.linkpaths.has(l.linkpath)) check.still_linking_old.push({ path: p, link: l.original });
      }
      if (reaching < plan.before) check.not_reaching_new.push({ path: p, before: plan.before, after: reaching });
    }
    if (ownBefore.size > 0) {
      const wanted = new Set([...ownTargets.values()]);
      const after = countBy(
        parseLinks(await app.vault.read(file)).filter((l) => isRelativeLinkpath(l.linkpath)).map((l) => resolves(app, l.linkpath, to)).filter((d): d is TFile => d !== null && wanted.has(d)),
        (d) => d.path,
      );
      for (const [target, before] of ownBefore) {
        const a = after.get(target) ?? 0;
        if (a < before) check.own_links_broken.push({ target, before, after: a });
      }
    }
  }
  // Records left as written: list only the links that no longer reach their target (a folder-only move leaves `[[Old]]` working).
  if (update) {
    for (const [p, links] of recordLinks) {
      const dangling = links.filter((l) => resolves(app, l.linkpath, p) !== file).map((l) => l.original);
      if (dangling.length > 0) check.records_left.push({ path: p, links: dangling });
    }
    const ownDangling = ownLeft.filter(({ link, target }) => resolves(app, link.linkpath, to) !== target).map(({ link }) => link.original);
    if (ownDangling.length > 0) check.records_left.push({ path: to, links: ownDangling });
    for (const p of recordIndexOnly) check.records_left.push({ path: p, links: [], index_only: true });
  }
  check.check_ms = Date.now() - t1;

  // Decide `ok` over everything, hidden notes included, then redact names the caller may not see.
  check.ok = check.still_linking_old.length === 0 && check.not_reaching_new.length === 0 && check.own_links_broken.length === 0 && check.index_only.length === 0 && check.failed.length === 0;
  const keep = (p: string) => { if (visible(p)) return true; check.hidden++; return false; };
  check.still_linking_old = check.still_linking_old.filter((x) => keep(x.path));
  check.not_reaching_new = check.not_reaching_new.filter((x) => keep(x.path));
  check.own_links_broken = check.own_links_broken.filter((x) => keep(x.target));
  check.failed = check.failed.filter((x) => keep(x.path));
  check.index_only = check.index_only.filter(keep);
  // The total counts every record left, hidden ones included (those are also counted in `hidden`).
  check.records_left_total = check.records_left.length;
  check.records_left = check.records_left.filter((x) => keep(x.path));
  check.records_left = check.records_left.slice(0, RECORDS_LEFT_CAP);
  for (const [p, n] of rewritten) if (keep(p)) { check.files_rewritten.push(p); check.links_rewritten += n; }
  return check;
}
