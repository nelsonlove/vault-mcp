// file-formats.ts — the two non-note file types vault-mcp writes (#575): Obsidian Bases (`.base`,
// YAML) and JSON Canvas (`.canvas`, JSON). Pure and Obsidian-free, so the live host and the
// file-system server validate and edit with the SAME code: one rule, two transports.
//
// What a write must pass, before anything is written (and again on the result of a keyed edit):
//   - `.base`: one YAML document (no `---` second document, no duplicate key, no parse error) whose
//     top level is a mapping, not a scalar or a list; a `views` key, when present, is a list of
//     mappings.
//   - `.canvas`: JSON whose top level is an object; `nodes` and `edges`, when present, are arrays
//     (JSON Canvas 1.0); each node and each edge is an object with a non-empty string `id`, unique
//     within its array (the keyed edit addresses them by it).
// Nothing more is checked: a node's type or position, a view's type or filters, are Obsidian's to
// read. A write that fails is refused with `invalid_file` and nothing is written.
//
// The keyed edit changes one item and leaves the rest of the file as it was written: a Base is
// edited as a YAML document (its comments and the style of the untouched parts are kept; the
// replaced view is written fresh), a Canvas is re-serialised with the indentation it already had.

import { parseDocument, isMap, isSeq, type Document, type YAMLMap } from "yaml";

/** The extensions these tools write, and nothing else. A note (`.md`) goes through the note tools. */
export const FILE_EXTENSIONS: readonly string[] = Object.freeze([".base", ".canvas"]);

export type FileKind = "base" | "canvas";

/** A path these tools do not write: wrong extension, or a hidden or malformed segment. Nothing was written. */
export class UnsupportedFileError extends Error {
  readonly code = "unsupported_file";
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileError";
  }
}

/** Content that does not parse as its type, or an edit whose result would not. Nothing was written. */
export class InvalidFileError extends Error {
  readonly code = "invalid_file";
  constructor(message: string) {
    super(message);
    this.name = "InvalidFileError";
  }
}

/** A keyed edit that names its item in two ways that disagree, or names an item twice in the file. Nothing was written. */
export class FileEditError extends Error {
  readonly code = "invalid_edit";
  constructor(message: string) {
    super(message);
    this.name = "FileEditError";
  }
}

/** The kind a path names by its extension (exact, lower case, as Obsidian registers them), or null. */
export function fileKindOf(path: string): FileKind | null {
  if (path.endsWith(".base")) return "base";
  if (path.endsWith(".canvas")) return "canvas";
  return null;
}

/**
 * The kind of a path these tools may write, or a refusal: the extension must be `.base` or
 * `.canvas`, the name before it must not be empty, and no segment may be empty, `.` or `..`, or
 * start with `.` (a hidden folder such as the app's config folder is never written here).
 */
export function assertFilePath(path: string): FileKind {
  const kind = fileKindOf(path);
  if (!kind) {
    throw new UnsupportedFileError(`'${path}' is not a .base or .canvas file; these tools write only those two types (a note goes through obsidian_write_note). Nothing was written.`);
  }
  const segs = path.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) {
    throw new UnsupportedFileError(`'${path}' has an empty, '.' or '..' segment; give a plain vault-relative path. Nothing was written.`);
  }
  // A hidden name (`.base` alone, with no name before the extension) is caught here too.
  if (segs.some((s) => s.startsWith("."))) {
    throw new UnsupportedFileError(`'${path}' is in a hidden folder or has a hidden name; these tools never write there. Nothing was written.`);
  }
  return kind;
}

// ── validation ──────────────────────────────────────────────────────────────

function parseBase(text: string): Document.Parsed {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    throw new InvalidFileError(`the .base content is not valid YAML (${e.code}: ${e.message.split("\n")[0]}). Nothing was written.`);
  }
  if (!isMap(doc.contents)) {
    const what = doc.contents === null ? "empty" : isSeq(doc.contents) ? "a list" : "a single value";
    throw new InvalidFileError(`the .base content is ${what}; a Base is a YAML mapping (keys such as filters, properties, views). Nothing was written.`);
  }
  const views = doc.contents.get("views", true);
  if (views !== undefined && views !== null) {
    if (!isSeq(views)) throw new InvalidFileError("the .base `views` key is not a list. Nothing was written.");
    if (views.items.some((v) => !isMap(v))) throw new InvalidFileError("every item of the .base `views` list must be a mapping. Nothing was written.");
  }
  return doc;
}

