/**
 * The retired `<scheme-id>:<address>` path syntax on the file-system server (Nelson, 2026-10-30:
 * "retire em"). With `VAULT_MCP_SCHEMES` naming a scheme, a path argument that starts with that
 * scheme's id and a colon is refused with `scheme_ref_retired` on every road (read, write, patch,
 * append, move from and to, delete, frontmatter, the file tools, replace text) before anything runs:
 * it is never read as a plain path, even when a file of that literal name exists. With no scheme,
 * the same string is an ordinary path. The values are made up.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FsWriteKernel } from "../fs-write-kernel.js";

// Not imported from core: a static import would fix core's vault root before `before` sets VAULT_PATH.
const SCHEMES_ENV_VAR = "VAULT_MCP_SCHEMES";
const SCHEMES = JSON.stringify([{ id: "jd", provider: "johnny-decimal" }, { id: "area-codes", provider: "johnny-decimal" }]);
// A file whose literal name is the ref: before the retirement a read of "jd:06.11" with no
// scheme would read it, so a refusal here proves the ref is not read as a plain path.
const LITERAL = "jd:06.11";
const LITERAL_BODY = "literal file named like a ref\n";

let buildFsServer: (typeof import("../fs-mode.js"))["buildFsServer"];
let vault: string;
let journal: string;
let kernel: FsWriteKernel;

before(async () => {
  vault = await mkdtemp(path.join(tmpdir(), "fs-scheme-refs-"));
  journal = await mkdtemp(path.join(tmpdir(), "fs-scheme-refs-journal-"));
  process.env.VAULT_PATH = vault;
  await mkdir(path.join(vault, "Notes"), { recursive: true });
  await writeFile(path.join(vault, "Notes", "A.md"), "# H\n\nbody\n");
  await writeFile(path.join(vault, "Boards.base"), "views:\n  - type: table\n    name: T\n");
  await writeFile(path.join(vault, LITERAL), LITERAL_BODY);
  const { FsWriteKernel: Kernel } = await import("../fs-write-kernel.js");
  kernel = new Kernel({ journalDir: journal, identity: { vault: "test", version: "0" } });
  buildFsServer = (await import("../fs-mode.js")).buildFsServer;
});

after(async () => {
  delete process.env[SCHEMES_ENV_VAR];
  await rm(vault, { recursive: true, force: true });
  await rm(journal, { recursive: true, force: true });
});

async function client() {
  const server = buildFsServer({ indexStatus: false, allowWrites: true, kernel });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(a);
  return c;
}

type Res = { isError?: boolean; content: Array<{ text: string }> };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as unknown as Res;
const text = (r: Res) => r.content[0]?.text ?? "";
async function journaled(): Promise<number> {
  let n = 0;
  for (const f of await readdir(journal, { recursive: true })) {
    if (String(f).endsWith(".jsonl")) n += (await readFile(path.join(journal, String(f)), "utf8")).split("\n").filter(Boolean).length;
  }
  return n;
}

const RETIRED = /^Error \[scheme_ref_retired\]: "jd:06\.11" uses the scheme-address path syntax \("jd:<address>"\), which is retired; name the note by a vault-relative path$/;

const ROADS: Array<[string, string, Record<string, unknown>]> = [
  ["read", "obsidian_read_note", { path: LITERAL }],
  ["batch read", "obsidian_read_notes", { paths: ["Notes/A.md", LITERAL] }],
  ["write", "obsidian_write_note", { path: LITERAL, content: "x", overwrite: true }],
  ["patch", "obsidian_patch_note", { path: LITERAL, anchor_type: "heading", anchor: "H", op: "append", content: "x" }],
  ["append", "obsidian_append_note", { path: LITERAL, content: "x" }],
  ["move (from)", "obsidian_move_note", { from: LITERAL, to: "Notes/B.md" }],
  ["move (to)", "obsidian_move_note", { from: "Notes/A.md", to: LITERAL }],
  ["delete", "obsidian_delete_note", { path: LITERAL, confirm: true }],
  ["frontmatter", "obsidian_manage_frontmatter", { path: LITERAL, op: "get", key: "k" }],
  ["replace text", "obsidian_replace_text", { path: LITERAL, old: "literal", new: "x" }],
  ["write file", "obsidian_write_file", { path: LITERAL, content: "views: []\n", overwrite: true }],
  ["move file", "obsidian_move_file", { from: "Boards.base", to: LITERAL }],
];

describe("a jd: ref is refused on every road of the file-system server", () => {
  before(() => {
    process.env[SCHEMES_ENV_VAR] = SCHEMES;
  });

  for (const [road, tool, args] of ROADS) {
    test(road, async () => {
      const c = await client();
      const before = await journaled();
      const r = await call(c, tool, args);
      if (road === "batch read") {
        // The batch reads per item: the ref is a per-item error, the plain path still reads.
        const body = JSON.parse(text(r));
        assert.equal(body.error_count, 1);
        assert.match(body.errors[0].error, /scheme-address path syntax .*which is retired/);
        assert.deepEqual(body.notes.map((n: { path: string }) => n.path), ["Notes/A.md"]);
      } else {
        assert.equal(r.isError, true, text(r));
        assert.match(text(r), RETIRED);
      }
      assert.equal(await journaled(), before, "refused before the queue: nothing journaled");
      assert.equal(await readFile(path.join(vault, LITERAL), "utf8"), LITERAL_BODY, "the literal file is untouched");
      assert.equal(await readFile(path.join(vault, "Notes", "A.md"), "utf8"), "# H\n\nbody\n");
      await c.close();
    });
  }

  test("any configured id is refused, and a colon after an unconfigured id is an ordinary path", async () => {
    const c = await client();
    let r = await call(c, "obsidian_read_note", { path: "area-codes:06.11" });
    assert.match(text(r), /^Error \[scheme_ref_retired\]: "area-codes:06\.11"/);
    r = await call(c, "obsidian_read_note", { path: "nope:06.11" });
    assert.doesNotMatch(text(r), /scheme_ref_retired/);
    r = await call(c, "obsidian_read_note", { path: "Notes/A.md" });
    assert.equal(r.isError, undefined, text(r));
    await c.close();
  });
});

describe("with no scheme configured, the same string is an ordinary path", () => {
  before(() => {
    delete process.env[SCHEMES_ENV_VAR];
  });

  test("the literal file reads", async () => {
    const c = await client();
    const r = await call(c, "obsidian_read_note", { path: LITERAL });
    assert.equal(r.isError, undefined, text(r));
    assert.match(text(r), /literal file named like a ref/);
    await c.close();
  });
});
