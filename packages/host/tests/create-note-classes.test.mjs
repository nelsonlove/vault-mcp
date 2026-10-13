// obsidian_create_note against the vault's REAL classes (#537): the real flow.js and
// fileclass-render.js, required from the vault, render the real 00.10 class files.
// The app is a read-only stand-in built from those files on disk: nothing is written
// to the vault, and the tool's one write lands in a map. Each note is checked with a
// real YAML reader (Ruby's), because the test stub's parseYaml is deliberately small.
// Skipped when the vault or Ruby is not on this machine.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { installObsidianStub, TFile } from "./obsidian-stub.mjs";
import { fakeServer } from "./fake-server.mjs";

installObsidianStub();
const { registerCreateNoteTool, CREATE_NOTE_TOOL, loadFlowModules } = await import("../src/mcp/tools-create-note.ts");

const VAULT = join(homedir(), "obsidian");
const CLASSES = "00-09 System/00 System management/00.10 Fileclasses";
const FLOW = "00-09 System/00 System management/00.13 Scripts/generated/flow.js";
const hasRuby = (() => {
  try {
    execFileSync("ruby", ["-e", "1"]);
    return true;
  } catch {
    return false;
  }
})();
const skip = !existsSync(join(VAULT, FLOW)) || !existsSync(join(VAULT, CLASSES)) || !hasRuby ? "needs ~/obsidian and ruby" : false;

/** A real YAML reader: Ruby's, with dates kept as text so the offset can be checked. */
function yamlLoad(texts) {
  const out = execFileSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "puts JSON.dump(JSON.parse(STDIN.read).map { |t| begin; YAML.safe_load(t, permitted_classes: [Date, Time]) || {}; rescue => e; {'__error' => e.message}; end })"],
    { input: JSON.stringify(texts) }
  );
  return JSON.parse(String(out));
}

function frontmatterOf(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return m ? m[1] : null;
}

function classApp() {
  const files = new Map(); // vault path -> { file, text, fm }
  const walk = (rel) => {
    for (const name of readdirSync(join(VAULT, rel))) {
      const r = `${rel}/${name}`;
      if (statSync(join(VAULT, r)).isDirectory()) walk(r);
      else if (name.endsWith(".md")) files.set(r, { file: new TFile(r), text: readFileSync(join(VAULT, r), "utf8") });
    }
  };
  walk(CLASSES);
  const list = [...files.values()];
  const parsed = yamlLoad(list.map((f) => frontmatterOf(f.text) ?? ""));
  list.forEach((f, i) => (f.fm = parsed[i]?.__error ? {} : parsed[i]));
  const written = new Map();
  const app = {
    written,
    vault: {
      adapter: { basePath: VAULT },
      getAbstractFileByPath: (p) => files.get(p)?.file ?? written.get(p)?.file ?? null,
      getMarkdownFiles: () => list.map((f) => f.file),
      read: async (file) => files.get(file.path).text,
      cachedRead: async (file) => files.get(file.path).text,
      modify: async () => {
        throw new Error("the real vault.modify must not be reached");
      },
      create: async () => {
        throw new Error("the real vault.create must not be reached");
      },
    },
    metadataCache: { getFileCache: (file) => (files.has(file?.path) ? { frontmatter: files.get(file.path).fm } : null), unresolvedLinks: {} },
    workspace: { getActiveFile: () => null },
    plugins: { plugins: { fileclass: { settings: { fileClassAlias: "type" } } } },
  };
  return app;
}

const errText = (r) => r.content?.[0]?.text ?? "";
const resultOf = (r) => JSON.parse(errText(r));

