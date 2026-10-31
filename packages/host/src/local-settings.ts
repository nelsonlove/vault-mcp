// local-settings.ts — the machine-local settings override (#579).
//
// A vault replicated by Obsidian Sync carries this plugin's `data.json` to
// every device. A headless replica (a server that runs the vault through Sync
// and this plugin's headless mode) needs settings the desktop must not get, and
// the desktop has settings the server must not get. So settings load in two
// layers: the synced `data.json` as before, then an optional JSON file OUTSIDE
// the vault, whose keys win.
//
// THE MERGE. Key by key: a plain object deep-merges into the synced object; any
// other value (a string, a number, a boolean, a list) replaces the synced value
// outright. A list is never merged item by item, and an empty list in the
// override replaces a full synced list. `null` is refused (leave a key out to
// take the synced value).
//
// WHERE THE FILE IS. `VAULT_MCP_LOCAL_SETTINGS` (an absolute path), else
// `<base state dir>/local/settings.json`, where the base state dir is
// `VAULT_MCP_STATE_DIR` or `~/.claude/vault-mcp/` (paths.ts `baseStateDir`).
// It is NEVER looked up through the `host.stateDir` setting: that setting comes
// from the synced file (or from the override itself), and a synced value must
// not be able to move where this machine looks for its own override. The
// default is in a SUBFOLDER on purpose: the bridge, the SessionStart health
// hook and the plugin's own registration check read every `*.json` directly in
// the state dir as a vault discovery entry, so a file there would be read as a
// vault (#582 review 1). The
// override may set `host.stateDir`; that moves the socket, the bridge and the
// discovery file as the setting always does, and does not move the override.
//
// FAILS CLOSED. An override often makes a machine STRICTER (create-only writes,
// headless on, no Claude registration), so a file that is present but cannot be
// used must stop the plugin, never fall back to the synced values: dropping the
// override would loosen this machine without anyone choosing that. An absent
// file is no override. A file named by `VAULT_MCP_LOCAL_SETTINGS` that is absent
// is an error, because naming it is a statement that one exists.
//
// SAVING. The override is never written into `data.json`: a save writes, for
// every overridden key, the value the synced file holds now (or leaves the key
// out when it holds none), so the synced file keeps its own value.
//
// Pure and Obsidian-free: main.ts reads the file through `readLocalSettings`
// and does the rest with the functions below.

import * as fs from "node:fs";
import * as path from "node:path";

export const LOCAL_SETTINGS_ENV = "VAULT_MCP_LOCAL_SETTINGS";
/** The default file, relative to the base state dir: in a subfolder, never beside the discovery files. */
export const LOCAL_SETTINGS_DIR = "local";
export const LOCAL_SETTINGS_FILE = "settings.json";

/** Where the override is looked up, and why there. */
export interface LocalSettingsLocation {
  path: string;
  /** "env": named by VAULT_MCP_LOCAL_SETTINGS; "default": `<base state dir>/local/settings.json`. */
  source: "env" | "default";
}

export type LocalSettingsLoad =
  | { state: "absent"; location: LocalSettingsLocation }
  | { state: "loaded"; location: LocalSettingsLocation; override: Record<string, unknown>; keys: string[] }
  | { state: "error"; location: LocalSettingsLocation; error: string };

/** The override's location: the variable when set (it must be absolute), else the file in the base state dir. */
export function localSettingsLocation(
  baseStateDir: string,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): LocalSettingsLocation {
  const named = env[LOCAL_SETTINGS_ENV]?.trim();
  if (named) return { path: named, source: "env" };
  return { path: path.join(baseStateDir, LOCAL_SETTINGS_DIR, LOCAL_SETTINGS_FILE), source: "default" };
}

/** The file-system calls `readLocalSettings` makes, injectable for tests. */
export interface LocalSettingsFs {
  lstatSync(p: string): { isSymbolicLink(): boolean };
  statSync(p: string): { isFile(): boolean };
  readFileSync(p: string, enc: "utf8"): string;
}

