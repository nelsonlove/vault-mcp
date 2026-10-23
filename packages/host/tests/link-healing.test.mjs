/**
 * link-healing.test.mjs — slice 2.2, which closes Delivery step 2 ("the uid
 * index and link healing").
 *
 * Healing has two halves, and this file pins both:
 *
 *   • IN BAND — a move through this server heals its own links. Since Nelson's
 *     "B" (2026-09-29) it does so WITHOUT `app.fileManager.renameFile`, whose
 *     link update waits for a clean metadata cache (minutes per move under the
 *     fleet's write load): every move path goes through `moveWithLinks`
 *     (move-with-links.ts), which renames at the file level and rewrites the
 *     backlinks itself, then checks for damage. This file pins that every move
 *     path uses it, that `renameFile` is reached nowhere, and that
 *     `vault.rename` is called from move-with-links.ts ONLY (a bare vault.rename
 *     anywhere else would move the bytes and orphan every backlink). The
 *     rewrite itself is pinned in move-with-links.test.mjs.
 *   • OUT OF BAND — drift that no move of ours caused is REPORTED, never
 *     repaired (Assent ch6: the rail detects, the human fixes).
 *     `obsidian_check_links` is read-only, takes no queue slot, and discloses
 *     nothing the caller's allowlist hides.
 *
 * Plus D1 from the Cycle 7 adversarial review: obsidian_resolve_uid's no-arg
 * totals are allowlist-filtered too.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { glob, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import { installObsidianStub, TFile, TFolder } from "./obsidian-stub.mjs";
import { Kernel, UidIndex, WriteJournal, WriteQueue } from "../src/kernel/index.ts";
import { makeGuarded } from "../src/mcp/guarded.ts";
import { registerLinkTools, obsidianLinkSource } from "../src/mcp/tools-links.ts";
import { registerUidTools } from "../src/mcp/tools-uid.ts";

// The move handlers import live Obsidian classes, so the specifier is pointed
// at the stub BEFORE they are imported. Everything above is obsidian-free.
installObsidianStub();
const { registerVaultWriteTools } = await import("../src/mcp/tools-vault-write.ts");
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { registerFsTools } = await import("@vault-mcp/core");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolvePath(HERE, "../src");
const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "abc-1" };

// ── a vault that records how it was moved ─────────────────────────────────────

/**
 * The surfaces a move touches, each a spy. `fileManager.renameFile` exists and
 * THROWS — present so "it was never called" is a real assertion about a real
 * method: reaching it again would bring back the wait for a clean cache.
 */
function fakeVault({ files = ["Notes/A.md"], folders = ["Notes"], texts = {} } = {}) {
  const tree = new Map(files.map((p) => { const f = new TFile(p); f.stat = { mtime: 1, size: (texts[p] ?? "").length }; return [p, f]; }));
  const text = new Map(files.map((p) => [p, texts[p] ?? ""]));
  const dirs = new Set(folders);
  const calls = { renameFile: [], vaultRename: [], trash: [], createFolder: [] };
  const fileCache = Object.fromEntries(files.map((p) => [p, { mtime: 1, size: (texts[p] ?? "").length }]));
  const app = {
    vault: {
      getAbstractFileByPath: (p) => tree.get(p) ?? (dirs.has(p) ? new TFolder(p) : null),
      async createFolder(p) {
        calls.createFolder.push(p);
        dirs.add(p);
      },
      async trash(file, system) {
        calls.trash.push([file.path, system]);
        tree.delete(file.path);
      },
      async rename(file, to) {
        calls.vaultRename.push([file.path, to]);
        const t = text.get(file.path); text.delete(file.path); tree.delete(file.path);
        fileCache[to] = fileCache[file.path]; delete fileCache[file.path];
        file.path = to; file.basename = to.split("/").pop().replace(/\.md$/, ""); file.name = to.split("/").pop();
        tree.set(to, file); text.set(to, t);
      },
      getMarkdownFiles: () => [...tree.values()],
      read: async (f) => text.get(f.path),
      cachedRead: async (f) => text.get(f.path),
      async process(f, fn) { const n = fn(text.get(f.path)); text.set(f.path, n); return n; },
    },
    fileManager: {
      async renameFile(file, to) {
        calls.renameFile.push([file.path, to]);
        throw new Error("renameFile waits for a clean metadata cache — moves go through moveWithLinks");
      },
    },
    metadataCache: {
      unresolvedLinks: {},
      resolvedLinks: {},
      fileCache,
      getFileCache: () => ({ links: [], embeds: [], frontmatterLinks: [] }),
      getFirstLinkpathDest: (lp) => [...tree.values()].find((f) => f.basename === lp || f.path === lp || f.path === `${lp}.md`) ?? null,
      fileToLinktext: (f) => f.basename,
    },
  };
  return { app, calls, tree, text };
}

function fakeServer() {
  const tools = new Map();
  return {
    server: { registerTool: (name, def, handler) => tools.set(name, { def, handler }) },
    tools,
    call: (name, args = {}) => tools.get(name).handler(args, {}),
    def: (name) => tools.get(name).def,
  };
}

// ── A. moves are link-aware, without waiting for a clean cache ─────────────────

