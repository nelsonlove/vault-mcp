import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeEnv } from "../bridge-env.js";

test("the bridge gets the SDK's default environment plus the variables it finds its vault by", () => {
  const env = bridgeEnv({ VAULT_MCP_STATE_DIR: "/srv/state", VAULT_MCP_VAULT: "vmh", SECRET_TOKEN: "x" });
  assert.equal(env.VAULT_MCP_STATE_DIR, "/srv/state");
  assert.equal(env.VAULT_MCP_VAULT, "vmh");
  assert.equal(env.SECRET_TOKEN, undefined, "nothing else is passed on");
  assert.ok("PATH" in env || "HOME" in env, "the SDK default list is kept");
});

test("an unset or empty variable is not passed on", () => {
  const env = bridgeEnv({ VAULT_MCP_STATE_DIR: "  " });
  assert.equal(env.VAULT_MCP_STATE_DIR, undefined);
});
