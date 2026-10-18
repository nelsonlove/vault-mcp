// The connection profile (#521): names, resolution, and the call-time check.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { READ_PROFILE_TOOLS, READ_MESSAGE_PROFILE_TOOLS, MESSAGE_TOOL, INBOX_WRITE_SCOPE, PROFILE_NAMES, resolveProfile, profileAllows, profileCallRefusal } from "../src/profile.ts";
import { inWriteScope } from "../src/write-scope.ts";

describe("profiles", () => {
  test("the names a front may use", () => {
    assert.deepEqual([...PROFILE_NAMES].sort(), ["full", "read", "read+inbox", "read+message"]);
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

  test("read+message: exactly the 15 note reads plus the message tool; no write, no machine state", () => {
    const p = resolveProfile("read+message");
    assert.equal(READ_MESSAGE_PROFILE_TOOLS.length, 16);
    assert.equal(MESSAGE_TOOL, "vaultmcp_send_message");
    assert.deepEqual([...p.tools].sort(), [...READ_MESSAGE_PROFILE_TOOLS].sort());
    for (const t of READ_MESSAGE_PROFILE_TOOLS) if (t !== MESSAGE_TOOL) assert.ok(READ_PROFILE_TOOLS.includes(t), `${t} is also a read-profile tool`);
    for (const t of [
      "obsidian_write_note", "obsidian_write_notes", "obsidian_append_note", "obsidian_patch_note", "obsidian_create_note",
      "obsidian_call_tool", "obsidian_run_command", "obsidian_get_active_note", "obsidian_vault_info", "obsidian_environment_info",
      "obsidian_plugin_info", "obsidian_get_command_ids", "obsidian_list_bookmarks", "obsidian_list_workspaces", "obsidian_snippets_list",
      "obsidian_snippet_read", "vaultmcp_conformance_debt", "vaultmcp_bases_query", "obsidian_periodic_note", "obsidian_doctor",
    ]) assert.equal(profileAllows(p, t), false, t);
    assert.equal(p.writeScope, undefined);
    assert.equal(profileCallRefusal(p, MESSAGE_TOOL, true, { text: "hi" }, () => false), null, "the message tool is offered");
    assert.equal(profileCallRefusal(p, "obsidian_write_note", true, { path: "a.md" }, () => false)?.code, "profile_refused");
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
