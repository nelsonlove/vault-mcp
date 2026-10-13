// obsidian_create_note — create a note of a class through the vault's own
// flow.createFromFileclass (#531).
//
// Nelson's "a" (2026-10-12) to "A: a guard plus a create tool": agents had
// written 17 invented `type` values on 56 notebook entries. A hook in dotfiles
// refuses an invented type; this tool is the road that makes a real one easy.
// It renders the class's own `## Template` through the vault's construction
// module (`flow.js`, generated from 00.13 Scripts), so the note gets exactly
// the frontmatter and sections the class declares, and a required blank with
// no value throws by name instead of landing empty.
//
// It CALLS THE FUNCTION. It never runs an Obsidian command, a QuickAdd choice
// or Templater: the module is required headlessly, with `_invoked-by: agent`,
// so nothing prompts. Where the module would have asked QuickAdd to format the
// note, the only token it relies on that QuickAdd resolves — `{{DATE[:fmt]}}`
// — is filled here with Obsidian's own moment; any other `{{…}}` left in the
// note is refused, and the new file is removed.
//
// Placement: the class's declared folder (`newNotes`, `fileClassNotesFolder`,
// or a single `filesPaths`), or the caller's `folder`. Never the folder of the
// note Nelson has open: the module falls back to that for a human, which is
// wrong for an agent, so a class that declares no folder needs `folder`.
//
// The module path is a SETTING (`createNoteFlow`, vault-relative), empty when
// the plugin ships: no vault folder name is written into live code (Nelson,
// 2026-10-03). With it empty the tool is not registered.

import { z } from "zod";
import * as nodePath from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { moment, normalizePath, TFile, type App } from "obsidian";
import { acceptForbiddenReason, isVerifiedKey, strictInput } from "@vault-mcp/core";
import { ok, codedError } from "./helpers.js";
import { assertCreateName } from "./name-checks.js";
import { isVisible, type GuardSettings } from "../guard.js";

export const CREATE_NOTE_TOOL = "obsidian_create_note";

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** What the tool needs from the vault's construction modules. */
export interface FlowModules {
  /** flow.createFromFileclass(app, params, name, cls, opts) → TFile */
  createFromFileclass: (app: App, params: unknown, name: string, cls: string, opts?: Record<string, unknown>) => Promise<unknown>;
  /** flow.applyFileclass(app, params, notePath, opts) */
  applyFileclass: (app: App, params: unknown, notePath: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
  /** fileclass-render.resolvePlacement(app, cls, params, opts) → folder ("" = root) */
  resolvePlacement: (app: App, cls: string, params: unknown, opts?: Record<string, unknown>) => Promise<string>;
  /** fileclass-render.definitions(app).find(name) → the class file, or undefined */
  classFile: (app: App, cls: string) => TFile | undefined;
}

export interface CreateNoteCtx {
  getSettings: () => GuardSettings;
  /** The vault-relative path of flow.js (the `createNoteFlow` setting). */
  flowPath: () => string;
  /** Load the modules. Injected so tests run without a vault; production = loadFlowModules. */
  load?: (app: App, flowRel: string) => FlowModules;
}

/** Require flow.js (and through it fileclass-render.js) from the vault. Node's require caches it; a changed module needs an Obsidian restart. */
export function loadFlowModules(app: App, flowRel: string): FlowModules {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (app.vault.adapter as any).basePath as string;
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
  const flow = (window as any).require(nodePath.join(base, flowRel));
  if (typeof flow?.createFromFileclass !== "function" || typeof flow?.req !== "function") {
    throw new Error(`${flowRel} does not export createFromFileclass and req: is the createNoteFlow setting right?`);
  }
  const render = flow.req(app, "fileclass-render.js");
  return {
    createFromFileclass: flow.createFromFileclass,
    applyFileclass: flow.applyFileclass,
    resolvePlacement: render.resolvePlacement,
    classFile: (a: App, cls: string) => render.definitions(a).find(render.className(cls)),
  };
}

/** Whether the class declares where its notes go (the module's own order, minus the active-note fallback). */
export function declaresPlacement(app: App, file: TFile | undefined): boolean {
  if (!file) return false;
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const dests = ([] as unknown[]).concat(fm.newNotes ?? []).filter((d) => d && typeof d === "object" && (d as { folder?: unknown }).folder);
  const bound = ([] as unknown[]).concat(fm.filesPaths ?? []).filter(Boolean);
  return dests.length > 0 || (typeof fm.fileClassNotesFolder === "string" && fm.fileClassNotesFolder.trim() !== "") || bound.length === 1;
}

const DATE_TOKEN = /\{\{\s*DATE(?::([^}]*))?\s*\}\}/g;
const ANY_TOKEN = /\{\{[^}]*\}\}/;