describe("moves rewrite their own links and never wait on renameFile", () => {
  test("obsidian_move_note (fs tool → ObsidianBackend) renames through moveWithLinks, never renameFile, and reports counts and a clean link check", async () => {
    const { app, calls, tree } = fakeVault({ files: ["Notes/A.md", "Notes/S.md"], texts: { "Notes/S.md": "see [[A]]\n" } });
    app.metadataCache.resolvedLinks = { "Notes/S.md": { "Notes/A.md": 1 } };
    app.metadataCache.getFileCache = (f) => (f.path === "Notes/S.md" ? { links: [{ link: "A", original: "[[A]]", position: { start: { offset: 4 }, end: { offset: 9 } } }], embeds: [] } : { links: [], embeds: [] });
    const s = fakeServer();
    registerFsTools(s.server, new ObsidianBackend(app), { decodeHtml: false });

    const res = await s.call("obsidian_move_note", { from: "Notes/A.md", to: "Archive/2026/A2.md", update_backlinks: true, overwrite: false });

    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.renameFile, [], "renameFile waits for a clean metadata cache");
    assert.deepEqual(calls.vaultRename, [["Notes/A.md", "Archive/2026/A2.md"]]);
    assert.equal(tree.has("Archive/2026/A2.md"), true);
    assert.equal(res.structuredContent.moved, true);
    assert.equal(res.structuredContent.backlinks_updated, 1, "the count is known now");
    assert.equal(res.structuredContent.backlinks_files_touched, 1);
    assert.equal(res.structuredContent.link_check.ok, true, JSON.stringify(res.structuredContent.link_check));
  });

  test("obsidian_move_note refuses a name Obsidian Sync refuses before it trashes a destination or makes a folder", async () => {
    const { app, calls } = fakeVault({ files: ["Notes/A.md", "Notes/A: two.md"] });
    const s = fakeServer();
    registerFsTools(s.server, new ObsidianBackend(app), { decodeHtml: false });
    const res = await s.call("obsidian_move_note", { from: "Notes/A.md", to: "Notes/A: two.md", update_backlinks: true, overwrite: true });
    assert.match(res.content[0].text, /^Error \[unsafe_name\]/);
    const res2 = await s.call("obsidian_move_note", { from: "Notes/A.md", to: "New: dir/A.md", update_backlinks: true, overwrite: false });
    assert.match(res2.content[0].text, /^Error \[unsafe_name\]/);
    assert.deepEqual(calls.trash, [], "nothing trashed for a refused move");
    assert.deepEqual(calls.createFolder, [], "no folder made for a refused move");
    assert.deepEqual(calls.vaultRename, []);
  });

  test("update_backlinks:false now renames only: no link is rewritten", async () => {
    const { app, calls, text } = fakeVault({ files: ["Notes/A.md", "Notes/S.md"], texts: { "Notes/S.md": "see [[A]]\n" } });
    const s = fakeServer();
    registerFsTools(s.server, new ObsidianBackend(app), { decodeHtml: false });
    const res = await s.call("obsidian_move_note", { from: "Notes/A.md", to: "Notes/B.md", update_backlinks: false, overwrite: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.vaultRename, [["Notes/A.md", "Notes/B.md"]]);
    assert.equal(text.get("Notes/S.md"), "see [[A]]\n");
    assert.equal(res.structuredContent.backlinks_updated, 0);
  });

  test("obsidian_move_notes (batch) routes every item through moveWithLinks and reports each item's link check", async () => {
    const { app, calls } = fakeVault({ files: ["Notes/A.md", "Notes/B.md"], folders: ["Notes"] });
    const s = fakeServer();
    registerVaultWriteTools(s.server, app);

    const res = await s.call("obsidian_move_notes", {
      moves: [
        { from: "Notes/A.md", to: "Archive/A.md" },
        { from: "Notes/B.md", to: "Archive/B.md" },
      ],
      overwrite: false,
    });

    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.count, 2);
    assert.equal(res.structuredContent.links_ok, true);
    assert.ok(res.structuredContent.moved.every((m) => m.link_check.ok === true));
    assert.deepEqual(calls.vaultRename, [
      ["Notes/A.md", "Archive/A.md"],
      ["Notes/B.md", "Archive/B.md"],
    ]);
    assert.deepEqual(calls.renameFile, []);
  });

  test("obsidian_move_notes rejects the whole batch, typed unsafe_name, when a destination adds a name Obsidian Sync refuses", async () => {
    const { app, calls } = fakeVault({ files: ["Notes/A.md", "Notes/B.md"], folders: ["Notes"] });
    const s = fakeServer();
    registerVaultWriteTools(s.server, app);
    const res = await s.call("obsidian_move_notes", {
      moves: [
        { from: "Notes/A.md", to: "Archive/A.md" },
        { from: "Notes/B.md", to: "Archive/B: v2.md" },
      ],
      overwrite: false,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[unsafe_name\]: invalid batch, no moves performed/);
    assert.deepEqual(calls.vaultRename, [], "nothing moved, not even the clean first item");
  });

  test("an overwriting move trashes the destination recoverably, then moves", async () => {
    const { app, calls } = fakeVault({ files: ["Notes/A.md", "Notes/B.md"] });
    const s = fakeServer();
    registerVaultWriteTools(s.server, app);

    await s.call("obsidian_move_notes", { moves: [{ from: "Notes/A.md", to: "Notes/B.md" }], overwrite: true });

    assert.deepEqual(calls.trash, [["Notes/B.md", true]], "system trash, so the overwritten note is recoverable");
    assert.deepEqual(calls.vaultRename, [["Notes/A.md", "Notes/B.md"]]);
    assert.deepEqual(calls.renameFile, []);
  });

  // The scan globs `src/**/*.ts` rather than a hand-kept list of files (D4):
  // the invariant is "NOWHERE in the plugin source, except the one module that
  // owns the move", and a list only covers the files somebody remembered. It is
  // proven live below, against a planted violation.
  const ALLOWED = "mcp/move-with-links.ts";
  async function moveOffenders() {
    const offenders = [];
    for await (const rel of glob("**/*.ts", { cwd: SRC })) {
      const text = await readFile(resolvePath(SRC, rel), "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
        if (/\bfileManager\s*\.\s*renameFile\s*\(/.test(line)) offenders.push(`${rel}: ${trimmed}`);
        if (/\bvault\s*\.\s*rename\s*\(/.test(line) && rel !== ALLOWED) offenders.push(`${rel}: ${trimmed}`);
      }
    }
    return offenders;
  }

  test("no path in the plugin source calls renameFile, and only move-with-links.ts calls vault.rename", async () => {
    assert.deepEqual(await moveOffenders(), [], "move through moveWithLinks: renameFile waits for a clean cache, and a bare vault.rename orphans backlinks");
  });

  test("the scan actually catches one: a planted vault.rename in a scratch module fails it", async () => {
    const planted = resolvePath(SRC, "__vault-rename-scratch.ts");
    try {
      await writeFile(
        planted,
        [
          "// Scratch module planted by link-healing.test.mjs, removed in the same test.",
          "export async function move(app: any, file: any, to: string) {",
          "  await app.vault.rename(file, to);",
          "  await app.fileManager.renameFile(file, to);",
          "}",
          "",
        ].join("\n")
      );
      const offenders = await moveOffenders();
      assert.equal(offenders.length, 2, `the glob missed a planted violation: ${JSON.stringify(offenders)}`);
      assert.match(offenders.join("\n"), /__vault-rename-scratch\.ts: await app\.vault\.rename\(file, to\);/);
    } finally {
      await rm(planted, { force: true });
    }
    // And the tree is clean again, so the real assertion above still means what it says.
    assert.deepEqual(await moveOffenders(), []);
  });
});

// ── B. obsidian_check_links — read-only drift report ──────────────────────────

describe("obsidian_check_links", () => {
  // `notes` is the vault's markdown-file list — uid coverage's denominator. It
  // defaults to the notes the uid map mentions, so every pre-existing case
  // keeps a coherent vault; pass it explicitly to include notes with no uid.
  function linkServer({ unresolved = {}, uids = null, notes = null, allowlist = [], kernel } = {}) {
    const index = uids ? new UidIndex({ paths: () => Object.keys(uids), uidOf: (p) => uids[p] }) : null;
    index?.rebuild();
    const s = fakeServer();
    const k = kernel === undefined ? (index ? { uids: index } : null) : kernel;
    const paths = notes ?? Object.keys(uids ?? {});
    registerLinkTools(
      s.server,
      obsidianLinkSource({
        metadataCache: { unresolvedLinks: unresolved },
        vault: { getMarkdownFiles: () => paths.map((p) => ({ path: p })) },
      }),
      { kernel: k, getSettings: () => ({ readOnly: false, allowlist }) }
    );
    return { ...s, index, call: (args = {}) => s.call("obsidian_check_links", args) };
  }

  test("it registers read-only, and says so in its annotations", () => {
    const { def } = linkServer();
    assert.deepEqual(def("obsidian_check_links").annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("no accept/approve/grant verb, and no auto-repair verb, in its vocabulary", () => {
    const d = linkServer().def("obsidian_check_links");
    const text = `obsidian_check_links ${d.title} ${d.description}`.toLowerCase();
    for (const banned of ["grant", "approve", "accept", "auto-heal", "autoheal"]) {
      assert.equal(text.includes(banned), false, banned);
    }
  });

  test("read-only means it never reaches the write queue: runMutation is not called", async () => {
    let mutations = 0;
    const index = new UidIndex({ paths: () => [], uidOf: () => undefined });
    index.rebuild();
    const kernel = {
      uids: index,
      runMutation: () => {
        mutations++;
        throw new Error("a read-only report must never take a queue slot or write a journal record");
      },
    };
    const { tools } = linkServer({ unresolved: { "A.md": { Ghost: 1 } }, kernel });
    const { def, handler } = tools.get("obsidian_check_links");
    const guarded = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist: [] }),
      kernel,
      actor: () => ACTOR,
    })(def, handler, "obsidian_check_links");

    const res = await guarded({}, {});
    assert.equal(res.isError, undefined);
    assert.equal(mutations, 0);
  });

  test("it is not blocked in read-only mode — a report is a read", async () => {
    const { tools } = linkServer({ unresolved: { "A.md": { Ghost: 1 } } });
    const { def, handler } = tools.get("obsidian_check_links");
    const guarded = makeGuarded({
      getSettings: () => ({ readOnly: true, allowlist: [] }),
      kernel: null,
      actor: () => ACTOR,
    })(def, handler, "obsidian_check_links");
    const res = await guarded({}, {});
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.dangling_links.link_count, 1);
  });

  test("it reports a dangling wikilink: which note, which link text, how many", async () => {
    const { call } = linkServer({
      unresolved: { "Notes/A.md": { "Missing Note": 2, Ghost: 1 }, "Notes/B.md": {} },
    });
    const res = await call();
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent.dangling_links, {
      note_count: 1,
      link_count: 3,
      truncated: false,
      items: [
        { from: "Notes/A.md", link: "Ghost", count: 1 },
        { from: "Notes/A.md", link: "Missing Note", count: 2 },
      ],
    });
    assert.equal(res.structuredContent.scope, null);
  });

  test("a healthy vault reports zero rather than an error", async () => {
    const res = await linkServer().call();
    assert.deepEqual(res.structuredContent.dangling_links, { note_count: 0, link_count: 0, truncated: false, items: [] });
  });

  test("`scope` narrows the report to a folder, on segment boundaries", async () => {
    const { call } = linkServer({
      unresolved: {
        "Projects/A.md": { Ghost: 1 },
        "Projects Archive/B.md": { Ghost: 1 },
        "Archive/C.md": { Ghost: 1 },
      },
    });
    const res = await call({ scope: "Projects" });
    assert.equal(res.structuredContent.scope, "Projects");
    assert.deepEqual(
      res.structuredContent.dangling_links.items.map((i) => i.from),
      ["Projects/A.md"],
      "'Projects Archive' is a different folder, not a prefix match"
    );
    assert.equal(res.structuredContent.dangling_links.note_count, 1);
  });

  test("a scope that normalizes out of itself is refused, not silently widened to everything", async () => {
    const { call } = linkServer({ unresolved: { "Archive/secret.md": { Ghost: 1 } } });
    for (const scope of ["Projects/../Archive/..", "..", "./"]) {
      const res = await call({ scope });
      assert.equal(res.isError, true, `scope '${scope}' should refuse`);
      assert.match(res.content[0].text, /does not name a folder/);
      assert.equal(JSON.stringify(res).includes("secret"), false, "a refusal reports nothing");
    }
  });

  // ── D5: scope refusals are CODED, like the claims surface's ─────────────────

  test("a malformed scope refuses with Error [invalid_scope], not a codeless failure", async () => {
    const { call } = linkServer({ unresolved: { "Archive/secret.md": { Ghost: 1 } } });
    const cases = [
      [" Projects", /whitespace/],
      ["Projects ", /whitespace/],
      ["/Projects", /absolute path/],
      ["..", /does not name a folder/],
      ["./", /does not name a folder/],
      ["Projects/../..", /does not name a folder/],
    ];
    for (const [scope, why] of cases) {
      const res = await call({ scope });
      assert.equal(res.isError, true, `scope '${scope}' should refuse`);
      assert.match(res.content[0].text, /^Error \[invalid_scope\]: /, `scope '${scope}' lost its code`);
      assert.match(res.content[0].text, why);
      assert.equal(res.structuredContent, undefined, "a refusal reports nothing");
      assert.equal(JSON.stringify(res).includes("secret"), false);
    }
  });

  test("an out-of-allowlist scope refuses TYPED rather than returning a zeroed report", async () => {
    const { call } = linkServer({
      unresolved: { "Projects/A.md": { Ghost: 1 }, "Archive/Payroll/S.md": { "Bonus Pool": 1 } },
      allowlist: ["Projects"],
    });
    const res = await call({ scope: "Archive/Payroll" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[out_of_allowlist\]: /);
    // A zeroed report for a hidden folder and a zeroed report for a genuinely
    // clean one are indistinguishable; the refusal is the honest answer, and it
    // matches how a scope claim answers the same mistake.
    assert.equal(res.structuredContent, undefined);
    assert.equal(JSON.stringify(res).includes("Bonus Pool"), false);
  });

  test("a scope that merely CONTAINS the allowlist is out of it too — narrow, or omit", async () => {
    const { call } = linkServer({ unresolved: { "Projects/Alpha/A.md": { Ghost: 1 } }, allowlist: ["Projects/Alpha"] });
    const wide = await call({ scope: "Projects" });
    assert.equal(wide.isError, true);
    assert.match(wide.content[0].text, /^Error \[out_of_allowlist\]: /);
    assert.match(wide.content[0].text, /narrow the scope, or omit it/);
    // The remedies both work, and report the same thing.
    const narrow = await call({ scope: "Projects/Alpha" });
    const omitted = await call();
    assert.equal(narrow.structuredContent.dangling_links.link_count, 1);
    assert.equal(omitted.structuredContent.dangling_links.link_count, 1);
  });

  // ── D6: a zero count is a zero ──────────────────────────────────────────────

  test("a host-reported count of 0 stays 0 — it is never inflated to 1", async () => {
    const { call } = linkServer({ unresolved: { "A.md": { Ghost: 0, Real: 2 } } });
    const res = await call();
    assert.deepEqual(res.structuredContent.dangling_links.items, [
      { from: "A.md", link: "Ghost", count: 0 },
      { from: "A.md", link: "Real", count: 2 },
    ]);
    assert.equal(res.structuredContent.dangling_links.link_count, 2, "0 + 2, not 1 + 2");
  });

  test("a non-numeric count still falls back to 1 — the key's presence is the evidence", async () => {
    const { call } = linkServer({ unresolved: { "A.md": { Ghost: "two" } } });
    const res = await call();
    assert.deepEqual(res.structuredContent.dangling_links.items, [{ from: "A.md", link: "Ghost", count: 1 }]);
  });

  test("it never names a path outside the allowlist", async () => {
    const { call } = linkServer({
      unresolved: {
        "Projects/A.md": { Ghost: 1 },
        "Archive/Payroll/Salaries 2026.md": { "Bonus Pool": 3 },
      },
      uids: { "Archive/Payroll/a.md": "dup", "Archive/Payroll/b.md": "dup" },
      allowlist: ["Projects"],
    });
    const res = await call();
    const text = JSON.stringify(res);
    assert.equal(text.includes("Payroll"), false, "an out-of-allowlist path leaked into the report");
    assert.equal(text.includes("Bonus Pool"), false, "…as did the link text inside it");
    assert.deepEqual(res.structuredContent.dangling_links, {
      note_count: 1,
      link_count: 1,
      truncated: false,
      items: [{ from: "Projects/A.md", link: "Ghost", count: 1 }],
    });
    assert.deepEqual(res.structuredContent.duplicate_uids.items, []);
    assert.equal(res.structuredContent.duplicate_uids.count, 0);
  });

  test("uid duplicates are reported from already-computed index data, scoped and visible-filtered", async () => {
    const { call } = linkServer({
      uids: { "Projects/A.md": "dup", "Projects/B.md": "dup", "Archive/C.md": "other", "Archive/D.md": "other" },
    });

    const all = await call();
    assert.equal(all.structuredContent.duplicate_uids.available, true);
    assert.deepEqual(all.structuredContent.duplicate_uids.items, [
      { uid: "dup", paths: ["Projects/A.md", "Projects/B.md"] },
      { uid: "other", paths: ["Archive/C.md", "Archive/D.md"] },
    ]);

    const scoped = await call({ scope: "Projects" });
    assert.deepEqual(scoped.structuredContent.duplicate_uids.items, [
      { uid: "dup", paths: ["Projects/A.md", "Projects/B.md"] },
    ]);
    assert.equal(scoped.structuredContent.duplicate_uids.count, 1);
  });

  test("a duplicate with only ONE carrier in scope is not an ambiguity for this scope", async () => {
    const { call } = linkServer({ uids: { "Projects/A.md": "dup", "Archive/B.md": "dup" } });
    const res = await call({ scope: "Projects" });
    assert.deepEqual(res.structuredContent.duplicate_uids.items, []);
  });

  test("without a uid index the duplicates half says so instead of reporting a confident zero", async () => {
    const res = await linkServer({ kernel: null, unresolved: { "A.md": { Ghost: 1 } } }).call();
    assert.equal(res.structuredContent.duplicate_uids.available, false);
    assert.equal(res.structuredContent.duplicate_uids.count, 0);
    assert.equal(res.structuredContent.dangling_links.link_count, 1, "the dangling half still works");
  });

  // ── uid coverage — report-first, never minting ──────────────────────────────

  describe("uid_coverage", () => {
    test("counts the visible notes that carry a uid, and names the ones that do not", async () => {
      const { call } = linkServer({
        uids: { "Projects/A.md": "a", "Projects/B.md": "b" },
        notes: ["Projects/A.md", "Projects/B.md", "Projects/C.md", "Notes/D.md"],
      });
      const res = await call();
      assert.deepEqual(res.structuredContent.uid_coverage, {
        available: true,
        notes_total: 4,
        notes_with_uid: 2,
        notes_without_uid: 2,
        truncated: false,
        uncovered: ["Notes/D.md", "Projects/C.md"],
      });
    });

    test("it mints nothing and writes nothing: the notes without uids still have none", async () => {
      const uids = { "A.md": "a" };
      const { call, index } = linkServer({ uids, notes: ["A.md", "B.md"] });
      await call();
      await call();
      assert.equal(index.uidFor("B.md"), undefined, "a report must not create identity");
      assert.deepEqual(Object.keys(uids), ["A.md"]);
    });

    test("report-first on the wire: `scope` is the only argument, and the description disclaims minting", () => {
      const d = linkServer().def("obsidian_check_links");
      // No fix/heal/mint/assign argument exists to be reached for — minting is a
      // pending human decision, not a flag on a report.
      assert.deepEqual(Object.keys(d.inputSchema), ["scope"]);
      assert.match(d.description, /no uid is minted/i);
    });

    test("the denominator is the SESSION's: an out-of-allowlist note is neither counted nor named", async () => {
      const { call } = linkServer({
        uids: { "Projects/A.md": "a" },
        notes: ["Projects/A.md", "Projects/B.md", "Archive/Payroll/S.md"],
        allowlist: ["Projects"],
      });
      const res = await call();
      assert.deepEqual(res.structuredContent.uid_coverage, {
        available: true,
        notes_total: 2,
        notes_with_uid: 1,
        notes_without_uid: 1,
        truncated: false,
        uncovered: ["Projects/B.md"],
      });
      assert.equal(JSON.stringify(res).includes("Payroll"), false);
    });

    test("`scope` narrows coverage the same way it narrows the rest of the report", async () => {
      const { call } = linkServer({
        uids: { "Projects/A.md": "a" },
        notes: ["Projects/A.md", "Projects/B.md", "Archive/C.md", "Projects Archive/D.md"],
      });
      const res = await call({ scope: "Projects" });
      assert.equal(res.structuredContent.uid_coverage.notes_total, 2, "'Projects Archive' is a different folder");
      assert.deepEqual(res.structuredContent.uid_coverage.uncovered, ["Projects/B.md"]);
    });

    test("the uncovered list is capped at 100 while the counts stay exact", async () => {
      const notes = Array.from({ length: 150 }, (_, i) => `Notes/n${String(i).padStart(3, "0")}.md`);
      const { call } = linkServer({ uids: { "Notes/n000.md": "a" }, notes });
      const cov = (await call()).structuredContent.uid_coverage;
      assert.equal(cov.notes_total, 150);
      assert.equal(cov.notes_with_uid, 1);
      assert.equal(cov.notes_without_uid, 149);
      assert.equal(cov.uncovered.length, 100);
      assert.equal(cov.truncated, true);
    });

    test("without a uid index it says the coverage is unknown, not zero", async () => {
      const res = await linkServer({ kernel: null, notes: ["A.md", "B.md"] }).call();
      assert.equal(res.structuredContent.uid_coverage.available, false);
      assert.equal(res.structuredContent.uid_coverage.notes_total, 2, "the denominator needs no index");
      assert.deepEqual(res.structuredContent.uid_coverage.uncovered, []);
    });
  });

  test("counts stay exact when the list is capped, and the cap is flagged", async () => {
    const unresolved = {};
    for (let i = 0; i < 150; i++) unresolved[`Notes/n${String(i).padStart(3, "0")}.md`] = { Ghost: 1 };
    const res = await linkServer({ unresolved }).call();
    assert.equal(res.structuredContent.dangling_links.note_count, 150);
    assert.equal(res.structuredContent.dangling_links.link_count, 150);
    assert.equal(res.structuredContent.dangling_links.items.length, 100);
    assert.equal(res.structuredContent.dangling_links.truncated, true);
  });
});

