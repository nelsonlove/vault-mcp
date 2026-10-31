/**
 * Unit tests for the FS write kernel (packages/server/src/fs-write-kernel.ts),
 * issue #92 — the FS-fallback path's serialized write queue + append-only
 * JSONL write journal.
 *
 * Pins the semantics shared with the plugin kernel:
 *   1. FIFO serialization: enqueue order is run order, and op N+1 never starts
 *      before op N settles (proven with deferreds, not timing).
 *   2. A failed operation rejects its own caller and never poisons the chain.
 *   3. Exactly one journal record per mutating operation — ok AND error.
 *   4. Journal write failures are swallowed (console.error), never failing the
 *      vault operation.
 *   5. digestArgs keeps note bodies out of the journal.
 *   6. Records carry the documented shape (ts/op/target/actor/argsDigest/
 *      outcome/durationMs/queueWaitMs, rev fields when the file exists).
 *
 * Everything runs against injected seams — no disk I/O except where the test
 * makes a temp dir on purpose.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FsWriteQueue,
  FsWriteJournal,
  FsWriteKernel,
  digestArgs,
  monthKey,
  vaultSlug,
  defaultJournalDir,
  FS_JOURNAL_DIR_ENV_VAR,
  type FsJournalRecord,
  type FsJournalIo,
} from "../fs-write-kernel.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** In-memory journal IO that records every appended line. */
function memoryIo(): FsJournalIo & { lines: string[]; files: string[] } {
  const lines: string[] = [];
  const files: string[] = [];
  return {
    lines,
    files,
    async append(file, data) {
      files.push(file);
      lines.push(data);
    },
    async mkdir() {
      /* no-op */
    },
  };
}

function makeKernel(overrides: Partial<ConstructorParameters<typeof FsWriteKernel>[0]> = {}): {
  kernel: FsWriteKernel;
  io: ReturnType<typeof memoryIo>;
} {
  const io = memoryIo();
  const kernel = new FsWriteKernel({
    journalDir: "/tmp/unused",
    identity: { vault: "test-vault", version: "0" },
    journalIo: io,
    ...overrides,
  });
  return { kernel, io };
}

function records(io: { lines: string[] }): FsJournalRecord[] {
  return io.lines.map((l) => JSON.parse(l) as FsJournalRecord);
}

// ── FsWriteQueue ──────────────────────────────────────────────────────────────

describe("FsWriteQueue", () => {
  test("serializes: op B never starts before op A settles; FIFO order", async () => {
    const q = new FsWriteQueue();
    const gate = deferred();
    const events: string[] = [];

    const a = q.run(async () => {
      events.push("A start");
      await gate.promise;
      events.push("A end");
      return "A";
    });
    const b = q.run(async () => {
      events.push("B start");
      return "B";
    });

    // Give B every chance to (incorrectly) start while A is blocked.
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events, ["A start"], "B must not start while A holds the queue");
    assert.equal(q.depth, 2);

    gate.resolve();
    assert.equal(await a, "A");
    assert.equal(await b, "B");
    assert.deepEqual(events, ["A start", "A end", "B start"], "enqueue order must be run order");
    assert.equal(q.depth, 0);
  });

  test("a rejecting operation fails its own caller and does not poison the chain", async () => {
    const q = new FsWriteQueue();
    const boom = new Error("boom");
    const a = q.run(async () => {
      throw boom;
    });
    const b = q.run(async () => "B ran");

    await assert.rejects(a, boom);
    assert.equal(await b, "B ran", "the queue must keep running after a failure");
  });

  test("deterministic final state: last-enqueued write wins over a shared target", async () => {
    const q = new FsWriteQueue();
    let note = "";
    // Interleaving hazard: each write reads, waits a tick, then writes back —
    // unserialized, both would read "" and the final state would depend on
    // scheduling. Serialized, the final state is exactly the second write.
    const write = (content: string) =>
      q.run(async () => {
        const seen = note;
        await new Promise((r) => setTimeout(r, 5));
        note = seen + content;
      });
    await Promise.all([write("first"), write("-second")]);
    assert.equal(note, "first-second");
  });
});

// ── FsWriteJournal ────────────────────────────────────────────────────────────