interface CanvasData {
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

function parseCanvas(text: string): CanvasData {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new InvalidFileError(`the .canvas content is not valid JSON (${e instanceof Error ? e.message : String(e)}). Nothing was written.`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new InvalidFileError("the .canvas content is not a JSON object; JSON Canvas is an object with `nodes` and `edges` arrays. Nothing was written.");
  }
  const c = data as CanvasData;
  for (const k of ["nodes", "edges"] as const) {
    const arr = c[k];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) throw new InvalidFileError(`the .canvas \`${k}\` is not an array (JSON Canvas 1.0). Nothing was written.`);
    const seen = new Set<string>();
    arr.forEach((item, i) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) throw new InvalidFileError(`.canvas ${k}[${i}] is not an object. Nothing was written.`);
      const id = (item as Record<string, unknown>).id;
      if (typeof id !== "string" || id === "") throw new InvalidFileError(`.canvas ${k}[${i}] has no string \`id\`. Nothing was written.`);
      if (seen.has(id)) throw new InvalidFileError(`.canvas ${k} has the id '${id}' twice; ids are unique. Nothing was written.`);
      seen.add(id);
    });
  }
  return c;
}

/** Refuse content that does not parse as the type `path` names (`invalid_file`); returns the kind. */
export function validateFileContent(path: string, content: string): FileKind {
  const kind = assertFilePath(path);
  if (kind === "base") parseBase(content);
  else parseCanvas(content);
  return kind;
}

// ── the keyed edit ──────────────────────────────────────────────────────────

export const FILE_EDIT_OPS = ["upsert_view", "remove_view", "upsert_node", "remove_node", "upsert_edge", "remove_edge"] as const;
export type FileEditOp = (typeof FILE_EDIT_OPS)[number];

export interface FileEdit {
  op: FileEditOp;
  /** The view's name, or the node's or edge's id: which item the edit addresses. */
  key?: string;
  /** For an upsert: the whole item, as JSON text (a view may also be YAML text). */
  item?: string;
}

export interface FileEditResult {
  op: FileEditOp;
  key: string;
  /** False when a remove names an item the file does not have: nothing is written. */
  found: boolean;
  action?: "added" | "replaced" | "removed";
  /** remove_node: the edges that touched the node, removed with it. */
  edges_removed?: string[];
}

const BASE_OPS: ReadonlySet<FileEditOp> = new Set(["upsert_view", "remove_view"]);

function parseItem(raw: string | undefined, kind: FileKind, what: string): Record<string, unknown> {
  if (raw === undefined) throw new FileEditError(`an upsert needs \`item_json\`: the whole ${what}. Nothing was written.`);
  let v: unknown;
  if (kind === "base") {
    const d = parseDocument(raw, { uniqueKeys: true, prettyErrors: false });
    if (d.errors.length > 0) throw new InvalidFileError(`\`item_json\` is not valid JSON or YAML (${d.errors[0].code}). Nothing was written.`);
    v = d.toJS();
  } else {
    try {
      v = JSON.parse(raw);
    } catch (e) {
      throw new InvalidFileError(`\`item_json\` is not valid JSON (${e instanceof Error ? e.message : String(e)}). Nothing was written.`);
    }
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new InvalidFileError(`\`item_json\` must be one ${what} object. Nothing was written.`);
  return v as Record<string, unknown>;
}

/** The indentation the canvas text already uses, so a keyed edit does not reformat the whole file. */
function canvasIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text);
  if (!m) return text.includes("\n") ? "\t" : 0;
  return m[1].startsWith("\t") ? "\t" : m[1].length;
}

/**
 * Apply one keyed edit to a file's current text. Returns the new text (null when nothing changes)
 * and what was done. The new text is validated as a whole before it is returned, so an edit can
 * never leave a file that a whole-file write would refuse.
 */