// ── C. D1 — the no-argument totals are allowlist-filtered too ─────────────────

describe("obsidian_resolve_uid — D1: totals are the session's own cardinality", () => {
  function uidServer({ entries, allowlist = [] }) {
    const index = new UidIndex({ paths: () => Object.keys(entries), uidOf: (p) => entries[p] });
    index.rebuild();
    const s = fakeServer();
    registerUidTools(s.server, { kernel: { uids: index }, getSettings: () => ({ readOnly: false, allowlist }) });
    return (args = {}) => s.call("obsidian_resolve_uid", args);
  }

  test("an allowlisted session is told how much IT can see, not how big the vault is", async () => {
    const call = uidServer({
      entries: {
        "Projects/A.md": "a",
        "Projects/B.md": "b",
        "Archive/C.md": "c",
        "Archive/D.md": "d",
        "Archive/E.md": "e",
      },
      allowlist: ["Projects"],
    });
    assert.deepEqual((await call()).structuredContent, {
      indexed_notes: 2,
      indexed_uids: 2,
      duplicate_count: 0,
      duplicates: [],
    });
  });

  test("a duplicated uid counts once in the visible uid total", async () => {
    const call = uidServer({
      entries: { "Projects/A.md": "dup", "Projects/B.md": "dup", "Archive/C.md": "hidden" },
      allowlist: ["Projects"],
    });
    const res = await call();
    assert.equal(res.structuredContent.indexed_notes, 2);
    assert.equal(res.structuredContent.indexed_uids, 1, "two notes, one uid between them");
    assert.deepEqual(res.structuredContent.duplicates, [{ uid: "dup", paths: ["Projects/A.md", "Projects/B.md"] }]);
  });

  test("with no allowlist the totals are the index's own, unchanged", async () => {
    const call = uidServer({ entries: { "A.md": "dup", "B.md": "dup", "C.md": "solo" } });
    assert.deepEqual((await call()).structuredContent, {
      indexed_notes: 3,
      indexed_uids: 2,
      duplicate_count: 1,
      duplicates: [{ uid: "dup", paths: ["A.md", "B.md"] }],
    });
  });
});

