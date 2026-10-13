// obsidian_create_note (#531): a note of a class, through the vault's own
// flow.createFromFileclass. The vault's modules are faked (`load`); the
// handler, its refusals and its clean-up are the real ones.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile, TFolder } from "./obsidian-stub.mjs";
import { fakeServer } from "./fake-server.mjs";

installObsidianStub();
const { registerCreateNoteTool, CREATE_NOTE_TOOL, fillDates, notePath } = await import("../src/mcp/tools-create-note.ts");
const { decideSync, normalizeSyncGuard } = await import("../src/kernel/sync-guard.ts");

// A small vault: files hold text; class files carry frontmatter in the cache.
function fakeApp({ classes = {} } = {}) {
  const files = new Map(); // path -> { file, text }
  const folders = new Set([""]);
  const trashed = [];
  const fm = new Map(); // TFile -> frontmatter
  for (const [name, f] of Object.entries(classes)) {
    const file = new TFile(`Classes/${name}.md`);
    files.set(file.path, { file, text: "" });
    fm.set(file, f);
  }
  const app = {
    trashed,
    files,
    vault: {
      adapter: { basePath: "/vault" },
      getAbstractFileByPath: (p) => files.get(p)?.file ?? (folders.has(p) && p ? new TFolder(p) : null),
      create: async (p, text) => {
        const file = new TFile(p, 1700000000000);
        files.set(p, { file, text });
        return file;
      },
      createFolder: async (p) => folders.add(p),
      read: async (file) => files.get(file.path).text,
      modify: async (file, text) => (files.get(file.path).text = text),
      trash: async (file) => {
        trashed.push(file.path);
        files.delete(file.path);
      },
    },
    metadataCache: { getFileCache: (file) => ({ frontmatter: fm.get(file) ?? {} }), unresolvedLinks: {} },
    // processFrontMatter over the simple "key: value" frontmatter the fake modules write.
    fileManager: {
      processFrontMatter: async (file, fn) => {
        const rec = files.get(file.path);
        const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(rec.text);
        const obj = {};
        for (const line of m[1].split("\n")) {
          const i = line.indexOf(": ");
          if (i > 0) obj[line.slice(0, i)] = line.slice(i + 2);
        }
        fn(obj);
        rec.text = ["---", ...Object.entries(obj).map(([k, v]) => `${k}: ${v}`), "---", m[2]].join("\n");
      },
    },
    workspace: { getActiveFile: () => null },
  };
  return app;
}

// The faked construction modules: render "type: <cls>" plus the values, the way flow does, and throw on a missing required one.
function fakeModules(app, { required = [], body = "" } = {}) {
  const calls = [];
  const render = async (params, file, cls) => {
    for (const r of required) if (params.variables[r] === undefined) throw new Error(`Class ${cls} needs "${r}" and no variable supplied it`);
    const v = Object.entries(params.variables).filter(([k]) => k !== "_invoked-by" && k !== "destination");
    const text = ["---", `type: ${cls}`, ...v.map(([k, x]) => `${k}: ${x}`), "---", body].join("\n");
    await app.vault.modify(file, await params.quickAddApi.format(text));
  };
  return {
    calls,
    mods: {
      classFile: (a, cls) => a.files.get(`Classes/${cls}.md`)?.file,
      resolvePlacement: async (a, cls) => (cls === "Declared" ? "Declared/Folder" : ""),
      createFromFileclass: async (a, params, name, cls) => {
        calls.push(["createFromFileclass", name, cls]);
        const file = await a.vault.create(`Declared/Folder/${name}.md`, "");
        await render(params, file, cls);
        return file;
      },
      applyFileclass: async (a, params, file, opts) => {
        calls.push(["applyFileclass", file.path, opts.cls]);
        await render(params, file, opts.cls);
      },
    },
  };
}

