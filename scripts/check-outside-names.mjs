#!/usr/bin/env node
// Flags a NEW hard-wired outside name (a name from the operator's own setup) in a PR.
// Usage: node scripts/check-outside-names.mjs [base-ref] [--all]
// Looks only at ADDED lines of `git diff --unified=0 <base>...HEAD`. --all checks every line of the tree (to calibrate the allow lists).
// A line opts out with a trailing comment: outside-name-ok: <reason>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const HINT = "add a row to the vault-mcp assumptions ledger (07.36) or make it a setting";
export const OPT_OUT = /outside-name-ok:\s*\S/;

export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file));
}

export function compile(config) {
  return config.patterns.map((p) => ({ ...p, re: new RegExp(p.regex) }));
}

/** Pure matcher: lines = [{file, line, text}] -> violations. */
export function findViolations(lines, config) {
  const patterns = compile(config);
  const always = config.alwaysAllowed ?? [];
  const found = [];
  for (const l of lines) {
    if (matchesAny(l.file, always) || OPT_OUT.test(l.text)) continue;
    for (const p of patterns) {
      if (p.re.test(l.text) && !matchesAny(l.file, p.allowed ?? [])) {
        found.push({ file: l.file, line: l.line, id: p.id, regex: p.regex, why: p.why, text: l.text.trim() });
      }
    }
  }
  return found;
}

/** Parse `git diff --unified=0` output into added lines. */
export function parseAddedLines(diff) {
  const out = [];
  let file = null;
  let n = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.replace(/^\+\+\+ (b\/)?/, "");
    } else if (raw.startsWith("@@")) {
      const m = /\+(\d+)/.exec(raw);
      n = m ? Number(m[1]) : 0;
    } else if (file && raw.startsWith("+") && !raw.startsWith("+++")) {
      out.push({ file, line: n, text: raw.slice(1) });
      n++;
    }
  }
  return out;
}

export function format(v) {
  return `${v.file}:${v.line}: ${v.id} (${v.regex}) - ${v.why}\n    ${v.text.slice(0, 160)}\n    hint: ${HINT}`;
}

export function loadConfig(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function main(argv) {
  const all = argv.includes("--all");
  const base = argv.find((a) => !a.startsWith("--")) ?? "origin/main";
  const here = dirname(fileURLToPath(import.meta.url));
  const config = loadConfig(join(here, "outside-names.json"));
  let diff;
  if (all) {
    const empty = git(["hash-object", "-t", "tree", "/dev/null"]).trim();
    diff = git(["diff", "--unified=0", "--no-color", "--no-ext-diff", empty, "HEAD"]);
  } else {
    diff = git(["diff", "--unified=0", "--no-color", "--no-ext-diff", `${base}...HEAD`]);
  }
  const violations = findViolations(parseAddedLines(diff), config);
  if (violations.length === 0) {
    console.log(`outside-names: no new outside names (${config.patterns.length} patterns checked).`);
    return 0;
  }
  console.error(`outside-names: ${violations.length} added line(s) carry an outside name:\n`);
  for (const v of violations) console.error(format(v) + "\n");
  console.error("Opt out one line with a trailing comment: outside-name-ok: <reason>");
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
