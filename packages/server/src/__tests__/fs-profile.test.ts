/**
 * FS mode applies the connection profile in registerFsTools (#521): the same filter by name the
 * plugin applies at origRegister, and the profile's create-only write scope.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FS_JOURNAL_DIR_ENV_VAR } from "../fs-write-kernel.js";

let buildFsServer: (typeof import("../fs-mode.js"))["buildFsServer"];
let READ: Set<string>;
let FS_NAMES: string[];
let vault: string;
let journal: string;

before(async () => {
  vault = await mkdtemp(path.join(tmpdir(), "fs-profile-"));
  journal = await mkdtemp(path.join(tmpdir(), "fs-profile-journal-"));
  process.env.VAULT_PATH = vault;
  process.env[FS_JOURNAL_DIR_ENV_VAR] = journal;
  await mkdir(path.join(vault, "00 Area", "00.01 Inbox"), { recursive: true });
  await mkdir(path.join(vault, "Notes"), { recursive: true });
  await writeFile(path.join(vault, "Notes", "a.md"), "# A\n");
  buildFsServer = (await import("../fs-mode.js")).buildFsServer;
  const core = await import("@vault-mcp/core");
  READ = new Set(core.READ_PROFILE_TOOLS);
  FS_NAMES = core.FS_TOOLS.map((t: { name: string }) => t.name);
  await core.buildIndex();
});

after(async () => {
  await rm(vault, { recursive: true, force: true });
  await rm(journal, { recursive: true, force: true });
  delete process.env[FS_JOURNAL_DIR_ENV_VAR];
});

async function client(profile?: string) {
  const server = buildFsServer({ indexStatus: false, allowWrites: true, ...(profile !== undefined ? { profile } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(a);
  return c;
}

const text = (r: unknown) => JSON.stringify(r);

describe("FS mode under a profile", () => {
  test("no profile: every FS tool, as before", async () => {
    const c = await client();
    assert.deepEqual((await c.listTools()).tools.map((t) => t.name).sort(), [...FS_NAMES].sort());
    await c.close();
  });

  test("read: exactly the FS tools on the read list; a write tool is not callable", async () => {
    const c = await client("read");
    const listed = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(listed, FS_NAMES.filter((n) => READ.has(n)).sort());
    assert.ok(!listed.includes("obsidian_write_note"));
    const r = await c.callTool({ name: "obsidian_write_note", arguments: { path: "Notes/b.md", content: "x" } }).catch((e: unknown) => ({ thrown: String(e) }));
    assert.match(text(r), /not found|-32602/i);
    assert.ok(!existsSync(path.join(vault, "Notes", "b.md")));
    const read = await c.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/a.md" } });
    assert.match(text(read), /# A/);
    await c.close();
  });

  test("read+inbox: a new note in a .01 folder is written; anywhere else, or an overwrite, is refused", async () => {
    const c = await client("read+inbox");
    const bad = await c.callTool({ name: "obsidian_write_note", arguments: { path: "Notes/c.md", content: "x" } });
    assert.match(text(bad), /write_scope/);
    assert.ok(!existsSync(path.join(vault, "Notes", "c.md")));
    const over = await c.callTool({ name: "obsidian_write_note", arguments: { path: "Notes/a.md", content: "x", overwrite: true } });
    assert.match(text(over), /write_scope/);
    const good = await c.callTool({ name: "obsidian_write_note", arguments: { path: "00 Area/00.01 Inbox/new.md", content: "hello" } });
    assert.doesNotMatch(text(good), /isError":true/, text(good));
    assert.ok(existsSync(path.join(vault, "00 Area", "00.01 Inbox", "new.md")));
    const again = await c.callTool({ name: "obsidian_write_note", arguments: { path: "00 Area/00.01 Inbox/new.md", content: "x" } });
    assert.match(text(again), /write_scope|exists/);
    await c.close();
  });

  test("an unknown profile: no tools at all", async () => {
    const c = await client("admin");
    assert.deepEqual((await c.listTools().catch(() => ({ tools: [] }))).tools, []);
    await c.close();
  });
  test("#562 review 1: an HTML-encoded path cannot leave the inbox (the check sees what the handler writes)", async () => {
    const c = await client("read+inbox");
    for (const p of ["00 Area/00.01 Inbox/x&#47;..&#47;..&#47;..&#47;Notes&#47;escaped.md", "00 Area/00.01 Inbox/sub&#47;nested.md"]) {
      const r = await c.callTool({ name: "obsidian_write_note", arguments: { path: p, content: "x" } });
      assert.equal((r as { isError?: boolean }).isError, true, p);
    }
    assert.equal(existsSync(path.join(vault, "Notes", "escaped.md")), false);
    assert.equal(existsSync(path.join(vault, "00 Area", "00.01 Inbox", "sub")), false);
    await c.close();
  });
});

