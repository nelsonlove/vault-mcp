import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegisterCommand } from "../src/register-command.ts";
import { MCP_SERVER_NAME } from "../src/claude-cli.ts";

test("generic command omits --vault", () => {
  assert.equal(
    buildRegisterCommand({ bridgePath: "/p/bridge.mjs" }),
    "claude mcp add --scope user vault-mcp -- node /p/bridge.mjs"
  );
});

test("named command appends --default-vault, quoting spaces", () => {
  assert.equal(
    buildRegisterCommand({ bridgePath: "/p/bridge.mjs", vaultName: "My Vault" }),
    "claude mcp add --scope user vault-mcp -- node /p/bridge.mjs --default-vault 'My Vault'"
  );
});

// The paste-by-hand command and `registerArgs` must name the SAME server, or an
// operator who uses the fallback ends up with a second entry under a different
// name. They drifted at the S3c wire rename because each spelled the name
// itself; the command now imports the constant, and this pins that it does.
test("the manual command names MCP_SERVER_NAME, not a second literal", () => {
  const cmd = buildRegisterCommand({ bridgePath: "/p/bridge.mjs" });
  assert.match(cmd, new RegExp(`--scope user ${MCP_SERVER_NAME} --`));
  assert.ok(!/\bgovernor\b/.test(cmd), `the retired server name must not survive here: ${cmd}`);
});
