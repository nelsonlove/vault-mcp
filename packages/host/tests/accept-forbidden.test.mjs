/**
 * accept-forbidden.test.mjs — the "accept verb is in no API" scar, enforced at
 * the SHARED write primitive (ObsidianBackend) so EVERY MCP write tool inherits
 * it. This is the B1-fix: the guard used to live on obsidian_write_notes only
 * (its structured `frontmatter` arg), so every older write tool self-accepted
 * freely, body-injected frontmatter slipped it (S2), and array/map value-types
 * slipped it (S3). Here each write tool is driven through registerFsTools + the
 * REAL ObsidianBackend (over a fake app) and proven to REJECT the introduction
 * of an accepted-family value while ALLOWING a preserved existing one.
 *
 * The backend imports live Obsidian classes, so the specifier is stubbed before
 * it is imported (the same mechanism link-healing.test.mjs uses for moves).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { installObsidianStub, TFile, parseYaml } from "./obsidian-stub.mjs";

installObsidianStub();
const { ObsidianBackend } = await import("../src/mcp/obsidian-backend.ts");
const { registerFsTools } = await import("@vault-mcp/core");

// ── a minimal in-memory vault the backend can drive ──────────────────────────

/** Extract + parse a note's leading frontmatter fence the way the backend does. */
function fmOf(content) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content ?? "");
  return m ? parseYaml(m[1]) : null;
}

function renderFm(fm) {
  return Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

function fakeApp({ files = {}, cache = {} } = {}) {
  const store = new Map(Object.entries(files)); // path -> raw markdown
  const caches = cache; // path -> { headings?, blocks? } (for patch anchors)
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (store.has(p) ? new TFile(p) : null),
      read: async (f) => store.get(f.path) ?? "",
      cachedRead: async (f) => store.get(f.path) ?? "",
      create: async (p, c) => { store.set(p, c); },
      modify: async (f, c) => { store.set(f.path, c); },
      append: async (f, c) => { store.set(f.path, (store.get(f.path) ?? "") + c); },
      createFolder: async () => {},
      // A move renames at the file level and rewrites links itself (move-with-links.ts).
      getMarkdownFiles: () => [...store.keys()].map((p) => new TFile(p)),
      rename: async (f, to) => {
        store.set(to, store.get(f.path));
        store.delete(f.path);
      },
      process: async (f, fn) => { const n = fn(store.get(f.path) ?? ""); store.set(f.path, n); return n; },
    },
    metadataCache: {
      resolvedLinks: {},
      getFirstLinkpathDest: () => null,
      fileToLinktext: (f) => f.basename,
      getFileCache: (f) => {
        const fm = fmOf(store.get(f.path) ?? "");
        return { ...(fm ? { frontmatter: fm } : {}), ...(caches[f.path] ?? {}) };
      },
    },
    fileManager: {
      processFrontMatter: async (f, fn) => {
        const fm = fmOf(store.get(f.path) ?? "") ?? {};
        fn(fm);
        const body = (store.get(f.path) ?? "").replace(
          /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/,
          "",
        );
        store.set(f.path, `---\n${renderFm(fm)}\n---\n${body}`);
      },
    },
  };
  return { app, store };
}

/** Register the fs-tools against a real backend over `app` and return a caller. */
function harness(appOpts) {
  const { app, store } = fakeApp(appOpts);
  const tools = new Map();
  const server = { registerTool: (name, def, handler) => tools.set(name, { def, handler }) };
  registerFsTools(server, new ObsidianBackend(app), { decodeHtml: false });
  const call = (name, args) => tools.get(name).handler(args, {});
  return { call, store };
}

/** Assert an MCP envelope is an accept_forbidden refusal. */
function assertRejected(res, path) {
  assert.equal(res.isError, true, "the write must be refused");
  assert.match(res.content[0].text, /\[accept_forbidden\]/, "the refusal carries the accept_forbidden code");
  if (path) assert.match(res.content[0].text, /accept/i);
}

const ACC = "---\nacceptance-status: accepted\n---\nbody";

// ── obsidian_write_note ───────────────────────────────────────────────────────

