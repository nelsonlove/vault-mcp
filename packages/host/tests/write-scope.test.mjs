// The write scope on the plugin (core's write-scope.ts): checked in the guarded
// wrapper every mutating tool passes, before the handler runs, on the resolved args.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { makeGuarded } = await import("../src/mcp/guarded.ts");

const RW = { annotations: { readOnlyHint: false } };
const RO = { annotations: { readOnlyHint: true } };
const SCOPE = { mode: "create-only", paths: ["**/[0-9][0-9].01 Inbox/*.md"] };

function harness(writeScope, existing = []) {
  const have = new Set(existing);
  const calls = [];
  const settings = { readOnly: false, allowlist: [], writeScope };
  const guarded = makeGuarded({ getSettings: () => settings, noteExists: (p) => have.has(p) });
  const tool = (name, def = RW) => guarded(def, async (args) => { calls.push({ name, args }); return { content: [{ type: "text", text: "ok" }] }; }, name);
  return { tool, calls, settings };
}
const text = (r) => r.content[0].text;

describe("the write scope in the guarded wrapper", () => {
  test("off (mode all): every write runs", async () => {
    const h = harness({ mode: "all", paths: [] });
    const r = await h.tool("obsidian_patch_note")({ path: "A/10.02 Tasks/x.md", anchor: "h", op: "replace", content: "x" }, {});
    assert.equal(text(r), "ok");
  });

  test("create-only: a new note in scope runs; the handler is reached", async () => {
    const h = harness(SCOPE);
    const r = await h.tool("obsidian_write_note")({ path: "10-19 Personal/10 Management/10.01 Inbox/New.md", content: "x" }, {});
    assert.equal(text(r), "ok");
    assert.equal(h.calls.length, 1);
  });

  test("create-only: outside the scope, an existing note, an overwrite and an edit are refused before the handler", async () => {
    const h = harness(SCOPE, ["A/10.01 Inbox/Old.md"]);
    for (const [name, args, why] of [
      ["obsidian_write_note", { path: "A/10.02 Tasks/New.md", content: "x" }, /is not one of them/],
      ["obsidian_write_note", { path: "A/10.01 Inbox/Old.md", content: "x" }, /already exists/],
      ["obsidian_write_note", { path: "A/10.01 Inbox/New.md", content: "x", overwrite: true }, /replace a note/],
      ["obsidian_write_notes", { path: "A/10.01 Inbox/New.md", content: "x", overwrite: true, create_only: false }, /replace a note/],
      ["obsidian_patch_note", { path: "A/10.01 Inbox/Old.md", anchor: "h", op: "append", content: "x" }, /does not allow/],
      ["obsidian_move_note", { from: "A/10.01 Inbox/Old.md", to: "A/10.01 Inbox/Moved.md" }, /does not allow/],
      ["obsidian_delete_note", { path: "A/10.01 Inbox/Old.md", confirm: true }, /does not allow/],
    ]) {
      const r = await h.tool(name)(args, {});
      assert.match(text(r), /^Error \[write_scope\]: /, name);
      assert.match(text(r), why, name);
    }
    assert.equal(h.calls.length, 0, "no handler ran");
  });

  test("a batch item that creates (create_only) in scope runs", async () => {
    const h = harness(SCOPE);
    const r = await h.tool("obsidian_write_notes")({ path: "A/10.01 Inbox/Item.md", content: "x", overwrite: true, create_only: true }, {});
    assert.equal(text(r), "ok");
  });

  test("reads are untouched by the write scope", async () => {
    const h = harness({ mode: "create-only", paths: [] });
    const r = await h.tool("obsidian_read_note", RO)({ path: "Anywhere/Any.md" }, {});
    assert.equal(text(r), "ok");
  });

  test("live: widening the setting takes effect on the next call", async () => {
    const h = harness({ mode: "create-only", paths: [] });
    const write = h.tool("obsidian_write_note");
    assert.match(text(await write({ path: "X/New.md", content: "x" }, {})), /write_scope/);
    h.settings.writeScope = { mode: "create-only", paths: ["X/*.md"] };
    assert.equal(text(await write({ path: "X/New.md", content: "x" }, {})), "ok");
  });
});

describe("the setting reaches the server", () => {
  test("main.ts forwards writeScope in getSettings, and the create tool checks its computed path", async () => {
    const fs = await import("node:fs");
    const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    assert.match(main, /writeScope:\s*this\.settings\.writeScope,/);
    const cn = fs.readFileSync(new URL("../src/mcp/tools-create-note.ts", import.meta.url), "utf8");
    assert.match(cn, /writeScopeRefusalForPath\(CREATE_NOTE_TOOL, path,/);
  });
});
