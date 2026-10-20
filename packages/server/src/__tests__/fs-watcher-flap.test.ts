/**
 * #583: the FS vault watcher must not outlive a presence down → up flap.
 *
 * Seen: a plugin reload (disable, enable; a few seconds) made presence go down and then up. On
 * "down" wireFailover prewarmed the FS handler (buildIndex + startVaultWatcher); on "up" it called
 * fs.stop(). The stop ran while the build was still in flight, found no watcher yet, closed nothing,
 * and the watcher that started after it ran on in LIVE mode, holding a file handle per vault note.
 *
 * These tests drive a real createFsHandler over a temp vault of a few hundred notes and count the
 * process's open handles under the vault with lsof (when lsof is on PATH), plus the handler's own
 * watching() flag. Each test ends with the count back at the file's baseline.
 *
 * VAULT_PATH must be set before @vault-mcp/core loads (vault.ts captures it at import), so the
 * modules are imported dynamically in before().
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";

let createFsHandler: (typeof import("../fs-mode.js"))["createFsHandler"];
let wireFailover: (typeof import("../front.js"))["wireFailover"];
let indexStatus: (typeof import("@vault-mcp/core"))["indexStatus"];

let tmpVault: string;
let realVault: string;
let tmpJournalDir: string;
let base: number | null = null;
/** Whether lsof answered for this process; the handle-count checks run only then. */
let lsofWorks = false;

const NOTE_COUNT = 300;

before(async () => {
  tmpVault = await mkdtemp(path.join(tmpdir(), "fs-flap-vault-"));
  realVault = await realpath(tmpVault);
  process.env.VAULT_PATH = tmpVault;
  tmpJournalDir = await mkdtemp(path.join(tmpdir(), "fs-flap-journal-"));
  process.env.VAULT_MCP_FS_JOURNAL_DIR = tmpJournalDir;
  for (let d = 0; d < 10; d++) {
    const dir = path.join(tmpVault, `Folder ${d}`);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < NOTE_COUNT / 10; i++) {
      await writeFile(path.join(dir, `Note ${d}-${i}.md`), `# Note ${d}-${i}\n\nSee [[Note ${d}-${(i + 1) % 30}]].\n`);
    }
  }
  ({ createFsHandler } = await import("../fs-mode.js"));
  ({ wireFailover } = await import("../front.js"));
  ({ indexStatus } = await import("@vault-mcp/core"));
  // One baseline for the whole file, taken before any watcher exists. chokidar shares its
  // per-path fs.watch handles across watchers in one process, so a watcher leaked by one test
  // would hide a second leak from a baseline taken later; every test must return to this one.
  base = openUnderVault();
  lsofWorks = base !== null;
});

after(async () => {
  await rm(tmpVault, { recursive: true, force: true });
  await rm(tmpJournalDir, { recursive: true, force: true });
});

// ── Instruments ─────────────────────────────────────────────────────────────────

