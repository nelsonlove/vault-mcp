/**
 * rename-heading.test.mjs — `obsidian_rename_heading` (#424; Nelson, 2026-09-29:
 * "agents need to understand that renaming a heading using that tool is
 * preferable because it rewrites links").
 *
 * Pins the pure rules (rename-heading.ts) and the real handler over a fake app
 * whose metadata cache is built from the notes' own text, so every position the
 * handler uses is the one the text actually has.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile } from "./obsidian-stub.mjs";
import { headingKey, stripHeading, newHeadingRefusal, rewriteLinkOriginal, rewriteHeadingLine, applyEdits } from "../src/mcp/rename-heading.ts";

installObsidianStub();
const { registerVaultWriteTools } = await import("../src/mcp/tools-vault-write.ts");

// ── the pure rules ────────────────────────────────────────────────────────────
describe("rename-heading rules", () => {
  test("rewriteLinkOriginal: wikilinks, embeds, same-note links, aliases, chains and markdown links; only the matching segment changes", () => {
    const r = (o) => rewriteLinkOriginal(o, "Old heading", "New name");
    assert.equal(r("[[A#Old heading]]"), "[[A#New name]]");
    assert.equal(r("[[A#old  HEADING|alias]]"), "[[A#New name|alias]]", "case and whitespace do not matter to the match; the alias stays");
    assert.equal(r("![[A#Old heading]]"), "![[A#New name]]");
    assert.equal(r("[[#Old heading]]"), "[[#New name]]");
    assert.equal(r("[[A#Title#Old heading]]"), "[[A#Title#New name]]", "only the segment naming the heading changes");
    assert.equal(r("[t](A.md#Old%20heading)"), "[t](A.md#New%20name)");
    assert.equal(r("[t](<A.md#Old%20heading>)"), "[t](<A.md#New%20name>)");
    assert.equal(r("[[A#Other]]"), null, "a link to another heading is left alone");
    assert.equal(r("[[A]]"), null);
  });
  test("links are matched with Obsidian's key: stripHeading, then lowercase (app.js 1.13.7)", () => {
    const r = (o) => rewriteLinkOriginal(o, "Step 1: setup", "Setup");
    assert.equal(r("[[A#Step 1 setup]]"), "[[A#Setup]]", "what Obsidian's autocomplete writes for '## Step 1: setup'");
    assert.equal(r("[[A#step 1 SETUP]]"), "[[A#Setup]]");
    assert.equal(r("[m](A.md#Step%201:%20setup)"), "[m](A.md#Setup)");
    assert.equal(headingKey("Step 1: setup"), "step 1 setup");
    assert.equal(headingKey("[[B]] notes"), "b notes");
    assert.equal(headingKey("C# tips"), "c tips");
    assert.equal(stripHeading("Why? (draft)"), "Why draft");
  });
  test("markdown links decode with decodeURI, as the cache does, and a new name's parentheses are encoded", () => {
    assert.equal(rewriteLinkOriginal("[t](A.md#Old%20heading%3F)", "Old heading?", "New"), null, "decodeURI keeps %3F, so Obsidian does not resolve this link either");
    assert.equal(rewriteLinkOriginal("[t](A.md#Old%20heading)", "Old heading", "Part a)"), "[t](A.md#Part%20a%29)", "a raw ) would end the destination");
    assert.equal(rewriteLinkOriginal("[t](A.md#Old%20heading)", "Old heading", "(b)"), "[t](A.md#%28b%29)");
    const colon = rewriteLinkOriginal("[t](A.md#Old)", "Old", "Step 1: setup");
    assert.equal(colon, "[t](A.md#Step%201:%20setup)", "encodeURI, the inverse of the cache's decodeURI");
    assert.equal(decodeURI(/#(.*)\)$/.exec(colon)[1]), "Step 1: setup", "the written link decodes back to the new name");
    assert.equal(rewriteLinkOriginal("[t](A.md#Old)", "Old", "50% done"), "[t](A.md#50%25%20done)");
    assert.equal(rewriteLinkOriginal("[[A#]]", "?", "New"), null, "an empty key matches no segment");
  });
  test("newHeadingRefusal: empty, padded, link syntax, unchanged", () => {
    assert.match(newHeadingRefusal("a", " "), /empty/);
    assert.match(newHeadingRefusal("a", " b"), /whitespace/);
    for (const bad of ["a[b", "a]b", "a|b", "a#b", "a^b", "a\nb"]) assert.match(newHeadingRefusal("a", bad), /cannot carry/, JSON.stringify(bad));
    assert.match(newHeadingRefusal("a", "a"), /same/);
    assert.match(newHeadingRefusal("a", "50%% done"), /%%/);
    assert.match(newHeadingRefusal("a", "?!"), /no character a link can match/);
    assert.equal(newHeadingRefusal("a", "b: c (d)"), null);
  });
  test("rewriteHeadingLine keeps the level and drops closing hashes; a different line is refused", () => {
    assert.equal(rewriteHeadingLine("## Old heading", "Old heading", "New"), "## New");
    assert.equal(rewriteHeadingLine("### Old heading ###", "Old heading", "New"), "### New");
    assert.equal(rewriteHeadingLine("## Other", "Old heading", "New"), null);
    assert.equal(rewriteHeadingLine("Old heading", "Old heading", "New"), null);
    assert.equal(rewriteHeadingLine("Old heading\n===", "Old heading", "New"), "New\n===", "setext keeps its underline");
    assert.equal(rewriteHeadingLine("Old heading\n---", "Old heading", "New"), "New\n---");
    assert.equal(rewriteHeadingLine("Old\nheading\n===", "Old\nheading", "New"), null, "a heading over two lines is not rewritten");
  });
  test("applyEdits verifies each position and refuses a stale or overlapping edit", () => {
    assert.equal(applyEdits("abc def", [{ start: 4, end: 7, expected: "def", replacement: "XY" }, { start: 0, end: 3, expected: "abc", replacement: "Q" }]), "Q XY");
    assert.equal(applyEdits("abc def", [{ start: 4, end: 7, expected: "zzz", replacement: "XY" }]), null);
    assert.equal(applyEdits("abcdef", [{ start: 0, end: 4, expected: "abcd", replacement: "" }, { start: 2, end: 6, expected: "cdef", replacement: "" }]), null);
    assert.equal(headingKey("  Old   Heading "), "old heading");
  });
});

// ── the handler over a fake vault ─────────────────────────────────────────────
function cacheOf(text) {
  const lineOf = (off) => text.slice(0, off).split("\n").length - 1;
  const pos = (s, e) => ({ start: { line: lineOf(s), offset: s }, end: { line: lineOf(e), offset: e } });
  const headings = [], links = [], embeds = [], frontmatterLinks = [];
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const bodyStart = fm ? fm[0].length : 0;
  if (fm) for (const m of fm[1].matchAll(/^(\w+):\s*"(\[\[([^\]|]+)(?:\|[^\]]*)?\]\])"/gm)) frontmatterLinks.push({ key: m[1], link: m[3], original: m[2] });
  const body = text.slice(bodyStart);
  // Like the real cache: the heading is the raw text without the closing #s,
  // and a setext heading's position spans its text and its underline.
  for (const m of body.matchAll(/^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm)) headings.push({ heading: m[2], level: m[1].length, position: pos(bodyStart + m.index, bodyStart + m.index + m[0].length) });
  for (const m of body.matchAll(/^([^#\n][^\n]*)\n(=+|-+)[ \t]*$/gm)) headings.push({ heading: m[1].trim(), level: m[2][0] === "=" ? 1 : 2, position: pos(bodyStart + m.index, bodyStart + m.index + m[0].length) });
  headings.sort((a, b) => a.position.start.offset - b.position.start.offset);
  for (const m of body.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) (m[1] ? embeds : links).push({ link: m[2].split("|")[0], original: m[0], position: pos(bodyStart + m.index, bodyStart + m.index + m[0].length) });
  // The cache decodes a markdown link with decodeURI, and reads an
  // angle-bracket destination that holds raw spaces.
  for (const m of body.matchAll(/(!?)\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))\)/g)) (m[1] ? embeds : links).push({ link: decodeURI(m[2] ?? m[3]), original: m[0], position: pos(bodyStart + m.index, bodyStart + m.index + m[0].length) });
  return { headings, links, embeds, frontmatterLinks };
}

function fakeVault(files, { stale = {}, throws = {} } = {}) {
  const store = { ...files };
  const tfiles = Object.keys(store).map((p) => new TFile(p));
  const byPath = (p) => tfiles.find((f) => f.path === p) ?? null;
  const caches = Object.fromEntries(Object.entries(store).map(([p, t]) => [p, cacheOf(t)]));
  const app = {
    vault: {
      getAbstractFileByPath: byPath,
      getMarkdownFiles: () => tfiles,
      cachedRead: async (f) => store[f.path],
      process: async (f, fn) => { if (throws[f.path]) throw new Error(throws[f.path]); const cur = stale[f.path] ?? store[f.path]; store[f.path] = fn(cur); return store[f.path]; },
    },
    metadataCache: {
      getFileCache: (f) => caches[f.path] ?? null,
      getFirstLinkpathDest: (lp) => tfiles.find((f) => f.path === lp || f.path === `${lp}.md` || f.basename === lp) ?? null,
    },
  };
  return { app, store };
}

function tool(app, ctx = {}) {
  let handler;
  registerVaultWriteTools({ registerTool: (name, _def, h) => { if (name === "obsidian_rename_heading") handler = h; } }, app, ctx);
  return async (args) => {
    const r = await handler({ dry_run: false, ...args });
    return { ...r, data: r.structuredContent, error: r.isError ? r.content?.[0]?.text : undefined };
  };
}

const FILES = {
  "A.md": "# Title\n\n## Old heading\ntext\n\nsee [[#Old heading]]\n",
  "B.md": "one [[A#Old heading|alias]] two ![[A#old heading]] three [md](A.md#Old%20heading) four [[A#Title#Old heading]] five [[A#Other]] six [[C#Old heading]]\n",
  "C.md": "## Old heading\nC's own heading of the same name\n",
  "R.md": "---\nrecord: true\n---\nlog: [[A#Old heading]]\n",
  "F.md": "---\nsee: \"[[A#Old heading]]\"\n---\nbody\n",
};

describe("obsidian_rename_heading", () => {
  test("renames the heading and heals every link to it — wikilink, alias, embed, markdown, chain, same-note — and nothing else", async () => {
    const { app, store } = fakeVault(FILES);
    const r = await tool(app, { isRecord: (p) => p === "R.md" })({ path: "A.md", heading: "Old heading", new_heading: "New name" });
    assert.equal(r.error, undefined, r.error);
    assert.equal(store["A.md"], "# Title\n\n## New name\ntext\n\nsee [[#New name]]\n");
    assert.equal(store["B.md"], "one [[A#New name|alias]] two ![[A#New name]] three [md](A.md#New%20name) four [[A#Title#New name]] five [[A#Other]] six [[C#Old heading]]\n");
    assert.equal(store["C.md"], FILES["C.md"], "another note's heading of the same name is not touched");
    assert.equal(store["R.md"], FILES["R.md"], "a record note is not edited");
    assert.equal(r.data.linksChanged, 5);
    assert.deepEqual(r.data.files, ["A.md", "B.md"]);
    assert.equal(r.data.filesChanged, 2);
    assert.equal(r.data.heading_line, 3);
    assert.ok(r.data.skipped.some((s) => s.path === "R.md" && /record note/.test(s.reason)));
    assert.ok(r.data.skipped.some((s) => s.path === "F.md" && /frontmatter link in 'see'/.test(s.reason)));
    assert.equal(r.data.scoped_to_allowlist, false);
  });

  test("dry_run reports the same plan and writes nothing", async () => {
    const { app, store } = fakeVault(FILES);
    const r = await tool(app)({ path: "A.md", heading: "Old heading", new_heading: "New name", dry_run: true });
    assert.deepEqual(store, FILES);
    assert.equal(r.data.linksChanged, 6, "with no record probe, R.md's link counts too");
    assert.deepEqual(r.data.files, ["A.md", "B.md", "R.md"]);
  });

  test("refuses: not found, ambiguous, a clash with another heading, a forbidden character", async () => {
    const { app, store } = fakeVault({ ...FILES, "D.md": "## Twice\n\n## Twice\n\n## Taken\n" });
    const run = tool(app);
    assert.match((await run({ path: "A.md", heading: "Nope", new_heading: "X" })).error, /heading not found in A\.md: 'Nope' \(headings: 'Title', 'Old heading'\)/);
    assert.match((await run({ path: "D.md", heading: "Twice", new_heading: "X" })).error, /2 headings in D\.md are reached by the same links \('Twice' line 1, 'Twice' line 3\)/);
    assert.match((await run({ path: "D.md", heading: "Taken", new_heading: "twice" })).error, /already has a heading 'Twice'/);
    assert.match((await run({ path: "A.md", heading: "Old heading", new_heading: "a#b" })).error, /cannot carry/);
    const q = fakeVault({ "Q.md": "## ?\n", "L.md": "[[Q#]]\n" });
    assert.match((await tool(q.app)({ path: "Q.md", heading: "?", new_heading: "New" })).error, /no character a link can match/);
    assert.equal(q.store["L.md"], "[[Q#]]\n");
    assert.deepEqual(store, { ...FILES, "D.md": "## Twice\n\n## Twice\n\n## Taken\n" }, "nothing written");
  });

  test("ambiguity and clash use Obsidian's key: headings that differ only in case or punctuation share their links", async () => {
    const files = { "E.md": "## Notes\n\n## notes\n", "G.md": "## Step 1: go\n\n## Other\n", "H.md": "see [[E#notes]] and [[G#Step 1 go]]\n" };
    const { app, store } = fakeVault(files);
    const run = tool(app);
    assert.match((await run({ path: "E.md", heading: "notes", new_heading: "X" })).error, /2 headings in E\.md are reached by the same links \('Notes' line 1, 'notes' line 3\)/, "[[E#notes]] resolves to line 1; renaming line 3 would retarget it");
    assert.match((await run({ path: "G.md", heading: "Other", new_heading: "Step 1 go" })).error, /already has a heading 'Step 1: go'/);
    assert.deepEqual(store, files, "nothing written");
  });

  test("a link written without the heading's punctuation is healed", async () => {
    const files = { "A.md": "## Step 1: setup\n", "B.md": "[[A#Step 1 setup]] and [m](A.md#Step%201:%20setup)\n" };
    const { app, store } = fakeVault(files);
    const r = await tool(app)({ path: "A.md", heading: "Step 1: setup", new_heading: "Setup" });
    assert.equal(r.error, undefined, r.error);
    assert.equal(store["A.md"], "## Setup\n");
    assert.equal(store["B.md"], "[[A#Setup]] and [m](A.md#Setup)\n");
    assert.equal(r.data.linksChanged, 2);
  });

  test("a setext heading is renamed and keeps its underline", async () => {
    const { app, store } = fakeVault({ "S.md": "Old heading\n===========\n\nsee [[#Old heading]]\n" });
    const r = await tool(app)({ path: "S.md", heading: "Old heading", new_heading: "New name" });
    assert.equal(r.error, undefined, r.error);
    assert.equal(store["S.md"], "New name\n===========\n\nsee [[#New name]]\n");
  });

  test("a link form the rewrite does not recognize is reported under skipped, not lost", async () => {
    const files = { "A.md": "## Old heading\n", "B.md": "[t](<A.md#Old heading>)\n" };
    const { app, store } = fakeVault(files);
    const r = await tool(app)({ path: "A.md", heading: "Old heading", new_heading: "New" });
    assert.equal(store["B.md"], files["B.md"]);
    assert.ok(r.data.skipped.some((s) => s.path === "B.md" && /link form not recognized/.test(s.reason) && s.link === "[t](<A.md#Old heading>)"));
  });

  test("a write that fails after the heading's own note is written is reported, and the result names what did change", async () => {
    const { app, store } = fakeVault(FILES, { throws: { "B.md": "disk full" } });
    const r = await tool(app)({ path: "A.md", heading: "Old heading", new_heading: "New name" });
    assert.equal(r.isError, undefined, "the rename happened, so the call is not an error");
    assert.match(store["A.md"], /## New name/);
    assert.equal(store["B.md"], FILES["B.md"]);
    assert.ok(r.data.skipped.some((s) => s.path === "B.md" && /write failed \(disk full\); 4 link\(s\) not rewritten/.test(s.reason)));
    assert.ok(r.data.files.includes("A.md") && !r.data.files.includes("B.md"));
    const own = fakeVault(FILES, { throws: { "A.md": "disk full" } });
    const r2 = await tool(own.app)({ path: "A.md", heading: "Old heading", new_heading: "New name" });
    assert.match(r2.error, /disk full/);
    assert.deepEqual(own.store, FILES, "a failure on the heading's own note writes nothing anywhere");
  });

  test("the scan is contained by the allowlist, and says so", async () => {
    const { app, store } = fakeVault(FILES);
    const r = await tool(app, { getSettings: () => ({ allowlist: ["A.md"] }) })({ path: "A.md", heading: "Old heading", new_heading: "New name" });
    assert.equal(store["B.md"], FILES["B.md"], "outside the allowlist: not read, not rewritten");
    assert.deepEqual(r.data.files, ["A.md"]);
    assert.equal(r.data.scoped_to_allowlist, true);
    assert.ok(!JSON.stringify(r.data).includes("B.md"), "and not named");
  });

  test("a note that changed since the cache read it is skipped, not rewritten blind; if it is the heading's own note, nothing at all is written", async () => {
    const other = fakeVault(FILES, { stale: { "B.md": "someone rewrote this\n" } });
    const r = await tool(other.app)({ path: "A.md", heading: "Old heading", new_heading: "New name" });
    assert.equal(other.store["B.md"], "someone rewrote this\n", "the changed text is kept");
    assert.ok(r.data.skipped.some((s) => s.path === "B.md" && /changed since the cache read it/.test(s.reason)));
    assert.match(other.store["A.md"], /## New name/);
    const own = fakeVault(FILES, { stale: { "A.md": "# Title\n\n## Old heading\nEDITED\n\nsee [[#Old heading]]\n" } });
    const r2 = await tool(own.app)({ path: "A.md", heading: "Old heading", new_heading: "New name" });
    assert.match(r2.error, /A\.md changed since the cache read it; nothing was renamed or rewritten/);
    assert.equal(own.store["B.md"], FILES["B.md"], "no other note was touched");
  });

  test("the descriptions tell agents to use this tool, and why (Nelson: 'renaming a heading using that tool is preferable because it rewrites links')", async () => {
    let desc = "";
    registerVaultWriteTools({ registerTool: (name, def) => { if (name === "obsidian_rename_heading") desc = def.description; } }, fakeVault(FILES).app, {});
    assert.match(desc, /^USE THIS TOOL TO RENAME A HEADING — not obsidian_patch_note, obsidian_write_note or any other text edit/);
    const { FS_TOOLS } = await import("@vault-mcp/core");
    const d = (n) => FS_TOOLS.find((t) => t.name === n)?.description ?? "";
    assert.match(d("obsidian_patch_note"), /To RENAME a heading, use `obsidian_rename_heading`/);
    assert.match(d("obsidian_write_note"), /to rename a heading, use `obsidian_rename_heading`/);
  });
});

describe("obsidian_rename_heading honours the record folders too (#482, PR #485 round 4)", () => {
  test("a note that is a record only by its folder keeps its heading link as written", async () => {
    const { inRecordFolder } = await import("../src/mcp/records.ts");
    const folders = { enabled: true, folders: ["Recs"], archivePattern: "" };
    const { app, store } = fakeVault({ ...FILES, "Recs/log.md": "cited [[A#Old heading]]\n" });
    // What server.ts hands the tool: the marker (here: none) OR the record folders.
    const isRecord = (p) => inRecordFolder(p, folders);
    await tool(app, { isRecord })({ path: "A.md", heading: "Old heading", new_heading: "New name" });
    assert.equal(store["Recs/log.md"], "cited [[A#Old heading]]\n", "the folder record is left as written");
    assert.match(store["B.md"], /\[\[A#New name\|alias\]\]/, "a living note is still rewritten");
  });

  test("server.ts gives rename_heading the marker OR the record folders, read live", async () => {
    const fs = await import("node:fs");
    const server = fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    assert.match(server, /probe\.record\?\.\(p\) === true\) return true;\s*return inRecordFolder\(p, normalizeRecordFolders\(ctx\.recordFolders\?\.\(\)\)\);/);
    assert.match(server, /isRecord: isRecordForRename/);
  });
});


// #614: the link rewrites of a heading rename pass the same written-content guard
// as a write of the note. This road writes only at the body positions the cache
// records and never rewrites a frontmatter link (it reports one), so the guard
// is what keeps a stale position or a note whose frontmatter the guard cannot
// read from being written blind.
describe("#614 obsidian_rename_heading's link rewrites pass the written-content guard", () => {
  const H = { "A.md": "## Old heading\ntext\n" };
  test("a link inside a verified value is not rewritten and is reported; an ordinary frontmatter link is reported as before; the body is rewritten", async () => {
    const files = { ...H, "V.md": "---\nverified: \"[[A#Old heading]]\"\n---\nbody [[A#Old heading]]\n", "O.md": "---\nsee: \"[[A#Old heading]]\"\n---\nbody [[A#Old heading]]\n" };
    const { app, store } = fakeVault(files);
    const r = await tool(app)({ path: "A.md", heading: "Old heading", new_heading: "New" });
    assert.equal(r.error, undefined, r.error);
    assert.equal(store["V.md"], "---\nverified: \"[[A#Old heading]]\"\n---\nbody [[A#New]]\n", "the verified value keeps its link; the body link, which the guard admits, is rewritten");
    assert.ok(r.data.skipped.some((s) => s.path === "V.md" && /frontmatter link in 'verified'/.test(s.reason)), JSON.stringify(r.data.skipped));
    assert.ok(r.data.skipped.some((s) => s.path === "O.md" && /frontmatter link in 'see'/.test(s.reason)));
    assert.equal(store["O.md"], "---\nsee: \"[[A#Old heading]]\"\n---\nbody [[A#New]]\n", "the body link is rewritten, the frontmatter link is not (as before)");
    assert.deepEqual(r.data.files, ["A.md", "O.md", "V.md"]);
  });

  test("a note whose guarded key YAML reads differently is left unchanged and reported, in a dry run too", async () => {
    const diverge = "---\nverified: \"a\\\\b\"\n---\nbody [[A#Old heading]]\n";
    for (const dry_run of [false, true]) {
      const { app, store } = fakeVault({ ...H, "D.md": diverge, "B.md": "x [[A#Old heading]]\n" });
      const r = await tool(app)({ path: "A.md", heading: "Old heading", new_heading: "New", dry_run });
      assert.equal(store["D.md"], diverge);
      assert.ok(r.data.skipped.some((s) => s.path === "D.md" && /^accept_forbidden: .*cannot read as YAML does/.test(s.reason)), JSON.stringify(r.data.skipped));
      assert.deepEqual(r.data.files, ["A.md", "B.md"]);
      if (!dry_run) assert.equal(store["B.md"], "x [[A#New]]\n");
    }
  });

  test("the heading's own note refused by the guard: nothing anywhere is written", async () => {
    const own = "---\nverified: \"a\\\\b\"\n---\n## Old heading\n";
    const { app, store } = fakeVault({ "A.md": own, "B.md": "x [[A#Old heading]]\n" });
    const r = await tool(app)({ path: "A.md", heading: "Old heading", new_heading: "New" });
    assert.match(r.error, /cannot read as YAML does/);
    assert.equal(store["A.md"], own);
    assert.equal(store["B.md"], "x [[A#Old heading]]\n");
  });
});
