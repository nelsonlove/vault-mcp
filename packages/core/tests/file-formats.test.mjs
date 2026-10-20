// .base and .canvas files (#575): the validation both servers run before a write, the keyed edit,
// and the file-system backend's three methods over a temp vault. The values are made up.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFilePath, validateFileContent, applyFileEdit, fileKindOf, FILE_TOOL_NAMES, registerFileTools, resolveProfile,
  DEFAULT_FILE_MOVE_EXTENSIONS, FILE_MOVE_EXTENSIONS_ENV_VAR, normalizeFileMoveExtensions, parseFileMoveExtensions, assertMovePath, assertMovePair,
} from "../src/index.ts";
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

describe("which files obsidian_move_file moves", () => {
  test("the default list is pinned: images, audio, video, PDF, and docx xlsx pptx odt zip; no script, config or note type", () => {
    assert.deepEqual([...DEFAULT_FILE_MOVE_EXTENSIONS], [
      "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif",
      "mp3", "wav", "m4a", "ogg", "flac", "webm", "3gp",
      "mp4", "mov", "mkv", "ogv",
      "pdf",
      "docx", "xlsx", "pptx", "odt", "zip",
    ]);
    assert.ok(Object.isFrozen(DEFAULT_FILE_MOVE_EXTENSIONS));
    for (const e of ["md", "base", "canvas", "json", "css", "js", "mjs", "ts", "sh", "exe", "app", "html", "docm", "xlsm"]) assert.equal(DEFAULT_FILE_MOVE_EXTENSIONS.includes(e), false, e);
    assert.equal(FILE_MOVE_EXTENSIONS_ENV_VAR, "VAULT_MCP_FILE_MOVE_EXTENSIONS");
  });
  test("the list is normalized: trimmed, no dot, lower case, letters and digits only, no md/base/canvas, no duplicates; not a list ⇒ the default", () => {
    assert.deepEqual(normalizeFileMoveExtensions([" .PDF", "pdf", "Zip", "md", ".base", "canvas", "tar.gz", "a/b", "", 7, "x".repeat(17), "heic"]), ["pdf", "zip", "heic"]);
    assert.deepEqual(normalizeFileMoveExtensions([]), []);
    assert.deepEqual(normalizeFileMoveExtensions(undefined), [...DEFAULT_FILE_MOVE_EXTENSIONS]);
    assert.deepEqual(normalizeFileMoveExtensions("pdf"), [...DEFAULT_FILE_MOVE_EXTENSIONS]);
    assert.deepEqual(parseFileMoveExtensions(undefined), [...DEFAULT_FILE_MOVE_EXTENSIONS]);
    assert.deepEqual(parseFileMoveExtensions(""), []);
    assert.deepEqual(parseFileMoveExtensions("pdf, .ZIP  docx"), ["pdf", "zip", "docx"]);
  });
  test("a path on the list moves, in any case; .base and .canvas always; a note never; anything else is refused", () => {
    const list = ["pdf", "zip"];
    assert.equal(assertMovePath("Inbox/Scan.pdf", list), "pdf");
    assert.equal(assertMovePath("Inbox/Scan.PDF", list), "PDF");
    assert.equal(assertMovePath("Inbox/Bundle 2026.zip", list), "zip");
    assert.equal(assertMovePath("B/T.base", []), "base");
    assert.equal(assertMovePath("B/P.canvas", []), "canvas");
    for (const p of ["Inbox/Scan.pdf", "Inbox/run.exe", "Inbox/x.json", "Inbox/noext", "Inbox/T.BASE"]) assert.equal(code(() => assertMovePath(p, p.endsWith(".pdf") ? [] : list)), "unsupported_file", p);
    for (const p of ["Notes/Plan.md", "Notes/Plan.MD"]) {
      assert.equal(code(() => assertMovePath(p, ["md"])), "unsupported_file", p);
      assert.throws(() => assertMovePath(p, list), /obsidian_move_note/);
    }
    for (const p of [".obsidian/x.pdf", "A/.trash/x.zip", "A/.pdf", "A//x.pdf", "./x.pdf", "A/../x.pdf", "/x.pdf"]) assert.equal(code(() => assertMovePath(p, list), p), "unsupported_file", p);
  });
  test("a move keeps the extension exactly: no change of type, nor of its case", () => {
    const list = ["pdf", "zip", "png"];
    assert.equal(assertMovePair("A/Scan.pdf", "B/Scan 2.pdf", list), undefined);
    for (const [from, to] of [["A/Scan.pdf", "A/Scan.zip"], ["A/Scan.pdf", "A/Scan.PDF"], ["A/Scan.pdf", "A/Scan.pdf.png"], ["A/P.canvas", "A/P.base"]]) {
      assert.equal(code(() => assertMovePair(from, to, list)), "unsupported_file", `${from} -> ${to}`);
      assert.throws(() => assertMovePair(from, to, list), /does not keep the extension/);
    }
    assert.equal(code(() => assertMovePair("A/Scan.pdf", "A/Scan.md", list)), "unsupported_file");
  });
});

