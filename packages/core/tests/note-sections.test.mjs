/**
 * note-sections.test.mjs — the shared heading and block parser (#593), and
 * the filesystem server's patch over it.
 *
 * Both servers place `obsidian_patch_note` (and the live host's
 * `obsidian_append_at_heading`) with this parser: the live host checks its
 * metadata cache against the text with it, and the filesystem server finds
 * headings and blocks with it. The note text is made up.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  outlineNote,
  findHeadingSection,
  findBlock,
  verifyCachedHeadings,
  verifyCachedBlock,
  resolveHeadings,
  resolveBlock,
  sectionIn,
} from "../src/note-sections.ts";
import { createVaultAt } from "../src/fs-backend/vault.ts";

const names = (text, opts) => outlineNote(text, opts).headings.map((h) => `${h.level}:${h.heading}`);

/** A cache entry as Obsidian shapes it, for the heading at `line` of `text`. */
function cached(text, line, heading, level) {
  const lines = text.split("\n");
  let start = 0;
  for (let i = 0; i < line; i++) start += lines[i].length + 1;
  return { heading, level, position: { start: { offset: start }, end: { offset: start + lines[line].length } } };
}

describe("outlineNote — headings", () => {
  test("ATX headings, levels 1 to 6, closing hashes dropped, text trimmed", () => {
    assert.deepEqual(names("# One\n## Two ##\n### Three #not-closing\n#### \n##### Five\t\n###### Six"), [
      "1:One", "2:Two", "3:Three #not-closing", "4:", "5:Five", "6:Six",
    ]);
  });

  test("not headings: no space after the hashes, seven hashes, four spaces of indent, an escaped hash", () => {
    assert.deepEqual(names("#tag\n####### seven\n    # indented code\n\\# escaped\n   # three spaces"), ["1:three spaces"]);
  });

  test("a # line inside a fence is not a heading: backticks, tildes, longer fences, info strings", () => {
    const text = [
      "# Real",
      "```js {tangle=\"no\"}",
      "# inside backticks",
      "```",
      "~~~~ python",
      "# inside tildes",
      "~~~", // too short to close a four-tilde fence
      "# still inside",
      "~~~~~",
      "## After",
      "````",
      "```",
      "# inside, a shorter fence line does not close",
      "````",
      "## End",
    ].join("\n");
    assert.deepEqual(names(text), ["1:Real", "2:After", "2:End"]);
  });

  test("an unclosed fence hides the rest of the note", () => {
    assert.deepEqual(names("# A\n```\n# hidden\n## hidden too"), ["1:A"]);
  });

  test("a backtick fence's info string may not hold a backtick (then it is not a fence)", () => {
    assert.deepEqual(names("``` a`b\n# visible\n"), ["1:visible"]);
  });

  test("math, comment and HTML blocks hide their lines", () => {
    const text = "# A\n$$\n# math\n$$\n%%\n# comment\n%%\n<!--\n# html comment\n-->\n<div>\n# in a div\n</div>\n\n## B";
    assert.deepEqual(names(text), ["1:A", "2:B"]);
  });

  test("front matter is skipped, BOM and all", () => {
    assert.deepEqual(names("---\ntitle: x\n# not: a heading\n---\n# Body"), ["1:Body"]);
    assert.deepEqual(names("﻿---\na: 1\n---\n# Body"), ["1:Body"]);
    // Without front-matter skipping a leading `---` is a thematic break, and
    // the line under it with the next `---` is a setext heading, as Obsidian reads it.
    assert.deepEqual(names("---\na: 1\n---\n# Body", { frontmatter: false }), ["2:a: 1", "1:Body"]);
  });

  test("setext headings at the start of a block; a thematic break after a blank line is not one", () => {
    assert.deepEqual(names("Title\n=====\n\nSub\n---\n\npara\n\n---\n\n- item\n---\n"), ["1:Title", "2:Sub"]);
  });

  test("offsets point at the heading line, end before the line break", () => {
    const text = "intro\n\n## Two\nbody\n";
    const [h] = outlineNote(text).headings;
    assert.equal(text.slice(h.start, h.end), "## Two");
  });
});