/** The QuickAdd `{{DATE[:fmt]}}` token, filled the way QuickAdd fills it (moment; bare = YYYY-MM-DD). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fillDates(text: string, now: () => { format(f: string): string } = () => (moment as any)()): string {
  return text.replace(DATE_TOKEN, (_w, fmt?: string) => now().format((fmt ?? "").trim() || "YYYY-MM-DD"));
}

/** The note's path for a title in a folder ("" = vault root). */
export function notePath(folder: string, title: string): string {
  const f = folder.replace(/^\/+|\/+$/g, "");
  return normalizePath(f ? `${f}/${title}.md` : `${title}.md`);
}

type ValueMap = Record<string, string | number | boolean>;

export function registerCreateNoteTool(server: McpServer, app: App, ctx: CreateNoteCtx): void {
  const load = ctx.load ?? loadFlowModules;
  server.registerTool(
    CREATE_NOTE_TOOL,
    {
      title: "Create a note of a class",
      description:
        "Create a new note of a fileclass (e.g. `Event/AgentNotebookEntry`, `Task/AgentTask`) from that class's own `## Template`, " +
        "through the vault's construction module — the way to make a note with a real `type`, never a hand-typed one. " +
        "`values` fills the template's `{{VALUE:name}}` blanks; a required blank with no value is refused by name, nothing written. " +
        "The note lands in the folder the class declares, or in `folder` when you pass it; a class that declares none needs `folder`. " +
        "`destination` picks one of several destinations a class declares. The title is `title`, else `values.title`. " +
        "`frontmatter` adds keys the template does not write (e.g. `session`, `session-id`, `reports-to`); it may not set a key the rendered note already has, nor the class key (`type`). " +
        "Refused: a note that already exists at the path, a name Obsidian Sync refuses or that breaks links, a value that sets " +
        "acceptance or a `verified` record, a path outside your allowlist. Returns the new note's path and rev. " +
        "To change an existing note, use obsidian_patch_note or obsidian_manage_frontmatter.",
      inputSchema: strictInput({
        class: z.string().min(1).describe("The fileclass, e.g. 'Event/AgentNotebookEntry' (as in 00.10 Fileclasses)."),
        title: z.string().min(1).optional().describe("The new note's name, without .md. Default: values.title."),
        values: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Values for the class template's {{VALUE:name}} blanks, e.g. {session: '[worker-OB-pro] x', description: '…'}."),
        folder: z.string().min(1).optional().describe("Vault-relative folder to create the note in, instead of the class's declared folder."),
        destination: z.string().min(1).optional().describe("One of the destinations the class declares, when it declares several."),
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe("Extra frontmatter keys the class template does not write, added after rendering, e.g. {session: '…', 'session-id': '…'}."),
      }),
      annotations: RW,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (raw: any) => {
      const args = raw as { class: string; title?: string; values?: ValueMap; folder?: string; destination?: string; frontmatter?: Record<string, unknown> };
      const extra: Record<string, unknown> = { ...(args.frontmatter ?? {}) };
      const values: ValueMap = { ...(args.values ?? {}) };
      const title = String(args.title ?? values.title ?? "").trim();
      if (!title) return codedError("invalid_argument", "A note needs a name: pass `title` (or `values.title`). Nothing was written.");

      // Acceptance is a human gesture, in no API: a value may not set it.
      const accept = acceptForbiddenReason(values as Record<string, unknown>) ?? acceptForbiddenReason(extra);
      if (accept) return codedError("accept_forbidden", `${accept}. Nothing was written.`);
      const verified = [...Object.keys(values), ...Object.keys(extra)].find((k) => isVerifiedKey(k));
      if (verified) return codedError("accept_forbidden", `A value sets '${verified}', which only Nelson writes. Nothing was written.`);

      const flowRel = ctx.flowPath().trim();
      let mods: FlowModules;
      try {
        mods = load(app, flowRel);
      } catch (e) {
        return codedError("unavailable", `The vault's construction module could not be loaded (${(e as Error).message}). Nothing was written.`);
      }

      // The class key is the class's to write, never the caller's: that is the whole point of the tool.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const alias = ((app as any).plugins?.plugins?.fileclass?.settings?.fileClassAlias as string | undefined) || "type";
      const bindingKey = [alias, "type", "fileClass", "fileclass"].find((k) => k in extra);
      if (bindingKey) {
        return codedError("invalid_argument", `\`frontmatter\` may not set '${bindingKey}': the class sets it. Pass the class as \`class\`. Nothing was written.`);
      }

      const classFile = mods.classFile(app, args.class);
      if (!classFile) return codedError("invalid_argument", `No fileclass '${args.class}'. Nothing was written.`);

      // Agent mode: nothing prompts; a missing required blank throws by name.
      const variables: Record<string, unknown> = { ...values, "_invoked-by": "agent", ...(args.destination ? { destination: args.destination } : {}) };
      const params = { variables, quickAddApi: { format: async (s: string) => fillDates(s) } };

      let folder: string;
      if (args.folder !== undefined) {
        folder = args.folder.replace(/^\/+|\/+$/g, "");
      } else {
        if (!declaresPlacement(app, classFile)) {
          return codedError(
            "invalid_argument",
            `Class '${args.class}' declares no folder for its notes, so pass \`folder\`. Nothing was written.`
          );
        }
        try {
          folder = await mods.resolvePlacement(app, args.class, params, args.destination ? { destination: args.destination } : {});
        } catch (e) {
          return codedError("invalid_argument", `${(e as Error).message} Nothing was written.`);
        }
      }

      const path = notePath(folder, title);
      // The guard checks the paths a call NAMES; this one is computed, so the handler applies the same rule.
      if (!isVisible(path, ctx.getSettings())) {
        return codedError("out_of_allowlist", `'${path}' is outside this session's path allowlist. Nothing was written.`);
      }
      if (app.vault.getAbstractFileByPath(path)) {
        return codedError("already_exists", `'${path}' already exists. Nothing was written. To change it, edit it in place.`);
      }
      try {
        assertCreateName(app, path);
      } catch (e) {
        return codedError("unsafe_name", `${(e as Error).message} Nothing was written.`);
      }

      let created: TFile | null = null;
      try {
        if (args.folder === undefined) {
          const f = await mods.createFromFileclass(app, params, title, args.class, args.destination ? { destination: args.destination } : {});
          created = f instanceof TFile ? f : (app.vault.getAbstractFileByPath(path) as TFile | null);
        } else {
          if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
          created = await app.vault.create(path, "");
          await mods.applyFileclass(app, params, created, { cls: args.class, title });
        }
        if (!created) throw new Error(`the module created no note at '${path}'`);
        const text = await app.vault.read(created);
        const left = ANY_TOKEN.exec(text);
        if (left) throw new Error(`the class template left a token this tool cannot fill: ${left[0]}`);
        if (Object.keys(extra).length > 0) {
          const target = created;
          let clash: string | undefined;
          await app.fileManager.processFrontMatter(target, (fm: Record<string, unknown>) => {
            clash = Object.keys(extra).find((k) => k in fm);
            if (clash) return;
            for (const [k, v] of Object.entries(extra)) fm[k] = v;
          });
          if (clash) throw new Error(`\`frontmatter\` sets '${clash}', which the class template already writes: pass it in \`values\` if the template has a blank for it`);
        }
      } catch (e) {
        // The note is this call's own new file: remove it so a failed create leaves nothing behind.
        const stub = created ?? app.vault.getAbstractFileByPath(path);
        if (stub instanceof TFile) {
          try {
            await app.vault.trash(stub, true);
          } catch {
            /* reported below */
          }
        }
        return codedError("create_failed", `${(e as Error).message}. Nothing was kept.`);
      }

      return ok({ path: created.path, class: args.class, created: true, rev: created.stat.mtime, filesChanged: 1, files: [created.path] });
    }
  );
}
