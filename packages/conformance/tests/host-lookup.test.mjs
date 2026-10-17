// host-lookup.test.mjs — "which loaded plugin is the Vault MCP host?"
//
// THIS IS THE SATELLITES' ONE BEHAVIOURAL TEST OF THE HOST LOOKUP, and the
// coverage choice is deliberate. All nine satellites carried the same defect
// (the release review's F4): the pre-split id order `["governor", "vault-mcp"]`
// plus a bare-presence match, which post-split resolves the governance PROVIDER
// as if it were the host. Nine identical suites would be nine copies of one
// assertion, so the pin lives in one package and the others carry the same two
// lines inline with a pointer here.
//
// The pin lived in `packages/crosssession` until that satellite was retired on
// 2026-10-15 (Nelson's verify of "Retire vaultmcp-crosssession"). It moved here
// unchanged in substance: `src/host-lookup.ts` in this package is the same
// lookup, except that it answers `null` rather than `undefined` for "no host".
import { test } from "node:test";
import assert from "node:assert/strict";
import { findHostPlugin, HOST_PLUGIN_IDS } from "../src/host-lookup.ts";

/** The host in the plugins map: an api object (present from construction). */
const host = (extra = {}) => ({ api: { apiVersion: 1, registerTools() {} }, manifest: { dir: ".obsidian/plugins/vault-mcp" }, ...extra });
/** The governance provider in the plugins map: no api at all. */
const provider = () => ({ settings: { config: { channel: "wrong" } }, manifest: { dir: ".obsidian/plugins/governor" } });

test("the id list is CURRENT FIRST, matching vault-mcp-api's order", () => {
  // It was ["governor", "vault-mcp"] until the S3c release fix.
  assert.deepEqual([...HOST_PLUGIN_IDS], ["vault-mcp", "governor"]);
});

test("finds the post-split host under `vault-mcp`", () => {
  const found = findHostPlugin({ "vault-mcp": host() });
  assert.equal(found.manifest.dir, ".obsidian/plugins/vault-mcp");
});

test("THE PROVIDER IS NOT THE HOST — a `governor` entry with no api is skipped", () => {
  // The ordinary post-split vault. Before the fix this returned the PROVIDER,
  // so settings adoption would have read the provider's config as the host's.
  const plugins = { governor: provider(), "vault-mcp": host() };
  assert.equal(findHostPlugin(plugins).manifest.dir, ".obsidian/plugins/vault-mcp");
});

test("provider loaded and NO host ⇒ null, so adoption retries next load", () => {
  assert.equal(findHostPlugin({ governor: provider() }), null);
});

test("a pre-split host still living under `governor` IS a host — it exposes the api", () => {
  // The rollback vault: the single-plugin build reinstalled under the old id.
  const found = findHostPlugin({ governor: host({ manifest: { dir: ".obsidian/plugins/governor" } }) });
  assert.equal(found.manifest.dir, ".obsidian/plugins/governor");
});

test("the CURRENT host wins when a stale pre-split host is loaded too", () => {
  const plugins = {
    governor: host({ manifest: { dir: ".obsidian/plugins/governor" } }),
    "vault-mcp": host(),
  };
  assert.equal(findHostPlugin(plugins).manifest.dir, ".obsidian/plugins/vault-mcp");
});

test("no plugins map, empty map, and a falsy api are all 'no host'", () => {
  assert.equal(findHostPlugin(undefined), null);
  assert.equal(findHostPlugin({}), null);
  for (const api of [undefined, null, 0, "", false]) {
    assert.equal(findHostPlugin({ "vault-mcp": { api, settings: {} } }), null);
  }
});

test("a host mid-onload (api present, settings not yet assigned) IS found here", () => {
  // The lookup's job is only "who is the host". `settings === undefined` is the
  // CALLER's readiness question — an adoption latch must read it as "not ready"
  // and retry next load, rather than burning its one-shot latch on nothing.
  const found = findHostPlugin({ "vault-mcp": { api: { apiVersion: 1 } } });
  assert.ok(found);
  assert.equal(found.settings, undefined);
});
