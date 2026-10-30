// Schemes are opt-in (01.33 "Move the scheme tools out of vault-mcp core",
// pick A, step b): with no scheme configured the rail runs no scheme check;
// the in-app sources measure the host's configured schemes; the CLI finds them
// where the host does. Every path, id and expansion here is made up.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runConformance, cliSchemes, LOCAL_SETTINGS_ENV } from "../src/kernel/cli.ts";
import { SCHEME_PACK_ID } from "../src/kernel/packs/scheme.ts";
import { obsidianDebtSource } from "../src/obsidian-debt-source.ts";
import { hostSchemes } from "../src/host-lookup.ts";
import { EMPTY_VAULT_CONVENTIONS } from "../src/kernel/vault-conventions.ts";
import { DEFAULT_SCHEMES } from "@vault-mcp/core";

const JD = [{ id: "jd", provider: "johnny-decimal" }];
const MADE_UP = [{ id: "jd", provider: "johnny-decimal", config: { expandedAreas: ["50-59"], expandedCategories: ["34"] } }];

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "schemes-opt-in-"));
  await mkdir(path.join(root, "Notes"), { recursive: true });
  // No address in the name: an unaddressed note to a JD scheme.
  await writeFile(path.join(root, "Notes", "loose.md"), "---\ntitle: loose\n---\nbody\n");
  // A 5-digit name: malformed with no expansion, an item with the made-up one.
  await mkdir(path.join(root, "30-39 Home", "34 Garden"), { recursive: true });
  await writeFile(path.join(root, "30-39 Home", "34 Garden", "34001 Seeds.md"), "---\ntitle: Seeds\n---\n");
  return root;
}
const run = (root, schemes) => runConformance({ root, baselineText: "", vocabularies: [], schemes, legacyPacks: false, conventions: { ...EMPTY_VAULT_CONVENTIONS } });
const schemeFindings = (res) => res.findings.filter((f) => f.pack === SCHEME_PACK_ID || f.script === SCHEME_PACK_ID);

