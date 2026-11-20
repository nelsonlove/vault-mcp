/**
 * read-note-parsed-links.test.mjs — obsidian_read_note_parsed reports every
 * kind of link Obsidian caches, each in its own field.
 *
 * Obsidian keeps body `[[…]]` links in `cache.links`, `![[…]]` transclusions
 * in `cache.embeds`, and links in property values in `cache.frontmatterLinks`.
 * The tool returned only `links`, so a note built from embeds read as if the
 * embedded notes did not exist, and nothing said anything was left out.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { installObsidianStub, TFile } from "./obsidian-stub.mjs";
installObsidianStub();
const { registerComplementaryTools } = await import("../src/mcp/tools-complementary.ts");

function parsedServer(notes, caches) {
  const files = new Map(Object.keys(notes).map((p) => [p, new TFile(p)]));
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getAbstractFileByPath: (p) => files.get(p) ?? null,
      async read(f) { return notes[f.path]; },
      async cachedRead(f) { return notes[f.path]; },
      getName: () => "TestVault",
    },
    metadataCache: {
      getFileCache: (f) => caches[f.path] ?? null,
      getTags: () => ({}),
      unresolvedLinks: {},
    },
    workspace: { getActiveFile: () => null, activeEditor: null, getActiveViewOfType: () => null },
    internalPlugins: { getPluginById: () => null },
    plugins: { plugins: {} },
  };
  const tools = new Map();
  const ctx = {
    pluginVersion: "0.0.0",
    socketPath: "/tmp/x.sock",
    vaultName: "TestVault",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [] }),
  };
  registerComplementaryTools({ registerTool: (name, def, handler) => tools.set(name, handler) }, app, ctx);
  return (path) => tools.get("obsidian_read_note_parsed")({ path }, {});
}

const pos = (line) => ({ start: { line, col: 0, offset: 0 }, end: { line, col: 0, offset: 0 } });

describe("obsidian_read_note_parsed: links, embeds and frontmatter links", () => {
  const content = "---\nup: \"[[Parent]]\"\n---\n# Spec\n\nSee [[Other]].\n\n![[Rule one]]\n\n![[Board.base#Open]]\n";
  const cache = {
    frontmatter: { up: "[[Parent]]" },
    links: [{ link: "Other", displayText: "Other", original: "[[Other]]", position: pos(5) }],
    embeds: [
      { link: "Rule one", displayText: "Rule one", original: "![[Rule one]]", position: pos(7) },
      { link: "Board.base#Open", displayText: "Board.base#Open", original: "![[Board.base#Open]]", position: pos(9) },
    ],
    frontmatterLinks: [{ key: "up", link: "Parent", displayText: "Parent", original: "[[Parent]]" }],
  };

  test("embeds are reported in their own field, with their lines", async () => {
    const res = await parsedServer({ "N.md": content }, { "N.md": cache })("N.md");
    assert.deepEqual(res.structuredContent.embeds, [
      { link: "Rule one", displayText: "Rule one", line: 7 },
      { link: "Board.base#Open", displayText: "Board.base#Open", line: 9 },
    ]);
  });

  test("links stay body links only, as before", async () => {
    const res = await parsedServer({ "N.md": content }, { "N.md": cache })("N.md");
    assert.deepEqual(res.structuredContent.links, [{ link: "Other", displayText: "Other", line: 5 }]);
  });

  test("frontmatter links are reported with their property key", async () => {
    const res = await parsedServer({ "N.md": content }, { "N.md": cache })("N.md");
    assert.deepEqual(res.structuredContent.frontmatterLinks, [{ key: "up", link: "Parent", displayText: "Parent" }]);
  });

  test("the body keeps the embed text: embeds are listed, not expanded", async () => {
    const res = await parsedServer({ "N.md": content }, { "N.md": cache })("N.md");
    assert.match(res.structuredContent.body, /!\[\[Rule one\]\]/);
  });

  test("a note with no cache gives empty lists, never a missing field", async () => {
    const res = await parsedServer({ "N.md": "plain\n" }, {})("N.md");
    assert.deepEqual(res.structuredContent.links, []);
    assert.deepEqual(res.structuredContent.embeds, []);
    assert.deepEqual(res.structuredContent.frontmatterLinks, []);
  });
});
