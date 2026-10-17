// audit-output.ts — report cap 2 (report-caps.ts): the full finding set goes
// to a JSON file OUTSIDE the vault, under `~/.local/share/vault-audits/`, never
// inside an indexed folder. Kept apart from report-caps.ts because it reads the
// filesystem, and report-caps.ts must stay importable from tools.ts.

import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";

/** Cap 2: the folder the full finding sets go to — `$XDG_DATA_HOME/vault-audits`, else `~/.local/share/vault-audits`. */
export function auditsDir(env: Record<string, string | undefined> = process.env): string {
  const xdg = (env.XDG_DATA_HOME ?? "").trim();
  return join(xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), ".local", "share"), "vault-audits");
}

/** The real path of `p`, or of its nearest existing ancestor with the rest re-joined (so a file not yet written still resolves through a symlinked folder). */
function realish(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    tail.unshift(cur.slice(up.length).replace(/^[\\/]+/, ""));
    cur = up;
  }
  let real = cur;
  try {
    // The native call returns the case stored on disk; the JS one keeps the case typed, and APFS ignores
    // case, so "/Users/x/OBSIDIAN" would not compare inside "/Users/x/obsidian" (#555 review 1).
    real = realpathSync.native(cur);
  } catch {
    /* keep the resolved path */
  }
  return tail.length ? join(real, ...tail) : real;
}

/** Cap 2's refusal: the full finding set must never land inside the vault (an indexed folder), whatever path is asked for. Null when `outPath` is outside `vaultRoot`. */
export function fullFindingsPathRefusal(outPath: string, vaultRoot: string): string | null {
  // macOS and Windows file systems ignore case by default: compare case-folded there, too.
  const fold = (p: string) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);
  const out = fold(realish(outPath));
  const root = fold(realish(vaultRoot));
  const rel = relative(root, out);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return `refusing to write the full finding set to '${outPath}': it is inside the vault (${vaultRoot}), where Obsidian would index it. Write it under ${auditsDir()} (the default) or another folder outside the vault.`;
  }
  return null;
}
