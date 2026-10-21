// headless.ts — running the plugin with no Obsidian window (vaultd-host).
//
// vaultd's headless plugin host loads this plugin over a vault with no Obsidian
// app: no window, no editor views, no workspace leaves, no `obsidian` CLI that
// can reach an app, and `Modal.open` absent. Measured on 2026-10-13 (vaultd's
// probe, "vault-mcp inside vaultd-host"): 71 tools served, and the ones that
// need the app either failed (the five CLI-backed tools, toggle_view_mode, the
// workspaces) or said they had worked when nothing happened (open_in_editor,
// jump_to). This file is the plugin's one answer to "is there an app here?".
//
// HOW IT KNOWS. A setting, `host.headless`: "on", "off" or "auto" (the default).
// "auto" reads the environment variable VAULT_MCP_HEADLESS ("1"/"true" or
// "0"/"false") and, failing that, asks the workspace at call time: real
// Obsidian always keeps at least one leaf once its layout is ready, and the
// headless host never has one. That probe is a call-time answer only; at load
// the layout is not ready, so what is decided at load (whether a tool is
// offered at all, whether the load-time `claude` registration runs) follows
// the setting and the variable alone ("declared" headless).
//
// The same setting object carries the two path overrides and the switch for
// the load-time `claude mcp` registration, so one key in data.json is all an
// operator of a headless host needs: { "host": { "headless": "on",
// "stateDir": "/srv/vault-mcp/state", "autoRegisterClaude": false } }.

import type { App } from "obsidian";

export type HeadlessMode = "auto" | "on" | "off";

export interface HostSettings {
  /** "auto" (default): the VAULT_MCP_HEADLESS variable, else a call-time look at the workspace. */
  headless: HeadlessMode;
  /** An absolute path: where the socket, bridge.mjs, the discovery file and the observation store go. Empty (or relative, which is ignored): `~/.claude/vault-mcp/` (or VAULT_MCP_STATE_DIR). Set: nothing is written under `~/.claude/governor/`. */
  stateDir: string;
  /** An absolute path: the socket to bind. Empty (or relative, which is ignored): `<stateDir>/<vault-slug>.sock`. */
  socketPath: string;
  /** Run `claude mcp …` at load to register the server with Claude Code. Off by default on a fresh install (#598); an install that predates the key keeps the old on (see `autoRegisterOnLoad`). Off when headless is declared, whatever this says. */
  autoRegisterClaude: boolean;
}

export const DEFAULT_HOST_SETTINGS: HostSettings = { headless: "auto", stateDir: "", socketPath: "", autoRegisterClaude: false };

/** Coerce a partial or hand-edited value; absent ⇒ the defaults. */
export function normalizeHostSettings(raw: unknown): HostSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const headless = r.headless === "on" || r.headless === "off" ? r.headless : "auto";
  // A path must be absolute: a relative one would resolve against the renderer's working folder, usually `/`.
  const str = (v: unknown) => (typeof v === "string" && v.trim().startsWith("/") ? v.trim() : "");
  return { headless, stateDir: str(r.stateDir), socketPath: str(r.socketPath), autoRegisterClaude: r.autoRegisterClaude === true };
}

export interface AutoRegisterOnLoad {
  /** The value to put in `host.autoRegisterClaude` before the settings are coerced. */
  value: boolean;
  /** True when the stored settings did not hold the key: save now, so the decision runs at most once per install. */
  persist: boolean;
}

/**
 * The default of `autoRegisterClaude` is off (#598), but an install that
 * predates the key was registering and keeps doing so. The discriminator is the
 * same as for the guarded territories: does the plugin already have stored
 * settings (its own data.json, else ones adopted from the pre-split plugin)?
 * None (a fresh install): off. Stored settings whose `host` lacks the key: on,
 * saved once. Otherwise the stored value, untouched.
 */
export function autoRegisterOnLoad(own: unknown, adopted?: unknown): AutoRegisterOnLoad {
  const asObject = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
  const stored = asObject(own) ?? asObject(adopted);
  if (!stored) return { value: false, persist: true };
  const host = asObject(stored.host);
  if (host && Object.prototype.hasOwnProperty.call(host, "autoRegisterClaude")) {
    return { value: host.autoRegisterClaude === true, persist: asObject(own) === null };
  }
  return { value: true, persist: true };
}

