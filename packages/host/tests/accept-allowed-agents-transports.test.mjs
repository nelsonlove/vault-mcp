/**
 * accept-allowed-agents-transports.test.mjs — the allowed-agent append
 * (@vault-mcp/core accept-guard.ts) on every host road that writes
 * frontmatter, and the proof that no road can change the setting.
 *
 * Every name is made up: `agent:example-decider`, `human:owner`.
 *
 *   • ObsidianBackend through registerFsTools: obsidian_write_note,
 *     obsidian_manage_frontmatter, obsidian_append_note, and patchNote
 *     (obsidian_patch_note's backend call);
 *   • composeNote (obsidian_write_notes' item composer);
 *   • guardAppendResult (obsidian_append_at_heading);
 *   • cliAcceptRefusal (the CLI proxy, payload-only: refused even when listed);
 *   • the host's status machine (accept-status-machine.ts), read through the
 *     vault's construction module as obsidian_create_note reads it;
 *   • the setting: set only from main.ts's settings load and save, no tool
 *     reads or writes it, and the plugin's data.json is not a writable path.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installObsidianStub, TFile, parseYaml } from "./obsidian-stub.mjs";

installObsidianStub();
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { composeNote } = await import("../src/mcp/write-notes-compose.ts");
const { guardAppendResult } = await import("../src/mcp/tools-complementary.ts");
const { cliAcceptRefusal } = await import("../src/mcp/tools-cli.ts");
const { makeStatusTableLookup } = await import("../src/accept-status-machine.ts");
const { registerFsTools, setAcceptAllowedAgents, setAcceptStatusTableLookup, parseGuardFrontmatter } = await import("@vault-mcp/core");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..");
const silent = () => {};
const AGENT = "agent:example-decider";
const HUMAN = "human:owner";
const TABLE = { "draft/proposed": ["stable/open", "archived/cancelled"] };
const CLASSES = { "Task/Example": { extends: "Task" }, Task: { "status-transitions": TABLE } };

function allow() {
  setAcceptAllowedAgents({ agents: [AGENT], onBehalfOf: HUMAN }, silent);
}
function reset() {
  setAcceptAllowedAgents(null, silent);
  setAcceptStatusTableLookup(null);
}
beforeEach(reset);
after(reset);

const ENTRY_YAML =
  "verified:\n  - by: agent:example-decider\n    on-behalf-of: human:owner\n    at: 2026-01-02T03:04:05-05:00\n    experiment: example-experiment\n";
const entry = { by: AGENT, "on-behalf-of": HUMAN, at: "2026-01-02T03:04:05-05:00", experiment: "example-experiment" };
const DRAFT = "---\ntitle: Q\ntype: Task/Example\nstatus: draft/proposed\n---\n\n# Q\n";
const DECIDED = `---\ntitle: Q\ntype: Task/Example\nstatus: stable/open\n${ENTRY_YAML}---\n\n# Q\n`;

// ── an in-memory vault whose metadata cache reads frontmatter with the guard's own parser ──

function fakeApp(files = {}, { blocks = {}, fileClassAlias = "type" } = {}) {
  const store = new Map(Object.entries(files));
  const app = {
    plugins: { plugins: { fileclass: { settings: { fileClassAlias } } } },
    vault: {
      getAbstractFileByPath: (p) => (store.has(p) ? new TFile(p) : null),
      read: async (f) => store.get(f.path) ?? "",
      cachedRead: async (f) => store.get(f.path) ?? "",
      create: async (p, c) => { store.set(p, c); },
      modify: async (f, c) => { store.set(f.path, c); },
      append: async (f, c) => { store.set(f.path, (store.get(f.path) ?? "") + c); },
      createFolder: async () => {},
    },
    metadataCache: {
      getFileCache: (f) => {
        let fm = null;
        try { fm = parseGuardFrontmatter(store.get(f.path) ?? ""); } catch { fm = null; }
        return { ...(fm ? { frontmatter: fm } : {}), blocks: blocks[f.path] ?? {} };
      },
    },
    fileManager: {
      processFrontMatter: async () => { throw new Error("not reached in these tests: the guard refuses first"); },
    },
  };
  return { app, store };
}

function harness(files, opts) {
  const { app, store } = fakeApp(files, opts);
  const backend = new ObsidianBackend(app);
  const tools = new Map();
  registerFsTools({ registerTool: (name, def, handler) => tools.set(name, { def, handler }) }, backend, { decodeHtml: false });
  const call = (name, args) => tools.get(name).handler(args, {});
  return { app, store, backend, call };
}

function wireMachine(app, flow = "flow.js") {
  setAcceptStatusTableLookup(makeStatusTableLookup(app, () => flow, () => ({ classFrontmatter: (_a, name) => CLASSES[name] })));
}

const refused = (res) => {
  assert.equal(res.isError, true, "the write must be refused");
  assert.match(res.content[0].text, /\[accept_forbidden\]/);
  return res.content[0].text;
};

describe("obsidian_write_note", () => {
  test("default (empty list): the decider-shaped write is refused and nothing lands", async () => {
    const { app, store, call } = harness({ "q.md": DRAFT });
    wireMachine(app);
    const text = refused(await call("obsidian_write_note", { path: "q.md", content: DECIDED, overwrite: true }));
    assert.match(text, /write would change the verification field 'verified'|write would introduce the verification field 'verified'/);
    assert.equal(store.get("q.md"), DRAFT);
  });

  test("listed: the exact entry lands with the class's draft → stable move, read through the construction module", async () => {
    allow();
    const { app, store, call } = harness({ "q.md": DRAFT });
    wireMachine(app);
    const res = await call("obsidian_write_note", { path: "q.md", content: DECIDED, overwrite: true });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    const fm = parseGuardFrontmatter(store.get("q.md"));
    assert.deepEqual(fm.verified, [entry]);
    assert.equal(fm.status, "stable/open");
  });

  test("listed, but the write does not move the status: refused, naming the move", async () => {
    allow();
    const { app, store, call } = harness({ "q.md": DRAFT });
    wireMachine(app);
    const text = refused(await call("obsidian_write_note", { path: "q.md", content: DECIDED.replace("status: stable/open", "status: draft/proposed"), overwrite: true }));
    assert.match(text, /move status from 'draft\/proposed' to 'stable\/open'/);
    assert.equal(store.get("q.md"), DRAFT);
  });

  test("listed, with no construction module set: the machine is unavailable and the draft's entry is refused", async () => {
    allow();
    const { app, store, call } = harness({ "q.md": DRAFT });
    wireMachine(app, "");
    assert.match(refused(await call("obsidian_write_note", { path: "q.md", content: DECIDED, overwrite: true })), /createNoteFlow setting is empty/);
    assert.equal(store.get("q.md"), DRAFT);
  });

  test("listed, but the class key is not where the fileclass plugin says: no table, so the refined draft is refused", async () => {
    allow();
    const { app, call } = harness({ "q.md": DRAFT }, { fileClassAlias: "fileClass" });
    wireMachine(app);
    assert.match(refused(await call("obsidian_write_note", { path: "q.md", content: DECIDED, overwrite: true })), /declares no status-transitions/);
  });

  test("listed: a new note carrying the entry is refused (nothing to append to)", async () => {
    allow();
    const { app, store, call } = harness({});
    wireMachine(app);
    assert.match(refused(await call("obsidian_write_note", { path: "new.md", content: DECIDED })), /must already exist/);
    assert.equal(store.has("new.md"), false);
  });

  test("listed: a human actor in the entry is refused exactly as before", async () => {
    allow();
    const { app, call } = harness({ "q.md": DRAFT });
    wireMachine(app);
    const text = refused(await call("obsidian_write_note", { path: "q.md", content: DECIDED.replace("by: agent:example-decider", "by: human:owner"), overwrite: true }));
    assert.match(text, /^Error \[accept_forbidden\]: write would introduce the verification field 'verified'\. /);
  });
});

describe("obsidian_manage_frontmatter", () => {
  test("its values are scalars, so it can never carry an entry: refused, listed or not", async () => {
    allow();
    const STABLE = "---\nstatus: stable/open\n---\nbody\n";
    const { app, store, call } = harness({ "s.md": STABLE });
    wireMachine(app);
    refused(await call("obsidian_manage_frontmatter", { path: "s.md", key: "verified", op: "set", value: [AGENT] }));
    refused(await call("obsidian_manage_frontmatter", { path: "s.md", key: "verified", op: "set", value: AGENT }));
    assert.equal(store.get("s.md"), STABLE);
  });
});

describe("obsidian_append_note", () => {
  test("appending a fence onto an empty note has no frontmatter before it: refused", async () => {
    allow();
    const { app, store, call } = harness({ "e.md": "" });
    wireMachine(app);
    refused(await call("obsidian_append_note", { path: "e.md", content: DECIDED }));
    assert.equal(store.get("e.md"), "");
  });
});

describe("patchNote (obsidian_patch_note's backend call)", () => {
  const TEXT = "---\nstatus: stable/open\n---\nbody ^b\n";
  // A block anchor whose range is the status line: the patch then rewrites the fence.
  const blocks = { "p.md": { b: { position: { start: { offset: 4 }, end: { offset: 23 } } } } };
  const replacement = `status: stable/open\n${ENTRY_YAML.trimEnd()}`;

  test("default: a patch that lands an entry in the fence is refused", async () => {
    const { app, store, backend } = harness({ "p.md": TEXT }, { blocks });
    wireMachine(app);
    await assert.rejects(() => backend.patchNote("p.md", { type: "block", value: "b" }, "replace", replacement), /verification field 'verified'/);
    assert.equal(store.get("p.md"), TEXT);
  });

  test("listed: the same patch runs through the same predicate and is admitted (a stable note moves nothing)", async () => {
    allow();
    const { app, store, backend } = harness({ "p.md": TEXT }, { blocks });
    wireMachine(app);
    await backend.patchNote("p.md", { type: "block", value: "b" }, "replace", replacement);
    assert.deepEqual(parseGuardFrontmatter(store.get("p.md")).verified, [entry]);
  });
});

describe("composeNote (obsidian_write_notes)", () => {
  const deps = {
    stringifyYaml: (o) => Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n",
    formatTs: () => "2026-01-02 03:04",
    now: Date.parse("2026-01-02T08:04:05Z"),
    mintUid: () => "uid-1",
  };
  const existing = { title: "Q", type: "Task/Example", status: "draft/proposed" };
  const payload = { ...existing, status: "stable/open", verified: [entry] };

  test("default: refused", () => {
    setAcceptStatusTableLookup(() => ({ state: "table", table: TABLE }));
    assert.throws(() => composeNote({ ...deps, frontmatter: payload, body: "# Q", stamp: false, existing }), (e) => e.code === "accept_forbidden");
  });

  test("listed: admitted; and two entries in one item are refused", () => {
    allow();
    setAcceptStatusTableLookup(() => ({ state: "table", table: TABLE }));
    const r = composeNote({ ...deps, frontmatter: payload, body: "# Q", stamp: false, existing });
    assert.deepEqual(r.frontmatter.verified, [entry]);
    assert.throws(
      () => composeNote({ ...deps, frontmatter: { ...payload, verified: [entry, entry] }, body: "# Q", stamp: false, existing }),
      (e) => e.code === "accept_forbidden" && /append exactly one entry/.test(e.message),
    );
  });
});

describe("guardAppendResult (obsidian_append_at_heading)", () => {
  test("default refuses; listed admits the same result", () => {
    setAcceptStatusTableLookup(() => ({ state: "table", table: TABLE }));
    assert.throws(() => guardAppendResult(DRAFT, DECIDED), (e) => e.code === "accept_forbidden");
    allow();
    assert.doesNotThrow(() => guardAppendResult(DRAFT, DECIDED));
  });
});

describe("cliAcceptRefusal (the CLI proxy)", () => {
  test("payload-only, so it refuses the entry even when the agent is listed", () => {
    allow();
    assert.match(cliAcceptRefusal("property:set", { name: "verified", value: AGENT }, parseYaml) ?? "", /verified/);
    assert.match(cliAcceptRefusal("create", { path: "x.md", content: DECIDED }, parseYaml) ?? "", /verified/);
  });
});

describe("the setting cannot be changed through any tool", () => {
  function sources(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        out.push(...sources(p));
      } else if (/\.(ts|mts|js|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const srcFiles = fs
    .readdirSync(path.join(REPO, "packages"))
    .map((pkg) => path.join(REPO, "packages", pkg, "src"))
    .filter((d) => fs.existsSync(d))
    .flatMap(sources);
  const rel = (p) => path.relative(REPO, p).split(path.sep).join("/");

  test("the setters are called only from the host's main.ts (settings load, save and unload)", () => {
    const callers = srcFiles
      .filter((p) => /\bsetAcceptAllowedAgents\(|\bsetAcceptStatusTableLookup\(/.test(fs.readFileSync(p, "utf8")))
      .map(rel)
      .filter((p) => p !== "packages/core/src/accept-guard.ts")
      .sort();
    assert.deepEqual(callers, ["packages/host/src/main.ts"]);
  });

  test("no MCP tool source names the two settings", () => {
    const hits = srcFiles
      .map(rel)
      .filter((p) => p.startsWith("packages/host/src/mcp/") || /\/src\/tools/.test(p))
      .filter((p) => /acceptAllowedAgents|acceptOnBehalfOf/.test(fs.readFileSync(path.join(REPO, p), "utf8")));
    assert.deepEqual(hits, []);
  });

  test("the plugin's data.json is not a path any write tool takes", async () => {
    const { store, call, backend } = harness({});
    const target = ".obsidian/plugins/vault-mcp/data.json";
    const res = await call("obsidian_write_note", { path: target, content: '{"acceptAllowedAgents":["agent:x"]}' });
    assert.equal(res.isError, true);
    await assert.rejects(() => backend.writeFile(target, "{}", true));
    await assert.rejects(() => backend.writeFile(".obsidian/plugins/vault-mcp/x.base", "{}", true), /hidden/);
    assert.equal(store.size, 0);
  });
});