export function applyFileEdit(path: string, text: string, edit: FileEdit): { text: string | null; result: FileEditResult } {
  const kind = assertFilePath(path);
  if ((kind === "base") !== BASE_OPS.has(edit.op)) {
    throw new FileEditError(`'${edit.op}' is not an edit of a .${kind} file (a .base takes upsert_view and remove_view; a .canvas the node and edge ops). Nothing was written.`);
  }
  const remove = edit.op.startsWith("remove_");
  if (remove && (edit.key === undefined || edit.key === "")) throw new FileEditError(`'${edit.op}' needs \`key\`: the ${kind === "base" ? "view's name" : "item's id"}. Nothing was written.`);
  if (remove && edit.item !== undefined) throw new FileEditError(`'${edit.op}' takes no \`item_json\`. Nothing was written.`);

  if (kind === "base") {
    const doc = parseBase(text);
    const root = doc.contents as unknown as YAMLMap; // parseBase refused anything but a mapping
    let views = root.get("views", true) as unknown;
    if (remove) {
      if (!isSeq(views)) return { text: null, result: { op: edit.op, key: edit.key!, found: false } };
      const at = matchingViews(views.items, edit.key!);
      if (at.length === 0) return { text: null, result: { op: edit.op, key: edit.key!, found: false } };
      views.items.splice(at[0], 1);
      return { text: finishBase(doc), result: { op: edit.op, key: edit.key!, found: true, action: "removed" } };
    }
    const item = parseItem(edit.item, kind, "view");
    if (typeof item.name !== "string" || item.name === "") throw new FileEditError("a view in `item_json` needs a string `name`. Nothing was written.");
    const key = edit.key ?? item.name;
    if (!isSeq(views)) {
      root.set("views", doc.createNode([]));
      views = root.get("views", true);
    }
    const seq = views as { items: unknown[] };
    const at = matchingViews(seq.items, key);
    if (item.name !== key && matchingViews(seq.items, item.name).length > 0) {
      throw new FileEditError(`a view named '${item.name}' already exists; renaming '${key}' to it would give two views one name. Nothing was written.`);
    }
    const node = doc.createNode(item);
    if (at.length === 0) seq.items.push(node);
    else seq.items[at[0]] = node;
    return { text: finishBase(doc), result: { op: edit.op, key, found: at.length > 0, action: at.length === 0 ? "added" : "replaced" } };
  }

  // canvas
  const data = parseCanvas(text);
  const list = edit.op.endsWith("_node") ? "nodes" : "edges";
  const arr = (data[list] ?? []) as Array<Record<string, unknown>>;
  const indent = canvasIndent(text);
  const trailing = text.endsWith("\n") ? "\n" : "";
  const serialise = () => {
    const out = JSON.stringify(data, null, indent) + trailing;
    parseCanvas(out);
    return out;
  };
  if (remove) {
    const i = arr.findIndex((x) => x.id === edit.key);
    if (i < 0) return { text: null, result: { op: edit.op, key: edit.key!, found: false } };
    arr.splice(i, 1);
    const result: FileEditResult = { op: edit.op, key: edit.key!, found: true, action: "removed" };
    if (list === "nodes" && Array.isArray(data.edges)) {
      // An edge whose end is gone is no longer JSON Canvas; Obsidian removes it with the node too.
      const gone = data.edges.filter((e) => e.fromNode === edit.key || e.toNode === edit.key);
      if (gone.length > 0) {
        data.edges = data.edges.filter((e) => !gone.includes(e));
        result.edges_removed = gone.map((e) => String(e.id));
      }
    }
    return { text: serialise(), result };
  }
  const item = parseItem(edit.item, kind, list === "nodes" ? "node" : "edge");
  if (typeof item.id !== "string" || item.id === "") throw new FileEditError(`the ${list === "nodes" ? "node" : "edge"} in \`item_json\` needs a string \`id\`. Nothing was written.`);
  if (edit.key !== undefined && edit.key !== item.id) {
    throw new FileEditError(`\`key\` '${edit.key}' and the item's id '${item.id}' differ; an id is not renamed by an upsert. Nothing was written.`);
  }
  const i = arr.findIndex((x) => x.id === item.id);
  if (i < 0) arr.push(item);
  else arr[i] = item;
  data[list] = arr;
  return { text: serialise(), result: { op: edit.op, key: item.id, found: i >= 0, action: i < 0 ? "added" : "replaced" } };
}

function matchingViews(items: unknown[], name: string): number[] {
  const at: number[] = [];
  items.forEach((v, i) => {
    if (isMap(v) && v.get("name") === name) at.push(i);
  });
  if (at.length > 1) throw new FileEditError(`the .base has ${at.length} views named '${name}'; a keyed edit cannot tell them apart. Rewrite the file whole with obsidian_write_file. Nothing was written.`);
  return at;
}

function finishBase(doc: Document.Parsed): string {
  const out = doc.toString({ lineWidth: 0 });
  parseBase(out);
  return out;
}
