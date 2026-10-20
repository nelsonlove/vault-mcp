// register-file-tools.ts — the three tools that write, edit and move `.base` and `.canvas` files
// (#575), and the move of attachment files whose extension is on the operator's list, registered on both servers the way the note tools are: the live host passes its
// ObsidianBackend through its guarded registerTool (kernel: if_rev, idempotency_key, the journal,
// the Sync guard, the allowlist, the write scope, the connection profile), and the file-system
// server passes its write-kernel backend (queue and journal; if_rev and idempotency_key accepted
// and not checked, as for its note tools).
//
// A separate registrar, not three more FS_TOOLS rows: FS_TOOLS is the 17 note tools, and their
// count and schemas are pinned as such on both servers. Trash stays with `obsidian_trash` on the
// live host, which already takes any file.
//
// Only the MOVE takes more than `.base` and `.canvas`: it does not read or change a file's bytes.
// The write and the edit validate content, and stay those two types.

import { z } from "zod";
import { ok, fail } from "./responses.js";
import { strictInput } from "./strict-input.js";
import { decodeHtmlEntities } from "./fs-backend/vault.js";
import { profileAllows, profileCallRefusal, type ConnProfile } from "./profile.js";
import { FILE_EDIT_OPS, type FileEdit, type FileEditResult } from "./file-formats.js";

/** The three tools, by name. A profile lists them to offer them; none but `full` does today. */
export const WRITE_FILE_TOOL = "obsidian_write_file";
export const EDIT_FILE_TOOL = "obsidian_edit_file";
export const MOVE_FILE_TOOL = "obsidian_move_file";
export const FILE_TOOL_NAMES: readonly string[] = Object.freeze([WRITE_FILE_TOOL, EDIT_FILE_TOOL, MOVE_FILE_TOOL]);

/** What a backend must do for the file tools. Each method validates through file-formats.ts before it writes. */
export interface FileBackend {
  /** Create a `.base` or `.canvas` file, or overwrite one when `overwrite` is true. */
  writeFile(relPath: string, content: string, overwrite: boolean): Promise<{ path: string; created: boolean }>;
  /** Apply one keyed edit (file-formats.ts `applyFileEdit`); a remove of an absent item writes nothing. */
  editFile(relPath: string, edit: FileEdit): Promise<FileEditResult & { path: string }>;
  /**
   * Move or rename a `.base` or `.canvas` file, or a file whose extension is on `extensions`
   * (core's `assertMovePair`; absent ⇒ only `.base` and `.canvas`). The extension stays the same.
   */
  moveFile(
    fromRel: string,
    toRel: string,
    options: { update_backlinks: boolean; overwrite: boolean; extensions?: readonly string[] },
  ): Promise<{
    from: string;
    to: string;
    /** Links in notes rewritten to the new path; null when the backend does not rewrite them. */
    backlinks_updated: number | null;
    backlinks_files_touched: number | null;
    /** Live host only: the damage check after its own backlink rewrite. */
    link_check?: unknown;
    /** What this backend did not do about links, in words, when it did not rewrite them. */
    links_note?: string;
  }>;
}

export interface RegisterFileToolsOpts {
  /** As registerFsTools: decode HTML entities in path arguments (the remote server). */
  decodeHtml?: boolean;
  /** As registerFsTools: name the kernel arguments on these strict tools, accepted and not checked (the file-system server). */
  kernelArgs?: boolean;
  /** The connection profile; a tool outside it is not registered, and the handler checks again at call time. */
  profile?: ConnProfile;
  /** Whether a path exists, for the profile's create-only check. */
  exists?: (path: string) => boolean;
  /**
   * The path scope in force for this call, in words, or null when none (the base-under-scope rule
   * below). The live host: its path allowlist or a vault-wide write scope that limits paths; the
   * file-system server: its write scope. A connection profile's own write scope counts too.
   */
  pathScope?: () => string | null;
  /**
   * The extensions `obsidian_move_file` moves besides `.base` and `.canvas`, normalized (core's
   * `normalizeFileMoveExtensions`), read per call. The live host: its `fileMoveExtensions`
   * setting; the file-system server: `VAULT_MCP_FILE_MOVE_EXTENSIONS`. Absent ⇒ none.
   */
  moveExtensions?: () => readonly string[];
}

/**
 * A `.base` is not written, edited or moved while a path scope is in force (#580 review 1). A Base
 * is a QUERY: its filters can reach notes outside the allowlist, and `vaultmcp_bases_query` checks
 * only the `.base` file's own path, so an agent-written Base inside the allowlist would read rows from
 * outside it. The tools that run an agent's own query refuse outright under a scope; this is the same
 * posture for the one way an agent could author such a query. A `.canvas` runs no query and stays allowed.
 */
export class BaseUnderScopeError extends Error {
  readonly code = "base_under_scope";
  constructor(tool: string, path: string, scope: string) {
    super(
      `'${tool}' does not write, edit or move a .base file ('${path}') while ${scope} is in force: a Base is a query, and its filters could read notes outside the scope. ` +
        "Nothing was written. A .canvas file is still allowed; a person can change the Base in Obsidian.",
    );
    this.name = "BaseUnderScopeError";
  }
}

