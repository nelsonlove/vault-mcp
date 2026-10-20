/**
 * TDD tests for buildFront (packages/server/src/front.ts).
 *
 * Drives the unified front via a real ephemeral Express server (listen(0)) +
 * Node built-in fetch. Injects stub presence / fs / live deps into buildFront
 * so no real socket, vault index, or bridge.mjs process is needed.
 *
 * Assertions:
 *   1. presence.isLive()===true + valid static token → POST /mcp calls live.handle.
 *   2. presence.isLive()===false + valid token → POST /mcp calls fs.handle.
 *   3. Unauthenticated POST /mcp → 401; neither handler called; no body required.
 *   4. GET /health → 200 with mode reflecting presence.isLive(); flips on toggle.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type express from "express";
import type { AddressInfo } from "node:net";
import {
  buildFront,
  wireFailover,
  createEbadfGuard,
  parsePrewarmDelay,
  DEFAULT_FS_PREWARM_DELAY_MS,
  FS_PREWARM_DELAY_ENV_VAR,
} from "../front.js";
import type { AuthConfig } from "../auth.js";

// ── Auth config — static-token only (enabled=false) ──────────────────────────
//
// Using cfg.enabled=false + a static token:
//   - valid Bearer <TOKEN> → next()
//   - anything else → 401 STATIC_CHALLENGE
// This is the simplest way to verify auth runs before body-parse and routing.

const cfg: AuthConfig = {
  enabled: false,
  resourceUrl: "",
  issuer: "",
  jwksUri: "",
  authorizationServers: [],
  scopesSupported: [],
};

const TOKEN = "test-static-secret-tok";

// ── Handler spy factory ────────────────────────────────────────────────────────

interface HandlerSpy {
  handle(req: express.Request, res: express.Response): Promise<void>;
  callCount: number;
  reset(): void;
}

function makeHandlerSpy(name: string): HandlerSpy {
  let calls = 0;
  return {
    async handle(_req: express.Request, res: express.Response): Promise<void> {
      calls++;
      res.status(200).json({ handled: name });
    },
    get callCount() {
      return calls;
    },
    reset() {
      calls = 0;
    },
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("buildFront", () => {
  let server: http.Server;
  let port: number;
  // mutable — tests flip this to exercise both routing branches
  let liveState = true;

  let fsSpy: HandlerSpy;
  let liveSpy: HandlerSpy;

  before(async () => {
    fsSpy = makeHandlerSpy("fs");
    liveSpy = makeHandlerSpy("live");

    // Presence stub reads from the mutable liveState closure on every isLive() call
    const presence = { isLive: () => liveState };

    const app = buildFront({
      cfg,
      token: TOKEN,
      presence,
      fs: fsSpy,
      live: liveSpy,
    });

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
  });

  after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  function reset(): void {
    fsSpy.reset();
    liveSpy.reset();
  }

  // ── 1. Live mode: valid token + presence up → live.handle ─────────────────

  test("presence isLive=true + valid token → live.handle called, fs.handle not called", async () => {
    reset();
    liveState = true;

    const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });

    assert.equal(resp.status, 200, "expect 200 from live stub");
    assert.equal(liveSpy.callCount, 1, "live.handle must be called exactly once");
    assert.equal(fsSpy.callCount, 0, "fs.handle must NOT be called when live");
  });

  // ── 2. Fallback mode: valid token + presence down → fs.handle ────────────

  test("presence isLive=false + valid token → fs.handle called, live.handle not called", async () => {
    reset();
    liveState = false;

    const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });

    assert.equal(resp.status, 200, "expect 200 from fs stub");
    assert.equal(fsSpy.callCount, 1, "fs.handle must be called exactly once when presence is down");
    assert.equal(liveSpy.callCount, 0, "live.handle must NOT be called when presence is down");
  });

  // ── 3. Unauthenticated → 401, neither handler called, body not required ───
  //
  // The key invariant: body-parse is wired AFTER authGate, so an unauthenticated
  // request never forces a JSON parse — and therefore doesn't need a body at all.

  test("unauthenticated POST /mcp (no Authorization) → 401; neither handler called", async () => {
    reset();

    // No Authorization header, no body — proves auth fires before body-parse
    const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
    });

    assert.equal(resp.status, 401, "must respond 401 for missing auth");
    assert.equal(fsSpy.callCount, 0, "fs.handle must NOT be called on 401");
    assert.equal(liveSpy.callCount, 0, "live.handle must NOT be called on 401");
  });

  // ── 4. GET /health reflects presence.isLive() dynamically ─────────────────
  //
  // /health must NOT require auth.  `mode` must flip when liveState changes.

  test("GET /health returns mode reflecting presence.isLive(); mode flips on toggle", async () => {
    // Live state → mode:"live"
    liveState = true;
    let resp = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(resp.status, 200, "health must return 200 (no auth required)");
    let body = (await resp.json()) as { status: string; mode: string; authEnabled: boolean };
    assert.equal(body.status, "ok");
    assert.equal(body.mode, "live", "mode must be 'live' when presence.isLive()===true");
    assert.equal(body.authEnabled, false, "authEnabled must match cfg.enabled");

    // Toggle to down → mode:"fs"
    liveState = false;
    resp = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(resp.status, 200);
    body = (await resp.json()) as { status: string; mode: string; authEnabled: boolean };
    assert.equal(body.mode, "fs", "mode must flip to 'fs' when presence.isLive()===false");
  });
});

// ── wireFailover ──────────────────────────────────────────────────────────────
//
// Stubs: a presence stub that records callbacks so tests can fire them, and a
// live stub with teardownAll/notifyAll spies.

describe("wireFailover", () => {
  // Presence stub: records registered callbacks by event name; fire() dispatches them.
  function makePresenceStub() {
    const cbs: Record<string, Array<() => void>> = {};
    return {
      on(ev: "up" | "down", cb: () => void): void {
        (cbs[ev] ??= []).push(cb);
      },
      fire(ev: "up" | "down"): void {
        for (const cb of cbs[ev] ?? []) cb();
      },
    };
  }

  // Live stub: records call order and captures the last message sent to notifyAll.
  function makeLiveStub() {
    const calls: string[] = [];
    let lastMsg: object | null = null;
    return {
      calls,
      get lastMsg(): object | null {
        return lastMsg;
      },
      notifyAll(msg: object): void {
        calls.push("notifyAll");
        lastMsg = msg;
      },
      teardownAll(): void {
        calls.push("teardownAll");
      },
    };
  }

  // ── 5. "down" → notifyAll(LIST_CHANGED) then teardownAll ──────────────────

  // FS stub: records whether ready()/stop() were called.
  function makeFsStub() {
    const calls: string[] = [];
    return {
      calls,
      ready(): Promise<void> {
        calls.push("ready");
        return Promise.resolve();
      },
      stop(): Promise<void> {
        calls.push("stop");
        return Promise.resolve();
      },
    };
  }

  test('"down" calls live.notifyAll(LIST_CHANGED) then live.teardownAll() and prewarms fs.ready() (delay 0)', () => {
    const presence = makePresenceStub();
    const live = makeLiveStub();
    const fs = makeFsStub();

    wireFailover({ presence, live, fs, prewarmDelayMs: 0 });
    presence.fire("down");

    assert.deepEqual(
      live.calls,
      ["notifyAll", "teardownAll"],
      "notifyAll must be called before teardownAll",
    );
    assert.ok(fs.calls.includes("ready"), '"down" must prewarm fs.ready()');
    assert.ok(!fs.calls.includes("stop"), '"down" must not stop fs');
    assert.equal(
      (live.lastMsg as { method?: string } | null)?.method,
      "notifications/tools/list_changed",
      "notifyAll must receive a notifications/tools/list_changed message",
    );
  });

  // ── 6. "up" → notifyAll(LIST_CHANGED) only, teardownAll NOT called ────────

  test('"up" calls live.notifyAll(LIST_CHANGED), stops fs, and does NOT call teardownAll', () => {
    const presence = makePresenceStub();
    const live = makeLiveStub();
    const fs = makeFsStub();

    wireFailover({ presence, live, fs });
    presence.fire("up");

    assert.ok(fs.calls.includes("stop"), '"up" must stop the FS watcher');
    assert.ok(!fs.calls.includes("ready"), '"up" must not build fs');
    assert.equal(
      live.calls.filter((c) => c === "notifyAll").length,
      1,
      "notifyAll must be called exactly once on up",
    );
    assert.equal(
      live.calls.filter((c) => c === "teardownAll").length,
      0,
      "teardownAll must NOT be called on up",
    );
    assert.equal(
      (live.lastMsg as { method?: string } | null)?.method,
      "notifications/tools/list_changed",
      "notifyAll must receive a notifications/tools/list_changed message",
    );
  });

  // ── #583: the prewarm waits out a short "down" ──────────────────────────────

  test('#583: with no delay given, "down" prewarms only after the default delay', async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const presence = makePresenceStub();
    const fs = makeFsStub();
    wireFailover({ presence, live: makeLiveStub(), fs });
    presence.fire("down");
    assert.ok(!fs.calls.includes("ready"), "no prewarm at once");
    t.mock.timers.tick(DEFAULT_FS_PREWARM_DELAY_MS - 1);
    assert.ok(!fs.calls.includes("ready"), "no prewarm before the delay");
    t.mock.timers.tick(1);
    assert.deepEqual(fs.calls, ["ready"], "one prewarm once the delay has passed");
  });

  test('#583: "up" inside the delay cancels the prewarm; a repeated "down" restarts the delay', async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const presence = makePresenceStub();
    const fs = makeFsStub();
    wireFailover({ presence, live: makeLiveStub(), fs, prewarmDelayMs: 1000 });
    presence.fire("down");
    t.mock.timers.tick(500);
    presence.fire("up");
    t.mock.timers.tick(5000);
    assert.deepEqual(fs.calls, ["stop"], "the reload never started the FS machinery");

    presence.fire("down");
    t.mock.timers.tick(800);
    presence.fire("down");
    t.mock.timers.tick(800);
    assert.ok(!fs.calls.includes("ready"), "the second down restarted the delay");
    t.mock.timers.tick(200);
    assert.equal(fs.calls.filter((c) => c === "ready").length, 1, "one prewarm, not two");
  });
});

describe("parsePrewarmDelay (#583)", () => {
  test("unset or empty ⇒ the default; a whole number ⇒ itself; 0 ⇒ 0", () => {
    assert.equal(parsePrewarmDelay(undefined), DEFAULT_FS_PREWARM_DELAY_MS);
    assert.equal(parsePrewarmDelay("  "), DEFAULT_FS_PREWARM_DELAY_MS);
    assert.equal(parsePrewarmDelay("2500"), 2500);
    assert.equal(parsePrewarmDelay("0"), 0);
  });

  test("a value that is not a whole number ⇒ the default, with one warning naming the variable", () => {
    for (const raw of ["-5", "1.5", "10s", "abc"]) {
      const warnings: string[] = [];
      assert.equal(parsePrewarmDelay(raw, (m) => warnings.push(m)), DEFAULT_FS_PREWARM_DELAY_MS, raw);
      assert.equal(warnings.length, 1, raw);
      assert.match(warnings[0], new RegExp(FS_PREWARM_DELAY_ENV_VAR));
    }
  });
});

describe("createEbadfGuard (#583)", () => {
  function makeFs(watching: boolean) {
    const fs = {
      stops: 0,
      on: watching,
      watching: () => fs.on,
      stop: async () => {
        fs.stops++;
        fs.on = false;
      },
    };
    return fs;
  }
  const ebadf = Object.assign(new Error("spawn EBADF"), { code: "EBADF" });

  test("EBADF while the watcher runs in LIVE mode stops the watcher and logs loudly once", () => {
    const fs = makeFs(true);
    const logs: string[] = [];
    const g = createEbadfGuard({ presence: { isLive: () => true }, fs, log: (m) => logs.push(m) });
    g.onSpawnError(ebadf);
    assert.equal(fs.stops, 1, "the watcher is stopped");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /EBADF/);
    assert.match(logs[0], /stopping the watcher/);
    g.onSpawnError(ebadf);
    assert.equal(logs.length, 1, "logged once only");
    assert.deepEqual({ count: g.status().count, watcherStops: g.status().watcherStops }, { count: 2, watcherStops: 1 });
    assert.ok(g.status().lastAt, "the time of the last one is kept");
  });

  test("EBADF with no watcher in LIVE mode stops nothing and says so; other errors are ignored", () => {
    const fs = makeFs(false);
    const logs: string[] = [];
    const g = createEbadfGuard({ presence: { isLive: () => true }, fs, log: (m) => logs.push(m) });
    g.onSpawnError(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    g.onSpawnError(new Error("no code"));
    g.onSpawnError(undefined);
    assert.equal(logs.length, 0);
    assert.equal(g.status().count, 0);
    g.onSpawnError(ebadf);
    assert.equal(fs.stops, 0);
    assert.match(logs[0], /not running in LIVE mode/);
  });

  test("EBADF in FS mode (presence down) does not stop the FS watcher", () => {
    const fs = makeFs(true);
    const g = createEbadfGuard({ presence: { isLive: () => false }, fs, log: () => {} });
    g.onSpawnError(ebadf);
    assert.equal(fs.stops, 0);
  });

  test("/health carries the guard's counts through healthExtra", async () => {
    const g = createEbadfGuard({ presence: { isLive: () => true }, fs: makeFs(true), log: () => {} });
    g.onSpawnError(ebadf);
    const app = buildFront({
      cfg,
      token: "t",
      presence: { isLive: () => true },
      fs: { handle: async () => {} },
      live: { handle: async () => {} },
      healthExtra: () => ({ bridgeSpawnEbadf: g.status() }),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const body = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { bridgeSpawnEbadf?: { count: number; watcherStops: number } };
      assert.equal(body.bridgeSpawnEbadf?.count, 1);
      assert.equal(body.bridgeSpawnEbadf?.watcherStops, 1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ── Task 4 (Phase 2b): seamless flag routes /mcp to the semantic proxy ────────

describe("buildFront seamless routing (Phase 2b)", () => {
  test("seamless dep present → /mcp routes there; live/fs untouched", async () => {
    const fsSpy = makeHandlerSpy("fs");
    const liveSpy = makeHandlerSpy("live");
    const seamlessSpy = makeHandlerSpy("seamless");
    const app = buildFront({
      cfg,
      token: TOKEN,
      presence: { isLive: () => true },
      fs: fsSpy,
      live: liveSpy,
      seamless: seamlessSpy,
    });
    const server: http.Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      assert.equal(resp.status, 200);
      assert.equal(seamlessSpy.callCount, 1, "seamless.handle must be routed");
      assert.equal(liveSpy.callCount, 0, "live must not be called when seamless is set");
      assert.equal(fsSpy.callCount, 0, "fs must not be called when seamless is set");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
