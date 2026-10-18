/**
 * TDD tests for createFsHandler (packages/server/src/fs-mode.ts).
 *
 * Uses the MCP SDK's InMemoryTransport to drive the McpServer that the factory
 * builds, without needing a live Express server.
 *
 * Asserts:
 *   1. tools/list returns exactly the 17 FS_TOOLS and the 3 .base/.canvas file tools.
 *   2. obsidian_write_note + obsidian_read_note round-trip (write, read back same content).
 *   3. obsidian_read_note response carries `index_status` block when indexStatus=true.
 *   4. The server's declared capabilities include tools.listChanged === true.
 *
 * VAULT_PATH must be set BEFORE any @vault-mcp/core module is imported — vault.ts
 * and index-store.ts capture their root and initial state at module load. This file
 * sets VAULT_PATH in a `before()` hook then dynamically imports fs-mode.ts and
 * @vault-mcp/core (same pattern as packages/core/tests/vault.test.ts).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FsWriteKernel,
  FS_JOURNAL_DIR_ENV_VAR,
  type FsJournalRecord,
  type FsJournalIo,
} from "../fs-write-kernel.js";

// ── Dynamic imports — resolved after VAULT_PATH is set ───────────────────────

// These will be populated in the `before()` hook below.
let buildFsServer: (typeof import("../fs-mode.js"))["buildFsServer"];
let createFsHandler: (typeof import("../fs-mode.js"))["createFsHandler"];
let FS_WRITES_ENV_VAR: (typeof import("../fs-mode.js"))["FS_WRITES_ENV_VAR"];
let FS_TOOLS: (typeof import("@vault-mcp/core"))["FS_TOOLS"];

// ── Temp vault setup ─────────────────────────────────────────────────────────

let tmpVault: string;
let tmpJournalDir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any; // FsHandler instance for ready()/stop() lifecycle

before(async () => {
  // Create temp vault dir and wire VAULT_PATH before any vault module loads.
  tmpVault = await mkdtemp(path.join(tmpdir(), "fs-mode-test-"));
  process.env.VAULT_PATH = tmpVault;

  // Point the process-wide FS write kernel's journal (issue #92) at a temp dir
  // OUTSIDE the vault — writes in this file would otherwise journal into the
  // real ~/.claude/vault-mcp/. Must be set before the first FS-mode write
  // (getFsWriteKernel reads it lazily, once per process).
  tmpJournalDir = await mkdtemp(path.join(tmpdir(), "fs-mode-journal-"));
  process.env[FS_JOURNAL_DIR_ENV_VAR] = tmpJournalDir;

  // Dynamic import after env is set — vault.ts captures VAULT_ROOT at import time.
  const fsMod = await import("../fs-mode.js");
  buildFsServer = fsMod.buildFsServer;
  createFsHandler = fsMod.createFsHandler;
  FS_WRITES_ENV_VAR = fsMod.FS_WRITES_ENV_VAR;

  const coreMod = await import("@vault-mcp/core");
  FS_TOOLS = coreMod.FS_TOOLS;

  // Create a handler and call ready() to build the index + start the watcher.
  // ready() is idempotent — safe to call once for all tests that need a live index.
  handler = createFsHandler({ indexStatus: true });
  await handler.ready();
});

after(async () => {
  // Close the vault watcher so no open handles remain and the test runner exits.
  if (handler) await handler.stop();
  // Clean up temp vault + journal.
  await rm(tmpVault, { recursive: true, force: true });
  await rm(tmpJournalDir, { recursive: true, force: true });
  delete process.env[FS_JOURNAL_DIR_ENV_VAR];
});

// ── Test harness ──────────────────────────────────────────────────────────────

/**
 * Build a fresh McpServer via the factory and wire it to a Client over
 * InMemoryTransport. Returns the client and a teardown function.
 *
 * Uses buildFsServer (the internal factory helper exported from fs-mode.ts)
 * so tests drive exactly the same server construction that createFsHandler.handle()
 * uses per-request — without needing a live Express server.
 *
 * `allowWrites` defaults to true here so tests that exercise write tools for
 * OTHER reasons (round-trips, the accept-forbidden guard) aren't tripped up by
 * the FS-write gate (issue #92) — that gate has its own dedicated describe
 * block below, which passes allowWrites explicitly per case.
 */