/** This process's open handles under the temp vault, from lsof; null when lsof cannot run. */
function openUnderVault(): number | null {
  let out: string;
  try {
    out = execFileSync("lsof", ["-n", "-P", "-p", String(process.pid), "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // lsof exits 1 when it lists nothing; any output it gave is still good.
    const so = (e as { stdout?: string }).stdout;
    if (typeof so !== "string" || so === "") return null;
    out = so;
  }
  return out.split("\n").filter((l) => l.startsWith("n") && (l.slice(1).startsWith(realVault) || l.slice(1).startsWith(tmpVault))).length;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the handle count settles at or below `target` (watcher close is not instant), or time out. */
async function settledCount(target: number, ms = 3000): Promise<number | null> {
  const end = Date.now() + ms;
  let n = openUnderVault();
  while (n !== null && n > target && Date.now() < end) {
    await sleep(50);
    n = openUnderVault();
  }
  return n;
}

/** The handler's watching() flag, read so that the test still compiles and runs against a handler without it. */
function watchingOf(h: unknown): boolean | undefined {
  const f = (h as { watching?: () => boolean }).watching;
  return typeof f === "function" ? f.call(h) : undefined;
}

function makePresence() {
  const em = new EventEmitter();
  return {
    on(ev: "up" | "down", cb: () => void) {
      em.on(ev, cb);
    },
    fire(ev: "up" | "down") {
      em.emit(ev);
    },
  };
}

const live = { notifyAll() {}, teardownAll() {} };

/** Wrap a real FS handler so the test can await every ready() and stop() that wireFailover starts. */
function spyFs(h: ReturnType<typeof createFsHandler>) {
  const readies: Promise<void>[] = [];
  const stops: Promise<void>[] = [];
  return {
    readies,
    stops,
    ready() {
      const p = h.ready();
      readies.push(p);
      return p;
    },
    stop() {
      const p = h.stop();
      stops.push(p);
      return p;
    },
    async settle() {
      // Await in rounds: a settled promise may have been joined by a later one.
      for (let i = 0; i < 3; i++) await Promise.allSettled([...readies, ...stops]);
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("FS watcher across presence flaps (#583)", () => {
  test("instrument check: a started watcher holds handles under the vault, and stop() releases them", async () => {
    const h = createFsHandler({ indexStatus: true });
    await h.ready();
    assert.equal(watchingOf(h) ?? true, true, "a finished ready() has a watcher open");
    if (lsofWorks && base !== null) {
      const during = openUnderVault();
      assert.ok(during !== null && during > base, `lsof must see the watcher's handles (base ${base}, during ${during})`);
    }
    await h.stop();
    assert.equal(watchingOf(h) ?? false, false);
    if (lsofWorks && base !== null) assert.equal(await settledCount(base), base, "handles back to baseline");
  });

  test("stop() during an in-flight ready() leaves no watcher once the build finishes", async () => {
    const h = createFsHandler({ indexStatus: true });
    const building = h.ready(); // the prewarm, not awaited: buildIndex is in flight
    await h.stop(); // presence "up" arrives first
    await building; // the build finishes afterwards
    await sleep(200);
    assert.equal(watchingOf(h) ?? false, false, "no watcher after the flap");
    if (lsofWorks && base !== null) assert.equal(await settledCount(base), base, "handles back to baseline after the flap");
    await h.stop();
  });

  test("down → up quickly through wireFailover (prewarm at once): watcher closed, handles at baseline", async () => {
    const h = createFsHandler({ indexStatus: true });
    const fs = spyFs(h);
    const presence = makePresence();
    wireFailover({ presence, live, fs, prewarmDelayMs: 0 });
    presence.fire("down");
    presence.fire("up");
    await fs.settle();
    await sleep(200);
    assert.equal(fs.readies.length, 1, "the prewarm ran (delay 0)");
    assert.equal(watchingOf(h) ?? false, false, "no watcher in LIVE mode");
    if (lsofWorks && base !== null) assert.equal(await settledCount(base), base, "handles back to baseline");
    await h.stop();
  });

  test("down → (watcher starting) → up: watcher closed, handles at baseline", async () => {
    const h = createFsHandler({ indexStatus: true });
    const fs = spyFs(h);
    const presence = makePresence();
    wireFailover({ presence, live, fs, prewarmDelayMs: 0 });
    const builtBefore = indexStatus().last_built_at;
    presence.fire("down");
    // Wait for this build to finish: the watcher's start begins in the same tick. Then flap up.
    for (let i = 0; i < 2000 && indexStatus().last_built_at === builtBefore; i++) await sleep(1);
    presence.fire("up");
    await fs.settle();
    await sleep(200);
    assert.equal(watchingOf(h) ?? false, false, "no watcher in LIVE mode");
    if (lsofWorks && base !== null) assert.equal(await settledCount(base), base, "handles back to baseline");
    await h.stop();
  });

  test("repeated down events then up: one build at most, and no watcher left", async () => {
    const h = createFsHandler({ indexStatus: true });
    const fs = spyFs(h);
    const presence = makePresence();
    wireFailover({ presence, live, fs, prewarmDelayMs: 0 });
    presence.fire("down");
    presence.fire("down");
    presence.fire("down");
    await fs.settle();
    assert.equal(new Set(fs.readies).size, 1, "every prewarm joins the one in-flight build");
    assert.equal(watchingOf(h) ?? true, true, "the lasting down has its watcher");
    presence.fire("up");
    await fs.settle();
    assert.equal(watchingOf(h) ?? false, false);
    if (lsofWorks && base !== null) assert.equal(await settledCount(base), base, "handles back to baseline");
    await h.stop();
  });

  test("down → up inside the prewarm delay never starts the FS machinery", async () => {
    const h = createFsHandler({ indexStatus: true });
    const fs = spyFs(h);
    const presence = makePresence();
    wireFailover({ presence, live, fs, prewarmDelayMs: 300 });
    presence.fire("down");
    await sleep(50);
    presence.fire("up");
    await sleep(500); // past the delay: a timer that was not cancelled would have fired by now
    await fs.settle();
    assert.equal(fs.readies.length, 0, "no prewarm on a short down");
    assert.equal(watchingOf(h) ?? false, false);
    if (lsofWorks && base !== null) assert.equal(openUnderVault(), base, "no handles were ever opened");
    await h.stop();
  });

  test("a lasting down still prewarms after the delay and serves FS mode; up then closes it", async () => {
    const h = createFsHandler({ indexStatus: true });
    const fs = spyFs(h);
    const presence = makePresence();
    wireFailover({ presence, live, fs, prewarmDelayMs: 100 });
    presence.fire("down");
    await sleep(20);
    assert.equal(fs.readies.length, 0, "no prewarm before the delay");
    for (let i = 0; i < 400 && fs.readies.length === 0; i++) await sleep(10);
    assert.equal(fs.readies.length, 1, "the prewarm ran after the delay");
    await fs.settle();
    assert.equal(watchingOf(h) ?? true, true, "FS mode has its watcher");

    // Serve one FS-mode request through the handler, as the front does when presence is down.
    const app = express();
    app.post("/mcp", express.json(), (req, res) => void h.handle(req, res));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "obsidian_list_notes", arguments: { limit: 500 } } }),
      });
      assert.equal(resp.status, 200);
      const body = (await resp.json()) as { result?: { content?: Array<{ text?: string }> } };
      const text = body.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
      assert.match(text, /Note 0-0\.md/, "FS mode lists the vault's notes");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    presence.fire("up");
    await fs.settle();
    assert.equal(watchingOf(h) ?? false, false, "up closes the watcher");
    if (lsofWorks && base !== null) assert.equal(await settledCount(base), base, "handles back to baseline");
    await h.stop();
  });
});
