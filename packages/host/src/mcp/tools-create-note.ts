// obsidian_create_note — create a note of a class through the vault's own
// construction module (#531).
//
// Nelson's "a" (2026-10-12) to "A: a guard plus a create tool": agents had
// written 17 invented `type` values on 56 notebook entries. A hook in dotfiles
// refuses an invented type; this tool is the road that makes a real one easy.
// It renders the class's own `## Template` through the vault's `flow.js`
// (generated from 00.13 Scripts), so the note gets exactly the frontmatter and
// sections the class declares, and a required blank with no value is refused
// by name.
//
// RENDER, CHECK, THEN WRITE ONCE (#532 review). The module renders into a
// stand-in for the new note: `flow.applyFileclass` runs against an app view
// whose `vault.modify` for that stand-in is captured, so the module writes
// nothing to disk. The rendered text is then checked (its frontmatter parses,
// carries the class, sets no acceptance or `verified`, leaves no token) and
// written ONCE through the host's own guarded write (`writeNote`, create
// only), which applies the accept guard, the protected properties and the
// name rules every other write gets. Nothing is ever written and then removed.
//
// It CALLS THE FUNCTION. It never runs an Obsidian command, a QuickAdd choice
// or Templater: the module is required headlessly, with `_invoked-by: agent`,
// so nothing prompts. The one QuickAdd token the class templates use,
// `{{DATE[:fmt]}}`, is filled here with Obsidian's moment.
//
// Placement: the class's declared folder (the module's `resolvePlacement`,
// run with no active note, so its human fallback — the folder of the note
// Nelson has open — can never apply), or the caller's `folder`.
//
// The module path is a SETTING (`createNoteFlow`, vault-relative), empty when
// the plugin ships: no vault folder name is written into live code (Nelson,
// 2026-10-03). With it empty the tool is not registered.

import { z } from "zod";
import * as nodePath from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { moment, normalizePath, parseYaml, stringifyYaml, type App } from "obsidian";
import { acceptForbiddenReason, acceptTransitionReason, isVerifiedKey, strictInput } from "@vault-mcp/core";
import { ok, codedError } from "./helpers.js";
import { isVisible, type GuardSettings } from "../guard.js";
import { assertCreateName } from "./name-checks.js";

export const CREATE_NOTE_TOOL = "obsidian_create_note";

const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** What the tool needs from the vault's construction modules. */
export interface FlowModules {
  /** flow.applyFileclass(app, params, note, opts): renders the class into the note through app.vault.modify. */
  applyFileclass: (app: App, params: unknown, note: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
  /** fileclass-render.resolvePlacement(app, cls, params, opts) → folder ("" = root, or the active note's folder) */
  resolvePlacement: (app: App, cls: string, params: unknown, opts?: Record<string, unknown>) => Promise<string>;
  /** Whether the class exists. */
  hasClass: (app: App, cls: string) => boolean;
}

export interface CreateNoteCtx {
  getSettings: () => GuardSettings;
  /** The vault-relative path of flow.js (the `createNoteFlow` setting). */
  flowPath: () => string;
  /** The host's own guarded create: refuses an existing note, applies the accept guard and the name rules, makes parent folders. */
  writeNote: (path: string, content: string) => Promise<{ path: string; created: boolean }>;
  /** A note's rev after the write. */
  revOf?: (path: string) => number | undefined;
  /** Load the modules. Injected so tests run without a vault; production = loadFlowModules. */
  load?: (app: App, flowRel: string) => FlowModules;
}

/** Require flow.js (and through it fileclass-render.js) from the vault. Node's require caches it; a changed module needs an Obsidian restart. */
export function loadFlowModules(app: App, flowRel: string): FlowModules {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (app.vault.adapter as any).basePath as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flow = (window as any).require(nodePath.join(base, flowRel));
  if (typeof flow?.applyFileclass !== "function" || typeof flow?.req !== "function") {
    throw new Error(`${flowRel} does not export applyFileclass and req: is the createNoteFlow setting right?`);
  }
  const render = flow.req(app, "fileclass-render.js");
  return {
    applyFileclass: flow.applyFileclass,
    resolvePlacement: render.resolvePlacement,
    hasClass: (a: App, cls: string) => !!render.definitions(a).find(render.className(cls)),
  };
}

const DATE_TOKEN = /\{\{\s*DATE(?::([^}]*))?\s*\}\}/g;
const ANY_TOKEN = /\{\{[^}]*\}\}/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

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

/**
 * An app view for rendering a note that does not exist yet: the stand-in note
 * reads as empty and has no cache entry, its `vault.modify` is captured instead
 * of written, any other write is refused, and there is no active note (so the
 * module's placement fallback to the open note's folder cannot apply).
 */
