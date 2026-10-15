// `isVisible` and `GuardSettings` now live in @vault-mcp/core (published at the
// skills satellite extraction — the skills compiler is its own plugin and asks
// the same disclosure question, and a second copy of a guard predicate is the
// drift this repo has paid for twice). The argument-path walk and the
// disclosure filter (mapPaths / collectPaths / visiblePaths) moved to core too on
// 2026-10-14, for the conformance and scheme satellites; this file re-exports them
// and keeps guardCall. `guardCall`'s allowlist branch is defined over core's
// `isVisible`, so the one-path answer and the whole-call answer cannot disagree.
import { isVisible, type GuardSettings } from "@vault-mcp/core";

export { isVisible };
export type { GuardSettings };

// mapPaths, collectPaths and visiblePaths live in core (guard-paths.ts) since 2026-10-14, so a
// satellite reads the same walk; re-exported here so no importer in this package moved.
import { mapPaths, collectPaths, visiblePaths } from "@vault-mcp/core";
export { mapPaths, collectPaths, visiblePaths };

// `isVisible` — `visiblePaths` for ONE path, for the surfaces whose disclosure
// is a single name rather than a list (the active note, a link's resolved
// destination, a skills preview body). It is re-exported at the top of this
// file from @vault-mcp/core, where it now lives so the extracted satellites can
// ask the identical question. `visiblePaths` and `guardCall` are both defined
// over it, so the one-path, many-path, and whole-call answers cannot disagree.

// Returns a blocking reason, or null if the call is allowed.
export function guardCall(opts: {
  isMutating: boolean;
  args: Record<string, unknown>;
  settings: GuardSettings;
}): { code: string; message: string } | null {
  const { isMutating, args, settings } = opts;
  if (settings.readOnly && isMutating) {
    return { code: "read_only", message: "vault-mcp is in read-only mode; mutating tools are blocked. Turn it off in the plugin settings." };
  }
  if (settings.allowlist.length) {
    // One path at a time through core's `isVisible` — which normalizes first
    // (collapsing "." / ".." so "20-29 People/../00-09 System/x.md" cannot pass
    // the prefix check and then resolve elsewhere inside Obsidian: the
    // allowlist traversal bypass) and then prefix-matches at a segment
    // boundary. Defining the whole-call check over the one-path check is what
    // keeps them from ever disagreeing.
    for (const raw of collectPaths(args)) {
      if (!isVisible(raw, settings)) {
        return { code: "out_of_allowlist", message: `path '${raw}' is outside the vault-mcp allowlist` };
      }
    }
  }
  return null;
}
