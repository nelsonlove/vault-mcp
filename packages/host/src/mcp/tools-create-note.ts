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
import { acceptForbiddenReason, acceptTransitionReason, isVerifiedKey, strictInput, uuidv7, normalizeWriteScope, writeScopeRefusalForPath } from "@vault-mcp/core";
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
  /** The class name as the module writes it (fileclass-render.className: no [[ ]], no .md/.fileclass). */
  className: (cls: string) => string;
  /** The top-level fields the class declares up its `extends` chain (#537): where a value no blank used may go. */
  fields?: (app: App, cls: string) => string[];
  /** For a slot function class (`Meta/Slot/<Function>`): the slot's name, the class note's `slot-title`, else the
   *  function's own name. Undefined for any other class. */
  slotName?: (app: App, cls: string) => string | undefined;
}

/** A slot's address alone, `<AC>.<NN>` (e.g. `00.08`): the title a caller passes to have the slot named for it. */
const SLOT_ADDRESS_RE = /^[A-Z0-9]{2}\.\d{2}$/;

/** The slot name for a class, from its note's frontmatter: `slot-title`, else the part after `Meta/Slot/`. */
export function slotNameOf(className: string, frontmatter: Record<string, unknown> | undefined): string | undefined {
  const m = /^Meta\/Slot\/([^/]+)$/.exec(className);
  if (!m) return undefined;
  const t = frontmatter?.["slot-title"];
  return (typeof t === "string" || typeof t === "number" ? String(t).trim() : "") || m[1];
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
    className: (cls: string) => String(render.className(cls)),
    fields: (a: App, cls: string) => declaredFields(a, render, cls),
    slotName: (a: App, cls: string) => {
      const name = String(render.className(cls));
      const file = render.definitions(a).find(name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fm = file ? ((a.metadataCache.getFileCache(file) as any)?.frontmatter as Record<string, unknown> | undefined) : undefined;
      return slotNameOf(name, fm);
    },
  };
}

/** The top-level field names a class declares, up its `extends` chain (a nested field has a `path`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function declaredFields(app: App, render: any, cls: string): string[] {
  const corpus = render.definitions(app);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let step: string | null = String(render.className(cls)); step && !seen.has(step); ) {
    seen.add(step);
    const file = corpus.find(step);
    if (!file) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fm = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as any;
    for (const f of ([] as unknown[]).concat(fm.fields ?? [])) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const x = f as any;
      if (x && typeof x.name === "string" && !(typeof x.path === "string" && x.path.trim() !== "")) out.push(x.name);
    }
    step = typeof fm.extends === "string" ? String(render.className(fm.extends)) : null;
  }
  return [...new Set(out)];
}

const DATE_TOKEN = /\{\{\s*DATE(?::([^}]*))?\s*\}\}/g;
const ANY_TOKEN = /\{\{[^}]*\}\}/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** The QuickAdd `{{DATE[:fmt]}}` token, filled the way QuickAdd fills it (moment; bare = YYYY-MM-DD), except that a date-time gets the local offset (#537). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fillDates(text: string, now: () => { format(f: string): string } = () => (moment as any)()): string {
  return text.replace(DATE_TOKEN, (_w, fmt?: string) => {
    let f = (fmt ?? "").trim() || "YYYY-MM-DD";
    // A full date-time is written with the local offset (#537): without one a YAML reader takes it as UTC.
    if (/HH:mm(:ss)?$/.test(f)) f += "Z";
    return now().format(f);
  });
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

/**
 * A value as a YAML scalar (#537): plain when plain YAML reads it back as the same
 * string, else double-quoted. A conservative test rather than a parse: plain only
 * for text that starts with a letter and holds no character YAML gives a meaning
 * (`:`, `#`, quotes, brackets, …), and is not a word YAML reads as a boolean or null.
 * So `stable/open` stays plain, and `99`, `a: b #c` and `[[Note]]` are quoted.
 * A number or a boolean the caller passed as one is written plain.
 */
export function yamlScalar(v: string | number | boolean): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const plain = /^[A-Za-z_][\w ./+()-]*$/.test(v) && !/\s$/.test(v) && !/^(true|false|yes|no|on|off|null|y|n)$/i.test(v);
  return plain ? v : JSON.stringify(v);
}