async function makeClientFromFsServer(
  indexStatus?: boolean,
  allowWrites = true,
): Promise<{ client: Client; teardown: () => Promise<void> }> {
  const server = buildFsServer({ indexStatus, allowWrites });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    teardown: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createFsHandler / buildFsServer", () => {
  /**
   * 1. tools/list returns exactly the 17 note tools and the three .base/.canvas file tools (#575).
   */
  test("tools/list returns exactly the 17 FS_TOOLS and the 3 file tools", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 20, `expected 20 tools, got ${tools.length}`);

      const names = tools.map((t) => t.name).sort();
      const expected = [...FS_TOOLS.map((t) => t.name), "obsidian_edit_file", "obsidian_move_file", "obsidian_write_file"].sort();
      assert.deepEqual(names, expected, "tool names do not match FS_TOOLS and the file tools");
    } finally {
      await teardown();
    }
  });

  /**
   * 2. obsidian_write_note + obsidian_read_note round-trip.
   *    Writes a note via the tool, then reads it back and asserts same content.
   */
  test("obsidian_write_note + obsidian_read_note round-trip", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      // Write a note via the tool (uses real vault at tmpVault).
      const writeResult = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-test/RoundTrip.md",
          content: "# Round Trip\nHello from fs-mode test!",
          overwrite: false,
        },
      });
      assert.ok(!writeResult.isError, `write failed: ${JSON.stringify(writeResult.content)}`);
      const writeData = JSON.parse(
        (writeResult.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.equal(writeData.path, "fs-mode-test/RoundTrip.md");
      assert.equal(writeData.created, true);

      // Read it back.
      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-test/RoundTrip.md" },
      });
      assert.ok(!readResult.isError, `read failed: ${JSON.stringify(readResult.content)}`);
      const readData = JSON.parse(
        (readResult.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.equal(readData.content, "# Round Trip\nHello from fs-mode test!");
    } finally {
      await teardown();
    }
  });

  /**
   * 3. obsidian_read_note response carries `index_status` block when indexStatus=true.
   *    Writes a note directly to the temp vault then reads it via the tool.
   */
  test("obsidian_read_note includes index_status when indexStatus=true", async () => {
    // Write a note directly to the filesystem (bypasses the tool round-trip for simplicity).
    const noteDir = path.join(tmpVault, "fs-mode-index-test");
    await mkdir(noteDir, { recursive: true });
    await writeFile(path.join(noteDir, "StatusNote.md"), "# Status Note\ncontent", "utf8");

    const { client, teardown } = await makeClientFromFsServer(true);
    try {
      const result = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-index-test/StatusNote.md" },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.ok("index_status" in data, "index_status field must be present when indexStatus=true");
      assert.ok(
        typeof data.index_status === "object" && data.index_status !== null,
        "index_status must be an object",
      );
      assert.ok("status" in data.index_status, "index_status must have a status field");
    } finally {
      await teardown();
    }
  });

  /**
   * 4. The server's declared capabilities include tools.listChanged === true.
   *    After client.connect(), getServerCapabilities() reflects what the server
   *    announced during initialization.
   */
  test("server capabilities include tools.listChanged === true", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      const caps = client.getServerCapabilities();
      assert.ok(caps, "server capabilities must be available after connect");
      assert.ok(caps.tools, "capabilities.tools must be present");
      assert.equal(
        caps.tools.listChanged,
        true,
        "capabilities.tools.listChanged must be true (required for Phase 2b)",
      );
    } finally {
      await teardown();
    }
  });

  /**
   * 5. ready() is idempotent — calling it twice does not double-build the index.
   */
  test("ready() is idempotent — second call returns same promise", async () => {
    const h = createFsHandler({ indexStatus: true });
    try {
      const p1 = h.ready();
      const p2 = h.ready();
      assert.strictEqual(p1, p2, "ready() must return the same Promise on repeated calls");
      await p1;
    } finally {
      await h.stop();
    }
  });

  /**
   * 6. obsidian_read_note does NOT include index_status when indexStatus=false (default opt-out).
   */
  test("obsidian_read_note omits index_status when indexStatus=false", async () => {
    // Write directly to temp vault.
    const noteDir2 = path.join(tmpVault, "fs-mode-noindex-test");
    await mkdir(noteDir2, { recursive: true });
    await writeFile(path.join(noteDir2, "NoIndex.md"), "# No Index\ncontent", "utf8");

    const { client, teardown } = await makeClientFromFsServer(false);
    try {
      const result = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-noindex-test/NoIndex.md" },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      assert.ok(
        !("index_status" in data),
        "index_status must NOT be present when indexStatus=false",
      );
    } finally {
      await teardown();
    }
  });
});

