// obsidian_write_note, obsidian_append_note, obsidian_manage_frontmatter,
// obsidian_patch_note, obsidian_move_note, and obsidian_delete_note have been
// migrated to registerFsTools + ObsidianBackend in server.ts.
//
// This file retains the live-only tools that are not part of the 17
// fs-expressible set — obsidian_move_notes (batch move/rename),
// obsidian_repoint_link (repoint broken wikilinks) and obsidian_rename_heading
// (rename a heading and heal every link to it, #424) — along with their helpers.

import { UnsafeNameError, assertLinkRewriteAllowed } from "@vault-mcp/core";
import { assertMoveName } from "./name-checks.js";
import { moveWithLinks, TextCache, type LinkCheck, type MoveWithLinksOptions } from "./move-with-links.js";
import { recordTest, type RecordRules } from "./records.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile } from "obsidian";
import { ok, fail, okError, validateMoves } from "./helpers.js";
import { repointLinksInText } from "./repoint.js";
import { applyEdits, headingKey, newHeadingRefusal, rewriteHeadingLine, rewriteLinkOriginal, type Edit } from "./rename-heading.js";
import { isVisible, visiblePaths, type GuardSettings } from "../guard.js";

export const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export interface VaultWriteToolsCtx {
  /**
   * The guard's settings — the allowlist `obsidian_repoint_link` scopes its
   * VAULT-WIDE SCAN by. Absent ⇒ no allowlist ⇒ unfiltered, exactly as before.
   *
   * The guard checks the paths an operation NAMES IN ITS ARGUMENTS, and a
   * repoint names only its target: the set it reads, rewrites and then reports
   * back is derived inside the handler, where no per-argument check can reach
   * it. So the handler applies the same rule to that set itself.
   */
  getSettings?: () => GuardSettings;
  /**
   * Whether a note is a RECORD (the operator's record identification, #264 /
   * #397). `obsidian_rename_heading` rewrites links in notes it discovers, so
   * the kernel's record check — which sees only the paths an operation names —
   * cannot reach them; the handler skips a record itself and reports it.
   * Absent ⇒ no note is treated as a record.
   */
  isRecord?: (path: string) => boolean;
  /**
   * The operator's record identification (#397), read live per call, for the
   * move's own record test (records.ts), which judges a note on its current
   * text. Absent ⇒ the shipped default `record: true`.
   */
  recordIdentification?: () => RecordRules;
}

async function ensureParentFolders(app: App, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  parts.pop();
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try { await app.vault.createFolder(cur); } catch { /* exists / race */ }
    }
  }
}

/**
 * Move one note and rewrite its backlinks ourselves (move-with-links.ts): a
 * file-level rename that does not wait for Obsidian's metadata cache to go
 * clean, followed by the rewrite and a damage check whose findings are
 * returned, never swallowed.
 */
