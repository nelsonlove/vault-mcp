/**
 * A runtime stand-in for the `obsidian` module.
 *
 * The real package is TYPES ONLY (`"main": ""`), so any source file that
 * imports a live class from it — `TFile`, `TFolder`, `getAllTags` — cannot be
 * loaded in node at all, which is why the plugin keeps its testable logic in
 * obsidian-free modules. The move path is the exception worth reaching: it is
 * one `instanceof TFile` away from being pure logic, and the property under
 * test (a move renames through `fileManager.renameFile`, never `vault.rename`)
 * is precisely a property of the real handler, not of a re-implementation.
 *
 * `installObsidianStub()` registers a synchronous resolve hook mapping the
 * "obsidian" specifier at this file, so a test can `await import()` the real
 * module under test afterwards. It is scoped to the process that calls it — no
 * other test file is affected, and the npm test script is unchanged.
 */

import { registerHooks } from "node:module";

/** Minimal TFile: a path plus the `stat.mtime` the kernel's probe reads. */
export class TFile {
  constructor(path, mtime = 1) {
    this.path = path;
    this.stat = { mtime, ctime: mtime, size: 0 };
    const name = path.split("/").pop() ?? path;
    this.name = name;
    this.basename = name.replace(/\.[^.]+$/, "");
    this.extension = name.includes(".") ? name.split(".").pop() : "";
  }
}

export class TFolder {
  constructor(path, children = []) {
    this.path = path;
    this.children = children;
  }
}

export class TAbstractFile {}

/** Enough of a MarkdownView for `instanceof` / `getActiveViewOfType` in tools-nav. */
export class MarkdownView {}

/**
 * Minimal base classes for the governance pane + wiring so those modules LOAD when a test imports
 * a file that transitively pulls them in (connection-ui.ts → governor/wiring/wiring.ts →
 * governor/wiring/pane.ts). `class GovernanceReviewView extends ItemView` and `new Component()` only need the base
 * class to EXIST at module-eval time; none of their Obsidian behavior is exercised headlessly (the
 * settings-tab render path is verified by build + reasoning + the gesture/tripwire tests). The
 * shared, obsidian-free helpers renderAllowlist / wireAdoptButton ARE exercised directly, against
 * a fake element, in governance-settings-tab.test.mjs.
 */
export class ItemView {}
export class Component {}

/**
 * Minimal stand-ins for the settings-tab surface (connection-ui.ts), just
 * enough for the module to LOAD and its class declarations
 * (`class Foo extends Modal`, `class Bar extends PluginSettingTab`) to
 * evaluate — none of these are exercised for their real Obsidian behavior.
 * connection-ui.ts's own pure, exported helpers (parseCommaList,
 * parseFloorField, floorFieldProblem) are what tests actually exercise;
 * `display()`/`onOpen()` — the DOM-heavy glue — are not.
 */
export class App {}

export class Modal {
  constructor(app) {
    this.app = app;
  }
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}

export class Setting {
  constructor() {}
}

export class Notice {
  constructor() {}
}

/**
 * Same reason as Modal/PluginSettingTab above: connection-ui.ts → command-
 * suggest.ts, whose `class CommandSuggest extends AbstractInputSuggest` only
 * needs the base class to EXIST at module-eval time. The real suggester
 * behavior (getSuggestions/renderSuggestion/selectSuggestion) is DOM-driven
 * and untested headlessly, same boundary as display()/onOpen() above.
 */
export class AbstractInputSuggest {
  constructor(app, inputEl) {
    this.app = app;
    this.inputEl = inputEl;
  }
}

/**
 * Obsidian's own getAllTags flattens a file cache's inline tags and its
 * frontmatter `tags` into one `#tag` list. The stub reads the same two places,
 * so a fake cache drives findByTag / obsidian_tags_list realistically; a cache
 * with neither yields [], which is what every pre-existing caller expects.
 */