/**
 * Issue #104 — the accept-forbidden guard, exercised through the REAL exposed
 * MCP tool (obsidian_write_note) on the REAL fs-failover handler, not just
 * against the underlying FilesystemBackend/VaultImpl classes directly. An
 * independent PR review of the initial #104 patch found that guarding
 * FilesystemBackend alone was not sufficient: this server's own
 * makeBackend() (fs-mode.ts) wraps the MODULE-LEVEL singleton functions
 * exported from @vault-mcp/core (writeNote/appendNote/setFrontmatterField/
 * patchNote, bound to a private VaultImpl singleton) — a SEPARATE code path
 * from the FilesystemBackend class. The guard had to move into VaultImpl
 * itself (the shared implementation both paths delegate to) for it to
 * actually reach this handler. This suite is the regression test for that:
 * it fails if the guard is ever wired to the wrong implementation again.
 */
describe("obsidian_write_note — accept-forbidden guard reaches the real fs-failover handler (issue #104)", () => {
  test("a write carrying acceptance-status: accepted is REFUSED through the real MCP tool", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-accept-guard-test/Accepted.md",
          content: "---\nacceptance-status: accepted\n---\nbody",
          overwrite: false,
        },
      });
      assert.ok(result.isError, "expected the write to be refused (isError: true)");
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.match(text, /accept_forbidden|accept-forbidden|acceptance/i);

      // And confirm nothing landed on disk.
      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-accept-guard-test/Accepted.md" },
      });
      assert.ok(readResult.isError, "the refused note must not exist on disk");
    } finally {
      await teardown();
    }
  });

  test("a normal (non-accepted) write still SUCCEEDS through the real MCP tool", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-accept-guard-test/Normal.md",
          content: "---\nname: N\n---\nordinary body",
          overwrite: false,
        },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
    } finally {
      await teardown();
    }
  });

  test("a cut read is never written back through the FS server: the trailer refusal before its kernel, the overwrite refusal at dequeue (#441, #443)", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    const notePath = "fs-mode-441/Big.md";
    const body = "# Big\n\n" + "x".repeat(150_000) + "\n\n## Tail\n";
    const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ type: string; text: string }>)[0].text;
    try {
      const created = await client.callTool({ name: "obsidian_write_note", arguments: { path: notePath, content: body, overwrite: false } });
      assert.ok(!created.isError, `unexpected error: ${text(created)}`);
      const read = await client.callTool({ name: "obsidian_read_note", arguments: { path: notePath } });
      const cut = JSON.parse(text(read)) as { content: string; truncated: boolean };
      assert.equal(cut.truncated, true);

      // The trailer refusal: the cut read handed back.
      const back = await client.callTool({ name: "obsidian_write_note", arguments: { path: notePath, content: cut.content, overwrite: true } });
      assert.ok(back.isError);
      assert.match(text(back), /^Error \[truncated_read\]:/);
      // The overwrite refusal: the trailer deleted and a paragraph added.
      const stripped = cut.content.replace(/\n\n\[truncated:[^\n]*$/, "") + "\n\nA new paragraph, added after the cut, longer than any trailer could be.\n";
      const grown = await client.callTool({ name: "obsidian_write_note", arguments: { path: notePath, content: stripped, overwrite: true } });
      assert.ok(grown.isError);
      assert.match(text(grown), /^Error \[truncated_read\]:[\s\S]*never overwritten whole over MCP/);
      assert.equal(await readFile(path.join(tmpVault, notePath), "utf8"), body, "the note on disk is intact");
      // The trailer refusal never reached the kernel (no record); the
      // overwrite refusal is decided at dequeue on this transport (#443), so
      // it is journaled as an error beside the create.
      const files = await readdir(tmpJournalDir);
      const lines = (await Promise.all(files.map((f) => readFile(path.join(tmpJournalDir, f), "utf8")))).join("\n").split("\n").filter(Boolean);
      const mine = lines.filter((l) => l.includes(notePath));
      assert.equal(mine.length, 2, "one record for the create, one for the overwrite refused at dequeue; none for the trailer refusal");
      assert.ok(mine.some((l) => l.includes('"outcome":"error"') && l.includes("longer than the read limit")), "the dequeue refusal is on the record (the journal carries the message)");
    } finally {
      await teardown();
    }
  });

  test("full: true serves the whole note on the FS server, but no whole-note overwrite is let through there (#443, #446)", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    const notePath = "fs-mode-443/Big.md";
    const body = "# Big\n\n" + "x".repeat(150_000) + "\n\n## Tail\n";
    const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = (r: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse(text(r)) as { content: string; rev?: number; whole?: boolean; truncated: boolean };
    try {
      const created = await client.callTool({ name: "obsidian_write_note", arguments: { path: notePath, content: body, overwrite: false } });
      assert.ok(!created.isError, `unexpected error: ${text(created)}`);
      const whole = parsed(await client.callTool({ name: "obsidian_read_note", arguments: { path: notePath, full: true } }));
      assert.equal(whole.whole, true);
      assert.equal(whole.content, body);
      assert.equal("rev" in whole, false, "no read on this transport shows a rev: its writes cannot honour one");
      // No proof can be tied to a caller here, so the policy stays: the
      // whole note back is refused like any whole-note overwrite of a long note.
      const back = await client.callTool({ name: "obsidian_write_note", arguments: { path: notePath, content: body.replace("# Big", "# Big (rewritten)"), overwrite: true } });
      assert.ok(back.isError);
      assert.match(text(back), /^Error \[truncated_read\]/);
      assert.equal(await readFile(path.join(tmpVault, notePath), "utf8"), body, "the note on disk is intact");
      // Edits by anchor still land.
      const appended = await client.callTool({ name: "obsidian_append_note", arguments: { path: notePath, content: "\nappended\n" } });
      assert.ok(!appended.isError, text(appended));
      assert.match(await readFile(path.join(tmpVault, notePath), "utf8"), /appended/);
    } finally {
      await teardown();
    }
  });

  test("a write to a path outside the vault is refused through the real MCP tool, not folded into the vault (#444)", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ type: string; text: string }>)[0].text;
    // A name unique to this run: `..` of the temp vault is the shared temp
    // root, so a stale file from another run must not fail this one, and on
    // a regression the stray file is removed below.
    const name = `outside-444-${process.pid}-${Date.now()}.md`;
    const outside = path.join(tmpVault, "..", name);
    try {
      const res = await client.callTool({ name: "obsidian_write_note", arguments: { path: `../${name}`, content: "x", overwrite: true } });
      assert.ok(res.isError, `the escaping path must be refused, not written as <vault>/${name}`);
      assert.match(text(res), /^Error \[invalid_path\]: Path escapes the vault root/);
      await assert.rejects(readFile(path.join(tmpVault, name), "utf8"), "nothing landed inside the vault under the folded name");
      await assert.rejects(readFile(outside, "utf8"), "nothing landed outside it either");
      // Refused before the kernel: no journal record for the attempt.
      const files = await readdir(tmpJournalDir);
      const lines = (await Promise.all(files.map((f) => readFile(path.join(tmpJournalDir, f), "utf8")))).join("\n");
      assert.equal(lines.includes(name), false, "an argument refusal is not journaled");
      // The same refusal on a move's destination (the `target.paths` branch) and on the read tools.
      await client.callTool({ name: "obsidian_write_note", arguments: { path: "fs-mode-444/Inside.md", content: "x", overwrite: false } });
      const moved = await client.callTool({ name: "obsidian_move_note", arguments: { from: "fs-mode-444/Inside.md", to: `../${name}` } });
      assert.ok(moved.isError);
      assert.match(text(moved), /^Error \[invalid_path\]/);
      assert.ok(!(await readFile(path.join(tmpVault, "fs-mode-444/Inside.md"), "utf8")).includes("nothing"), "the source note is still where it was");
      await assert.rejects(readFile(outside, "utf8"), "the move landed nothing outside");
      const read = await client.callTool({ name: "obsidian_read_note", arguments: { path: `../${name}` } });
      assert.ok(read.isError);
      assert.match(text(read), /^Error \[invalid_path\]/);
      const batch = JSON.parse(text(await client.callTool({ name: "obsidian_read_notes", arguments: { paths: [`../${name}`] } }))) as { errors: Array<{ error: string }> };
      assert.match(batch.errors[0].error, /escapes the vault root/);
    } finally {
      await rm(outside, { force: true });
      await teardown();
    }
  });

  test("a write carrying an accepted-family value behind a leading BOM is REFUSED (recognition parity)", async () => {
    const { client, teardown } = await makeClientFromFsServer();
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-accept-guard-test/BomAccepted.md",
          content: "\uFEFF---\nacceptance-status: accepted\n---\nbody",
          overwrite: false,
        },
      });
      assert.ok(result.isError, "a BOM-prefixed accepted fence must be refused, not silently honored unguarded");
    } finally {
      await teardown();
    }
  });
});