describe("findHeadingSection", () => {
  test("a section ends at the next heading of the same or a higher level, outside fences", () => {
    const text = "# T\n## A\nbody\n```\n## fenced\n```\n### deeper\nmore\n## B\nb\n";
    const o = outlineNote(text);
    const s = findHeadingSection(o, text.length, "A");
    assert.equal(text.slice(s.start, s.end), "\nbody\n```\n## fenced\n```\n### deeper\nmore\n");
    assert.equal(s.startLine, 2);
    assert.equal(s.endLine, 8);
  });

  test("a heading that appears twice: the first is found", () => {
    const text = "## Entry\none\n## Entry\ntwo\n";
    const s = findHeadingSection(outlineNote(text), text.length, "Entry");
    assert.equal(text.slice(s.start, s.end), "\none\n");
  });

  test("the last section runs to the end; a missing heading is undefined", () => {
    const text = "# T\n## Z\nlast";
    const o = outlineNote(text);
    assert.equal(text.slice(findHeadingSection(o, text.length, "Z").start), "\nlast");
    assert.equal(findHeadingSection(o, text.length, "nope"), undefined);
  });
});

describe("findBlock", () => {
  test("an id at a paragraph's end gives the paragraph", () => {
    const text = "# H\n\nline one\nline two ^blk\n\nafter\n";
    const b = findBlock(outlineNote(text), (id) => id === "blk");
    assert.equal(text.slice(b.start, b.end), "line one\nline two ^blk");
  });

  test("a block stops at a heading line and at a fence", () => {
    const text = "## H\npara ^p1\n```\ncode\n```\nnext ^p2\n";
    const o = outlineNote(text);
    const p1 = findBlock(o, (id) => id === "p1");
    assert.equal(text.slice(p1.start, p1.end), "para ^p1");
    const p2 = findBlock(o, (id) => id === "p2");
    assert.equal(text.slice(p2.start, p2.end), "next ^p2");
  });

  test("an id inside a fence is not a block; one on a list item gives that item", () => {
    const text = "```\nnot here ^x\n```\n\n- one\n- two ^x\n- three\n";
    const b = findBlock(outlineNote(text), (id) => id === "x");
    assert.equal(text.slice(b.start, b.end), "- two ^x");
  });

  test("an id in mid-line is not an id", () => {
    assert.equal(findBlock(outlineNote("a ^x b\n"), (id) => id === "x"), undefined);
  });
});