describe("obsidian_write_note — accept-forbidden at the write primitive", () => {
  test("blocks a body-injected accepted fence on a NEW note (S2)", async () => {
    const { call, store } = harness();
    const res = await call("obsidian_write_note", { path: "New/A.md", content: ACC, overwrite: true });
    assertRejected(res);
    assert.equal(store.has("New/A.md"), false, "a rejected write must never land on disk");
  });

  test("blocks an accepted-by field carried in content", async () => {
    const { call } = harness();
    const res = await call("obsidian_write_note", {
      path: "New/B.md",
      content: "---\nname: N\naccepted-by: nelson\n---\nx",
      overwrite: true,
    });
    assertRejected(res);
  });

  test("blocks the array value-type form (S3)", async () => {
    const { call } = harness();
    const res = await call("obsidian_write_note", {
      path: "New/C.md",
      content: "---\nacceptance-status: [accepted]\n---\nx",
      overwrite: true,
    });
    assertRejected(res);
  });

  test("blocks the map value-type form (S3)", async () => {
    const { call } = harness();
    const res = await call("obsidian_write_note", {
      path: "New/D.md",
      content: "---\nacceptance-status: {value: accepted}\n---\nx",
      overwrite: true,
    });
    assertRejected(res);
  });

  test("blocks changing an existing proposed → accepted", async () => {
    const { call } = harness({ files: { "E.md": "---\nacceptance-status: proposed\n---\nold" } });
    const res = await call("obsidian_write_note", { path: "E.md", content: ACC, overwrite: true });
    assertRejected(res);
  });

  test("ALLOWS an ordinary write with no acceptance", async () => {
    const { call, store } = harness();
    const res = await call("obsidian_write_note", { path: "Ok/F.md", content: "---\nname: F\n---\nhi", overwrite: true });
    assert.notEqual(res.isError, true);
    assert.equal(store.get("Ok/F.md"), "---\nname: F\n---\nhi");
  });

  test("ALLOWS preserving an existing human-granted accepted (legitimate edit)", async () => {
    const { call, store } = harness({ files: { "Keep/G.md": "---\nacceptance-status: accepted\n---\nold body" } });
    const res = await call("obsidian_write_note", {
      path: "Keep/G.md",
      content: "---\nacceptance-status: accepted\n---\nedited body",
      overwrite: true,
    });
    assert.notEqual(res.isError, true, "carrying an existing accepted forward unchanged is allowed");
    assert.match(store.get("Keep/G.md"), /edited body/);
  });
});

// ── obsidian_append_note ──────────────────────────────────────────────────────

describe("obsidian_append_note — accept-forbidden", () => {
  test("blocks CREATING a note whose appended content injects an accepted fence", async () => {
    const { call, store } = harness();
    const res = await call("obsidian_append_note", { path: "New/H.md", content: ACC });
    assertRejected(res);
    assert.equal(store.has("New/H.md"), false);
  });

  test("ALLOWS appending to an existing accepted note (append cannot change frontmatter)", async () => {
    const { call, store } = harness({ files: { "I.md": "---\nacceptance-status: accepted\n---\nbody" } });
    const res = await call("obsidian_append_note", { path: "I.md", content: "\nmore text" });
    assert.notEqual(res.isError, true);
    assert.match(store.get("I.md"), /more text/);
  });

  test("blocks appending an accepted fence to an EMPTY existing note (S5)", async () => {
    // write_note "" leaves a 0-byte note that passes; the append then makes the
    // fence the note's leading frontmatter — the existing-append branch must guard.
    const { call, store } = harness({ files: { "Empty/J.md": "" } });
    const res = await call("obsidian_append_note", {
      path: "Empty/J.md",
      content: "---\nacceptance-status: accepted\naccepted-by: ghost\n---\n",
    });
    assertRejected(res);
    assert.equal(store.get("Empty/J.md"), "", "the empty note must be left untouched");
  });

  test("ALLOWS appending to a non-empty frontmatter-less note (fence lands mid-body, not as frontmatter)", async () => {
    const { call, store } = harness({ files: { "Plain/K.md": "just a plain body, no frontmatter" } });
    // The appended text lands AFTER existing body, so even a `---` fence cannot
    // become the note's leading frontmatter — the final content is checked and
    // asserts no acceptance.
    const res = await call("obsidian_append_note", { path: "Plain/K.md", content: "\n---\nacceptance-status: accepted\n---\n" });
    assert.notEqual(res.isError, true);
    assert.match(store.get("Plain/K.md"), /just a plain body/);
  });

  test("ALLOWS a normal append (no accepted) to a non-empty note", async () => {
    const { call, store } = harness({ files: { "L.md": "---\nname: L\n---\nbody" } });
    const res = await call("obsidian_append_note", { path: "L.md", content: "\nappended line" });
    assert.notEqual(res.isError, true);
    assert.match(store.get("L.md"), /appended line/);
  });
});

