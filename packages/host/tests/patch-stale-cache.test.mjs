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
const { structureTiming } = await import("../src/mcp/note-structure.ts");
// A missing reading waits for the cache this long here, not 2 s.
structureTiming.cacheWaitMs = 60;

// ── an independent stand-in for Obsidian's metadata cache ───────────────────

/** Headings (ATX, outside fences, after front matter) and paragraph blocks
 *  ending in `^id`, with Obsidian's offset shape. */
function parseCache(text) {
  const headings = [];
  const blocks = {};
  // Offsets end before a CRLF line's \r, as Obsidian's do.
  const raw = text.split("\n");
  const lines = raw.map((l) => l.replace(/\r$/, ""));
  let off = 0;
  let fence = null;
  let i = 0;
  const starts = [];
  for (const l of raw) { starts.push(off); off += l.length + 1; }
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
    const b = /(?:^|\s)\^([a-z0-9-]+)$/i.exec(l);
    // An id alone on its line after a blank line goes to the block above
    // (Obsidian moves a lone blockid onto the previous section).
    if (b && l.trim() === `^${b[1]}` && i > 0 && lines[i - 1].trim() === "") {
      let e = i - 1;
      while (e > 0 && lines[e].trim() === "") e--;
      let s = e;
      while (s > 0 && lines[s - 1].trim() !== "" && !/^#/.test(lines[s - 1])) s--;
      blocks[b[1].toLowerCase()] = { id: b[1], position: { start: { line: s, offset: starts[s] }, end: { line: e, offset: starts[e] + lines[e].length } } };
      continue;
    }
    // Obsidian takes a block id only at the end of its paragraph.
    if (b && (i + 1 >= lines.length || lines[i + 1].trim() === "")) {
      let s = i;
      while (s > 0 && lines[s - 1].trim() !== "" && !/^#/.test(lines[s - 1])) s--;
      blocks[b[1].toLowerCase()] = { id: b[1], position: { start: { line: s, offset: starts[s] }, end: { line: i, offset: starts[i] + l.length } } };
    }
  }
  return { headings, blocks, sections: [] };
}

/**
 * `obsidianParse` (default true) gives the metadata cache a
 * `computeMetadataAsync` that parses a buffer the way the stored cache was
 * made, as Obsidian's does; `parse` replaces that reading. With it false the
 * host can only check the cache. `changedAfterWrite` (ms) re-parses a note
 * that long after a write and fires the cache's "changed" event, as Obsidian
 * does; without it the cache stays stale.
 */
function fakeApp(files, { obsidianParse = true, parse = parseCache, changedAfterWrite = null } = {}) {
  const store = new Map(Object.entries(files));
  const caches = new Map();
  const listeners = new Set();
  const reparse = (p) => caches.set(p, parseCache(store.get(p)));
  for (const p of store.keys()) reparse(p);
  const written = (p) => {
    if (changedAfterWrite === null) return;
    setTimeout(() => { reparse(p); for (const cb of listeners) cb({ path: p }); }, changedAfterWrite);
  };
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (store.has(p) ? new TFile(p, 1700) : null),
      read: async (f) => store.get(f.path),
      cachedRead: async (f) => store.get(f.path),
      // The cache is NOT refreshed on a write: that is the race under test.
      modify: async (f, c) => { store.set(f.path, c); written(f.path); },
      // As Obsidian's: read, run, write, with no other write in between.
      process: async (f, fn) => { const n = fn(store.get(f.path)); store.set(f.path, n); written(f.path); return n; },
      append: async (f, c) => { store.set(f.path, store.get(f.path) + c); written(f.path); },
      create: async (p, c) => { store.set(p, c); },
      createFolder: async () => {},
      getMarkdownFiles: () => [...store.keys()].map((p) => new TFile(p, 1700)),
    },
    metadataCache: {
      resolvedLinks: {},
      getFileCache: (f) => caches.get(f.path) ?? null,
      on: (name, cb) => { if (name === "changed") listeners.add(cb); return cb; },
      offref: (ref) => { listeners.delete(ref); },
      ...(obsidianParse ? { computeMetadataAsync: async (buf) => parse(new TextDecoder().decode(buf)) } : {}),
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

describe("review round 1 of #596", () => {
  async function staleVsFresh(text, anchor, op, content) {
    const stale = fakeApp({ "R.md": text });
    const fresh = fakeApp({ "R.md": text });
    const lead = "A longer first line that moves every offset after it.";
    await new ObsidianBackend(stale.app).patchNote("R.md", { type: "heading", value: "H" }, "prepend", lead);
    await new ObsidianBackend(fresh.app).patchNote("R.md", { type: "heading", value: "H" }, "prepend", lead);
    fresh.reparse("R.md");
    const a = await new ObsidianBackend(stale.app).patchNote("R.md", anchor, op, content);
    const b = await new ObsidianBackend(fresh.app).patchNote("R.md", anchor, op, content);
    return { a, b, staleText: stale.store.get("R.md"), freshText: fresh.store.get("R.md") };
  }

  for (const [kind, structure] of [
    ["table", "| a | b |\n| - | - |\n| 1 | 2 |"],
    ["list", "- one\n- two"],
    ["quote", "> quoted\n> more"],
  ]) {
    test(`an id alone after a ${kind}: the stale path gives the fresh path's bytes`, async () => {
      const text = `# H\n\nlead\n\n${structure}\n\n^blk\n\ntail\n`;
      const { a, b, staleText, freshText } = await staleVsFresh(text, { type: "block", value: "blk" }, "replace", "replaced");
      assert.equal(b.found, true, "fresh found");
      assert.equal(a.found, true, "stale found");
      assert.equal(a.previous, structure);
      sameText(staleText, freshText);
    });
  }

  test("a mixed-case anchor finds a mixed-case id, fresh and stale alike", async () => {
    const text = "# H\n\nA line ^Note-A\n\ntail\n";
    const { a, b, staleText, freshText } = await staleVsFresh(text, { type: "block", value: "Note-A" }, "replace", "B line ^Note-A");
    assert.equal(b.found, true, "fresh found");
    assert.equal(a.found, true, "stale found");
    sameText(staleText, freshText);
  });

  test("a fresh cache holding a list-item heading is used: append_at_heading finds it and adds no duplicate", async () => {
    const text = "# T\n\n- # Item head\n\n## Next\n";
    const { app, store, caches } = fakeApp({ "I.md": text }, { obsidianParse: false });
    const at = text.indexOf("# Item head");
    const cache = caches.get("I.md");
    cache.headings.splice(1, 0, { heading: "Item head", level: 1, position: { start: { offset: at }, end: { offset: at + "# Item head".length } } });
    const handlers = new Map();
    registerComplementaryTools({ registerTool(n, _m, h) { handlers.set(n, h); } }, app, { getSettings: () => ({ allowlist: [] }) });
    const res = await handlers.get("obsidian_append_at_heading")({ path: "I.md", heading: "Item head", content: "under it", create_if_missing: true }, {});
    assert.equal(res.structuredContent.found, true, JSON.stringify(res.structuredContent));
    assert.equal(store.get("I.md").split("Item head").length, 2, "no duplicate heading");
  });
});

describe("review round 2 of #596 on the live host", () => {
  test("a CRLF note: a replace above a fence keeps the section after it, and writes CRLF", async () => {
    const text = "## A\r\n```\r\ncode\r\n```\r\n## B\r\ntext\r\n";
    const { app, store, caches } = fakeApp({ "C.md": text });
    caches.delete("C.md");
    const r = await new ObsidianBackend(app).patchNote("C.md", { type: "heading", value: "A" }, "replace", "new");
    assert.equal(r.found, true);
    assert.equal(store.get("C.md"), "## A\r\n\r\nnew\r\n## B\r\ntext\r\n");
  });

  test("a fresh cache for a note whose %% line holds a % is used as it stands", async () => {
    const text = "## A\n%% 50% done\n## Hidden\n%%\n\n## B\nb\n";
    const { app, store, caches } = fakeApp({ "P.md": text }, { obsidianParse: false });
    // The cache Obsidian 1.14.4 gives: A and Hidden; B sits inside the comment the lone %% opens.
    caches.set("P.md", { headings: [
      { heading: "A", level: 2, position: { start: { offset: 0 }, end: { offset: 4 } } },
      { heading: "Hidden", level: 2, position: { start: { offset: 17 }, end: { offset: 26 } } },
    ], blocks: {} });
    await new ObsidianBackend(app).patchNote("P.md", { type: "heading", value: "A" }, "replace", "new");
    assert.equal(store.get("P.md"), "## A\n\nnew\n## Hidden\n%%\n\n## B\nb\n");
  });
});

describe("review round 3 of #596: the host writes only on a reading it can check", () => {
  test("Obsidian's own parse of the text is the truth, even where the shared parser reads it differently", async () => {
    // The shared parser hides "## H" (it reads "%% c" as a comment opener); the
    // reading Obsidian gives here lists it. Obsidian's reading wins.
    const before = "## A\n\nold\n%% c\n## H\nh\n";
    const text = "## A\n\nold, now longer\n%% c\n## H\nh\n";
    const at = text.indexOf("## H");
    const { app, store, caches } = fakeApp({ "D.md": text }, {
      parse: () => ({ headings: [
        { heading: "A", level: 2, position: { start: { offset: 0 }, end: { offset: 4 } } },
        { heading: "H", level: 2, position: { start: { offset: at }, end: { offset: at + 4 } } },
      ], blocks: {}, sections: [] }),
    });
    caches.set("D.md", parseCache(before)); // stale
    await new ObsidianBackend(app).patchNote("D.md", { type: "heading", value: "A" }, "replace", "new");
    assert.equal(store.get("D.md"), "## A\n\nnew\n## H\nh\n");
  });

  test("without Obsidian's parse, a cache that does not match the text is refused with cache_mismatch, and nothing is written", async () => {
    const before = "# T\n\n## A\n\na\n\n## B\n\nb\n";
    const text = "# T\n\n## A\n\na, now longer\n\n## B\n\nb\n";
    const { app, store, caches } = fakeApp({ "M.md": text }, { obsidianParse: false });
    caches.set("M.md", parseCache(before));
    await assert.rejects(() => new ObsidianBackend(app).patchNote("M.md", { type: "heading", value: "B" }, "replace", "x"), (e) => e.code === "cache_mismatch" && /Retry/.test(e.message));
    assert.equal(store.get("M.md"), text);
  });

  test("without Obsidian's parse, a stale cache is waited for: once Obsidian re-reads the note the write lands", async () => {
    const { app, store } = fakeApp({ "W.md": "# T\n\n## A\n\na\n\n## B\n\nb\n" }, { obsidianParse: false, changedAfterWrite: 20 });
    const b = new ObsidianBackend(app);
    await b.patchNote("W.md", { type: "heading", value: "A" }, "replace", "a, now longer");
    await b.patchNote("W.md", { type: "heading", value: "B" }, "replace", "b2");
    assert.equal(store.get("W.md"), "# T\n\n## A\n\na, now longer\n## B\n\nb2\n");
  });

  test("append_at_heading with create_if_missing refuses on a mismatch instead of adding a heading Obsidian has", async () => {
    // Obsidian's index holds "Target"; the shared parser does not see it here,
    // and the index's offsets are stale, so no reading can be checked.
    const text = "# T\n\nintro, now longer\n\n- # Target\n\nmore\n";
    const { app, store, caches } = fakeApp({ "X.md": text }, { obsidianParse: false });
    caches.set("X.md", { headings: [
      { heading: "T", level: 1, position: { start: { offset: 0 }, end: { offset: 3 } } },
      { heading: "Target", level: 1, position: { start: { offset: 16 }, end: { offset: 24 } } },
    ], blocks: {} });
    const handlers = new Map();
    registerComplementaryTools({ registerTool(n, _m, h) { handlers.set(n, h); } }, app, { getSettings: () => ({ allowlist: [] }) });
    const res = await handlers.get("obsidian_append_at_heading")({ path: "X.md", heading: "Target", content: "under it", create_if_missing: true }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[cache_mismatch\]/);
    assert.equal(store.get("X.md"), text, "nothing written, no duplicate heading");
  });

  test("a CRLF note: append and prepend write CRLF too", async () => {
    const text = "# T\r\n\r\n## A\r\n\r\na\r\n\r\n## B\r\n\r\nb\r\n";
    const { app, store, reparse } = fakeApp({ "R.md": text });
    const b = new ObsidianBackend(app);
    await b.patchNote("R.md", { type: "heading", value: "A" }, "append", "one\ntwo");
    reparse("R.md");
    await b.patchNote("R.md", { type: "heading", value: "B" }, "prepend", "first");
    assert.equal(store.get("R.md"), "# T\r\n\r\n## A\r\n\r\na\r\none\r\ntwo\r\n\r\n## B\r\n\r\nfirst\r\n\r\nb\r\n");
  });
});

describe("review round 4 of #596", () => {
  const handlersOf = (app) => {
    const handlers = new Map();
    registerComplementaryTools({ registerTool(n, _m, h) { handlers.set(n, h); } }, app, { getSettings: () => ({ allowlist: [] }) });
    return handlers;
  };

  test("an edit that lands while Obsidian parses the read text is kept: the patch is refused with rev_conflict", async () => {
    const text = "## A\nold a\n## B\nb\n";
    const { app, store } = fakeApp({ "N.md": text }, {
      parse: (t) => {
        // Another writer (the editor, Sync) changes the note while the worker parses.
        store.set("N.md", store.get("N.md") + "## C\nuser text\n");
        return parseCache(t);
      },
    });
    await assert.rejects(() => new ObsidianBackend(app).patchNote("N.md", { type: "heading", value: "A" }, "replace", "new a"), (e) => e.code === "rev_conflict");
    assert.equal(store.get("N.md"), text + "## C\nuser text\n");
  });

  test("append_at_heading keeps an edit that lands while it places the text", async () => {
    const text = "## A\nold a\n## B\nb\n";
    const { app, store } = fakeApp({ "N.md": text }, {
      parse: (t) => { store.set("N.md", store.get("N.md") + "## C\nuser text\n"); return parseCache(t); },
    });
    const res = await handlersOf(app).get("obsidian_append_at_heading")({ path: "N.md", heading: "A", content: "more", create_if_missing: false }, {});
    assert.match(res.content[0].text, /^Error \[rev_conflict\]/);
    assert.equal(store.get("N.md"), text + "## C\nuser text\n");
  });

  test("a BOM note on the cache road: the cache's offsets are shifted past the BOM, as the parse's are", async () => {
    const text = "\uFEFF# T\n\n## A\n\na\n\n## B\n\nb\n";
    const { app, store, caches } = fakeApp({ "U.md": text }, { obsidianParse: false });
    caches.set("U.md", parseCache(text.slice(1))); // Obsidian's cache: built without the BOM
    await new ObsidianBackend(app).patchNote("U.md", { type: "heading", value: "A" }, "replace", "new a");
    assert.equal(store.get("U.md"), "\uFEFF# T\n\n## A\n\nnew a\n## B\n\nb\n");
  });

  test("an answer from the parse call with no sections is not a parse: no heading is added twice", async () => {
    const text = "# T\n\n## Log\n\nold\n";
    const { app, store } = fakeApp({ "E.md": text }, { parse: () => ({}) });
    const res = await handlersOf(app).get("obsidian_append_at_heading")({ path: "E.md", heading: "Log", content: "new", create_if_missing: true }, {});
    assert.equal(res.structuredContent.found, true, JSON.stringify(res.structuredContent ?? res.content));
    assert.equal(store.get("E.md").split("## Log").length, 2, "no second Log heading");
  });

  test("a move's link reader sees a link after a fence in a list item indented by a tab or four spaces", async () => {
    const { parseLinks } = await import("../src/mcp/link-rewrite.ts");
    assert.deepEqual(parseLinks("- item\n\t```\n\tcode\n\t```\n\n[[B]]\n").map((l) => l.linkpath), ["B"]);
    assert.deepEqual(parseLinks("- item\n\n    ```\n    code\n    ```\n\n[[B]]\n").map((l) => l.linkpath), ["B"]);
    // A link inside that fence is code, as Obsidian reads it.
    assert.deepEqual(parseLinks("- item\n\t```\n\t[[A]]\n\t```\n\n[[B]]\n").map((l) => l.linkpath), ["B"]);
  });
});

describe("the H1 replace rule on the live host (#601)", () => {
  const H1NOTE = "# Title\n\nintro\n\n## Part\n\npart body\n\n## Response\n\nanswer\n";

  test("a replace on an H1 is refused with h1_replace, and the note is unchanged", async () => {
    const { app, store } = fakeApp({ "T.md": H1NOTE });
    await assert.rejects(() => new ObsidianBackend(app).patchNote("T.md", { type: "heading", value: "Title" }, "replace", "new intro"), (e) => e.code === "h1_replace" && /whole note/.test(e.message));
    assert.equal(store.get("T.md"), H1NOTE);
  });

  test("with whole_section the replace goes through", async () => {
    const { app, store } = fakeApp({ "T.md": H1NOTE });
    const r = await new ObsidianBackend(app).patchNote("T.md", { type: "heading", value: "Title" }, "replace", "all new", { wholeSection: true });
    assert.equal(r.found, true);
    assert.equal(store.get("T.md"), "# Title\n\nall new\n");
  });

  test("prepend and append on an H1 are allowed", async () => {
    const { app, store, reparse } = fakeApp({ "T.md": H1NOTE });
    const b = new ObsidianBackend(app);
    await b.patchNote("T.md", { type: "heading", value: "Title" }, "prepend", "> [!note] a callout");
    reparse("T.md");
    await b.patchNote("T.md", { type: "heading", value: "Title" }, "append", "tail");
    assert.equal(store.get("T.md"), "# Title\n\n> [!note] a callout\n\nintro\n\n## Part\n\npart body\n\n## Response\n\nanswer\ntail\n");
  });

  test("a replace on an H2 is not affected", async () => {
    const { app, store } = fakeApp({ "T.md": H1NOTE });
    await new ObsidianBackend(app).patchNote("T.md", { type: "heading", value: "Part" }, "replace", "new part");
    assert.equal(store.get("T.md"), "# Title\n\nintro\n\n## Part\n\nnew part\n## Response\n\nanswer\n");
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
