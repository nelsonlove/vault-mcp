// snapshot.ts — the headless vault reader. The ONLY I/O in the engine: it
// walks a content root, reads .md + .fileclass files, parses frontmatter, and
// produces the VaultSnapshot the pure packs consume. No Obsidian — the rail
// runs headless (CI / cron / CLI).
//
// Frontmatter parsing REUSES @vault-mcp/core's `parseAllFrontmatter` (the same
// best-effort top-level YAML scalar/array reader the filesystem-only server
// uses) — no new dependency, and the same disk-frontmatter semantics the
// Python rail assumed.
//
// Two listings, deliberately:
//   • notes  — .md AND .fileclass, each with {path, frontmatter, body} — the
//     vocab pack's input (types live in .fileclass; glossary in .md bodies).
//   • paths  — .md ONLY — the scheme pack's input (addresses attach to notes).
//
// excludedRoots drops whole subtrees BEFORE any read (the seam that keeps the
// archaeology tree out of the rail, aligned with worker-3's schemes[].excludedRoots).
//
// TERRITORY GUARD (#157): `root` is checked against a declared boundary and a
// hard deny-list BEFORE any of the above happens — see `assertRootPermitted`.

import { opendir, readFile } from "node:fs/promises";
import { realpathSync, lstatSync, readlinkSync } from "node:fs";
import { join, relative, resolve, dirname, basename, sep } from "node:path";
import { isExcludedTerritory, matchesTerritoryPrefix, parseAllFrontmatter, resolveTerritories, stripLeadingFrontmatter, type VocabNote } from "@vault-mcp/core";
import type { SourceFile, VaultSnapshot } from "./rule-pack.js";
import { intendedRealPath, isInside } from "./path-identity.js";
import { envAliased } from "@vault-mcp/core";

/** A guarded territory the walk met INSIDE the root and stepped around (#398):
 *  the vault-relative directory and the configured entry that covered it. */
export interface SkippedTerritory {
  path: string;
  territory: string;
}

export interface SnapshotOpts {
  /** Absolute content root to walk. */
  root: string;
  /**
   * The guarded territories this rail refuses to walk into, as vault-path
   * prefixes. There is NO built-in list (#397, ruled 2026-09-22): omitted or
   * blank means the walk refuses nothing on territory grounds, and every
   * caller that wants a territory refused passes the operator's list.
   *
   * Threaded rather than read from a module-level constant because #397: the
   * list is the HOST's setting now, and a rail pinned to the compiled-in
   * default would silently ignore a territory a human added. The SEGMENT
   * semantics below stay stricter than core's prefix match on purpose.
   */
  territories?: readonly string[];
  /**
   * The boundary `root` must resolve inside (or equal). NOT optional in
   * effect: if this is omitted, `buildSnapshot` falls back to reading
   * `GOVERNOR_CONTENT_ROOT` / `GOVERNOR_VAULT_ROOT` (legacy `ASSENT_*`
   * aliases accepted) from the environment, and if
   * NEITHER is present it refuses outright — see `assertRootPermitted`. There
   * is no further fallback: never `$HOME`, never the current working
   * directory, never a hardcoded path, and no upward filesystem walk to find
   * one. Pass this explicitly from programmatic callers (tests, one-off
   * corpus-measurement scripts); `cli.ts`'s own entry already has an
   * explicitly-resolved `root` and threads it through as its own boundary.
   */
  boundary?: string;
  /** Vault-relative path prefixes to exclude entirely (e.g. archaeology). */
  excludedRoots?: string[];
  /** Directory names skipped everywhere (VCS/config noise). */
  skipDirs?: string[];
}

export const DEFAULT_SKIP = new Set([".git", ".obsidian", ".trash", "node_modules"]);

