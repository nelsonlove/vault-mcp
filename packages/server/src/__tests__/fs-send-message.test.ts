/**
 * vaultmcp_send_message on the file-system server: offered only when the operator sets
 * VAULT_MCP_MESSAGE_URL and VAULT_MCP_MESSAGE_TOPIC, and it posts end to end to a fake ntfy
 * server on localhost (no network).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let buildFsServer: (typeof import("../fs-mode.js"))["buildFsServer"];
let tmpVault: string;
let ntfy: Server;
let base: string;
const posts: { url?: string; body: string }[] = [];

before(async () => {
  tmpVault = await mkdtemp(path.join(tmpdir(), "fs-send-message-"));
  process.env.VAULT_PATH = tmpVault;
  ntfy = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posts.push({ url: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "abc" }));
    });
  });
  await new Promise<void>((r) => ntfy.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(ntfy.address() as AddressInfo).port}`;
  buildFsServer = (await import("../fs-mode.js")).buildFsServer;
});

after(async () => {
  delete process.env.VAULT_MCP_MESSAGE_URL;
  delete process.env.VAULT_MCP_MESSAGE_TOPIC;
  await new Promise<void>((r) => ntfy.close(() => r()));
  await rm(tmpVault, { recursive: true, force: true });
});

async function connect(profile?: string) {
  const server = buildFsServer({ indexStatus: false, ...(profile ? { profile } : {}) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(st);
  await client.connect(ct);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe("vaultmcp_send_message on the file-system server", () => {
  test("absent when unconfigured", async () => {
    delete process.env.VAULT_MCP_MESSAGE_URL;
    delete process.env.VAULT_MCP_MESSAGE_TOPIC;
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.some((t) => t.name === "vaultmcp_send_message"), false);
      assert.equal(tools.length, 21, "the 17 note tools, the three .base/.canvas file tools (#575) and obsidian_replace_text");
    } finally {
      await close();
    }
  });

  test("offered and working when the URL and topic are set", async () => {
    process.env.VAULT_MCP_MESSAGE_URL = base;
    process.env.VAULT_MCP_MESSAGE_TOPIC = "inbox";
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === "vaultmcp_send_message");
      assert.ok(t, "the tool is listed");
      assert.equal(t.annotations?.openWorldHint, true);
      const r = await client.callTool({ name: "vaultmcp_send_message", arguments: { text: "hello from a test" } });
      assert.equal(r.isError, undefined);
      assert.deepEqual(r.structuredContent, { sent: true, id: "abc" });
      assert.deepEqual(posts.at(-1), { url: "/inbox", body: "hello from a test" });
    } finally {
      await close();
    }
  });

  test("not offered under the read profile", async () => {
    process.env.VAULT_MCP_MESSAGE_URL = base;
    process.env.VAULT_MCP_MESSAGE_TOPIC = "inbox";
    const { client, close } = await connect("read");
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.some((t) => t.name === "vaultmcp_send_message"), false);
    } finally {
      await close();
    }
  });
});
