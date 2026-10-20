// file-formats.ts — the two non-note file types vault-mcp writes (#575): Obsidian Bases (`.base`,
// YAML) and JSON Canvas (`.canvas`, JSON). Pure and Obsidian-free, so the live host and the
// file-system server validate and edit with the SAME code: one rule, two transports.
//
// What a write must pass, before anything is written (and again on the result of a keyed edit):
//   - `.base`: one YAML document (no `---` second document, no duplicate key, no parse error) whose
//     top level is a mapping, not a scalar or a list; a `views` key, when present and not empty, is
//     a list of mappings (an empty `views:` is no views). No anchor, alias, merge key (`<<`) or
//     explicit tag (`!!str`, `!!js/function`, `!foo`): a Base needs none, an alias can expand without
//     bound (an alias bomb Obsidian cannot load), and an aliased view name would hide a duplicate
//     from the keyed edit.
//   - `.canvas`: JSON whose top level is an object; `nodes` and `edges`, when present, are arrays
//     (JSON Canvas 1.0); each node and each edge is an object with a non-empty string `id`, unique
//     within its array (the keyed edit addresses them by it); each edge's `fromNode` and `toNode`
//     name a node of the file.
// Nothing more is checked: a node's type or position, a view's type or filters, are Obsidian's to
// read. A write that fails is refused with `invalid_file` and nothing is written.
//
// The keyed edit changes one item and leaves the rest of the file as it was written: a Base is
// edited as a YAML document (its comments and the style of the untouched parts are kept; the
// replaced view is written fresh), a Canvas is re-serialised with the indentation it already had.

import { parseDocument, isMap, isSeq, isScalar, isAlias, isPair, visit, type Document, type YAMLMap } from "yaml";

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
 * No segment may be empty, `.` or `..`, or start with `.` (a hidden folder such as the app's config
 * folder is never written here, and a hidden name such as `.base` alone is refused too). An absolute
 * path has an empty first segment, so it is refused here as well.
 */
function assertPlainSegments(path: string): void {
  const segs = path.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) {
    throw new UnsupportedFileError(`'${path}' has an empty, '.' or '..' segment; give a plain vault-relative path. Nothing was written.`);
  }
  if (segs.some((s) => s.startsWith("."))) {
    throw new UnsupportedFileError(`'${path}' is in a hidden folder or has a hidden name; these tools never write there. Nothing was written.`);
  }
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
  assertPlainSegments(path);
  return kind;
}

// ── which files obsidian_move_file moves ────────────────────────────────────
//
// A move does not read or change a file's bytes, so it can take more types than the write and
// the edit, which validate content and stay `.base` and `.canvas` only. `.base` and `.canvas` are
// always movable; a note (`.md`) never is here, because the note tools carry the note rules
// (link rewriting of the note's own links, the accept and record guards, frontmatter); any other
// type is movable when its extension is on the operator's list.

/**
 * The extensions `obsidian_move_file` moves by default, besides `.base` and `.canvas`: lower case,
 * without the dot. The attachment types Obsidian itself opens (images, audio, video, PDF), plus the
 * office and archive files an operator commonly files beside notes. No executable or script type,
 * no type Obsidian reads as configuration (`json`, `css`, `js`), and no `md`.
 */
export const DEFAULT_FILE_MOVE_EXTENSIONS: readonly string[] = Object.freeze([
  // images
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif",
  // audio
  "mp3", "wav", "m4a", "ogg", "flac", "webm", "3gp",
  // video
  "mp4", "mov", "mkv", "ogv",
  // documents
  "pdf",
  // office and archive files
  "docx", "xlsx", "pptx", "odt", "zip",
]);

/** The file-system server reads the list from this variable (comma- or space-separated); unset ⇒ the default, empty ⇒ none. */
export const FILE_MOVE_EXTENSIONS_ENV_VAR = "VAULT_MCP_FILE_MOVE_EXTENSIONS";

/** The extensions a move always takes or never takes, whatever the list says. */
const ALWAYS_MOVABLE = new Set(["base", "canvas"]);
const NEVER_ON_LIST = new Set(["md", "base", "canvas"]);

/**
 * The operator's list as the move uses it: each entry trimmed, a leading dot dropped, lower-cased,
 * kept only when it is 1 to 16 letters or digits, without duplicates. `md`, `base` and `canvas`
 * are dropped (`.base` and `.canvas` always move; a note never does here). Not a list ⇒ the
 * default; an empty list ⇒ only `.base` and `.canvas`.
 */
export function normalizeFileMoveExtensions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_FILE_MOVE_EXTENSIONS];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const e = v.trim().replace(/^\./, "").toLowerCase();
    if (!/^[a-z0-9]{1,16}$/.test(e) || NEVER_ON_LIST.has(e) || out.includes(e)) continue;
    out.push(e);
  }
  return out;
}

/** The list from the environment variable's text: undefined ⇒ the default; otherwise split on commas and white space. */
export function parseFileMoveExtensions(text: string | undefined): string[] {
  if (text === undefined) return [...DEFAULT_FILE_MOVE_EXTENSIONS];
  return normalizeFileMoveExtensions(text.split(/[\s,]+/).filter(Boolean));
}