// ── territory guard (#157) ──────────────────────────────────────────────
//
// Filed against a real breach: a corpus measurement commissioned for #143
// read `~/obsidian-old` — 12,072 notes, including 2,998 files under
// `80-89 Sensitive/` — to count frontmatter parse failures. Read-only, but the
// standing rule is flat: never `~/obsidian-old`, never `80-89` legal
// material, never anything under a hold.
//
// The bound is applied HERE, before `buildSnapshot` performs a single read —
// filtering the returned snapshot would be useless, because the exposure is
// the file CONTENTS that transit this process, not the aggregate this
// function returns.
//
// Identity is decided over the RESOLVED REAL PATH the filesystem reports,
// never a string prefix — the same technique `cli.ts`'s
// `intendedRealPath`/`isInside` pair uses to decide "is this the protected
// file" for the baseline-identity guard (#144: a string-comparison version of
// that exact question had three live bypasses — a decoupled `--root`, a
// hardlink, and a realpath-fallback that could be forced). Those helpers are
// not exported from `cli.ts`, and `cli.ts`'s baseline/rebaseline guard is live
// PATH IDENTITY IS IMPORTED, NEVER RE-IMPLEMENTED (#169).
//
// `realish`/`isWithin` used to live here as a fresh implementation of the same
// technique, because #144's helpers were unexported and that file is live
// acceptance-path code. They are exported now, so this imports them.
//
// The reason this matters more than ordinary DRY: the string-comparison
// predecessor of this comparison was bypassed THREE separate ways (#144 —
// caller-controlled `root`, hardlink/case alias, and a realpath fallback that
// could fabricate the record). Two copies of a security comparison means two
// places a future bypass has to be fixed, and only one of them will be.
//
// Verified equivalent before collapsing rather than assumed: a differential run
// over 12 path shapes (resolvable and dangling symlinks, a symlink loop, a
// non-existent path, `.`/`..`, the filesystem root) and 6 containment pairs
// found ZERO divergence. "Same technique" is not "same behaviour" — the two
// did differ cosmetically (`resolve` vs `join` on the re-appended basename;
// `isInside` resolves its inputs where `isWithin` assumed pre-resolved ones),
// and `isInside` is the strictly more defensive of the pair.

/**
 * The guarded-territory names, DERIVED from `@vault-mcp/core`'s published list
 * rather than restated here.
 *
 * This file used to hardcode its own three checks. That was the second
 * implementation of one rule, and it had already drifted: core's list carries
 * `_keep/`, which this file never denied. The suite split's S3b published
 * the territory predicate precisely so there is ONE list — the failure it names is
 * a prefix present in one copy and missing from another, which is how guarded
 * content reaches somewhere it should never be. Deriving keeps this rail from
 * hardcoding its OWN second copy of the list.
 *
 * #321 landed as a per-operator setting and #397 moved it to the HOST, which
 * is where it had to live: the other consumer is observation capture, which
 * writes note bodies outside the vault and runs whether or not Governor is
 * installed. This rail derives its segments from `opts.territories` — the
 * operator's list, resolved — and from nothing else: a caller that supplies
 * none gets a walk that refuses nothing, honestly, rather than one guarded by
 * a list the operator never wrote.
 *
 * The SEGMENT semantics stay local and are deliberately stricter than core's
 * path-prefix matching: every segment of a resolved real path is checked, so a
 * symlink cannot launder a guarded directory into the middle of an allowed one.
 */
/** A territory list as the SEGMENT forms this rail matches on — trailing
 * separators stripped, lowercased. Derived rather than written twice: a second
 * hand-maintained copy of the names is the exact drift the shared predicate was
 * centralized to prevent. #397 makes the input configurable; the derivation is
 * unchanged. */
/** A configured entry in the two forms the real-path checks need: normalized
 *  for matching (lowercase, one trailing slash at most) and as the operator
 *  wrote it, for the refusal message. */
interface DeniedEntry {
  norm: string;
  entry: string;
}

function deniedSegmentsOf(prefixes: readonly string[]): ReadonlyArray<DeniedEntry> {
  // A trailing slash is KEPT (normalized to one): it is the operator saying
  // "exactly this folder", and `matchesTerritoryPrefix` honours it only if it
  // is still there. Stripping it turned `Archive/` into a bare `archive` that
  // also refused `Archive Old` (re-review of #396).
  return prefixes.map((p) => ({ norm: p.replace(/\/+$/, "/").toLowerCase(), entry: p }));
}