// ── obsidian_manage_frontmatter (op=set) ──────────────────────────────────────

describe("obsidian_manage_frontmatter set — accept-forbidden", () => {
  test("blocks setting acceptance-status = accepted", async () => {
    const { call } = harness({ files: { "J.md": "---\nname: J\n---\nx" } });
    const res = await call("obsidian_manage_frontmatter", { path: "J.md", key: "acceptance-status", op: "set", value: "accepted" });
    assertRejected(res);
  });

  test("blocks setting an accepted-by field", async () => {
    const { call } = harness({ files: { "K.md": "---\nname: K\n---\nx" } });
    const res = await call("obsidian_manage_frontmatter", { path: "K.md", key: "accepted-by", op: "set", value: "nelson" });
    assertRejected(res);
  });

  test("blocks the array value-type (S3)", async () => {
    const { call } = harness({ files: { "L.md": "---\nname: L\n---\nx" } });
    const res = await call("obsidian_manage_frontmatter", { path: "L.md", key: "acceptance-status", op: "set", value: ["accepted"] });
    assertRejected(res);
  });

  test("blocks the map value-type (S3)", async () => {
    const { call } = harness({ files: { "M.md": "---\nname: M\n---\nx" } });
    const res = await call("obsidian_manage_frontmatter", { path: "M.md", key: "acceptance-status", op: "set", value: { value: "accepted" } });
    assertRejected(res);
  });

  test("ALLOWS setting a non-accepted status", async () => {
    const { call } = harness({ files: { "N.md": "---\nname: N\n---\nx" } });
    const res = await call("obsidian_manage_frontmatter", { path: "N.md", key: "acceptance-status", op: "set", value: "proposed" });
    assert.notEqual(res.isError, true);
  });

  test("ALLOWS re-asserting an already-accepted value verbatim (no-op preserve)", async () => {
    const { call } = harness({ files: { "O.md": "---\nacceptance-status: accepted\n---\nx" } });
    const res = await call("obsidian_manage_frontmatter", { path: "O.md", key: "acceptance-status", op: "set", value: "accepted" });
    assert.notEqual(res.isError, true);
  });
});

// ── obsidian_patch_note & obsidian_move_note (cannot introduce frontmatter) ────

describe("obsidian_patch_note — an accepted note is patchable (guard is preserve-safe)", () => {
  test("patching a heading on an accepted note is ALLOWED and preserves acceptance", async () => {
    const files = { "P.md": "---\nacceptance-status: accepted\n---\n# Head\nold" };
    // The cache Obsidian gives this text: "# Head" at offset 36.
    const at = files["P.md"].indexOf("# Head");
    const cache = { "P.md": { headings: [{ heading: "Head", level: 1, position: { start: { offset: at }, end: { offset: at + 6 } } }] } };
    const { call, store } = harness({ files, cache });
    const res = await call("obsidian_patch_note", { path: "P.md", anchor_type: "heading", anchor: "Head", op: "append", content: "new line" });
    assert.notEqual(res.isError, true);
    assert.match(store.get("P.md"), /acceptance-status: accepted/, "the human's accepted survives an in-body patch");
  });
});

describe("obsidian_move_note — moving an accepted note is ALLOWED (content preserved)", () => {
  test("a move cannot introduce acceptance and never blocks a legitimate accepted note", async () => {
    const { call, store } = harness({ files: { "From/Q.md": "---\nacceptance-status: accepted\n---\nbody" } });
    const res = await call("obsidian_move_note", { from: "From/Q.md", to: "To/Q.md", update_backlinks: true, overwrite: false });
    assert.notEqual(res.isError, true);
    assert.equal(store.has("To/Q.md"), true);
    assert.match(store.get("To/Q.md"), /acceptance-status: accepted/);
  });
});