const KERNEL_ARGS_FS = {
  if_rev: z.number().optional().describe("The file's rev from a read. Checked by the Obsidian plugin's kernel; the file-system server does not check it."),
  idempotency_key: z.string().min(1).max(200).optional().describe("A retry-safety key. Honoured by the Obsidian plugin's kernel; the file-system server does not deduplicate."),
  intent: z.string().min(1).max(2000).optional().describe("Advisory text for the journal. Recorded by the Obsidian plugin; the file-system server does not record it."),
};

const VALIDATION =
  "Validated before anything is written: a .base must parse as one YAML document whose top level is a mapping (and whose `views`, when present, is a list of mappings); a .canvas must parse as a JSON object whose `nodes` and `edges`, when present, are arrays of objects each with a unique string `id` (JSON Canvas 1.0). Content that fails is refused with Error [invalid_file] and nothing is written. ";

const SCOPE =
  "While a path allowlist or a write scope limits this session, a .base file is not written, edited or moved (Error [base_under_scope]): a Base is a query, and its filters could read notes outside the scope. A .canvas is still allowed. ";

const REV =
  "To get a file's `rev` for `if_rev`, read it with obsidian_read_note (it reads a .base or .canvas file as text). ";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolRegistrar = { registerTool(name: string, meta: any, handler: (args: any, extra?: any) => any): any };