/** A single path SEGMENT (one directory or file name — no separators) that is
 * refused EVEN WHEN it falls inside a declared boundary and even when the
 * caller asks for it explicitly by name — the one case where an explicit
 * request is exactly what should be refused (issue #157). Returns the human
 * name of the violated territory, or null when nothing matched. No syscall:
 * used both against a RESOLVED real path's segments (`deniedTerritory`) and,
 * during the walk, against an already-verified-real directory's own name
 * (cheap — no need to re-resolve a real path for something that is already
 * known not to be a symlink). */
function deniedSegment(seg: string, segments: ReadonlyArray<DeniedEntry>): string | null {
  const s = seg.toLowerCase();
  for (const { norm: denied, entry } of segments) {
    // The SAME boundary rule core's `isExcludedTerritory` applies to whole
    // paths (#321): `80-89` and `80-89 Sensitive` match, `80-891` and
    // `80-89-archive` do not. One rule, published once, so the walker and the
    // capture gate can never disagree about what a listed entry covers.
    // The segment is compared WITH a trailing slash so an entry that ends in
    // `/` matches exactly that folder name and nothing longer.
    if (matchesTerritoryPrefix(s + "/", denied)) {
      return entry;
    }
  }
  // The `hold`/`holds` segment heuristic that used to live here is GONE (#397):
  // it was one vault's convention baked in, and with an empty configured list
  // it would still have refused paths — making "empty means guard nothing"
  // false. An operator who wants hold folders guarded lists them.
  return null;
}

/** Every segment of the RESOLVED real path, checked with `deniedSegment` — so
 * a symlink cannot launder past this either. Returns the human name of the
 * violated territory, or null when nothing matched. */
/** The descend-time decision over a VAULT-RELATIVE directory path, made with
 *  the published predicate itself (one entry at a time, so the refusal can name
 *  the entry as the operator wrote it). */
function deniedVaultPath(vaultPath: string, list: readonly string[]): string | null {
  for (const entry of list) {
    if (isExcludedTerritory(vaultPath + "/", [entry])) return entry;
  }
  return null;
}

function deniedTerritory(realPath: string, segments: ReadonlyArray<DeniedEntry>): string | null {
  for (const seg of realPath.split(sep)) {
    if (!seg) continue;
    const hit = deniedSegment(seg, segments);
    if (hit) return hit;
  }
  return null;
}

/** The declared boundary `root` must resolve inside, or null when none is
 * declared. NO fallback: `opts.boundary`'s absence does not default to
 * `$HOME`, the current working directory, or any hardcoded path, and there is
 * no upward filesystem walk to find one — an undeclared boundary is a
 * refusal, decided by the caller (`assertRootPermitted`), not a default
 * decided here. */
function declaredBoundary(opts: SnapshotOpts): string | null {
  return (
    opts.boundary ??
    envAliased(process.env, "CONTENT_ROOT") ??
    envAliased(process.env, "VAULT_ROOT") ??
    null
  );
}

/**
 * Throws if `opts.root` may not be walked; otherwise returns the resolved
 * REAL boundary path, so the walk below can re-run the same checks against
 * anything it discovers mid-tree (a symlinked file, or a plainly-named
 * denied subdirectory a few levels down) — checking `root` alone is not
 * "unconditional": it bounds what `root` may equal, not what the walk may
 * actually read. Called as the FIRST statement of `buildSnapshot`, before any
 * filesystem read.
 *
 * Three independent refusals, checked in this order (a listed territory met
 * INSIDE the root during the walk is a fourth case and is NOT a refusal since
 * #398: it is skipped and reported — see the descend site in `buildSnapshot`):
 *
 * 1. The root's real path cannot be established at all — refuse rather than
 *    guess (an indeterminate identity is not a permitted one).
 * 2. The root's real path falls inside a CONFIGURED guarded territory
 *    (`opts.territories` — the operator's list; there is no built-in one
 *    since #397, so an empty list refuses nothing here) — refused
 *    UNCONDITIONALLY, before the boundary is even consulted, so this holds
 *    even when a boundary was declared that would otherwise have permitted
 *    it, and even when the caller names the territory explicitly.
 * 3. No boundary is declared, or the root's real path resolves outside the
 *    declared boundary's real path.
 *
 * Refusal messages name WHICH rule was violated so the fix is obvious, but
 * never print a resolved real path that differs from what the caller
 * supplied — a symlink's true target is not something a caller pointing at
 * the symlink is necessarily entitled to see echoed back.
 */
