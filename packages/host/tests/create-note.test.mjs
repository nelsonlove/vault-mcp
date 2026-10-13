// obsidian_create_note (#531): a note of a class, rendered through the vault's
// own flow.applyFileclass into a stand-in, checked, then written once through
// the host's guarded create. The vault's modules are faked (`load`); the
// handler, its render view, its checks and its single write are the real ones.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile, TFolder } from "./obsidian-stub.mjs";
import { fakeServer } from "./fake-server.mjs";

installObsidianStub();
const { registerCreateNoteTool, CREATE_NOTE_TOOL, fillDates, notePath, renderView } = await import("../src/mcp/tools-create-note.ts");
const { decideSync, normalizeSyncGuard } = await import("../src/kernel/sync-guard.ts");

function fakeApp() {
  const files = new Map(); // path -> { file, text }
  const writes = [];
  const app = {
    files,
    writes,
    vault: {
      adapter: { basePath: "/vault" },
      getAbstractFileByPath: (p) => files.get(p)?.file ?? null,
      read: async (file) => files.get(file.path).text,
      cachedRead: async (file) => files.get(file.path).text,
      modify: async () => {
        throw new Error("the real vault.modify must not be reached during a render");
      },
      create: async () => {
        throw new Error("the real vault.create must not be reached: writes go through ctx.writeNote");
      },
    },
    metadataCache: { getFileCache: () => ({ frontmatter: {} }), unresolvedLinks: {} },
    workspace: { getActiveFile: () => new TFile("Open/Note.md") },
  };
  return app;
}

// The faked modules: render "type: <cls>" plus the values (as flow does), into the note through app.vault.modify.
function fakeModules({ required = [], body = "", fmLines = [], type } = {}) {
  const seen = { applyApps: [], placementActive: [] };
  return {
    seen,
    mods: {
      hasClass: (a, cls) => cls === "Declared" || cls === "Loose" || cls === "Two",
      resolvePlacement: async (view, cls, params, opts) => {
        // The module's human fallback is the active note's folder; the view must hide it.
        seen.placementActive.push(view.workspace.getActiveFile());
        if (cls === "Declared") return "Declared/Folder";
        if (cls === "Two") {
          if (!opts.destination) throw new Error("Two declares 2 destinations and none was chosen.");
          return opts.destination === "A" ? "Two/A" : "Two/B";
        }
        return view.workspace.getActiveFile()?.path?.split("/").slice(0, -1).join("/") ?? "";
      },
      applyFileclass: async (view, params, note, opts) => {
        seen.applyApps.push(view);
        for (const r of required) if (params.variables[r] === undefined) throw new Error(`Class ${opts.cls} needs "${r}" and no variable supplied it`);
        const v = Object.entries(params.variables).filter(([k]) => k !== "_invoked-by" && k !== "destination");
        const text = ["---", `type: ${type ?? opts.cls}`, ...v.map(([k, x]) => `${k}: ${x}`), ...fmLines, "---", body].join("\n");
        await view.vault.modify(note, await params.quickAddApi.format(text));
      },
    },
  };
}

function setup({ allowlist = [], ...mod } = {}) {
  const app = fakeApp();
  const { mods, seen } = fakeModules(mod);
  const server = fakeServer();
  registerCreateNoteTool(server, app, {
    getSettings: () => ({ readOnly: false, allowlist }),
    flowPath: () => "Scripts/flow.js",
    load: () => mods,
    writeNote: async (p, content) => {
      if (app.files.has(p)) throw new Error(`exists (set overwrite=true to replace): ${p}`);
      app.files.set(p, { file: new TFile(p, 1700000000000), text: content });
      app.writes.push(p);
      return { path: p, created: true };
    },
    revOf: (p) => app.files.get(p)?.file.stat.mtime,
  });
  const call = (args) => server.tools.get(CREATE_NOTE_TOOL).handler(args, {});
  return { app, seen, call, def: server.tools.get(CREATE_NOTE_TOOL).def };
}
const errText = (r) => r.content[0].text;