describe("checking a cache against the text", () => {
  const text = "# T\n\n## A\n\nbody\n\n## B\n\nmore ^blk\n";
  const fresh = [cached(text, 0, "T", 1), cached(text, 2, "A", 2), cached(text, 6, "B", 2)];

  test("a fresh cache holds, and resolveHeadings returns it", () => {
    assert.equal(verifyCachedHeadings(text, outlineNote(text), fresh), true);
    const r = resolveHeadings(text, fresh);
    assert.equal(r.source, "cache");
    assert.deepEqual(sectionIn(r.headings, text.length, "A"), { start: fresh[1].position.end.offset, end: fresh[2].position.start.offset, level: 2 });
  });

  test("the cache of an older text does not hold: its offsets miss the heading lines", () => {
    const newer = "# T\n\n## A\n\nbody, now much longer than it was\n\n## B\n\nmore ^blk\n";
    assert.equal(verifyCachedHeadings(newer, outlineNote(newer), fresh), false);
    const r = resolveHeadings(newer, fresh);
    assert.equal(r.source, "text");
    const s = sectionIn(r.headings, newer.length, "A");
    assert.equal(newer.slice(s.start, s.end), "\n\nbody, now much longer than it was\n\n");
  });

  test("a cache that misses a heading written since does not hold", () => {
    const newer = text + "\n## C\n\nnew\n";
    assert.equal(verifyCachedHeadings(newer, outlineNote(newer), fresh), false);
  });

  test("a cached heading this parser does not see (in a list, say) is allowed", () => {
    const t = "# T\n\n- item\n  # nested heading\n";
    const c = [cached(t, 0, "T", 1), { heading: "nested heading", level: 1, position: { start: { offset: t.indexOf("  #") }, end: { offset: t.length - 1 } } }];
    assert.equal(verifyCachedHeadings(t, outlineNote(t), c), true);
  });

  test("a cached heading whose text or level changed does not hold", () => {
    const t = "# T\n\n## Renamed\n";
    assert.equal(verifyCachedHeadings(t, outlineNote(t), [cached(t, 0, "T", 1), cached(t, 2, "Old", 2)]), false);
    assert.equal(verifyCachedHeadings(t, outlineNote(t), [cached(t, 0, "T", 1), cached(t, 2, "Renamed", 3)]), false);
  });

  test("blocks: a fresh cached block holds; a moved one is found on the text instead", () => {
    const start = text.indexOf("more ^blk");
    const block = { position: { start: { offset: start }, end: { offset: start + "more ^blk".length } } };
    assert.equal(verifyCachedBlock(text, outlineNote(text), "blk", block), true);
    assert.deepEqual(resolveBlock(text, "blk", block), { start, end: start + 9, source: "cache" });
    const newer = "# T\n\nan extra line\n\n" + text.slice(4);
    assert.equal(verifyCachedBlock(newer, outlineNote(newer), "blk", block), false);
    const r = resolveBlock(newer, "blk", block);
    assert.equal(r.source, "text");
    assert.equal(newer.slice(r.start, r.end), "more ^blk");
  });

  test("blocks: an id on its own line after a table holds for the table's offsets", () => {
    const t = "| a | b |\n| - | - |\n| 1 | 2 |\n\n^tbl\n";
    const end = t.indexOf("\n\n^tbl");
    assert.equal(verifyCachedBlock(t, outlineNote(t), "tbl", { position: { start: { offset: 0 }, end: { offset: end } } }), true);
  });
});

describe("the filesystem server's patch over the shared parser", () => {
  let root;
  let vault;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "note-sections-"));
    vault = createVaultAt(root);
  });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  test("a # line inside a fence does not end a section", async () => {
    const text = "---\ntitle: Doc\n---\n# Doc\n\n## Setup\n\n```sh\n# install the tool\nmake install\n```\n\nAfter the fence.\n\n## Use\n\nRun it.\n";
    await writeFile(path.join(root, "doc.md"), text, "utf8");
    const miss = await vault.patchNote("doc.md", { type: "heading", value: "install the tool" }, "replace", "x");
    assert.equal(miss.found, false);
    const r = await vault.patchNote("doc.md", { type: "heading", value: "Setup" }, "replace", "\nSetup replaced.\n");
    assert.equal(r.found, true);
    assert.equal(r.previous, "\n```sh\n# install the tool\nmake install\n```\n\nAfter the fence.\n");
    assert.equal(await readFile(path.join(root, "doc.md"), "utf8"), "---\ntitle: Doc\n---\n# Doc\n\n## Setup\n\nSetup replaced.\n\n## Use\n\nRun it.\n");
  });

  test("a heading that appears twice: the first section is patched", async () => {
    await writeFile(path.join(root, "log.md"), "# Log\n\n## Entry\n\none\n\n## Entry\n\ntwo\n", "utf8");
    await vault.patchNote("log.md", { type: "heading", value: "Entry" }, "append", "added");
    assert.equal(await readFile(path.join(root, "log.md"), "utf8"), "# Log\n\n## Entry\n\none\n\nadded\n## Entry\n\ntwo\n");
  });

  test("two patches back to back read the text each time", async () => {
    await writeFile(path.join(root, "two.md"), "# T\n\n## A\n\na\n\n## B\n\nb\n", "utf8");
    await vault.patchNote("two.md", { type: "heading", value: "A" }, "replace", "\na, now longer\nand two lines\n");
    await vault.patchNote("two.md", { type: "heading", value: "B" }, "replace", "\nb2\n");
    assert.equal(await readFile(path.join(root, "two.md"), "utf8"), "# T\n\n## A\n\na, now longer\nand two lines\n\n## B\n\nb2\n");
  });

  test("a block id inside a fence is not found", async () => {
    await writeFile(path.join(root, "blk.md"), "# B\n\n```\nnot a block ^b1\n```\n", "utf8");
    assert.equal((await vault.patchNote("blk.md", { type: "block", value: "b1" }, "replace", "x")).found, false);
  });
});

