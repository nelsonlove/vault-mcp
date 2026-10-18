import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeEnv } from "../bridge-env.js";

test("the bridge gets the SDK's default environment plus the variables it finds its vault by", () => {
  const env = bridgeEnv({ VAULT_MCP_STATE_DIR: "/srv/state", VAULT_MCP_VAULT: "vmh", SECRET_TOKEN: "x" });
  assert.equal(env.VAULT_MCP_STATE_DIR, "/srv/state");
  assert.equal(env.VAULT_MCP_VAULT, "vmh");
  assert.equal(env.SECRET_TOKEN, undefined, "nothing else is passed on");
  assert.equal(env.PATH, process.env.PATH, "the SDK default list is kept");
});

test("an unset or empty variable is not passed on", () => {
  const env = bridgeEnv({ VAULT_MCP_STATE_DIR: "  " });
  assert.equal(env.VAULT_MCP_STATE_DIR, undefined);
});

test("both places that start a bridge pass bridgeEnv(), with the session's profile (#521)", async () => {
  const fs = await import("node:fs");
  for (const f of ["live-proxy.ts", "semantic-proxy.ts"]) {
    const src = fs.readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");
    const spawns = src.split("new StdioClientTransport(").slice(1);
    assert.ok(spawns.length > 0, `${f} starts no bridge?`);
    for (const s of spawns) assert.match(s.slice(0, 400), /env:\s*bridgeEnv\(process\.env, \{ profile: [\w.]+ \}\)/, `${f}: a bridge started without bridgeEnv() and its profile`);
  }
});