describe("FsWriteJournal", () => {
  const record = (op: string): FsJournalRecord => ({
    ts: "2026-08-18T00:00:00.000Z",
    op,
    target: { path: "A.md" },
    actor: {
      transport: "mcp",
      connection: "c",
      server: { mode: "fs-fallback", vault: "v", version: "0" },
    },
    argsDigest: {},
    outcome: "ok",
    durationMs: 1,
    queueWaitMs: 0,
  });

  test("appends one JSONL line per record, in order, to the monthly file", async () => {
    const io = memoryIo();
    const j = new FsWriteJournal("/j", () => new Date("2026-08-18T12:00:00Z"), io);
    await j.append(record("op1"));
    await j.append(record("op2"));
    assert.equal(io.lines.length, 2);
    assert.ok(io.lines.every((l) => l.endsWith("\n")));
    assert.deepEqual(
      io.lines.map((l) => (JSON.parse(l) as FsJournalRecord).op),
      ["op1", "op2"],
    );
    assert.ok(io.files.every((f) => f === path.join("/j", "2026-08.jsonl")));
  });

  test("append never rejects when the IO fails — logged and dropped", async () => {
    const failing: FsJournalIo = {
      async append() {
        throw new Error("disk full");
      },
      async mkdir() {
        throw new Error("mkdir failed");
      },
    };
    const j = new FsWriteJournal("/j", undefined, failing);
    // Must resolve, not reject.
    await j.append(record("doomed"));
    // And the chain must stay usable for later appends.
    await j.append(record("also-doomed"));
  });

  test("monthKey is UTC (filename agrees with record ts)", () => {
    // 2026-09-01T00:30Z is still 2026-08 in UTC-8 local time; UTC keying must say 09.
    assert.equal(monthKey(new Date("2026-09-01T00:30:00Z")), "2026-09");
    assert.equal(monthKey(new Date("2026-01-15T12:00:00Z")), "2026-01");
  });

  test("writes real JSONL to disk via the default IO", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fs-journal-"));
    try {
      const j = new FsWriteJournal(path.join(dir, "nested", "journal"));
      await j.append(record("real-disk"));
      const content = await readFile(j.currentFile(), "utf8");
      const parsed = JSON.parse(content.trim()) as FsJournalRecord;
      assert.equal(parsed.op, "real-disk");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── digestArgs ────────────────────────────────────────────────────────────────

describe("digestArgs", () => {
  test("note bodies and over-long strings never enter the journal", () => {
    const d = digestArgs({
      path: "Notes/A.md",
      content: "SECRET BODY TEXT",
      overwrite: true,
      long: "x".repeat(500),
    });
    assert.equal(d.path, "Notes/A.md");
    assert.equal(d.content, "<16 chars>");
    assert.equal(d.overwrite, true);
    assert.equal(d.long, "<500 chars>");
  });
});

// ── FsWriteKernel.runMutation ─────────────────────────────────────────────────

describe("FsWriteKernel.runMutation", () => {
  test("a successful mutation journals exactly one ok record with the documented shape", async () => {
    const { kernel, io } = makeKernel();
    const result = await kernel.runMutation(
      "obsidian_write_note",
      { path: "A.md" },
      { path: "A.md", content: "hello world", overwrite: false },
      async () => ({ created: true }),
    );
    assert.deepEqual(result, { created: true });

    const recs = records(io);
    assert.equal(recs.length, 1, "exactly one record per mutation");
    const r = recs[0];
    assert.equal(r.op, "obsidian_write_note");
    assert.equal(r.outcome, "ok");
    assert.equal(r.error, undefined);
    assert.deepEqual(r.target, { path: "A.md" });
    assert.equal(r.actor.transport, "mcp");
    assert.equal(r.actor.connection, kernel.connection);
    assert.deepEqual(r.actor.server, { mode: "fs-fallback", vault: "test-vault", version: "0" });
    assert.equal(r.argsDigest?.content, "<11 chars>", "bodies must be digested");
    assert.equal(r.argsDigest?.path, "A.md");
    assert.ok(typeof r.durationMs === "number" && r.durationMs >= 0);
    assert.ok(typeof r.queueWaitMs === "number" && r.queueWaitMs >= 0);
    assert.ok(!Number.isNaN(Date.parse(r.ts)));
  });

  test("a failing mutation rethrows to the caller AND journals exactly one error record", async () => {
    const { kernel, io } = makeKernel();
    await assert.rejects(
      kernel.runMutation("obsidian_delete_note", { path: "Missing.md" }, { path: "Missing.md", confirm: true }, async () => {
        throw new Error("not found: Missing.md");
      }),
      /not found: Missing\.md/,
    );
    const recs = records(io);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].outcome, "error");
    assert.equal(recs[0].error, "not found: Missing.md");
  });

  test("journal failure never fails the vault operation", async () => {
    const failing: FsJournalIo = {
      async append() {
        throw new Error("journal disk full");
      },
      async mkdir() {
        /* ok */
      },
    };
    const { kernel } = makeKernel({ journalIo: failing });
    const result = await kernel.runMutation("obsidian_write_note", { path: "A.md" }, { path: "A.md" }, async () => "written");
    assert.equal(result, "written", "the write must succeed even when the journal cannot be written");
  });

  test("concurrent mutations serialize FIFO and journal in operation order", async () => {
    const { kernel, io } = makeKernel();
    const gate = deferred();
    const events: string[] = [];

    const first = kernel.runMutation("op_one", { path: "A.md" }, {}, async () => {
      events.push("one start");
      await gate.promise;
      events.push("one end");
    });
    const second = kernel.runMutation("op_two", { path: "A.md" }, {}, async () => {
      events.push("two start");
    });

    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events, ["one start"], "the second mutation must wait for the first");

    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["one start", "one end", "two start"]);
    assert.deepEqual(
      records(io).map((r) => r.op),
      ["op_one", "op_two"],
      "journal order must be operation order",
    );
  });

  test("revBefore/revAfter come from the resolved path's mtime; absent when the file is missing", async () => {
    const mtimes = new Map<string, number>([["/vault/A.md", 111]]);
    const { kernel, io } = makeKernel({
      resolvePath: (rel) => `/vault/${rel}`,
      statMtimeMs: async (abs) => {
        const m = mtimes.get(abs);
        if (m === undefined) throw new Error("ENOENT");
        return m;
      },
    });

    await kernel.runMutation("obsidian_write_note", { path: "A.md" }, {}, async () => {
      mtimes.set("/vault/A.md", 222);
    });
    await kernel.runMutation("obsidian_write_note", { path: "New.md" }, {}, async () => {
      /* file never appears */
    });

    const [existing, missing] = records(io);
    assert.equal(existing.revBefore, 111);
    assert.equal(existing.revAfter, 222);
    assert.equal(missing.revBefore, undefined);
    assert.equal(missing.revAfter, undefined);
  });
});