function assertRootPermitted(opts: SnapshotOpts): string {
  const realRoot = intendedRealPath(opts.root);
  if (realRoot === null) {
    throw new Error(
      `buildSnapshot: refusing to walk ${opts.root} — its real path could not be established (unreadable ` +
        `ancestor or a symlink loop). An indeterminate root is refused, never assumed safe.`,
    );
  }

  const denied = deniedTerritory(realRoot, deniedSegmentsOf(resolveTerritories(opts.territories)));
  if (denied) {
    throw new Error(
      `buildSnapshot: refusing to walk ${opts.root} — it resolves into a permanently denied territory ` +
        `(the guarded territory '${denied}'). This is refused even when explicitly requested and even when it falls inside a declared ` +
        `boundary.`,
    );
  }

  const boundary = declaredBoundary(opts);
  if (!boundary) {
    throw new Error(
      "buildSnapshot: refusing to walk — no content-root boundary declared. Pass `boundary` explicitly, or set " +
        "GOVERNOR_CONTENT_ROOT (or GOVERNOR_VAULT_ROOT; the legacy ASSENT_* spellings are accepted too). " +
        "There is no default to $HOME, the current working " +
        "directory, or any hardcoded path, and no upward filesystem walk to find one.",
    );
  }

  const realBoundary = intendedRealPath(boundary);
  if (realBoundary === null) {
    throw new Error(
      `buildSnapshot: refusing to walk — the declared boundary could not be resolved. An indeterminate ` +
        `boundary is refused, never assumed to permit everything.`,
    );
  }

  if (!isInside(realBoundary, realRoot)) {
    throw new Error(
      `buildSnapshot: refusing to walk ${opts.root} — it resolves outside the declared content-root boundary. ` +
        `A corpus measurement may only read notes within the vault its boundary declares.`,
    );
  }

  return realBoundary;
}

function toVaultPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function isExcluded(vaultPath: string, excluded: string[]): boolean {
  return excluded.some((e) => vaultPath === e || vaultPath.startsWith(e.replace(/\/$/, "") + "/"));
}

/** The leading frontmatter block's parsed contents and the body after it.
 *
 * BOTH halves bind to core's shared recognizer (`parseAllFrontmatter` /
 * `stripLeadingFrontmatter`, #150) rather than one of them re-deriving the
 * fence locally. That is not tidiness: when the two disagree the note is
 * neither skipped nor read correctly — it is read with its own frontmatter
 * still inside the body, so every H2/vocab check runs over YAML as if it were
 * prose. That split brain is precisely what a local copy of the pattern
 * produces the moment the shared one is widened (a BOM-tolerant parser beside
 * a BOM-blind body regex), which is how it nearly shipped here.
 *
 * The CRLF pre-normalization is kept because downstream checks index by line
 * offsets into this body and expect LF; the recognizer itself is CRLF-native
 * either way. */
function splitNote(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  return {
    frontmatter: parseAllFrontmatter(text) as Record<string, unknown>,
    body: stripLeadingFrontmatter(text),
  };
}

/** One directory's entries in RAW order (the OS `readdir`/`scandir` order), via
 * `opendir` iteration. This is deliberate, not `readdir`: libuv SORTS
 * `fs.readdir` results, whereas Python's `Path.rglob`/`os.scandir` (which the
 * drift pack's traversal-ordered uid checks must match byte-for-byte) yields
 * raw directory order. `opendir` iteration preserves that raw order, verified
 * identical to CPython `rglob` over the live vault. */
