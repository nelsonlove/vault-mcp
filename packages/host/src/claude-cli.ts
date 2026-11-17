import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
// `spawnEnv` (PATH augmentation for spawned processes) and `findBinary` (the
// executable-file probe) were DEFINED here until the mutating tier's
// extraction, when the `vaultmcp-fileclass` satellite — which spawns the
// `fileclass` CLI out of its own plugin — needed both to behave identically to
// the host's. Publishing beat forking a pair of one-line functions whose whole
// value is that both sides agree (the `isVisible` / `executeQuickAddChoice` /
// `resolveScope` precedent). They are re-exported unchanged below, so every
// call site and test in this package is untouched.
import { spawnEnv, findBinary } from "@vault-mcp/core";

const pexecFile = promisify(execFile);

export { spawnEnv, findBinary };

// Pure + testable: returns the first candidate that exists, else null.
export function findClaudeBinary(opts?: {
  candidates?: string[];
  fileExists?: (p: string) => boolean;
}): string | null {
  const home = os.homedir();
  const candidates = opts?.candidates ?? [
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return findBinary(candidates, opts?.fileExists);
}

/** The Claude Code MCP server name — tool prefixes become `mcp__vault-mcp__*`.
 *
 * Renamed BACK from `governor` at the suite split's S3c (Nelson's ruling,
 * 2026-09-09). 0.12.0 moved it `vault-mcp` → `governor` with the plugin id;
 * the split moves both back, because after the split `governor` names the
 * governance PROVIDER and prefixing the HOST's tools with it is the same
 * architectural lie the `obsidian_pending_review` → `governance_pending_review`
 * rename fixed one level down. The stated, accepted cost is one-time: an
 * operator's `mcp__governor__*` permission entries must be re-added as
 * `mcp__vault-mcp__*`.
 *
 * Claude Code does NOT sanitize the server name into the tool prefix — a
 * hyphen survives (`mcp__vault-mcp__obsidian_read_note`), which is exactly the
 * spelling this server used before 0.12.0 and the spelling the operator's own
 * `~/.claude/settings.local.json` still carries from that era.
 *
 * The plugin never removes a stale `governor` registration itself — that is a
 * deliberate human step at cutover (`claude mcp remove governor`), and until it
 * is taken, `claudeLegacyIsRegistered` makes the half-migrated state visible in
 * the settings tab rather than letting it read as clean. */
export const MCP_SERVER_NAME = "vault-mcp";

/** The 0.12.0-era registration name, kept ONLY so the settings tab can SAY that
 * a stale entry is still there. Nothing registers or removes under it. */
export const LEGACY_MCP_SERVER_NAME = "governor";

/** `exec` is injectable for the same reason `claudeEnsureConnectPlugin`'s is:
 * WHICH name each probe asks the CLI about is the load-bearing behaviour, and
 * spawning a real `claude` in a test cannot assert it. */
export type ProbeExec = (bin: string, args: string[]) => Promise<unknown>;

async function mcpEntryExists(bin: string, name: string, exec?: ProbeExec): Promise<boolean> {
  const run: ProbeExec = exec ?? ((b, a) => pexecFile(b, a, { env: spawnEnv() }));
  try {
    await run(bin, ["mcp", "get", name]);
    return true; // exit 0 => present
  } catch {
    return false;
  }
}

export async function claudeIsRegistered(bin: string, opts?: { exec?: ProbeExec }): Promise<boolean> {
  return mcpEntryExists(bin, MCP_SERVER_NAME, opts?.exec);
}

/** Is a 0.12.0-era `governor` entry still registered?
 *
 * DELIBERATELY NOT folded into `claudeIsRegistered`. The 0.12.0 precedent's
 * dual-id pattern belongs to the state dirs, where silent continuity is the
 * whole point; a registration name is an operator decision surface, so the
 * grace state must be DISCLOSED, not hidden. Accepting either name here would
 * report "Registered: yes" on a vault that has not been re-registered at all —
 * a half-migrated state reading as clean, which is the failure this split's
 * review kept finding. The old entry does keep WORKING (the bridge resolves the
 * socket through discovery, never through the registration name), so nothing
 * breaks while it stands; it just stops being invisible. */
export async function claudeLegacyIsRegistered(bin: string, opts?: { exec?: ProbeExec }): Promise<boolean> {
  return mcpEntryExists(bin, LEGACY_MCP_SERVER_NAME, opts?.exec);
}

// Pure + testable: the `claude mcp add` argv. Passes `--default-vault <name>`
// when given: with several vaults open the bridge serves the one containing the
// session's directory, and this vault when the session is inside none of them.
// A hard `--vault` pin would hide every other vault from the one registration.
export function registerArgs(bridgePath: string, vaultName?: string): string[] {
  const args = ["mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--", "node", bridgePath];
  if (vaultName) args.push("--default-vault", vaultName);
  return args;
}

export async function claudeRegister(bin: string, bridgePath: string, vaultName?: string): Promise<void> {
  // Claude Code writes its own user config; we only invoke the CLI.
  await pexecFile(bin, registerArgs(bridgePath, vaultName), { env: spawnEnv() });
}

export async function claudeRemove(bin: string): Promise<void> {
  await pexecFile(bin, ["mcp", "remove", MCP_SERVER_NAME], { env: spawnEnv() }).catch(() => { /* ignore if absent */ });
}

// ── #38: auto-provision the vault-mcp-connect Claude Code plugin ──────────────
// The connect plugin (SessionStart health hook + /vault-mcp-status) ships from
// THIS repository's own marketplace (`.claude-plugin/marketplace.json`, named
// `obsidian-mcp-suite` since the repo rename; source packages/host/cc-plugin).
// It used to be provisioned from the nelsonlove/claude-code-plugins catalogue,
// which dropped it at d36b1b1, so that path had been broken since (#409 review).
// The MCP server itself stays a DIRECT `claude mcp add` registration — bundling
// it into a CC plugin would rename the tools to mcp__plugin_*, breaking every
// mcp__vault-mcp__* allowlist reference (decision 2026-07-10; the prefix was
// mcp__governor__* between the 0.12.0 id migration and the S3c wire rename).

export const CONNECT_MARKETPLACE_NAME = "obsidian-mcp-suite";
export const CONNECT_MARKETPLACE_SOURCE = "nelsonlove/obsidian-mcp-suite";
export const CONNECT_PLUGIN_NAME = "vault-mcp-connect";

export function marketplaceAddArgs(): string[] {
  return ["plugin", "marketplace", "add", CONNECT_MARKETPLACE_SOURCE];
}

export function connectInstallArgs(): string[] {
  return ["plugin", "install", `${CONNECT_PLUGIN_NAME}@${CONNECT_MARKETPLACE_NAME}`, "--scope", "user"];
}

export function hasMarketplace(listOutput: string): boolean {
  return listOutput.includes(CONNECT_MARKETPLACE_NAME);
}

export function hasConnectPlugin(listOutput: string): boolean {
  return listOutput.includes(`${CONNECT_PLUGIN_NAME}@`);
}

type ExecLike = (bin: string, args: string[]) => Promise<{ stdout: string }>;

/**
 * Idempotently ensure the marketplace is configured and vault-mcp-connect is
 * installed. Check-first (like claudeIsRegistered) so repeated plugin loads
 * are cheap no-ops. Throws on CLI failure — callers decide how quietly to fail.
 */
export async function claudeEnsureConnectPlugin(
  bin: string,
  opts?: { exec?: ExecLike },
): Promise<"already" | "installed"> {
  const exec: ExecLike = opts?.exec ?? ((b, a) => pexecFile(b, a, { env: spawnEnv() }));

  const markets = await exec(bin, ["plugin", "marketplace", "list"]);
  if (!hasMarketplace(markets.stdout)) {
    await exec(bin, marketplaceAddArgs());
  }
  const plugins = await exec(bin, ["plugin", "list"]);
  if (hasConnectPlugin(plugins.stdout)) return "already";
  await exec(bin, connectInstallArgs());
  return "installed";
}