function setup({ classes = { Declared: { newNotes: [{ folder: "Declared/Folder" }] }, Loose: {} }, allowlist = [], required, body } = {}) {
  const app = fakeApp({ classes });
  const { mods, calls } = fakeModules(app, { required, body });
  const server = fakeServer();
  registerCreateNoteTool(server, app, { getSettings: () => ({ readOnly: false, allowlist }), flowPath: () => "Scripts/flow.js", load: () => mods });
  const call = (args) => server.tools.get(CREATE_NOTE_TOOL).handler(args, {});
  return { app, calls, call, def: server.tools.get(CREATE_NOTE_TOOL).def };
}
const errText = (r) => r.content[0].text;

describe("obsidian_create_note", () => {
  test("with a folder: creates the note, renders it through applyFileclass, fills {{DATE}}, returns path and rev", async () => {
    const { app, call, calls } = setup({ body: "made {{DATE:YYYY-MM-DD}}" });
    const r = await call({ class: "Loose", title: "My note", folder: "Notes/Here/", values: { session: "[worker-OB-pro] x" } });
    assert.notEqual(r.isError, true, errText(r));
    assert.equal(r.structuredContent.path, "Notes/Here/My note.md");
    assert.equal(r.structuredContent.created, true);
    assert.equal(typeof r.structuredContent.rev, "number");
    assert.deepEqual(r.structuredContent.files, ["Notes/Here/My note.md"]);
    assert.deepEqual(calls[0], ["applyFileclass", "Notes/Here/My note.md", "Loose"]);
    const text = app.files.get("Notes/Here/My note.md").text;
    assert.match(text, /^---\ntype: Loose\nsession: \[worker-OB-pro\] x\n---\nmade 2026-10-12$/);
  });
  test("without a folder: the class's declared folder, through createFromFileclass", async () => {
    const { call, calls } = setup();
    const r = await call({ class: "Declared", title: "N" });
    assert.equal(r.structuredContent.path, "Declared/Folder/N.md");
    assert.deepEqual(calls[0], ["createFromFileclass", "N", "Declared"]);
  });
  test("a class that declares no folder needs `folder`: never the active note's folder", async () => {
    const { app, call } = setup();
    const r = await call({ class: "Loose", title: "N" });
    assert.equal(r.isError, true);
    assert.match(errText(r), /declares no folder.*pass `folder`/);
    assert.equal([...app.files.keys()].filter((p) => !p.startsWith("Classes/")).length, 0);
  });
  test("the title falls back to values.title; no title at all is refused", async () => {
    const { call } = setup();
    assert.equal((await call({ class: "Loose", folder: "F", values: { title: "From values" } })).structuredContent.path, "F/From values.md");
    assert.match(errText(await call({ class: "Loose", folder: "F" })), /needs a name/);
  });
  test("a missing required value: refused by name, and the empty new file is removed", async () => {
    const { app, call } = setup({ required: ["session"] });
    const r = await call({ class: "Loose", title: "N", folder: "F" });
    assert.equal(r.isError, true);
    assert.match(errText(r), /Error \[create_failed\].*needs "session"/);
    assert.equal(app.files.has("F/N.md"), false);
    assert.deepEqual(app.trashed, ["F/N.md"]);
  });
  test("a token the tool cannot fill is refused and the note removed", async () => {
    const { app, call } = setup({ body: "x {{TIME}}" });
    const r = await call({ class: "Loose", title: "N", folder: "F" });
    assert.match(errText(r), /left a token this tool cannot fill: \{\{TIME\}\}/);
    assert.equal(app.files.has("F/N.md"), false);
  });
  test("an existing note at the path is refused, untouched", async () => {
    const { app, call } = setup();
    await app.vault.create("F/N.md", "keep me");
    const r = await call({ class: "Loose", title: "N", folder: "F" });
    assert.match(errText(r), /Error \[already_exists\]/);
    assert.equal(app.files.get("F/N.md").text, "keep me");
  });
  test("acceptance and verified records cannot be set through values", async () => {
    const { call } = setup();
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F", values: { "accepted-by": "me" } })), /Error \[accept_forbidden\]/);
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F", values: { verified: "x" } })), /Error \[accept_forbidden\].*verified/);
  });
  test("a computed path outside the allowlist is refused", async () => {
    const { call } = setup({ allowlist: ["Allowed"] });
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "Elsewhere" })), /Error \[out_of_allowlist\]/);
  });
  test("an unknown class is refused", async () => {
    const { call } = setup();
    assert.match(errText(await call({ class: "Nope", title: "N", folder: "F" })), /No fileclass 'Nope'/);
  });
  test("a name Obsidian Sync refuses is refused", async () => {
    const { call } = setup();
    assert.match(errText(await call({ class: "Loose", title: "a: b", folder: "F" })), /Error \[unsafe_name\]/);
  });
  test("`frontmatter` adds keys the template does not write", async () => {
    const { app, call } = setup();
    const r = await call({ class: "Loose", title: "N", folder: "F", frontmatter: { session: "[worker-OB-pro] x", "session-id": "abc" } });
    assert.notEqual(r.isError, true, errText(r));
    assert.match(app.files.get("F/N.md").text, /session: \[worker-OB-pro\] x\nsession-id: abc/);
  });
  test("`frontmatter` may not set a key the template wrote (the note is removed), nor the class key, nor acceptance", async () => {
    const { app, call } = setup();
    const r = await call({ class: "Loose", title: "N", folder: "F", values: { status: "a" }, frontmatter: { status: "b" } });
    assert.match(errText(r), /Error \[create_failed\].*'status'/);
    assert.equal(app.files.has("F/N.md"), false);
    assert.match(errText(await call({ class: "Loose", title: "N2", folder: "F", frontmatter: { type: "Invented" } })), /may not set 'type'/);
    assert.match(errText(await call({ class: "Loose", title: "N3", folder: "F", frontmatter: { verified: "x" } })), /Error \[accept_forbidden\]/);
  });
  test("an argument the tool does not name is refused by the schema", () => {
    const { def } = setup();
    assert.throws(() => def.inputSchema.parse({ class: "Loose", title: "N", type: "Invented" }), /Unrecognized key/);
  });
});

