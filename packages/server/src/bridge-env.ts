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

export function bridgeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { ...getDefaultEnvironment() };
  for (const k of BRIDGE_ENV_KEYS) {
    const v = env[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
}
