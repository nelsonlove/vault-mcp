// write-scope.ts — what a session may WRITE, separate from what it may read.
//
// The path allowlist (visibility.ts) is one prefix list for reads and writes
// together. A remote host that should read the whole vault but only drop new
// notes into a few folders needs a second rule, for writes alone (Nelson,
// 2026-10-13, relayed by [lead-FL-pro] vaultd: "it's closer to the use cases for
// vault-mcp", then "it should be configurable in vault-mcp and configured there
// alone"). So the rule is a setting, and no folder name lives in this code.
//
// Two modes:
//   - "all" (the default): no write rule beyond read-only mode and the allowlist.
//   - "create-only": a mutating call is allowed only when it CREATES a new note
//     at a path that matches one of `paths` (glob patterns over the vault-relative
//     note path). Everything else that writes is refused with `write_scope`:
//     an overwrite, an edit, an append, a frontmatter change, a rename, a move, a
//     delete, a trash, a folder of its own, a command, a plugin or snippet change.
//     The tools that can create a note by a path are a closed list (CREATE_TOOLS);
//     a mutating tool not on it is refused whatever its arguments, so a new tool
//     is refused until someone decides it creates.
//
// The check runs where every mutating call passes before the queue (the host's
// runGuarded, the FS server's write kernel), on the RESOLVED arguments. That a
// note does not exist yet is checked there, and again at the write itself: the
// create tools write create-only (overwrite false, or a batch item's
// create_only), which refuses a note that appeared in between.

import { normalizePosix } from "./visibility.js";

export type WriteScopeMode = "all" | "create-only";

export interface WriteScope {
  mode: WriteScopeMode;
  /** Glob patterns over the vault-relative note path: `**` any folders (or none), `*` and `?` within one name, `[…]` a character class. */
  paths: string[];
}

export const DEFAULT_WRITE_SCOPE: WriteScope = { mode: "all", paths: [] };

/** No write is allowed: what an unclear value reads as, so a typo closes rather than opens (#542 review). */
const CLOSED: WriteScope = { mode: "create-only", paths: [] };

/**
 * Coerce a hand-edited value. ABSENT (undefined or null) is the default, "all".
 * Anything else that is not exactly `{mode: "all"}` or `{mode: "create-only",
 * paths: [string, …]}` FAILS CLOSED: every write refused. A misspelt mode
 * ("create_only", "createOnly") must not read as "all", which would open every
 * write the operator meant to close. A pattern that does not compile is dropped,
 * which narrows the scope, never widens it.
 */
export function normalizeWriteScope(raw: unknown): WriteScope {
  if (raw === undefined || raw === null) return { ...DEFAULT_WRITE_SCOPE, paths: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ...CLOSED, paths: [] };
  const r = raw as Record<string, unknown>;
  if (r.mode !== "all" && r.mode !== "create-only") return { ...CLOSED, paths: [] };
  if (r.paths !== undefined && !Array.isArray(r.paths)) return { ...CLOSED, paths: [] };
  // The patterns are kept in mode "all" too, though only create-only reads them, so an operator who
  // types them first and switches the mode second does not lose them (#542 review 2).
  const paths = ((r.paths as unknown[] | undefined) ?? [])
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map((p) => p.trim().replace(/^\/+/, ""))
    .filter((p) => {
      try {
        globToRegExp(p);
        return true;
      } catch {
        return false;
      }
    });
  return { mode: r.mode, paths };
}

/** A glob as a RegExp over a vault-relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` is any number of folders, none included; a bare `**` is anything.
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) {
        re += "\\[";
      } else {
        // A class never matches `/`: a negated one (`!` or `^`) excludes it, a plain one is
        // preceded by a lookahead, so a range such as `[+-0]` cannot cross a folder (#542 review).
        const body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        re += body.startsWith("!") || body.startsWith("^") ? `[^/${body.slice(1)}]` : `(?!/)[${body}]`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether a vault-relative note path matches one of the scope's patterns. */
export function inWriteScope(path: string, scope: WriteScope): boolean {
  // The same normalisation the allowlist uses, so `A/./B` or `A//B` cannot slip past a pattern.
  const p = normalizePosix(path.replace(/^\/+/, ""));
  if (p.startsWith("/") || p.split("/").includes("..")) return false;
  return scope.paths.some((g) => globToRegExp(g).test(p));
}

/** The tools that can create a note at a path the arguments name, and how to tell a create from an overwrite. */
export const CREATE_TOOLS: ReadonlyMap<string, (args: Record<string, unknown>) => boolean> = new Map([
  // overwrite defaults to false: a create unless the caller asks to replace.
  ["obsidian_write_note", (a: Record<string, unknown>) => a.overwrite !== true],
  // One batch item, as the batch dispatches it: an item without if_rev arrives with create_only.
  ["obsidian_write_notes", (a: Record<string, unknown>) => a.create_only === true],
]);

/**
 * Tools that create a note at a path they COMPUTE (the class decides the folder),
 * so the check cannot run on their arguments: each checks its own computed path
 * with `writeScopeRefusalForPath` before it writes.
 */
export const COMPUTED_CREATE_TOOLS: ReadonlySet<string> = new Set(["obsidian_create_note"]);

const refusal = (message: string) => ({ code: "write_scope", message: `${message} Nothing was written.` });

/** The refusal for one computed path, or null: in scope, and no note there yet. */
export function writeScopeRefusalForPath(
  tool: string,
  path: string,
  scope: WriteScope,
  exists: (path: string) => boolean
): { code: string; message: string } | null {
  if (scope.mode !== "create-only") return null;
  if (!inWriteScope(path, scope)) {
    return refusal(`'${tool}' may only create a new note in the folders this vault-mcp's write scope allows, and '${path}' is not one of them.`);
  }
  if (exists(path)) return refusal(`'${path}' already exists, and this vault-mcp's write scope allows only creating new notes.`);
  // In a folder that is already there: a create would otherwise make every missing parent
  // folder, and a pattern that starts with ** would then let a new tree appear anywhere (#542 review).
  const p = normalizePosix(path.replace(/^\/+/, ""));
  const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  if (parent && !exists(parent)) {
    return refusal(`'${tool}' may only create a new note in a folder that already exists, and '${parent}' does not; this vault-mcp's write scope makes no new folders.`);
  }
  return null;
}

/**
 * The refusal for a mutating call, or null. `paths` are the paths the RESOLVED
 * arguments name; `exists` asks the vault.
 */
export function writeScopeRefusal(
  tool: string,
  args: Record<string, unknown>,
  paths: string[],
  scope: WriteScope,
  exists: (path: string) => boolean
): { code: string; message: string } | null {
  if (scope.mode !== "create-only") return null;
  if (COMPUTED_CREATE_TOOLS.has(tool)) return null; // the tool checks the path it computes
  const isCreate = CREATE_TOOLS.get(tool);
  if (!isCreate) {
    return refusal(`'${tool}' changes the vault in a way this vault-mcp's write scope does not allow: it allows only creating new notes (obsidian_write_note, obsidian_write_notes, obsidian_create_note) in the folders it names.`);
  }
  if (!isCreate(args)) return refusal(`'${tool}' was asked to replace a note, and this vault-mcp's write scope allows only creating new notes.`);
  if (paths.length !== 1) return refusal(`'${tool}' must name exactly one note to create under this vault-mcp's write scope.`);
  return writeScopeRefusalForPath(tool, paths[0], scope, exists);
}
