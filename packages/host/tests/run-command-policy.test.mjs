/**
 * run-command-policy.test.mjs — the command policy wired into the REAL
 * `obsidian_run_command` handler (tools-complementary.ts).
 *
 * Uses the obsidian stub (sparingly, per its own charter): the property under
 * test — a policy-refused command id executes NOTHING, not even the
 * `file_path` open that precedes execution — is a property of the real
 * handler's ordering, not of a re-implementation. The pure policy semantics
 * are covered in cli-policy.test.mjs; this file pins only the wiring.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import { installObsidianStub } from "./obsidian-stub.mjs";

installObsidianStub();
const { registerComplementaryTools } = await import("../src/mcp/tools-complementary.ts");
const { hashScript } = await import("../src/mcp/cli-policy.ts");

function build(settings = {}, { quickadd, files = {} } = {}) {
  const server = fakeServer();
  const opened = [];
  const executed = [];
  const app = {
    workspace: { openLinkText: async (p) => opened.push(p) },
    commands: { executeCommandById: (id) => (executed.push(id), true) },
    vault: {
      getMarkdownFiles: () => [],
      getName: () => "test",
      getAbstractFileByPath: (p) => (p in files ? { path: p, extension: "md" } : null),
      read: async (f) => files[f.path],
    },
    metadataCache: {},
    plugins: { plugins: quickadd ? { quickadd } : {} },
  };
  const ctx = {
    pluginVersion: "0.0.0-test",
    socketPath: "/tmp/x.sock",
    vaultName: "test",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [], ...settings }),
  };
  registerComplementaryTools(server, app, ctx);
  return { handler: server.tools.get("obsidian_run_command").handler, opened, executed };
}

// A fake QuickAdd plugin instance: one choice, id "abc", name "My Choice".
// executeChoice records what it was called with and either resolves or
// rejects, matching the real API's behavior (errors thrown inside a script
// propagate through executeChoice's own await chain).
function fakeQuickAdd({ throws } = {}) {
  const calls = [];
  return {
    calls,
    getChoiceById: (id) => {
      if (id !== "abc") throw new Error(`Choice ${id} not found`);
      return { id: "abc", name: "My Choice" };
    },
    api: {
      executeChoice: async (name, vars) => {
        calls.push({ name, vars });
        if (throws) throw throws;
      },
    },
  };
}

describe("obsidian_run_command: policy wiring in the real handler", () => {
  test("a quickadd:* id is refused cli_denied BEFORE the file_path open", async () => {
    const { handler, opened, executed } = build();
    const res = await handler({ command_id: "quickadd:runQuickAdd", file_path: "Inbox/Note.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[cli_denied\]/);
    assert.deepEqual(opened, []);
    assert.deepEqual(executed, []);
  });

  test("an ordinary id executes, with the file_path opened first", async () => {
    const { handler, opened, executed } = build();
    const res = await handler({ command_id: "editor:toggle-bold", file_path: "Inbox/Note.md" });
    assert.notEqual(res.isError, true);
    assert.deepEqual(opened, ["Inbox/Note.md"]);
    assert.deepEqual(executed, ["editor:toggle-bold"]);
  });

  test("an exact allowOpaque entry re-enables exactly that id", async () => {
    const { handler, executed } = build({ cliPolicy: { deny: [], allowOpaque: ["quickadd:runQuickAdd"] } });
    const ok = await handler({ command_id: "quickadd:runQuickAdd" });
    assert.notEqual(ok.isError, true);
    assert.deepEqual(executed, ["quickadd:runQuickAdd"]);
    const denied = await handler({ command_id: "quickadd:toggleMacro" });
    assert.equal(denied.isError, true);
  });

  test("the settings deny list gates ordinary ids too", async () => {
    const { handler, executed } = build({ cliPolicy: { deny: ["templater:*"], allowOpaque: [] } });
    const res = await handler({ command_id: "templater:insert" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.deepEqual(executed, []);
  });
});

describe("obsidian_run_command: an id a wildcard opened is checked against its script snapshot (01.41 pick A)", () => {
  const id = "quickadd:choice:abc";
  const settingsFor = (hash) => ({
    cliPolicy: { deny: [], allowOpaque: [id], neverOpaque: [], opaqueWildcards: ["quickadd:choice:*"], opaqueSnapshot: { [id]: { scripts: { "S/x.md": hash } } } },
  });
  const quickaddWithScript = () => {
    const q = fakeQuickAdd();
    q.settings = { choices: [{ id: "abc", name: "My Choice", type: "Macro", macro: { commands: [{ type: "UserScript", path: "S/x.md" }] } }] };
    return q;
  };

  test("the same script: it runs", async () => {
    const { handler, executed } = build(settingsFor(hashScript("v1")), { quickadd: quickaddWithScript(), files: { "S/x.md": "v1" } });
    const res = await handler({ command_id: id });
    assert.notEqual(res.isError, true);
    assert.deepEqual(executed, [id]);
  });

  test("a changed script: cli_denied before anything runs or opens", async () => {
    const { handler, executed, opened } = build(settingsFor(hashScript("v1")), { quickadd: quickaddWithScript(), files: { "S/x.md": "v2" } });
    const res = await handler({ command_id: id, file_path: "Inbox/Note.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[cli_denied\].*script changed since you saved the wildcard/);
    assert.deepEqual(executed, []);
    assert.deepEqual(opened, []);
  });
});

describe("obsidian_run_command: variables routes through QuickAdd's executeChoice", () => {
  test("a QuickAdd id with variables still needs allowOpaque — policy checked before the quickadd branch", async () => {
    const quickadd = fakeQuickAdd();
    const { handler } = build({ cliPolicy: { deny: [], allowOpaque: [] } }, { quickadd });
    const res = await handler({ command_id: "quickadd:choice:abc", variables: { foo: "bar" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[cli_denied\]/);
    assert.deepEqual(quickadd.calls, []);
  });

  test("resolves the choice id to its name and calls executeChoice, defaulting _invoked-by to agent", async () => {
    const quickadd = fakeQuickAdd();
    const { handler } = build({ cliPolicy: { deny: [], allowOpaque: ["quickadd:choice:abc"] } }, { quickadd });
    const res = await handler({ command_id: "quickadd:choice:abc", variables: { foo: "bar" } });
    assert.notEqual(res.isError, true);
    assert.deepEqual(quickadd.calls, [{ name: "My Choice", vars: { "_invoked-by": "agent", foo: "bar" } }]);
    assert.equal(res.structuredContent.choice, "My Choice");
  });

  test("an explicit _invoked-by overrides the default", async () => {
    const quickadd = fakeQuickAdd();
    const { handler } = build({ cliPolicy: { deny: [], allowOpaque: ["quickadd:choice:abc"] } }, { quickadd });
    await handler({ command_id: "quickadd:choice:abc", variables: { "_invoked-by": "human" } });
    assert.deepEqual(quickadd.calls, [{ name: "My Choice", vars: { "_invoked-by": "human" } }]);
  });

  test("a thrown script error (e.g. missing required variable) surfaces as a normal failure", async () => {
    const quickadd = fakeQuickAdd({ throws: new Error('Missing required variable "range"') });
    const { handler } = build({ cliPolicy: { deny: [], allowOpaque: ["quickadd:choice:abc"] } }, { quickadd });
    const res = await handler({ command_id: "quickadd:choice:abc", variables: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Missing required variable "range"/);
  });

  test("an unknown choice id is a typed refusal, not a crash", async () => {
    const quickadd = fakeQuickAdd();
    const { handler } = build({ cliPolicy: { deny: [], allowOpaque: ["quickadd:choice:nope"] } }, { quickadd });
    const res = await handler({ command_id: "quickadd:choice:nope", variables: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[choice_not_found\]/);
  });

  test("QuickAdd not installed/enabled is a typed refusal", async () => {
    const { handler } = build({ cliPolicy: { deny: [], allowOpaque: ["quickadd:choice:abc"] } });
    const res = await handler({ command_id: "quickadd:choice:abc", variables: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[quickadd_unavailable\]/);
  });

  test("no variables means the plain command path runs, unaffected", async () => {
    const quickadd = fakeQuickAdd();
    const { handler, executed } = build({ cliPolicy: { deny: [], allowOpaque: ["quickadd:choice:abc"] } }, { quickadd });
    const res = await handler({ command_id: "quickadd:choice:abc" });
    assert.notEqual(res.isError, true);
    assert.deepEqual(executed, ["quickadd:choice:abc"]);
    assert.deepEqual(quickadd.calls, []);
  });

  test("a non-QuickAdd command_id with variables runs the plain command path, per its own docs (`ignored otherwise`)", async () => {
    const quickadd = fakeQuickAdd();
    const { handler, executed } = build({}, { quickadd });
    const res = await handler({ command_id: "editor:toggle-bold", variables: { foo: "bar" } });
    assert.notEqual(res.isError, true);
    assert.deepEqual(executed, ["editor:toggle-bold"]);
    assert.deepEqual(quickadd.calls, []);
  });

  test("a non-QuickAdd command_id with variables runs fine even when QuickAdd isn't installed at all", async () => {
    const { handler, executed } = build({});
    const res = await handler({ command_id: "editor:toggle-bold", variables: { foo: "bar" } });
    assert.notEqual(res.isError, true);
    assert.deepEqual(executed, ["editor:toggle-bold"]);
  });
});
