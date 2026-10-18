// The connection profile (#521): names, resolution, and the call-time check.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { READ_PROFILE_TOOLS, INBOX_WRITE_SCOPE, PROFILE_NAMES, resolveProfile, profileAllows, profileCallRefusal } from "../src/profile.ts";
import { inWriteScope } from "../src/write-scope.ts";

describe("profiles", () => {
  test("the names a front may use", () => {
    assert.deepEqual([...PROFILE_NAMES].sort(), ["full", "read", "read+inbox"]);
  });

  test("absent is full; an unknown or malformed name is none (no tools), never full", () => {
    for (const v of [undefined, null, ""]) assert.equal(resolveProfile(v).name, "full");
    for (const v of ["admin", "READ", "(invalid)", 5, {}]) {
      const p = resolveProfile(v);
      assert.equal(p.name, "none");
      assert.equal(profileAllows(p, "obsidian_read_note"), false);
    }
  });

  test("read holds the 23 read tools and no write", () => {
    const p = resolveProfile("read");
    assert.equal(READ_PROFILE_TOOLS.length, 23);
    for (const t of READ_PROFILE_TOOLS) assert.ok(profileAllows(p, t), t);
    for (const t of ["obsidian_write_note", "obsidian_write_notes", "obsidian_call_tool", "obsidian_run_command"]) assert.equal(profileAllows(p, t), false, t);
    assert.equal(p.writeScope, undefined);
  });

  test("the call-time check refuses a name outside the profile", () => {
    const r = profileCallRefusal(resolveProfile("read"), "obsidian_delete_note", true, { path: "a.md" }, () => false);
    assert.equal(r?.code, "profile_refused");
    assert.equal(profileCallRefusal(resolveProfile("full"), "obsidian_delete_note", true, {}, () => false), null);
  });

  test("the inbox scope: a new note directly in a .01 slot folder, at any depth, only", () => {
    for (const p of ["00.01 Inbox/a.md", "00-09 System/00 System management/00.01 Inbox/a.md", "50-59 Study/50 Admin/50.01 Inbox/a.md", "AC.01/a.md"]) {
      assert.ok(inWriteScope(p, INBOX_WRITE_SCOPE), p);
    }
    for (const p of ["Notes/a.md", "00.01 Inbox/sub/a.md", "00.011 Inbox/a.md", "00.02 Tasks/a.md", "00.01 Inbox/../x/a.md", "00.01 Inbox/a.txt", "x00.01 Inbox/a.md"]) {
      assert.ok(!inWriteScope(p, INBOX_WRITE_SCOPE), p);
    }
  });

  test("read+inbox: a create in a .01 folder passes; an overwrite or another folder is refused", () => {
    const p = resolveProfile("read+inbox");
    const exists = (x) => x === "00.01 Inbox";
    assert.equal(profileCallRefusal(p, "obsidian_write_note", true, { path: "00.01 Inbox/a.md", content: "x" }, exists), null);
    assert.equal(profileCallRefusal(p, "obsidian_write_note", true, { path: "00.01 Inbox/a.md", content: "x", overwrite: true }, exists)?.code, "write_scope");
    assert.equal(profileCallRefusal(p, "obsidian_write_note", true, { path: "Notes/a.md", content: "x" }, exists)?.code, "write_scope");
    assert.equal(profileCallRefusal(p, "vaultmcp_bases_list", true, {}, exists), null, "a read by name is never write-scoped");
  });
});
