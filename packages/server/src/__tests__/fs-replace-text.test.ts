/**
 * obsidian_replace_text on the file-system server, over a real MCP client against a temp vault.
 * The note tools' rules hold: writes are refused unless the deployment opts in, every write is
 * serialized and journaled (one record, as its own op, with `old` and `new` digested like a body),
 * the write scope and the connection profile apply, and `if_rev` / `idempotency_key` are accepted
 * and not checked (this server has no kernel, as for its note tools). The plan and the accept guard
 * are the ones the live host runs. The notes are made up.
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

const WRITE_SCOPE_ENV_VAR = "VAULT_MCP_WRITE_SCOPE";
const T = "obsidian_replace_text";
const NOTE = "---\ntitle: Plan\nstatus: draft\n---\n# Plan\n\nThe colour is blue.\nThe sky is blue.\n";

let buildFsServer: (typeof import("../fs-mode.js"))["buildFsServer"];
let LIMIT: number;
let vault: string;
let journal: string;
let kernel: FsWriteKernel;

before(async () => {
  vault = await mkdtemp(path.join(tmpdir(), "fs-replace-"));
  journal = await mkdtemp(path.join(tmpdir(), "fs-replace-journal-"));
  process.env.VAULT_PATH = vault;
  await mkdir(path.join(vault, "Notes"), { recursive: true });
  const { FsWriteKernel: Kernel } = await import("../fs-write-kernel.js");
  kernel = new Kernel({ journalDir: journal, identity: { vault: "test", version: "0" } });
  buildFsServer = (await import("../fs-mode.js")).buildFsServer;
  LIMIT = (await import("@vault-mcp/core")).CHARACTER_LIMIT;
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
const put = (p: string, t: string) => writeFile(path.join(vault, p), t);
type Rec = { op: string; outcome: string; argsDigest?: Record<string, unknown>; target?: { path?: string } };
async function records(): Promise<Rec[]> {
  const out: Rec[] = [];
  for (const f of await readdir(journal, { recursive: true })) {
    if (!String(f).endsWith(".jsonl")) continue;
    for (const l of (await readFile(path.join(journal, String(f)), "utf8")).split("\n").filter(Boolean)) out.push(JSON.parse(l));
  }
  return out;
}

describe("obsidian_replace_text on the file-system server", () => {
  test("one match: replaced, spans returned, no rev on this server; journaled once with the note text digested", async () => {
    await put("Notes/One.md", NOTE);
    const c = await client();
    const r = await call(c, T, { path: "Notes/One.md", old: "colour is blue", new: "colour is green", if_rev: 1, idempotency_key: "k1" });
    assert.equal(r.isError, undefined, err(r));
    assert.equal(await read("Notes/One.md"), NOTE.replace("colour is blue", "colour is green"));
    const s = r.structuredContent!;
    assert.equal(s.count, 1);
    assert.equal(s.rev, undefined, "this server shows no rev");
    assert.match((s.spans as Array<{ after: string }>)[0].after, /colour is green/);
    const rec = (await records()).filter((x) => x.op === T && x.target?.path === "Notes/One.md");
    assert.equal(rec.length, 1);
    assert.equal(rec[0].outcome, "ok");
    assert.equal(rec[0].argsDigest?.old, "<14 chars>");
    assert.equal(rec[0].argsDigest?.new, "<15 chars>");
    await c.close();
  });

  test("all: true replaces every match; without it, many matches are refused with the count; 0 matches too", async () => {
    await put("Notes/Many.md", NOTE);
    const c = await client();
    let r = await call(c, T, { path: "Notes/Many.md", old: "blue", new: "red" });
    assert.match(err(r), /^Error \[many_matches\]: .*found 2 times/);
    r = await call(c, T, { path: "Notes/Many.md", old: "purple", new: "red" });
    assert.match(err(r), /^Error \[no_match\]: .*0 times/);
    assert.equal(await read("Notes/Many.md"), NOTE);
    r = await call(c, T, { path: "Notes/Many.md", old: "blue", new: "red", all: true });
    assert.equal(r.isError, undefined, err(r));
    assert.equal(r.structuredContent!.count, 2);
    assert.equal(await read("Notes/Many.md"), NOTE.replaceAll("blue", "red"));
    await c.close();
  });

  test("CRLF note: matched on its own line endings", async () => {
    await put("Notes/Win.md", "a\r\nb\r\n");
    const c = await client();
    let r = await call(c, T, { path: "Notes/Win.md", old: "a\nb", new: "c" });
    assert.match(err(r), /^Error \[no_match\]: .*CRLF/);
    r = await call(c, T, { path: "Notes/Win.md", old: "a\r\nb", new: "c" });
    assert.equal(r.isError, undefined, err(r));
    assert.equal(await read("Notes/Win.md"), "c\r\n");
    await c.close();
  });

  test("the accept guard: a verified entry and the acceptance keys cannot be changed or set", async () => {
    const rec = "---\nverified:\n  - by: human:pat\n    at: 2026-09-25T05:08:39-04:00\ntitle: T\n---\nbody\n";
    await put("Notes/V.md", rec);
    await put("Notes/A.md", NOTE);
    const c = await client();
    for (const [old, nw] of [["human:pat", "human:sam"], ["verified:\n  - by: human:pat\n    at: 2026-09-25T05:08:39-04:00\n", ""]]) {
      const r = await call(c, T, { path: "Notes/V.md", old, new: nw });
      assert.match(err(r), /^Error \[accept_forbidden\]: .*verification field 'verified'/, old);
    }
    for (const nw of ["acceptance-status: accepted", "accepted-by: someone", "verified:\n  - by: human:pat"]) {
      const r = await call(c, T, { path: "Notes/A.md", old: "status: draft", new: nw });
      assert.match(err(r), /^Error \[accept_forbidden\]/, nw);
    }
    assert.equal(await read("Notes/V.md"), rec);
    assert.equal(await read("Notes/A.md"), NOTE);
    await c.close();
  });

  test("the frontmatter guard: fences, an early close, broken YAML and a new block are refused", async () => {
    await put("Notes/F.md", NOTE);
    await put("Notes/Bare.md", "Hello\n");
    const c = await client();
    for (const [p, old, nw] of [
      ["Notes/F.md", "draft\n---\n# Plan", "draft\n# Plan"],
      ["Notes/F.md", "status: draft", "status: draft\n---\nx"],
      ["Notes/F.md", "status: draft", "status: [draft"],
      ["Notes/Bare.md", "Hello\n", "---\na: 1\n---\nHello\n"],
    ]) {
      const r = await call(c, T, { path: p, old, new: nw });
      assert.match(err(r), /^Error \[frontmatter_edit\]/, `${p}: ${old}`);
    }
    assert.equal(await read("Notes/F.md"), NOTE);
    assert.equal(await read("Notes/Bare.md"), "Hello\n");
    await c.close();
  });

  test("a truncated read: `new` with the read trailer, and a match past the read limit on a long note (no proof on this server)", async () => {
    const long = "head\n" + "x".repeat(LIMIT + 10) + "\ntail\n";
    await put("Notes/Long.md", long);
    await put("Notes/T.md", NOTE);
    const c = await client();
    let r = await call(c, T, { path: "Notes/T.md", old: "sky", new: "sky\n[truncated: note is 200000 chars, showing first 100000]" });
    assert.match(err(r), /^Error \[truncated_read\]/);
    r = await call(c, T, { path: "Notes/Long.md", old: "tail", new: "end" });
    assert.match(err(r), /^Error \[truncated_read\]/);
    assert.equal(await read("Notes/Long.md"), long);
    r = await call(c, T, { path: "Notes/Long.md", old: "head", new: "top" });
    assert.equal(r.isError, undefined, err(r));
    assert.equal(await read("Notes/Long.md"), long.replace("head", "top"), "the tail is kept");
    await c.close();
  });

  test("paths: an escaping path is invalid_path; a missing note is not created", async () => {
    const c = await client();
    let r = await call(c, T, { path: "../out.md", old: "a", new: "b" });
    assert.match(err(r), /^Error \[invalid_path\]/);
    r = await call(c, T, { path: "Notes/None.md", old: "a", new: "b" });
    assert.equal(r.isError, true);
    assert.equal(existsSync(path.join(vault, "Notes", "None.md")), false);
    await c.close();
  });

  test("writes not turned on: fs_writes_disabled; a create-only write scope: write_scope", async () => {
    await put("Notes/Off.md", NOTE);
    let c = await client({ allowWrites: false });
    let r = await call(c, T, { path: "Notes/Off.md", old: "sky", new: "sea" });
    assert.match(err(r), /^Error \[fs_writes_disabled\]/);
    await c.close();
    process.env[WRITE_SCOPE_ENV_VAR] = JSON.stringify({ mode: "create-only", paths: ["**"] });
    try {
      c = await client();
      r = await call(c, T, { path: "Notes/Off.md", old: "sky", new: "sea" });
      assert.match(err(r), /^Error \[write_scope\]/);
      await c.close();
    } finally {
      delete process.env[WRITE_SCOPE_ENV_VAR];
    }
    assert.equal(await read("Notes/Off.md"), NOTE);
  });

  test("a profile other than full does not list it, and a call is not found", async () => {
    await put("Notes/P.md", NOTE);
    for (const profile of ["read", "read+inbox", "read+message"]) {
      const c = await client({ profile });
      assert.equal((await c.listTools()).tools.some((t) => t.name === T), false, profile);
      const r = await call(c, T, { path: "Notes/P.md", old: "sky", new: "sea" });
      assert.equal(r.isError, true, profile);
      await c.close();
    }
    assert.equal(await read("Notes/P.md"), NOTE);
  });

  test("an argument the tool does not name is refused", async () => {
    await put("Notes/S.md", NOTE);
    const c = await client();
    const r = await call(c, T, { path: "Notes/S.md", old: "sky", new: "sea", regex: true });
    assert.equal(r.isError, true);
    assert.equal(await read("Notes/S.md"), NOTE);
    await c.close();
  });
});
