import { z } from "zod";
import { assertCreateName } from "./name-checks.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile, TFolder, getAllTags } from "obsidian";
import {
  AcceptForbiddenError,
  acceptTransitionReason,
  acceptTransitionNeedsBefore,
  executeQuickAddChoice,
  parseGuardFrontmatter,
  sectionIn,
  lineEndingOf,
  stripLeadingFrontmatter,
  unverifiableProtectedPropertyIn, unverifiableBeforeReason,
} from "@vault-mcp/core";
import { ok, fail, codedError } from "./helpers.js";
import { noteStructure, writeIfUnchanged, type MetadataSource, type WriteTarget } from "./note-structure.js";
import { visiblePaths } from "../guard.js";
import type { ServerCtx } from "./tools-core.js";
import { inRecordFolder } from "./records.js";
import { normalizeRecordFolders } from "../kernel/record-guard.js";
import { quickAddChoicesFrom, runCommandRefusal, runCommandSnapshotRefusal, vaultTextReader } from "./cli-policy.js";

// ── accept-forbidden guard for obsidian_append_at_heading (#109) ──────────────
//
// This tool writes via raw app.vault.modify/append/create — OUTSIDE the shared
// write primitive (ObsidianBackend.writeNote / VaultImpl.guardWrittenContent),
// so the accept-forbidden check the primitive enforces never ran here. It is
// safe today only by accident (it writes body content under a heading, never
// leading frontmatter), but a future change could let it introduce acceptance.
// So route the RESULTING full-note content through the SAME transition
// predicate the primitive uses — no second definition of "accepted".
//
// Mirrors ObsidianBackend.guardWrittenContent exactly: parse the resulting
// frontmatter first (a construct the guard cannot classify throws
// AcceptForbiddenError → the write refuses), and only when the result asserts
// acceptance at all read the BEFORE frontmatter so a legitimate edit carrying
// an existing human-granted accepted value forward UNCHANGED is allowed.
export function guardAppendResult(beforeText: string | null, resultingContent: string): void {
  const after = parseGuardFrontmatter(resultingContent);
  // Result-only shortcut delegated to the shared helper (#224): an absent
  // declared protected property can be a removal, decidable only against the
  // before-frontmatter, so the shortcut is safe only with none declared.
  if (!acceptTransitionNeedsBefore(after)) return;
  let before: Record<string, unknown> | null = null;
  if (beforeText !== null) {
    // A before that itself cannot be parsed is treated as no prior acceptance
    // (fail closed on the transition), matching the backend's diskFrontmatter —
    // except when the unreadable block textually mentions a declared protected
    // property, which refuses (#224: null-before would let a removal through).
    try {
      before = parseGuardFrontmatter(beforeText);
    } catch {
      const k = unverifiableProtectedPropertyIn(beforeText);
      if (k) {
        throw new AcceptForbiddenError(unverifiableBeforeReason(k));
      }
      before = null;
    }
  }
  const reason = acceptTransitionReason(before, after);
  if (reason) throw new AcceptForbiddenError(reason);
}

