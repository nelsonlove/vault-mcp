// obsidian-source.ts — the live vault adapter, the only Obsidian coupling in
// this package (the triage/crosssession satellites' pattern: a separate file so
// tools.ts stays obsidian-free and headless-testable; only main.ts imports
// this).
//
// DUCK-TYPED against `app` rather than importing `obsidian` types, exactly as
// it was in the host — it keeps the file loadable in a plain node process if a
// future test ever wants to drive it, and it costs nothing.
//
// Two things here are load-bearing and easy to get wrong:
//
//   * `vault.getFiles()`, NOT `getMarkdownFiles()`. The blueprint provider's
//     TYPE entries are `.fileclass` files, which are not markdown; enumerating
//     only markdown would make every configured type silently vanish.
//   * `cachedRead`, not `adapter.read`. Bodies are read only for the shapes the
//     metadata cache cannot serve — a `.fileclass` file's frontmatter, a
//     glossary chapter's `## Terms` section, and a scope note's `## Tags`
//     table — and the tool layer decides which files those are before
//     anything is opened (see `buildListing`).

import type { VocabSource } from "./tools.js";

/** The adapter over Obsidian's vault and metadata cache. */
export function obsidianVocabSource(app: {
  vault: {
    getFiles(): Array<{ path: string }>;
    getAbstractFileByPath(path: string): unknown;
    cachedRead(file: unknown): Promise<string>;
  };
  metadataCache: { getCache(path: string): { frontmatter?: Record<string, unknown> } | null };
}): VocabSource {
  return {
    paths: () => app.vault.getFiles().map((f) => f.path),
    frontmatter: (path) => app.metadataCache.getCache(path)?.frontmatter ?? null,
    body: async (path) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) return null;
      try {
        return await app.vault.cachedRead(file);
      } catch {
        return null;
      }
    },
  };
}
