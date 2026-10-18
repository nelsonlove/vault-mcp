import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { globToRegExp, matchesAny, findViolations, parseAddedLines, headerPath, loadConfig } from "./check-outside-names.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig(join(here, "outside-names.json"));
const add = (file, text, line = 1) => [{ file, line, text }];

test("globs: * stays in one folder, ** crosses folders", () => {
  assert.ok(globToRegExp("packages/*/tests/**").test("packages/core/tests/a/b.mjs"));
  assert.ok(!globToRegExp("packages/*/tests/**").test("packages/core/src/a.ts"));
  assert.ok(matchesAny("packages/core/src/paths.ts", ["**/paths.ts"]));
  assert.ok(matchesAny("paths.ts", ["**/paths.ts"]));
  assert.ok(!matchesAny("a/b/README.md", ["README.md"]));
  assert.ok(matchesAny("docs/x/y.md", ["docs/**"]));
});

test("every pattern compiles and has a why", () => {
  for (const p of config.patterns) {
    assert.doesNotThrow(() => new RegExp(p.regex), p.id);
    assert.ok(p.why && p.why.length > 3, p.id);
    assert.ok(Array.isArray(p.allowed), p.id);
  }
  assert.equal(new Set(config.patterns.map((p) => p.id)).size, config.patterns.length);
});

test("a match in a disallowed file is flagged with file, line, pattern and why", () => {
  const v = findViolations(add("packages/core/src/x.ts", 'const l = "com.nelson.thing";', 7), config);
  assert.equal(v.length, 1);
  assert.equal(v[0].file, "packages/core/src/x.ts");
  assert.equal(v[0].line, 7);
  assert.equal(v[0].id, "launchagent-label");
  assert.ok(v[0].why);
});

test("an allowed path is not flagged", () => {
  assert.equal(findViolations(add("packages/core/tests/a.test.mjs", 'p = "/Users/x/vault"'), config).length, 0);
  assert.equal(findViolations(add("docs/guide.md", "see nelsonlove/vault-mcp"), config).length, 0);
  assert.equal(findViolations(add("packages/core/src/x.ts", "see nelsonlove/vault-mcp"), config).length, 1);
});

test("trailing outside-name-ok opts a line out; an empty reason does not", () => {
  assert.equal(findViolations(add("src/a.ts", 'x = "/Users/zed"; // outside-name-ok: made-up fixture'), config).length, 0);
  assert.equal(findViolations(add("src/a.ts", 'x = "/Users/zed"; // outside-name-ok:'), config).length, 1);
});

test("one line can match several patterns", () => {
  const ids = findViolations(add("src/a.ts", "/Users/zed and wham.studio"), config).map((v) => v.id).sort();
  assert.deepEqual(ids, ["home-path", "old-account-or-key"]);
});

test("date-like text is not a JD area folder", () => {
  assert.equal(findViolations(add("src/a.ts", "// 2026-10-17 Monday note"), config).length, 0);
  assert.equal(findViolations(add("src/a.ts", 'const f = "12-19 Made up";'), config).length, 1);
});

test("parseAddedLines reads files, line numbers and ignores removals", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -3,1 +3,2 @@",
    "-old", "+new one", "+new two",
    "diff --git a/gone.ts b/gone.ts", "--- a/gone.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-bye",
  ].join("\n");
  assert.deepEqual(parseAddedLines(diff), [
    { file: "a.ts", line: 3, text: "new one" },
    { file: "a.ts", line: 4, text: "new two" },
  ]);
});

test("end to end in a temp git repo: exit 0 when clean, 1 on a new name, old lines ignored", () => {
  const repo = mkdtempSync(join(tmpdir(), "outside-names-"));
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  g("init", "-q", "-b", "main");
  mkdirSync(join(repo, "scripts"));
  writeFileSync(join(repo, "scripts", "outside-names.json"), readFileSync(join(here, "outside-names.json")));
  writeFileSync(join(repo, "scripts", "check-outside-names.mjs"), readFileSync(join(here, "check-outside-names.mjs")));
  writeFileSync(join(repo, "a.ts"), 'old = "/Users/zed";\n');
  g("add", "."); g("commit", "-qm", "base");
  g("checkout", "-qb", "pr");
  const run = () => { try { execFileSync("node", ["scripts/check-outside-names.mjs", "main"], { cwd: repo, encoding: "utf8", stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
  writeFileSync(join(repo, "b.ts"), "const x = 1;\n"); g("add", "."); g("commit", "-qm", "clean");
  assert.equal(run(), 0);
  writeFileSync(join(repo, "b.ts"), 'const x = "/Users/zed";\n'); g("add", "."); g("commit", "-qm", "bad");
  assert.equal(run(), 1);
});

test("#565 review 1: an added line that starts with ++ is an added line, and paths with spaces or quotes are read plainly", () => {
  const diff = [
    "diff --git a/x.js b/x.js",
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -0,0 +1,3 @@",
    "+a();",
    "+++count; // a made-up name",
    "+b();",
    "diff --git a/a b.md b/a b.md",
    "--- a/a b.md",
    "+++ b/a b.md\t",
    "@@ -0,0 +1 @@",
    "+x",
  ].join("\n");
  const added = parseAddedLines(diff);
  assert.deepEqual(added.map((l) => [l.file, l.line, l.text]), [
    ["x.js", 1, "a();"],
    ["x.js", 2, "++count; // a made-up name"],
    ["x.js", 3, "b();"],
    ["a b.md", 1, "x"],
  ]);
  assert.equal(headerPath('"b/caf\\303\\251.md"'), "café.md");
  assert.equal(headerPath('"b/a \\"q\\".md"'), 'a "q".md');
  assert.equal(headerPath("b/a b.md\t"), "a b.md");
});