// ── Journal location helpers ──────────────────────────────────────────────────

describe("journal location", () => {
  test("vaultSlug mirrors the socket slug derivation", () => {
    assert.equal(vaultSlug("My Vault!"), "my-vault");
    assert.equal(vaultSlug("obsidian"), "obsidian");
    assert.equal(vaultSlug("A__B..c-d"), "a__b..c-d");
  });

  test("defaultJournalDir: env override > state dir > home default", () => {
    const prevJournal = process.env[FS_JOURNAL_DIR_ENV_VAR];
    const prevState = process.env.VAULT_MCP_STATE_DIR;
    try {
      process.env[FS_JOURNAL_DIR_ENV_VAR] = "/explicit/journal";
      assert.equal(defaultJournalDir("obsidian"), "/explicit/journal");

      delete process.env[FS_JOURNAL_DIR_ENV_VAR];
      process.env.VAULT_MCP_STATE_DIR = "/state";
      assert.equal(defaultJournalDir("My Vault"), path.join("/state", "journal", "my-vault"));

      delete process.env.VAULT_MCP_STATE_DIR;
      const dir = defaultJournalDir("obsidian");
      assert.ok(dir.endsWith(path.join(".claude", "vault-mcp", "journal", "obsidian")));
    } finally {
      if (prevJournal === undefined) delete process.env[FS_JOURNAL_DIR_ENV_VAR];
      else process.env[FS_JOURNAL_DIR_ENV_VAR] = prevJournal;
      if (prevState === undefined) delete process.env.VAULT_MCP_STATE_DIR;
      else process.env.VAULT_MCP_STATE_DIR = prevState;
    }
  });
});
