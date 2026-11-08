/**
 * trash-folder.test.mjs — obsidian_trash_folder (#634): trash an EMPTY folder, refuse a non-empty one.
 * Built through the REAL server wiring (buildMcpServer: the guard, the kernel with idempotency_key, the
 * journal, the allowlist, the write scope, the record folders) and called over a real MCP client. The vault
 * is an in-memory fake: folders with children, and a disk listing that can hold files Obsidian does not index.
 * Every path and name here is made up.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile, TFolder } from "./obsidian-stub.mjs";

installObsidianStub();
const { buildMcpServer } = await import("../src/mcp/server.ts");
const { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } = await import("../src/kernel/index.ts");
const { syncKindOf, STATUS_STRICT } = await import("../src/kernel/sync-guard.ts");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

/** `files`: indexed file paths; `folders`: extra (possibly empty) folder paths; `diskOnly`: files on disk the index does not show. */
function fakeApp({ files = [], folders = [], diskOnly = [], noList = false }) {
  const F = new Map();
  const D = new Map();
  const trashed = [];
  const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const folder = (p) => {
    if (!p) return null;
    if (!D.has(p)) {
      const f = new TFolder(p, []);
      D.set(p, f);
      const parent = folder(parentOf(p));
      if (parent) parent.children.push(f);
    }
    return D.get(p);
  };
  for (const d of folders) folder(d);
  for (const p of files) {
    const f = new TFile(p);
    f.stat = { mtime: 1000, ctime: 1, size: 1 };
    F.set(p, f);
    folder(parentOf(p))?.children.push(f);
  }
  const allDisk = () => [...F.keys(), ...diskOnly];
  const adapter = { basePath: "/nonexistent-vault" };
  if (!noList) {
    adapter.list = async (p) => ({
      files: allDisk().filter((x) => parentOf(x) === p),
      folders: [...D.keys()].filter((x) => parentOf(x) === p),
    });
  }
  const app = {
    vault: {
      adapter,
      configDir: ".obsidian",
      getName: () => "test",
      getMarkdownFiles: () => [...F.values()].filter((f) => f.extension === "md"),
      getFiles: () => [...F.values()],
      getAllLoadedFiles: () => [...F.values(), ...D.values()],
      getAbstractFileByPath: (p) => F.get(p) ?? D.get(p) ?? null,
      getRoot: () => new TFolder("", [...D.values()].filter((d) => !d.path.includes("/"))),
      on: () => ({}),
      read: async () => "",
      cachedRead: async () => "",
      async trash(f, system) {
        trashed.push({ path: f.path, system });
        for (const k of [...D.keys()]) if (k === f.path || k.startsWith(f.path + "/")) D.delete(k);
        F.delete(f.path);
      },
    },
    metadataCache: { initialized: true, resolvedLinks: {}, unresolvedLinks: {}, fileCache: {}, getFileCache: () => null, getFirstLinkpathDest: () => null, on: () => ({}) },
    workspace: { layoutReady: true, iterateAllLeaves: (cb) => cb({}), getActiveFile: () => null, on: () => ({}) },
    plugins: { plugins: {}, manifests: {}, enabledPlugins: new Set() },
    internalPlugins: { getPluginById: () => null },
    commands: { commands: {}, executeCommandById: () => true },
    fileManager: { async processFrontMatter() {} },
  };
  return { app, trashed, D };
}

