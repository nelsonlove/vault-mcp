/**
 * protected-properties-transports.test.mjs — the declared protected-property
 * perimeter (#224) swept across the PLUGIN transports, parametrized over a
 * declared test key exactly like the accepted family's own per-transport tests:
 *
 *   • ObsidianBackend via registerFsTools (obsidian_write_note /
 *     obsidian_manage_frontmatter set+delete / obsidian_append_note) — the
 *     shared write primitive every MCP write tool routes through;
 *   • obsidian_append_at_heading (the #109 out-of-primitive path);
 *   • composeNote (obsidian_write_notes' stamped/verbatim item composer);
 *   • cliAcceptRefusal (the CLI property/content guard, #107/#153).
 *
 * Grade semantics under test: introduce / change / remove refuse with the
 * typed accept_forbidden code and NOTHING lands; byte-identical carry-forward
 * writes; case/underscore variants are caught; a second declared key enforces
 * identically; and with the declared list EMPTIED the same writes pass while
 * the accepted-family floor still refuses (floor ≠ config).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { installObsidianStub, TFile, parseYaml } from "./obsidian-stub.mjs";
import { fakeServer } from "./fake-server.mjs";

installObsidianStub();
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { registerComplementaryTools } = await import("../src/mcp/tools-complementary.ts");
const { composeNote } = await import("../src/mcp/write-notes-compose.ts");
const { cliAcceptRefusal } = await import("../src/mcp/tools-cli.ts");
const {
  registerFsTools,
  DEFAULT_PROTECTED_PROPERTIES,
  setDeclaredProtectedProperties,
} = await import("@vault-mcp/core");

const silent = () => {};
const WITH_TIER = [...DEFAULT_PROTECTED_PROPERTIES, { key: "review-tier", grade: "agent-forbidden" }];

beforeEach(() => setDeclaredProtectedProperties(WITH_TIER, silent));
after(() => setDeclaredProtectedProperties(DEFAULT_PROTECTED_PROPERTIES, silent));

// ── in-memory vault (the accept-forbidden.test.mjs harness, verbatim shape) ──

function fmOf(content) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content ?? "");
  return m ? parseYaml(m[1]) : null;
}

function renderFm(fm) {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

function fakeApp({ files = {} } = {}) {
  const store = new Map(Object.entries(files));
  const app = {
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
        const fm = fmOf(store.get(f.path) ?? "");
        return fm ? { frontmatter: fm } : {};
      },
    },
    fileManager: {
      processFrontMatter: async (f, fn) => {
        const fm = fmOf(store.get(f.path) ?? "") ?? {};
        fn(fm);
        const body = (store.get(f.path) ?? "").replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
        store.set(f.path, `---\n${renderFm(fm)}\n---\n${body}`);
      },
    },
  };
  return { app, store };
}

function harness(appOpts) {
  const { app, store } = fakeApp(appOpts);
  const tools = new Map();
  const server = { registerTool: (name, def, handler) => tools.set(name, { def, handler }) };
  registerFsTools(server, new ObsidianBackend(app), { decodeHtml: false });
  const call = (name, args) => tools.get(name).handler(args, {});
  return { call, store };
}

function assertRefused(res) {
  assert.equal(res.isError, true, "the write must be refused");
  assert.match(res.content[0].text, /\[accept_forbidden\]/);
  assert.match(res.content[0].text, /protected property/);
}

const POLICY_NOTE = "---\nauto-accept: appends\ntitle: T\n---\nbody\n";

describe("ObsidianBackend transports — declared key sweep", () => {
  test("obsidian_write_note INTRODUCING auto-accept refuses; nothing lands", async () => {
    const { call, store } = harness({});
    const res = await call("obsidian_write_note", { path: "n.md", content: "---\nauto-accept: all\n---\nhi\n" });
    assertRefused(res);
    assert.equal(store.has("n.md"), false);
  });

  test("obsidian_write_note CHANGING auto-accept refuses; disk unchanged", async () => {
    const { call, store } = harness({ files: { "n.md": POLICY_NOTE } });
    const res = await call("obsidian_write_note", {
      path: "n.md",
      content: "---\nauto-accept: all\ntitle: T\n---\nbody\n",
      overwrite: true,
    });
    assertRefused(res);
    assert.equal(store.get("n.md"), POLICY_NOTE);
  });

  test("obsidian_write_note REMOVING auto-accept (omission) refuses; disk unchanged", async () => {
    const { call, store } = harness({ files: { "n.md": POLICY_NOTE } });
    const res = await call("obsidian_write_note", { path: "n.md", content: "---\ntitle: T\n---\nbody\n", overwrite: true });
    assertRefused(res);
    assert.equal(store.get("n.md"), POLICY_NOTE);
  });

  test("obsidian_write_note carrying auto-accept forward byte-identically is ALLOWED", async () => {
    const { call, store } = harness({ files: { "n.md": POLICY_NOTE } });
    const res = await call("obsidian_write_note", {
      path: "n.md",
      content: "---\nauto-accept: appends\ntitle: T\n---\nnew body\n",
      overwrite: true,
    });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.match(store.get("n.md"), /new body/);
  });

  test("underscore/case variant cannot dodge: AUTO_ACCEPT refused; variant beside the real key refused", async () => {
    const { call } = harness({ files: { "n.md": POLICY_NOTE } });
    assertRefused(await call("obsidian_write_note", { path: "m.md", content: "---\nAUTO_ACCEPT: all\n---\nhi\n" }));
    assertRefused(
      await call("obsidian_write_note", {
        path: "n.md",
        content: "---\nauto-accept: appends\nauto_accept: all\ntitle: T\n---\nbody\n",
        overwrite: true,
      })
    );
  });

  test("obsidian_manage_frontmatter set/delete on auto-accept refuses; unrelated keys pass", async () => {
    const { call, store } = harness({ files: { "n.md": POLICY_NOTE } });
    assertRefused(await call("obsidian_manage_frontmatter", { path: "n.md", key: "auto-accept", op: "set", value: "all" }));
    assertRefused(await call("obsidian_manage_frontmatter", { path: "n.md", key: "auto-accept", op: "delete" }));
    assert.match(store.get("n.md"), /auto-accept: appends/);
    const ok = await call("obsidian_manage_frontmatter", { path: "n.md", key: "title", op: "set", value: "U" });
    assert.notEqual(ok.isError, true, ok.content?.[0]?.text);
    assert.match(store.get("n.md"), /title: U/);
  });

  test("obsidian_append_note to a policy note still works; the policy value survives", async () => {
    const { call, store } = harness({ files: { "n.md": POLICY_NOTE } });
    const res = await call("obsidian_append_note", { path: "n.md", content: "appended\n" });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.match(store.get("n.md"), /appended/);
    assert.match(store.get("n.md"), /auto-accept: appends/);
  });

  test("the second declared key (review-tier) enforces identically", async () => {
    const { call, store } = harness({ files: { "t.md": "---\nreview-tier: 2\n---\nbody\n" } });
    assertRefused(await call("obsidian_write_note", { path: "u.md", content: "---\nreview-tier: 1\n---\nhi\n" }));
    assertRefused(await call("obsidian_manage_frontmatter", { path: "t.md", key: "review-tier", op: "set", value: 3 }));
    assertRefused(await call("obsidian_manage_frontmatter", { path: "t.md", key: "review-tier", op: "delete" }));
    assert.match(store.get("t.md"), /review-tier: 2/);
  });

  test("with the declared list EMPTIED the same writes pass — and the accepted-family floor still refuses", async () => {
    setDeclaredProtectedProperties([], silent);
    const { call, store } = harness({ files: { "n.md": POLICY_NOTE } });
    const ok = await call("obsidian_manage_frontmatter", { path: "n.md", key: "auto-accept", op: "set", value: "all" });
    assert.notEqual(ok.isError, true, ok.content?.[0]?.text);
    assert.match(store.get("n.md"), /auto-accept: all/);
    const floor = await call("obsidian_manage_frontmatter", { path: "n.md", key: "accepted-by", op: "set", value: "me" });
    assert.equal(floor.isError, true);
    assert.match(floor.content[0].text, /\[accept_forbidden\]/);
  });
});

// ── obsidian_append_at_heading (#109 path) ───────────────────────────────────

describe("obsidian_append_at_heading — declared key coverage", () => {
  function aahHarness(files = {}) {
    const tree = new Map();
    for (const [p, { text, cache }] of Object.entries(files)) {
      tree.set(p, { file: new TFile(p), text, cache: cache ?? { headings: [] } });
    }
    const calls = { create: [], append: [], modify: [] };
    const app = {
      vault: {
        getAbstractFileByPath: (p) => tree.get(p)?.file ?? null,
        async read(file) { return tree.get(file.path).text; },
        async create(p, content) { calls.create.push([p, content]); },
        async append(file, content) { calls.append.push([file.path, content]); },
        async modify(file, content) { calls.modify.push([file.path, content]); },
      },
      metadataCache: { getFileCache: (file) => tree.get(file.path)?.cache ?? null },
    };
    const server = fakeServer();
    registerComplementaryTools(server, app, { getSettings: () => ({ allowlist: [] }) });
    return { handler: server.tools.get("obsidian_append_at_heading").handler, calls };
  }

  test("a write that closes an open leading fence and introduces auto-accept is refused; nothing written", async () => {
    // A cache that mis-reports offsets inside the fence is no longer used
    // (#593), so the guard is reached the way a real write reaches it: the
    // fence is still open, and appending under `## H` closes it.
    const text = "---\nfoo: bar\n## H\n";
    const at = text.indexOf("## H");
    const cache = { headings: [{ heading: "H", level: 2, position: { start: { line: 2, offset: at }, end: { line: 2, offset: at + 4 } } }] };
    const { handler, calls } = aahHarness({ "N.md": { text, cache } });
    const res = await handler({ path: "N.md", heading: "H", content: "auto-accept: all\n---", create_if_missing: false });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /\[accept_forbidden\]/);
    assert.match(res.content[0].text, /protected property/);
    assert.equal(calls.modify.length, 0);
  });

  test("an ordinary body append onto a policy-carrying note SUCCEEDS (carry-forward)", async () => {
    const text = "---\nauto-accept: appends\n---\n\n## H\n\nbody\n";
    const cache = { headings: [{ heading: "H", level: 2, position: { start: { line: 4, offset: 30 } } }] };
    const { handler, calls } = aahHarness({ "N.md": { text, cache } });
    const res = await handler({ path: "N.md", heading: "H", content: "more", create_if_missing: false });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.equal(calls.append.length + calls.modify.length, 1, "exactly one write landed");
  });
});

// ── composeNote (obsidian_write_notes item composer) ─────────────────────────

describe("composeNote — declared key coverage", () => {
  const deps = {
    stringifyYaml: (o) => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n",
    parseYaml,
    formatTs: () => "2026-08-18 12:00",
    now: new Date("2026-08-18T12:00:00Z"),
    mintUid: () => "uid-1",
  };

  test("a payload introducing auto-accept throws typed accept_forbidden", () => {
    assert.throws(
      () => composeNote({ ...deps, frontmatter: { "auto-accept": "all" }, body: "hi", stamp: false, existing: null }),
      (e) => e.code === "accept_forbidden" && /protected property/.test(e.message)
    );
  });

  test("a stamped rewrite that OMITS an existing auto-accept throws (removal)", () => {
    assert.throws(
      () =>
        composeNote({
          ...deps,
          frontmatter: { title: "T" },
          body: "hi",
          stamp: true,
          existing: { "auto-accept": "appends", title: "T" },
        }),
      (e) => e.code === "accept_forbidden" && /remove the protected property/.test(e.message)
    );
  });

  test("carrying the existing value forward verbatim is allowed", () => {
    const r = composeNote({
      ...deps,
      frontmatter: { "auto-accept": "appends", title: "T" },
      body: "hi",
      stamp: false,
      existing: { "auto-accept": "appends" },
    });
    assert.match(r.content, /auto-accept: appends/);
  });

  test("a body-injected fence carrying auto-accept is caught on the no-structured-frontmatter path", () => {
    assert.throws(
      () => composeNote({ ...deps, frontmatter: {}, body: "---\nauto-accept: all\n---\nhi", stamp: false, existing: null }),
      (e) => e.code === "accept_forbidden" && /protected property/.test(e.message)
    );
  });
});

// ── cliAcceptRefusal (CLI property/content paths) ────────────────────────────

describe("cliAcceptRefusal — declared key coverage", () => {
  test("property:set name=auto-accept is refused (either param shape)", () => {
    assert.match(cliAcceptRefusal("property:set", { name: "auto-accept", value: "all" }, parseYaml) ?? "", /protected property/);
    assert.match(cliAcceptRefusal("property:set", { "auto-accept": "all" }, parseYaml) ?? "", /protected property/);
    assert.match(cliAcceptRefusal("property:set", { name: "AUTO_ACCEPT", value: "x" }, parseYaml) ?? "", /protected property/);
  });

  test("a content write whose fence carries auto-accept is refused; unrelated content is clean", () => {
    assert.match(
      cliAcceptRefusal("create", { content: "---\nauto-accept: appends\n---\nbody" }, parseYaml) ?? "",
      /protected property/
    );
    assert.equal(cliAcceptRefusal("create", { content: "---\ntitle: x\n---\nbody" }, parseYaml), null);
  });

  test("a valueless --auto-accept flag on a guarded family fails closed", () => {
    const r = cliAcceptRefusal("property:set", { name: "title", value: "x" }, parseYaml, ["--auto-accept"]);
    assert.match(r ?? "", /valueless flag/);
  });

  test("an UNPARSEABLE fence mentioning auto-accept fails closed (textual fallback)", () => {
    const broken = "---\n[unclosed\nauto_accept: all\n---\nbody";
    assert.match(cliAcceptRefusal("create", { content: broken }, parseYaml) ?? "", /protected property/);
  });

  test("with the declared list emptied, the same calls are clean (config-driven)", () => {
    setDeclaredProtectedProperties([], silent);
    assert.equal(cliAcceptRefusal("property:set", { name: "auto-accept", value: "all" }, parseYaml), null);
    // floor unchanged
    assert.match(cliAcceptRefusal("property:set", { name: "accepted-by", value: "x" }, parseYaml) ?? "", /acceptance field/);
  });
});

// ── the live `verified` key on every host transport (#406) ───────────────────

function assertRefusedVerified(res, re = /verification field/) {
  assert.equal(res.isError, true, "the write must be refused");
  assert.match(res.content[0].text, /\[accept_forbidden\]/);
  assert.match(res.content[0].text, re);
}
const RECORD_NOTE = "---\nverified:\n  - by: human:nelson\n    at: 2026-09-25T05:08:39-04:00\ntitle: T\n---\nbody\n";
const BLANK_NOTE = "---\nverified: []\ntitle: T\n---\nbody\n";

describe("ObsidianBackend transports — the live `verified` key (#406)", () => {
  test("obsidian_write_note INTRODUCING verified refuses; nothing lands", async () => {
    const { call, store } = harness({});
    assertRefusedVerified(await call("obsidian_write_note", { path: "n.md", content: "---\nverified:\n  - by: an-agent\n---\nhi\n" }));
    assert.equal(store.has("n.md"), false);
  });

  test("obsidian_write_note writing a BLANK verified refuses with the remedy named", async () => {
    const { call, store } = harness({});
    assertRefusedVerified(await call("obsidian_write_note", { path: "n.md", content: "---\nverified: []\n---\nhi\n" }), /remove the key instead/);
    assert.equal(store.has("n.md"), false);
  });

  test("obsidian_write_note that OMITS a filled record refuses (removal); carrying it forward with a new body is ALLOWED", async () => {
    const { call, store } = harness({ files: { "n.md": RECORD_NOTE } });
    assertRefusedVerified(await call("obsidian_write_note", { path: "n.md", content: "---\ntitle: T\n---\nnew body\n", overwrite: true }), /remove the verification field/);
    assert.equal(store.get("n.md"), RECORD_NOTE);
    const ok = await call("obsidian_write_note", { path: "n.md", content: RECORD_NOTE.replace("body", "new body"), overwrite: true });
    assert.notEqual(ok.isError, true, ok.content?.[0]?.text);
    assert.match(store.get("n.md"), /new body/);
  });

  test("obsidian_manage_frontmatter: set/delete on a filled record refuses; delete of a BLANK one is the allowed repair; unrelated keys pass on both", async () => {
    const { call, store } = harness({ files: { "f.md": RECORD_NOTE, "b.md": BLANK_NOTE } });
    assertRefusedVerified(await call("obsidian_manage_frontmatter", { path: "f.md", key: "verified", op: "set", value: "yes" }));
    assertRefusedVerified(await call("obsidian_manage_frontmatter", { path: "f.md", key: "verified", op: "delete" }), /remove the verification field/);
    assert.match(store.get("f.md"), /by: human:nelson/);
    const okF = await call("obsidian_manage_frontmatter", { path: "f.md", key: "title", op: "set", value: "U" });
    assert.notEqual(okF.isError, true, okF.content?.[0]?.text);
    // A note that carries the blank is otherwise unwritable — an unrelated set carries the blank forward and is refused; the delete repairs it.
    assertRefusedVerified(await call("obsidian_manage_frontmatter", { path: "b.md", key: "title", op: "set", value: "U" }), /remove the key instead/);
    const okB = await call("obsidian_manage_frontmatter", { path: "b.md", key: "verified", op: "delete" });
    assert.notEqual(okB.isError, true, okB.content?.[0]?.text);
    assert.doesNotMatch(store.get("b.md"), /verified/);
  });

  test("obsidian_append_note to a note with a filled record works; the record survives", async () => {
    const { call, store } = harness({ files: { "n.md": RECORD_NOTE } });
    const res = await call("obsidian_append_note", { path: "n.md", content: "appended\n" });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.match(store.get("n.md"), /appended/);
    assert.match(store.get("n.md"), /by: human:nelson/);
  });

  test("with the declared list EMPTIED the verified floor still refuses (it is the floor, not config)", async () => {
    setDeclaredProtectedProperties([], silent);
    try {
      const { call } = harness({ files: { "n.md": RECORD_NOTE } });
      assertRefusedVerified(await call("obsidian_write_note", { path: "n.md", content: "---\ntitle: T\n---\nx\n", overwrite: true }), /remove the verification field/);
    } finally {
      setDeclaredProtectedProperties(undefined, silent);
    }
  });
});

describe("composeNote — the live `verified` key (#406)", () => {
  const deps = {
    stringifyYaml: (o) => Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n",
    parseYaml,
    formatTs: () => "2026-09-26 12:00",
    now: new Date("2026-09-26T12:00:00Z"),
    mintUid: () => "uid-1",
  };
  const record = [{ by: "human:nelson", at: "2026-09-25T05:08:39-04:00" }];

  test("a payload introducing verified throws typed accept_forbidden", () => {
    assert.throws(
      () => composeNote({ ...deps, frontmatter: { verified: record }, body: "hi", stamp: false, existing: null }),
      (e) => e.code === "accept_forbidden" && /introduce the verification field/.test(e.message)
    );
  });

  test("a stamped rewrite SILENT on a filled record carries it forward by name (else every ordinary write would be a removal)", () => {
    const r = composeNote({ ...deps, frontmatter: { title: "T" }, body: "hi", stamp: true, existing: { verified: record, title: "T" } });
    assert.deepEqual(r.frontmatter.verified, record);
  });

  test("a stamped rewrite silent on a BLANK record drops it (the allowed repair), and a NON-stamped rewrite that omits a filled one throws (removal)", () => {
    const r = composeNote({ ...deps, frontmatter: { title: "T" }, body: "hi", stamp: true, existing: { verified: [], title: "T" } });
    assert.equal("verified" in r.frontmatter, false);
    assert.throws(
      () => composeNote({ ...deps, frontmatter: { title: "T" }, body: "hi", stamp: false, existing: { verified: record } }),
      (e) => e.code === "accept_forbidden" && /remove the verification field/.test(e.message)
    );
  });
});

describe("cliAcceptRefusal — the live `verified` key (#406)", () => {
  test("property:set name=verified is refused (either param shape); a content fence carrying it is refused; unrelated content is clean", () => {
    assert.match(cliAcceptRefusal("property:set", { name: "verified", value: "yes" }, parseYaml) ?? "", /verification field/);
    assert.match(cliAcceptRefusal("property:set", { verified_by: "x" }, parseYaml) ?? "", /verification field/);
    assert.match(cliAcceptRefusal("create", { content: "---\nverified: []\n---\nbody" }, parseYaml) ?? "", /verification field/);
    assert.equal(cliAcceptRefusal("create", { content: "---\ntitle: x\n---\nbody" }, parseYaml), null);
  });

  test("a fence the stub still parses around an unclosed line is caught structurally; the throwing-parser fallback (quoted keys included) is pinned in core's accept-guard tests", () => {
    // The test stub's parseYaml never throws (it skips lines it cannot read), so
    // this row cannot reach the textual fallback; it proves the structural path
    // through the CLI content guard sees a separator variant.
    const broken = "---\n[unclosed\nverified_by: an-agent\n---\nbody";
    assert.match(cliAcceptRefusal("create", { content: broken }, parseYaml) ?? "", /verification field/);
  });
});
