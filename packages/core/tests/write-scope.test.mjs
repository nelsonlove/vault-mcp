// The write scope (write-scope.ts): what a session may write, separate from what it may read.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, inWriteScope, normalizeWriteScope, writeScopeRefusal, writeScopeRefusalForPath } from "../src/write-scope.ts";

const INBOX = { mode: "create-only", paths: ["**/[0-9][0-9].01 Inbox/*.md"] };
const none = () => false;

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

  test("a path that climbs out or hides a folder in . or // is judged after normalising", () => {
    assert.equal(inWriteScope("A/10.01 Inbox/../10.02 Tasks/x.md", INBOX), false, "judged on where it really lands");
    assert.equal(inWriteScope("../x.md", { mode: "create-only", paths: ["**"] }), false, "outside the vault");
    assert.equal(inWriteScope("A/./10.01 Inbox/x.md", INBOX), true);
    assert.equal(inWriteScope("A//10.01 Inbox/x.md", INBOX), true);
    assert.equal(inWriteScope("/A/10.01 Inbox/x.md", INBOX), true, "a leading slash is dropped, as the vault does");
  });
});

describe("the setting", () => {
  test("absent or unclear reads as no rule; paths are trimmed strings", () => {
    assert.deepEqual(normalizeWriteScope(undefined), { mode: "all", paths: [] });
    assert.deepEqual(normalizeWriteScope({ mode: "create", paths: "x" }), { mode: "all", paths: [] });
    assert.deepEqual(normalizeWriteScope({ mode: "create-only", paths: [" /a/*.md ", "", 3] }), { mode: "create-only", paths: ["a/*.md"] });
  });
});

describe("the refusal", () => {
  test("mode all: nothing is refused", () => {
    assert.equal(writeScopeRefusal("obsidian_delete_note", { path: "x.md" }, ["x.md"], { mode: "all", paths: [] }, none), null);
  });

  test("create-only: a new note in scope is allowed, by write_note and by a batch item", () => {
    assert.equal(writeScopeRefusal("obsidian_write_note", { path: "A/10.01 Inbox/n.md", content: "x" }, ["A/10.01 Inbox/n.md"], INBOX, none), null);
    assert.equal(writeScopeRefusal("obsidian_write_notes", { path: "A/10.01 Inbox/n.md", content: "x", overwrite: true, create_only: true }, ["A/10.01 Inbox/n.md"], INBOX, none), null);
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

  test("a create naming two paths is refused", () => {
    assert.equal(writeScopeRefusal("obsidian_write_note", { path: "a", x: "b" }, ["A/10.01 Inbox/a.md", "A/10.01 Inbox/b.md"], INBOX, none)?.code, "write_scope");
  });

  test("a computed-path create (obsidian_create_note) passes the call check and is judged on its path", () => {
    assert.equal(writeScopeRefusal("obsidian_create_note", { class: "Note", title: "t" }, [], INBOX, none), null);
    assert.equal(writeScopeRefusalForPath("obsidian_create_note", "A/10.01 Inbox/t.md", INBOX, none), null);
    assert.equal(writeScopeRefusalForPath("obsidian_create_note", "A/10.02 Tasks/t.md", INBOX, none)?.code, "write_scope");
    assert.equal(writeScopeRefusalForPath("obsidian_create_note", "A/10.01 Inbox/t.md", INBOX, () => true)?.code, "write_scope");
  });
});
