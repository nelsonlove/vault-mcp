// redaction-env.ts — the secret scanner's settings for the file-system server, from the environment.
//
// OFF BY DEFAULT. Two variables, both optional:
//   VAULT_MCP_REDACT_PROFILES — the connection profiles whose replies are scanned: a JSON array
//                               (`["read+message"]`) or a comma list (`read+message,read`).
//                               Unset or empty: the scanner is off.
//   VAULT_MCP_REDACT_CONFIG   — the path of a JSON file with the scanner config (core's
//                               SecretScanConfig: keyNames, extraKeyNames, patterns, extraPatterns).
//                               Unset: the shipped defaults.
//
// FAIL CLOSED. An unknown profile name, a config file that cannot be read or parsed, or a config
// the scanner refuses throws. The front calls this at start-up and refuses to start; buildFsServer
// calls it too, so a server built with bad settings throws and serves nothing.
//
// These variables apply to FS mode only. In LIVE mode the Obsidian plugin decides, from its own
// settings ("Secret scanner: profiles" and "config").

import { readFileSync } from "node:fs";
import { buildRedaction, parseProfileList, RedactionSettingsError, type Redaction } from "@vault-mcp/core";

export const REDACT_PROFILES_ENV_VAR = "VAULT_MCP_REDACT_PROFILES";
export const REDACT_CONFIG_ENV_VAR = "VAULT_MCP_REDACT_CONFIG";

let cache: { key: string; redaction: Redaction | undefined } | null = null;

/**
 * The redaction settings, or undefined when the scanner is off and no config is named. Throws
 * `RedactionSettingsError` on anything refused. The config file is read once per distinct pair of
 * values; a change to the file takes effect on a restart.
 */
export function loadRedaction(env: NodeJS.ProcessEnv = process.env): Redaction | undefined {
  const rawProfiles = env[REDACT_PROFILES_ENV_VAR]?.trim() ?? "";
  const configPath = env[REDACT_CONFIG_ENV_VAR]?.trim() ?? "";
  const key = `${rawProfiles}\u0000${configPath}`;
  if (cache && cache.key === key) return cache.redaction;
  let redaction: Redaction | undefined;
  if (!rawProfiles && !configPath) {
    redaction = undefined;
  } else {
    let profiles: string[];
    try {
      profiles = parseProfileList(rawProfiles);
    } catch (e) {
      throw new RedactionSettingsError(`${REDACT_PROFILES_ENV_VAR}: ${(e as Error).message}`);
    }
    let config: unknown;
    if (configPath) {
      let text: string;
      try {
        text = readFileSync(configPath, "utf8");
      } catch (e) {
        throw new RedactionSettingsError(`${REDACT_CONFIG_ENV_VAR}: cannot read '${configPath}' (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
      try {
        config = JSON.parse(text);
      } catch {
        throw new RedactionSettingsError(`${REDACT_CONFIG_ENV_VAR}: '${configPath}' is not valid JSON`);
      }
    }
    try {
      redaction = buildRedaction(profiles, config);
    } catch (e) {
      throw new RedactionSettingsError(`${REDACT_PROFILES_ENV_VAR}/${REDACT_CONFIG_ENV_VAR}: ${(e as Error).message}`);
    }
  }
  cache = { key, redaction };
  return redaction;
}