export function renderView(app: App, stand: object, sink: { text?: string }): App {
  const vault = Object.create(app.vault);
  vault.read = async (f: unknown) => (f === stand ? "" : app.vault.read(f as never));
  vault.cachedRead = async (f: unknown) => (f === stand ? "" : app.vault.cachedRead(f as never));
  vault.modify = async (f: unknown, text: string) => {
    if (f !== stand) throw new Error("the construction module tried to change another note");
    sink.text = text;
  };
  for (const m of ["create", "createFolder", "delete", "trash", "rename", "append", "process", "createBinary", "modifyBinary"]) {
    vault[m] = async () => {
      throw new Error(`the construction module tried to ${m} during a render`);
    };
  }
  const metadataCache = Object.create(app.metadataCache);
  metadataCache.getFileCache = (f: unknown) => (f === stand ? null : app.metadataCache.getFileCache(f as never));
  const workspace = Object.create(app.workspace);
  workspace.getActiveFile = () => null;
  const view = Object.create(app);
  view.vault = vault;
  view.metadataCache = metadataCache;
  view.workspace = workspace;
  return view as App;
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
        "`values` fills the template's `{{VALUE:name}}` blanks (one line each; no line breaks and no `{{`); a required blank with no value is refused by name. " +
        "The note lands in the folder the class declares, or in `folder` when you pass it; a class that declares none needs `folder`. " +
        "`destination` picks one of several destinations a class declares. The title is `title`, else `values.title` (no `/`, `\\` or `.md`). " +
        "`frontmatter` adds keys the template does not write (e.g. `session`, `session-id`, `reports-to`); it may not set a key the rendered note already has, nor the class key (`type`). " +
        "The note is rendered, checked, and written once; nothing is written when any check fails. Refused: a note that already exists at the path, " +
        "a name Obsidian Sync refuses or that breaks links, acceptance or a `verified` record anywhere in the result, a path outside your allowlist. " +
        "Returns the new note's path and rev. To change an existing note, use obsidian_patch_note or obsidian_manage_frontmatter.",
      inputSchema: strictInput({
        class: z.string().min(1).describe("The fileclass, e.g. 'Event/AgentNotebookEntry' (as in 00.10 Fileclasses)."),
        title: z.string().min(1).optional().describe("The new note's name, without .md. Default: values.title."),
        values: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Values for the class template's {{VALUE:name}} blanks, e.g. {description: '…'}. One line each."),
        folder: z.string().min(1).optional().describe("Vault-relative folder to create the note in, instead of the class's declared folder."),
        destination: z.string().min(1).optional().describe("One of the destinations the class declares, when it declares several."),
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe("Extra frontmatter keys the class template does not write, e.g. {session: '…', 'session-id': '…'}."),
      }),
      annotations: RW,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (raw: any) => {
      const args = raw as { class: string; title?: string; values?: ValueMap; folder?: string; destination?: string; frontmatter?: Record<string, unknown> };
      const values: ValueMap = { ...(args.values ?? {}) };
      const extra: Record<string, unknown> = { ...(args.frontmatter ?? {}) };
      const refuse = (code: string, why: string) => codedError(code, `${why} Nothing was written.`);

      const title = String(args.title ?? values.title ?? "").trim();
      if (!title) return refuse("invalid_argument", "A note needs a name: pass `title` (or `values.title`).");
      if (/[/\\]/.test(title) || /\.md$/i.test(title)) {
        return refuse("invalid_argument", `The title '${title}' names a folder or ends in .md: pass the folder as \`folder\` and the name without .md.`);
      }
      // A value is one line of text: a line break could add frontmatter keys, a `{{` a token.
      for (const [k, v] of Object.entries(values)) {
        if (typeof v === "string" && (/[\r\n]/.test(v) || v.includes("{{"))) {
          return refuse("invalid_argument", `values.${k} holds a line break or '{{': a template value is one line of plain text.`);
        }
      }
      // Acceptance is a human gesture, in no API.
      const named = acceptForbiddenReason(values as Record<string, unknown>) ?? acceptForbiddenReason(extra);
      if (named) return refuse("accept_forbidden", `${named}.`);
      const verifiedKey = [...Object.keys(values), ...Object.keys(extra)].find((k) => isVerifiedKey(k));
      if (verifiedKey) return refuse("accept_forbidden", `'${verifiedKey}' is a verified record, which only Nelson writes.`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const alias = ((app as any).plugins?.plugins?.fileclass?.settings?.fileClassAlias as string | undefined) || "type";
      const bindingKeys = [...new Set([alias, "type", "fileClass", "fileclass"])];
      const extraBinding = bindingKeys.find((k) => k in extra);
      if (extraBinding) return refuse("invalid_argument", `\`frontmatter\` may not set '${extraBinding}': the class sets it. Pass the class as \`class\`.`);
      if (args.folder !== undefined && (/^[a-z][\w-]*:/i.test(args.folder) || args.folder.split("/").includes(".."))) {
        return refuse("invalid_argument", `\`folder\` is a plain vault-relative folder path (no 'uid:' or 'jd:' address, no '..').`);
      }

      let mods: FlowModules;
      try {
        mods = load(app, ctx.flowPath().trim());
      } catch (e) {
        return refuse("unavailable", `The vault's construction module could not be loaded (${(e as Error).message}).`);
      }
      if (!mods.hasClass(app, args.class)) return refuse("invalid_argument", `No fileclass '${args.class}'.`);

      // Agent mode: nothing prompts; a missing required blank throws by name.
      const variables: Record<string, unknown> = { ...values, ...(args.destination ? { destination: args.destination } : {}), "_invoked-by": "agent" };
      const params = { variables, quickAddApi: { format: async (s: string) => fillDates(s) } };

      // Placement, once: the caller's folder, else the class's declared one. The view has no active
      // note, so the module's human fallback resolves to the vault root, which the tool refuses.
      let folder: string;
      if (args.folder !== undefined) {
        folder = args.folder.trim().replace(/^\/+|\/+$/g, "");
      } else {
        try {
          folder = (await mods.resolvePlacement(renderView(app, {}, {}), args.class, params, args.destination ? { destination: args.destination } : {})).trim();
        } catch (e) {
          return refuse("invalid_argument", `${(e as Error).message}`);
        }
        if (!folder) return refuse("invalid_argument", `Class '${args.class}' declares no folder for its notes, so pass \`folder\`.`);
      }

      const path = notePath(folder, title);
      // The guard checks the paths a call NAMES; this one is computed, so the handler applies the same rule.
      if (!isVisible(path, ctx.getSettings())) return refuse("out_of_allowlist", `'${path}' is outside this session's path allowlist.`);
      if (app.vault.getAbstractFileByPath(path)) return refuse("already_exists", `'${path}' already exists. To change it, edit it in place.`);
      try {
        assertCreateName(app, path);
      } catch (e) {
        return refuse("unsafe_name", `${(e as Error).message}`);
      }

      // Render into a stand-in: nothing reaches the disk here.
      const stand = { path, name: `${title}.md`, basename: title, extension: "md", parent: null, stat: { ctime: 0, mtime: 0, size: 0 } };
      const sink: { text?: string } = {};
      try {
        await mods.applyFileclass(renderView(app, stand, sink), params, stand, { cls: args.class, title });
      } catch (e) {
        return refuse("create_failed", `${(e as Error).message}`);
      }
      let text = sink.text ?? "";
      if (!text) return refuse("create_failed", "The construction module rendered nothing.");

      // Check what WOULD be written.
      const left = ANY_TOKEN.exec(text);
      if (left) return refuse("create_failed", `The class template left a token this tool cannot fill: ${left[0]}.`);
      const block = FRONTMATTER.exec(text);
      let fm: Record<string, unknown> = {};
      try {
        const parsed = block ? parseYaml(block[1]) : {};
        fm = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch (e) {
        return refuse("create_failed", `The rendered frontmatter is not valid YAML (${(e as Error).message}).`);
      }
      const bound = bindingKeys.map((k) => fm[k]).find((v) => v !== undefined);
      if (!([] as unknown[]).concat(bound ?? []).some((v) => String(v) === args.class)) {
        return refuse("create_failed", `The rendered note does not carry the class '${args.class}'.`);
      }
      const accept = acceptTransitionReason(null, fm) ?? acceptForbiddenReason(fm);
      if (accept) return refuse("accept_forbidden", `${accept}.`);
      const verifiedRendered = Object.keys(fm).find((k) => isVerifiedKey(k));
      if (verifiedRendered) return refuse("accept_forbidden", `The rendered note sets '${verifiedRendered}', which only Nelson writes.`);

      // `frontmatter`: new keys only, added as text so the class's own YAML is kept as rendered.
      if (Object.keys(extra).length > 0) {
        const clash = Object.keys(extra).find((k) => k in fm);
        if (clash) {
          return refuse("invalid_argument", `\`frontmatter\` sets '${clash}', which the class template already writes: pass it in \`values\` if the template has a blank for it.`);
        }
        if (!block) return refuse("create_failed", "The rendered note has no frontmatter to add keys to.");
        let added = stringifyYaml(extra);
        if (!added.endsWith("\n")) added += "\n";
        const end = block.index + block[0].length - block[2].length - 3; // where the closing fence starts
        text = text.slice(0, end) + added + text.slice(end);
      }

      // Write once, through the host's guarded create.
      let written: { path: string; created: boolean };
      try {
        written = await ctx.writeNote(path, text);
      } catch (e) {
        return refuse("create_failed", `${(e as Error).message}`);
      }
      const rev = ctx.revOf?.(written.path);
      return ok({ path: written.path, class: args.class, created: true, ...(rev !== undefined ? { rev } : {}), filesChanged: 1, files: [written.path] });
    }
  );
}