/** One frontmatter key as lines (#537): scalars and flat lists through yamlScalar, so a `[[link]]` or a `: ` is quoted; anything deeper through stringifyYaml. */
export function yamlEntry(k: string, v: unknown): string[] {
  const flat = (x: unknown): x is string | number | boolean => typeof x === "string" || typeof x === "number" || typeof x === "boolean";
  if (flat(v)) return [`${k}: ${yamlScalar(v)}`];
  if (v === null || v === undefined) return [`${k}:`];
  if (Array.isArray(v) && v.every(flat)) return v.length ? [`${k}:`, ...v.map((x) => `  - ${yamlScalar(x)}`)] : [`${k}: []`];
  return stringifyYaml({ [k]: v }).replace(/\n+$/, "").split("\n");
}

/** Frontmatter text as blocks: one per top-level key (with its indented lines), in order. */
export function frontmatterBlocks(yaml: string): { key: string | null; lines: string[] }[] {
  const out: { key: string | null; lines: string[] }[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^([^\s#:][^:]*):(\s|$)/.exec(line);
    if (m) out.push({ key: m[1].trim(), lines: [line] });
    else if (out.length && (line.trim() === "" || /^\s/.test(line))) out[out.length - 1].lines.push(line);
    else out.push({ key: null, lines: [line] });
  }
  return out;
}

/** A date-time with no UTC offset, which a YAML reader takes as UTC (#537). */
const NO_OFFSET = /^["']?\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?["']?$/;

/** Keys every note carries, in Global's order, ahead of the class's own (#537). */
const CORE_ORDER = ["title", "description", "type", "fileClass", "fileclass", "created", "modified", "uid"];

/** What the vault module says when a required blank has no value. */
const MISSING_BLANK = /needs "([^"]+)" and no variable supplied it|Missing required variable "([^"]+)"/;

export function registerCreateNoteTool(server: McpServer, app: App, ctx: CreateNoteCtx): void {
  const load = ctx.load ?? loadFlowModules;
  server.registerTool(
    CREATE_NOTE_TOOL,
    {
      title: "Create a note of a class",
      description:
        "Create a new note of a fileclass (e.g. `Event/AgentNotebookEntry`, `Task/AgentTask`) from that class's own `## Template`, " +
        "through the vault's construction module — the way to make a note with a real `type`, never a hand-typed one. " +
        "`values` fills the template's `{{VALUE:name}}` blanks (one line each; no line breaks and no `{{`); every required blank with no value is named in one refusal. " +
        "A value is written as YAML needs: a string stays a string (quoted when it must be, so `99` or `a: b #c` come through as text); pass a number or a boolean to get one. " +
        "A value for a field the class declares goes into the frontmatter when the note does not already set it, even when the body used it; a value used nowhere and placed nowhere is listed in the result's `unused_values`; nothing is dropped silently. " +
        "Every note gets a `uid` and `created`/`modified` with the local offset, and a `{{DATE:…}}` whose format ends in a time (`HH:mm` or `HH:mm:ss`) gets the offset too. " +
        "The note lands in the folder the class declares, or in `folder` when you pass it; a class that declares none needs `folder`. " +
        "`destination` picks one of several destinations a class declares. The title is `title`, else `values.title` (no `/`, `\\` or `.md`). " +
        "For a slot class (`Meta/Slot/<Function>`), a bare address as the title names the slot from the class's `slot-title` (`00.08` becomes `00.08 Audits & reports`), else from the function's name. " +
        "`frontmatter` adds keys the template does not write (e.g. `session`, `session-id`, `reports-to`); it may not set a key the rendered note already has, nor the class key (`type`). " +
        "The note is rendered, checked, and written once; nothing is written when any check fails. Refused: a note that already exists at the path, " +
        "a name Obsidian Sync refuses or that breaks links, acceptance or a `verified` record anywhere in the result, a path outside your allowlist. " +
        "A class whose template uses a token other than `{{VALUE:…}}`, `{{TITLE}}` and `{{DATE…}}` (e.g. a Templater `{{date}}`) is refused. " +
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

      let title = String(args.title ?? values.title ?? "").trim();
      if (!title) return refuse("invalid_argument", "A note needs a name: pass `title` (or `values.title`).");
      // A slot is named for its function (2026-10-15, Nelson's "go" on the .08 "Audits & reports" name): a slot
      // class with a bare address as its title gets "<address> <slot-title>", or the function's own name.
      if (SLOT_ADDRESS_RE.test(title)) {
        let probe: FlowModules | undefined;
        try { probe = load(app, ctx.flowPath().trim()); } catch { probe = undefined; }
        const slot = probe?.hasClass(app, args.class) ? probe.slotName?.(app, args.class) : undefined;
        if (slot) title = `${title} ${slot}`;
      }
      if (/[/\\]/.test(title) || /\.md$/i.test(title)) {
        return refuse("invalid_argument", `The title '${title}' names a folder or ends in .md: pass the folder as \`folder\` and the name without .md.`);
      }
      // The module puts the title in with String.replace, where `$` is a pattern (`$'` pastes the rest of the note), and a `{{` would be a token.
      if (title.includes("$") || title.includes("{{")) {
        return refuse("invalid_argument", `The title '${title}' holds '$' or '{{', which the template would read as a pattern or a token.`);
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
      const alias = ((app as any).plugins?.plugins?.fileclass?.settings?.fileClassAlias as string | undefined) || "fileClass";
      const bindingKeys = [...new Set([alias, "type", "fileClass", "fileclass"])];
      const extraBinding = bindingKeys.find((k) => k in extra);
      if (extraBinding) return refuse("invalid_argument", `\`frontmatter\` may not set '${extraBinding}': the class sets it. Pass the class as \`class\`.`);
      if (args.folder !== undefined && (/^[a-z][\w-]*:/i.test(args.folder) || args.folder.split("/").includes(".."))) {
        return refuse("invalid_argument", `\`folder\` is a plain vault-relative folder path (no 'uid:' or scheme-address prefix such as 'jd:' — that syntax is retired — and no '..').`);
      }

      let mods: FlowModules;
      try {
        mods = load(app, ctx.flowPath().trim());
      } catch (e) {
        return refuse("unavailable", `The vault's construction module could not be loaded (${(e as Error).message}).`);
      }
      if (!mods.hasClass(app, args.class)) return refuse("invalid_argument", `No fileclass '${args.class}'.`);
      const cls = mods.className(args.class);

      // A STAND-IN FOR EACH VALUE (#537). The module strips the template's quotes off a
      // frontmatter line that holds a token before it fills the token in, so a value
      // went in raw: `a: b #c` broke the YAML and "99" became a number. The module is
      // handed a stand-in word instead, and the tool puts each value back itself,
      // quoted as YAML needs (yamlScalar). A stand-in is letters and digits only, so
      // no escaping in the module changes it, and one left out of the render shows
      // which values no blank used.
      const mark = Math.random().toString(36).slice(2, 10);
      const standIns = new Map<string, { name: string; value: string | number | boolean }>();
      const variables: Record<string, unknown> = {};
      let n = 0;
      for (const [k, v] of Object.entries(values)) {
        if (k === "destination") continue; // the module reads it as a placement choice, never a blank
        if (String(v).trim() === "") {
          variables[k] = v; // empty is "not given", as the module reads it
          continue;
        }
        const s = `vmcpv${mark}x${n++}z`;
        standIns.set(s, { name: k, value: v });
        variables[k] = s;
      }
      const titleStandIn = `vmcpt${mark}z`;
      const destination = args.destination ?? (typeof values.destination === "string" && values.destination.trim() ? values.destination : undefined);
      if (destination) variables.destination = destination;
      variables["_invoked-by"] = "agent";
      const paramsFor = (vars: Record<string, unknown>) => ({ variables: { ...vars }, quickAddApi: { format: async (t: string) => fillDates(t) } });

      // Placement, once: the caller's folder, else the class's declared one. The view has no active
      // note, so the module's human fallback resolves to the vault root, which the tool refuses.
      let folder: string;
      if (args.folder !== undefined) {
        folder = args.folder.trim().replace(/^\/+|\/+$/g, "");
      } else {
        try {
          folder = (await mods.resolvePlacement(renderView(app, {}, {}), args.class, paramsFor(variables), destination ? { destination } : {})).trim();
        } catch (e) {
          return refuse("invalid_argument", `${(e as Error).message}`);
        }
        if (!folder) return refuse("invalid_argument", `Class '${args.class}' declares no folder for its notes, so pass \`folder\`.`);
      }

      const path = notePath(folder, title);
      // The guard checks the paths a call NAMES; this one is computed, so the handler applies the same rule.
      if (!isVisible(path, ctx.getSettings())) return refuse("out_of_allowlist", `'${path}' is outside this session's path allowlist.`);
      // The write scope (core's write-scope.ts): this tool computes its path, so it checks that path itself.
      const scoped = writeScopeRefusalForPath(CREATE_NOTE_TOOL, path, normalizeWriteScope(ctx.getSettings().writeScope), (p) => app.vault.getAbstractFileByPath(p) !== null);
      if (scoped) return codedError(scoped.code, scoped.message);
      if (app.vault.getAbstractFileByPath(path)) return refuse("already_exists", `'${path}' already exists. To change it, edit it in place.`);
      try {
        assertCreateName(app, path);
      } catch (e) {
        return refuse("unsafe_name", `${(e as Error).message}`);
      }

      // Render into a stand-in: nothing reaches the disk here. The module names one missing
      // blank per render, so a missing one gets a filler and the render runs again, until
      // every missing blank is known; they are then refused together (#537).
      const stand = { path, name: `${title}.md`, basename: title, extension: "md", parent: null, stat: { ctime: 0, mtime: 0, size: 0 } };
      const missing: string[] = [];
      const tries: Record<string, unknown> = { ...variables };
      let text = "";
      for (;;) {
        const sink: { text?: string } = {};
        try {
          await mods.applyFileclass(renderView(app, stand, sink), paramsFor(tries), stand, { cls, title: titleStandIn });
        } catch (e) {
          const msg = (e as Error).message;
          const m = MISSING_BLANK.exec(msg);
          const name = m ? (m[1] ?? m[2]) : undefined;
          if (!name || missing.includes(name) || missing.length >= 50) return refuse("create_failed", msg);
          missing.push(name);
          tries[name] = `vmcpfill${mark}z`;
          continue;
        }
        text = sink.text ?? "";
        break;
      }
      if (missing.length) {
        return refuse("invalid_argument", `Class ${cls} needs ${missing.length === 1 ? "a value" : "values"} for ${missing.map((x) => `"${x}"`).join(", ")}. Pass ${missing.length === 1 ? "it" : "them"} in \`values\`.`);
      }
      if (!text) return refuse("create_failed", "The construction module rendered nothing.");
      const used = new Set([...standIns.keys()].filter((s) => text.includes(s)));

      // Check what WOULD be written.
      const block = FRONTMATTER.exec(text);
      if (!block) return refuse("create_failed", "The rendered note has no frontmatter.");
      const valueOf = (s: string) => (s === titleStandIn ? title : String(standIns.get(s)?.value ?? s));
      const anyStandIn = new RegExp(`vmcp[vt]${mark}(?:x\\d+)?z`, "g");
      // The body: each value as it is, escaped for a double-quoted scalar when it sits in one (as the module does).
      const body = text.slice(block[0].length).replace(anyStandIn, (s, off: number, src: string) =>
        src[off - 1] === '"' && src[off + s.length] === '"' ? JSON.stringify(valueOf(s)).slice(1, -1) : valueOf(s)
      );
      // The frontmatter: a line that holds a stand-in gets its value back as a YAML scalar.
      const fmLines = block[1].split(/\r?\n/).map((line) => {
        if (!anyStandIn.test(line)) return line;
        anyStandIn.lastIndex = 0;
        const m = /^(\s*(?:-\s+)?(?:[^\s#:"'][^:]*:\s+)?)(.*)$/.exec(line);
        if (m && m[1].trim() === "") return line.replace(anyStandIn, (s) => valueOf(s));
        if (!m) return line.replace(anyStandIn, (s) => valueOf(s));
        const rest = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
        const one = standIns.get(rest);
        if (one && typeof one.value !== "string") return m[1] + yamlScalar(one.value);
        return m[1] + yamlScalar(rest.replace(anyStandIn, (s) => valueOf(s)));
      });
      anyStandIn.lastIndex = 0;
      const left = ANY_TOKEN.exec(body) ?? ANY_TOKEN.exec(fmLines.join("\n"));
      if (left) return refuse("create_failed", `The class template left a token this tool cannot fill: ${left[0]}.`);

      let blocks = frontmatterBlocks(fmLines.join("\n"));
      let rendered: Record<string, unknown>;
      try {
        const parsed = parseYaml(fmLines.join("\n"));
        rendered = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch (e) {
        return refuse("create_failed", `The rendered frontmatter is not valid YAML (${(e as Error).message}).`);
      }

      // `frontmatter`: new keys only.
      const clash = Object.keys(extra).find((k) => k in rendered);
      if (clash) {
        return refuse("invalid_argument", `\`frontmatter\` sets '${clash}', which the class template already writes: pass it in \`values\` if the template has a blank for it.`);
      }
      for (const [k, v] of Object.entries(extra)) blocks.push({ key: k, lines: yamlEntry(k, v) });

      // A value for a field the class declares and the note does not set goes into the frontmatter
      // (#537), even when the body used it: Meta/Panel shows `description` in its body but had no
      // `description` key. A value used nowhere and placed nowhere is named in the result. Never
      // dropped silently.
      const declared = new Set(mods.fields?.(app, args.class) ?? []);
      const unused: string[] = [];
      for (const [s, { name, value }] of standIns) {
        if (name === "title") continue;
        if (!declared.has(name) || bindingKeys.includes(name)) {
          if (!used.has(s)) unused.push(name);
          continue;
        }
        const b = blocks.find((x) => x.key === name);
        const empty = b && b.lines.length === 1 && b.lines[0].slice(b.lines[0].indexOf(":") + 1).trim().replace(/^(["'])\1$/, "") === "";
        if (!b) blocks.push({ key: name, lines: [`${name}: ${yamlScalar(value)}`] });
        else if (empty) b.lines = [`${name}: ${yamlScalar(value)}`];
        else if (!used.has(s)) unused.push(name);
      }

      // What every note carries (#537): created and modified with the local offset, and a uid.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const now = (moment as any)();
      const stamp = String(now.format("YYYY-MM-DDTHH:mm:ssZ"));
      for (const k of ["created", "modified"]) {
        const b = blocks.find((x) => x.key === k);
        const v = b ? b.lines[0].slice(b.lines[0].indexOf(":") + 1).trim().replace(/^(["'])(.*)\1$/, "$2") : "";
        if (!b) blocks.push({ key: k, lines: [`${k}: ${stamp}`] });
        else if (b.lines.length === 1 && (v === "" || NO_OFFSET.test(v))) b.lines = [`${k}: ${stamp}`];
      }
      const uidBlock = blocks.find((x) => x.key === "uid");
      if (!uidBlock) blocks.push({ key: "uid", lines: [`uid: ${uuidv7(Date.now())}`] });
      else if (uidBlock.lines.length === 1 && uidBlock.lines[0].slice(4).trim().replace(/^["']|["']$/g, "") === "") uidBlock.lines = [`uid: ${uuidv7(Date.now())}`];

      // Global's keys first, in Global's order; the class's own after, as rendered.
      const rank = (k: string | null) => {
        const i = k === null ? -1 : CORE_ORDER.indexOf(k);
        return i < 0 ? CORE_ORDER.length : i;
      };
      blocks = blocks.map((b, i) => ({ b, i })).sort((x, y) => rank(x.b.key) - rank(y.b.key) || x.i - y.i).map((x) => x.b);
      const yaml = blocks.flatMap((b) => b.lines).join("\n");

      let fm: Record<string, unknown>;
      try {
        const parsed = parseYaml(yaml);
        fm = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch (e) {
        return refuse("create_failed", `The rendered frontmatter is not valid YAML (${(e as Error).message}).`);
      }
      // The class under whichever binding key the module wrote (its alias, or fileClass when the plugin is not loaded).
      const carries = bindingKeys.some((k) => ([] as unknown[]).concat(fm[k] ?? []).some((v) => String(v) === cls));
      if (!carries) return refuse("create_failed", `The rendered note does not carry the class '${cls}'.`);
      const accept = acceptTransitionReason(null, fm) ?? acceptForbiddenReason(fm);
      if (accept) return refuse("accept_forbidden", `${accept}.`);
      const verifiedRendered = Object.keys(fm).find((k) => isVerifiedKey(k));
      if (verifiedRendered) return refuse("accept_forbidden", `The rendered note sets '${verifiedRendered}', which only Nelson writes.`);

      const out = `---\n${yaml}\n---\n${body}`;

      // Write once, through the host's guarded create.
      let written: { path: string; created: boolean };
      try {
        written = await ctx.writeNote(path, out);
      } catch (e) {
        return refuse("create_failed", `${(e as Error).message}`);
      }
      const rev = ctx.revOf?.(written.path);
      return ok({
        path: written.path,
        class: cls,
        created: true,
        ...(rev !== undefined ? { rev } : {}),
        ...(unused.length
          ? { unused_values: unused, warning: `No blank of class ${cls} used ${unused.map((x) => `"${x}"`).join(", ")}, and the class declares no such field, or the note already sets it, so ${unused.length === 1 ? "it was" : "they were"} not written.` }
          : {}),
        filesChanged: 1,
        files: [written.path],
      });
    }
  );
}