// ── D. obsidian_repoint_link — the repair is contained by the allowlist ───────
//
// Cycle 8 D1. `obsidian_repoint_link` is the tool the Link-health docs prescribe
// as the repair for a dangling link, and it was the one tool whose blast radius
// was not in its arguments: it iterated `vault.getMarkdownFiles()` — the WHOLE
// vault — reading, rewriting and then NAMING notes a sandboxed session could
// not read, write or list. The guard never saw them, because the guard checks
// the paths an operation names and a repoint names only its target.
//
// These tests pin the containment in all three directions (read, write, name),
// the flag that admits the repair is partial, the unchanged no-allowlist
// behavior, and the journal record's honesty about what actually changed.

describe("obsidian_repoint_link containment (D1)", () => {
  /** A vault of note bodies, recording every read and every write. */
  function repointVault(files) {
    const contents = new Map(Object.entries(files));
    const reads = [];
    const writes = [];
    const app = {
      vault: {
        getMarkdownFiles: () => [...contents.keys()].map((p) => new TFile(p)),
        getAbstractFileByPath: (p) => (contents.has(p) ? new TFile(p) : null),
        async cachedRead(file) {
          reads.push(file.path);
          return contents.get(file.path);
        },
        async process(file, fn) {
          writes.push(file.path);
          const next = fn(contents.get(file.path));
          contents.set(file.path, next);
          return next;
        },
      },
      metadataCache: {
        unresolvedLinks: {},
        // Shortest link text for the target: the basename, as Obsidian would.
        fileToLinktext: (target) => target.path.replace(/\.md$/, "").split("/").pop(),
      },
    };
    return { app, contents, reads, writes };
  }

  const VAULT = {
    "Projects/Target.md": "# target",
    "Projects/A.md": "see [[Ghost]]",
    "Archive/Payroll/Salaries.md": "see [[Ghost]] too",
  };

  function repointServer(files, allowlist = []) {
    const v = repointVault(files);
    const s = fakeServer();
    registerVaultWriteTools(s.server, v.app, { getSettings: () => ({ readOnly: false, allowlist }) });
    return { ...v, call: (args) => s.call("obsidian_repoint_link", { dry_run: false, unresolved_only: false, drop_echo_alias: false, ...args }) };
  }

  const REPOINT = { link_name: "Ghost", target_path: "Projects/Target.md" };

  test("under an allowlist it rewrites, reads and names ONLY visible notes", async () => {
    const { call, contents, reads, writes } = repointServer(VAULT, ["Projects"]);
    const res = await call(REPOINT);

    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent.files, ["Projects/A.md"]);
    assert.equal(res.structuredContent.filesChanged, 1);
    assert.equal(res.structuredContent.linksChanged, 1);
    assert.equal(res.structuredContent.scoped_to_allowlist, true, "a partial repair must say it is partial");

    assert.equal(contents.get("Projects/A.md"), "see [[Target]]");
    assert.equal(contents.get("Archive/Payroll/Salaries.md"), "see [[Ghost]] too", "an out-of-allowlist note was rewritten");
    assert.equal(writes.includes("Archive/Payroll/Salaries.md"), false, "…or opened for writing");
    assert.equal(reads.includes("Archive/Payroll/Salaries.md"), false, "…or even read");
    assert.equal(JSON.stringify(res).includes("Payroll"), false, "…or named in the response");
  });

  test("a dry run is contained too — it discloses no out-of-allowlist path", async () => {
    const { call, contents, reads } = repointServer(VAULT, ["Projects"]);
    const res = await call({ ...REPOINT, dry_run: true });

    assert.deepEqual(res.structuredContent.files, ["Projects/A.md"]);
    assert.equal(res.structuredContent.filesChanged, 1);
    assert.equal(res.structuredContent.scoped_to_allowlist, true);
    assert.equal(contents.get("Projects/A.md"), "see [[Ghost]]", "a dry run writes nothing");
    assert.equal(reads.includes("Archive/Payroll/Salaries.md"), false);
  });

  test("with no allowlist the behavior is unchanged: the whole vault, and the flag is false", async () => {
    const { call, contents } = repointServer(VAULT);
    const res = await call(REPOINT);

    assert.deepEqual(res.structuredContent.files, ["Projects/A.md", "Archive/Payroll/Salaries.md"]);
    assert.equal(res.structuredContent.filesChanged, 2);
    assert.equal(res.structuredContent.linksChanged, 2);
    assert.equal(res.structuredContent.scoped_to_allowlist, false);
    assert.equal(contents.get("Archive/Payroll/Salaries.md"), "see [[Target]] too");
  });

  test("a target inside the allowlist with all sources outside changes nothing, and says so", async () => {
    const { call, contents } = repointServer(
      { "Projects/Target.md": "# target", "Archive/B.md": "[[Ghost]]" },
      ["Projects"]
    );
    const res = await call(REPOINT);
    assert.deepEqual(res.structuredContent.files, []);
    assert.equal(res.structuredContent.filesChanged, 0);
    assert.equal(res.structuredContent.scoped_to_allowlist, true);
    assert.equal(contents.get("Archive/B.md"), "[[Ghost]]");
  });

  // ── the journal tells the truth about the blast radius ─────────────────────

  function journalKernel() {
    const files = new Map();
    const dirs = new Set();
    const adapter = {
      async exists(p) { return files.has(p) || dirs.has(p); },
      async mkdir(p) { dirs.add(p); },
      async write(p, d) { files.set(p, d); },
      async append(p, d) { files.set(p, (files.get(p) ?? "") + d); },
    };
    const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-08T12:00:00Z"));
    const kernel = new Kernel(new WriteQueue(1000), journal, null);
    const records = () =>
      (files.get("dir/journal/2026-08.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { kernel, records };
  }

  /** The real chain: makeGuarded → Kernel.runMutation → WriteJournal. */
  function journaledRepoint(files, allowlist = []) {
    const v = repointVault(files);
    const s = fakeServer();
    registerVaultWriteTools(s.server, v.app, { getSettings: () => ({ readOnly: false, allowlist }) });
    const { def, handler } = s.tools.get("obsidian_repoint_link");
    const { kernel, records } = journalKernel();
    const guarded = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist }),
      kernel,
      actor: () => ACTOR,
    })(def, handler, "obsidian_repoint_link");
    return {
      ...v,
      records,
      call: (args) => guarded({ dry_run: false, unresolved_only: false, drop_echo_alias: false, ...args }, {}),
    };
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("the record names what actually changed, not just the target that was asked for", async () => {
    const { call, records } = journaledRepoint(VAULT);
    await call(REPOINT);
    await flush();

    const [rec] = records();
    assert.equal(rec.op, "obsidian_repoint_link");
    assert.equal(rec.outcome, "ok");
    // The argument-derived target is still there — it is what was ASKED for…
    assert.equal(rec.target.path, "Projects/Target.md");
    // …and `effects` is what HAPPENED: two notes rewritten, both named.
    assert.deepEqual(rec.effects, {
      filesChanged: 2,
      paths: ["Projects/A.md", "Archive/Payroll/Salaries.md"],
    });
  });

  test("under an allowlist the record's blast radius is the contained one", async () => {
    const { call, records } = journaledRepoint(VAULT, ["Projects"]);
    await call(REPOINT);
    await flush();

    const [rec] = records();
    assert.deepEqual(rec.effects, { filesChanged: 1, paths: ["Projects/A.md"] });
    assert.equal(JSON.stringify(rec).includes("Payroll"), false, "the journal must not record what the tool could not touch");
  });

  test("a dry run records no effects — nothing changed, so nothing is claimed", async () => {
    const { call, records } = journaledRepoint(VAULT);
    await call({ ...REPOINT, dry_run: true });
    await flush();

    const [rec] = records();
    assert.equal(rec.effects, undefined);
    assert.equal(rec.argsDigest.dry_run, true, "the digest still says what was asked");
  });

  test("an ordinary single-path write records no effects — its target already says everything", async () => {
    const { kernel, records } = journalKernel();
    const guarded = makeGuarded({ getSettings: () => ({ readOnly: false, allowlist: [] }), kernel, actor: () => ACTOR })(
      { annotations: { readOnlyHint: false } },
      async () => ({ content: [], structuredContent: { path: "A.md", written: true } }),
      "obsidian_write_note"
    );
    await guarded({ path: "A.md" }, {});
    await flush();
    assert.equal(records()[0].effects, undefined);
  });

  // D-E. `effects` is a journal field, and a journal field must never be able
  // to cost a caller their result — the same guarantee a broken journal already
  // has. The convention is supplied by the interception layer and reads a
  // handler's own envelope shape, so a malformed result (or a future convention
  // with a bug in it) is exactly the kind of thing that throws here. Pinned:
  // the caller still gets their envelope, the record is still written, and the
  // only thing lost is the one field that could not be computed.
  test("a throwing effectsOf costs the caller nothing — result returned, record still written", async () => {
    const { kernel, records } = journalKernel();
    const envelope = { content: [{ type: "text", text: "{}" }], structuredContent: { ok: true } };
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a);
    let result;
    try {
      result = await kernel.runMutation(
        {
          op: "obsidian_repoint_link",
          args: { target_path: "Projects/Target.md" },
          actor: ACTOR,
          effectsOf: () => {
            throw new Error("effects convention blew up");
          },
        },
        async () => envelope
      );
      await flush();
    } finally {
      console.error = orig;
    }

    assert.deepEqual(result, envelope, "the handler's envelope must reach the caller unchanged");
    const [rec] = records();
    assert.equal(rec.outcome, "ok", "a throw in a journal field must not turn a successful write into a failure");
    assert.equal(rec.target.path, "Projects/Target.md", "the argument-derived record survives intact");
    assert.equal(rec.effects, undefined, "the uncomputable field is simply absent");
    assert.equal(errors.length, 1, "it is swallowed loudly, not silently");
  });

  // #614: each repoint passes the same written-content guard as a write of the
  // note. A link inside a `verified` entry, an acceptance key or a declared
  // protected property is never rewritten: the note is left unchanged and named
  // in `skipped` with the guard's reason, and the other notes are repointed.
  describe("#614 the written-content guard on every repointed note", () => {
    const VERIFIED = "---\nverified:\n  - by: \"human:someone\"\n    at: 2026-01-02\n    note: \"see [[Ghost]]\"\n---\nBody [[Ghost]]\n";
    const ORDINARY = "---\nrelated: \"[[Ghost]]\"\n---\nBody [[Ghost]]\n";
    const ACCEPT_KEY = "---\nacceptance-status: \"[[Ghost]]\"\n---\n";
    const DIVERGE = "---\nverified:\n  - by: \"human:someone\"\n    at: 2026-01-02\nrelated: '[[Ghost]]'\n---\n";
    const FILES = { "Projects/Target.md": "# target", "N/V.md": VERIFIED, "N/O.md": ORDINARY, "N/B.md": "Body [[Ghost]]\n", "N/K.md": ACCEPT_KEY };
    const reasonOf = (res, p) => res.structuredContent.skipped.find((x) => x.path === p)?.reason;

    test("a verified entry's link and an acceptance key's link are not rewritten and are reported; an ordinary key and the body are rewritten", async () => {
      const { call, contents } = repointServer(FILES);
      const res = await call(REPOINT);
      assert.equal(res.isError, undefined, res.content?.[0]?.text);
      assert.equal(contents.get("N/V.md"), VERIFIED);
      assert.match(reasonOf(res, "N/V.md"), /^accept_forbidden: .*verification field 'verified'/);
      assert.equal(contents.get("N/K.md"), ACCEPT_KEY);
      assert.match(reasonOf(res, "N/K.md"), /^accept_forbidden: a link rewrite would change the guarded frontmatter key 'acceptance-status'/);
      assert.equal(contents.get("N/O.md"), "---\nrelated: \"[[Target]]\"\n---\nBody [[Target]]\n");
      assert.equal(contents.get("N/B.md"), "Body [[Target]]\n");
      assert.deepEqual(res.structuredContent.files.sort(), ["N/B.md", "N/O.md"]);
    });

    test("a rewrite that YAML would read differently in a block holding a guarded key is refused", async () => {
      const { call, contents } = repointServer({ "Projects/It's.md": "# target", "N/D.md": DIVERGE, "N/B.md": "Body [[Ghost]]\n" });
      const res = await call({ link_name: "Ghost", target_path: "Projects/It's.md" });
      assert.equal(contents.get("N/D.md"), DIVERGE);
      assert.match(reasonOf(res, "N/D.md"), /^accept_forbidden: .*cannot read as YAML does/);
      assert.equal(contents.get("N/B.md"), "Body [[It's]]\n");
    });

    test("a dry run reports the same refusals and writes nothing", async () => {
      const { call, writes } = repointServer(FILES);
      const res = await call({ ...REPOINT, dry_run: true });
      assert.deepEqual(writes, []);
      assert.match(reasonOf(res, "N/V.md"), /^accept_forbidden: /);
      assert.deepEqual(res.structuredContent.files.sort(), ["N/B.md", "N/O.md"]);
    });
  });
});