/**
 * Issue #92 — FS-mode writes bypass the plugin kernel's serialized write
 * queue and append-only write journal entirely (FS mode has no kernel to
 * route through; packages/server does not, and must not, depend on
 * packages/host). Rather than silently shipping unaudited writes under
 * the same tool names as the journaled LIVE path, FS-mode writes are
 * refused by default and require an explicit opt-in — this suite is the
 * regression test for that gate.
 */
describe("FS-mode write gate (issue #92)", () => {
  test("obsidian_write_note is refused by default (no allowWrites option, no env var)", async () => {
    const { client, teardown } = await makeClientFromFsServer(undefined, false);
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-write-gate-test/ShouldNotExist.md",
          content: "body",
          overwrite: false,
        },
      });
      assert.ok(result.isError, "expected the write to be refused (isError: true)");
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      assert.match(text, /fs_writes_disabled/);

      // Confirm nothing landed on disk.
      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-write-gate-test/ShouldNotExist.md" },
      });
      assert.ok(readResult.isError, "the refused write must not have created the note");
    } finally {
      await teardown();
    }
  });

  test("obsidian_append_note, obsidian_delete_note, and obsidian_manage_frontmatter (set) are also refused by default", async () => {
    const { client, teardown } = await makeClientFromFsServer(undefined, false);
    try {
      const appendResult = await client.callTool({
        name: "obsidian_append_note",
        arguments: { path: "fs-mode-write-gate-test/Append.md", content: "more" },
      });
      assert.ok(appendResult.isError, "append must be refused by default");
      assert.match(
        (appendResult.content as Array<{ type: string; text: string }>)[0].text,
        /fs_writes_disabled/,
      );

      const fmResult = await client.callTool({
        name: "obsidian_manage_frontmatter",
        arguments: { path: "fs-mode-write-gate-test/Fm.md", key: "title", op: "set", value: "x" },
      });
      assert.ok(fmResult.isError, "manage_frontmatter set must be refused by default");
      assert.match(
        (fmResult.content as Array<{ type: string; text: string }>)[0].text,
        /fs_writes_disabled/,
      );

      const deleteResult = await client.callTool({
        name: "obsidian_delete_note",
        arguments: { path: "fs-mode-write-gate-test/Nonexistent.md", confirm: true },
      });
      assert.ok(deleteResult.isError, "delete must be refused by default");
      assert.match(
        (deleteResult.content as Array<{ type: string; text: string }>)[0].text,
        /fs_writes_disabled/,
      );
    } finally {
      await teardown();
    }
  });

  test("obsidian_write_note succeeds when allowWrites: true is explicitly opted in", async () => {
    const { client, teardown } = await makeClientFromFsServer(undefined, true);
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: {
          path: "fs-mode-write-gate-test/Allowed.md",
          content: "# Allowed\nbody",
          overwrite: false,
        },
      });
      assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);

      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-write-gate-test/Allowed.md" },
      });
      assert.ok(!readResult.isError);
      const data = JSON.parse((readResult.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(data.content, "# Allowed\nbody");
    } finally {
      await teardown();
    }
  });

  test("obsidian_write_note succeeds when VAULT_MCP_FS_ALLOW_WRITES env var is set, with no explicit option", async () => {
    const prev = process.env[FS_WRITES_ENV_VAR];
    process.env[FS_WRITES_ENV_VAR] = "true";
    try {
      // buildFsServer({ indexStatus }) — allowWrites intentionally omitted, so
      // makeBackend() must fall back to reading the env var itself.
      const server = buildFsServer({ indexStatus: false });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "0.0.1" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: "obsidian_write_note",
          arguments: {
            path: "fs-mode-write-gate-test/EnvAllowed.md",
            content: "via env var",
            overwrite: false,
          },
        });
        assert.ok(!result.isError, `unexpected error: ${JSON.stringify(result.content)}`);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      if (prev === undefined) delete process.env[FS_WRITES_ENV_VAR];
      else process.env[FS_WRITES_ENV_VAR] = prev;
    }
  });

  test("gate refusals are not journaled — nothing ran (matches the plugin's pre-queue refusals)", async () => {
    const countBefore = (await journalRecords()).length;
    const { client, teardown } = await makeClientFromFsServer(undefined, false);
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: { path: "fs-mode-write-gate-test/Unjournaled.md", content: "x", overwrite: false },
      });
      assert.ok(result.isError);
    } finally {
      await teardown();
    }
    assert.equal((await journalRecords()).length, countBefore, "a refused write must not journal");
  });

  test("reads (obsidian_list_notes, obsidian_read_note) work identically whether or not writes are allowed", async () => {
    // Seed a note directly on disk (bypassing the gated write tools).
    const noteDir = path.join(tmpVault, "fs-mode-write-gate-read-test");
    await mkdir(noteDir, { recursive: true });
    await writeFile(path.join(noteDir, "ReadMe.md"), "# Read fallback\nstill works", "utf8");

    for (const allowWrites of [false, true]) {
      const { client, teardown } = await makeClientFromFsServer(undefined, allowWrites);
      try {
        const listResult = await client.callTool({
          name: "obsidian_list_notes",
          arguments: { subdir: "fs-mode-write-gate-read-test", limit: 10, offset: 0 },
        });
        assert.ok(!listResult.isError, `list failed (allowWrites=${allowWrites})`);

        const readResult = await client.callTool({
          name: "obsidian_read_note",
          arguments: { path: "fs-mode-write-gate-read-test/ReadMe.md" },
        });
        assert.ok(!readResult.isError, `read failed (allowWrites=${allowWrites})`);
        const data = JSON.parse((readResult.content as Array<{ type: string; text: string }>)[0].text);
        assert.equal(data.content, "# Read fallback\nstill works");
      } finally {
        await teardown();
      }
    }
  });
});