async function harness(vault, { settings = {}, recordFolders } = {}) {
  const v = fakeApp(vault);
  const jfiles = new Map();
  const adapter = { async exists(p) { return jfiles.has(p); }, async mkdir() {}, async write(p, d) { jfiles.set(p, d); }, async append(p, d) { jfiles.set(p, (jfiles.get(p) ?? "") + d); } };
  const journal = new WriteJournal(adapter, "j", () => new Date("2026-11-08T12:00:00Z"));
  const kernel = new Kernel(new WriteQueue(5000), journal, { uid: () => undefined, rev: () => undefined, record: () => undefined }, new IdempotencyStore(), new LockStore());
  const ctx = {
    pluginVersion: "0.0.0", socketPath: "/tmp/none.sock", vaultName: "test", enabledPlugins: () => [],
    getSettings: () => ({ allowlist: [], readOnly: false, trustedReadOnlyPlugins: [], ...settings }),
    kernel,
    ...(recordFolders ? { recordFolders: () => recordFolders } : {}),
  };
  const server = buildMcpServer(v.app, ctx, {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(a);
  const call = (args) => client.callTool({ name: "obsidian_trash_folder", arguments: args });
  const records = () => (jfiles.get("j/2026-11.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { ...v, call, records, close: () => client.close() };
}

let n = 0;
const key = () => `tf-${++n}`;
const errText = (r) => (r.isError ? r.content[0].text : "");
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("obsidian_trash_folder", () => {
  test("an empty folder is trashed to the system trash and journaled", async () => {
    const h = await harness({ folders: ["Inbox/Old"], files: ["Inbox/Keep.md"] });
    const r = await h.call({ path: "Inbox/Old", idempotency_key: key() });
    assert.equal(r.isError, undefined, errText(r));
    assert.deepEqual(r.structuredContent, { path: "Inbox/Old", trashed: true, subfolders: 0 });
    assert.deepEqual(h.trashed, [{ path: "Inbox/Old", system: true }]);
    await tick();
    const rec = h.records().at(-1);
    assert.equal(rec.op, "obsidian_trash_folder");
    assert.equal(rec.outcome, "ok");
    await h.close();
  });

  test("it needs idempotency_key, and takes no if_rev", async () => {
    const h = await harness({ folders: ["A"] });
    assert.match(errText(await h.call({ path: "A" })), /^Error \[protection_required\].*idempotency_key/);
    assert.equal(h.trashed.length, 0);
    await h.close();
  });

  test("a folder that holds a file, at any depth, is refused and nothing is trashed", async () => {
    for (const files of [["A/n.md"], ["A/B/C/deep.md"], ["A/scan.pdf"]]) {
      const h = await harness({ files });
      const r = await h.call({ path: "A", idempotency_key: key() });
      assert.match(errText(r), /^Error \[folder_not_empty\]/, files[0]);
      assert.doesNotMatch(errText(r), /n\.md|deep\.md|scan\.pdf/, "the refusal names no file inside");
      assert.equal(h.trashed.length, 0, files[0]);
      await h.close();
    }
  });

  test("a file on disk that Obsidian does not index refuses it too; macOS's .DS_Store does not", async () => {
    const hidden = await harness({ folders: ["A"], diskOnly: ["A/.secret"] });
    assert.match(errText(await hidden.call({ path: "A", idempotency_key: key() })), /^Error \[folder_not_empty\]/);
    assert.equal(hidden.trashed.length, 0);
    await hidden.close();
    const ds = await harness({ folders: ["A"], diskOnly: ["A/.DS_Store"] });
    assert.equal((await ds.call({ path: "A", idempotency_key: key() })).isError, undefined);
    assert.equal(ds.trashed.length, 1);
    await ds.close();
  });

  test("subfolders: refused by default; with include_empty_subfolders, a chain of empty folders is trashed with it", async () => {
    const h = await harness({ folders: ["A/B/C", "A/D"] });
    assert.match(errText(await h.call({ path: "A", idempotency_key: key() })), /^Error \[folder_not_empty\].*include_empty_subfolders/);
    assert.equal(h.trashed.length, 0);
    const r = await h.call({ path: "A", include_empty_subfolders: true, idempotency_key: key() });
    assert.equal(r.isError, undefined, errText(r));
    assert.equal(r.structuredContent.subfolders, 3);
    assert.deepEqual(h.trashed, [{ path: "A", system: true }]);
    await h.close();
  });

  test("include_empty_subfolders never trashes a subfolder that holds a file", async () => {
    const h = await harness({ folders: ["A/B"], files: ["A/B/x.md"] });
    assert.match(errText(await h.call({ path: "A", include_empty_subfolders: true, idempotency_key: key() })), /^Error \[folder_not_empty\]/);
    assert.equal(h.trashed.length, 0);
    await h.close();
  });

  test("the root, a dot segment, a file, and a missing folder are refused", async () => {
    const h = await harness({ folders: ["A", ".hidden"], files: ["A2/n.md"] });
    for (const [path, re] of [["/", /invalid_argument.*root/], [".hidden", /invalid_argument.*dot/], ["A/.git", /invalid_argument.*dot/], ["A2/n.md", /not_a_folder/], ["Nope", /not_found/]]) {
      const r = await h.call({ path, idempotency_key: key() });
      assert.match(errText(r), re, path);
    }
    assert.equal(h.trashed.length, 0);
    await h.close();
  });

  test("a path with slashes around it is normalised", async () => {
    const h = await harness({ folders: ["A/B"] });
    assert.equal((await h.call({ path: "/A/B/", idempotency_key: key() })).isError, undefined);
    assert.deepEqual(h.trashed, [{ path: "A/B", system: true }]);
    await h.close();
  });

  test("a record folder, an archive folder, and a folder inside either are kept", async () => {
    const rf = { enabled: true, folders: ["Records"], archivePattern: "Archive$" };
    const h = await harness({ folders: ["Records", "Records/Sub", "Old Archive", "Old Archive/Box", "Plain"] }, { recordFolders: rf });
    for (const path of ["Records", "Records/Sub", "Old Archive", "Old Archive/Box"]) {
      assert.match(errText(await h.call({ path, idempotency_key: key() })), /^Error \[record_immutable\]/, path);
    }
    assert.equal(h.trashed.length, 0);
    assert.equal((await h.call({ path: "Plain", idempotency_key: key() })).isError, undefined, "an ordinary folder is trashed");
    await h.close();
  });

  test("read-only mode, the allowlist and the write scope refuse it before it runs", async () => {
    const ro = await harness({ folders: ["A"] }, { settings: { readOnly: true } });
    assert.match(errText(await ro.call({ path: "A", idempotency_key: key() })), /read.?only/i);
    await ro.close();
    const al = await harness({ folders: ["A", "Open"] }, { settings: { allowlist: ["Open/**"] } });
    assert.match(errText(await al.call({ path: "A", idempotency_key: key() })), /allowlist|not_allowlisted|out_of_allowlist/);
    await al.close();
    const ws = await harness({ folders: ["A"] }, { settings: { writeScope: { mode: "create-only", paths: ["**"] } } });
    assert.match(errText(await ws.call({ path: "A", idempotency_key: key() })), /^Error \[write_scope\]/);
    assert.equal(ro.trashed.length + al.trashed.length + ws.trashed.length, 0);
    await ws.close();
  });

  test("fails closed when the adapter cannot list the folder on disk", async () => {
    const h = await harness({ folders: ["A"], noList: true });
    const r = await h.call({ path: "A", idempotency_key: key() });
    assert.equal(r.isError, true);
    assert.match(errText(r), /cannot list a folder on disk/);
    assert.equal(h.trashed.length, 0);
    await h.close();
  });

  test("the Sync guard treats it as a delete: structure, on the strict list", () => {
    assert.equal(syncKindOf("obsidian_trash_folder", { path: "A" }), "structure");
    assert.ok(STATUS_STRICT.has("obsidian_trash_folder"));
  });
});
