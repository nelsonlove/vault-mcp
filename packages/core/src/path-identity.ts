// path-identity.ts — the ONE answer to "is this path the protected one?".
//
// A neutral home, deliberately. These helpers began life inside `cli.ts`
// (#144), which made them awkward to reach: #168 needed the same technique for
// the corpus-boundary guard and re-implemented it rather than import from a
// live acceptance-path file with other PRs against it. #151 exported them and
// #169 collapsed the copy — but leaving them in `cli.ts` re-creates the exact
// pressure that produced the duplication, and makes `snapshot.ts` depend on the
// CLI entry point, dragging its init surface into every snapshot caller.
//
// WHY THIS IS SECURITY-CRITICAL, so nobody "simplifies" it back to a string
// compare: the predecessor of this comparison was bypassed THREE separate ways
// in #144 — a caller-controlled `root`, a hardlink/case alias (APFS `realpath`
// does not case-canonicalize), and a `realpath` fallback that let a dangling
// symlink FABRICATE the accepted-debt record. Every one of those looked like a
// reasonable simplification beforehand.
//
// The invariants each branch buys:
//   • a dangling symlink is followed BY HAND, never treated as non-existent —
//     silently falling back to a lexical resolve is itself the bypass;
//   • identity is the filesystem's answer (device + inode) where both sides
//     exist, because no string comparison can see a hardlink;
//   • null means "cannot establish identity", and every caller must treat that
//     as REFUSE — never as "not the protected one".

import { realpathSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * The path a write to `p` would actually land on, following symlinks, WITHOUT
 * silently degrading when `p` does not exist yet.
 *
 * `realpathSync` throws on a non-existent path, and the previous version caught
 * that and fell back to `resolve()`. That fallback was the bug (#144): it could
 * not tell "does not exist" from "could not resolve", so a DANGLING symlink
 * aimed at the live record resolved to its own name, compared unequal, and the
 * write was allowed — creating the live acceptance record from nothing. So:
 * resolve the deepest existing ancestor for real, then re-append the segments
 * below it. A dangling symlink is followed by hand rather than ignored.
 *
 * Returns null when identity genuinely cannot be established; every caller
 * treats null as "refuse", never as "not the live one".
 *
 * EXPORTED deliberately (#168): this technique — realpath resolution, a
 * dangling symlink followed by hand, no lexical fallback that could launder an
 * alias — is security-critical and was being reimplemented elsewhere precisely
 * because it was unexported. A second copy is a second place a bypass has to be
 * fixed, and this codebase has spent a week deleting duplicated guards. One
 * implementation, imported.
 */
export function intendedRealPath(p: string, depth = 0): string | null {
  if (depth > 8) return null; // symlink loop
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    /* does not exist (or is a dangling link) — fall through */
  }
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      // Dangling symlink: follow it manually. Its TARGET is where a write lands.
      return intendedRealPath(resolve(dirname(abs), readlinkSync(abs)), depth + 1);
    }
  } catch {
    /* no lstat either — a plain non-existent path; resolve its parent */
  }
  const parent = dirname(abs);
  if (parent === abs) return null;
  const realParent = intendedRealPath(parent, depth + 1);
  return realParent === null ? null : join(realParent, basename(abs));
}

/** Same file by the FILESYSTEM's answer (device + inode), which is what catches
 * a hardlink or a case-insensitive alias. Null when either side cannot be stat'd. */
export function sameFile(a: string, b: string): boolean | null {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return null;
  }
}

/** `child` is inside `parent` (or is `parent`), compared on resolved paths. */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}