describe("obsidian_create_note on the vault's real classes (#537)", { skip }, () => {
  let app;
  let call;
  before(() => {
    globalThis.window = { require: createRequire(join(VAULT, FLOW)) };
    app = classApp();
    const server = fakeServer();
    registerCreateNoteTool(server, app, {
      getSettings: () => ({ readOnly: false, allowlist: [] }),
      flowPath: () => FLOW,
      load: loadFlowModules,
      writeNote: async (p, content) => {
        if (app.written.has(p)) throw new Error(`exists: ${p}`);
        app.written.set(p, { file: new TFile(p), text: content });
        return { path: p, created: true };
      },
    });
    call = (args) => server.tools.get(CREATE_NOTE_TOOL).handler({ folder: "Scratch", ...args });
  });

  const OFFSET = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/;
  const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  /** Create, then check: it parses, carries the class, a uid, created and modified with an offset, and drops no value. */
  async function make(cls, title, values = {}, frontmatter, where = {}) {
    const r = await call({ class: cls, title, values, ...(frontmatter ? { frontmatter } : {}) });
    assert.ok(!r.isError, `${cls}: ${errText(r)}`);
    const res = resultOf(r);
    const text = app.written.get(res.path).text;
    const fmText = frontmatterOf(text);
    assert.ok(fmText !== null, `${cls}: no frontmatter`);
    const [fm] = yamlLoad([fmText]);
    assert.equal(fm.__error, undefined, `${cls}: frontmatter does not parse: ${fm.__error}\n${fmText}`);
    assert.equal(fm.type, cls, `${cls}: type`);
    assert.equal(fm.title, title, `${cls}: title`);
    assert.match(String(fm.uid), UUID7, `${cls}: uid`);
    for (const k of ["created", "modified"]) {
      const line = fmText.split("\n").find((l) => l.startsWith(`${k}:`));
      assert.ok(line, `${cls}: no ${k}`);
      assert.match(line.slice(k.length + 1).trim(), OFFSET, `${cls}: ${k} has no offset`);
    }
    const body = text.slice(text.indexOf("\n---\n", 4) + 5);
    const unused = res.unused_values ?? [];
    for (const [k, v] of Object.entries(values)) {
      // Where the value must be: its own key, unless the class puts it in the body or under another key on purpose.
      const at = where[k];
      const kept =
        unused.includes(k) ||
        (at === "body" ? body.includes(String(v)) : Array.isArray(at) ? at.reduce((o, x) => o?.[x], fm) === v : fm[k] === v);
      assert.ok(kept, `${cls}: values.${k} was dropped without a word\n${text}`);
    }
    for (const [k, v] of Object.entries(frontmatter ?? {})) assert.deepEqual(fm[k], v, `${cls}: frontmatter.${k}`);
    assert.ok(!/\{\{|vmcp[vt]/.test(text), `${cls}: a token or a stand-in was left\n${text}`);
    return { text, fm, body, res, keys: fmText.split("\n").filter((l) => /^[^\s#-][^:]*:/.test(l)).map((l) => l.slice(0, l.indexOf(":"))) };
  }

  /** The keys after Global's six, in order (#543). */
  const classKeys = (keys) => keys.filter((k) => !["title", "description", "type", "created", "modified", "uid"].includes(k));

  test("Task", async () => {
    const { fm, body } = await make("Task", "Case Task", { description: "a task", status: "stable/open", priority: "normal", outcome: "it is done" }, undefined, { outcome: "body" });
    assert.equal(fm.status, "stable/open");
    assert.match(body, /it is done/);
  });

  test("Note, with ': ' and '#' in a value", async () => {
    const { fm } = await make("Note", "Case Note", { description: "Quote test: a colon here: and a hash #tag inside" });
    assert.equal(fm.description, "Quote test: a colon here: and a hash #tag inside");
  });

  test("Meta/Panel keeps description, created and modified, and no fixed date", async () => {
    const { fm, body } = await make("Meta/Panel", "Case Panel", { description: "A panel: for the test" });
    assert.equal(fm.description, "A panel: for the test");
    assert.match(body, /\*A panel: for the test\*/);
    assert.ok(!body.includes("2026-09-27 — Created."), "the template's fixed History date");
  });

  test("Meta/Slot keeps slot \"99\" a string", async () => {
    const { fm } = await make("Meta/Slot", "Case Slot", { slot: "99", description: "a slot" });
    assert.equal(fm.slot, "99");
    assert.equal(fm.description, "a slot");
  });

  test("Task/AgentTask with projects and blockedBy; outcome is reported, not dropped", async () => {
    const { res } = await make(
      "Task/AgentTask",
      "Case AgentTask",
      { description: "an agent task", priority: "normal", "generated-by": "[worker-OB-pro] test", outcome: "done when tested" },
      { projects: ["[[Some project]]"], blockedBy: ["[[Another task]]"] },
      { "generated-by": ["generated", "by"] }
    );
    assert.deepEqual(res.unused_values, ["outcome"]);
    assert.match(res.warning, /"outcome"/);
  });

  test("#543: Task/AgentTask keeps the template's key order (parent, then child) and its comment under the H1", async () => {
    const { keys, body } = await make(
      "Task/AgentTask",
      "Case AgentTask order",
      { description: "an agent task", priority: "normal", "generated-by": "[worker-OB-pro] test" },
      { projects: ["[[Some project]]"] },
      { "generated-by": ["generated", "by"] }
    );
    assert.deepEqual(keys.slice(0, 6), ["title", "description", "type", "created", "modified", "uid"]);
    assert.deepEqual(classKeys(keys), ["status", "priority", "needs", "generated", "projects"]);
    assert.match(body, /^# Case AgentTask order\n\n%% Rule links: [^\n]*%%\n\n## Ask/m, body);
  });

  test("#543: Task/Decision keeps the key order and the comment", async () => {
    const { keys, body } = await make(
      "Task/Decision",
      "Case Decision order",
      { description: "a decision", priority: "normal", "generated-by": "[worker-OB-pro] test", context: "why" },
      undefined,
      { "generated-by": ["generated", "by"], context: "body" }
    );
    assert.deepEqual(classKeys(keys), ["status", "priority", "needs", "generated"]);
    assert.match(body, /^# Case Decision order\n\n%% Rule links: [^\n]*%%\n/m, body);
  });

  test("#543: Project writes needs before outcome (Task's keys, then Project's), and a placed gain last", async () => {
    const { keys } = await make("Project", "Case Project order", { description: "p", status: "stable/open", priority: "normal", outcome: "shipped", gain: "less" });
    assert.deepEqual(classKeys(keys), ["status", "priority", "needs", "outcome", "gain"]);
  });

  test("Task/Decision", async () => {
    const { res } = await make("Task/Decision", "Case Decision", { description: "a decision", priority: "normal", "generated-by": "[worker-OB-pro] test", context: "why we ask", outcome: "ruled" }, undefined, { "generated-by": ["generated", "by"], context: "body" });
    assert.deepEqual(res.unused_values, ["outcome"]);
  });

  test("Project with gain: placed where the class declares it", async () => {
    const { fm, res } = await make("Project", "Case Project", { description: "a project", status: "stable/open", priority: "normal", outcome: "shipped", gain: "less waiting" });
    assert.equal(fm.gain, "less waiting");
    assert.equal(fm.outcome, "shipped");
    assert.equal(res.unused_values, undefined);
  });

  test("Event/AgentNotebookEntry with session, session-id and reports-to", async () => {
    const fmIn = { session: "[manager-OB-pro] vault-mcp", "session-id": "45419354-d7c6-47c7-ada7-5658a56a454f", "reports-to": "[lead-OB-pro] obsidian" };
    const { fm, body } = await make("Event/AgentNotebookEntry", "Agent session 2026-10-13T1200 case", { description: "a session" }, fmIn);
    assert.deepEqual([].concat(fm.tags ?? []), ["agent/session"]);
    assert.ok(!body.includes("<stamp>"), "the literal <stamp>");
    assert.match(body, /^Log read through/m);
  });

  test("every missing blank is named in one refusal", async () => {
    const r = await call({ class: "Task", title: "Case Missing" });
    assert.ok(r.isError);
    for (const name of ["description", "status", "priority", "outcome"]) assert.match(errText(r), new RegExp(`"${name}"`));
  });

  test("a duplicate title is refused", async () => {
    await make("Note", "Case Twice", { description: "first" });
    const r = await call({ class: "Note", title: "Case Twice", values: { description: "second" } });
    assert.match(errText(r), /Error \[already_exists\]/);
  });

  test("an unknown class is refused", async () => {
    const r = await call({ class: "No/Such/Class", title: "Case Unknown" });
    assert.match(errText(r), /Error \[invalid_argument\]: No fileclass/);
  });
});
