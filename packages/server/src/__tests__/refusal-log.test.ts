/**
 * The refusal log (#618) on the file-system server, over a real MCP client against a temp vault:
 * with VAULT_MCP_REFUSAL_LOG on, a write call refused before the FS write kernel is one new line
 * (`outcome: "refused"`, `refusal`, `codeFamily`, capped paths, no argument value, capped per code);
 * one refused at dequeue keeps its `error` record and gains only `refusal` and `codeFamily`. Off, the
 * journal is what it was before. The notes, paths and markers are made up.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FsWriteKernel } from "../fs-write-kernel.js";

const WRITE_SCOPE_ENV_VAR = "VAULT_MCP_WRITE_SCOPE";
const MARK = "ZQX-FS-REFUSAL-MARKER-77";
const TOKEN = "tok_live_1a2b3c4d5e6f7a8b9c0d";
const NOTE = "---\ntitle: Plan\n---\n# Plan\n\nThe colour is blue.\n";

let fsMode: typeof import("../fs-mode.js");
let Kernel: typeof import("../fs-write-kernel.js").FsWriteKernel;
let core: typeof import("@vault-mcp/core");
let vault: string;
let journalRoot: string;
let journalN = 0;

before(async () => {
  vault = await mkdtemp(path.join(tmpdir(), "fs-refusal-"));
  journalRoot = await mkdtemp(path.join(tmpdir(), "fs-refusal-journal-"));
  process.env.VAULT_PATH = vault;
  await mkdir(path.join(vault, "Notes"), { recursive: true });
  Kernel = (await import("../fs-write-kernel.js")).FsWriteKernel;
  fsMode = await import("../fs-mode.js");
  core = await import("@vault-mcp/core");
});

after(async () => {
  delete process.env[WRITE_SCOPE_ENV_VAR];
  delete process.env.VAULT_MCP_REFUSAL_LOG;
  await rm(vault, { recursive: true, force: true });
  await rm(journalRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  delete process.env[WRITE_SCOPE_ENV_VAR];
  await writeFile(path.join(vault, "Notes/Plan.md"), NOTE);
  await writeFile(path.join(vault, "Notes/Long.md"), "x".repeat(core.CHARACTER_LIMIT + 10));
});

type Res = { isError?: boolean; content: Array<{ text: string }>; thrown?: string };
type Rec = { op: string; outcome: string; refusal?: string; codeFamily?: string; suppressed?: number; argsDigest?: Record<string, unknown>; target?: { path?: string; paths?: string[] }; actor: { transport: string } };

/** One server with its own journal directory, so each test reads only its own lines. */
async function harness(opts: { on?: boolean; allowWrites?: boolean; profile?: string; limiter?: { admit: (key: string, flush: (count: number) => void) => boolean } } = {}) {
  const dir = path.join(journalRoot, `j${++journalN}`);
  const on = opts.on ?? true;
  const kernel: FsWriteKernel = new Kernel({ journalDir: dir, identity: { vault: "test", version: "0" }, refusal: fsMode.refusalPolicy(() => on, opts.limiter as never) });
  const server = fsMode.buildFsServer({ indexStatus: false, allowWrites: opts.allowWrites ?? true, kernel, ...(opts.profile !== undefined ? { profile: opts.profile } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(a);
  const call = async (name: string, args: Record<string, unknown>): Promise<Res> => {
    try {
      return (await c.callTool({ name, arguments: args })) as unknown as Res;
    } catch (e) {
      return { content: [], thrown: String(e) };
    }
  };
  const raw = async (): Promise<string> => {
    let out = "";
    try {
      for (const f of await readdir(dir)) if (f.endsWith(".jsonl")) out += await readFile(path.join(dir, f), "utf8");
    } catch {
      /* no journal yet */
    }
    return out;
  };
  const lines = async (): Promise<Rec[]> => (await raw()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
  return { call, raw, lines, close: () => c.close() };
}

const text = (r: Res) => r.thrown ?? (r.isError ? r.content[0].text : "");
const REFUSED_KEYS = new Set(["ts", "op", "target", "actor", "outcome", "refusal", "codeFamily", "durationMs", "queueWaitMs"]);

interface Stage {
  name: string;
  tool: string;
  args: () => Record<string, unknown>;
  expect: string;
  stage: "pre" | "dequeue";
  allowWrites?: boolean;
  profile?: string;
  env?: Record<string, string>;
}

const STAGES: Stage[] = [
  { name: "schema (strict write arguments)", tool: "obsidian_append_note", args: () => ({ path: "Notes/Plan.md", content: MARK, bogus: MARK }), expect: "input_validation", stage: "pre" },
  { name: "the write gate (writes not enabled)", allowWrites: false, tool: "obsidian_append_note", args: () => ({ path: "Notes/Plan.md", content: MARK, intent: MARK }), expect: "fs_writes_disabled", stage: "pre" },
  { name: "the path check", tool: "obsidian_append_note", args: () => ({ path: "../outside.md", content: MARK, intent: MARK }), expect: "invalid_path", stage: "pre" },
  { name: "the write scope", env: { [WRITE_SCOPE_ENV_VAR]: JSON.stringify({ mode: "create-only", paths: ["Inbox/*.md"] }) }, tool: "obsidian_append_note", args: () => ({ path: "Notes/Plan.md", content: MARK, intent: MARK }), expect: "write_scope", stage: "pre" },
  { name: "the profile (its call-time write scope)", profile: "read+inbox", tool: "obsidian_write_note", args: () => ({ path: "Notes/New.md", content: MARK }), expect: "write_scope", stage: "pre" },
  { name: "the read-limit proof (a cut read handed back)", tool: "obsidian_append_note", args: () => ({ path: "Notes/Plan.md", content: `${MARK}\n${core.truncationTrailer(core.CHARACTER_LIMIT + 5, core.CHARACTER_LIMIT)}\n`, intent: MARK }), expect: "truncated_read", stage: "pre" },
  { name: "the read-limit proof at dequeue (a whole overwrite of a long note)", tool: "obsidian_write_note", args: () => ({ path: "Notes/Long.md", content: MARK, overwrite: true, intent: MARK }), expect: "truncated_read", stage: "dequeue" },
  { name: "a tool's own refusal at dequeue (no_match)", tool: "obsidian_replace_text", args: () => ({ path: "Notes/Plan.md", old: MARK, new: TOKEN, intent: MARK }), expect: "no_match", stage: "dequeue" },
];

function withEnv<T>(env: Record<string, string> | undefined, fn: () => Promise<T>): Promise<T> {
  if (!env) return fn();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return fn().finally(() => {
    for (const k of Object.keys(env)) delete process.env[k];
  });
}

describe("VAULT_MCP_REFUSAL_LOG on: one refused line per refused call, at every stage", () => {
  for (const s of STAGES) {
    test(s.name, () =>
      withEnv(s.env, async () => {
        const h = await harness({ on: true, allowWrites: s.allowWrites, profile: s.profile });
        const r = await h.call(s.tool, s.args());
        if (s.expect === "input_validation") assert.match(text(r), /Input validation error|Unrecognized key/i, text(r));
        else assert.match(text(r), new RegExp(`Error \\[${s.expect}\\]`), text(r));
        const lines = await h.lines();
        assert.equal(lines.length, 1, JSON.stringify(lines));
        const [line] = lines;
        assert.equal(line.refusal, s.expect);
        assert.equal(line.codeFamily, core.refusalFamily(s.expect));
        assert.equal(line.op, s.tool);
        assert.equal(line.actor.transport, "mcp");
        if (s.stage === "pre") {
          assert.equal(line.outcome, "refused");
          for (const k of Object.keys(line)) assert.ok(REFUSED_KEYS.has(k), `a refused line carries '${k}'`);
          const raw = await h.raw();
          assert.ok(!raw.includes(MARK), `the content marker reached the journal: ${raw}`);
          assert.ok(!raw.includes(TOKEN), `a token reached the journal: ${raw}`);
        } else {
          // The dequeue record is kept as it is, with only the mark added.
          assert.equal(line.outcome, "error");
          assert.ok(line.argsDigest, "the record keeps its digest");
        }
        await h.close();
      }),
    );
  }

  test("the target is the path the call named", async () => {
    const h = await harness({ allowWrites: false });
    await h.call("obsidian_move_note", { from: "Notes/Plan.md", to: "Notes/Moved.md" });
    const [line] = await h.lines();
    assert.deepEqual(line.target, { path: "Notes/Plan.md", paths: ["Notes/Plan.md", "Notes/Moved.md"] });
    await h.close();
  });

  test("an allowed call writes no refused line", async () => {
    const h = await harness();
    const r = await h.call("obsidian_replace_text", { path: "Notes/Plan.md", old: "colour", new: "color" });
    assert.equal(r.isError, undefined, text(r));
    const lines = await h.lines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, "ok");
    assert.equal(lines[0].refusal, undefined);
    await h.close();
  });

  test("a retry with the same idempotency key is its own refused call, never two lines for one call", async () => {
    // This server does not check idempotency keys (no kernel), so each call is one call and one line.
    const h = await harness();
    const args = { path: "Notes/Plan.md", old: "purple", new: "red", idempotency_key: "k-1" };
    await h.call("obsidian_replace_text", args);
    assert.equal((await h.lines()).length, 1);
    await h.call("obsidian_replace_text", args);
    assert.deepEqual((await h.lines()).map((l) => [l.outcome, l.refusal]), [["error", "no_match"], ["error", "no_match"]]);
    await h.close();
  });

  test("a read call is never journaled", async () => {
    const h = await harness();
    await h.call("obsidian_read_note", { path: "../outside.md" });
    assert.equal(await h.raw(), "");
    await h.close();
  });
});

describe("VAULT_MCP_REFUSAL_LOG off: the journal is what it was before", () => {
  for (const s of STAGES) {
    test(s.name, () =>
      withEnv(s.env, async () => {
        const h = await harness({ on: false, allowWrites: s.allowWrites, profile: s.profile });
        await h.call(s.tool, s.args());
        const lines = await h.lines();
        for (const l of lines) {
          assert.notEqual(l.outcome, "refused");
          assert.equal(l.refusal, undefined);
        }
        if (s.stage === "pre") assert.equal(lines.length, 0, JSON.stringify(lines));
        else {
          assert.equal(lines.length, 1);
          assert.equal(lines[0].outcome, "error");
          assert.ok(lines[0].argsDigest, "the pre-existing record keeps its digest");
        }
        await h.close();
      }),
    );
  }

  test("the switch is the environment variable, read per call; unset is off", () => {
    assert.equal(fsMode.REFUSAL_LOG_ENV_VAR, "VAULT_MCP_REFUSAL_LOG");
    assert.equal(fsMode.isRefusalLogEnabled({}), false);
    assert.equal(fsMode.isRefusalLogEnabled({ VAULT_MCP_REFUSAL_LOG: "" }), false);
    assert.equal(fsMode.isRefusalLogEnabled({ VAULT_MCP_REFUSAL_LOG: "0" }), false);
    for (const v of ["true", "1", "yes", "on", " TRUE "]) assert.equal(fsMode.isRefusalLogEnabled({ VAULT_MCP_REFUSAL_LOG: v }), true, v);
  });

  test("a kernel built without the option has the log off", () => {
    const k = new Kernel({ journalDir: path.join(journalRoot, "unused"), identity: { vault: "test", version: "0" } });
    assert.equal(k.refusalLogOn(), false);
  });
});

describe("review 1 of #619", () => {
  test("a coded failure after a write is never marked refused at dequeue (serious)", async () => {
    for (const code of ["dispose_partially_applied", "promote_partial", "reload_failed", "dispose_failed", "create_failed"]) {
      const dir = path.join(journalRoot, `post-${code}`);
      const k = new Kernel({ journalDir: dir, identity: { vault: "test", version: "0" }, refusal: fsMode.refusalPolicy(() => true) });
      await assert.rejects(k.runMutation("obsidian_write_note", { path: "Notes/P.md" }, { path: "Notes/P.md", content: "x" }, async () => {
        throw Object.assign(new Error(`Error [${code}]: part of it was written`), { code });
      }));
      const [rec] = (await readFile(path.join(dir, (await readdir(dir))[0]), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
      assert.equal(rec.outcome, "error", code);
      assert.equal(rec.refusal, undefined, code);
      assert.ok(rec.argsDigest, code);
    }
  });

  test("a path on a new refused line is capped (minor)", async () => {
    const h = await harness();
    const body = `${MARK} ${"y".repeat(5000)}`;
    await h.call("obsidian_append_note", { path: body, content: "x", bogus: 1 });
    const [line] = await h.lines();
    assert.equal(line.refusal, "input_validation");
    assert.equal(line.target?.path, `<${body.length} chars>`);
    assert.ok(!(await h.raw()).includes(MARK));
    await h.close();
  });

  test("new refused lines are capped per code, with one 'suppressed' line when the window ends (minor)", async () => {
    let now = 5_000_000;
    let pending: (() => void) | null = null;
    const limiter = new core.RefusalRateLimiter({ now: () => now, schedule: (fn) => { pending = fn; } });
    const h = await harness({ allowWrites: false, limiter });
    for (let i = 0; i < core.REFUSAL_LOG_MAX_PER_WINDOW + 3; i++) await h.call("obsidian_append_note", { path: "Notes/Plan.md", content: "x" });
    assert.equal((await h.lines()).length, core.REFUSAL_LOG_MAX_PER_WINDOW);
    now += core.REFUSAL_LOG_WINDOW_MS;
    assert.ok(pending);
    (pending as () => void)();
    await new Promise((r) => setTimeout(r, 20));
    const sup = (await h.lines()).filter((l) => l.suppressed !== undefined);
    assert.equal(sup.length, 1);
    assert.equal(sup[0].suppressed, 3);
    assert.equal(sup[0].refusal, "fs_writes_disabled");
    await h.close();
  });
});

