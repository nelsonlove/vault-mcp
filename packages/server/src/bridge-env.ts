// bridge-env.ts — the environment the front gives each bridge.mjs it spawns.
//
// The MCP SDK's StdioClientTransport, given no `env`, passes only its short
// default list (HOME, LOGNAME, PATH, SHELL, TERM, USER). The bridge finds the
// plugin's socket through discovery files in its state folder, and a host that
// keeps that folder outside ~/.claude/ (a headless vaultd-host, the plugin's
// `host.stateDir` setting) names it in VAULT_MCP_STATE_DIR — which the default
// list drops, so the bridge looked in ~/.claude/ and found no vault. These are
// the variables the bridge reads to find and pick its vault; each is passed on
// when the front itself has it.
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

export const BRIDGE_ENV_KEYS = ["VAULT_MCP_STATE_DIR", "VAULT_MCP_VAULT"] as const;

// VAULT_MCP_PROFILE (#521) is the connection profile the front chose for ONE session's credential.
// It is set per session from the front's own decision and never copied from the front's
// environment, so a stray variable there cannot change what a session gets. `full` (and no
// profile) sends nothing: the bridge then behaves exactly as a local one, and works with a plugin
// that predates profiles.
export const PROFILE_ENV_KEY = "VAULT_MCP_PROFILE";

export function bridgeEnv(env: NodeJS.ProcessEnv = process.env, session: { profile?: string } = {}): Record<string, string> {
  const out: Record<string, string> = { ...getDefaultEnvironment() };
  for (const k of BRIDGE_ENV_KEYS) {
    const v = env[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  delete out[PROFILE_ENV_KEY];
  if (session.profile && session.profile !== "full") out[PROFILE_ENV_KEY] = session.profile;
  return out;
}
