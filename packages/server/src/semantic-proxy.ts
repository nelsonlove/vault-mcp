/**
 * semantic-proxy.ts — Phase 2b: MCP-semantic proxy building blocks.
 *
 * Phase 2a's LIVE mode is a transport-level byte passthrough — it never sees
 * tool schemas, so it cannot re-advertise a changed tool list into an existing
 * session. Phase 2b's semantic proxy instead runs its own MCP client against
 * the plugin socket (via bridge.mjs), mirrors the plugin's tools, and forwards
 * tools/call — which lets a per-session McpServer flip its tool surface and
 * emit notifications/tools/list_changed mid-session.
 *
 * Task 1 (this file's first slice): connectLiveBackend — connect to the live
 * plugin as an MCP client, fetch its tool list, expose callTool + close.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bridgeEnv } from "./bridge-env.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface LiveBackend {
  /** Connected MCP client — use client.callTool() to forward calls. */
  client: Client;
  /** The plugin's advertised tools at connect time. */
  tools: Tool[];
  close(): Promise<void>;
}

export async function connectLiveBackend(opts: {
  bridgePath: string;
  /** TEST SEAM: inject a client Transport; defaults to spawning bridge.mjs. */
  makeTransport?: () => Transport;
  /** The connection profile (#521) this backend's bridge asks the plugin for; absent ⇒ `full`. */
  profile?: string;
}): Promise<LiveBackend> {
  const transport =
    opts.makeTransport?.() ??
    new StdioClientTransport({
      command: process.execPath, // node
      args: [opts.bridgePath],
      env: bridgeEnv(process.env, { profile: opts.profile }),
      // "ignore", NOT "inherit": inheriting a redirected stderr under launchd
      // EBADFs the spawn (see the Phase 2a lazy-FS fix + deploy notes).
      stderr: "ignore",
    });

  const client = new Client(
    { name: "vault-mcp-front", version: "0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const { tools } = await client.listTools();
  return {
    client,
    tools,
    close: () => client.close(),
  };
}

// ── Tasks 2+3: mode-aware sessions with mid-session switching ─────────────────

import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildFsServer } from "./fs-mode.js";
import { profileOf } from "./profiles.js";

export interface SemanticProxy {
  handle(req: Request, res: Response): Promise<void>;
  sessionCount(): number;
  stop(): Promise<void>;
  /** TEST SEAM — create a session's Server without HTTP routing. @internal */
  _createSessionForTest(profile?: string): Promise<{ server: Server }>;
}

export function createSemanticProxy(opts: {
  bridgePath: string;
  presence: { isLive(): boolean; on(ev: "up" | "down", cb: () => void): void };
  /** Awaited before the FS backend is first used (lazy index build). */
  fsReady?: () => Promise<void>;
  /** TEST SEAM: transport to the live plugin; defaults to bridge.mjs stdio. */
  makeLiveTransport?: () => Transport;
  /** TEST SEAM: the FS McpServer; defaults to fs-mode's buildFsServer(). */
  makeFsServer?: (profile: string) => McpServer;
}): SemanticProxy {
  // ── Shared backends (lazy) ──────────────────────────────────────────────────
  // One live client + one in-process FS client serve all sessions. The plugin
  // socket multiplexes tools/call fine over a single bridge connection, and the
  // FS server is stateless. On presence "down" the live backend is closed so
  // the next LIVE use reconnects fresh.
  //
  // ONE PAIR PER PROFILE (#521): a backend is built for one connection profile, so sessions share
  // a backend only with sessions of the same profile — a `read` session never calls through a
  // `full` bridge.
  const liveBackends = new Map<string, Promise<LiveBackend>>();
  const fsClients = new Map<string, Promise<Client>>();

  function getLiveBackend(profile: string): Promise<LiveBackend> {
    let b = liveBackends.get(profile);
    if (!b) {
      b = connectLiveBackend({
        bridgePath: opts.bridgePath,
        makeTransport: opts.makeLiveTransport,
        profile,
      }).catch((e: unknown) => {
        liveBackends.delete(profile); // allow retry on next use
        throw e;
      });
      liveBackends.set(profile, b);
    }
    return b;
  }

  function getFsClient(profile: string): Promise<Client> {
    let c = fsClients.get(profile);
    if (c) return c;
    c = (async () => {
      await opts.fsReady?.();
      const server = opts.makeFsServer ? opts.makeFsServer(profile) : buildFsServer(profile === "full" ? undefined : { profile });
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
      await server.connect(serverEnd);
      const client = new Client(
        { name: "vault-mcp-front-fs", version: "0" },
        { capabilities: {} },
      );
      await client.connect(clientEnd);
      return client;
    })();
    fsClients.set(profile, c);
    return c;
  }

  async function backendClient(profile: string): Promise<Client> {
    if (opts.presence.isLive()) return (await getLiveBackend(profile)).client;
    return getFsClient(profile);
  }

  // ── Sessions ────────────────────────────────────────────────────────────────
  interface Session {
    server: Server;
    transport?: StreamableHTTPServerTransport;
    profile: string;
  }
  const sessions = new Map<string, Session>();
  const testSessions: Session[] = [];

  function buildSessionServer(profile: string): Server {
    const server = new Server(
      { name: "vault-mcp-front", version: "0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (opts.presence.isLive()) {
        // Re-list from the live client each time: the plugin's surface can vary
        // (integration plugins), and a cached list would go stale across flips.
        const { client } = await getLiveBackend(profile);
        return await client.listTools();
      }
      const client = await getFsClient(profile);
      return await client.listTools();
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const client = await backendClient(profile);
      return (await client.callTool({
        name: req.params.name,
        arguments: req.params.arguments ?? {},
      })) as import("@modelcontextprotocol/sdk/types.js").CallToolResult;
    });
    return server;
  }

  // ── Mid-session switch ──────────────────────────────────────────────────────
  function notifyAllSessions(): void {
    const all = [...sessions.values(), ...testSessions];
    for (const s of all) {
      // Best-effort: sessions without an open SSE channel just pick up the new
      // surface on their next tools/list.
      s.server
        .notification({ method: "notifications/tools/list_changed" })
        .catch(() => {});
    }
  }
  opts.presence.on("up", () => {
    notifyAllSessions();
  });
  opts.presence.on("down", () => {
    // Drop the shared live backend — its socket is gone. Next LIVE use reconnects.
    for (const b of liveBackends.values()) b.then((x) => x.close()).catch(() => {});
    liveBackends.clear();
    notifyAllSessions();
  });

  // ── HTTP plumbing (mirrors live-proxy's session routing) ────────────────────
  async function handle(req: Request, res: Response): Promise<void> {
    // No profile gate in front (a bare embed, the tests) is `full`, as before.
    const profile = profileOf(res) ?? "full";
    const sid = req.header("mcp-session-id");
    if (sid) {
      const s = sessions.get(sid);
      // A session opened under another profile answers as not found (#521).
      if (!s?.transport || s.profile !== profile) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "session not found" },
          id: null,
        });
        return;
      }
      await s.transport.handleRequest(req, res, req.body);
      return;
    }
    const isInit =
      req.method === "POST" &&
      ((Array.isArray(req.body) &&
        req.body.some((m) => m?.method === "initialize")) ||
        (req.body as { method?: string } | undefined)?.method === "initialize");
    if (!isInit) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "missing session id" },
        id: null,
      });
      return;
    }
    const server = buildSessionServer(profile);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSid: string) => {
        sessions.set(newSid, { server, transport, profile });
        console.error(`[semantic-proxy] session ${newSid} opened (${sessions.size})`);
      },
    });
    transport.onclose = () => {
      const cur = transport.sessionId;
      if (cur) sessions.delete(cur);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  return {
    handle,
    sessionCount: () => sessions.size,
    async stop(): Promise<void> {
      for (const s of [...sessions.values(), ...testSessions]) {
        await s.server.close().catch(() => {});
        await s.transport?.close().catch(() => {});
      }
      sessions.clear();
      testSessions.length = 0;
      for (const b of liveBackends.values()) await b.then((x) => x.close()).catch(() => {});
      liveBackends.clear();
      for (const c of fsClients.values()) await c.then((x) => x.close()).catch(() => {});
      fsClients.clear();
    },
    async _createSessionForTest(profile = "full"): Promise<{ server: Server }> {
      const server = buildSessionServer(profile);
      testSessions.push({ server, profile });
      return { server };
    },
  };
}