// ── Journal-reading helper (issue #92 suites) ────────────────────────────────

/** All records currently in the temp journal dir, file order then line order. */
async function journalRecords(): Promise<FsJournalRecord[]> {
  const files = await readdir(tmpJournalDir).catch(() => [] as string[]);
  const out: FsJournalRecord[] = [];
  for (const f of files.filter((f) => f.endsWith(".jsonl")).sort()) {
    const content = await readFile(path.join(tmpJournalDir, f), "utf8");
    for (const line of content.split("\n")) {
      if (line.trim()) out.push(JSON.parse(line) as FsJournalRecord);
    }
  }
  return out;
}

/**
 * Issue #92, resolution (a) — FS-mode writes now run through a process-wide
 * serialized write queue and append one JSONL record per mutating operation to
 * the server-side journal (fs-write-kernel.ts). These tests drive the REAL
 * MCP tools end-to-end (buildFsServer → registerFsTools → makeBackend) and
 * read the journal files the default process kernel writes.
 *
 * The queue's interleaving-impossibility proof (deferred-based) lives in
 * fs-write-kernel.test.ts; here we pin the WIRING: every mutating tool
 * journals exactly once, reads never journal, separate connections share the
 * one process kernel, and a broken journal never fails a write.
 */
describe("FS-mode write queue + journal (issue #92)", () => {
  test("every mutating tool appends exactly one ok record; reads append none", async () => {
    const { client, teardown } = await makeClientFromFsServer(undefined, true);
    try {
      const steps: Array<{ tool: string; args: Record<string, unknown> }> = [
        {
          tool: "obsidian_write_note",
          args: { path: "fs-mode-journal-test/A.md", content: "# A\n\n## Section\nbody ^blk1", overwrite: false },
        },
        { tool: "obsidian_append_note", args: { path: "fs-mode-journal-test/A.md", content: "\nmore" } },
        {
          tool: "obsidian_patch_note",
          args: {
            path: "fs-mode-journal-test/A.md",
            anchor_type: "heading",
            anchor: "Section",
            op: "append",
            content: "patched line",
          },
        },
        {
          tool: "obsidian_manage_frontmatter",
          args: { path: "fs-mode-journal-test/A.md", key: "status", op: "set", value: "open" },
        },
        {
          tool: "obsidian_move_note",
          args: { from: "fs-mode-journal-test/A.md", to: "fs-mode-journal-test/B.md", update_backlinks: false },
        },
        { tool: "obsidian_delete_note", args: { path: "fs-mode-journal-test/B.md", confirm: true } },
      ];

      for (const step of steps) {
        const before = (await journalRecords()).length;
        const result = await client.callTool({ name: step.tool, arguments: step.args });
        assert.ok(!result.isError, `${step.tool} failed: ${JSON.stringify(result.content)}`);
        const recs = await journalRecords();
        assert.equal(recs.length, before + 1, `${step.tool} must journal exactly one record`);
        const rec = recs[recs.length - 1];
        assert.equal(rec.op, step.tool);
        assert.equal(rec.outcome, "ok");
        assert.equal(rec.actor.server.mode, "fs-fallback");
        // Note bodies never enter the journal.
        if ("content" in step.args) {
          assert.match(String(rec.argsDigest.content), /^<\d+ chars>$/);
        }
      }

      // Move records both ends; delete/write carry the primary path.
      const all = await journalRecords();
      const move = all.find((r) => r.op === "obsidian_move_note");
      assert.deepEqual(move?.target.paths, ["fs-mode-journal-test/A.md", "fs-mode-journal-test/B.md"]);

      // Reads journal nothing.
      const before = (await journalRecords()).length;
      const read = await client.callTool({
        name: "obsidian_list_notes",
        arguments: { subdir: "fs-mode-journal-test", limit: 10, offset: 0 },
      });
      assert.ok(!read.isError);
      const fmGet = await client.callTool({
        name: "obsidian_manage_frontmatter",
        arguments: { path: "fs-mode-journal-test/DoesNotMatter.md", key: "status", op: "get" },
      });
      // get on a missing note errors, but must not journal either way.
      void fmGet;
      assert.equal((await journalRecords()).length, before, "read operations must never journal");
    } finally {
      await teardown();
    }
  });

  test("a failing mutation journals exactly one error record and still errors to the caller", async () => {
    const { client, teardown } = await makeClientFromFsServer(undefined, true);
    try {
      const before = (await journalRecords()).length;
      const result = await client.callTool({
        name: "obsidian_delete_note",
        arguments: { path: "fs-mode-journal-test/Nonexistent.md", confirm: true },
      });
      assert.ok(result.isError, "deleting a missing note must error");
      const recs = await journalRecords();
      assert.equal(recs.length, before + 1, "the failure must journal exactly one record");
      const rec = recs[recs.length - 1];
      assert.equal(rec.op, "obsidian_delete_note");
      assert.equal(rec.outcome, "error");
      assert.ok(rec.error, "the error record must carry the failure message");
    } finally {
      await teardown();
    }
  });

  test("two separate connections share the one process kernel (cross-connection serialization)", async () => {
    // Two independent per-request servers, as createFsHandler.handle() builds
    // them — no injected kernel, so both must resolve to the same process-wide
    // singleton. actor.connection is per-process: identical across both proves
    // both writes rode the same queue + journal.
    const a = await makeClientFromFsServer(undefined, true);
    const b = await makeClientFromFsServer(undefined, true);
    try {
      const r1 = await a.client.callTool({
        name: "obsidian_write_note",
        arguments: { path: "fs-mode-journal-test/Shared.md", content: "from A", overwrite: true },
      });
      const r2 = await b.client.callTool({
        name: "obsidian_write_note",
        arguments: { path: "fs-mode-journal-test/Shared.md", content: "from B", overwrite: true },
      });
      assert.ok(!r1.isError && !r2.isError);
      const recs = (await journalRecords()).filter(
        (r) => r.target.path === "fs-mode-journal-test/Shared.md",
      );
      assert.equal(recs.length, 2);
      assert.equal(
        recs[0].actor.connection,
        recs[1].actor.connection,
        "both connections must share the process kernel",
      );
    } finally {
      await a.teardown();
      await b.teardown();
    }
  });

  test("concurrent writes to one note serialize FIFO — deterministic final state", async () => {
    const { client, teardown } = await makeClientFromFsServer(undefined, true);
    try {
      // Fired without awaiting: both are in flight together. The process
      // kernel's FIFO queue makes enqueue order the run order, so the final
      // content is exactly the second write's.
      const p1 = client.callTool({
        name: "obsidian_write_note",
        arguments: { path: "fs-mode-journal-test/Race.md", content: "first write", overwrite: true },
      });
      const p2 = client.callTool({
        name: "obsidian_write_note",
        arguments: { path: "fs-mode-journal-test/Race.md", content: "second write", overwrite: true },
      });
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.ok(!r1.isError && !r2.isError);

      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-journal-test/Race.md" },
      });
      assert.ok(!readResult.isError);
      const data = JSON.parse((readResult.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(data.content, "second write", "the later-enqueued write must win, deterministically");

      const recs = (await journalRecords()).filter(
        (r) => r.target.path === "fs-mode-journal-test/Race.md",
      );
      assert.equal(recs.length, 2, "both writes must journal");
    } finally {
      await teardown();
    }
  });

  test("a broken journal never fails the vault operation (swallow semantics)", async () => {
    const failingIo: FsJournalIo = {
      async append() {
        throw new Error("journal disk full");
      },
      async mkdir() {
        throw new Error("mkdir refused");
      },
    };
    const kernel = new FsWriteKernel({
      journalDir: path.join(tmpJournalDir, "never-created"),
      identity: { vault: "test", version: "0" },
      journalIo: failingIo,
    });
    const server = buildFsServer({ indexStatus: false, allowWrites: true, kernel });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "obsidian_write_note",
        arguments: { path: "fs-mode-journal-test/JournalDown.md", content: "still lands", overwrite: false },
      });
      assert.ok(!result.isError, `the write must succeed despite the broken journal: ${JSON.stringify(result.content)}`);

      const readResult = await client.callTool({
        name: "obsidian_read_note",
        arguments: { path: "fs-mode-journal-test/JournalDown.md" },
      });
      assert.ok(!readResult.isError);
      const data = JSON.parse((readResult.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(data.content, "still lands");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
