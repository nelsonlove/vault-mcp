// The write scope (write-scope.ts): what a session may write, separate from what it may read.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, inWriteScope, normalizeWriteScope, writeScopeRefusal, writeScopeRefusalForPath } from "../src/write-scope.ts";

const INBOX = { mode: "create-only", paths: ["**/[0-9][0-9].01 Inbox/*.md"] };
const none = () => false;
// Folders exist; notes do not: what a create in an existing folder sees.
const FOLDERS = new Set(["A", "A/10.01 Inbox", "A/10.02 Tasks"]);
const folders = (p) => FOLDERS.has(p);

describe("glob patterns over note paths", () => {
  test("** is any folders or none; * and ? stay in one name; [0-9] is a class", () => {
    const re = globToRegExp("**/[0-9][0-9].01 Inbox/*.md");
    assert.ok(re.test("10-19 Personal/10 Management/10.01 Inbox/Note.md"));
    assert.ok(re.test("80-89 Divorce/80 Management/80.01 Inbox/Note.md"));
    assert.ok(re.test("00.01 Inbox/Note.md"), "** with no folder");
    assert.ok(!re.test("10-19 Personal/10.01 Inbox/sub/Note.md"), "* does not cross a folder");
    assert.ok(!re.test("10-19 Personal/10.02 Tasks/Note.md"));
    assert.ok(!re.test("10-19 Personal/1x.01 Inbox/Note.md"));
    assert.ok(globToRegExp("a?c.md").test("abc.md") && !globToRegExp("a?c.md").test("a/c.md"));
    assert.ok(globToRegExp("Notes/**").test("Notes/a/b/c.md"));
    assert.ok(globToRegExp("a.b/(x)+.md").test("a.b/(x)+.md") && !globToRegExp("a.b/x.md").test("aXb/x.md"), "regex characters are literal");
  });

  test("a character class never matches a folder separator", () => {
    assert.ok(!globToRegExp("Inbox[^a]x.md").test("Inbox/x.md"), "^ negates, and / stays out");
    assert.ok(!globToRegExp("Inbox[!a]x.md").test("Inbox/x.md"));
    assert.ok(!globToRegExp("Inbox[+-0]x.md").test("Inbox/x.md"), "a range that spans / does not match it");
    assert.ok(globToRegExp("Inbox[+-0]x.md").test("Inbox-x.md"));
  });

  test("a path that climbs out or hides a folder in . or // is judged after normalising", () => {
    assert.equal(inWriteScope("A/10.01 Inbox/../10.02 Tasks/x.md", INBOX), false, "judged on where it really lands");
    assert.equal(inWriteScope("../x.md", { mode: "create-only", paths: ["**"] }), false, "outside the vault");
    assert.equal(inWriteScope("A/./10.01 Inbox/x.md", INBOX), true);
    assert.equal(inWriteScope("A//10.01 Inbox/x.md", INBOX), true);
    assert.equal(inWriteScope("/A/10.01 Inbox/x.md", INBOX), true, "a leading slash is dropped, as the vault does");
  });
});

describe("the setting", () => {
  test("absent reads as no rule; paths are trimmed strings", () => {
    assert.deepEqual(normalizeWriteScope(undefined), { mode: "all", paths: [] });
    assert.deepEqual(normalizeWriteScope(null), { mode: "all", paths: [] });
    assert.deepEqual(normalizeWriteScope({ mode: "all", paths: ["x"] }), { mode: "all", paths: [] });
    assert.deepEqual(normalizeWriteScope({ mode: "create-only", paths: [" /a/*.md ", "", 3] }), { mode: "create-only", paths: ["a/*.md"] });
  });

  test("a value that is present but wrong closes every write, never opens them", () => {
    for (const bad of [{ mode: "create_only", paths: ["a/*.md"] }, { mode: "createOnly" }, { mode: "Create-only" }, { mode: null }, {}, "create-only", 3, [], { mode: "create-only", paths: "a/*.md" }]) {
      assert.deepEqual(normalizeWriteScope(bad), { mode: "create-only", paths: [] }, JSON.stringify(bad));
    }
  });

  test("a pattern that does not compile is dropped, which narrows the scope", () => {
    assert.deepEqual(normalizeWriteScope({ mode: "create-only", paths: ["[z-a].md", "ok/*.md"] }).paths, ["ok/*.md"]);
  });
});