const RO = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// trash is destructive but recoverable (system trash — can be restored)
const DESTRUCTIVE_RECOVERABLE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export function registerComplementaryTools(server: McpServer, app: App, ctx: ServerCtx) {

  // ── obsidian_trash ──────────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_trash",
    {
      title: "Trash a note",
      description: "Move a note to the system trash (recoverable). Returns {path, trashed:true}.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note to trash."),
      },
      annotations: DESTRUCTIVE_RECOVERABLE,
    },
    async ({ path: p }) => {
      try {
        const file = app.vault.getAbstractFileByPath(p);
        if (!(file instanceof TFile)) return fail(new Error(`not found: ${p}`));
        await app.vault.trash(file, true); // true = system trash
        return ok({ path: p, trashed: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_trash_folder (#634) ────────────────────────────────────────────
  // A folder has no rev, so obsidian_trash (which needs if_rev) cannot take one. This tool trashes a folder
  // only when it holds no file: the check runs here, in the handler, which the kernel runs at dequeue, one write
  // at a time, so a file that arrives before the trash is seen and the trash is refused. Recoverable, like a file.
  server.registerTool(
    "obsidian_trash_folder",
    {
      title: "Trash an empty folder",
      description:
        "Move an EMPTY folder to the system trash (recoverable). Refused, and nothing is written, when the folder holds any file " +
        "(at any depth; only macOS's own .DS_Store files are not counted), or holds a subfolder and include_empty_subfolders is not true. " +
        "Refused for the vault root, a path with a segment that starts with a dot, a path that is not a folder, and a folder the record " +
        "settings treat as a record folder or archive (or one inside such a folder). Needs idempotency_key; takes no if_rev, because a folder has no rev " +
        "(the emptiness check inside the operation stands in for it). Returns {path, trashed: true, subfolders}.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the folder to trash."),
        include_empty_subfolders: z
          .boolean()
          .default(false)
          .describe("Also trash empty subfolders with it (a chain of folders that hold no file). Default false: any subfolder refuses the call."),
      },
      annotations: DESTRUCTIVE_RECOVERABLE,
    },
    async ({ path: raw, include_empty_subfolders }) => {
      try {
        const p = raw.trim().replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
        if (!p) return codedError("invalid_argument", "The vault root cannot be trashed. Nothing was written.");
        if (p.split("/").some((seg) => seg.startsWith(".") || seg === "")) {
          return codedError("invalid_argument", `'${raw}' has a segment that starts with a dot (a hidden or config folder). Nothing was written.`);
        }
        const folder = app.vault.getAbstractFileByPath(p);
        if (!folder) return codedError("not_found", `No folder at '${p}'. Nothing was written.`);
        if (!(folder instanceof TFolder)) {
          return codedError("not_a_folder", `'${p}' is a file, not a folder: use obsidian_trash for a file. Nothing was written.`);
        }
        // The record folders and the archive pattern (#482): a folder that is one, or sits inside one, is kept,
        // as the moves keep a record. The child name is one no folder can have, so only the folder's own path is judged.
        const records = normalizeRecordFolders(ctx.recordFolders?.());
        if (inRecordFolder(`${p}/\u0000`, records)) {
          return codedError("record_immutable", `'${p}' is a record folder or archive, or sits inside one; it is not trashed. Nothing was written.`);
        }
        const notEmpty = () =>
          codedError("folder_not_empty", `'${p}' holds at least one file; only an empty folder is trashed. Move or trash the files first. Nothing was written.`);
        // What Obsidian indexes, read synchronously: the subfolders, and whether any file is there (it stops at the first).
        const indexed = (): { file: boolean; subfolders: string[] } => {
          const subfolders: string[] = [];
          const stack: TFolder[] = [folder];
          while (stack.length) {
            for (const c of (stack.pop() as TFolder).children ?? []) {
              if (c instanceof TFolder) {
                subfolders.push(c.path);
                stack.push(c);
              } else return { file: true, subfolders };
            }
          }
          return { file: false, subfolders };
        };
        const first = indexed();
        if (first.file) return notEmpty();
        if (first.subfolders.length > 0 && include_empty_subfolders !== true) {
          return codedError(
            "folder_not_empty",
            `'${p}' holds subfolders (with no file in them). Pass include_empty_subfolders: true to trash them with it. Nothing was written.`
          );
        }
        // A record folder or archive below it is kept too: trashing the parent would take it along.
        if (first.subfolders.some((s) => inRecordFolder(`${s}/\u0000`, records))) {
          return codedError("record_immutable", `'${p}' holds a record folder or archive; it is not trashed. Nothing was written.`);
        }
        // What is on disk: the index leaves out dot-files and some types, so a folder that looks empty to Obsidian
        // can still hold one. Any file there refuses the trash too, except macOS's .DS_Store.
        if (await diskHasFile(app, p)) return notEmpty();
        // The disk listing awaited: look at the index once more, synchronously, right before the trash, so a file
        // Obsidian indexed meanwhile (Sync, another plugin, the user) is not trashed with the folder. Writes through
        // vault-mcp cannot arrive at all: this handler runs in the write queue.
        const last = indexed();
        if (last.file) return notEmpty();
        const subfolders = last.subfolders;
        if (subfolders.length > 0 && include_empty_subfolders !== true) return notEmpty();
        await app.vault.trash(folder, true); // true = system trash
        return ok({ path: p, trashed: true, subfolders: subfolders.length });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_read_note_parsed ───────────────────────────────────────────────
  server.registerTool(
    "obsidian_read_note_parsed",
    {
      title: "Read note (parsed)",
      description:
        "Return structured metadata from Obsidian's live cache: frontmatter, headings, links, tags, plus the body (content minus the frontmatter block). Read-only.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path, e.g. 'Projects/Roadmap.md'."),
      },
      annotations: RO,
    },
    async ({ path: p }) => {
      try {
        const file = app.vault.getAbstractFileByPath(p);
        if (!(file instanceof TFile)) return fail(new Error(`not found: ${p}`));

        const cache = app.metadataCache.getFileCache(file);
        const content = await app.vault.read(file);

        // Strip a leading YAML frontmatter block via the shared recognizer
        // (#189) rather than the cache's frontmatterPosition offsets (whose
        // inclusive/exclusive semantics differ across Obsidian versions) or a
        // local regex (whose old copy was BOM-blind, so a BOM-authored note's
        // "body" still carried the whole frontmatter fence even though the
        // cache had parsed it). The cache gate stays: no cache-recognized
        // frontmatter ⇒ content passes through byte-identically.
        const body = cache?.frontmatter ? stripLeadingFrontmatter(content) : content;

        return ok({
          path: p,
          frontmatter: cache?.frontmatter ?? null,
          headings: (cache?.headings ?? []).map((h) => ({
            heading: h.heading,
            level: h.level,
            line: h.position.start.line,
          })),
          links: (cache?.links ?? []).map((l) => ({
            link: l.link,
            displayText: l.displayText,
            line: l.position.start.line,
          })),
          tags: cache?.tags ?? [],
          body,
        });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_append_at_heading ──────────────────────────────────────────────
  server.registerTool(
    "obsidian_append_at_heading",
    {
      title: "Append content at a heading",
      description:
        "Insert content at the end of the section under a heading. If create_if_missing=true and the heading is absent, appends the heading + content to the file (creating the file if needed).",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path ending in .md."),
        heading: z.string().min(1).describe("Exact heading text (no leading #)."),
        content: z.string().min(1).describe("Markdown to insert after the heading section's body."),
        create_if_missing: z.boolean().default(false),
      },
      annotations: RW,
    },
    async ({ path: p, heading, content, create_if_missing }) => {
      try {
        if (!p.endsWith(".md")) return fail(new Error("path must end in .md"));
        // A cut read handed back as `content` is refused before this handler
        // runs, by the guard's cutReadError (#441); the tool has no direct
        // caller, so no second check here.
        const file = app.vault.getAbstractFileByPath(p);

        if (!(file instanceof TFile)) {
          if (!create_if_missing) {
            return ok({ path: p, found: false, inserted: false });
          }
          // Create note with the heading + content
          const newContent = `# ${heading}\n\n${content}\n`;
          guardAppendResult(null, newContent);
          assertCreateName(app, p);
          await app.vault.create(p, newContent);
          return ok({ path: p, found: false, inserted: true, created_note: true });
        }

        // The section is placed on Obsidian's own reading of the text just
        // read (#593, note-structure.ts): never on a stale cache, and never on
        // a guess. When no reading can be checked the call fails with
        // cache_mismatch, so a heading Obsidian has is never added twice.
        const text = await app.vault.read(file);
        const { headings } = await noteStructure(app.metadataCache as unknown as MetadataSource, file, text);
        const section = sectionIn(headings, text.length, heading);
        const nl = lineEndingOf(text);
        const ins = nl === "\n" ? content : content.replace(/\r?\n/g, nl);

        if (!section) {
          if (!create_if_missing) {
            return ok({ path: p, found: false, inserted: false });
          }
          // Append heading + content to file
          const appended = `${nl}## ${heading}${nl}${nl}${ins}${nl}`;
          guardAppendResult(text, text + appended);
          // Only if the note still holds the text the heading was looked for in.
          await writeIfUnchanged(app.vault as unknown as WriteTarget, file, text, text + appended);
          return ok({ path: p, found: false, inserted: true, created_heading: true });
        }

        const sectionEnd = section.end;

        // Append at the end of the section body, preserving trailing newline before next heading
        const head = text.slice(0, sectionEnd).replace(/(?:\r?\n)*$/, nl);
        const tail = text.slice(sectionEnd);
        const sep = tail.length === 0 || tail.startsWith("\n") || tail.startsWith("\r\n") ? nl : nl + nl;
        const next = head + ins + sep + tail;

        guardAppendResult(text, next);
        // Written only if the note still holds the text it was placed on.
        await writeIfUnchanged(app.vault as unknown as WriteTarget, file, text, next);
        return ok({ path: p, found: true, inserted: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_open_in_editor ─────────────────────────────────────────────────
  server.registerTool(
    "obsidian_open_in_editor",
    {
      title: "Open note in editor",
      description: "Open a note in Obsidian's editor, optionally in a new leaf/tab.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note to open."),
        new_leaf: z.boolean().default(false).describe("Open in a new tab/leaf."),
      },
      annotations: RW,
    },
    async ({ path: p, new_leaf }) => {
      try {
        // openLinkText resolves the path through Obsidian's link resolver.
        await app.workspace.openLinkText(p, "", new_leaf);
        return ok({ path: p, opened: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_run_command ────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_run_command",
    {
      title: "Run Obsidian command",
      description:
        "Execute an Obsidian command by its ID (see obsidian_get_command_ids). Optionally open file_path first so file-scoped commands have a target. " +
        "Opaque-execution command ids (quickadd:*, js-engine:*) run macros/vault JS the acceptance guard cannot inspect and are DENIED by default (Error [cli_denied]); a human can re-enable a specific id in the Vault MCP settings. " +
        "Pass `variables` to invoke a QuickAdd choice through its own executeChoice API instead of the plain command call — this is how the vault's dual-mode scripts (variables-first, `_invoked-by: \"agent\"` fails fast instead of opening a modal nobody will answer) are meant to be driven headlessly. `_invoked-by` defaults to \"agent\" when `variables` is given, so a missing required input fails fast rather than hanging on a prompt. KNOWN LIMITATION: QuickAdd's own executeChoice API does not return the invoked script's return value — only success/failure (a thrown error surfaces as a normal tool failure). To see a script's result, re-read whatever it changed after this call returns.",
      inputSchema: {
        command_id: z.string().min(1).describe("Obsidian command ID, e.g. 'editor:toggle-bold'. A QuickAdd choice's id is 'quickadd:choice:<uuid>' (see obsidian_get_command_ids)."),
        file_path: z.string().optional().describe("Open this vault-relative path before running the command."),
        variables: z
          .record(z.string())
          .optional()
          .describe(
            "QuickAdd choice variables (only meaningful for a QuickAdd command id — ignored otherwise). " +
            "Routes through quickAddApi.executeChoice(name, variables) rather than the plain command call. " +
            "'_invoked-by' defaults to \"agent\" here unless you set it yourself."
          ),
      },
      annotations: RW,
    },
    async ({ command_id, file_path, variables }) => {
      try {
        // Command policy (cli-policy.ts): QuickAdd ids run arbitrary macros
        // the acceptance guard cannot inspect — denied by default, re-enabled
        // per-command only through the human-only settings. Same policy object
        // as obsidian_cli; refused BEFORE anything runs (including the
        // file_path open, which would leak an action for a refused command).
        // Applies identically whether or not `variables` is given — passing
        // variables changes HOW an allowed command runs, never WHETHER it may.
        // Two halves (01.41, pick A): the sync gate, then the script snapshot of an id a wildcard opened.
        const policy = ctx.getSettings().cliPolicy;
        const choices = quickAddChoicesFrom((app as any).plugins?.plugins?.quickadd?.settings);
        const policyReason =
          runCommandRefusal(command_id, policy, choices) ??
          (await runCommandSnapshotRefusal(command_id, policy, choices, vaultTextReader(app)));
        if (policyReason) {
          return codedError("cli_denied", policyReason);
        }
        if (file_path) {
          await app.workspace.openLinkText(file_path, "", false);
        }

        // Only a QuickAdd-namespaced id is routed through executeChoice — per
        // the tool's own description, `variables` is "ignored otherwise", so
        // a non-QuickAdd id carrying `variables` falls through to the plain
        // command path below rather than misrouting into a choice lookup
        // that was never going to resolve. The resolution + invocation seam
        // is SHARED with the vaultmcp-triage satellite's declared choice
        // dispositions — one executeChoice path, two policy gates (the
        // cli-policy deny above for agent-named ids here; human-only config
        // binding there). The seam moved to `@vault-mcp/core` at the triage
        // extraction (S5): the two callers are now in different plugins, and
        // the file exists precisely so they cannot drift.
        const isQuickAddId = command_id.startsWith("quickadd:");
        if (variables && isQuickAddId) {
          let run;
          try {
            run = await executeQuickAddChoice(app, { commandId: command_id }, variables);
          } catch (e) { return fail(e); }
          if (!run.ok) return codedError(run.code, run.message);
          return ok({ command_id, choice: run.choice, executed: true, variables: run.variables });
        }

        // app.commands is not in the public obsidian types — cast required.
        const executed = (app as any).commands.executeCommandById(command_id) as boolean | undefined;
        return ok({ command_id, executed: executed !== false });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_get_command_ids ────────────────────────────────────────────────
  server.registerTool(
    "obsidian_get_command_ids",
    {
      title: "Get command IDs",
      description: "List all registered Obsidian command IDs and names. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        // app.commands.commands is not in the public obsidian types — cast required.
        const commands = (app as any).commands.commands as Record<string, { name: string }>;
        const list = Object.entries(commands).map(([id, c]) => ({ id, name: c.name }));
        return ok({ count: list.length, commands: list });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_vault_info ─────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_vault_info",
    {
      title: "Vault info",
      description: "Return vault metadata: name, base path, config dir, and attachment folder path. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        // app.vault.getConfig is not in the public obsidian types — cast required.
        const attachmentFolderPath = (app.vault as any).getConfig("attachmentFolderPath") as string | null;
        return ok({
          vault_name: app.vault.getName(),
          base_path: (app.vault.adapter as any).getBasePath?.() ?? null,
          config_dir: app.vault.configDir,
          attachment_folder_path: attachmentFolderPath ?? null,
        });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_tags_list ──────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_tags_list",
    {
      title: "List all tags",
      description:
        "Return all tags in the vault with their usage counts, from the live metadata cache. Read-only. " +
        "While a path allowlist is active, only tags used by notes you can see are listed, and the counts are counts over those notes.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const settings = ctx.getSettings();
        if (!settings.allowlist.length) {
          // No boundary ⇒ the host's own aggregate, byte-identical to before.
          // getTags() is not in the public obsidian types — cast required.
          // Returns Record<string, number> where keys have a leading '#'.
          const raw = (app.metadataCache as any).getTags() as Record<string, number>;
          const tags = Object.entries(raw)
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);
          return ok({ count: tags.length, tags });
        }
        // Obsidian's getTags() aggregates the WHOLE vault, so a sandboxed
        // session would learn both the vocabulary of the area it is excluded
        // from and how much is in it — a tag name is often the most telling
        // thing about a note. Recompute over visible notes only; the aggregate
        // is not decomposable, so the only honest answer is to rebuild it.
        const files = app.vault.getMarkdownFiles();
        const shown = new Set(visiblePaths(files.map((f) => f.path), settings));
        const counts = new Map<string, number>();
        for (const f of files) {
          if (!shown.has(f.path)) continue;
          const cache = app.metadataCache.getFileCache(f);
          if (!cache) continue;
          for (const t of getAllTags(cache) ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const tags = [...counts.entries()]
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        return ok({ count: tags.length, tags });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_environment_info ───────────────────────────────────────────────
  server.registerTool(
    "obsidian_environment_info",
    {
      title: "Environment info",
      description: "Return Obsidian version, plugin version, platform, and list of enabled community plugins. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        // app.appVersion is not in the public obsidian types — cast required.
        return ok({
          obsidian_version: (app as any).appVersion as string,
          plugin_version: ctx.pluginVersion,
          platform: process.platform,
          enabled_plugins: ctx.enabledPlugins(),
        });
      } catch (e) { return fail(e); }
    }
  );
}

/** Whether a vault folder holds a file on disk, at any depth, not counting macOS's .DS_Store. Stops at the first.
 *  Throws when the adapter cannot list: a trash never trusts an unknown. */
async function diskHasFile(app: App, folder: string): Promise<boolean> {
  const adapter = app.vault.adapter as unknown as { list?: (p: string) => Promise<{ files: string[]; folders: string[] }> };
  if (typeof adapter.list !== "function") throw new Error("the vault adapter cannot list a folder on disk, so the folder's emptiness cannot be proven; nothing was trashed");
  const queue = [folder];
  while (queue.length) {
    const { files, folders } = await adapter.list(queue.shift() as string);
    if (files.some((f) => (f.split("/").pop() ?? f) !== ".DS_Store")) return true;
    queue.push(...folders);
  }
  return false;
}
