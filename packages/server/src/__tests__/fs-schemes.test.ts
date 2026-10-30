/**
 * VAULT_MCP_SCHEMES on the file-system server (follow-up to #621): a value the
 * index cannot use stops the server at startup, and a link-healing move refuses
 * while the index is in error instead of renaming with no link rewrite. The
 * values are made up.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FsWriteKernel } from "../fs-write-kernel.js";

let fsMode: typeof import("../fs-mode.js");
let vault: string;
let journal: string;
let kernel: FsWriteKernel;

before(async () => {
  vault = await mkdtemp(path.join(tmpdir(), "fs-schemes-"));
  journal = await mkdtemp(path.join(tmpdir(), "fs-schemes-journal-"));
  process.env.VAULT_PATH = vault;
  await mkdir(path.join(vault, "Notes"), { recursive: true });
  await writeFile(path.join(vault, "Notes", "A.md"), "A.\n");
  await writeFile(path.join(vault, "Notes", "Index.md"), "See [[A]].\n");
  const { FsWriteKernel: Kernel } = await import("../fs-write-kernel.js");
  kernel = new Kernel({ journalDir: journal, identity: { vault: "test", version: "0" } });
  fsMode = await import("../fs-mode.js");
});

after(async () => {
  delete process.env.VAULT_MCP_SCHEMES;
  await rm(vault, { recursive: true, force: true });
  await rm(journal, { recursive: true, force: true });
});

describe("checkFsSchemes — the startup check", () => {
  test("unset, empty or a good list passes", () => {
    assert.doesNotThrow(() => fsMode.checkFsSchemes({}));
    assert.doesNotThrow(() => fsMode.checkFsSchemes({ VAULT_MCP_SCHEMES: "[]" }));
    assert.doesNotThrow(() => fsMode.checkFsSchemes({ VAULT_MCP_SCHEMES: '[{"id":"jd","provider":"johnny-decimal","config":{"expandedAreas":["50-59"]}}]' }));
  });
  test("a value the index cannot use throws a clear refusal that names the variable", () => {
    for (const v of ["{not json", '{"id":"jd"}', '[{"id":"jd","provider":"no-such-provider"}]']) {
      const quiet = console.error;
      console.error = () => {};
      try {
        assert.throws(() => fsMode.checkFsSchemes({ VAULT_MCP_SCHEMES: v }), /refusing to start: VAULT_MCP_SCHEMES cannot be used/, v);
      } finally {
        console.error = quiet;
      }
    }
  });
  test("front.ts runs the check at startup and exits on it", async () => {
    const src = await readFile(new URL("../../src/front.ts", import.meta.url), "utf8");
    assert.match(src, /try \{\s*checkFsSchemes\(\);\s*\} catch \(e\) \{\s*console\.error\([^\n]*\);\s*process\.exit\(1\);/);
  });
});

describe("a move while the index is in error", () => {
  test("refuses with index_unavailable and moves nothing; update_backlinks: false still moves", async () => {
    const core = await import("@vault-mcp/core");
    process.env.VAULT_MCP_SCHEMES = "{not json";
    await core.buildIndex();
    assert.equal(core.indexStatus().status, "error");
    const server = fsMode.buildFsServer({ indexStatus: false, allowWrites: true, kernel });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(a);
    const r = (await c.callTool({ name: "obsidian_move_note", arguments: { from: "Notes/A.md", to: "Notes/B.md", idempotency_key: "k1" } })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /index_unavailable/);
    assert.ok(existsSync(path.join(vault, "Notes", "A.md")), "nothing was moved");
    assert.ok(!existsSync(path.join(vault, "Notes", "B.md")));
    const ok = (await c.callTool({ name: "obsidian_move_note", arguments: { from: "Notes/A.md", to: "Notes/C.md", update_backlinks: false, idempotency_key: "k2" } })) as { isError?: boolean };
    assert.notEqual(ok.isError, true);
    assert.ok(existsSync(path.join(vault, "Notes", "C.md")));
    await c.close();
    delete process.env.VAULT_MCP_SCHEMES;
  });
});