/** Register the three file tools on `server`, driving `backend`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerFileTools(server: any, backend: FileBackend, opts: RegisterFileToolsOpts = {}): void {
  const reg = server as ToolRegistrar;
  const dec = (s: string): string => (opts.decodeHtml ? decodeHtmlEntities(s) : s);
  const profile = opts.profile;
  const offered = (name: string) => !profile || profileAllows(profile, name);
  const schema = (shape: Record<string, z.ZodTypeAny>) => strictInput({ ...(opts.kernelArgs ? KERNEL_ARGS_FS : {}), ...shape });
  // The profile's call-time check, on the arguments the handler will use (decoded paths).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gated = (name: string, inner: (args: any, extra?: any) => Promise<unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any, extra?: any) => {
      const seen: Record<string, unknown> = { ...args };
      for (const k of ["path", "from", "to"]) if (typeof seen[k] === "string") seen[k] = dec(seen[k] as string);
      if (profile) {
        const refused = profileCallRefusal(profile, name, true, seen, opts.exists ?? (() => true));
        if (refused) return fail(Object.assign(new Error(refused.message), { code: refused.code }));
      }
      const base = ["path", "from", "to"].map((k) => seen[k]).find((v): v is string => typeof v === "string" && v.endsWith(".base"));
      if (base !== undefined) {
        const scope = profile?.writeScope && profile.writeScope.mode !== "all" ? `this connection's write scope (profile '${profile.name}')` : opts.pathScope?.() ?? null;
        if (scope) return fail(new BaseUnderScopeError(name, base, scope));
      }
      return inner(args, extra);
    };

  if (offered(WRITE_FILE_TOOL)) {
    reg.registerTool(
      WRITE_FILE_TOOL,
      {
        title: "Write a .base or .canvas file",
        description:
          "Create an Obsidian Bases file (.base, YAML) or a JSON Canvas file (.canvas), or overwrite one when overwrite=true. Path must end in .base or .canvas; a note goes through obsidian_write_note. Parent folders are created as needed. " +
          VALIDATION +
          SCOPE +
          "A NEW file's path may not hold a character Obsidian Sync refuses (\\ : * ? \" < > |) or one that breaks links (# ^ [ ]): refused with `unsafe_name`; no path may be in a hidden folder. " +
          REV +
          "An argument this tool does not name is refused, never ignored. To change one view of a Base or one node or edge of a Canvas, use obsidian_edit_file.",
        inputSchema: schema({
          path: z.string().min(1).describe("Vault-relative path ending in .base or .canvas, e.g. 'Projects/Tasks.base'."),
          content: z.string().describe("The whole file: YAML for a .base, JSON for a .canvas."),
          overwrite: z.boolean().default(false).describe("Replace an existing file. Default false (refuses if it exists)."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      gated(WRITE_FILE_TOOL, async ({ path: p, content, overwrite }: { path: string; content: string; overwrite: boolean }) => {
        try {
          return ok(await backend.writeFile(dec(p), content, overwrite));
        } catch (e) {
          return fail(e);
        }
      }),
    );
  }

  if (offered(EDIT_FILE_TOOL)) {
    reg.registerTool(
      EDIT_FILE_TOOL,
      {
        title: "Edit one view of a .base or one node or edge of a .canvas",
        description:
          "Change one keyed item of a file and leave the rest as written. A .base: `upsert_view` replaces the view named `key` (or, without `key`, the view with the item's own `name`) with `item_json`, or adds it when there is none; `remove_view` removes the view named `key`. A .canvas: `upsert_node` / `upsert_edge` replace the node or edge with the item's `id`, or add it; `remove_node` / `remove_edge` remove the one with id `key` (removing a node also removes every edge that ends on it, listed in `edges_removed`). " +
          "A remove of an item the file does not have returns `found: false` and writes nothing. Two views with one name are refused (`invalid_edit`): rewrite the file whole. " +
          "The result of the edit is validated as obsidian_write_file validates a whole file, and refused with Error [invalid_file] if it would not parse. A Base keeps its comments and the style of the parts not edited; a Canvas keeps its indentation. The result's `key` names the view the file now holds (`replaced` names the view an upsert renamed). " +
          SCOPE +
          REV +
          "An argument this tool does not name is refused, never ignored.",
        inputSchema: schema({
          path: z.string().min(1).describe("Vault-relative path of the .base or .canvas file."),
          op: z.enum(FILE_EDIT_OPS).describe("The edit: upsert_view / remove_view for a .base; upsert_node / remove_node / upsert_edge / remove_edge for a .canvas."),
          key: z.string().min(1).optional().describe("The view's name, or the node's or edge's id. Required for a remove. For upsert_view, the view to replace (the item may rename it); for a node or edge it must equal the item's id when given."),
          item_json: z.string().min(1).optional().describe("For an upsert: the whole view, node or edge, as JSON text (a view may also be written as YAML), e.g. '{\"id\":\"a1\",\"type\":\"text\",\"text\":\"Hello\",\"x\":0,\"y\":0,\"width\":200,\"height\":80}'."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      gated(EDIT_FILE_TOOL, async ({ path: p, op, key, item_json }: { path: string; op: FileEdit["op"]; key?: string; item_json?: string }) => {
        try {
          return ok(await backend.editFile(dec(p), { op, ...(key !== undefined ? { key } : {}), ...(item_json !== undefined ? { item: item_json } : {}) }));
        } catch (e) {
          return fail(e);
        }
      }),
    );
  }

  if (offered(MOVE_FILE_TOOL)) {
    const extensions = () => opts.moveExtensions?.() ?? [];
    const listed = extensions();
    reg.registerTool(
      MOVE_FILE_TOOL,
      {
        title: "Move or rename a .base, .canvas or attachment file",
        description:
          "Move (or rename) a .base or .canvas file, or an attachment file whose type the operator allows, to another vault path with the same extension (the same case, too). " +
          `Allowed types when this connection was made: .base .canvas${listed.map((e) => ` .${e}`).join("")}; any other type is refused with \`unsupported_file\`. A note (.md) is refused here: move it with obsidian_move_note. No path may be in a hidden folder. ` +
          "`to` may keep the file's own name and the folders it is already in, but any NEW name or folder may not hold a character Obsidian Sync refuses (\\ : * ? \" < > |) or one that breaks links (# ^ [ ]): refused with `unsafe_name`. Refuses if `to` exists unless overwrite: true (on the live Obsidian server the file replaced goes to the system trash). Parent folders are created as needed. " +
          "Links TO the file: on the live Obsidian server, with update_backlinks true (the default), links and embeds in notes ([[Board.canvas]], ![[Tasks.base]], ![[Scan.pdf]], ![](Photo.png)) are rewritten to the new path and checked for damage (`link_check`), as obsidian_move_note does; the file's own text is never rewritten, and links inside other .canvas files are not tracked (Obsidian's link index does not count them). The file-system server does not rewrite links to these files at all (`links_note` says so). " +
          SCOPE +
          "The file's content is not read or changed, so no validation runs. To delete one of these files, use obsidian_trash on the live Obsidian server.",
        inputSchema: schema({
          from: z.string().min(1).describe("Existing vault-relative path of the file, e.g. 'Inbox/Scan.pdf'."),
          to: z.string().min(1).describe("New vault-relative path, with the same extension."),
          update_backlinks: z.boolean().default(true).describe("Rewrite links in notes that reach `from` (live Obsidian server). false: rename only. Ignored by the file-system server, which rewrites none."),
          overwrite: z.boolean().default(false).describe("Replace `to` if it already exists. Default false (refuses)."),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      gated(MOVE_FILE_TOOL, async ({ from, to, update_backlinks, overwrite }: { from: string; to: string; update_backlinks: boolean; overwrite: boolean }) => {
        try {
          const r = await backend.moveFile(dec(from), dec(to), { update_backlinks, overwrite, extensions: extensions() });
          const resp: Record<string, unknown> = { from: r.from, to: r.to, moved: true };
          if (r.backlinks_updated !== null) resp.backlinks_updated = r.backlinks_updated;
          if (r.backlinks_files_touched !== null) resp.backlinks_files_touched = r.backlinks_files_touched;
          if (r.link_check !== undefined) resp.link_check = r.link_check;
          if (r.links_note !== undefined) resp.links_note = r.links_note;
          return ok(resp);
        } catch (e) {
          return fail(e);
        }
      }),
    );
  }
}
