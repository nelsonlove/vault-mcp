/**
 * obsidian_write_file / obsidian_edit_file / obsidian_move_file on the file-system server (#575),
 * over a real MCP client against a temp vault. The note tools' rules hold: writes are refused unless
 * the deployment opts in, every write is serialized and journaled, the write scope and the
 * connection profile apply, and `if_rev` / `idempotency_key` are accepted and not checked (this
 * server has no kernel, as for its note tools). The values are made up.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FsWriteKernel } from "../fs-write-kernel.js";

// Not imported from fs-mode.js: a static import would load @vault-mcp/core, whose vault root is
// fixed at load, before `before` sets VAULT_PATH to the temp vault.
const WRITE_SCOPE_ENV_VAR = "VAULT_MCP_WRITE_SCOPE";

let buildFsServer: (typeof import("../fs-mode.js"))["buildFsServer"];
let FILE_NAMES: readonly string[];
let FS_NAMES: string[];
let vault: string;
let journal: string;
let kernel: FsWriteKernel;

const BASE = "# made-up base\nviews:\n  - type: table\n    name: Table\n  - type: cards\n    name: Cards\n";
const CANVAS = JSON.stringify({ nodes: [{ id: "n1", type: "text", text: "One" }, { id: "n2", type: "text", text: "Two" }], edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }] }, null, "\t");

before(async () => {
  vault = await mkdtemp(path.join(tmpdir(), "fs-files-"));
  journal = await mkdtemp(path.join(tmpdir(), "fs-files-journal-"));
  process.env.VAULT_PATH = vault;
  await mkdir(path.join(vault, "Boards"), { recursive: true });
  await mkdir(path.join(vault, "Notes"), { recursive: true });
  await writeFile(path.join(vault, "Boards", "Plan.canvas"), CANVAS);
  await writeFile(path.join(vault, "Boards", "Tasks.base"), BASE);
  await writeFile(path.join(vault, "Notes", "Index.md"), "See [[Plan.canvas]].\n");
  const { FsWriteKernel: Kernel } = await import("../fs-write-kernel.js");
  kernel = new Kernel({ journalDir: journal, identity: { vault: "test", version: "0" } });
  const fsMode = await import("../fs-mode.js");
  assert.equal(fsMode.WRITE_SCOPE_ENV_VAR, WRITE_SCOPE_ENV_VAR);
  buildFsServer = fsMode.buildFsServer;
  const core = await import("@vault-mcp/core");
  FILE_NAMES = core.FILE_TOOL_NAMES;
  FS_NAMES = core.FS_TOOLS.map((t: { name: string }) => t.name);
});

after(async () => {
  delete process.env[WRITE_SCOPE_ENV_VAR];
  await rm(vault, { recursive: true, force: true });
  await rm(journal, { recursive: true, force: true });
});

async function client(opts: { allowWrites?: boolean; profile?: string } = {}) {
  const server = buildFsServer({ indexStatus: false, allowWrites: opts.allowWrites ?? true, kernel, ...(opts.profile !== undefined ? { profile: opts.profile } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(a);
  return c;
}

type Res = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as unknown as Res;
const err = (r: Res) => (r.isError ? r.content[0].text : "");
const read = (p: string) => readFile(path.join(vault, p), "utf8");
async function records(): Promise<Array<{ op: string; outcome: string }>> {
  const out: Array<{ op: string; outcome: string }> = [];
  for (const f of await readdir(journal, { recursive: true })) {
    if (!String(f).endsWith(".jsonl")) continue;
    for (const l of (await readFile(path.join(journal, String(f)), "utf8")).split("\n").filter(Boolean)) out.push(JSON.parse(l));
  }
  return out;
}

describe("the file tools on the file-system server", () => {
  test("listed beside the 17 note tools; no trash tool on this server", async () => {
    const c = await client();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...FS_NAMES, ...FILE_NAMES].sort());
    assert.equal(names.includes("obsidian_trash"), false);
    await c.close();
  });

  test("write: create, refuse invalid YAML and JSON with nothing written, overwrite; journaled", async () => {
    const c = await client();
    let r = await call(c, "obsidian_write_file", { path: "Boards/New.base", content: BASE });
    assert.equal(r.isError, undefined, err(r));
    assert.equal(await read("Boards/New.base"), BASE);
    for (const [p, content] of [["Boards/Bad.base", "views: [\n"], ["Boards/List.base", "- a\n"], ["Boards/Bad.canvas", "{nodes: []}"], ["Boards/Shape.canvas", "{\"edges\": {}}"], ["Boards/Dangling.canvas", "{\"nodes\": [{\"id\": \"a\"}], \"edges\": [{\"id\": \"e\", \"fromNode\": \"a\", \"toNode\": \"z\"}]}"], ["Boards/Alias.base", "a: &x 1\nb: *x\n"], ["Boards/Tag.base", "f: !!js/function \"x\"\n"]]) {
      r = await call(c, "obsidian_write_file", { path: p, content });
      assert.match(err(r), /^Error \[invalid_file\]/, p);
      assert.equal(existsSync(path.join(vault, p)), false, p);
    }
    r = await call(c, "obsidian_write_file", { path: "Boards/New.base", content: "views: [", overwrite: true });
    assert.match(err(r), /^Error \[invalid_file\]/);
    assert.equal(await read("Boards/New.base"), BASE, "an overwrite with bad content leaves the file as it was");
    r = await call(c, "obsidian_write_file", { path: "Boards/New.base", content: "views: []\n", overwrite: true });
    assert.equal(r.isError, undefined, err(r));
    assert.equal(await read("Boards/New.base"), "views: []\n");
    const ops = (await records()).filter((x) => x.op === "obsidian_write_file");
    assert.ok(ops.some((x) => x.outcome === "ok"));
    assert.ok(ops.some((x) => x.outcome === "error"), "a refused content is journaled as an error, at the write");
    await c.close();
  });

  test("path rules: wrong type, hidden folder, unsafe name, escaping path", async () => {
    const c = await client();
    for (const [p, re] of [
      ["Notes/x.md", /^Error \[unsupported_file\]/],
      [".obsidian/x.base", /^Error \[(unsupported_file|invalid_path)\]/],
      ["Boards/a:b.canvas", /^Error \[unsafe_name\]/],
      ["../outside.base", /^Error \[(invalid_path|unsupported_file)\]/],
    ] as const) {
      const r = await call(c, "obsidian_write_file", { path: p, content: "{}" });
      assert.match(err(r), re, p);
    }
    await c.close();
  });

  test("edit: upsert a view, remove a node and its edges; the kernel arguments are accepted and not checked", async () => {
    const c = await client();
    let r = await call(c, "obsidian_edit_file", { path: "Boards/Tasks.base", op: "upsert_view", item_json: JSON.stringify({ type: "list", name: "List" }), if_rev: 1, idempotency_key: "k-1" });
    assert.equal(r.isError, undefined, err(r));
    assert.match(await read("Boards/Tasks.base"), /name: List/);
    r = await call(c, "obsidian_edit_file", { path: "Boards/Plan.canvas", op: "remove_node", key: "n2" });
    assert.equal(r.isError, undefined, err(r));
    assert.deepEqual(r.structuredContent?.edges_removed, ["e1"]);
    assert.match(await read("Boards/Plan.canvas"), /\n\t"nodes"/, "tab indentation kept");
    r = await call(c, "obsidian_edit_file", { path: "Boards/Plan.canvas", op: "upsert_node", item_json: "{\"type\": \"text\"}" });
    assert.match(err(r), /^Error \[invalid_edit\]/);
    await c.close();
  });

  test("move: renames, keeps the type, says it rewrote no links", async () => {
    const c = await client();
    let r = await call(c, "obsidian_move_file", { from: "Boards/Plan.canvas", to: "Boards/Plan.base" });
    assert.match(err(r), /does not keep the extension/);
    r = await call(c, "obsidian_move_file", { from: "Boards/Plan.canvas", to: "Archive/Plan 2026.canvas", idempotency_key: "k-2" });
    assert.equal(r.isError, undefined, err(r));
    assert.equal(r.structuredContent?.backlinks_updated, 0);
    assert.match(String(r.structuredContent?.links_note), /does not rewrite links/);
    assert.equal(existsSync(path.join(vault, "Archive", "Plan 2026.canvas")), true);
    assert.equal(await read("Notes/Index.md"), "See [[Plan.canvas]].\n");
    await c.close();
  });

  test("the permanent delete stays notes-only: a .canvas is refused and stays", async () => {
    const c = await client();
    await writeFile(path.join(vault, "Boards", "Keep.canvas"), "{}");
    const r = await call(c, "obsidian_delete_note", { path: "Boards/Keep.canvas", confirm: true });
    assert.equal(r.isError, true);
    assert.equal(existsSync(path.join(vault, "Boards", "Keep.canvas")), true);
    await c.close();
  });

  test("writes not turned on: all three refused with fs_writes_disabled", async () => {
    const c = await client({ allowWrites: false });
    for (const [name, args] of [
      ["obsidian_write_file", { path: "Boards/Off.base", content: BASE }],
      ["obsidian_edit_file", { path: "Boards/Tasks.base", op: "remove_view", key: "Cards" }],
      ["obsidian_move_file", { from: "Boards/Tasks.base", to: "Boards/Moved.base" }],
    ] as const) {
      const r = await call(c, name, args);
      assert.match(err(r), /^Error \[fs_writes_disabled\]/, name);
    }
    assert.equal(existsSync(path.join(vault, "Boards", "Off.base")), false);
    await c.close();
  });

  test("under a write scope a .base is refused as base_under_scope (a Base is a query); a .canvas falls to the write scope, which refuses all three", async () => {
    process.env[WRITE_SCOPE_ENV_VAR] = JSON.stringify({ mode: "create-only", paths: ["**"] });
    try {
      const c = await client();
      for (const [name, args] of [
        ["obsidian_write_file", { path: "Boards/Scoped.base", content: BASE }],
        ["obsidian_edit_file", { path: "Boards/Tasks.base", op: "remove_view", key: "Table" }],
        ["obsidian_move_file", { from: "Boards/Tasks.base", to: "Boards/Moved.base" }],
      ] as const) {
        const r = await call(c, name, args);
        assert.match(err(r), /^Error \[base_under_scope\]: .*VAULT_MCP_WRITE_SCOPE/, name);
      }
      assert.equal(existsSync(path.join(vault, "Boards", "Scoped.base")), false);
      assert.match(await read("Boards/Tasks.base"), /name: Table/);
      const r = await call(c, "obsidian_write_file", { path: "Boards/Scoped.canvas", content: "{}" });
      assert.match(err(r), /^Error \[write_scope\]/);
      assert.equal(existsSync(path.join(vault, "Boards", "Scoped.canvas")), false);
      await c.close();
    } finally {
      delete process.env[WRITE_SCOPE_ENV_VAR];
    }
  });

  test("a profile without the tools does not list them, and a call is not found", async () => {
    for (const profile of ["read", "read+inbox", "read+message"]) {
      const c = await client({ profile });
      const names = (await c.listTools()).tools.map((t) => t.name);
      for (const n of FILE_NAMES) assert.equal(names.includes(n), false, `${profile}: ${n}`);
      const r = await call(c, "obsidian_write_file", { path: "Boards/P.base", content: BASE });
      assert.equal(r.isError, true, profile);
      assert.equal(existsSync(path.join(vault, "Boards", "P.base")), false, profile);
      await c.close();
    }
  });
});

describe("obsidian_move_file on attachment files (VAULT_MCP_FILE_MOVE_EXTENSIONS)", () => {
  const ENV = "VAULT_MCP_FILE_MOVE_EXTENSIONS";
  const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0xfe]);
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0xff]);
  const bytes = (p: string) => readFile(path.join(vault, p));
  const put = async (p: string, b: Buffer | string) => {
    await mkdir(path.dirname(path.join(vault, p)), { recursive: true });
    await writeFile(path.join(vault, p), b);
  };

  test("unset: the default list; a PDF and a zip move between folders with their bytes, journaled, and the note's embed is left (links_note)", async () => {
    delete process.env[ENV];
    await put("Inbox/Scan.pdf", PDF);
    await put("Inbox/Bundle.zip", ZIP);
    await put("Notes/Files.md", "![[Scan.pdf]]\n");
    const c = await client();
    let r = await call(c, "obsidian_move_file", { from: "Inbox/Scan.pdf", to: "Files/2026/Scan.pdf", idempotency_key: "a-1" });
    assert.equal(r.isError, undefined, err(r));
    assert.deepEqual(await bytes("Files/2026/Scan.pdf"), PDF);
    assert.equal(existsSync(path.join(vault, "Inbox", "Scan.pdf")), false);
    assert.match(String(r.structuredContent?.links_note), /does not rewrite links or embeds/);
    assert.equal(await read("Notes/Files.md"), "![[Scan.pdf]]\n");
    r = await call(c, "obsidian_move_file", { from: "Inbox/Bundle.zip", to: "Files/Bundle 2026.zip" });
    assert.equal(r.isError, undefined, err(r));
    assert.deepEqual(await bytes("Files/Bundle 2026.zip"), ZIP);
    const moves = (await records()).filter((x) => x.op === "obsidian_move_file" && x.outcome === "ok");
    assert.ok(moves.length >= 2, "each move is journaled");
    await c.close();
  });

  test("off the list, a type change, a note and a hidden folder are refused, and nothing moves", async () => {
    delete process.env[ENV];
    await put("Inbox/run.exe", "x");
    await put("Inbox/Two.pdf", PDF);
    const c = await client();
    for (const [from, to, want] of [
      ["Inbox/run.exe", "Files/run.exe", /^Error \[unsupported_file\]: .*does not move here/],
      ["Inbox/Two.pdf", "Inbox/Two.zip", /does not keep the extension/],
      ["Inbox/Two.pdf", "Inbox/Two.PDF", /does not keep the extension/],
      ["Notes/Index.md", "Archive/Index.md", /obsidian_move_note/],
      ["Inbox/Two.pdf", ".hidden/Two.pdf", /^Error \[unsupported_file\]/],
    ] as const) {
      const r = await call(c, "obsidian_move_file", { from, to });
      assert.match(err(r), want, `${from} -> ${to}`);
    }
    assert.equal(existsSync(path.join(vault, "Inbox", "run.exe")), true);
    assert.equal(existsSync(path.join(vault, "Inbox", "Two.pdf")), true);
    assert.equal(existsSync(path.join(vault, "Notes", "Index.md")), true);
    await c.close();
  });

  test("the variable sets the list: empty moves only .base and .canvas; a listed type moves", async () => {
    await put("Inbox/Three.pdf", PDF);
    await put("Inbox/Photo.heic", "x");
    process.env[ENV] = "";
    try {
      const c = await client();
      let r = await call(c, "obsidian_move_file", { from: "Inbox/Three.pdf", to: "Files/Three.pdf" });
      assert.match(err(r), /^Error \[unsupported_file\]/);
      assert.equal(existsSync(path.join(vault, "Inbox", "Three.pdf")), true);
      process.env[ENV] = "pdf, HEIC";
      r = await call(c, "obsidian_move_file", { from: "Inbox/Photo.heic", to: "Files/Photo.heic" });
      assert.equal(r.isError, undefined, err(r));
      r = await call(c, "obsidian_move_file", { from: "Inbox/Three.pdf", to: "Files/Three.pdf" });
      assert.equal(r.isError, undefined, err(r));
      await c.close();
    } finally {
      delete process.env[ENV];
    }
  });

  test("both ends are path-checked: an escape at either end is refused, and a write scope refuses the move", async () => {
    await put("Inbox/Four.pdf", PDF);
    const c = await client();
    for (const [from, to] of [["Inbox/Four.pdf", "../Four.pdf"], ["../Four.pdf", "Files/Four.pdf"]]) {
      const r = await call(c, "obsidian_move_file", { from, to });
      assert.equal(r.isError, true, `${from} -> ${to}`);
    }
    assert.equal(existsSync(path.join(vault, "Inbox", "Four.pdf")), true);
    assert.equal(existsSync(path.join(vault, "..", "Four.pdf")), false);
    await c.close();
    process.env[WRITE_SCOPE_ENV_VAR] = JSON.stringify({ mode: "create-only", paths: ["**"] });
    try {
      const s = await client();
      const r = await call(s, "obsidian_move_file", { from: "Inbox/Four.pdf", to: "Files/Four.pdf" });
      assert.match(err(r), /^Error \[write_scope\]/);
      assert.equal(existsSync(path.join(vault, "Inbox", "Four.pdf")), true);
      await s.close();
    } finally {
      delete process.env[WRITE_SCOPE_ENV_VAR];
    }
  });

  test("a move never replaces an attachment: overwrite: true is refused and both files stay (fs.rename would destroy one)", async () => {
    await put("Inbox/Five.pdf", "new");
    await put("Files/Five.pdf", "original");
    const c = await client();
    const r = await call(c, "obsidian_move_file", { from: "Inbox/Five.pdf", to: "Files/Five.pdf", overwrite: true });
    assert.match(err(r), /^Error \[overwrite_refused\]/);
    assert.equal(await read("Files/Five.pdf"), "original");
    assert.equal(await read("Inbox/Five.pdf"), "new");
    await c.close();
  });

  test("a set but malformed variable means only .base and .canvas move, never the default", async () => {
    await put("Inbox/Six.pdf", PDF);
    process.env[ENV] = "pdf;zip";
    try {
      const c = await client();
      const r = await call(c, "obsidian_move_file", { from: "Inbox/Six.pdf", to: "Files/Six.pdf" });
      assert.match(err(r), /^Error \[unsupported_file\]/);
      assert.equal(existsSync(path.join(vault, "Inbox", "Six.pdf")), true);
      await c.close();
    } finally {
      delete process.env[ENV];
    }
  });

  test("obsidian_read_note on a binary file returns {path, size, binary: true} and no content", async () => {
    await put("Inbox/Seven.pdf", PDF);
    await put("Inbox/blob.dat", Buffer.from([1, 2, 0, 3]));
    await put("Inbox/readme.txt", "hello");
    const c = await client();
    for (const full of [false, true]) {
      const r = await call(c, "obsidian_read_note", { path: "Inbox/Seven.pdf", ...(full ? { full } : {}) });
      assert.equal(r.isError, undefined, err(r));
      assert.deepEqual(r.structuredContent, { path: "Inbox/Seven.pdf", size: PDF.length, binary: true });
    }
    let r = await call(c, "obsidian_read_note", { path: "Inbox/blob.dat" });
    assert.deepEqual(r.structuredContent, { path: "Inbox/blob.dat", size: 4, binary: true });
    r = await call(c, "obsidian_read_note", { path: "Inbox/readme.txt" });
    assert.equal(r.structuredContent?.content, "hello");
    await c.close();
  });

  test("only the move widens: obsidian_write_file still refuses a PDF", async () => {
    const c = await client();
    const r = await call(c, "obsidian_write_file", { path: "Inbox/New.pdf", content: "%PDF-1.7" });
    assert.match(err(r), /^Error \[unsupported_file\]/);
    assert.equal(existsSync(path.join(vault, "Inbox", "New.pdf")), false);
    await c.close();
  });
});
