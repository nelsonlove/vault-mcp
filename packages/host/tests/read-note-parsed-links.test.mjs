/**
 * read-note-parsed-links.test.mjs — obsidian_read_note_parsed reports body
 * links, embeds and frontmatter links, each in its own field.
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
  const content = "---\nup: \"[[Parent]]\"\nrelated:\n  - \"[[A]]\"\n  - \"[[B]]\"\n---\n# Spec\n\nSee [[Other]].\n\n![[Rule one]]\n\n![[Board.base#Open]]\n";
  const cache = {
    frontmatter: { up: "[[Parent]]", related: ["[[A]]", "[[B]]"] },
    links: [{ link: "Other", displayText: "Other", original: "[[Other]]", position: pos(8) }],
    embeds: [
      { link: "Rule one", displayText: "", original: "![[Rule one]]", position: pos(10) },
      { link: "Board.base#Open", displayText: "", original: "![[Board.base#Open]]", position: pos(12) },
    ],
    // Obsidian keys a list item by its path: `related.0`, `related.1`.
    frontmatterLinks: [
      { key: "up", link: "Parent", displayText: "Parent", original: "[[Parent]]" },
      { key: "related.0", link: "A", displayText: "A", original: "[[A]]" },
      { key: "related.1", link: "B", displayText: "B", original: "[[B]]" },
    ],
  };

  test("embeds are reported in their own field, with their lines", async () => {
    const res = await parsedServer({ "N.md": content }, { "N.md": cache })("N.md");
    assert.deepEqual(res.structuredContent.embeds, [
      { link: "Rule one", displayText: "", line: 10 },
      { link: "Board.base#Open", displayText: "", line: 12 },
    ]);
  });

  test("links stay body links only, as before", async () => {
    const res = await parsedServer({ "N.md": content }, { "N.md": cache })("N.md");
    assert.deepEqual(res.structuredContent.links, [{ link: "Other", displayText: "Other", line: 8 }]);
  });

  test("frontmatter links are reported with their property path, list items indexed", async () => {
    const res = await parsedServer({ "N.md": content }, { "N.md": cache })("N.md");
    assert.deepEqual(res.structuredContent.frontmatterLinks, [
      { key: "up", link: "Parent", displayText: "Parent" },
      { key: "related.0", link: "A", displayText: "A" },
      { key: "related.1", link: "B", displayText: "B" },
    ]);
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
