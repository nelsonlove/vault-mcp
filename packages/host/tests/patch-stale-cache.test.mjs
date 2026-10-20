/**
 * patch-stale-cache.test.mjs — a patch never writes at a stale cache offset (#593).
 *
 * The live host's `patchNote` and `obsidian_append_at_heading` read the note
 * with `vault.read` and used to take heading and block offsets from
 * `metadataCache.getFileCache`. After a write the cache describes the
 * previous text until Obsidian parses the file again, so a second patch
 * soon after the first sliced the new text at the old offsets: it cut a
 * table row, dropped a heading and left a duplicated tail.
 *
 * The fake app here keeps a cache per note that is made only when a test
 * asks for it (`reparse`), never on `modify`. So the cache is stale on
 * purpose after every write, as Obsidian's is for a moment. The REAL
 * ObsidianBackend and the REAL obsidian_append_at_heading handler run over
 * it. The cache is built by a small, independent reader in this file (ATX
 * headings outside ``` and ~~~ fences, `^id` blocks at a paragraph's end),
 * not by the parser under test.
 *
 * The note text is made up.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile } from "./obsidian-stub.mjs";

installObsidianStub();
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { registerComplementaryTools } = await import("../src/mcp/tools-complementary.ts");

// ── an independent stand-in for Obsidian's metadata cache ───────────────────

/** Headings (ATX, outside fences, after front matter) and paragraph blocks
 *  ending in `^id`, with Obsidian's offset shape. */
