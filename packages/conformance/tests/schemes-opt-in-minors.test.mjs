// Follow-ups to #621: the CLI checks the override's scheme rows the way the
// host does, and reads the settings the host adopts from the pre-split
// plugin. Every path, id and expansion here is made up.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cliSchemes } from "../src/kernel/cli.ts";

const JD = [{ id: "jd", provider: "johnny-decimal" }];
const MADE_UP = [{ id: "jd", provider: "johnny-decimal", config: { expandedCategories: ["34"] } }];

async function setup({ data, legacy, override } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "schemes-cli-minors-"));
  const root = path.join(dir, "vault");
  const plug = (id) => path.join(root, ".obsidian", "plugins", id);
  await mkdir(plug("vault-mcp"), { recursive: true });
  if (data !== undefined) await writeFile(path.join(plug("vault-mcp"), "data.json"), JSON.stringify(data));
  if (legacy !== undefined) {
    await mkdir(plug("governor"), { recursive: true });
    await writeFile(path.join(plug("governor"), "data.json"), JSON.stringify(legacy));
  }
  const home = path.join(dir, "home");
  if (override !== undefined) {
    await mkdir(path.join(home, ".claude", "vault-mcp", "local"), { recursive: true });
    await writeFile(path.join(home, ".claude", "vault-mcp", "local", "settings.json"), JSON.stringify(override));
  }
  return { dir, root, home, done: () => rm(dir, { recursive: true, force: true }) };
}

describe("3. the override's rows go through the registry check, as in the host", () => {
  for (const [label, rows] of [
    ["an unknown provider", [{ id: "jd", provider: "no-such-provider" }]],
    ["a config the provider refuses", [{ id: "jd", provider: "johnny-decimal", config: { expandedAreas: "50-59" } }]],
    ["a repeated id", [...JD, ...JD]],
    ["a row that is not an object", ["jd"]],
  ]) {
    test(`${label} is refused loudly`, async () => {
      const s = await setup({ data: { schemes: JD }, override: { schemes: rows } });
      const quiet = console.error;
      console.error = () => {};
      try {
        assert.throws(() => cliSchemes(s.root, {}, s.home), /schemes holds a row the scheme registry does not take/);
      } finally {
        console.error = quiet;
        await s.done();
      }
    });
  }
  test("good rows pass", async () => {
    const s = await setup({ data: { schemes: JD }, override: { schemes: MADE_UP } });
    try {
      assert.deepEqual(cliSchemes(s.root, {}, s.home), MADE_UP);
    } finally {
      await s.done();
    }
  });
});

describe("4. with no data.json of its own, the settings adopted from the pre-split plugin", () => {
  test("the legacy data.json's schemes, or the plain jd row when it has none", async () => {
    for (const [legacy, want] of [[{ schemes: MADE_UP }, MADE_UP], [{ readOnly: true }, JD], [{ schemes: [] }, []]]) {
      const s = await setup({ legacy });
      try {
        assert.deepEqual(cliSchemes(s.root, {}, s.home), want, JSON.stringify(legacy));
      } finally {
        await s.done();
      }
    }
  });
  test("the plugin's own data.json wins over the legacy one", async () => {
    const s = await setup({ data: { schemes: [] }, legacy: { schemes: MADE_UP } });
    try {
      assert.deepEqual(cliSchemes(s.root, {}, s.home), []);
    } finally {
      await s.done();
    }
  });
});
