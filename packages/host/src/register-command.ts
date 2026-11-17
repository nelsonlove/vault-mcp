// The server name is imported rather than spelled again: this command is the
// paste-by-hand twin of `registerArgs`, and a second literal is how the two
// drifted apart at the S3c wire rename (`registerArgs` moved, this did not).
import { MCP_SERVER_NAME } from "./claude-cli.js";

function shellQuote(s: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// Generic by default (single vault auto-selects). vaultName only for the
// multi-vault case, where it appends `--vault <name>`.
export function buildRegisterCommand(opts: { bridgePath: string; vaultName?: string }): string {
  const base = `claude mcp add --scope user ${MCP_SERVER_NAME} -- node ${shellQuote(opts.bridgePath)}`;
  return opts.vaultName ? `${base} --default-vault ${shellQuote(opts.vaultName)}` : base;
}