function parseCache(text) {
  const headings = [];
  const blocks = {};
  const lines = text.split("\n");
  let off = 0;
  let fence = null;
  let i = 0;
  const starts = [];
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  if (lines[0] === "---") {
    i = 1;
    while (i < lines.length && lines[i] !== "---") i++;
    i++;
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = /^(`{3,}|~{3,})/.exec(l);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && l.trim() === f[1]) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const m = /^(#{1,6}) (.*)$/.exec(l);
    if (m) {
      headings.push({ heading: m[2].trim(), level: m[1].length, position: { start: { line: i, offset: starts[i] }, end: { line: i, offset: starts[i] + l.length } } });
      continue;
    }
    const b = /\s\^([a-z0-9-]+)$/i.exec(l);
    // Obsidian takes a block id only at the end of its paragraph.
    if (b && (i + 1 >= lines.length || lines[i + 1].trim() === "")) {
      let s = i;
      while (s > 0 && lines[s - 1].trim() !== "" && !/^#/.test(lines[s - 1])) s--;
      blocks[b[1].toLowerCase()] = { id: b[1], position: { start: { line: s, offset: starts[s] }, end: { line: i, offset: starts[i] + l.length } } };
    }
  }
  return { headings, blocks };
}

function fakeApp(files) {
  const store = new Map(Object.entries(files));
  const caches = new Map();
  const reparse = (p) => caches.set(p, parseCache(store.get(p)));
  for (const p of store.keys()) reparse(p);
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (store.has(p) ? new TFile(p, 1700) : null),
      read: async (f) => store.get(f.path),
      cachedRead: async (f) => store.get(f.path),
      // The cache is NOT refreshed on a write: that is the race under test.
      modify: async (f, c) => { store.set(f.path, c); },
      append: async (f, c) => { store.set(f.path, store.get(f.path) + c); },
      create: async (p, c) => { store.set(p, c); },
      createFolder: async () => {},
      getMarkdownFiles: () => [...store.keys()].map((p) => new TFile(p, 1700)),
    },
    metadataCache: {
      resolvedLinks: {},
      getFileCache: (f) => caches.get(f.path) ?? null,
    },
    fileManager: { processFrontMatter: async () => {} },
  };
  return { app, store, reparse, caches };
}

/** Equal, or fail naming the first differing offset (the notes are large). */
function sameText(actual, expected, msg) {
  if (actual === expected) return;
  let i = 0;
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++;
  assert.fail(`${msg ?? "texts differ"} at offset ${i} (lengths ${actual.length} and ${expected.length}): got ${JSON.stringify(actual.slice(Math.max(0, i - 40), i + 80))}, want ${JSON.stringify(expected.slice(Math.max(0, i - 40), i + 80))}`);
}

/** The pre-#593 placement, over whatever cache it is given: the reference
 *  for "a fresh cache gives the same bytes as before". */
function oldPatch(text, cache, anchor, op, content) {
  let start, end;
  if (anchor.type === "heading") {
    const hs = cache.headings;
    const idx = hs.findIndex((h) => h.heading === anchor.value);
    if (idx < 0) return null;
    start = hs[idx].position.end.offset;
    end = text.length;
    for (let j = idx + 1; j < hs.length; j++) if (hs[j].level <= hs[idx].level) { end = hs[j].position.start.offset; break; }
  } else {
    const b = cache.blocks[anchor.value];
    if (!b) return null;
    start = b.position.start.offset;
    end = b.position.end.offset;
  }
  if (op === "replace") return text.slice(0, start) + (anchor.type === "heading" ? `\n\n${content}\n` : content) + text.slice(end);
  if (op === "prepend") return text.slice(0, start) + (anchor.type === "heading" ? `\n\n${content}` : `${content}\n`) + text.slice(start);
  const head = text.slice(0, end).replace(/\n*$/, "\n");
  const tail = text.slice(end);
  return head + content + (tail.length === 0 || tail.startsWith("\n") ? "\n" : "\n\n") + tail;
}

// ── fixtures ────────────────────────────────────────────────────────────────

const FM = "---\ntitle: Sample script note\ntags: [example]\n---\n";

function bigJs(lines) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(i % 50 === 0 ? `# shell-style comment line ${i}, not a heading` : `const value${i} = compute(${i}); // step ${i} of the sample`);
  }
  return out.join("\n");
}

const PARTS = {
  intro: "# Sample script note\n\n",
  overview: "## Overview\n\nPlain words about what the sample does.\n\n```text {tangle=\"no\"}\n# a text fence line, not a heading\n```\n\n",
  table: "## Steps\n\n| Step | What it does |\n| --- | --- |\n| 1 | reads the note |\n| 2 | checks the fields |\n| 3 | writes the answer |\n\n",
  refuses: "## What it refuses\n\n- a note without a title\n- a note in an archive\n\n",
  impl: `## Implementation\n\n\`\`\`js\n${bigJs(1500)}\n\`\`\`\n\n`,
  notes: "## Notes\n\nA short paragraph to anchor on. ^note-a\n\n",
  history: "## History\n\n- 2026-01-01 made\n\n",
  related: "## Related\n\n- [[Other note]]\n",
};
const NOTE = FM + Object.values(PARTS).join("");

const R1 = "- a note without a title\n- a note in an archive\n- a note whose path names no folder\n- a note that is longer than the read limit and was cut";
const R2 = "```js\nconst replaced = true;\n# still not a heading\n```";

describe("patchNote with a stale cache", () => {
  test("the fixture is large and its fences hide # lines (sanity)", () => {
    assert.ok(NOTE.length > 50_000, `note is ${NOTE.length} chars`);
    const cache = parseCache(NOTE);
    assert.deepEqual(cache.headings.map((h) => h.heading), ["Sample script note", "Overview", "Steps", "What it refuses", "Implementation", "Notes", "History", "Related"]);
  });

  test("two heading replaces back to back give exactly the bytes of two fresh patches (the repro shape)", async () => {
    const { app, store } = fakeApp({ "S.md": NOTE });
    const backend = new ObsidianBackend(app);
    const r1 = await backend.patchNote("S.md", { type: "heading", value: "What it refuses" }, "replace", R1);
    assert.equal(r1.found, true);
    // No reparse: the cache still describes NOTE.
    const r2 = await backend.patchNote("S.md", { type: "heading", value: "Implementation" }, "replace", R2);
    assert.equal(r2.found, true);
    assert.equal(r2.previous, PARTS.impl.slice("## Implementation".length), "the section read back is the live one");
    const expected = FM + PARTS.intro + PARTS.overview + PARTS.table +
      `## What it refuses\n\n${R1}\n` +
      `## Implementation\n\n${R2}\n` +
      PARTS.notes + PARTS.history + PARTS.related;
    sameText(store.get("S.md"), expected);
  });

  test("a stale cache gives the same bytes as a fresh one, op by op", async () => {
    const ops = [
      [{ type: "heading", value: "Steps" }, "replace", "| Step | What |\n| --- | --- |\n| 1 | only |"],
      [{ type: "block", value: "note-a" }, "replace", "A new anchored paragraph. ^note-a"],
      [{ type: "heading", value: "Notes" }, "append", "Appended line."],
      [{ type: "heading", value: "History" }, "prepend", "- 2026-02-02 changed"],
      [{ type: "heading", value: "Related" }, "append", "- [[Third note]]"],
    ];
    const stale = fakeApp({ "S.md": NOTE });
    const fresh = fakeApp({ "S.md": NOTE });
    const staleBackend = new ObsidianBackend(stale.app);
    const freshBackend = new ObsidianBackend(fresh.app);
    // A first write makes the stale app's cache stale for every op after it.
    await staleBackend.patchNote("S.md", { type: "heading", value: "What it refuses" }, "replace", R1);
    await freshBackend.patchNote("S.md", { type: "heading", value: "What it refuses" }, "replace", R1);
    fresh.reparse("S.md");
    for (const [anchor, op, content] of ops) {
      const a = await staleBackend.patchNote("S.md", anchor, op, content);
      const b = await freshBackend.patchNote("S.md", anchor, op, content);
      fresh.reparse("S.md");
      assert.equal(a.found, true, `${op} at ${anchor.value} found`);
      assert.equal(b.found, true);
      sameText(stale.store.get("S.md"), fresh.store.get("S.md"), `${op} at ${anchor.value}: stale and fresh differ`);
    }
  });

  test("a fresh cache gives exactly the pre-#593 bytes", async () => {
    const cases = [
      [{ type: "heading", value: "Overview" }, "replace", "New overview."],
      [{ type: "heading", value: "Implementation" }, "append", "After the code."],
      [{ type: "heading", value: "Sample script note" }, "prepend", "Lead line."],
      [{ type: "heading", value: "Related" }, "replace", "- [[Only link]]"],
      [{ type: "block", value: "note-a" }, "prepend", "Before the block."],
      [{ type: "block", value: "note-a" }, "append", "After the block."],
    ];
    for (const [anchor, op, content] of cases) {
      const { app, store, caches } = fakeApp({ "S.md": NOTE });
      const want = oldPatch(NOTE, caches.get("S.md"), anchor, op, content);
      const r = await new ObsidianBackend(app).patchNote("S.md", anchor, op, content);
      assert.equal(r.found, true);
      sameText(store.get("S.md"), want, `${op} at ${anchor.value}`);
    }
  });

  test("a # line inside a fence is not a heading when the cache is stale", async () => {
    const text = "# Doc\n\n## Setup\n\n```sh\n# install the tool\nmake install\n```\n\nAfter the fence.\n\n## Use\n\nRun it.\n";
    const { app, store } = fakeApp({ "D.md": text });
    const backend = new ObsidianBackend(app);
    await backend.patchNote("D.md", { type: "heading", value: "Doc" }, "prepend", "Intro line.");
    // Stale now. "install the tool" must not be found, and Setup's section
    // must run past the fence to "## Use".
    const miss = await backend.patchNote("D.md", { type: "heading", value: "install the tool" }, "replace", "x");
    assert.equal(miss.found, false);
    const r = await backend.patchNote("D.md", { type: "heading", value: "Setup" }, "replace", "Setup replaced.");
    assert.equal(r.found, true);
    assert.equal(store.get("D.md"), "# Doc\n\nIntro line.\n\n## Setup\n\nSetup replaced.\n## Use\n\nRun it.\n");
  });

  test("a heading that appears twice: the first one is patched, with a stale cache too", async () => {
    const text = "# Log\n\n## Entry\n\nfirst body\n\n## Entry\n\nsecond body\n";
    const { app, store } = fakeApp({ "L.md": text });
    const backend = new ObsidianBackend(app);
    await backend.patchNote("L.md", { type: "heading", value: "Entry" }, "replace", "first, once more and longer");
    await backend.patchNote("L.md", { type: "heading", value: "Entry" }, "append", "and a tail");
    assert.equal(store.get("L.md"), "# Log\n\n## Entry\n\nfirst, once more and longer\nand a tail\n\n## Entry\n\nsecond body\n");
  });

  test("a block patch after a write that moved the block", async () => {
    const text = "# B\n\nLead paragraph.\n\nThe anchored line. ^blk\n\nTail.\n";
    const { app, store } = fakeApp({ "B.md": text });
    const backend = new ObsidianBackend(app);
    await backend.patchNote("B.md", { type: "heading", value: "B" }, "prepend", "A much longer first line that moves every offset after it.");
    const r = await backend.patchNote("B.md", { type: "block", value: "blk" }, "replace", "Replaced anchored line. ^blk");
    assert.equal(r.found, true);
    assert.equal(r.previous, "The anchored line. ^blk");
    assert.equal(store.get("B.md"), "# B\n\nA much longer first line that moves every offset after it.\n\nLead paragraph.\n\nReplaced anchored line. ^blk\n\nTail.\n");
  });

  test("a note the cache has not read yet is patched from its text", async () => {
    const { app, store, caches } = fakeApp({ "N.md": "# New\n\n## Part\n\nbody\n" });
    caches.delete("N.md");
    const r = await new ObsidianBackend(app).patchNote("N.md", { type: "heading", value: "Part" }, "replace", "new body");
    assert.equal(r.found, true);
    assert.equal(store.get("N.md"), "# New\n\n## Part\n\nnew body\n");
  });
});

describe("obsidian_append_at_heading with a stale cache", () => {
  function appendTool(app) {
    const handlers = new Map();
    const server = { registerTool(name, _meta, handler) { handlers.set(name, handler); } };
    registerComplementaryTools(server, app, { getSettings: () => ({ allowlist: [] }) });
    return (args) => handlers.get("obsidian_append_at_heading")(args, {});
  }

  test("appends at the end of the live section, not at a cached offset", async () => {
    const { app, store } = fakeApp({ "S.md": NOTE });
    const backend = new ObsidianBackend(app);
    await backend.patchNote("S.md", { type: "heading", value: "What it refuses" }, "replace", R1);
    const call = appendTool(app);
    const res = await call({ path: "S.md", heading: "History", content: "- 2026-03-03 appended", create_if_missing: false });
    assert.equal(res.isError, undefined, JSON.stringify(res));
    assert.equal(res.structuredContent.found, true);
    const expected = FM + PARTS.intro + PARTS.overview + PARTS.table +
      `## What it refuses\n\n${R1}\n` + PARTS.impl + PARTS.notes +
      "## History\n\n- 2026-01-01 made\n- 2026-03-03 appended\n\n" + PARTS.related;
    sameText(store.get("S.md"), expected);
  });

  test("a heading written since the cache was made is found", async () => {
    const { app, store } = fakeApp({ "A.md": "# A\n\nbody\n" });
    await new ObsidianBackend(app).patchNote("A.md", { type: "heading", value: "A" }, "append", "## Added\n\nadded body");
    const res = await appendTool(app)({ path: "A.md", heading: "Added", content: "more", create_if_missing: false });
    assert.equal(res.structuredContent.found, true);
    assert.equal(store.get("A.md"), "# A\n\nbody\n## Added\n\nadded body\nmore\n");
  });
});
