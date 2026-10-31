/**
 * scheme-write-live-move.test.mjs — Task 5 of the scope-provider module:
 * real-Obsidian move verification + uid stability.
 *
 * The three mutating scheme tools (tools-scheme-write.ts, Task 4) all move a
 * note by calling `moveOne` (tools-vault-write.ts), which in turn calls
 * `app.fileManager.renameFile` — Obsidian's link-updating rename. That API
 * renames a path; it never opens, rewrites, or otherwise touches the file's
 * bytes. So a note's `uid` frontmatter — or any other content — must survive
 * a scheme mutation byte-for-byte. That is a property of the REAL handler
 * (moveOne, imported unmodified below), not of a re-implementation, so this
 * file follows link-healing.test.mjs's precedent: install the obsidian stub,
 * then `await import()` the real tool module so `renameFile` is exercised
 * for real rather than assumed.
 *
 * The stub-vault fixture here extends link-healing.test.mjs's fakeVault with
 * a `body` map (path -> raw markdown text, frontmatter included) that
 * `fileManager.renameFile` carries across the rename — exactly mirroring
 * what a real vault does (the bytes move with the file). Nothing in moveOne
 * or the scheme-write tools touches `body` directly; it exists only so this
 * test can read the note's content back through the same path table the
 * production code moved, and prove nothing happened to it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile, TFolder, parseYaml } from "./obsidian-stub.mjs";
import { makeRegistry } from "../src/kernel/scheme/registry.ts";
import { JD_SCHEMES } from "./scheme-fixture.mjs";

// The write tools import `moveOne`, which imports live `TFile`/`TAbstractFile`
// from "obsidian" — stub must be installed before that module is imported.
installObsidianStub();
const { registerSchemeWriteTools } = await import("../src/mcp/tools-scheme-write.ts");

// Same fixture scheme-write-tools.test.mjs uses for obsidian_assign_address:
// "Unfiled/New thing.md" has no address yet, and scope "06" resolves to
// "00-09 System/06 Agent tooling" with "06.10" the next free slot — already
// pinned deterministic by that file's own dry_run/live tests.
const NOTES = [
  "00-09 System/00.00 Index.md",
  "00-09 System/06 Agent tooling/06.00 JDex.md",
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "90-99 Projects/92021 Big thing/92021.10 Sub.md",
  "Unfiled/New thing.md",
];

const FOLDERS = [
  "00-09 System",
  "00-09 System/06 Agent tooling",
  "90-99 Projects",
  "90-99 Projects/92021 Big thing",
  "Unfiled",
];

const FROM = "Unfiled/New thing.md";
const TO = "00-09 System/06 Agent tooling/06.10 New thing.md";
const UID = "01J8QK7ZC9XG3E5N6P0R2T4V6W";
const TARGET_CONTENT = `---\nuid: ${UID}\ntitle: New thing\n---\n# New thing\n\nSome body text.\n`;

/**
 * A vault that records how it was moved (link-healing.test.mjs's three
 * spies: vaultRename — the file-level rename moveOne now takes (move-with-links.ts);
 * renameFile — throws, so "never reached" is a real assertion about a real
 * method (it waits for a clean metadata cache); createFolder — harmless bookkeeping) PLUS a `body` map carrying
 * each note's raw text across a rename, the way a real vault's bytes do.
 */
function fakeApp({ files = NOTES, folders = FOLDERS, contents = {} } = {}) {
  const tree = new Map(files.map((p) => [p, new TFile(p)]));
  const dirs = new Set(folders);
  const body = new Map(Object.entries(contents));
  const calls = { renameFile: [], vaultRename: [] };
  const app = {
    vault: {
      getAbstractFileByPath: (p) => tree.get(p) ?? (dirs.has(p) ? new TFolder(p) : null),
      async createFolder(p) {
        dirs.add(p);
      },
      async trash(file) {
        tree.delete(file.path);
        body.delete(file.path);
      },
      // moveOne renames at the file level (move-with-links.ts): the bytes move
      // with the path and are never opened for rewriting unless a link to the
      // note must change — which no note here has.
      async rename(file, to) {
        calls.vaultRename.push([file.path, to]);
        const text = body.get(file.path);
        tree.delete(file.path);
        body.delete(file.path);
        file.path = to;
        tree.set(to, file);
        if (text !== undefined) body.set(to, text);
      },
      getMarkdownFiles: () => [...tree.values()],
      read: async (f) => body.get(f.path) ?? "",
      cachedRead: async (f) => body.get(f.path) ?? "",
      async process(f, fn) { const n = fn(body.get(f.path) ?? ""); body.set(f.path, n); return n; },
    },
    metadataCache: { resolvedLinks: {}, getFileCache: () => ({ links: [], embeds: [] }), getFirstLinkpathDest: () => null, fileToLinktext: (f) => f.basename },
    fileManager: {
      async renameFile(file, to) {
        calls.renameFile.push([file.path, to]);
        throw new Error("renameFile waits for a clean metadata cache — moves go through moveWithLinks");
      },
    },
  };
  return { app, calls, tree, body };
}

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, def, handler) {
      tools.set(name, { def, handler });
    },
  };
}

function toolServer({ schemes = JD_SCHEMES, notes = NOTES, folders = FOLDERS, contents = {} } = {}) {
  const { app, calls, tree, body } = fakeApp({ files: notes, folders, contents });
  const server = fakeServer();
  registerSchemeWriteTools(server, app, {
    registry: () => makeRegistry(schemes),
    notes: () => [...tree.values()].map((f) => f.path),
    getSettings: () => ({ readOnly: false, allowlist: [], schemes }),
  });
  const call = (name, args = {}) => server.tools.get(name).handler(args, {});
  return { call, calls, tree, body };
}

/** Pull the frontmatter block out of raw note text via the stub's own YAML
 * reader — the same reader the guard's accept-forbidden checks use, so this
 * reads frontmatter the way the rest of the test suite already trusts. */
function frontmatterOf(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(m, "note is missing a frontmatter block");
  return parseYaml(m[1]);
}

test("obsidian_assign_address moves the note through fileManager.renameFile and never touches its uid", async () => {
  const { call, calls, tree, body } = toolServer({ contents: { [FROM]: TARGET_CONTENT } });

  const before = frontmatterOf(body.get(FROM));
  assert.equal(before.uid, UID, "fixture sanity: the uid is there before the move");

  const res = await call("obsidian_assign_address", { path: FROM, scope: "06", dry_run: false });
  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  assert.deepEqual(res.structuredContent.moves, [{ from: FROM, to: TO }]);

  // The move really happened — old path gone, new path present — so the uid
  // assertion below isn't trivially true from a no-op.
  assert.equal(tree.has(FROM), false, "old path must no longer resolve to a file");
  assert.equal(tree.has(TO), true, "new path must resolve to the moved file");
  assert.equal(res.structuredContent.address, "06.10");

  // It went through the link-aware rename, never the non-link-aware one.
  assert.deepEqual(calls.vaultRename, [[FROM, TO]]);
  assert.deepEqual(calls.renameFile, []);

  // The whole point: read the note's frontmatter back at its NEW path and
  // confirm the uid is byte-identical to what it was before the move.
  const movedText = body.get(TO);
  assert.equal(body.has(FROM), false, "no stale content left behind at the old path");
  assert.equal(movedText, TARGET_CONTENT, "renameFile must not alter the note's bytes at all");
  const after = frontmatterOf(movedText);
  assert.equal(after.uid, UID, "a rename must never change the note's uid");
});