/**
 * Refuse a path `obsidian_move_file` does not move (`unsupported_file`), else return its extension
 * as written. The same segment rules as a write (nothing hidden, no `.`, `..` or empty segment, no
 * absolute path); `.base` and `.canvas` (exact, lower case) always; a note never; another type when
 * its extension, in any case, is on `extensions` (normalized, as `normalizeFileMoveExtensions` gives it).
 */
export function assertMovePath(path: string, extensions: readonly string[]): string {
  assertPlainSegments(path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (ALWAYS_MOVABLE.has(ext)) return ext;
  const lower = ext.toLowerCase();
  if (lower === "md") {
    throw new UnsupportedFileError(`'${path}' is a note; move it with obsidian_move_note, which also heals the note's own links and applies the note guards. Nothing was moved.`);
  }
  if (lower !== "" && !NEVER_ON_LIST.has(lower) && extensions.includes(lower)) return ext;
  const allowed = [".base", ".canvas", ...extensions.map((e) => `.${e}`)].join(" ");
  throw new UnsupportedFileError(
    `'${path}' ${ext === "" ? "has no extension" : `is a .${ext} file`}, which obsidian_move_file does not move here. It moves: ${allowed} (the operator sets the list). Nothing was moved.`,
  );
}

/**
 * The checks a move makes before it touches anything: both paths movable, and the extension kept
 * exactly as written (a rename does not change a file's type, nor the case of its extension).
 */
export function assertMovePair(fromRel: string, toRel: string, extensions: readonly string[]): void {
  const from = assertMovePath(fromRel, extensions);
  const to = assertMovePath(toRel, extensions);
  if (from !== to) {
    throw new UnsupportedFileError(`'${toRel}' does not keep the extension of '${fromRel}' (.${from}); a move does not change a file's type. Nothing was moved.`);
  }
}

// ── validation ──────────────────────────────────────────────────────────────

/** Parse YAML for a Base: one document, no error, no anchor, alias, merge key or explicit tag. */
function parsePlainYaml(text: string, what: string): Document.Parsed {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    throw new InvalidFileError(`${what} is not valid YAML (${problem.code}: ${problem.message.split("\n")[0]}). Nothing was written.`);
  }
  let found: string | null = null;
  visit(doc, {
    Node(_k, n) {
      if (isAlias(n)) found = `an alias (*${n.source})`;
      else if (n.anchor) found = `an anchor (&${n.anchor})`;
      else if (n.tag) found = `an explicit tag (${n.tag})`;
      if (found) return visit.BREAK;
    },
    Pair(_k, p) {
      if (isPair(p) && isScalar(p.key) && p.key.value === "<<") {
        found = "a merge key (<<)";
        return visit.BREAK;
      }
    },
  });
  if (found) throw new InvalidFileError(`${what} holds ${found}; a Base is written without anchors, aliases, merge keys or tags. Nothing was written.`);
  return doc;
}

function parseBase(text: string): Document.Parsed {
  const doc = parsePlainYaml(text, "the .base content");
  if (!isMap(doc.contents)) {
    const what = doc.contents === null ? "empty" : isSeq(doc.contents) ? "a list" : "a single value";
    throw new InvalidFileError(`the .base content is ${what}; a Base is a YAML mapping (keys such as filters, properties, views). Nothing was written.`);
  }
  const views = doc.contents.get("views", true);
  // An empty `views:` (a null scalar) is no views; Obsidian reads it as none, and upsert_view makes the list.
  if (views !== undefined && !(isScalar(views) && views.value === null)) {
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
  if (Array.isArray(c.edges)) {
    const nodes = new Set((c.nodes ?? []).map((n) => n.id as string));
    c.edges.forEach((e, i) => {
      for (const end of ["fromNode", "toNode"] as const) {
        const v = e[end];
        if (typeof v !== "string" || !nodes.has(v)) {
          throw new InvalidFileError(`.canvas edge '${String(e.id)}' (edges[${i}]) has ${end} ${typeof v === "string" ? `'${v}', which is not a node of this canvas` : "missing"}; every edge joins two nodes of the file. Nothing was written.`);
        }
      }
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
  /** upsert_view: the name of the view replaced, when the item renamed it. */
  replaced?: string;
  /** remove_node: the edges that touched the node, removed with it. */
  edges_removed?: string[];
}

const BASE_OPS: ReadonlySet<FileEditOp> = new Set(["upsert_view", "remove_view"]);

function parseItem(raw: string | undefined, kind: FileKind, what: string): Record<string, unknown> {
  if (raw === undefined) throw new FileEditError(`an upsert needs \`item_json\`: the whole ${what}. Nothing was written.`);
  let v: unknown;
  if (kind === "base") {
    v = parsePlainYaml(raw, "`item_json`").toJS();
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
    // The result names the view the file now holds; a replaced view of another name is `replaced`.
    const result: FileEditResult = { op: edit.op, key: item.name, found: at.length > 0, action: at.length === 0 ? "added" : "replaced" };
    if (at.length > 0 && key !== item.name) result.replaced = key;
    return { text: finishBase(doc), result };
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