function envFlag(name: string): boolean | undefined {
  const v = (typeof process !== "undefined" ? process.env?.[name] : undefined)?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

/** Headless as decided at load: the setting, else VAULT_MCP_HEADLESS. No probe. */
export function declaredHeadless(mode: HeadlessMode): boolean {
  if (mode !== "auto") return mode === "on";
  return envFlag("VAULT_MCP_HEADLESS") === true;
}

/** Headless as answered at call time: the setting, else the variable, else no workspace leaf once the layout is ready. */
export function isHeadless(app: App, mode: HeadlessMode): boolean {
  if (mode !== "auto") return mode === "on";
  const env = envFlag("VAULT_MCP_HEADLESS");
  if (env !== undefined) return env;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = (app as any)?.workspace;
  if (!ws || !ws.layoutReady || typeof ws.iterateAllLeaves !== "function") return false;
  let leaves = 0;
  try {
    ws.iterateAllLeaves(() => {
      leaves++;
    });
  } catch {
    return false;
  }
  return leaves === 0;
}

/** Whether the load-time `claude mcp` registration may run. */
export function autoRegisterAllowed(host: HostSettings): boolean {
  if (envFlag("VAULT_MCP_NO_AUTOREGISTER") === true) return false;
  return host.autoRegisterClaude && !declaredHeadless(host.headless);
}

/**
 * Tools that need the Obsidian app itself: an editor view or a workspace leaf,
 * or the `obsidian` CLI, which forwards into a running app. Headless they are
 * not offered when headless is declared, and refused with `headless_unsupported`
 * when the call-time look finds no app — never run against nothing.
 */
export const APP_ONLY_TOOLS: ReadonlyMap<string, string> = new Map([
  ["obsidian_open_in_editor", "it opens a note in an editor view"],
  ["obsidian_jump_to", "it moves the cursor in an editor view"],
  ["obsidian_toggle_view_mode", "it switches an editor view's mode"],
  ["obsidian_open_workspace", "it loads a window layout (the workspaces core plugin)"],
  ["obsidian_save_workspace", "it saves a window layout (the workspaces core plugin)"],
  ["obsidian_list_workspaces", "it reads the workspaces core plugin"],
  ["obsidian_open_bookmark", "it opens a bookmark in an editor view"],
  ["obsidian_note_history", "it runs the obsidian CLI, which reads File Recovery inside a running app"],
  ["obsidian_note_diff", "it runs the obsidian CLI, which reads File Recovery and Sync history inside a running app"],
  ["obsidian_base_create", "it runs the obsidian CLI, and the base's own configuration (read by the app) decides where the item lands; use obsidian_write_note or obsidian_create_note"],
  ["obsidian_plugin_install", "it runs the obsidian CLI; a headless host's plugin set is its operator's configuration"],
  ["obsidian_plugin_uninstall", "it runs the obsidian CLI; a headless host's plugin set is its operator's configuration"],
  ["obsidian_cli", "it runs the obsidian CLI, which forwards into a running app"],
]);

/**
 * Tools that need the app for ONE form of the call only, so they stay offered
 * headless and refuse just that form: they would otherwise report success with
 * nothing done (#540 review).
 */
export const APP_ONLY_ARGS: ReadonlyMap<string, string> = new Map([
  ["obsidian_periodic_note", "action \"open\" opens the note in an editor view"],
  ["obsidian_run_command", "file_path opens a note in an editor view before the command runs (leave it out to run the command alone)"],
]);

/** Whether this call needs the app: an app-only tool, or the app-only form of a call. */
export function appOnlyCall(tool: string, args: unknown): boolean {
  if (APP_ONLY_TOOLS.has(tool)) return true;
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (tool === "obsidian_periodic_note") return (a.action ?? "open") === "open";
  if (tool === "obsidian_run_command") return typeof a.file_path === "string" && a.file_path !== "";
  return false;
}

/** The refusal an app-only tool gives headless. */
export function headlessRefusal(tool: string): { content: { type: "text"; text: string }[]; isError: true } {
  const why = APP_ONLY_TOOLS.get(tool) ?? APP_ONLY_ARGS.get(tool) ?? "it needs the Obsidian app";
  return {
    content: [{ type: "text", text: `Error [headless_unsupported]: '${tool}' needs the Obsidian app, and this vault-mcp runs headless (no Obsidian window): ${why}. Nothing was done.` }],
    isError: true,
  };
}