async function rawEntries(absDir: string) {
  const out: import("node:fs").Dirent[] = [];
  let dir;
  try {
    dir = await opendir(absDir);
  } catch {
    return out; // unreadable dir — skip, never crash the run
  }
  try {
    for await (const entry of dir) out.push(entry);
  } catch {
    return out;
  }
  return out;
}

export async function buildSnapshot(opts: SnapshotOpts): Promise<VaultSnapshot> {
  // Resolved ONCE per walk, not per directory entry and per symlink. The list
  // cannot change mid-walk, and a whole-vault walk would otherwise re-derive it
  // thousands of times.
  const territoryList = resolveTerritories(opts.territories);
  const deniedSegs = deniedSegmentsOf(territoryList);
  const realBoundary = assertRootPermitted(opts);
  const excluded = opts.excludedRoots ?? [];
  const skip = new Set([...DEFAULT_SKIP, ...(opts.skipDirs ?? [])]);
  const notes: VocabNote[] = [];
  const paths: string[] = [];
  // Raw source text for the ported legacy packs (structure/port/ste). The `.md`
  // raw text feeds port/ste (line-by-line regex scans over the whole file,
  // frontmatter included); `.blueprint` raw text feeds the structure pack.
  // Universal-newline-normalized so `^---\n` anchors bite on CRLF-authored
  // files, matching Python's `Path.read_text`.
  const sources: SourceFile[] = [];
  const blueprints: SourceFile[] = [];
  // Drift-pack inputs. `dirs` is J's universe (and, with `files`, the dead-
  // convention check's); `walkOrder` is the `.md` paths in raw traversal
  // order (drift's E embeds a traversal-ordered homes list in its finding
  // MESSAGE). See rule-pack.ts.
  const files: string[] = [];
  const dirs: string[] = [];
  const skippedTerritories: SkippedTerritory[] = [];
  const walkOrder: string[] = [];

  // pathlib `rglob("*.md")` traversal: for each directory in pre-order DFS
  // (siblings in raw scandir order), yield that directory's matching files
  // BEFORE descending into its subdirectories. Reproduced as two passes per
  // directory (files first, then subdirs), both in raw `opendir` order, so
  // `walkOrder` matches CPython's order exactly.
  async function walk(absDir: string): Promise<void> {
    const entries = await rawEntries(absDir);
    // Pass 1 — files (raw order).
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const abs = join(absDir, entry.name);
      const vaultPath = toVaultPath(opts.root, abs);
      if (isExcluded(vaultPath, excluded)) continue;
      // A symlinked FILE is the one entry shape the root-level territory
      // guard cannot see: `entry.isDirectory()` is false for it regardless of
      // its target, so it reaches this loop untouched by anything above. Its
      // REAL target — not its in-tree location — is what `readFile` below
      // will actually honor, so it gets the identical checks `root` got,
      // BEFORE that read happens.
      if (entry.isSymbolicLink()) {
        const real = intendedRealPath(abs);
        if (real === null) {
          throw new Error(
            `buildSnapshot: refusing to read ${vaultPath} — its real path could not be established (unreadable ` +
              `ancestor or a symlink loop). An indeterminate target is refused, never assumed safe.`,
          );
        }
        const denied = deniedTerritory(real, deniedSegs);
        if (denied) {
          throw new Error(
            `buildSnapshot: refusing to read ${vaultPath} — it is a symlink resolving into a permanently denied ` +
              `territory (the guarded territory '${denied}'). This is refused even though it sits inside an otherwise-permitted tree.`,
          );
        }
        if (!isInside(realBoundary, real)) {
          throw new Error(
            `buildSnapshot: refusing to read ${vaultPath} — it is a symlink resolving outside the declared ` +
              `content-root boundary.`,
          );
        }
      }
      files.push(vaultPath);
      const isMd = entry.name.endsWith(".md");
      const isFileclass = entry.name.endsWith(".fileclass");
      const isBlueprint = entry.name.endsWith(".blueprint");
      if (!isMd && !isFileclass && !isBlueprint) continue;
      let text = "";
      try {
        text = await readFile(abs, "utf8");
      } catch {
        continue; // unreadable file — skip
      }
      // Universal-newline normalize (CRLF/CR → LF) up front, so both the parsed
      // listing and the raw sources see the same LF text Python's read_text saw.
      //
      // KNOWN PARITY EDGE (#125 item 3, carried forward from the superseded
      // `de1868e`): the ported packs then split this on \n, whereas Python's
      // `str.splitlines()` — which the original rail used — ALSO breaks on
      // \v, \f, \x85, U+2028 and U+2029. A note containing any of those would
      // give the TS packs one line where Python saw two, so a finding whose
      // regex is line-anchored could differ. Verified zero live occurrences
      // across the parity runs, which is why the ports were accepted as
      // byte-equal; it is a latent edge, not a live one. Deliberately NOT
      // "fixed" by widening the split: that would change keys for a case that
      // does not occur, and the Python rail it had to match is now retired.
      // Tracked with the other latent parity edges in #112.
      const raw = text.replace(/\r\n?/g, "\n");
      if (isBlueprint) {
        blueprints.push({ path: vaultPath, text: raw });
        continue; // blueprints are not vocab/scheme notes
      }
      const { frontmatter, body } = splitNote(raw);
      notes.push({ path: vaultPath, frontmatter, body });
      if (isMd) {
        paths.push(vaultPath);
        sources.push({ path: vaultPath, text: raw });
        walkOrder.push(vaultPath); // raw traversal order (drift E)
      }
    }
    // Pass 2 — subdirectories (raw order).
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const abs = join(absDir, entry.name);
      const vaultPath = toVaultPath(opts.root, abs);
      if (isExcluded(vaultPath, excluded)) continue;
      if (skip.has(entry.name)) continue;
      // The descend decision is core's OWN predicate over the vault-relative
      // path — the same call the capture gate makes, and NOTHING else — so an
      // entry covers here exactly what it covers there: `80-89 Sensitive/Evidence`
      // covers that nested folder, a bare `Evidence` covers a top-level
      // `Evidence` and not `Notes/Evidence` (#400 review: the per-segment
      // fallback that used to sit beside this over-skipped by bare name). The
      // per-segment check survives only for what the predicate cannot see — a
      // symlink or a root resolving OUTSIDE the vault, above and below.
      //
      // A listed territory INSIDE the root is SKIPPED, not refused (#398, ruled
      // 2026-09-22). #157's refusal was written when the guarded areas lived
      // outside the vault; once one lives inside it, refusing the whole run
      // made the rail useless on exactly the vaults that guard something. The
      // property #157 wanted — the rail never READS a territory — holds under a
      // skip as fully as under a throw. The skip is recorded and reported, never
      // silent (a folder that is quietly absent reads as clean), and a baseline
      // key under it refuses the run (`guardedTerritoryRefusal`, cli.ts). The
      // root-inside-a-territory and symlink-into-a-territory refusals are
      // unchanged: those are escapes, not folders in the tree.
      const covered = deniedVaultPath(vaultPath, territoryList);
      if (covered) {
        skippedTerritories.push({ path: vaultPath, territory: covered });
        continue;
      }
      dirs.push(vaultPath);
      await walk(abs);
    }
  }

  await walk(opts.root);
  notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  paths.sort();
  const byPath = (a: SourceFile, b: SourceFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  sources.sort(byPath);
  blueprints.sort(byPath);
  // notes/paths/sources/blueprints are SORTED (order-independent consumers);
  // files/dirs/walkOrder keep TRAVERSAL order (walkOrder's order is
  // load-bearing for drift's E message — leave it unsorted).
  return { notes, paths, sources, blueprints, files, dirs, walkOrder, skippedTerritories };
}

