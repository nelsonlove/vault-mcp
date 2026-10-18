// .base and .canvas files (#575): the validation both servers run before a write, the keyed edit,
// and the file-system backend's three methods over a temp vault. The values are made up.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFilePath, validateFileContent, applyFileEdit, fileKindOf, FILE_TOOL_NAMES, registerFileTools, resolveProfile } from "../src/index.ts";
import { FilesystemBackend } from "../src/fs-backend/filesystem-backend.ts";

const BASE = "# made-up base\nfilters:\n  and:\n    - file.ext == \"md\"\nviews:\n  - type: table\n    name: Table # main\n    order: [file.name, status]\n  - type: cards\n    name: Cards\n";
const CANVAS = JSON.stringify({ nodes: [{ id: "a", type: "text", text: "A", x: 0, y: 0, width: 1, height: 1 }, { id: "b", type: "text", text: "B", x: 0, y: 0, width: 1, height: 1 }], edges: [{ id: "ab", fromNode: "a", toNode: "b" }, { id: "ba", fromNode: "b", toNode: "a" }] }, null, 2) + "\n";

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

describe("which paths these tools write", () => {
  test("only .base and .canvas, exact lower-case extensions", () => {
    assert.equal(fileKindOf("A/B.base"), "base");
    assert.equal(fileKindOf("A/B.canvas"), "canvas");
    for (const p of ["A/B.md", "A/B.BASE", "A/B.base.md", "A/B.json", "A/B"]) assert.equal(code(() => assertFilePath(p)), "unsupported_file", p);
  });
  test("no hidden folder or name, no empty, '.' or '..' segment", () => {
    for (const p of [".obsidian/x.base", "A/.trash/x.canvas", "A/.base", "A//x.base", "./x.base", "A/../x.canvas", "/x.base"]) assert.equal(code(() => assertFilePath(p)), "unsupported_file", p);
    assert.equal(assertFilePath("Projects 2026/Board one.canvas"), "canvas");
  });
});

describe("validation before a write", () => {
  test("a .base must be one YAML mapping, with views a list of mappings when present", () => {
    assert.equal(validateFileContent("x.base", BASE), "base");
    assert.equal(validateFileContent("x.base", "{}"), "base");
    for (const bad of ["", "# only a comment\n", "- a\n- b\n", "just text\n", "a: [\n", "a: 1\na: 2\n", "a: 1\n---\nb: 2\n", "views: Table\n", "views:\n  - Table\n"]) {
      assert.equal(code(() => validateFileContent("x.base", bad)), "invalid_file", JSON.stringify(bad));
    }
  });
  test("a .canvas must be a JSON object; nodes and edges, when present, arrays of objects with unique string ids", () => {
    assert.equal(validateFileContent("x.canvas", CANVAS), "canvas");
    assert.equal(validateFileContent("x.canvas", "{}"), "canvas");
    for (const bad of ["", "[]", "null", "{nodes: []}", '{"nodes": {}}', '{"edges": "x"}', '{"nodes": [1]}', '{"nodes": [{"type": "text"}]}', '{"nodes": [{"id": ""}]}', '{"nodes": [{"id": "a"}, {"id": "a"}]}']) {
      assert.equal(code(() => validateFileContent("x.canvas", bad)), "invalid_file", bad);
    }
  });
});