function code(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Read and check the override against `shape` (the plugin's default settings).
 * Never throws: every problem is an `error` state, which the caller must treat
 * as "do not serve".
 */
export function readLocalSettings(
  location: LocalSettingsLocation,
  shape: Record<string, unknown>,
  fsImpl: LocalSettingsFs = fs,
): LocalSettingsLoad {
  const fail = (error: string): LocalSettingsLoad => ({ state: "error", location, error });
  if (!path.isAbsolute(location.path)) {
    return fail(`${LOCAL_SETTINGS_ENV} must be an absolute path; it is '${location.path}'`);
  }
  try {
    fsImpl.lstatSync(location.path);
  } catch (e) {
    // At the default path, ENOTDIR (a FILE where the `local` folder would be) is
    // absent too: nothing there can be an override. Every other error (EACCES,
    // ELOOP, …) fails closed. A path the variable names fails closed on any error.
    if (code(e) === "ENOENT" || (code(e) === "ENOTDIR" && location.source === "default")) {
      if (location.source === "env") return fail(`${LOCAL_SETTINGS_ENV} names ${location.path}, and there is no file there`);
      return { state: "absent", location };
    }
    return fail(`cannot read ${location.path}: ${message(e)}`);
  }
  let isFile: boolean;
  try {
    isFile = fsImpl.statSync(location.path).isFile();
  } catch (e) {
    // lstat found an entry and stat cannot follow it: a dangling symbolic link.
    return fail(`${location.path} is a link to nothing (${message(e)})`);
  }
  if (!isFile) return fail(`${location.path} is not a regular file`);
  let text: string;
  try {
    text = fsImpl.readFileSync(location.path, "utf8");
  } catch (e) {
    return fail(`cannot read ${location.path}: ${message(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return fail(`${location.path} is not valid JSON: ${message(e)}`);
  }
  const problems = checkOverride(parsed, shape);
  if (problems.length > 0) return fail(`${location.path}: ${problems.join("; ")}`);
  const override = parsed as Record<string, unknown>;
  return { state: "loaded", location, override, keys: overridePaths(override) };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Keys JSON.parse can produce that would reach an object's prototype through an assignment. */
const FORBIDDEN_PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A key the override may not use: a prototype key, an empty key, or a key with
 * a `.` in it. Overridden keys are handled as dotted paths, so `a.b` as ONE key
 * would be read as two levels, and a save would put a value the synced file
 * never had into data.json (#582 review 1).
 */
function badKey(k: string): boolean {
  return FORBIDDEN_PROTO_KEYS.has(k) || k === "" || k.includes(".");
}
const FORBIDDEN_KEYS = { has: badKey };

/**
 * Lists of strings by path. Their default is an empty list, so the shape
 * cannot say what an item must be; these say it.
 */
export const STRING_LISTS: ReadonlySet<string> = new Set([
  "allowlist",
  "trustedReadOnlyPlugins",
  "redactProfiles",
  "guardedTerritories",
  "fileMoveExtensions",
  "writeScope.paths",
  "recordFolders.folders",
  "cliPolicy.deny",
  "cliPolicy.allowOpaque",
  "cliPolicy.neverOpaque",
  "cliPolicy.opaqueWildcards",
]);

/**
 * Lists of objects by path whose default is an empty list, so the shape cannot
 * say what an item must be. `schemes` is one since a fresh install has no
 * scheme (01.33 pick A, step b): an override that turns a scheme on, or sets
 * this machine's expansions, carries the whole list. What an item may hold is
 * the provider's to say, so it is checked by `useTimeProblems`.
 */
export const OBJECT_LISTS: ReadonlySet<string> = new Set(["schemes"]);

function kind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "list";
  if (isPlainObject(v)) return "object";
  return typeof v;
}

/**
 * Check an override against the shape of the default settings. The rules:
 *
 *   • the file is one JSON object;
 *   • every top-level key is a setting the plugin has (a misspelt key would
 *     otherwise do nothing, which for an override that tightens is loosening);
 *   • under an object setting with a fixed shape (`host`, `writeScope`, …)
 *     every key is one of its keys; under an object whose default is EMPTY
 *     (`modules`, `cliPolicy.opaqueSnapshot`) any key is accepted, because
 *     those are open maps;
 *   • a value has the type of the default it replaces (a list for a list, an
 *     object for an object, a boolean for a boolean, …), and a list of
 *     strings holds only strings;
 *   • `null` is never a value, and `__proto__`, `constructor`, `prototype`, an
 *     empty key and a key holding a `.` are never keys.
 *
 * Values inside an open map are checked only for `null` and forbidden keys.
 * A value the setting's own normalizer would change (an unknown mode, a path
 * that is not absolute) is caught later, by `normalizedMismatches`.
 */
export function checkOverride(raw: unknown, shape: Record<string, unknown>): string[] {
  if (!isPlainObject(raw)) return [`the file must hold one JSON object, not ${kind(raw)}`];
  const problems: string[] = [];
  const walk = (value: unknown, def: unknown, at: string, open: boolean) => {
    if (value === null) {
      problems.push(`${at} is null (leave the key out to use the synced value)`);
      return;
    }
    if (open) {
      if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(k)) problems.push(`${at}.${k} is not an allowed key (a prototype key, an empty key, or a key with a dot)`);
        else walk(v, undefined, `${at}.${k}`, true);
      } else if (Array.isArray(value)) value.forEach((v, i) => v === null && problems.push(`${at}[${i}] is null`));
      return;
    }
    const want = kind(def);
    const got = kind(value);
    if (want !== got) {
      problems.push(`${at} must be ${want === "object" ? "an object" : want === "list" ? "a list" : `a ${want}`}, not ${got === "object" ? "an object" : got === "list" ? "a list" : got}`);
      return;
    }
    if (got === "list") {
      const items = value as unknown[];
      const defItems = def as unknown[];
      if (STRING_LISTS.has(at)) {
        items.forEach((v, i) => typeof v !== "string" && problems.push(`${at}[${i}] must be a string`));
      } else if (OBJECT_LISTS.has(at)) {
        items.forEach((v, i) => !isPlainObject(v) && problems.push(`${at}[${i}] must be an object`));
      } else if (defItems.length > 0) {
        const itemKind = kind(defItems[0]);
        items.forEach((v, i) => kind(v) !== itemKind && problems.push(`${at}[${i}] must be ${itemKind === "object" ? "an object" : `a ${itemKind}`}`));
      }
      return;
    }
    if (got === "object") {
      const d = def as Record<string, unknown>;
      const openMap = Object.keys(d).length === 0;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const p = `${at}.${k}`;
        if (FORBIDDEN_KEYS.has(k)) problems.push(`${p} is not an allowed key (a prototype key, an empty key, or a key with a dot)`);
        else if (openMap) walk(v, undefined, p, true);
        else if (!Object.prototype.hasOwnProperty.call(d, k)) problems.push(`${p} is not a setting`);
        else walk(v, d[k], p, false);
      }
    }
  };
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_KEYS.has(k)) problems.push(`${k} is not an allowed key (a prototype key, an empty key, or a key with a dot)`);
    else if (!Object.prototype.hasOwnProperty.call(shape, k)) problems.push(`${k} is not a setting`);
    else walk(v, shape[k], k, false);
  }
  return problems;
}

/**
 * The dotted paths the override sets: one per leaf (a value that is not a
 * plain object). An empty object sets nothing. Sorted, so a report is a
 * function of the file.
 */
export function overridePaths(override: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k);
    else out.push(at);
  };
  walk(override, "");
  return out.sort();
}

/** A deep copy of a JSON-shaped value. */
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * `base` with `override` merged in: plain objects merge key by key, every
 * other value replaces. Neither input is changed; the result shares nothing
 * with `override`.
 */
export function mergeOverride<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeOverride(out[k] as Record<string, unknown>, v) : clone(v);
  }
  return out as T;
}

function split(p: string): string[] {
  return p.split(".");
}

/** The value at a dotted path, and whether it is there. */
export function getPath(obj: unknown, p: string): { present: boolean; value?: unknown } {
  let cur: unknown = obj;
  for (const seg of split(p)) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return { present: false };
    cur = cur[seg];
  }
  return { present: true, value: cur };
}

function setPath(obj: Record<string, unknown>, p: string, value: unknown): void {
  const segs = split(p);
  let cur = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

function deletePath(obj: Record<string, unknown>, p: string): void {
  const segs = split(p);
  let cur: unknown = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isPlainObject(cur)) return;
    cur = cur[seg];
  }
  if (isPlainObject(cur)) delete cur[segs[segs.length - 1]];
}

/**
 * What a save writes into the synced `data.json`: `settings` with every
 * overridden path set back to the synced value, never the override's. The
 * synced value is what the file holds NOW (`syncedNow`, the file as read just
 * before the save, so a newer value another device synced in is kept), else
 * what the settings held at load before the override was merged
 * (`syncedBase`: the file's value, a default, or a one-time seed, which is
 * what a save would have written with no override), else nothing (the key is
 * left out). `settings` is not changed.
 */
export function forSyncedFile(
  settings: Record<string, unknown>,
  paths: readonly string[],
  syncedNow: Record<string, unknown> | null,
  syncedBase: Record<string, unknown> | null,
): Record<string, unknown> {
  const out = clone(settings);
  for (const p of paths) {
    const now = getPath(syncedNow, p);
    const base = now.present ? now : getPath(syncedBase, p);
    if (base.present) {
      setPath(out, p, clone(base.value));
      continue;
    }
    deletePath(out, p);
    // An object that only held overridden keys (`modules.scheme` when the
    // override alone sets `modules.scheme.enabled`) is left out too, rather than
    // written as `{}`: the synced file never had it (#582 review 1).
    const segs = split(p);
    for (let i = segs.length - 1; i > 0; i--) {
      const parent = segs.slice(0, i).join(".");
      const there = getPath(out, parent);
      if (!there.present || !isPlainObject(there.value) || Object.keys(there.value).length > 0) break;
      if (getPath(syncedNow, parent).present || getPath(syncedBase, parent).present) break;
      deletePath(out, parent);
    }
  }
  return out;
}

/** Set every overridden path in `settings` back to the override's value, in place. */
export function reapplyOverride(settings: Record<string, unknown>, override: Record<string, unknown>, paths: readonly string[]): void {
  for (const p of paths) setPath(settings, p, clone(getPath(override, p).value));
}

/**
 * The overridden paths whose value the plugin's normalizers changed: the
 * setting does not take that value (an unknown mode, a relative path, a
 * pattern that does not compile, a value out of range). The override must not
 * be quietly replaced by a default, so the caller refuses to serve.
 */
export function normalizedMismatches(settings: unknown, override: Record<string, unknown>, paths: readonly string[]): string[] {
  return paths.filter((p) => !sameValue(getPath(settings, p).value, getPath(override, p).value));
}

/** Deep equality over JSON-shaped values; the order of an object's keys does not count. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }
  return false;
}

/**
 * The overridden paths that touch `key`: the key itself, a path under it
 * (`host` is touched by `host.headless`), or a path above it (`writeScope.mode`
 * is touched when `writeScope` were a leaf). The settings tab locks a control
 * when this is not empty.
 */
export function overridesTouching(paths: readonly string[], key: string): string[] {
  return paths.filter((p) => p === key || p.startsWith(`${key}.`) || key.startsWith(`${p}.`));
}

/** What obsidian_doctor reports: where the file is looked up, whether it was found, and the overridden key NAMES (never values). */
export function localSettingsReport(load: LocalSettingsLoad): Record<string, unknown> {
  return {
    path: load.location.path,
    source: load.location.source,
    found: load.state === "loaded",
    overridden_keys: load.state === "loaded" ? [...load.keys] : [],
    ...(load.state === "error" ? { error: load.error } : {}),
  };
}

/**
 * Checks of overridden values that no load-time normalizer makes, because the
 * setting is otherwise judged only where it is used (#582 review 1): an
 * archive pattern that does not compile would match nothing, so a record
 * folder rule the override meant to add would be silently off; a scheme row
 * the registry skips (`schemesRegister` answers false) would leave that scheme
 * off the same way.
 */
export function useTimeProblems(
  override: Record<string, unknown>,
  compiles: (pattern: string) => boolean,
  schemesRegister?: (rows: unknown[]) => boolean,
): string[] {
  const problems: string[] = [];
  // A scheme row the registry skips (an unknown provider, a config the
  // provider refuses, a bad excluded root, a repeated id) would leave the
  // scheme, or this machine's expansions, silently off.
  const schemes = getPath(override, "schemes");
  if (schemesRegister && schemes.present && Array.isArray(schemes.value) && !schemesRegister(schemes.value)) {
    problems.push("schemes holds a row the scheme registry does not take (an unknown provider, a config the provider refuses, a bad excludedRoots entry, or a repeated id)");
  }
  const pattern = getPath(override, "recordFolders.archivePattern");
  if (pattern.present && typeof pattern.value === "string" && pattern.value.trim() !== "" && !compiles(pattern.value)) {
    problems.push("recordFolders.archivePattern does not compile as a regular expression");
  }
  return problems;
}