describe("the rail with no scheme", () => {
  test("the default (no scheme) runs no scheme pack and gives no scheme finding", async () => {
    const root = await vault();
    try {
      const res = await run(root, DEFAULT_SCHEMES);
      assert.deepEqual(schemeFindings(res), []);
      assert.ok(!res.coveredPackIds.includes(SCHEME_PACK_ID), "the scheme pack did not run");
      const withJd = await run(root, JD);
      assert.ok(withJd.coveredPackIds.includes(SCHEME_PACK_ID));
      assert.ok(schemeFindings(withJd).length > 0, "fixture: a JD scheme does find the unaddressed note");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a scheme's expansions change what it finds", async () => {
    const root = await vault();
    try {
      const plain = schemeFindings(await run(root, JD)).filter((f) => f.target.includes("34001"));
      const expanded = schemeFindings(await run(root, MADE_UP)).filter((f) => f.target.includes("34001"));
      assert.ok(plain.length > expanded.length, "the 5-digit name is a finding only without the expansion");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("in-app: a baseline that holds scheme debt refuses when no scheme is configured, never reads as CLEARED", async () => {
    const root = await vault();
    const rel = "Records/Conformance baseline.md";
    try {
      const withJd = await run(root, JD);
      await mkdir(path.join(root, "Records"), { recursive: true });
      await writeFile(path.join(root, rel), "```ratchet-baseline\n" + withJd.rebaseline + "\n```\n");
      const conv = () => ({ ...EMPTY_VAULT_CONVENTIONS, baselineRel: rel });
      const none = obsidianDebtSource({ vault: { adapter: { basePath: root } } }, () => [], conv, () => []);
      await assert.rejects(() => none.liveFindings(), new RegExp(`accepted debt for ${SCHEME_PACK_ID}, which did not run`));
      const jd = obsidianDebtSource({ vault: { adapter: { basePath: root } } }, () => [], conv, () => JD);
      assert.ok((await jd.liveFindings()).length > 0, "the host's schemes reach the run");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("hostSchemes — the host's configured rows, as it holds them", () => {
  test("a loaded host's schemes; no host, a host not ready, or a non-list: none", () => {
    assert.deepEqual(hostSchemes({ "vault-mcp": { api: {}, settings: { schemes: MADE_UP } } }), MADE_UP);
    assert.deepEqual(hostSchemes({}), []);
    assert.deepEqual(hostSchemes({ "vault-mcp": { api: {} } }), [], "settings not assigned yet");
    assert.deepEqual(hostSchemes({ "vault-mcp": { api: {}, settings: { schemes: "jd" } } }), []);
    assert.deepEqual(hostSchemes({ "vault-mcp": { settings: { schemes: JD } } }), [], "a plugin without the api is not the host");
  });
});

describe("cliSchemes — where the CLI finds the host's schemes", () => {
  async function setup({ data, override } = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), "schemes-cli-"));
    const root = path.join(dir, "vault");
    await mkdir(path.join(root, ".obsidian", "plugins", "vault-mcp"), { recursive: true });
    if (data !== undefined) await writeFile(path.join(root, ".obsidian", "plugins", "vault-mcp", "data.json"), JSON.stringify(data));
    const home = path.join(dir, "home");
    if (override !== undefined) {
      await mkdir(path.join(home, ".claude", "vault-mcp", "local"), { recursive: true });
      await writeFile(path.join(home, ".claude", "vault-mcp", "local", "settings.json"), typeof override === "string" ? override : JSON.stringify(override));
    }
    return { dir, root, home };
  }

  test("the host's data.json by the host's load rule", async () => {
    for (const [data, want] of [[undefined, []], [{ readOnly: false }, JD], [{ schemes: [] }, []], [{ schemes: MADE_UP }, MADE_UP]]) {
      const s = await setup({ data });
      try {
        assert.deepEqual(cliSchemes(s.root, {}, s.home), want, JSON.stringify(data));
      } finally {
        await rm(s.dir, { recursive: true, force: true });
      }
    }
  });

  test("the machine-local override's schemes win over the data.json, at the host's default path or the one the variables name", async () => {
    const s = await setup({ data: { schemes: JD }, override: { schemes: MADE_UP } });
    try {
      assert.deepEqual(cliSchemes(s.root, {}, s.home), MADE_UP);
      const named = path.join(s.home, ".claude", "vault-mcp", "local", "settings.json");
      assert.deepEqual(cliSchemes(s.root, { [LOCAL_SETTINGS_ENV]: named }, "/nowhere"), MADE_UP);
      assert.deepEqual(cliSchemes(s.root, { VAULT_MCP_STATE_DIR: path.join(s.home, ".claude", "vault-mcp") }, "/nowhere"), MADE_UP);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  test("an override without schemes leaves the data.json's", async () => {
    const s = await setup({ data: { schemes: JD }, override: { readOnly: true } });
    try {
      assert.deepEqual(cliSchemes(s.root, {}, s.home), JD);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
  });

  test("an override that cannot be used fails closed, as in the host", async () => {
    const s = await setup({ data: { schemes: JD }, override: "{ not json" });
    try {
      assert.throws(() => cliSchemes(s.root, {}, s.home), /not valid JSON/);
      assert.throws(() => cliSchemes(s.root, { [LOCAL_SETTINGS_ENV]: path.join(s.dir, "missing.json") }, s.home), /there is no file there/);
      assert.throws(() => cliSchemes(s.root, { [LOCAL_SETTINGS_ENV]: "relative.json" }, s.home), /must be an absolute path/);
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
    const t = await setup({ data: { schemes: JD }, override: { schemes: { id: "jd" } } });
    try {
      assert.throws(() => cliSchemes(t.root, {}, t.home), /schemes must be a list/);
    } finally {
      await rm(t.dir, { recursive: true, force: true });
    }
  });
});