describe("helpers", () => {
  test("fillDates fills bare and formatted {{DATE}}", () => {
    const now = () => ({ format: (f) => `<${f}>` });
    assert.equal(fillDates("a {{DATE}} b {{DATE:YYYY-MM-DDTHH:mm}}", now), "a <YYYY-MM-DD> b <YYYY-MM-DDTHH:mm>");
  });
  test("notePath joins folder and title, root when the folder is empty", () => {
    assert.equal(notePath("A/B/", "N"), "A/B/N.md");
    assert.equal(notePath("", "N"), "N.md");
  });
});

describe("the Sync guard targets the note obsidian_create_note names", () => {
  const NOW = 1_800_000_000_000;
  const state = (pending) => ({ state: "fields", fields: { ready: true, error: false, pause: false, syncStatus: "Indexing...", pendingPaths: pending, socketOpen: true, lastMessageTs: NOW - 1000 } });
  const deps = (s) => ({ settings: normalizeSyncGuard({ enabled: true, waitSeconds: 0 }), read: () => s, now: () => NOW, sleep: async () => {} });
  test("with a folder: only a change waiting at that note or folder counts", async () => {
    const args = { class: "Loose", title: "N", folder: "F" };
    assert.equal(await decideSync("obsidian_create_note", args, deps(state(["Other/x.md"]))), null);
    assert.equal((await decideSync("obsidian_create_note", args, deps(state(["F"])))).refuse.code, "sync_behind");
  });
  test("without a folder (class placement): every pending change counts", async () => {
    const d = await decideSync("obsidian_create_note", { class: "Declared", title: "N" }, deps(state(["Other/x.md"])));
    assert.equal(d.refuse.code, "sync_behind");
  });
});
