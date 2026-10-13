// visibility.ts — the path-allowlist visibility predicate, published as a
// contract at the skills satellite extraction (suite split, S4).
//
// WHY IT LIVES IN CORE. `isVisible` was born in the host's `src/guard.ts` and
// is the one rule every disclosing surface asks: "may this session be told
// about this path?" The skills compiler's preview filter asks it too, and the
// skills compiler is now its own plugin. The alternative was a second copy of
// the predicate inside the satellite — the drift this repo has already paid
// for twice (the accept-guard recognizer, the guarded-territory prefix list),
// and a guard predicate is exactly the wrong thing to fork: a copy that
// normalizes differently is a bypass nobody notices until it is a leak.
//
// It is a pure function over (path, settings) and `GuardSettings` is the kind
// of small published shape core already carries (SessionV1, the disposition
// descriptors, the territory predicate). Nothing here imports obsidian, the MCP SDK,
// or anything host-side.
//
// The host's `guard.ts` keeps `guardCall`, `visiblePaths`, `mapPaths` and
// `collectPaths` — those know the tool surface's ARGUMENT shapes, which is
// host knowledge — and re-exports this type so its own importers are
// unchanged. `guardCall`'s allowlist branch is defined over `isVisible`, so the
// one-path answer and the whole-call answer cannot disagree.

/** Read-only mode plus the path allowlist — the two settings every guard
 * decision reads. An empty (or absent) allowlist means "no path restriction". */
export interface GuardSettings {
  readOnly: boolean;
  allowlist: string[];
  /** What a session may write, separate from what it may read (write-scope.ts). Absent ⇒ no write rule. */
  writeScope?: unknown;
}

/** POSIX `path.normalize`, inlined so this module has no node dependency at
 * all (core is imported by browser-side plugin bundles). Collapses `.` and
 * `..` segments and repeated slashes, preserving a leading `/` and any
 * unresolvable leading `..` — which is exactly what the caller below tests
 * for. Behaviour matches `node:path`'s posix.normalize for the relative,
 * vault-relative paths the guard sees. */
export function normalizePosix(input: string): string {
  const absolute = input.startsWith("/");
  const trailingSlash = input.length > 1 && input.endsWith("/");
  const out: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  let joined = out.join("/");
  if (joined === "" && !absolute) return ".";
  if (trailingSlash) joined += "/";
  return absolute ? "/" + joined : joined;
}

/**
 * May a session with these settings be TOLD ABOUT this path?
 *
 * No allowlist ⇒ everything is visible. With one, the path is normalized
 * FIRST — collapsing `.` / `..` so `Projects/../Secrets/x.md` cannot pass a
 * prefix check and then resolve elsewhere inside Obsidian (the allowlist
 * traversal bypass) — and then must equal an allowlist entry or sit under one
 * at a segment boundary. A normalized path that still escapes upward (`..`)
 * is never visible.
 */
export function isVisible(path: string, settings?: GuardSettings | null): boolean {
  const allowlist = settings?.allowlist;
  if (!allowlist?.length) return true;
  const p = normalizePosix(path);
  if (p.startsWith("..")) return false;
  for (const raw of allowlist) {
    const prefix = raw.replace(/\/+$/, "");
    if (!prefix) continue;
    if (p === prefix || p.startsWith(prefix + "/")) return true;
  }
  return false;
}
