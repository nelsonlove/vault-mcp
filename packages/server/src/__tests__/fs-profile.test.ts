/**
 * FS mode applies the connection profile in registerFsTools (#521): the same filter by name the
 * plugin applies at origRegister, and the profile's create-only write scope.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FS_JOURNAL_DIR_ENV_VAR } from "../fs-write-kernel.js";

let buildFsServer: (typeof import("../fs-mode.js"))["buildFsServer"];
let READ: Set<string>;
let READ_MESSAGE: Set<string>;
let FS_NAMES: string[];
let vault: string;
let journal: string;
// Built at run time from parts, so no key-shaped literal is committed; made up.
const FAKE_KEY = ["sk", "test", "A".repeat(24)].join("-");
const FAKE_BODY = ["MIIEv", "QIBADANBgkqhkiG9w0BAQEFAASC", "FAKE"].join("");

before(async () => {
  vault = await mkdtemp(path.join(tmpdir(), "fs-profile-"));
  journal = await mkdtemp(path.join(tmpdir(), "fs-profile-journal-"));
  process.env.VAULT_PATH = vault;
  process.env[FS_JOURNAL_DIR_ENV_VAR] = journal;
  await mkdir(path.join(vault, "00 Area", "00.01 Inbox"), { recursive: true });
  await mkdir(path.join(vault, "Notes"), { recursive: true });
  await writeFile(path.join(vault, "Notes", "a.md"), "# A\n");
  // A made-up key, for the secret scanner (read+message only).
  await writeFile(path.join(vault, "Notes", "keys.md"), `---\napi_key: fake-key-value\npassword: fake-pass\nAPI Key: fake-spaced\n---\nThe key is ${FAKE_KEY} here.\n\nhunt marker\n${FAKE_BODY}\n\n| Service | Password |\n|---|---|\n| mail | fake-cell |\n`);
  buildFsServer = (await import("../fs-mode.js")).buildFsServer;
  const core = await import("@vault-mcp/core");
  READ = new Set(core.READ_PROFILE_TOOLS);
  READ_MESSAGE = new Set(core.READ_MESSAGE_PROFILE_TOOLS);
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

  test("read+message: exactly the FS tools on its list; machine-state reads and writes are absent", async () => {
    const c = await client("read+message");
    const listed = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(listed, FS_NAMES.filter((n) => READ_MESSAGE.has(n)).sort());
    for (const n of listed) assert.ok(READ.has(n) || n === "vaultmcp_send_message", `${n} is a read or the message tool`);
    assert.ok(!listed.includes("obsidian_write_note"));
    const r = await c.callTool({ name: "obsidian_write_note", arguments: { path: "Notes/m.md", content: "x" } }).catch((e: unknown) => ({ thrown: String(e) }));
    assert.match(text(r), /not found|-32602/i);
    assert.ok(!existsSync(path.join(vault, "Notes", "m.md")));
    const read = await c.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/a.md" } });
    assert.match(text(read), /# A/);
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

  test("read+message blanks a key-shaped string in a reply; full sends the note unchanged; the file is untouched", async () => {
    const m = await client("read+message");
    const r = text(await m.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/keys.md" } }));
    assert.ok(!r.includes(FAKE_KEY), r);
    assert.ok(!r.includes("fake-key-value"), r);
    assert.match(r, /\[redacted:api-key\]/);
    assert.match(r, /api_key: \[redacted:secret\]/);
    // The structured copy is blanked too, and the text copy still parses as JSON.
    const res = (await m.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/keys.md" } })) as { content: Array<{ text: string }>; structuredContent?: { content?: string } };
    const sc = JSON.stringify(res.structuredContent);
    assert.ok(!/fake-key-value|fake-pass/.test(sc) && !sc.includes(FAKE_KEY), sc);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.content, res.structuredContent?.content);
    assert.match(parsed.content, /password: \[redacted:secret\]/);
    // A whole read keeps the key in view, so the spaced key and the table column are blanked; a
    // bare body line with no BEGIN header is not (only search snippets get that rule).
    assert.ok(!/fake-spaced|fake-cell/.test(text(res)), text(res));
    // A search hit carries one line: a key body line is blanked even without its key.
    const body = text(await m.callTool({ name: "obsidian_search_notes", arguments: { query: "QIBADANBgkqhkiG9w0" } }));
    assert.match(body, /redacted:secret/);
    assert.ok(!body.includes(FAKE_BODY), body);
    const s = text(await m.callTool({ name: "obsidian_search_notes", arguments: { query: "key is" } }));
    assert.ok(!s.includes(FAKE_KEY), s);
    await m.close();
    const f = await client("full");
    const raw = text(await f.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/keys.md" } }));
    assert.ok(raw.includes(FAKE_KEY), raw);
    assert.ok(raw.includes("fake-key-value"), raw);
    await f.close();
    const r2 = await client("read");
    assert.ok(text(await r2.callTool({ name: "obsidian_read_note", arguments: { path: "Notes/keys.md" } })).includes(FAKE_KEY));
    await r2.close();
    assert.match(await readFile(path.join(vault, "Notes", "keys.md"), "utf8"), new RegExp(FAKE_KEY));
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