describe("validation before a write", () => {
  test("a .base must be one YAML mapping, with views a list of mappings when present", () => {
    assert.equal(validateFileContent("x.base", BASE), "base");
    assert.equal(validateFileContent("x.base", "{}"), "base");
    for (const bad of ["", "# only a comment\n", "- a\n- b\n", "just text\n", "a: [\n", "a: 1\na: 2\n", "a: 1\n---\nb: 2\n", "views: Table\n", "views:\n  - Table\n", "a: &x 1\nb: *x\n", "d: &d {a: 1}\ne:\n  <<: {a: 2}\n", "e:\n  <<: {a: 2}\n", "f: !!js/function \"x\"\n", "g: !!str 5\n", "h: !custom 1\n", "a: &a [1,1,1,1,1,1,1,1,1]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n"]) {
      assert.equal(code(() => validateFileContent("x.base", bad)), "invalid_file", JSON.stringify(bad));
    }
  });
  test("an empty `views:` is no views: valid, and upsert_view makes the list", () => {
    assert.equal(validateFileContent("x.base", "filters: {}\nviews:\n"), "base");
    const { text, result } = applyFileEdit("x.base", "views:\n", { op: "upsert_view", item: JSON.stringify({ type: "table", name: "T" }) });
    assert.equal(result.action, "added");
    assert.match(text, /views:\n  - type: table\n    name: T/);
    assert.equal(applyFileEdit("x.base", "views:\n", { op: "remove_view", key: "T" }).result.found, false);
  });
  test("a view item may not use an alias, an anchor, a merge key or a tag either, so no duplicate name can hide behind one", () => {
    for (const item of ["name: &n Cards\ntype: table\n", "<<: {name: Cards}\ntype: table\n", "name: !!str Cards\n"]) {
      assert.equal(code(() => applyFileEdit("x.base", BASE, { op: "upsert_view", item })), "invalid_file", item);
    }
  });
  test("a .canvas must be a JSON object; nodes and edges, when present, arrays of objects with unique string ids", () => {
    assert.equal(validateFileContent("x.canvas", CANVAS), "canvas");
    assert.equal(validateFileContent("x.canvas", "{}"), "canvas");
    for (const bad of ["", "[]", "null", "{nodes: []}", '{"nodes": {}}', '{"edges": "x"}', '{"nodes": [1]}', '{"nodes": [{"type": "text"}]}', '{"nodes": [{"id": ""}]}', '{"nodes": [{"id": "a"}, {"id": "a"}]}', '{"nodes": [{"id": "a"}], "edges": [{"id": "e", "fromNode": "a", "toNode": "z"}]}', '{"edges": [{"id": "e", "fromNode": "a", "toNode": "a"}]}', '{"nodes": [{"id": "a"}], "edges": [{"id": "e", "fromNode": "a"}]}']) {
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
    assert.deepEqual(result, { op: "upsert_view", key: "Gallery", found: true, action: "replaced", replaced: "Cards" });
    ({ result } = applyFileEdit("x.base", BASE, { op: "upsert_view", key: "Nope", item: JSON.stringify({ type: "list", name: "List" }) }));
    assert.deepEqual(result, { op: "upsert_view", key: "List", found: false, action: "added" }, "a key that matches no view: the result names the view added");
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
    assert.equal(code(() => applyFileEdit("x.canvas", CANVAS, { op: "upsert_edge", item: JSON.stringify({ id: "ac", fromNode: "a", toNode: "c" }) })), "invalid_file", "an edge to a missing node");
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
  test("moveFile moves a PDF and a zip on the list, keeps their bytes, and refuses one off the list, a type change and a note", async () => {
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0xfe]);
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0xff]);
    const v = await vault({ "Inbox/Scan.pdf": pdf, "Inbox/Bundle.zip": zip, "Inbox/run.exe": "x", "N/Plan.md": "# Plan\n" });
    const opt = (extensions) => ({ update_backlinks: true, overwrite: false, ...(extensions ? { extensions } : {}) });
    // Without a list (a direct caller), only .base and .canvas move.
    await assert.rejects(v.backend.moveFile("Inbox/Scan.pdf", "Files/Scan.pdf", opt()), (e) => e.code === "unsupported_file");
    const list = ["pdf", "zip"];
    let r = await v.backend.moveFile("Inbox/Scan.pdf", "Files/2026/Scan.pdf", opt(list));
    assert.deepEqual([r.from, r.to, r.backlinks_updated], ["Inbox/Scan.pdf", "Files/2026/Scan.pdf", 0]);
    assert.match(r.links_note, /does not rewrite links or embeds/);
    assert.deepEqual(await readFile(join(v.root, "Files/2026/Scan.pdf")), pdf, "the bytes are moved as they were");
    assert.equal(await v.exists("Inbox/Scan.pdf"), false);
    r = await v.backend.moveFile("Inbox/Bundle.zip", "Files/Bundle 2026.zip", opt(list));
    assert.deepEqual(await readFile(join(v.root, "Files/Bundle 2026.zip")), zip);
    await assert.rejects(v.backend.moveFile("Inbox/run.exe", "Files/run.exe", opt(list)), (e) => e.code === "unsupported_file");
    await assert.rejects(v.backend.moveFile("Files/2026/Scan.pdf", "Files/2026/Scan.zip", opt(list)), /does not keep the extension/);
    await assert.rejects(v.backend.moveFile("N/Plan.md", "M/Plan.md", opt(["md", ...list])), /obsidian_move_note/);
    await assert.rejects(v.backend.moveFile("Files/2026/Scan.pdf", ".hidden/Scan.pdf", opt(list)), (e) => e.code === "unsupported_file");
    assert.equal(await v.exists("Inbox/run.exe"), true);
    assert.equal(await v.exists("N/Plan.md"), true);
    assert.equal(await v.exists("Files/2026/Scan.pdf"), true);
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
  test("the move hands the operator's list to the backend, read per call, and names it in its description", async () => {
    const s = fakeServer();
    let list = ["pdf"];
    const seen = [];
    registerFileTools(s, { moveFile: async (from, to, o) => { seen.push(o.extensions); return { from, to, backlinks_updated: null, backlinks_files_touched: null }; } }, { moveExtensions: () => list });
    const move = s.tools.get("obsidian_move_file");
    assert.match(move.def.description, /Allowed types when this connection was made: \.base \.canvas \.pdf;/);
    assert.match(move.def.description, /obsidian_move_note/);
    await move.handler({ from: "A/x.pdf", to: "B/x.pdf", update_backlinks: true, overwrite: false });
    list = ["zip"];
    await move.handler({ from: "A/x.zip", to: "B/x.zip", update_backlinks: true, overwrite: false });
    assert.deepEqual(seen, [["pdf"], ["zip"]]);
    const none = fakeServer();
    const got = [];
    registerFileTools(none, { moveFile: async (from, to, o) => { got.push(o.extensions); return { from, to, backlinks_updated: null, backlinks_files_touched: null }; } });
    await none.tools.get("obsidian_move_file").handler({ from: "A/x.canvas", to: "B/x.canvas", update_backlinks: true, overwrite: false });
    assert.deepEqual(got, [[]], "no list given: none, so only .base and .canvas move");
  });
  test("kernelArgs names if_rev, idempotency_key and intent (the file-system server accepts them)", () => {
    const s = fakeServer();
    registerFileTools(s, {}, { kernelArgs: true });
    for (const { def } of s.tools.values()) for (const k of ["if_rev", "idempotency_key", "intent"]) assert.ok(def.inputSchema.shape[k], k);
    const w = s.tools.get("obsidian_write_file").def.inputSchema.safeParse({ path: "a.base", content: "a: 1\n", if_rev: 1, idempotency_key: "k", intent: "why" });
    assert.equal(w.success, true, JSON.stringify(w.error?.issues));
  });
});