export async function moveOne(app: App, from: string, to: string, overwrite: boolean, opts: MoveWithLinksOptions = {}): Promise<LinkCheck> {
  if (!from.endsWith(".md")) throw new Error("source must end in .md");
  if (!to.endsWith(".md")) throw new Error("destination must end in .md");
  if (from === to) throw new Error("from and to are the same path");
  // Before anything is trashed or any folder is made (the scheme moves come here without the batch pre-check).
  await assertMoveName(app, from, to, overwrite, opts.texts);
  const file = app.vault.getAbstractFileByPath(from);
  if (!(file instanceof TFile)) throw new Error(`not found: ${from}`);
  const dest = app.vault.getAbstractFileByPath(to);
  let trashedDest = false;
  if (dest) {
    if (!overwrite) throw new Error(`destination exists (set overwrite=true): ${to}`);
    // Recoverable delete: if the subsequent rename fails, the overwritten note is in trash.
    if (dest instanceof TFile) {
      await app.vault.trash(dest, true);
      trashedDest = true;
    }
  }
  await ensureParentFolders(app, to);
  try {
    return await moveWithLinks(app, file, to, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (trashedDest)
      throw new Error(`${msg} (the note previously at '${to}' was already moved to the system trash and is recoverable there)`);
    throw e;
  }
}

export function registerVaultWriteTools(server: McpServer, app: App, ctx: VaultWriteToolsCtx = {}) {
  server.registerTool(
    "obsidian_move_notes",
    {
      title: "Move/rename multiple notes",
      description:
        "Move or rename several notes in one call. Items are processed sequentially. Each note is renamed at the file level (no wait for Obsidian's index) and vault-mcp rewrites every link to it itself, then checks for damage: each item's `link_check` reports any link still naming the old path, any note reaching the note fewer times than before, any note it could not rewrite, and `ok`. A note whose rewrite the written-content guard refuses (a link inside a `verified` entry, an acceptance key or a declared protected property, which no agent may change) is left unchanged and listed in `failed` with the guard's reason, and the rest of the move lands. Links inside records (a note the operator's record identifier marks, `record: true` by default, or one under a record folder: a folder in the plugin's record-folder list, or one whose name matches its archive pattern; both indicators are plugin settings, each with its own switch) are never rewritten, and a moved record keeps its own links as written (a marked record stays one wherever it moves; a note that is a record only by its folder is living once moved out); each link left that no longer reaches its target is listed in `records_left` (at most 100 notes; `records_left_total` counts all), which is not damage. `links_ok` is false if any item found damage. A runtime-failed item (missing source, existing destination) is reported in `errors` and does not fail the call, but if every item fails the call is flagged as an error. Statically invalid batches are rejected up front with no moves performed: a non-.md path, an item whose from and to are identical, a destination whose NEW name or folder holds a character Obsidian Sync refuses (\\ : * ? \" < > |) or one that breaks links (# ^ [ ]) (typed `unsafe_name`; the note's own name and the folders it is already in may be kept; [ ] are allowed only in the name of a note under an existing archive folder (one the plugin's archive pattern names) that no other note links to, never in a folder name), or a path appearing twice as a source, twice as a destination, or as both (swaps/chains) — compared after normalization.",
      inputSchema: {
        moves: z
          .array(
            z.object({
              from: z.string().min(1).describe("Existing vault-relative path ending in .md."),
              to: z.string().min(1).describe("New vault-relative path ending in .md."),
            })
          )
          .min(1)
          .max(50)
          .describe("Move/rename operations, e.g. [{from:'Inbox/A.md',to:'Archive/A.md'}]."),
        overwrite: z
          .boolean()
          .default(false)
          .describe("Applies to every item: replace an existing destination (the previous note goes to trash)."),
      },
      annotations: RW,
    },
    async ({ moves, overwrite }) => {
      // A destination that adds a name Obsidian Sync refuses rejects the whole batch, typed, before any move.
      const nameTexts = new TextCache(app);
      for (const { from, to } of moves) {
        try {
          await assertMoveName(app, from, to, overwrite, nameTexts);
        } catch (e) {
          return fail(new UnsafeNameError(`invalid batch, no moves performed — ${(e as Error).message}`));
        }
      }
      const invalid = validateMoves(moves);
      if (invalid) return fail(new Error(`invalid batch, no moves performed — ${invalid}`));
      const moved: Array<{ from: string; to: string; link_check: LinkCheck }> = [];
      const errors: Array<{ from: string; to: string; error: string }> = [];
      // One read of the vault's text for the whole batch (see TextCache).
      const texts = new TextCache(app);
      const isRecord = recordTest(ctx.recordIdentification);
      for (const { from, to } of moves) {
        try {
          const settings = ctx.getSettings?.();
          const link_check = await moveOne(app, from, to, overwrite, { visible: (p) => (settings ? isVisible(p, settings) : true), texts, isRecord });
          moved.push({ from, to, link_check });
        } catch (e) {
          errors.push({ from, to, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const links_ok = moved.every((m) => m.link_check.ok);
      const files = [...new Set(moved.flatMap((m) => [m.to, ...m.link_check.files_rewritten]))];
      const payload = { count: moved.length, error_count: errors.length, links_ok, moved, errors, filesChanged: files.length, files };
      // Partial failure is tolerated, but total failure must carry the standard MCP error flag.
      return moved.length === 0 ? okError(payload) : ok(payload);
    }
  );

  server.registerTool(
    "obsidian_repoint_link",
    {
      title: "Repoint a link",
      description:
        "Rewrite every wikilink whose target text matches `link_name` to point at `target_path` instead, across every note you can see. Case-insensitive on the link text; aliases ([[x|alias]]) and subpaths ([[x#heading]]) are preserved. This is the tool for fixing BROKEN links: Obsidian's rename-based backlink rewrite (obsidian_move_note/obsidian_move_notes) only touches links that already resolve to a file, so a dangling [[x]] that points at no note can only be repointed by this text-level scan. While a path allowlist is configured the scan is CONTAINED BY IT — notes outside it are neither read, rewritten, nor named, so the repair is partial and `scoped_to_allowlist: true` says so. A note whose rewrite the written-content guard refuses (a link inside a `verified` entry, an acceptance key or a declared protected property, which no agent may change) is left unchanged and listed in `skipped` with the guard's reason; the other notes are still repointed. Set dry_run=true to report how many links/notes would change without writing anything.",
      inputSchema: {
        link_name: z
          .string()
          .min(1)
          .describe("The link text inside [[ ]] to repoint, e.g. 'Foo Bar'. Case-insensitive; omit the brackets, any alias, and any #heading."),
        target_path: z
          .string()
          .min(1)
          .describe("Vault-relative path (ending in .md) of the note to point the matching links at."),
        dry_run: z
          .boolean()
          .default(false)
          .describe("If true, report linksChanged/filesChanged without modifying any files."),
        unresolved_only: z
          .boolean()
          .default(false)
          .describe("Only rewrite links that do NOT currently resolve from their source file (checked per-file against metadataCache.unresolvedLinks). Guards against repointing working links that share the name."),
        drop_echo_alias: z
          .boolean()
          .default(false)
          .describe("Drop an alias that merely echoes the old link name ([[foo|foo]] becomes [[NewTarget]]), so display text follows the new target. Genuine aliases are always preserved."),
      },
      annotations: RW,
    },
    async ({ link_name, target_path, dry_run, unresolved_only, drop_echo_alias }) => {
      try {
        if (!target_path.endsWith(".md")) return fail(new Error("target_path must end in .md"));
        const target = app.vault.getAbstractFileByPath(target_path);
        if (!(target instanceof TFile)) return fail(new Error(`target not found: ${target_path}`));

        let filesChanged = 0;
        let linksChanged = 0;
        const files: string[] = [];
        // Notes left unchanged because the written-content guard refused the rewrite (#614).
        const skipped: Array<{ path: string; reason: string }> = [];

        // ── allowlist containment ────────────────────────────────────────────
        // This is the one tool whose blast radius is not in its arguments: it
        // scans, rewrites and then NAMES a set it discovers for itself. Handed
        // the whole vault, it reads notes a sandboxed session cannot read,
        // writes notes it cannot write, and hands back their paths in `files` —
        // an allowlist bypass in all three directions at once, in the very tool
        // the link-health docs prescribe as the repair.
        //
        // So the discovered set goes through `visiblePaths`, the same rule the
        // guard applies to a named path (guard.ts — one copy, shared with uid
        // addressing and the drift report). The consequence is honest and must
        // be reported rather than hidden: under an allowlist the repair is
        // PARTIAL, dangling links to the same name survive outside it, and
        // `scoped_to_allowlist` tells the caller so.
        //
        // No allowlist ⇒ visiblePaths returns the same array ⇒ unchanged.
        const settings = ctx.getSettings?.();
        const all = app.vault.getMarkdownFiles();
        const scoped = Boolean(settings?.allowlist?.length);
        const allowed = scoped ? new Set(visiblePaths(all.map((f) => f.path), settings)) : null;

        for (const file of all) {
          if (allowed && !allowed.has(file.path)) continue;
          // Shortest unambiguous link text for the target, relative to this source file.
          const newTarget = app.metadataCache.fileToLinktext(target, file.path, true);
          // unresolved_only: gate each link on Obsidian's own per-file unresolved map,
          // so links that still resolve from this file are left untouched.
          let allowTarget: ((rawTarget: string) => boolean) | undefined;
          if (unresolved_only) {
            const unres = app.metadataCache.unresolvedLinks[file.path] ?? {};
            const unresSet = new Set(Object.keys(unres).map((k) => k.trim().toLowerCase()));
            allowTarget = (raw) => unresSet.has(raw.trim().toLowerCase());
          }
          const opts = { dropEchoAlias: drop_echo_alias, allowTarget };
          // Peek from cache first so unmatched files are never rewritten (no mtime churn).
          const cached = await app.vault.cachedRead(file);
          const preview = repointLinksInText(cached, link_name, newTarget, opts);
          if (preview.count === 0) continue;

          let count = preview.count;
          // The written-content guard, as for any write of a note (#614): a link in a `verified` entry, an
          // acceptance key or a declared protected property is never rewritten by an agent. A refused note is
          // left unchanged and reported in `skipped` with the guard's reason; the other notes are still repointed.
          try {
            if (dry_run) assertLinkRewriteAllowed(cached, preview.text);
            else {
              // Re-run under the write lock so the reported count reflects what was written.
              await app.vault.process(file, (data) => {
                const r = repointLinksInText(data, link_name, newTarget, opts);
                if (r.count > 0) assertLinkRewriteAllowed(data, r.text);
                count = r.count;
                return r.text;
              });
            }
          } catch (e) {
            if ((e as { code?: unknown }).code !== "accept_forbidden") throw e;
            skipped.push({ path: file.path, reason: `accept_forbidden: ${(e as Error).message}` });
            continue;
          }
          if (count === 0) continue;

          filesChanged++;
          linksChanged += count;
          files.push(file.path);
        }

        return ok({
          link_name,
          target_path,
          dry_run,
          unresolved_only,
          drop_echo_alias,
          linksChanged,
          filesChanged,
          files,
          skipped,
          // Present either way, so a caller never has to infer containment from
          // the absence of a flag: `true` means notes outside the allowlist were
          // skipped and this repair is partial.
          scoped_to_allowlist: scoped,
        });
      } catch (e) { return fail(e); }
    }
  );
  server.registerTool(
    "obsidian_rename_heading",
    {
      title: "Rename a heading",
      description:
        "USE THIS TOOL TO RENAME A HEADING — not obsidian_patch_note, obsidian_write_note or any other text edit. Those change the heading text but leave every link to it ([[Note#Old heading]], ![[Note#Old heading]], [[#Old heading]]) pointing at a heading that no longer exists, and nothing reports the breakage. This tool renames one heading in a note and rewrites every link to it across the notes you can see — wikilinks, embeds and markdown links, same-note [[#Heading]] links and heading chains ([[Note#A#B]]) — the headless equivalent of Obsidian's 'Rename this heading' command, which needs an editor cursor and a dialog. `heading` is the current heading text exactly as written (no leading #); links are matched the way Obsidian matches them, ignoring case and punctuation, so [[Note#Step 1 setup]] reaches '## Step 1: setup'. A heading that is not found is refused, and so is one that another heading in the note shares its links with, a new name that would share links with another heading, and a new name that contains [ ] | # ^ or %%. ATX (## Text) and setext (Text over ===) headings are both handled. Each link is rewritten at the position Obsidian's metadata cache records, after checking the text there still matches; a note that changed since is reported under `skipped`, never rewritten blind. Links inside record notes are not rewritten (records are historical) and are reported under `skipped`, as are frontmatter links, and a note whose rewrite the written-content guard refuses (with the guard's reason). While a path allowlist is configured the scan is CONTAINED BY IT — notes outside it are neither read, rewritten nor named, and `scoped_to_allowlist: true` says so. Set dry_run=true to report what would change without writing.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note that holds the heading, ending in .md."),
        heading: z.string().min(1).describe("The heading's current text, exactly as written, without the leading #s."),
        new_heading: z.string().min(1).describe("The new heading text. Must not contain [ ] | # ^ %% or a line break."),
        dry_run: z.boolean().default(false).describe("If true, report the heading line and the links that would change without modifying any file."),
      },
      annotations: RW,
    },
    async ({ path, heading, new_heading, dry_run }) => {
      try {
        if (!path.endsWith(".md")) return fail(new Error("path must end in .md"));
        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return fail(new Error(`not found: ${path}`));
        const refusal = newHeadingRefusal(heading, new_heading);
        if (refusal) return fail(new Error(refusal));

        const own = app.metadataCache.getFileCache(file);
        const headings = own?.headings ?? [];
        const matches = headings.filter((h) => h.heading === heading);
        // Obsidian resolves a heading link to the FIRST heading whose key
        // matches, so two headings that share a key (`## Notes` and `## notes`,
        // `## Step 1: go` and `## Step 1 go`) cannot be told apart by a link.
        const sameKey = headings.filter((h) => headingKey(h.heading) === headingKey(heading));
        if (matches.length === 0) {
          const known = headings.slice(0, 20).map((h) => `'${h.heading}'`).join(", ");
          return fail(new Error(`heading not found in ${path}: '${heading}'${known ? ` (headings: ${known}${headings.length > 20 ? ", …" : ""})` : " (the note has no headings, or the cache has not read it yet)"}`));
        }
        if (sameKey.length > 1) {
          return fail(new Error(`${sameKey.length} headings in ${path} are reached by the same links (${sameKey.map((h) => `'${h.heading}' line ${h.position.start.line + 1}`).join(", ")}); a link cannot tell them apart, so it is not renamed`));
        }
        const target = matches[0];
        // A heading of punctuation only has an empty key: no link can name it,
        // and an empty key would match the empty segment of a plain [[Note#]].
        if (headingKey(heading) === "") return fail(new Error(`heading '${heading}' has no character a link can match (Obsidian ignores punctuation), so no link points at it; edit it by hand`));
        const clash = headings.find((h) => h !== target && headingKey(h.heading) === headingKey(new_heading));
        if (clash) return fail(new Error(`${path} already has a heading '${clash.heading}' (line ${clash.position.start.line + 1}); renaming to '${new_heading}' would make links to either ambiguous`));

        // The notes to scan, contained by the allowlist exactly as
        // obsidian_repoint_link is (see its comment): the set is discovered
        // here, where no argument-level guard check can reach it.
        const settings = ctx.getSettings?.();
        const all = app.vault.getMarkdownFiles();
        const scoped = Boolean(settings?.allowlist?.length);
        const allowed = scoped ? new Set(visiblePaths(all.map((f) => f.path), settings)) : null;

        const edits = new Map<string, Edit[]>();
        const skipped: Array<{ path: string; reason: string; link?: string }> = [];
        const add = (p: string, e: Edit) => { const list = edits.get(p) ?? []; list.push(e); edits.set(p, list); };

        // The heading line itself.
        const ownText = await app.vault.cachedRead(file);
        const hs = target.position.start.offset, he = target.position.end.offset;
        const newLine = rewriteHeadingLine(ownText.slice(hs, he), heading, new_heading);
        if (newLine === null) return fail(new Error(`the heading at line ${target.position.start.line + 1} of ${path} does not read '${heading}' on one line: either the note changed since the cache read it (retry), or the heading's text spans more than one line (edit it by hand)`));
        add(file.path, { start: hs, end: he, expected: ownText.slice(hs, he), replacement: newLine });

        for (const src of all) {
          if (allowed && !allowed.has(src.path)) continue;
          const cache = app.metadataCache.getFileCache(src);
          if (!cache) continue;
          const found: Edit[] = [];
          for (const l of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
            const hash = l.link.indexOf("#");
            if (hash < 0) continue;
            const linkpath = l.link.slice(0, hash);
            const dest = linkpath === "" ? src : app.metadataCache.getFirstLinkpathDest(linkpath, src.path);
            if (!dest || dest.path !== file.path) continue;
            if (!l.link.slice(hash + 1).split("#").some((seg) => headingKey(seg) === headingKey(heading))) continue;
            const replacement = rewriteLinkOriginal(l.original, heading, new_heading);
            if (replacement === null) { skipped.push({ path: src.path, reason: "link form not recognized; not rewritten", link: l.original }); continue; }
            found.push({ start: l.position.start.offset, end: l.position.end.offset, expected: l.original, replacement });
          }
          for (const fl of cache.frontmatterLinks ?? []) {
            const hash = fl.link.indexOf("#");
            if (hash < 0) continue;
            const linkpath = fl.link.slice(0, hash);
            const dest = linkpath === "" ? src : app.metadataCache.getFirstLinkpathDest(linkpath, src.path);
            if (dest?.path === file.path && fl.link.slice(hash + 1).split("#").some((seg) => headingKey(seg) === headingKey(heading))) {
              skipped.push({ path: src.path, reason: `frontmatter link in '${fl.key}' is not rewritten; update it by hand`, link: fl.original });
            }
          }
          if (found.length === 0) continue;
          if (src.path !== file.path && ctx.isRecord?.(src.path)) {
            skipped.push({ path: src.path, reason: `record note: ${found.length} link(s) to the heading left as they are (records are historical)` });
            continue;
          }
          for (const e of found) add(src.path, e);
        }

        const files: string[] = [];
        let linksChanged = 0;
        // The note that holds the heading goes first: if it has changed since
        // the cache read it, nothing anywhere is written.
        const order = [file.path, ...[...edits.keys()].filter((p) => p !== file.path).sort()];
        for (const p of order) {
          const list = edits.get(p)!;
          const links = list.length - (p === file.path ? 1 : 0);
          if (dry_run) {
            // The written-content guard decides a dry run too, so it reports what a real run would refuse (#614).
            const f = app.vault.getAbstractFileByPath(p);
            if (f instanceof TFile) {
              const data = await app.vault.cachedRead(f);
              const next = applyEdits(data, list);
              try {
                if (next !== null && next !== data) assertLinkRewriteAllowed(data, next);
              } catch (e) {
                if ((e as { code?: unknown }).code !== "accept_forbidden") throw e;
                if (p === file.path) throw e;
                skipped.push({ path: p, reason: `accept_forbidden: ${(e as Error).message}; ${links} link(s) not rewritten` });
                continue;
              }
            }
          } else {
            const f = app.vault.getAbstractFileByPath(p);
            let stale = !(f instanceof TFile);
            if (!stale) {
              try {
                await app.vault.process(f as TFile, (data) => {
                  const next = applyEdits(data, list);
                  if (next === null) { stale = true; return data; }
                  // The written-content guard, as for any write of a note (#614). A refusal throws before
                  // anything is written: the note is left unchanged and reported in `skipped`.
                  if (next !== data) assertLinkRewriteAllowed(data, next);
                  return next;
                });
              } catch (e) {
                // The heading's own note is written first, so a failure there
                // has changed nothing. After it, earlier files ARE written:
                // report this one and go on, so the result names every file
                // that changed and every link left behind.
                if (p === file.path) throw e;
                const refused = (e as { code?: unknown }).code === "accept_forbidden";
                const msg = e instanceof Error ? e.message : String(e);
                skipped.push({ path: p, reason: refused ? `accept_forbidden: ${msg}; ${links} link(s) not rewritten` : `write failed (${msg}); ${links} link(s) not rewritten — retry to heal them` });
                continue;
              }
            }
            if (stale) {
              if (p === file.path) return fail(new Error(`${path} changed since the cache read it; nothing was renamed or rewritten — retry`));
              skipped.push({ path: p, reason: `changed since the cache read it; ${links} link(s) not rewritten — retry to heal them` });
              continue;
            }
          }
          files.push(p);
          linksChanged += links;
        }

        return ok({
          path,
          heading,
          new_heading,
          dry_run,
          heading_line: target.position.start.line + 1,
          linksChanged,
          filesChanged: files.length,
          files,
          skipped,
          scoped_to_allowlist: scoped,
        });
      } catch (e) { return fail(e); }
    }
  );
}