describe("the refusal", () => {
  test("mode all: nothing is refused", () => {
    assert.equal(writeScopeRefusal("obsidian_delete_note", { path: "x.md" }, ["x.md"], { mode: "all", paths: [] }, none), null);
  });

  test("create-only: a new note in scope is allowed, by write_note and by a batch item", () => {
    assert.equal(writeScopeRefusal("obsidian_write_note", { path: "A/10.01 Inbox/n.md", content: "x" }, ["A/10.01 Inbox/n.md"], INBOX, folders), null);
    assert.equal(writeScopeRefusal("obsidian_write_notes", { path: "A/10.01 Inbox/n.md", content: "x", overwrite: true, create_only: true }, ["A/10.01 Inbox/n.md"], INBOX, folders), null);
  });

  test("create-only refuses: outside the scope, an existing note, an overwrite, a batch overwrite", () => {
    const r1 = writeScopeRefusal("obsidian_write_note", { path: "A/10.02 Tasks/n.md" }, ["A/10.02 Tasks/n.md"], INBOX, none);
    assert.equal(r1.code, "write_scope");
    assert.match(r1.message, /is not one of them\. Nothing was written\.$/);
    assert.match(writeScopeRefusal("obsidian_write_note", { path: "A/10.01 Inbox/n.md" }, ["A/10.01 Inbox/n.md"], INBOX, () => true).message, /already exists/);
    assert.match(writeScopeRefusal("obsidian_write_note", { path: "A/10.01 Inbox/n.md", overwrite: true }, ["A/10.01 Inbox/n.md"], INBOX, none).message, /replace a note/);
    assert.match(writeScopeRefusal("obsidian_write_notes", { path: "A/10.01 Inbox/n.md", overwrite: true, create_only: false }, ["A/10.01 Inbox/n.md"], INBOX, none).message, /replace a note/);
  });

  test("create-only refuses every other write, whatever its paths: edit, append, frontmatter, move, delete, trash, command, an unknown tool", () => {
    for (const tool of ["obsidian_patch_note", "obsidian_append_note", "obsidian_manage_frontmatter", "obsidian_move_note", "obsidian_move_notes", "obsidian_delete_note", "obsidian_trash", "obsidian_run_command", "obsidian_snippet_write", "some_satellite_tool"]) {
      const r = writeScopeRefusal(tool, { path: "A/10.01 Inbox/n.md" }, ["A/10.01 Inbox/n.md"], INBOX, none);
      assert.equal(r?.code, "write_scope", tool);
    }
  });

  test("a create in a folder that is not there yet is refused: no new folders", () => {
    const r = writeScopeRefusalForPath("obsidian_write_note", "New/Tree/99.01 Inbox/x.md", INBOX, folders);
    assert.equal(r?.code, "write_scope");
    assert.match(r.message, /'New\/Tree\/99\.01 Inbox' does not/);
    assert.equal(writeScopeRefusalForPath("obsidian_write_note", "00.01 Inbox.md", { mode: "create-only", paths: ["*.md"] }, none), null, "the vault root is always there");
  });

  test("a create naming two paths is refused", () => {
    assert.equal(writeScopeRefusal("obsidian_write_note", { path: "a", x: "b" }, ["A/10.01 Inbox/a.md", "A/10.01 Inbox/b.md"], INBOX, none)?.code, "write_scope");
  });

  test("a computed-path create (obsidian_create_note) passes the call check and is judged on its path", () => {
    assert.equal(writeScopeRefusal("obsidian_create_note", { class: "Note", title: "t" }, [], INBOX, none), null);
    assert.equal(writeScopeRefusalForPath("obsidian_create_note", "A/10.01 Inbox/t.md", INBOX, folders), null);
    assert.equal(writeScopeRefusalForPath("obsidian_create_note", "A/10.02 Tasks/t.md", INBOX, none)?.code, "write_scope");
    assert.equal(writeScopeRefusalForPath("obsidian_create_note", "A/10.01 Inbox/t.md", INBOX, () => true)?.code, "write_scope");
  });
});