describe("the keyed edit", () => {
  test("upsert_view replaces by name, keeps comments and the other view; adds when absent; renames by key", () => {
    let { text, result } = applyFileEdit("x.base", BASE, { op: "upsert_view", item: JSON.stringify({ type: "cards", name: "Cards", limit: 5 }) });
    assert.deepEqual(result, { op: "upsert_view", key: "Cards", found: true, action: "replaced" });
    assert.match(text, /^# made-up base\n/);
    assert.match(text, /name: Table # main\n    order: \[ file\.name, status \]|name: Table # main\n    order: \[file\.name, status\]/);
    assert.match(text, /limit: 5/);
    ({ text, result } = applyFileEdit("x.base", BASE, { op: "upsert_view", item: "type: list\nname: List\n" }));
    assert.equal(result.action, "added");
    assert.match(text, /name: List/);
    ({ text, result } = applyFileEdit("x.base", BASE, { op: "upsert_view", key: "Cards", item: JSON.stringify({ type: "cards", name: "Gallery" }) }));
    assert.equal(result.action, "replaced");
    assert.doesNotMatch(text, /name: Cards/);
    assert.equal(code(() => applyFileEdit("x.base", BASE, { op: "upsert_view", key: "Cards", item: JSON.stringify({ type: "cards", name: "Table" }) })), "invalid_edit", "a rename onto another view's name");
    ({ text } = applyFileEdit("x.base", "filters: {}\n", { op: "upsert_view", item: JSON.stringify({ type: "table", name: "T" }) }));
    assert.match(text, /views:\n  - type: table\n    name: T/);
  });
  test("remove_view; a missing view is found: false with no text; two views of one name are refused", () => {
    const { text, result } = applyFileEdit("x.base", BASE, { op: "remove_view", key: "Table" });
    assert.equal(result.action, "removed");
    assert.doesNotMatch(text, /name: Table/);
    assert.deepEqual(applyFileEdit("x.base", BASE, { op: "remove_view", key: "Nope" }), { text: null, result: { op: "remove_view", key: "Nope", found: false } });
    const twice = "views:\n  - name: A\n  - name: A\n";
    assert.equal(code(() => applyFileEdit("x.base", twice, { op: "remove_view", key: "A" })), "invalid_edit");
  });
  test("canvas: upsert and remove nodes and edges by id; removing a node removes its edges; indentation is kept", () => {
    let { text, result } = applyFileEdit("x.canvas", CANVAS, { op: "remove_node", key: "a" });
    assert.deepEqual(result.edges_removed, ["ab", "ba"]);
    assert.deepEqual(JSON.parse(text).edges, []);
    assert.match(text, /^\{\n  "nodes"/);
    assert.ok(text.endsWith("}\n"));
    ({ text, result } = applyFileEdit("x.canvas", CANVAS, { op: "upsert_node", item: JSON.stringify({ id: "c", type: "text", text: "C", x: 1, y: 1, width: 1, height: 1 }) }));
    assert.equal(result.action, "added");
    assert.deepEqual(JSON.parse(text).nodes.map((n) => n.id), ["a", "b", "c"]);
    ({ result } = applyFileEdit("x.canvas", CANVAS, { op: "upsert_edge", key: "ab", item: JSON.stringify({ id: "ab", fromNode: "a", toNode: "b", label: "x" }) }));
    assert.equal(result.action, "replaced");
    assert.equal(code(() => applyFileEdit("x.canvas", CANVAS, { op: "upsert_node", key: "z", item: JSON.stringify({ id: "a" }) })), "invalid_edit", "key and id differ");
    assert.equal(code(() => applyFileEdit("x.canvas", CANVAS, { op: "upsert_node", item: "{oops" })), "invalid_file");
    assert.equal(code(() => applyFileEdit("x.canvas", CANVAS, { op: "upsert_view", item: "{}" })), "invalid_edit", "a base op on a canvas");
    assert.equal(code(() => applyFileEdit("x.canvas", CANVAS, { op: "remove_node" })), "invalid_edit", "a remove needs a key");
    assert.equal(code(() => applyFileEdit("x.canvas", "{\"nodes\": 1}", { op: "remove_node", key: "a" })), "invalid_file", "the file must parse before an edit");
    const compact = JSON.stringify({ nodes: [{ id: "a" }] });
    ({ text } = applyFileEdit("x.canvas", compact, { op: "upsert_edge", item: JSON.stringify({ id: "e", fromNode: "a", toNode: "a" }) }));
    assert.equal(text.includes("\n"), false, "a one-line canvas stays one line");
  });
});

describe("the file-system backend", () => {
  async function vault(files = {}) {
    const root = await mkdtemp(join(tmpdir(), "file-formats-"));
    for (const [p, t] of Object.entries(files)) {
      await mkdir(join(root, p, ".."), { recursive: true });
      await writeFile(join(root, p), t);
    }
    return { root, backend: new FilesystemBackend(root), read: (p) => readFile(join(root, p), "utf8"), exists: (p) => access(join(root, p)).then(() => true, () => false) };
  }
  test("writeFile creates, refuses an existing file without overwrite, refuses invalid content with nothing written", async () => {
    const v = await vault();
    assert.deepEqual(await v.backend.writeFile("B/T.base", BASE, false), { path: "B/T.base", created: true });
    await assert.rejects(v.backend.writeFile("B/T.base", BASE, false), /already exists/);
    await assert.rejects(v.backend.writeFile("B/T.base", "a: [", true), (e) => e.code === "invalid_file");
    assert.equal(await v.read("B/T.base"), BASE);
    await assert.rejects(v.backend.writeFile("B/N.canvas", "[]", false), (e) => e.code === "invalid_file");
    assert.equal(await v.exists("B/N.canvas"), false);
    await assert.rejects(v.backend.writeFile("B/a:b.canvas", "{}", false), (e) => e.code === "unsafe_name");
    await assert.rejects(v.backend.writeFile(".obsidian/x.base", "a: 1\n", false), (e) => e.code === "unsupported_file");
  });
  test("editFile edits in place; a missing item writes nothing", async () => {
    const v = await vault({ "B/P.canvas": CANVAS });
    const r = await v.backend.editFile("B/P.canvas", { op: "remove_edge", key: "ab" });
    assert.equal(r.found, true);
    assert.deepEqual(JSON.parse(await v.read("B/P.canvas")).edges.map((e) => e.id), ["ba"]);
    const before = await v.read("B/P.canvas");
    assert.equal((await v.backend.editFile("B/P.canvas", { op: "remove_edge", key: "zz" })).found, false);
    assert.equal(await v.read("B/P.canvas"), before);
  });
  test("moveFile renames, keeps the extension, refuses an existing destination, and says it rewrote no links", async () => {
    const v = await vault({ "B/P.canvas": CANVAS, "B/Q.canvas": CANVAS, "N/Index.md": "[[P.canvas]]\n" });
    await assert.rejects(v.backend.moveFile("B/P.canvas", "B/P.base", { update_backlinks: true, overwrite: false }), /does not keep the extension/);
    await assert.rejects(v.backend.moveFile("B/P.canvas", "B/Q.canvas", { update_backlinks: true, overwrite: false }), /already exists/);
    const r = await v.backend.moveFile("B/P.canvas", "C/P2.canvas", { update_backlinks: true, overwrite: false });
    assert.equal(r.backlinks_updated, 0);
    assert.match(r.links_note, /does not rewrite links/);
    assert.equal(await v.read("C/P2.canvas"), CANVAS);
    assert.equal(await v.exists("B/P.canvas"), false);
    assert.equal(await v.read("N/Index.md"), "[[P.canvas]]\n", "the note's link is left as it was");
  });
  test("the file-system backend's permanent delete stays notes-only", async () => {
    const v = await vault({ "B/P.canvas": CANVAS });
    await assert.rejects(v.backend.deleteNote("B/P.canvas", true), /must end in \.md/);
    assert.equal(await v.exists("B/P.canvas"), true);
  });
});

describe("registerFileTools", () => {
  const fakeServer = () => {
    const tools = new Map();
    return { tools, registerTool(name, def, handler) { tools.set(name, { def, handler }); } };
  };
  test("registers the three tools, strict, as writes; a profile that does not list them registers none", () => {
    const s = fakeServer();
    registerFileTools(s, {});
    assert.deepEqual([...s.tools.keys()], [...FILE_TOOL_NAMES]);
    for (const { def } of s.tools.values()) {
      assert.equal(def.annotations.readOnlyHint, false);
      assert.equal(def.inputSchema._def.unknownKeys, "strict");
    }
    for (const name of ["read", "read+inbox", "read+message", "none", "made-up"]) {
      const p = fakeServer();
      registerFileTools(p, {}, { profile: resolveProfile(name) });
      assert.equal(p.tools.size, 0, name);
    }
    const full = fakeServer();
    registerFileTools(full, {}, { profile: resolveProfile("full") });
    assert.equal(full.tools.size, 3);
  });
  test("kernelArgs names if_rev, idempotency_key and intent (the file-system server accepts them)", () => {
    const s = fakeServer();
    registerFileTools(s, {}, { kernelArgs: true });
    for (const { def } of s.tools.values()) for (const k of ["if_rev", "idempotency_key", "intent"]) assert.ok(def.inputSchema.shape[k], k);
    const w = s.tools.get("obsidian_write_file").def.inputSchema.safeParse({ path: "a.base", content: "a: 1\n", if_rev: 1, idempotency_key: "k", intent: "why" });
    assert.equal(w.success, true, JSON.stringify(w.error?.issues));
  });
});
