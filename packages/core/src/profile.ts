// profile.ts — the connection profile: which tools one connection may see and call (#521).
//
// A remote (hosted) client reaches the vault through the front (packages/server). The front
// decides, per credential, which profile the connection gets and hands its NAME to the bridge,
// which sends it in the connection preamble; the plugin (and the FS-mode server) build the
// connection's tool surface from it. A local connection (the Claude Code bridge on this Mac)
// sends no profile and gets `full`, exactly as before.
//
// FAIL CLOSED BY NAME. A profile is an allowlist of tool names. A tool whose name is not on it is
// never registered, so it is absent from tools/list and "not found" on call; the call-time gate
// (`profileCallRefusal`) is a second check. A new tool is outside every profile but `full` until
// someone adds it here. A profile name nobody knows resolves to `none` (no tools at all), never to
// `full`, so a typo or a newer front talking to an older plugin cannot open the vault.
//
// Rulings: Nelson's "all picks" of 2026-10-17 (01.43, pick A: a read-only profile per token or
// OAuth subject; every folder stays reachable, no deny list is ruled).

import type { WriteScope } from "./write-scope.js";
import { writeScopeRefusal } from "./write-scope.js";
import { collectPaths } from "./guard-paths.js";

/** Every read tool a remote client may see under `read` (#521). Names only; each is checked to exist by the tests. */
export const READ_PROFILE_TOOLS: readonly string[] = Object.freeze([
  "obsidian_list_notes",
  "obsidian_list_folders",
  "obsidian_read_note",
  "obsidian_read_notes",
  "obsidian_search_notes",
  "obsidian_find_by_tag",
  "obsidian_search_by_frontmatter",
  "obsidian_resolve",
  "obsidian_get_backlinks",
  "obsidian_get_outlinks",
  "obsidian_read_note_parsed",
  "obsidian_resolve_uid",
  "obsidian_check_links",
  "obsidian_tags_list",
  "obsidian_list_bookmarks",
  "obsidian_list_workspaces",
  "obsidian_snippets_list",
  "obsidian_snippet_read",
  "obsidian_get_command_ids",
  "obsidian_plugin_info",
  "obsidian_environment_info",
  "vaultmcp_conformance_debt",
  "vaultmcp_bases_list",
]);

/**
 * The write scope of `read+inbox`: a NEW note directly inside a `.01` slot folder (`XX.01` or
 * `XX.01 <name>`, at any depth), and nowhere else. The create-only write scope (write-scope.ts,
 * #542) refuses an overwrite, an existing note, a missing parent folder and every other write.
 */
export const INBOX_WRITE_SCOPE: WriteScope = Object.freeze({
  mode: "create-only",
  paths: Object.freeze(["**/[0-9A-Z][0-9A-Z].01/*.md", "**/[0-9A-Z][0-9A-Z].01 */*.md"]) as unknown as string[],
}) as WriteScope;

const READ_SET: ReadonlySet<string> = new Set(READ_PROFILE_TOOLS);

export type ProfileName = "full" | "read" | "read+inbox" | "none";

export interface ConnProfile {
  name: ProfileName;
  /** The tool names this connection may see and call; null means every tool (`full` only). */
  tools: ReadonlySet<string> | null;
  /** A write rule for this connection alone, checked on top of the vault-wide one. */
  writeScope?: WriteScope;
}

const PROFILES: Record<Exclude<ProfileName, "none">, ConnProfile> = {
  full: { name: "full", tools: null },
  read: { name: "read", tools: new Set(READ_PROFILE_TOOLS) },
  "read+inbox": { name: "read+inbox", tools: new Set([...READ_PROFILE_TOOLS, "obsidian_write_note"]), writeScope: INBOX_WRITE_SCOPE },
};

const NONE: ConnProfile = { name: "none", tools: new Set() };

/** The profile names a front may map a credential to. */
export const PROFILE_NAMES: readonly string[] = Object.freeze(Object.keys(PROFILES));

/** Whether a name is a known profile (for the front's config check). */
export function isProfileName(name: unknown): name is Exclude<ProfileName, "none"> {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(PROFILES, name);
}

/**
 * The profile for a name from the preamble. ABSENT (undefined, null, "") is `full`: a local
 * connection that names no profile is unchanged. Anything else that is not a known name is `none`.
 */
export function resolveProfile(name: unknown): ConnProfile {
  if (name === undefined || name === null || name === "") return PROFILES.full;
  return isProfileName(name) ? PROFILES[name] : NONE;
}

/** Whether this profile lets the connection see a tool of this name. */
export function profileAllows(profile: ConnProfile, tool: string): boolean {
  return profile.tools === null || profile.tools.has(tool);
}

/**
 * The call-time refusal, or null: the second check behind registration. A tool outside the
 * profile is refused; a mutating call is checked against the profile's own write scope on its RAW
 * arguments (an address such as `uid:` or `jd:` matches no glob, so it is refused, never widened).
 */
export function profileCallRefusal(
  profile: ConnProfile,
  tool: string,
  mutating: boolean,
  args: unknown,
  exists: (path: string) => boolean
): { code: string; message: string } | null {
  if (!profileAllows(profile, tool)) {
    return { code: "profile_refused", message: `'${tool}' is not offered on this connection (profile '${profile.name}'). Nothing was done.` };
  }
  // A tool on the read list is a read by NAME, whatever its annotations say: the host treats an
  // untrusted satellite's read as mutating (trustedReadOnlyPlugins), and that must not make the
  // profile's write scope refuse a read such as vaultmcp_bases_list.
  if (mutating && profile.writeScope && !READ_SET.has(tool)) {
    const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const paths = collectPaths(a);
    // A path that still holds an HTML entity is refused under a profile's write scope (#562 review 1):
    // some handlers decode entities, so `&#47;` could become a '/' after the scope was checked.
    const entity = paths.find((p) => /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(p));
    if (entity !== undefined) {
      return { code: "write_scope", message: `'${tool}' names '${entity}', which holds an HTML entity; on this connection a path is written plainly. Nothing was written.` };
    }
    return writeScopeRefusal(tool, a, paths, profile.writeScope, exists);
  }
  return null;
}