describe("obsidian_create_note: render, check, write once", () => {
  test("with a folder: rendered through applyFileclass in a view, {{DATE}} filled, written once through writeNote", async () => {
    const { app, call } = setup({ body: "made {{DATE:YYYY-MM-DD}}" });
    const r = await call({ class: "Loose", title: "My note", folder: "Notes/Here/", values: { description: "a note" } });
    assert.notEqual(r.isError, true, errText(r));
    assert.equal(r.structuredContent.path, "Notes/Here/My note.md");
    assert.equal(r.structuredContent.rev, 1700000000000);
    assert.deepEqual(app.writes, ["Notes/Here/My note.md"]);
    assert.equal(app.files.get("Notes/Here/My note.md").text, "---\ntype: Loose\ndescription: a note\n---\nmade 2026-10-12");
  });
  test("without a folder: the class's declared folder", async () => {
    const { call } = setup();
    assert.equal((await call({ class: "Declared", title: "N" })).structuredContent.path, "Declared/Folder/N.md");
  });
  test("the module never sees the active note: a class with no folder is refused, never placed beside the open note", async () => {
    const { app, seen, call } = setup();
    const r = await call({ class: "Loose", title: "N" });
    assert.match(errText(r), /declares no folder.*pass `folder`/);
    assert.deepEqual(seen.placementActive, [null]);
    assert.equal(app.writes.length, 0);
  });
  test("several destinations: `destination` chooses; none given is refused by the module's message", async () => {
    const { call } = setup();
    assert.equal((await call({ class: "Two", title: "N", destination: "A" })).structuredContent.path, "Two/A/N.md");
    assert.match(errText(await call({ class: "Two", title: "N" })), /none was chosen/);
  });
  test("a missing required value: refused by name, nothing written", async () => {
    const { app, call } = setup({ required: ["session"] });
    const r = await call({ class: "Loose", title: "N", folder: "F" });
    assert.match(errText(r), /Error \[create_failed\].*needs "session".*Nothing was written/);
    assert.equal(app.writes.length, 0);
  });
  test("a token the tool cannot fill: refused, nothing written", async () => {
    const { app, call } = setup({ body: "x {{TIME}}" });
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F" })), /cannot fill: \{\{TIME\}\}/);
    assert.equal(app.writes.length, 0);
  });
  test("a value with a line break or '{{' is refused before rendering", async () => {
    const { app, call } = setup();
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F", values: { description: "x\nverified: 2026" } })), /line break/);
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F", values: { description: "a {{TITLE}}" } })), /line break or '\{\{'/);
    assert.equal(app.writes.length, 0);
  });
  test("the RENDERED result is checked: acceptance or verified from the template is refused", async () => {
    const a = setup({ fmLines: ["accepted-by: someone"] });
    assert.match(errText(await a.call({ class: "Loose", title: "N", folder: "F" })), /Error \[accept_forbidden\]/);
    const b = setup({ fmLines: ["verified: x"] });
    assert.match(errText(await b.call({ class: "Loose", title: "N", folder: "F" })), /Error \[accept_forbidden\].*verified/);
    assert.equal(a.app.writes.length + b.app.writes.length, 0);
  });
  test("the rendered note must carry the class", async () => {
    const { call } = setup({ type: "Something/Else" });
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F" })), /does not carry the class 'Loose'/);
  });
  test("an existing note at the path is refused and untouched; a race at the write is refused, not trashed", async () => {
    const { app, call } = setup();
    app.files.set("F/N.md", { file: new TFile("F/N.md"), text: "keep me" });
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F" })), /Error \[already_exists\]/);
    assert.equal(app.files.get("F/N.md").text, "keep me");
  });
  test("acceptance and verified cannot be set through values or frontmatter", async () => {
    const { call } = setup();
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F", values: { "accepted-by": "me" } })), /Error \[accept_forbidden\]/);
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F", frontmatter: { verified: "x" } })), /Error \[accept_forbidden\]/);
  });
  test("titles and folders that would escape the computed path are refused", async () => {
    const { call } = setup();
    assert.match(errText(await call({ class: "Loose", title: "sub/x", folder: "F" })), /names a folder/);
    assert.match(errText(await call({ class: "Loose", title: "x.md", folder: "F" })), /ends in \.md/);
    assert.match(errText(await call({ class: "Loose", title: "x", folder: "uid:019f" })), /plain vault-relative folder/);
    assert.match(errText(await call({ class: "Loose", title: "x", folder: "A/../B" })), /plain vault-relative folder/);
  });
  test("a computed path outside the allowlist is refused", async () => {
    const { call } = setup({ allowlist: ["Allowed"] });
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "Elsewhere" })), /Error \[out_of_allowlist\]/);
    assert.match(errText(await call({ class: "Declared", title: "N" })), /Error \[out_of_allowlist\]/);
  });
  test("an unknown class and an unsafe name are refused", async () => {
    const { call } = setup();
    assert.match(errText(await call({ class: "Nope", title: "N", folder: "F" })), /No fileclass 'Nope'/);
    assert.match(errText(await call({ class: "Loose", title: "a: b", folder: "F" })), /Error \[unsafe_name\]/);
  });
  test("`frontmatter` adds new keys as text, before the closing fence", async () => {
    const { app, call } = setup({ body: "body" });
    const r = await call({ class: "Loose", title: "N", folder: "F", frontmatter: { session: "s1", "session-id": "abc" } });
    assert.notEqual(r.isError, true, errText(r));
    assert.equal(app.files.get("F/N.md").text, "---\ntype: Loose\nsession: s1\nsession-id: abc\n---\nbody");
  });
  test("`frontmatter` may not set a key the template wrote, nor the class key; nothing is written", async () => {
    const { app, call } = setup();
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F", values: { status: "a" }, frontmatter: { status: "b" } })), /already writes/);
    assert.match(errText(await call({ class: "Loose", title: "N", folder: "F", frontmatter: { type: "Invented" } })), /may not set 'type'/);
    assert.equal(app.writes.length, 0);
  });
  test("an argument the tool does not name is refused by the schema", () => {
    const { def } = setup();
    assert.throws(() => def.inputSchema.parse({ class: "Loose", title: "N", type: "Invented" }), /Unrecognized key/);
  });
});

describe("renderView", () => {
  test("captures the stand-in's modify, refuses any other write, hides the active note", async () => {
    const app = fakeApp();
    const stand = {};
    const sink = {};
    const view = renderView(app, stand, sink);
    await view.vault.modify(stand, "text");
    assert.equal(sink.text, "text");
    assert.equal(await view.vault.read(stand), "");
    assert.equal(view.metadataCache.getFileCache(stand), null);
    assert.equal(view.workspace.getActiveFile(), null);
    await assert.rejects(view.vault.modify(new TFile("Other.md"), "x"), /another note/);
    await assert.rejects(view.vault.create("X.md", ""), /tried to create/);
    await assert.rejects(view.vault.trash(new TFile("X.md")), /tried to trash/);
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