// ── review round 1 of #596 ─────────────────────────────────────────────────

describe("review round 1: fences, cache checks and blocks", () => {
  test("a fence that opens on a list item's line hides its lines, and its closer does not open another", () => {
    const text = "## Setup\n- ```bash\n  # install deps\n  npm i\n  ```\n\n## Usage\nrun it\n\n## License\nMIT\n";
    assert.deepEqual(names(text), ["2:Setup", "2:Usage", "2:License"]);
  });

  test("a fence inside a quote hides its lines", () => {
    assert.deepEqual(names("# A\n> ```\n> # quoted code\n> ```\n## B\n"), ["1:A", "2:B"]);
  });

  test("a cache that lacks an indented ATX heading written since does not hold", () => {
    const text = "# T\n\n## A\n\nbody\n";
    const c = [cached(text, 0, "T", 1), cached(text, 2, "A", 2)];
    const newer = text + "\n   ## New\n\nnew body\n";
    assert.equal(verifyCachedHeadings(newer, outlineNote(newer), c), false);
  });

  test("a cache that lacks a setext heading written since does not hold", () => {
    const text = "# T\n\n## A\n\nbody\n";
    const c = [cached(text, 0, "T", 1), cached(text, 2, "A", 2)];
    const newer = text + "\nNew\n===\n\nnew body\n";
    assert.equal(verifyCachedHeadings(newer, outlineNote(newer), c), false);
  });

  test("an indented # line inside a list item is not a heading of the note", () => {
    assert.deepEqual(names("# T\n\n- item\n  # nested\n\n  ## nested too\n\n## After\n"), ["1:T", "2:After"]);
  });

  test("a fresh cache holding headings the parser cannot place still holds: list item, callout, multi-line setext", () => {
    const text = "# T\n\n- # Item head\n\n> [!note]\n> # Callout head\n\nLine one\nline two\n---\n\n## End\n";
    const at = (s) => text.indexOf(s);
    const c = [
      cached(text, 0, "T", 1),
      { heading: "Item head", level: 1, position: { start: { offset: at("# Item head") }, end: { offset: at("# Item head") + "# Item head".length } } },
      { heading: "Callout head", level: 1, position: { start: { offset: at("# Callout head") }, end: { offset: at("# Callout head") + "# Callout head".length } } },
      { heading: "Line one\nline two", level: 2, position: { start: { offset: at("Line one") }, end: { offset: at("line two\n---") + "line two\n---".length } } },
      cached(text, 11, "End", 2),
    ];
    assert.equal(verifyCachedHeadings(text, outlineNote(text), c), true);
    assert.equal(resolveHeadings(text, c).source, "cache");
  });

  test("a cached list-item heading whose text changed does not hold", () => {
    const text = "# T\n\n- # Other head\n";
    const s = text.indexOf("# Other");
    const c = [cached(text, 0, "T", 1), { heading: "Item head", level: 1, position: { start: { offset: s }, end: { offset: s + 12 } } }];
    assert.equal(verifyCachedHeadings(text, outlineNote(text), c), false);
  });

  for (const [kind, structure] of [
    ["table", "| a | b |\n| - | - |\n| 1 | 2 |"],
    ["list", "- one\n- two"],
    ["quote", "> quoted\n> more"],
  ]) {
    test(`an id alone on its line after a blank line belongs to the ${kind} above (text fallback)`, () => {
      const text = `# H\n\nlead\n\n${structure}\n\n^Blk-1\n\ntail\n`;
      const r = resolveBlock(text, "blk-1", undefined);
      assert.ok(r, "found");
      assert.equal(text.slice(r.start, r.end), structure);
    });
  }

  test("a mixed-case anchor matches a mixed-case id, both sides lowercased", () => {
    const text = "# H\n\nA line ^Note-A\n";
    const r = resolveBlock(text, "Note-A", undefined);
    assert.ok(r);
    assert.equal(text.slice(r.start, r.end), "A line ^Note-A");
  });

  test("the FS server: a replace on a heading above a list-item fence keeps the sections after it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "note-sections-r1-"));
    try {
      const v = createVaultAt(root);
      await writeFile(path.join(root, "s.md"), "## Setup\n- ```bash\n  # install deps\n  npm i\n  ```\n\n## Usage\nrun it\n\n## License\nMIT\n", "utf8");
      assert.equal((await v.patchNote("s.md", { type: "heading", value: "install deps" }, "replace", "x")).found, false);
      await v.patchNote("s.md", { type: "heading", value: "Setup" }, "replace", "new setup\n");
      assert.equal(await readFile(path.join(root, "s.md"), "utf8"), "## Setup\nnew setup\n\n## Usage\nrun it\n\n## License\nMIT\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// ── #601: a replace on an H1 is the whole note ─────────────────────────────

describe("the H1 replace rule on the filesystem server (#601)", () => {
  const NOTE = "# Title\n\nintro\n\n## Part\n\npart body\n\n## Response\n\nanswer\n";
  let root;
  let v;
  before(async () => { root = await mkdtemp(path.join(tmpdir(), "h1-replace-")); v = createVaultAt(root); });
  after(async () => { await rm(root, { recursive: true, force: true }); });
  const put = (f) => writeFile(path.join(root, f), NOTE, "utf8");
  const get = (f) => readFile(path.join(root, f), "utf8");

  test("a replace on an H1 is refused with h1_replace, and the note is unchanged", async () => {
    await put("a.md");
    await assert.rejects(() => v.patchNote("a.md", { type: "heading", value: "Title" }, "replace", "new intro\n"), (e) => e.code === "h1_replace" && /whole note/.test(e.message));
    assert.equal(await get("a.md"), NOTE);
  });

  test("with whole_section the replace goes through", async () => {
    await put("b.md");
    const r = await v.patchNote("b.md", { type: "heading", value: "Title" }, "replace", "\nall new\n", { wholeSection: true });
    assert.equal(r.found, true);
    assert.equal(await get("b.md"), "# Title\n\nall new\n");
  });

  test("prepend and append on an H1 are allowed", async () => {
    await put("c.md");
    await v.patchNote("c.md", { type: "heading", value: "Title" }, "prepend", "> [!note] a callout");
    await v.patchNote("c.md", { type: "heading", value: "Title" }, "append", "tail");
    assert.equal(await get("c.md"), "# Title\n> [!note] a callout\n\nintro\n\n## Part\n\npart body\n\n## Response\n\nanswer\n\ntail");
  });

  test("a replace on an H2 is not affected", async () => {
    await put("d.md");
    await v.patchNote("d.md", { type: "heading", value: "Part" }, "replace", "\nnew part\n");
    assert.equal(await get("d.md"), "# Title\n\nintro\n\n## Part\n\nnew part\n\n## Response\n\nanswer\n");
  });

  test("the tool declares whole_section and says why", async () => {
    const { FS_TOOLS } = await import("../src/tool-registry.ts");
    const def = FS_TOOLS.find((t) => t.name === "obsidian_patch_note");
    assert.ok(def.inputSchema.whole_section, "whole_section in the schema");
    assert.match(def.description, /level-1 heading is refused/);
  });
});

// ── review round 2 of #596 ─────────────────────────────────────────────────
//
// Each expected outline below is what Obsidian 1.14.4's own parser gives for
// the text (its worker run on the string, outside the repo), and each cache
// is the one it gives: start and end offsets of each heading.

const obsCache = (...hs) => hs.map(([heading, level, s, e]) => ({ heading, level, position: { start: { offset: s }, end: { offset: e } } }));

describe("review round 2: CRLF, comments, container fences, list columns", () => {
  test("a CRLF note: a fence closes, and the outline and the cache check see the heading after it", () => {
    const text = "## A\r\n```\r\ncode\r\n```\r\n## B\r\ntext\r\n";
    assert.deepEqual(names(text), ["2:A", "2:B"]);
    const c = obsCache(["A", 2, 0, 4], ["B", 2, 22, 26]);
    assert.equal(resolveHeadings(text, c).source, "cache");
  });

  test("the shared fence rule closes a CRLF fence (the link rewriter's spans too)", async () => {
    const { fencedSpans } = await import("../src/fences.ts");
    const text = "x\r\n```\r\ncode\r\n```\r\nafter\r\n";
    assert.deepEqual(fencedSpans(text, 0), [[3, text.indexOf("```\r\nafter") + 3 + 1]]);
  });

  test("a %% line with a % in its text opens no comment; the later lone %% does (as Obsidian reads it)", () => {
    const t1 = "## A\n%% 50% done\n## Hidden\n%%\n\n## B\nb\n";
    assert.deepEqual(names(t1), ["2:A", "2:Hidden"]);
    assert.equal(resolveHeadings(t1, obsCache(["A", 2, 0, 4], ["Hidden", 2, 17, 26])).source, "cache");
    const t2 = "## A\nsee %%\n## Hidden\n%%\n\n## B\nb\n";
    assert.deepEqual(names(t2), ["2:A", "2:Hidden"]);
    assert.equal(resolveHeadings(t2, obsCache(["A", 2, 0, 4], ["Hidden", 2, 12, 21])).source, "cache");
  });

  test("a comment closes in mid-line, and the rest of that line is a heading", () => {
    const text = "%% c\n%% ## X\n";
    assert.deepEqual(names(text), ["2:X"]);
    assert.equal(resolveHeadings(text, obsCache(["X", 2, 7, 12])).source, "cache");
  });

  test("a fence inside a comment is comment text: the comment closes at the next %%", () => {
    assert.deepEqual(names("%%\n```\n%%\n```\n## Z\n"), []);
    assert.deepEqual(names("```\n%%\n```\n## Z\n%%\n## W\n"), ["2:Z"]);
  });

  test("an unclosed fence in a quote or a list item ends with its container", () => {
    assert.deepEqual(names("## A\n> ```\n> x\n\n## B\nb\n"), ["2:A", "2:B"]);
    assert.deepEqual(names("## A\n- ```\n  x\n\n## B\nb\n"), ["2:A", "2:B"]);
    assert.deepEqual(names("> ```\nlazy text\n## B\n"), ["2:B"]);
    assert.deepEqual(names("- ```\n  x\n\n  y\n## B\n"), ["2:B"]);
  });

  test("a heading indented less than the list item's content column is outside the list", () => {
    assert.deepEqual(names("- item\n\n # H\n"), ["1:H"]);
    assert.deepEqual(names("- item\n\n  # H\n"), []);
    assert.deepEqual(names("1. item\n\n  # H\n"), ["1:H"]);
    assert.deepEqual(names("- item\n # H\n"), ["1:H"]);
    assert.deepEqual(names("* item\n    - deep\n  # in item\n"), []);
  });

  test("the FS server: a replace on a heading above a CRLF fence keeps the section after it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "note-sections-r2-"));
    try {
      const v = createVaultAt(root);
      await writeFile(path.join(root, "c.md"), "## A\r\n```\r\ncode\r\n```\r\n## B\r\ntext\r\n", "utf8");
      const r = await v.patchNote("c.md", { type: "heading", value: "A" }, "replace", "new");
      assert.equal(r.found, true);
      assert.equal(await readFile(path.join(root, "c.md"), "utf8"), "## A\r\nnew\n## B\r\ntext\r\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