export function getAllTags(cache) {
  const out = [];
  for (const t of cache?.tags ?? []) out.push(typeof t === "string" ? t : t.tag);
  const fm = cache?.frontmatter?.tags;
  for (const t of Array.isArray(fm) ? fm : fm ? [fm] : []) {
    out.push(String(t).startsWith("#") ? String(t) : `#${t}`);
  }
  return out;
}

/**
 * A deliberately small YAML reader — enough for the frontmatter the tests write:
 * `key: scalar`, quoted scalars, inline arrays `[a, b]`, and inline maps
 * `{k: v}`. The real Obsidian parseYaml is far richer; this only has to make the
 * accept-forbidden guard's value-TYPE handling (string / array / map) testable
 * headlessly, so array/map acceptance forms are read as the guard sees them.
 */
/**
 * Load-time stand-ins so server.ts (the composition of every registrar) can be
 * imported in node, for the tests that drive a tool through the REAL server
 * wiring (move-with-links.test.mjs, the records block). Only their existence is needed at
 * module-eval time; no test exercises their Obsidian behavior.
 */
export class FileSystemAdapter {}
export class FuzzySuggestModal extends Modal {}
export class Plugin {}
/** A minimal YAML writer for flat maps (the only use a load-only test can reach). */
export function stringifyYaml(obj) {
  return Object.entries(obj ?? {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`).join("\n") + "\n";
}

export function parseYaml(text) {
  const scalar = (raw) => {
    const s = raw.trim();
    if (s === "") return null;
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "null" || s === "~") return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
  };
  // A YAML comment: ` #` and the rest of the line, after a plain or a closed quoted scalar. `true#x` keeps its `#` (no space), as YAML reads it.
  const uncomment = (raw) => {
    const s = raw.trim();
    const q = s[0] === '"' || s[0] === "'" ? s.indexOf(s[0], 1) : -1;
    if (q > 0) return s.slice(0, q + 1) + s.slice(q + 1).replace(/\s+#.*$/, "");
    return s.replace(/(^|\s+)#.*$/, "");
  };
  const inline = (raw) => {
    const s = uncomment(raw);
    if (s.startsWith("[") && s.endsWith("]")) {
      const inner = s.slice(1, -1).trim();
      return inner === "" ? [] : inner.split(",").map((x) => scalar(x));
    }
    if (s.startsWith("{") && s.endsWith("}")) {
      const inner = s.slice(1, -1).trim();
      const out = {};
      if (inner !== "") {
        for (const pair of inner.split(",")) {
          const i = pair.indexOf(":");
          if (i < 0) continue;
          out[pair.slice(0, i).trim()] = scalar(pair.slice(i + 1));
        }
      }
      return out;
    }
    return scalar(s);
  };
  const obj = {};
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const m = /^([^:\s][^:]*):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const rest = m[2].trim();
    // Block sequence: `key:` then following `  - item` lines.
    if (rest === "" && lines[i + 1] && /^\s*-\s+/.test(lines[i + 1])) {
      const arr = [];
      while (lines[i + 1] && /^\s*-\s+/.test(lines[i + 1])) {
        arr.push(scalar(uncomment(lines[i + 1].replace(/^\s*-\s+/, ""))));
        i++;
      }
      obj[key] = arr;
    } else {
      obj[key] = inline(rest);
    }
  }
  return obj;
}

let installed = false;

/** Point the "obsidian" specifier at this module for every subsequent import. */
/** Obsidian's normalizePath, as far as the tests need it: collapse slashes, trim them at the ends. */
export function normalizePath(p) {
  return String(p).replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

/** A fixed-clock moment: format() renders the few tokens the tests use from 2026-10-12T14:05:09. */
export function moment() {
  return {
    format(f) {
      return String(f).replace("YYYY", "2026").replace("MM", "10").replace("DD", "12").replace("HH", "14").replace("mm", "05").replace("ss", "09");
    },
  };
}

export function installObsidianStub() {
  if (installed) return;
  installed = true;
  const url = import.meta.url;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "obsidian") return { url, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}
