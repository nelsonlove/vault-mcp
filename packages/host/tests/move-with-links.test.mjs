/**
 * move-with-links.test.mjs — a move that renames at the file level and rewrites
 * its own backlinks (Nelson's "B", 2026-09-29: "Let's try be and run tests
 * looking for damage"). Obsidian's renameFile waited for a clean metadata cache,
 * minutes per move under the fleet's write load.
 *
 * The fake app behaves like Obsidian where it matters: links resolve by path or
 * by basename (same folder first, then shortest path), the cache records
 * positions and a per-file mtime/size, a stale cache entry is possible, and
 * `vault.rename` does NOT update `resolvedLinks` (the index lags).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile, TFolder, parseYaml } from "./obsidian-stub.mjs";
import { parseLinks, rewriteLink, relativePath } from "../src/mcp/link-rewrite.ts";

installObsidianStub();
const { moveWithLinks, TextCache } = await import("../src/mcp/move-with-links.ts");
const { recordTest } = await import("../src/mcp/records.ts");
const { LEGACY_RECORD_FOLDERS_SEED } = await import("../src/record-folders-policy.ts");
const { DEFAULT_RECORD_IDENTIFICATION: SEED_ID } = await import("../src/kernel/record-guard.ts");
// The record rules this vault was seeded with (#482): the plugin itself ships no record folders.
const SEEDED = () => ({ ...SEED_ID, folders: LEGACY_RECORD_FOLDERS_SEED });
const { RECORDS_LEFT_CAP } = await import("../src/mcp/move-with-links.ts");

const stripMd = (s) => s.replace(/\.md$/i, "");
const base = (p) => stripMd(p.split("/").pop());
const folder = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function fakeApp(files, { stale = [], wrongCache = {}, throwOn = [], changeBeforeProcess = {} } = {}) {
  const text = new Map(Object.entries(files));
  const tfiles = new Map();
  let clock = 1000;
  const mk = (p) => { const f = new TFile(p); f.stat = { mtime: clock++, size: text.get(p).length }; return f; };
  for (const p of text.keys()) tfiles.set(p, mk(p));
  const all = () => [...tfiles.values()];
  const resolve = (linkpath, source) => {
    if (!linkpath) return null;
    let lp = linkpath;
    if (/^\.\.?\//.test(lp)) {
      const parts = folder(source) ? folder(source).split("/") : [];
      for (const seg of lp.split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
      lp = parts.join("/");
    }
    const exact = tfiles.get(lp) ?? tfiles.get(`${lp}.md`);
    if (exact) return exact;
    if (lp.includes("/")) return all().find((f) => stripMd(f.path).toLowerCase().endsWith("/" + stripMd(lp).toLowerCase())) ?? null;
    const same = all().filter((f) => base(f.path).toLowerCase() === stripMd(lp).toLowerCase());
    if (same.length === 0) return null;
    return same.find((f) => folder(f.path) === folder(source)) ?? same.sort((a, b) => a.path.length - b.path.length)[0];
  };
  const cacheOf = (p, t) => {
    const links = [], embeds = [], frontmatterLinks = [];
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(t);
    if (fm) for (const m of fm[1].matchAll(/^(\w+):\s*"(\[\[([^\]|]+)(?:\|[^\]]*)?\]\])"/gm)) frontmatterLinks.push({ key: m[1], link: m[3], original: m[2] });
    for (const l of parseLinks(t)) {
      if (fm && l.start < fm[0].length) continue;
      (l.embed ? embeds : links).push({ link: l.linkpath + l.subpath, original: l.original, position: { start: { offset: l.start }, end: { offset: l.end } } });
    }
    // The frontmatter and inline tags, as Obsidian's cache holds them: what the kernel's record probe reads (01.44 rule 8, #397).
    const frontmatter = fm ? parseYaml(fm[1]) : undefined;
    const tags = [...t.slice(fm ? fm[0].length : 0).matchAll(/(?:^|\s)(#[\w/-]+)/g)].map((m) => ({ tag: m[1] }));
    return { links, embeds, frontmatterLinks, tags, ...(frontmatter ? { frontmatter } : {}) };
  };
  const caches = new Map();
  const fileCache = {};
  const resolvedLinks = {};
  for (const [p, t] of text) {
    const src = wrongCache[p] ?? t; // a cache built from different text: the index is wrong about this note
    caches.set(p, cacheOf(p, src));
    fileCache[p] = { mtime: tfiles.get(p).stat.mtime, size: tfiles.get(p).stat.size };
    resolvedLinks[p] = {};
    for (const l of [...caches.get(p).links, ...caches.get(p).embeds]) {
      const d = resolve(l.link.split("#")[0], p);
      if (d) resolvedLinks[p][d.path] = (resolvedLinks[p][d.path] ?? 0) + 1;
    }
  }
  // A stale note: written after the cache read it (new text, same cache).
  for (const [p, newText] of Object.entries(stale)) { text.set(p, newText); tfiles.get(p).stat = { mtime: clock++, size: newText.length }; }
  const calls = { renameFile: 0, vaultRename: [] };
  // Every write moves the file's mtime and size, as on disk.
  const write = (p, t) => { text.set(p, t); tfiles.get(p).stat = { mtime: clock++, size: t.length }; };
  const app = {
    vault: {
      getMarkdownFiles: all,
      getAbstractFileByPath: (p) => tfiles.get(p) ?? null,
      read: async (f) => text.get(f.path),
      cachedRead: async (f) => text.get(f.path),
      async rename(f, to) {
        calls.vaultRename.push([f.path, to]);
        const t = text.get(f.path); text.delete(f.path); tfiles.delete(f.path);
        const old = f.path;
        f.path = to; f.basename = base(to); f.name = to.split("/").pop();
        text.set(to, t); tfiles.set(to, f);
        // Obsidian re-keys the per-file cache on rename, but resolvedLinks lags.
        caches.set(to, caches.get(old)); caches.delete(old); fileCache[to] = fileCache[old]; delete fileCache[old];
      },
      async process(f, fn) {
        if (throwOn.includes(f.path)) throw new Error("disk full");
        if (changeBeforeProcess[f.path]) { write(f.path, changeBeforeProcess[f.path]); delete changeBeforeProcess[f.path]; }
        const next = fn(text.get(f.path));
        write(f.path, next);
        return next;
      },
    },
    metadataCache: {
      resolvedLinks,
      fileCache,
      getFileCache: (f) => caches.get(f.path) ?? null,
      getFirstLinkpathDest: resolve,
      fileToLinktext(f, source, omitMd) {
        const unique = all().filter((g) => base(g.path).toLowerCase() === f.basename.toLowerCase()).length === 1;
        const t = unique ? f.basename : stripMd(f.path);
        return omitMd ? t : `${t}.md`;
      },
    },
    fileManager: { async renameFile() { calls.renameFile++; throw new Error("the move must not wait on renameFile"); } },
  };
  return { app, text, tfiles, calls, write };
}

describe("link-rewrite rules", () => {
  test("parseLinks finds wikilinks, embeds, aliases, subpaths and markdown links, skips code and math, and keeps links in %% comments (Obsidian indexes those)", () => {
    const t = "a [[X]] b ![[X#H|al]] c [t](X.md) d `[[X]]`\n```\n[[X]]\n```\n$$[[X]]$$ %%[[Y]]%% [u](https://x.org)";
    const ls = parseLinks(t);
    assert.deepEqual(ls.map((l) => [l.kind, l.embed, l.linkpath, l.subpath]), [["wiki", false, "X", ""], ["wiki", true, "X", "#H"], ["markdown", false, "X.md", ""], ["wiki", false, "Y", ""]]);
  });
  test("parseLinks: a name with a bracket pair is a link; in [[a [[b]] c]] only the innermost is; inline code stays on one line", () => {
    assert.deepEqual(parseLinks("see [[[draft] Note|d]] here").map((l) => l.linkpath), ["[draft] Note"]);
    assert.deepEqual(parseLinks("[[a t[[b]]c]]").map((l) => l.original), ["[[b]]"]);
    assert.deepEqual(parseLinks("- one ` lone\n- two [[B]] and `c`\n").map((l) => l.linkpath), ["B"]);
  });
  test("parseLinks follows Obsidian's index on quoted fences, paragraph-wide inline code, escaped backticks and badge links (each seen in the real vault)", () => {
    assert.deepEqual(parseLinks("> ~~~md\n> [[A]]\n> ~~~\n> [[B]]\n").map((l) => l.linkpath), ["B"], "a fence inside a quote hides its lines");
    assert.deepEqual(parseLinks("x `one\ntwo [[A]]` [[B]]\n").map((l) => l.linkpath), ["B"], "inline code runs over a line break inside one paragraph");
    assert.deepEqual(parseLinks("- a ` lone\n- b [[A]] `c`\n# h ` x\n[[B]] `\n").map((l) => l.linkpath), ["A", "B"], "a list item and a heading each start a new block");
    assert.deepEqual(parseLinks("say `\\` then [[A]] and `[[B]]`\n").map((l) => l.linkpath), ["A"], "a backslash does not escape inside code, so `\\` is a span");
    assert.deepEqual(parseLinks("[![badge](https://x.org/b.svg)](Read%20me.md)\n").map((l) => l.linkpath), ["Read me.md"], "a link whose text is an image");
  });
  test("parseLinks: a fence may open on a list item's first line; an escaped backslash does not escape a backtick", () => {
    assert.deepEqual(parseLinks("- ```\n  [[A]]\n  ```\n\nafter [[B]]\n1. ~~~js\n   [[C]]\n   ~~~\n[[D]]\n").map((l) => l.linkpath), ["B", "D"]);
    assert.deepEqual(parseLinks("x \\\\`[[A]]` [[B]]\n").map((l) => l.linkpath), ["B"], "\\\\ is a backslash, so the backtick after it opens code");
    assert.deepEqual(parseLinks("```\n- ```\n```\n[[Me]]\n").map((l) => l.linkpath), ["Me"], "a list item inside a fence does not close it");
    assert.deepEqual(parseLinks("[a `[b](Me.md)` c](Other.md)\n").map((l) => l.linkpath), ["Other.md"], "a link in inline code inside link text is code");
  });
  test("parseLinks stays fast on a large note and on long lines of stray brackets or backticks", () => {
    const big = "line `code` and [[Link]] and [t](Other.md)\n".repeat(17000);
    for (const [name, t] of [["a 700 KB note", big], ["a paragraph of 17,000 lines", big.replace(/\n/g, " ")], ["stray brackets", "[a\\".repeat(50000)], ["stray backticks", "`a ".repeat(100000)], ["unclosed angle destinations", "[a](<x".repeat(80000)]]) {
      const t0 = Date.now();
      parseLinks(t);
      assert.ok(Date.now() - t0 < 1500, `${name}: ${Date.now() - t0} ms`);
    }
  });
  test("rewriteLink changes only the target: alias, subpath, embed marker, display text, title and angle brackets stay", () => {
    const [w] = parseLinks("![[Old#Sec|shown]]");
    assert.equal(rewriteLink(w, "B/New.md", "S.md", "New"), "![[New#Sec|shown]]");
    const [t] = parseLinks("| [[Old\\|alias]] |");
    assert.equal(rewriteLink(t, "B/New.md", "S.md", "New"), "[[New\\|alias]]", "a table's escaped pipe is kept");
    const [m] = parseLinks('[see it](A/Old%20name.md#Sec "t")');
    assert.equal(rewriteLink(m, "B/New name.md", "S.md", "New name"), '[see it](B/New%20name.md#Sec "t")');
    const [r] = parseLinks("[x](../A/Old.md)");
    assert.equal(rewriteLink(r, "B/C/New.md", "D/S.md", "New"), "[x](../B/C/New.md)");
    const [a] = parseLinks("[x](<A/Old one.md>)");
    assert.equal(rewriteLink(a, "B/New one.md", "S.md", "New one"), "[x](<B/New one.md>)");
    assert.equal(relativePath("A/B", "A/C/N.md"), "../C/N.md");
    assert.equal(relativePath("", "N.md"), "./N.md");
  });
});

describe("moveWithLinks", () => {
  test("renames without renameFile, rewrites every backlink form, leaves every other link alone, and checks clean", async () => {
    const { app, text, calls } = fakeApp({
      "A/Old.md": "# Old\nsee [other](../C/Other.md) and [[#Old]]\n",
      "S/One.md": "x [[Old]] y ![[Old#Sec|al]] z [md](../A/Old.md) w [[Other]]\n",
      "S/Two.md": "---\nup: \"[[Old]]\"\n---\nbody [[A/Old|full]]\n",
      "C/Other.md": "no links here, and `[[Old]]` in code\n",
    });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(calls.renameFile, 0, "no wait for a clean metadata cache");
    assert.deepEqual(calls.vaultRename, [["A/Old.md", "B/New.md"]]);
    assert.equal(text.get("S/One.md"), "x [[New]] y ![[New#Sec|al]] z [md](../B/New.md) w [[Other]]\n");
    assert.equal(text.get("S/Two.md"), "---\nup: \"[[New]]\"\n---\nbody [[New|full]]\n");
    assert.equal(text.get("C/Other.md"), "no links here, and `[[Old]]` in code\n", "a link inside code is not a link");
    assert.equal(text.get("B/New.md"), "# Old\nsee [other](../C/Other.md) and [[#Old]]\n", "the moved note's relative link still reaches its target from the new folder");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.links_rewritten, 5);
    assert.deepEqual(r.files_rewritten.sort(), ["S/One.md", "S/Two.md"]);
  });

  test("the moved note's own relative links are rewritten when its folder depth changes", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "[o](../C/Other.md)\n", "C/Other.md": "x\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/D/New.md");
    assert.equal(text.get("B/D/New.md"), "[o](../../C/Other.md)\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a note written moments before (its index entry stale) is still rewritten: the risk the ruling named", async () => {
    const { app, text } = fakeApp(
      { "A/Old.md": "x\n", "S/Fresh.md": "nothing yet\n" },
      { stale: { "S/Fresh.md": "just added [[Old]] and [t](../A/Old.md)\n" } }
    );
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(text.get("S/Fresh.md"), "just added [[New]] and [t](../B/New.md)\n");
    assert.ok(r.stale_sources >= 1);
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a note that changed between the plan and the write is rewritten from its current text", async () => {
    const { app, text } = fakeApp(
      { "A/Old.md": "x\n", "S/One.md": "a [[Old]]\n" },
      { changeBeforeProcess: { "S/One.md": "PREPENDED LINE\na [[Old]] and ![[Old]]\n" } }
    );
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(text.get("S/One.md"), "PREPENDED LINE\na [[New]] and ![[New]]\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a link the index does not know is found from the note's text and rewritten", async () => {
    const { app, text } = fakeApp(
      { "A/Old.md": "x\n", "S/Hidden.md": "a [[Old]]\n" },
      { wrongCache: { "S/Hidden.md": "a note with no links\n" } }
    );
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(text.get("S/Hidden.md"), "a [[New]]\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a link inside a frontmatter string (not a property link, so not indexed) is rewritten too", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/F.md": "---\ndescription: \"see [[Old]] rule 8\"\nabout:\n  - link: \"[[Old]]\"\n---\nbody\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(text.get("S/F.md"), "---\ndescription: \"see [[New]] rule 8\"\nabout:\n  - link: \"[[New]]\"\n---\nbody\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("damage is REPORTED, never silent: a note the index says links the note, where its text has no link, makes ok false", async () => {
    const { app } = fakeApp(
      { "A/Old.md": "x\n", "S/Ghost.md": "no link here\n" },
      { wrongCache: { "S/Ghost.md": "a [[Old]]\n" } }
    );
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(r.ok, false);
    assert.deepEqual(r.index_only, ["S/Ghost.md"]);
  });

  test("a current index entry counting more links than the text scan found is reported, and ok is false", async () => {
    const { app } = fakeApp({ "A/Old.md": "x\n", "S/P.md": "one [[Old]] here\n" }, { wrongCache: { "S/P.md": "[[Old]] and [[Old]]\n" } });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(r.ok, false);
    assert.deepEqual(r.index_only, ["S/P.md"]);
  });

  test("a same-note heading link [[#H]] in the moved note is not reported as missing", async () => {
    const { app } = fakeApp({ "A/Old.md": "# H\nsee [[#H]]\n" });
    app.metadataCache.resolvedLinks["A/Old.md"] = { "A/Old.md": 1 };
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("inline code never spans a blank line: a link after an unclosed backtick in another paragraph is still found", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/C.md": "a lone ` backtick\n\nthen [[Old]] and `code`\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(text.get("S/C.md"), "a lone ` backtick\n\nthen [[New]] and `code`\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a note that cannot be written is reported under failed, and ok is false", async () => {
    const { app } = fakeApp({ "A/Old.md": "x\n", "S/One.md": "a [[Old]]\n" }, { throwOn: ["S/One.md"] });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(r.ok, false);
    assert.deepEqual(r.failed, [{ path: "S/One.md", reason: "disk full" }]);
    assert.ok(r.still_linking_old.some((x) => x.path === "S/One.md"));
  });

  test("a link to ANOTHER note that shares the basename is not touched", async () => {
    const { app, text } = fakeApp({ "A/Note.md": "x\n", "Z/Note.md": "z\n", "Z/S.md": "[[Note]] resolves to Z/Note by folder\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Note.md"), "B/Note2.md");
    assert.equal(text.get("Z/S.md"), "[[Note]] resolves to Z/Note by folder\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a batch shares one read of the vault: the second move sees the first move's rewrite", async () => {
    const { app, text } = fakeApp({ "A/One.md": "1\n", "A/Two.md": "2\n", "S/Both.md": "[[One]] and [[Two]] and [[One#H]]\n" });
    const texts = new TextCache(app);
    const r1 = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/One.md"), "B/Uno.md", { texts });
    const r2 = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Two.md"), "B/Dos.md", { texts });
    assert.equal(text.get("S/Both.md"), "[[Uno]] and [[Dos]] and [[Uno#H]]\n");
    assert.equal(r1.ok && r2.ok, true, JSON.stringify([r1, r2]));
  });

  test("update_backlinks: false renames only, and says so by rewriting nothing", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/One.md": "a [[Old]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { updateBacklinks: false });
    assert.equal(text.get("S/One.md"), "a [[Old]]\n");
    assert.equal(r.links_rewritten, 0);
  });

  test("a fenced block hides every line up to its close, and a link after the block is found (review #1)", async () => {
    const note = "```js\nconst a = \"[[Old]]\";\n[[Old]]\n```\nafter [[Old]]\n  ~~~~\n  [[Old]]\n  ~~~\n  ~~~~~\nlast [[Old]]\n```\nunclosed [[Old]]\n";
    assert.deepEqual(parseLinks(note).map((l) => note.slice(0, l.start).split("\n").length), [5, 10]);
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/F.md": note });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(text.get("S/F.md"), note.replace("after [[Old]]", "after [[New]]").replace("last [[Old]]", "last [[New]]"));
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a markdown destination with balanced parentheses is one link (review #4)", async () => {
    assert.deepEqual(parseLinks("[x](A/Old%20(1).md#H) y").map((l) => [l.original, l.linkpath, l.subpath]), [["[x](A/Old%20(1).md#H)", "A/Old (1).md", "#H"]]);
    const { app, text } = fakeApp({ "A/Old (1).md": "x\n", "S/P.md": "see [x](A/Old%20(1).md#H) and [[Old (1)]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old (1).md"), "B/New (2).md");
    assert.equal(text.get("S/P.md"), "see [x](B/New%20%282%29.md#H) and [[New (2)]]\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a fence opened on a list item hides its link, and the real link after it is rewritten (review A)", async () => {
    const note = "- ```\n  [[Old]]\n  ```\n\nafter [[Old]]\n";
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/L.md": note });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(text.get("S/L.md"), "- ```\n  [[Old]]\n  ```\n\nafter [[New]]\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a link inside a link's image text is rewritten with the outer one (review B)", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/I.md": "[![alt](../A/Old.md)](../A/Old.md) and [![b](Pic.md)](../A/Old.md)\n", "S/Pic.md": "p\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(text.get("S/I.md"), "[![alt](../B/New.md)](../B/New.md) and [![b](Pic.md)](../B/New.md)\n");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.links_rewritten, 3);
  });

  test("a subpath is written back as it was written, encoded characters included (review C)", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/H.md": "[x](../A/Old.md#a%29%25b) [y](<../A/Old.md#c d>)\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(text.get("S/H.md"), "[x](../B/New.md#a%29%25b) [y](<../B/New.md#c d>)\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a note whose only link is %20-encoded, or written in the other Unicode form, is found (review #3)", async () => {
    const nfd = "Café note";
    const { app, text } = fakeApp({ "A/Old name.md": "x\n", "S/E.md": "[x](../A/Old%20name.md)\n", "A/Café note.md": "y\n", "S/N.md": `[[${nfd}]]\n` });
    const r1 = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old name.md"), "B/New name.md");
    assert.equal(text.get("S/E.md"), "[x](../B/New%20name.md)\n");
    const r2 = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Café note.md"), "B/Moved.md");
    assert.equal(text.get("S/N.md"), "[[Moved]]\n");
    assert.equal(r1.ok && r2.ok, true, JSON.stringify([r1, r2]));
  });

  test("the moved note's own relative links in angle brackets and relative wikilinks are rewritten (review #2)", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "[o](<../C/Other one.md>) and [[../C/Other one|w]] and ![[./Pic.md]]\n", "C/Other one.md": "x\n", "A/Pic.md": "p\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/D/New.md");
    assert.equal(text.get("B/D/New.md"), "[o](<../../C/Other one.md>) and [[../../C/Other one|w]] and ![[../../A/Pic.md]]\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a relative wikilink to the moved note stays relative", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/R.md": "[[../A/Old#H]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/C/New.md");
    assert.equal(text.get("S/R.md"), "[[../B/C/New#H]]\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a relative link of the moved note that could not be rewritten is reported, and ok is false (review #2)", async () => {
    const { app } = fakeApp({ "A/Old.md": "[o](../C/Other.md)\n", "C/Other.md": "x\n" }, { throwOn: ["B/D/New.md"] });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/D/New.md");
    assert.equal(r.ok, false);
    assert.deepEqual(r.own_links_broken, [{ target: "C/Other.md", before: 1, after: 0 }]);
  });

  test("the moved note's own links are rewritten from its current text when it changed mid-move", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "[o](../C/Other.md)\n", "C/Other.md": "x\n" }, { changeBeforeProcess: { "B/D/New.md": "NEW LINE\n[o](../C/Other.md)\n" } });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/D/New.md");
    assert.equal(text.get("B/D/New.md"), "NEW LINE\n[o](../../C/Other.md)\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("update_backlinks: false leaves the moved note's own links alone too (review #5)", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "[o](../C/Other.md)\n", "C/Other.md": "x\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/D/New.md", { updateBacklinks: false });
    assert.equal(text.get("B/D/New.md"), "[o](../C/Other.md)\n");
    assert.equal(r.links_rewritten, 0);
  });

  test("a batch's shared text sees a write made between two moves by someone else (review #6)", async () => {
    // S/X is read (and cached) by the first move's scan, but not rewritten by it.
    const { app, text, write } = fakeApp({ "A/One.md": "1\n", "A/Two.md": "2\n", "S/X.md": "nothing yet\n" });
    const texts = new TextCache(app);
    await moveWithLinks(app, app.vault.getAbstractFileByPath("A/One.md"), "B/Uno.md", { texts });
    write("S/X.md", "now [[Two]]\n"); // the editor, another plugin, a sync
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Two.md"), "B/Dos.md", { texts });
    assert.equal(text.get("S/X.md"), "now [[Dos]]\n");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("counts name only what the caller may see: a hidden note's rewrite is in neither count (review #8)", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "Secret/S.md": "a [[Old]] [[Old]]\n", "S/V.md": "[[Old]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { visible: (p) => !p.startsWith("Secret/") });
    assert.equal(text.get("Secret/S.md"), "a [[New]] [[New]]\n", "the hidden note is still healed");
    assert.deepEqual([r.links_rewritten, r.files_rewritten, r.ok], [1, ["S/V.md"], true]);
  });

  test("a note outside the caller's view is counted, never named, and its damage still makes ok false", async () => {
    const { app } = fakeApp({ "A/Old.md": "x\n", "Secret/S.md": "a [[Old]]\n" }, { throwOn: ["Secret/S.md"] });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { visible: (p) => !p.startsWith("Secret/") });
    assert.equal(r.ok, false);
    assert.ok(r.hidden >= 1);
    assert.ok(!JSON.stringify(r).includes("Secret/"));
  });
});

describe("records are never rewritten (01.44 rule 8)", () => {
  const ARCH = "00-09 System/00 System management/00.09 Archive";

  test("recordTest: any JD archive folder, the agent record folders, and the record key; nothing else", () => {
    const { app } = fakeApp({
      "Live/Keyed.md": "---\nrecord: true\n---\nx\n",
      "Live/Plain.md": "---\nrecord: false\n---\nx\n",
    });
    const is0 = recordTest(SEEDED);
    const is = (p) => is0(p, ""); // by folder alone: a note with no key
    const keyed = (p) => is0(p, p === "Live/Keyed.md" ? "---\nrecord: true\n---\nx\n" : p === "Live/Plain.md" ? "---\nrecord: false\n---\nx\n" : "");
    assert.equal(is(`${ARCH}/Old plan.md`), true);
    assert.equal(is(`${ARCH}/Deep/er/Note.md`), true);
    assert.equal(is("40-49 Financial/41 Banking & accounts/41.09 Archive for 41 Banking & accounts/Stmt.md"), true);
    assert.equal(is("00-09 System/03 Agents/03.04 Records/Agent notebook/2026-09/Agent session.md"), true);
    assert.equal(is("00-09 System/03 Agents/03.16 Cross-session log/CROSS-SESSION.md"), true);
    assert.equal(is("00-09 System/03 Agents/03.20 Imported chats/Chat.md"), true);
    assert.equal(keyed("Live/Keyed.md"), true);
    assert.equal(keyed("Live/Plain.md"), false);
    assert.equal(is("00-09 System/06 Repos/06.37 claude-code-plugins/06.37.09 Archive for claude-code-plugins/X.md"), true, "the dotted JD form");
    assert.equal(is("Projects/Archive/Note.md"), false, "a plain Archive folder is not a JD archive");
    assert.equal(is("Projects/00.09 Archived ideas/Note.md"), false, "the folder name must be '.09 Archive' then a space or its end");
    assert.equal(is("00.09 Archive.md"), false, "a note NAMED like an archive is not inside one");
    assert.equal(is("00-09 System/03 Agents/03.04 Records.md"), false);
  });

  test("a record that links the moved note keeps its link as written, is listed in records_left, and the move is still ok", async () => {
    const { app, text } = fakeApp({
      "A/Old.md": "x\n",
      "S/Live.md": "see [[Old]]\n",
      [`${ARCH}/Plan.md`]: "cited [[Old]] and [md](../../../A/Old.md)\n",
      "Live/Keyed.md": "---\nrecord: true\n---\nalso [[Old]]\n",
    });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: recordTest(SEEDED) });
    assert.equal(text.get("S/Live.md"), "see [[New]]\n", "a living note is rewritten as before");
    assert.equal(text.get(`${ARCH}/Plan.md`), "cited [[Old]] and [md](../../../A/Old.md)\n", "the record's bytes are untouched");
    assert.equal(text.get("Live/Keyed.md"), "---\nrecord: true\n---\nalso [[Old]]\n");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(
      [...r.records_left].sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: `${ARCH}/Plan.md`, links: ["[[Old]]", "[md](../../../A/Old.md)"] },
        { path: "Live/Keyed.md", links: ["[[Old]]"] },
      ]
    );
    assert.deepEqual(r.files_rewritten, ["S/Live.md"]);
    assert.deepEqual(r.index_only, [], "the index's record linkers are not flagged as missed");
    assert.deepEqual(r.still_linking_old, []);
  });

  test("a moved record keeps its own relative links as written and lists them; living notes that link it are still rewritten", async () => {
    const { app, text } = fakeApp({
      [`${ARCH}/Old.md`]: "[o](../Other.md) and [[Other]]\n",
      [`00-09 System/00 System management/Other.md`]: "x\n",
      "S/Live.md": "see [[Old]]\n",
    });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath(`${ARCH}/Old.md`), `${ARCH}/Deeper/New.md`, { isRecord: recordTest(SEEDED) });
    assert.equal(text.get(`${ARCH}/Deeper/New.md`), "[o](../Other.md) and [[Other]]\n", "a record's own text is untouched");
    assert.equal(text.get("S/Live.md"), "see [[New]]\n");
    assert.deepEqual(r.records_left, [{ path: `${ARCH}/Deeper/New.md`, links: ["[o](../Other.md)"] }]);
    assert.deepEqual(r.own_links_broken, [], "left on purpose, not damage");
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("records_left names only what the caller may see; the rest are counted in hidden", async () => {
    const { app } = fakeApp({ "A/Old.md": "x\n", [`${ARCH}/Plan.md`]: "cited [[Old]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: recordTest(SEEDED), visible: (p) => !p.startsWith("00-09") });
    assert.deepEqual(r.records_left, []);
    assert.equal(r.hidden, 1);
    assert.equal(r.ok, true);
  });

  test("the record test can be supplied by the caller", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/Mine.md": "[[Old]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: (p) => p === "S/Mine.md" });
    assert.equal(text.get("S/Mine.md"), "[[Old]]\n");
    assert.deepEqual(r.records_left, [{ path: "S/Mine.md", links: ["[[Old]]"] }]);
  });

  test("an un-archived note is living at its new path: its own relative links are healed, nothing is left", async () => {
    const { app, text } = fakeApp({
      [`${ARCH}/Plan.md`]: "[o](../Other.md)\n",
      "00-09 System/00 System management/Other.md": "x\n",
    });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath(`${ARCH}/Plan.md`), "00-09 System/01 Live/Sub/Plan.md", { isRecord: recordTest(SEEDED) });
    assert.equal(text.get("00-09 System/01 Live/Sub/Plan.md"), "[o](../../00%20System%20management/Other.md)\n");
    assert.deepEqual(r.records_left, []);
    assert.deepEqual(r.own_links_broken, []);
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("a folder-only move leaves a record's [[Old]] working, so nothing is listed", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", [`${ARCH}/Plan.md`]: "cited [[Old]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/Old.md", { isRecord: recordTest(SEEDED) });
    assert.equal(text.get(`${ARCH}/Plan.md`), "cited [[Old]]\n");
    assert.deepEqual(r.records_left, []);
    assert.equal(r.records_left_total, 0);
  });

  test("a note keyed record: true moments ago (its cache stale) is judged by its text, and left", async () => {
    const { app, text } = fakeApp(
      { "A/Old.md": "x\n", "S/New record.md": "nothing yet\n" },
      { stale: { "S/New record.md": "---\nrecord: true\n---\ncited [[Old]]\n" } }
    );
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: recordTest(SEEDED) });
    assert.equal(text.get("S/New record.md"), "---\nrecord: true\n---\ncited [[Old]]\n");
    assert.deepEqual(r.records_left, [{ path: "S/New record.md", links: ["[[Old]]"] }]);
  });

  test("a moved record that links itself is listed once, under its new path", async () => {
    const { app, text } = fakeApp({ [`${ARCH}/Old.md`]: "see [[Old]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath(`${ARCH}/Old.md`), `${ARCH}/New.md`, { isRecord: recordTest(SEEDED) });
    assert.equal(text.get(`${ARCH}/New.md`), "see [[Old]]\n");
    assert.deepEqual(r.records_left, [{ path: `${ARCH}/New.md`, links: ["[[Old]]"] }]);
  });

  test("a record the index says links the note, where the text gave no link, is listed as index_only", async () => {
    const { app } = fakeApp(
      { "A/Old.md": "x\n", [`${ARCH}/Plan.md`]: "cited [[Old]]\n" },
      { stale: { [`${ARCH}/Plan.md`]: "the link is gone from the text\n" } }
    );
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: recordTest(SEEDED) });
    assert.deepEqual(r.records_left, [{ path: `${ARCH}/Plan.md`, links: [], index_only: true }]);
    assert.deepEqual(r.index_only, []);
  });

  test("records_left is capped; records_left_total counts them all", async () => {
    const files = { "A/Old.md": "x\n" };
    for (let i = 0; i < RECORDS_LEFT_CAP + 5; i++) files[`${ARCH}/R${i}.md`] = "cited [[Old]]\n";
    const { app } = fakeApp(files);
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: recordTest(SEEDED) });
    assert.equal(r.records_left.length, RECORDS_LEFT_CAP);
    assert.equal(r.records_left_total, RECORDS_LEFT_CAP + 5);
    assert.equal(r.ok, true);
  });

  test("a record folder's own folder note is its living index, healed like any living note", async () => {
    const R = "00-09 System/03 Agents/03.04 Records";
    const { app, text } = fakeApp({
      [`${R}/Agent friction log.md`]: "x\n",
      [`${R}/03.04 Records.md`]: "see [[00-09 System/03 Agents/03.04 Records/Agent friction log]]\n",
      [`${ARCH}/00.09 Archive.md`]: "index [[Agent friction log]]\n",
    });
    const is = (p) => recordTest(SEEDED)(p, "");
    assert.equal(is(`${R}/03.04 Records.md`), false);
    assert.equal(is(`${ARCH}/00.09 Archive.md`), false);
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath(`${R}/Agent friction log.md`), `${R}/Friction log.md`, { isRecord: recordTest(SEEDED) });
    assert.equal(text.get(`${R}/03.04 Records.md`), "see [[Friction log]]\n");
    assert.equal(text.get(`${ARCH}/00.09 Archive.md`), "index [[Friction log]]\n");
    assert.deepEqual(r.records_left, []);
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("record: True and record: true with a comment are records, read from text as from the cache", async () => {
    const { app } = fakeApp({ "S/A.md": "---\nrecord: True\n---\n", "S/B.md": "---\nrecord: true  # since 2026-09\n---\n", "S/C.md": "---\nrecord: truthy\n---\n" });
    const is = recordTest(SEEDED);
    assert.equal(is("S/A.md", "---\nrecord: True\n---\n"), true);
    assert.equal(is("S/B.md", "---\nrecord: true  # since 2026-09\n---\n"), true);
    assert.equal(is("S/C.md", "---\nrecord: truthy\n---\n"), false);
  });

  test("a note made a record between the scan and its rewrite is left as written and listed", async () => {
    const { app, text } = fakeApp(
      { "A/Old.md": "x\n", "S/Live.md": "see [[Old]]\n" },
      { changeBeforeProcess: { "S/Live.md": "---\nrecord: true\n---\nsee [[Old]]\n" } }
    );
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: recordTest(SEEDED) });
    assert.equal(text.get("S/Live.md"), "---\nrecord: true\n---\nsee [[Old]]\n");
    assert.deepEqual(r.records_left, [{ path: "S/Live.md", links: ["[[Old]]"] }]);
    assert.deepEqual(r.not_reaching_new, []);
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("records_left_total counts hidden records too", async () => {
    const { app } = fakeApp({ "A/Old.md": "x\n", [`${ARCH}/P.md`]: "cited [[Old]]\n", "Z/R.md": "---\nrecord: true\n---\n[[Old]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: recordTest(SEEDED), visible: (p) => !p.startsWith("00-09") });
    assert.equal(r.records_left_total, 2);
    assert.deepEqual(r.records_left.map((x) => x.path), ["Z/R.md"]);
    assert.equal(r.hidden, 1);
  });

  test("the operator's tag identification (#397): a note tagged in frontmatter or inline is left; record: true alone is not a record then", async () => {
    const tagId = { method: "tag", property: "record", value: "true", tag: "historical" };
    const { app, text } = fakeApp({
      "A/Old.md": "x\n",
      "S/Fm.md": "---\ntags: [historical, x]\n---\nsee [[Old]]\n",
      "S/Inline.md": "cited [[Old]] #historical\n",
      "S/Code.md": "`#historical` [[Old]]\n",
      "S/Keyed.md": "---\nrecord: true\n---\n[[Old]]\n",
    });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: recordTest(() => ({ folders: LEGACY_RECORD_FOLDERS_SEED, ...tagId })) });
    assert.equal(text.get("S/Fm.md"), "---\ntags: [historical, x]\n---\nsee [[Old]]\n");
    assert.equal(text.get("S/Inline.md"), "cited [[Old]] #historical\n");
    assert.equal(text.get("S/Code.md"), "`#historical` [[New]]\n", "a tag inside code is no tag");
    assert.equal(text.get("S/Keyed.md"), "---\nrecord: true\n---\n[[New]]\n", "the operator chose a tag, so the key marks nothing");
    assert.deepEqual(r.records_left.map((x) => x.path).sort(), ["S/Fm.md", "S/Inline.md"]);
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test("the operator's own property and value (#397) mark a record, judged on the text", () => {
    const id = { method: "property", property: "kind", value: "Record", tag: "record" };
    const is = recordTest(() => ({ folders: LEGACY_RECORD_FOLDERS_SEED, ...id }));
    assert.equal(is("S/K.md", "---\nkind: record\n---\n"), true);
    assert.equal(is("S/R.md", "---\nrecord: true\n---\n"), false);
  });

  test("record: \"true\" counts, as the kernel's isRecordFlag counts it; record: true#x is a string and does not", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/Q.md": "---\nrecord: \"true\"\n---\n[[Old]]\n", "S/H.md": "---\nrecord: true#x\n---\n[[Old]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: recordTest(SEEDED) });
    assert.equal(text.get("S/Q.md"), "---\nrecord: \"true\"\n---\n[[Old]]\n");
    assert.equal(text.get("S/H.md"), "---\nrecord: true#x\n---\n[[New]]\n");
    assert.deepEqual(r.records_left, [{ path: "S/Q.md", links: ["[[Old]]"] }]);
  });

  test("only the record ROOT's folder note is living: a folder note nested inside a record folder is a record", () => {
    const { app } = fakeApp({ "x.md": "x\n" });
    const is = (p) => recordTest(SEEDED)(p, "");
    assert.equal(is(`${ARCH}/00.09 Archive.md`), false);
    assert.equal(is(`${ARCH}/Old project/Old project.md`), true);
    assert.equal(is("00-09 System/03 Agents/03.04 Records/03.04 Records.md"), false);
    assert.equal(is("00-09 System/03 Agents/03.04 Records/Agent notebook/Agent notebook.md"), true);
    assert.equal(is(`${ARCH}/41.09 Archive for x/41.09 Archive for x.md`), true, "an archive inside an archive: the outer one is the root");
  });

  test("the move tools wire the operator's identification, and the record-immutability toggle does not reach a move", async () => {
    const { registerVaultWriteTools } = await import("../src/mcp/tools-vault-write.ts");
    const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
    const tagId = { method: "tag", property: "record", value: "true", tag: "historical" };
    const files = { "A/Old.md": "x\n", "S/T.md": "cited [[Old]] #historical\n" };
    {
      const { app, text } = fakeApp({ ...files });
      let handler;
      // isRecord: () => false is the probe with enforcement switched off (it answers "cannot tell").
      registerVaultWriteTools({ registerTool: (name, _def, h) => { if (name === "obsidian_move_notes") handler = h; } }, app, { isRecord: () => false, recordIdentification: () => tagId });
      const res = await handler({ moves: [{ from: "A/Old.md", to: "B/New.md" }], overwrite: false });
      assert.equal(text.get("S/T.md"), "cited [[Old]] #historical\n", JSON.stringify(res));
    }
    {
      const { app, text } = fakeApp({ ...files });
      const r = await new ObsidianBackend(app, undefined, undefined, () => tagId).moveNote("A/Old.md", "B/New.md", { update_backlinks: true, overwrite: false });
      assert.equal(text.get("S/T.md"), "cited [[Old]] #historical\n");
      assert.deepEqual(r.link_check.records_left, [{ path: "S/T.md", links: ["[[Old]]"] }]);
    }
  });

  test("a keyed record stays a record wherever it moves; a record only by its folder, moved out, is living", async () => {
    const { app, text } = fakeApp({
      [`${ARCH}/K.md`]: "---\nrecord: true\n---\n[o](../Other.md)\n",
      [`${ARCH}/F.md`]: "[o](../Other.md)\n",
      "00-09 System/00 System management/Other.md": "x\n",
    });
    const k = await moveWithLinks(app, app.vault.getAbstractFileByPath(`${ARCH}/K.md`), "Live/Sub/K.md", { isRecord: recordTest(SEEDED) });
    assert.equal(text.get("Live/Sub/K.md"), "---\nrecord: true\n---\n[o](../Other.md)\n");
    assert.deepEqual(k.records_left, [{ path: "Live/Sub/K.md", links: ["[o](../Other.md)"] }]);
    await moveWithLinks(app, app.vault.getAbstractFileByPath(`${ARCH}/F.md`), "Live/Sub/F.md", { isRecord: recordTest(SEEDED) });
    assert.equal(text.get("Live/Sub/F.md"), "[o](../../00-09%20System/00%20System%20management/Other.md)\n");
  });

  test("the REAL server wiring reaches the operator's setting, live: a main.ts-shaped ctx → buildMcpServer → obsidian_move_notes (PR #455 review, finding 1)", async () => {
    // getSettings withholds both record settings (settings-projection WITHHELD), so before this fix
    // every connection judged records by the shipped default whatever the operator had set.
    const { buildMcpServer } = await import("../src/mcp/server.ts");
    const tagId = { method: "tag", property: "record", value: "true", tag: "historical" };
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/T.md": "cited [[Old]] #historical\n", "S/K.md": "---\nrecord: true\n---\n[[Old]]\n" });
    // The plugin's settings object, and the ctx main.ts builds over it: getSettings is the projection, which carries neither record setting.
    const settings = { allowlist: [], readOnly: false, enforceRecordImmutability: true, recordIdentification: tagId };
    const ctx = {
      pluginVersion: "0.0.0", socketPath: "/tmp/none.sock", vaultName: "test", enabledPlugins: () => [],
      getSettings: () => ({ allowlist: settings.allowlist, readOnly: settings.readOnly }),
      enforceRecordImmutability: () => settings.enforceRecordImmutability,
      recordIdentification: () => settings.recordIdentification,
    };
    // What buildMcpServer touches at build time beyond the move itself (registrars read these eagerly).
    app.vault.adapter = { basePath: "/nonexistent-vault" };
    const move = buildMcpServer(app, ctx)._registeredTools.obsidian_move_notes;
    const r1 = await move.handler({ moves: [{ from: "A/Old.md", to: "B/New.md" }], overwrite: false }, {});
    assert.equal(text.get("S/T.md"), "cited [[Old]] #historical\n", JSON.stringify(r1));
    assert.equal(text.get("S/K.md"), "---\nrecord: true\n---\n[[New]]\n", "the operator chose a tag, so record: true marks nothing");
    // The operator switches back to the property: the next move sees it with no reconnect.
    settings.recordIdentification = { method: "property", property: "record", value: "true", tag: "record" };
    const r2 = await move.handler({ moves: [{ from: "B/New.md", to: "C/Newer.md" }], overwrite: false }, {});
    assert.equal(text.get("S/K.md"), "---\nrecord: true\n---\n[[New]]\n", JSON.stringify(r2));
  });

  test("main.ts hands the server both record settings through their own thunks, and nothing reads them through getSettings", async () => {
    const fs = await import("node:fs");
    const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    assert.match(main, /enforceRecordImmutability:\s*\(\)\s*=>\s*this\.settings\.enforceRecordImmutability,/);
    assert.match(main, /recordIdentification:\s*\(\)\s*=>\s*this\.settings\.recordIdentification,/);
    assert.match(main, /recordFolders:\s*\(\)\s*=>\s*this\.settings\.recordFolders,/);
    const server = fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    assert.match(server, /normalizeRecordIdentification\(ctx\.recordIdentification\?\.\(\)\)/);
    assert.match(server, /ctx\.enforceRecordImmutability\?\.\(\)\s*!==\s*false/);
    for (const f of fs.readdirSync(new URL("../src/mcp/", import.meta.url)).filter((n) => n.endsWith(".ts"))) {
      const src = fs.readFileSync(new URL(`../src/mcp/${f}`, import.meta.url), "utf8");
      assert.doesNotMatch(src, /getSettings\(\)\??\.(?:recordIdentification|enforceRecordImmutability|recordFolders)\b/, `${f} reads a withheld record setting through getSettings`);
    }
  });

  test("frontmatter is found as core's recognizer finds it: a BOM, blanks after ---, CRLF, a lone CR, text after the closing --- (finding 2)", () => {
    const is = recordTest(SEEDED);
    for (const t of [
      "\uFEFF---\nrecord: true\n---\n",
      "---  \nrecord: true\n---\n",
      "---\r\nrecord: true\r\n---\r\n",
      "---\rrecord: true\r---\r",
      "---\nrecord: true\n--- trailing\nbody\n",
    ]) assert.equal(is("S/N.md", t), true, JSON.stringify(t));
    assert.equal(is("S/N.md", "x\n---\nrecord: true\n---\n"), false, "frontmatter only at the top");
  });

  test("a tag inside code is judged as Obsidian's index delimits code: quoted and listed fences, an unclosed fence, multi-line spans, escaped backticks (finding 3)", () => {
    const tagId = { method: "tag", property: "record", value: "true", tag: "historical" };
    const is = recordTest(() => ({ folders: LEGACY_RECORD_FOLDERS_SEED, ...tagId }));
    assert.equal(is("S/N.md", "> ```\n> #historical\n> ```\n"), false, "a fence inside a quote");
    assert.equal(is("S/N.md", "- ```\n  #historical\n  ```\n"), false, "a fence on a list item");
    assert.equal(is("S/N.md", "```\n#historical\n"), false, "an unclosed fence runs to the end");
    assert.equal(is("S/N.md", "x `one\ntwo #historical` y\n"), false, "inline code over a line break in one paragraph");
    assert.equal(is("S/N.md", "\\` #historical \\`\n"), true, "escaped backticks open no code");
    assert.equal(is("S/N.md", "> ```\n> x\n> ```\n#historical\n"), true, "after the quoted fence closes");
  });

  test("tags are gathered as Obsidian's getAllTags gathers them: Tags: any case, tag: not at all, a string is one tag, **#tag** inline (finding 4)", () => {
    const tagId = { method: "tag", property: "record", value: "true", tag: "historical" };
    const is = recordTest(() => ({ folders: LEGACY_RECORD_FOLDERS_SEED, ...tagId }));
    assert.equal(is("S/N.md", "---\nTags: [historical]\n---\n"), true, "the key matches /^tags$/i");
    assert.equal(is("S/N.md", "---\nTAGS: historical\n---\n"), true, "a string value is one tag");
    assert.equal(is("S/N.md", "---\ntag: historical\n---\n"), false, "Obsidian 1.13 reads tags only, not tag");
    assert.equal(is("S/N.md", "---\ntags: historical, x\n---\n"), false, "the string 'historical, x' holds a space, so Obsidian drops it");
    assert.equal(is("S/N.md", "**#historical**\n"), true, "inside bold");
    assert.equal(is("S/N.md", "==#historical==\n"), true, "inside a highlight");
    assert.equal(is("S/N.md", "(#historical)\n"), false, "after a parenthesis is no tag");
    assert.equal(is("S/N.md", "a#historical\n"), false, "inside a word is no tag");
    assert.equal(is("S/N.md", "#historical\u2014x\n"), true, "an em dash ends the tag, as in Obsidian");
  });

  test("archiving is the moment a note becomes a record: a living note moved INTO a record folder has its own links healed on the way in, and kept from then on (finding 5)", async () => {
    const { app, text } = fakeApp({
      "Live/Sub/Plan.md": "[o](../Other.md)\n",
      "Live/Other.md": "x\n",
    });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("Live/Sub/Plan.md"), `${ARCH}/Plan.md`, { isRecord: recordTest(SEEDED) });
    assert.equal(text.get(`${ARCH}/Plan.md`), "[o](../../../Live/Other.md)\n", "healed: the record cites a working target as of its archiving");
    assert.deepEqual(r.records_left, []);
    assert.equal(r.ok, true, JSON.stringify(r));
    const r2 = await moveWithLinks(app, app.vault.getAbstractFileByPath(`${ARCH}/Plan.md`), `${ARCH}/Deeper/Plan.md`, { isRecord: recordTest(SEEDED) });
    assert.equal(text.get(`${ARCH}/Deeper/Plan.md`), "[o](../../../Live/Other.md)\n", "a record now: left as written");
    assert.deepEqual(r2.records_left, [{ path: `${ARCH}/Deeper/Plan.md`, links: ["[o](../../../Live/Other.md)"] }]);
  });

  test("a renumber reads the vault once and builds one record test for all its steps (finding 6)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/mcp/tools-scheme-write.ts", import.meta.url), "utf8");
    const loop = src.indexOf("for (const step of result.steps)");
    assert.ok(loop > 0);
    // The one cache is made before the name checks, and they use it too (the merge review of #455).
    const checks = src.lastIndexOf("for (const st of result.steps) await assertMoveName(app, st.from, st.to, false, texts);", loop);
    assert.ok(checks > 0, "every step's name check shares the cache");
    assert.match(src.slice(src.lastIndexOf("const texts = new TextCache(app);", checks), checks), /const texts = new TextCache\(app\);/);
    assert.equal(src.slice(checks, loop).includes("new TextCache("), false, "no second cache before the moves");
    const before = src.slice(src.lastIndexOf("const completed: MoveStep[] = [];", loop), loop);
    assert.match(before, /const isRecord = recordTest\(ctx\.recordIdentification\);/);
    assert.match(src.slice(loop, loop + 400), /moveOne\(app, step\.from, step\.to, false, \{ texts, isRecord \}\)/);
  });

  test("rename only (update_backlinks false) reads nothing for the record test", async () => {
    const { app } = fakeApp({ "A/Old.md": "x\n" });
    let reads = 0;
    const read = app.vault.cachedRead;
    app.vault.cachedRead = async (f) => { reads++; return read(f); };
    app.vault.read = async (f) => { reads++; return read(f); };
    await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", { isRecord: recordTest(SEEDED), updateBacklinks: false });
    assert.equal(reads, 0);
  });
});

describe("name checks at the live host's create and move sites (Nelson's bracket rule)", async () => {
  const { assertCreateName, assertMoveName, configureArchiveFolders } = await import("../src/mcp/name-checks.ts");
  // The archives this vault was seeded with (#482): the plugin ships none.
  before(() => configureArchiveFolders(() => new RegExp(LEGACY_RECORD_FOLDERS_SEED.archivePattern)));
  after(() => configureArchiveFolders(undefined));
  const ARCH = "00-09 System/00 System management/00.09 Archive";
  // fakeApp knows files only: give it the archive folder, and unresolved links.
  function withFolders(made, folders, unresolved = {}) {
    const get = made.app.vault.getAbstractFileByPath;
    made.app.vault.getAbstractFileByPath = (p) => get(p) ?? (folders.includes(p) ? Object.assign(new TFolder(), { path: p }) : null);
    made.app.metadataCache.unresolvedLinks = unresolved;
    return made;
  }

  test("a move into an existing archive may add brackets for a note nothing links to", async () => {
    const { app } = withFolders(fakeApp({ "A/Lonely.md": "x\n" }), [ARCH]);
    await assertMoveName(app, "A/Lonely.md", `${ARCH}/[superseded] Lonely.md`);
  });

  test("a link in a note's CURRENT text counts, though Obsidian's index has not seen it", async () => {
    const { app } = withFolders(fakeApp({ "A/Cited.md": "x\n", "S/L.md": "nothing\n" }, { stale: { "S/L.md": "now [[Cited]]\n" } }), [ARCH]);
    assert.deepEqual(Object.keys(app.metadataCache.resolvedLinks["S/L.md"]), [], "the index has no link yet");
    await assert.rejects(assertMoveName(app, "A/Cited.md", `${ARCH}/[superseded] Cited.md`), (e) => e.code === "unsafe_name");
  });

  test("with overwrite, links to the replaced destination count", async () => {
    const { app } = withFolders(fakeApp({ "D/Plan.md": "x\n", [`${ARCH}/[v1] Plan.md`]: "old\n", "S/L.md": "[[[v1] Plan]]\n" }), [ARCH]);
    await assert.rejects(assertMoveName(app, "D/Plan.md", `${ARCH}/[v1] Plan.md`, true), (e) => e.code === "unsafe_name");
  });

  test("an unresolved link that the new name would answer counts, for a create and a move", async () => {
    const made = withFolders(fakeApp({ "A/Lonely.md": "x\n" }), [ARCH], { "S/L.md": { "[old] Plan": 1 } });
    assert.throws(() => assertCreateName(made.app, `${ARCH}/[old] Plan.md`), (e) => e.code === "unsafe_name");
    assert.doesNotThrow(() => assertCreateName(made.app, `${ARCH}/[new] Plan.md`));
    await assert.rejects(assertMoveName(made.app, "A/Lonely.md", `${ARCH}/[old] Plan.md`), (e) => e.code === "unsafe_name");
  });

  test("an archive folder that does not exist yet does not free brackets", async () => {
    const { app } = withFolders(fakeApp({ "A/Lonely.md": "x\n" }), []);
    await assert.rejects(assertMoveName(app, "A/Lonely.md", "Projects/99.09 Archive/[x] Lonely.md"), (e) => e.code === "unsafe_name");
    assert.throws(() => assertCreateName(app, "Projects/99.09 Archive/[x] New.md"), (e) => e.code === "unsafe_name");
  });

  test("the vault is read only when brackets decide it", async () => {
    const made = withFolders(fakeApp({ "A/Plain.md": "x\n", "S/L.md": "[[Plain]]\n" }), [ARCH]);
    let reads = 0;
    const r = made.app.vault.cachedRead;
    made.app.vault.cachedRead = async (f) => { reads++; return r(f); };
    made.app.vault.read = async (f) => { reads++; return r(f); };
    await assertMoveName(made.app, "A/Plain.md", "B/Plain v2.md");
    await assert.rejects(assertMoveName(made.app, "A/Plain.md", "B/Plain: v2.md"), (e) => e.code === "unsafe_name");
    assert.equal(reads, 0);
  });
});

describe("the folder indicator is a setting (#482)", async () => {
  const { inRecordFolder, recordTest } = await import("../src/mcp/records.ts");
  const { DEFAULT_RECORD_IDENTIFICATION, DEFAULT_RECORD_FOLDERS } = await import("../src/kernel/record-guard.ts");
  const custom = { enabled: true, folders: ["Journal/Logs"], archivePattern: "^Old " };

  test("a configured folder list and archive pattern replace the defaults", () => {
    assert.equal(inRecordFolder("Journal/Logs/2026/a.md", custom), true);
    assert.equal(inRecordFolder("X/Old stuff/a.md", custom), true);
    assert.equal(inRecordFolder("00-09 System/00 System management/00.09 Archive/a.md", custom), false, "the JD default no longer applies");
    assert.equal(inRecordFolder("00-09 System/03 Agents/03.04 Records/a.md", custom), false);
    assert.equal(inRecordFolder("Journal/Logs/Logs.md", custom), false, "the root's own index note is living");
  });

  test("the folder indicator off: no note is a record by folder; an empty pattern: no archive", () => {
    assert.equal(inRecordFolder("00-09 System/03 Agents/03.04 Records/a.md", { ...DEFAULT_RECORD_FOLDERS, enabled: false }), false);
    assert.equal(inRecordFolder("A/00.09 Archive/a.md", { ...DEFAULT_RECORD_FOLDERS, archivePattern: "" }), false);
  });

  test("recordTest reads both indicators from the one getter; each switch works alone", () => {
    const keyed = "---\nrecord: true\n---\nx\n";
    const rules = (id, folders) => () => ({ ...DEFAULT_RECORD_IDENTIFICATION, ...id, folders: { ...LEGACY_RECORD_FOLDERS_SEED, ...folders } });
    assert.equal(recordTest(rules({}, custom))("Journal/Logs/a.md", "x"), true);
    assert.equal(recordTest(rules({}, { enabled: false }))("00-09 System/03 Agents/03.04 Records/a.md", "x"), false);
    assert.equal(recordTest(rules({ enabled: false }, {}))("Live/a.md", keyed), false, "note marker off");
    assert.equal(recordTest(rules({ enabled: false }, {}))("00-09 System/03 Agents/03.04 Records/a.md", "x"), true, "the folder rule still works");
  });

  test("a move honours a configured folder list", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "Journal/Logs/r.md": "cited [[Old]]\n", "S/L.md": "[[Old]]\n" });
    const r = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md", {
      isRecord: recordTest(() => ({ ...DEFAULT_RECORD_IDENTIFICATION, folders: custom })),
    });
    assert.equal(text.get("Journal/Logs/r.md"), "cited [[Old]]\n");
    assert.equal(text.get("S/L.md"), "[[New]]\n");
    assert.deepEqual(r.records_left.map((x) => x.path), ["Journal/Logs/r.md"]);
  });
});

describe("the bracket rule takes its archives from the operator's pattern (#482)", async () => {
  const { assertCreateName, configureArchiveFolders } = await import("../src/mcp/name-checks.ts");
  test("a configured pattern decides which existing folder is an archive", () => {
    const made = fakeApp({ "Old stuff/x.md": "x\n" });
    const get = made.app.vault.getAbstractFileByPath;
    made.app.vault.getAbstractFileByPath = (p) => get(p) ?? (p === "Old stuff" || p === "00.09 Archive" ? Object.assign(new TFolder(), { path: p }) : null);
    made.app.metadataCache.unresolvedLinks = {};
    try {
      configureArchiveFolders(() => /^Old /);
      assert.doesNotThrow(() => assertCreateName(made.app, "Old stuff/[v1] Plan.md"));
      assert.throws(() => assertCreateName(made.app, "00.09 Archive/[v1] Plan.md"), (e) => e.code === "unsafe_name");
      configureArchiveFolders(() => null);
      assert.throws(() => assertCreateName(made.app, "Old stuff/[v1] Plan.md"), (e) => e.code === "unsafe_name", "an empty pattern: no archives");
    } finally {
      configureArchiveFolders(undefined);
    }
  });
});

// ── #614: the written-content guard on every link rewrite of a move ───────────
//
// A move rewrites links in notes it was not asked to edit, frontmatter strings
// included. Each rewrite now passes the same written-content guard as a write of
// the note: a link inside a `verified` entry, an acceptance key or a declared
// protected property is never rewritten; the note is left unchanged and named in
// `failed` with the guard's reason, and the rest of the move lands.
describe("#614 a move's link rewrites pass the written-content guard", () => {
  const VERIFIED = "---\nverified:\n  - by: \"human:someone\"\n    at: 2026-01-02\n    note: \"see [[Old]]\"\n---\nBody [[Old]]\n";
  const ORDINARY = "---\nrelated: \"[[Old]]\"\n---\nBody [[Old]]\n";
  const BODY = "Body [[Old]]\n";
  const ACCEPT_KEY = "---\nacceptance-status: \"[[Old]]\"\n---\nBody [[Old]]\n";
  // A rewrite to a name with an apostrophe breaks the single-quoted value, so YAML can no longer read the block that holds `verified`.
  const DIVERGE = "---\nverified:\n  - by: \"human:someone\"\n    at: 2026-01-02\nrelated: '[[Old]]'\n---\n";
  const vault = () => ({ "A/Old.md": "x\n", "S/V.md": VERIFIED, "S/O.md": ORDINARY, "S/B.md": BODY, "S/K.md": ACCEPT_KEY });
  const failedFor = (check, p) => check.failed.find((f) => f.path === p);

  test("moveWithLinks: a verified entry's link is not rewritten and is reported; an ordinary key and the body are rewritten", async () => {
    const { app, text } = fakeApp(vault());
    const check = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "B/New.md");
    assert.equal(text.get("S/V.md"), VERIFIED, "the note with the verified link is left exactly as it was");
    assert.match(failedFor(check, "S/V.md").reason, /^accept_forbidden: .*verification field 'verified'/);
    assert.equal(text.get("S/O.md"), "---\nrelated: \"[[New]]\"\n---\nBody [[New]]\n");
    assert.equal(text.get("S/B.md"), "Body [[New]]\n");
    assert.equal(text.get("S/K.md"), ACCEPT_KEY, "a link in an acceptance key is never rewritten");
    assert.match(failedFor(check, "S/K.md").reason, /^accept_forbidden: a link rewrite would change the guarded frontmatter key 'acceptance-status'/);
    assert.deepEqual(check.files_rewritten.sort(), ["S/B.md", "S/O.md"]);
    assert.equal(check.ok, false, "a link left behind is reported, never hidden");
    assert.equal(text.has("B/New.md"), true, "the move itself lands");
  });

  test("moveWithLinks: a rewrite that YAML would read differently in a block holding a guarded key is refused", async () => {
    const { app, text } = fakeApp({ "A/Old.md": "x\n", "S/D.md": DIVERGE, "S/B.md": BODY });
    const check = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "A/It's.md");
    assert.equal(text.get("S/D.md"), DIVERGE);
    assert.match(failedFor(check, "S/D.md").reason, /^accept_forbidden: .*cannot read as YAML does/);
    assert.equal(text.get("S/B.md"), "Body [[It's]]\n");
  });

  test("moveWithLinks: the moved note's own relative link inside its verified entry is not rewritten", async () => {
    const own = "---\nverified:\n  - by: \"human:someone\"\n    at: 2026-01-02\n    note: \"[o](../Other.md)\"\n---\n";
    const { app, text } = fakeApp({ "A/Old.md": own, "Other.md": "x\n" });
    const check = await moveWithLinks(app, app.vault.getAbstractFileByPath("A/Old.md"), "A/Deep/Old.md");
    assert.equal(text.get("A/Deep/Old.md"), own);
    assert.match(failedFor(check, "A/Deep/Old.md").reason, /^accept_forbidden: /);
  });

  test("obsidian_move_notes and obsidian_move_note (ObsidianBackend) report the refused note and rewrite the rest", async () => {
    const { registerVaultWriteTools } = await import("../src/mcp/tools-vault-write.ts");
    const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
    {
      const { app, text } = fakeApp(vault());
      let handler;
      registerVaultWriteTools({ registerTool: (name, _def, h) => { if (name === "obsidian_move_notes") handler = h; } }, app, {});
      const res = await handler({ moves: [{ from: "A/Old.md", to: "B/New.md" }], overwrite: false });
      const check = res.structuredContent.moved[0].link_check;
      assert.equal(text.get("S/V.md"), VERIFIED);
      assert.match(failedFor(check, "S/V.md").reason, /^accept_forbidden: /);
      assert.equal(text.get("S/O.md"), "---\nrelated: \"[[New]]\"\n---\nBody [[New]]\n");
      assert.equal(text.get("S/B.md"), "Body [[New]]\n");
      assert.equal(res.structuredContent.links_ok, false);
    }
    {
      const { app, text } = fakeApp(vault());
      const r = await new ObsidianBackend(app).moveNote("A/Old.md", "B/New.md", { update_backlinks: true, overwrite: false });
      assert.equal(text.get("S/V.md"), VERIFIED);
      assert.match(failedFor(r.link_check, "S/V.md").reason, /^accept_forbidden: /);
      assert.equal(text.get("S/O.md"), "---\nrelated: \"[[New]]\"\n---\nBody [[New]]\n");
      assert.equal(text.get("S/B.md"), "Body [[New]]\n");
    }
  });
});
