/**
 * cli-policy.test.mjs — the command allow/deny policy (mcp/cli-policy.ts)
 * closing the accept-scar's opaque residual, and its wiring into the
 * obsidian_cli handler.
 *
 * Load-bearing properties:
 *   • the opaque-accept set is DENIED BY DEFAULT (fail closed) on both
 *     surfaces — obsidian_cli commands and obsidian_run_command ids;
 *   • re-enable is per-command by an exact entry, or per family of command ids by a
 *     trailing-* entry, which never reaches a CLI command or an accept verb;
 *   • deny ALWAYS wins — over allowOpaque, over defaults;
 *   • the policy composes with the danger gate: a re-enabled `eval` still
 *     needs allowDangerousCli;
 *   • refusals are typed Error [cli_denied], and nothing executes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeServer } from "./fake-server.mjs";
import {
  OPAQUE_ACCEPT_CLI_COMMANDS,
  OPAQUE_ACCEPT_COMMAND_IDS,
  UNINSPECTABLE_WRITE_CLI_COMMANDS,
  cliCommandRefusal,
  configPathRefusal,
  matchesCommandPattern,
  runCommandRefusal,
  isAcceptVerbCommandId,
  reenabledOpaqueCommandIds,
} from "../src/mcp/cli-policy.ts";
import { registerCliTools } from "../src/mcp/tools-cli.ts";

describe("matchesCommandPattern", () => {
  test("exact match, no substring leakage", () => {
    assert.equal(matchesCommandPattern("quickadd", "quickadd"), true);
    assert.equal(matchesCommandPattern("quickadd:run", "quickadd"), false);
    assert.equal(matchesCommandPattern("myquickadd", "quickadd"), false);
  });

  test("trailing * is a prefix glob", () => {
    assert.equal(matchesCommandPattern("quickadd:runQuickAdd", "quickadd:*"), true);
    assert.equal(matchesCommandPattern("quickadd", "quickadd:*"), false);
    assert.equal(matchesCommandPattern("anything-at-all", "*"), true);
  });

  test("case-sensitive (matches the danger gate's discipline)", () => {
    assert.equal(matchesCommandPattern("Eval", "eval"), false);
  });

  test("empty pattern matches nothing", () => {
    assert.equal(matchesCommandPattern("x", ""), false);
    assert.equal(matchesCommandPattern("x", "  "), false);
  });
});

describe("cliCommandRefusal: the opaque-accept default", () => {
  test("every opaque-accept command is denied with no policy at all", () => {
    for (const cmd of OPAQUE_ACCEPT_CLI_COMMANDS) {
      assert.ok(cliCommandRefusal(cmd), `${cmd} must be denied by default`);
      assert.ok(cliCommandRefusal(cmd, {}), `${cmd} must be denied with an empty policy`);
    }
  });

  test("ordinary commands are untouched", () => {
    for (const cmd of ["help", "history:list", "theme:set", "property:get", "create"]) {
      assert.equal(cliCommandRefusal(cmd, {}), null, cmd);
    }
  });

  test("allowOpaque re-enables exactly the named command", () => {
    const policy = { allowOpaque: ["quickadd"] };
    assert.equal(cliCommandRefusal("quickadd", policy), null);
    assert.ok(cliCommandRefusal("quickadd:run", policy), "quickadd:run stays denied");
    assert.ok(cliCommandRefusal("eval", policy), "eval stays denied");
  });

  test("deny beats allowOpaque", () => {
    const policy = { deny: ["quickadd"], allowOpaque: ["quickadd"] };
    assert.ok(cliCommandRefusal("quickadd", policy));
  });

  test("deny extends to arbitrary commands, exact or glob", () => {
    const policy = { deny: ["history:restore", "theme:*"] };
    assert.ok(cliCommandRefusal("history:restore", policy));
    assert.ok(cliCommandRefusal("theme:set", policy));
    assert.equal(cliCommandRefusal("history:list", policy), null);
  });
});

describe("cliCommandRefusal: history:restore uninspectable-write default-deny (#110)", () => {
  test("history:restore is denied by default (no policy / empty policy)", () => {
    assert.ok(cliCommandRefusal("history:restore"), "denied with no policy");
    assert.ok(cliCommandRefusal("history:restore", {}), "denied with an empty policy");
    // The exported set is exactly this one command.
    assert.deepEqual([...UNINSPECTABLE_WRITE_CLI_COMMANDS], ["history:restore"]);
  });

  test("the refusal names the restore/revoked-acceptance reason", () => {
    const reason = cliCommandRefusal("history:restore");
    assert.match(reason, /restores note content/);
    assert.match(reason, /reintroduce an accepted value a human revoked/);
  });

  test("sibling history commands stay allowed", () => {
    for (const cmd of ["history", "history:list", "diff"]) {
      assert.equal(cliCommandRefusal(cmd, {}), null, cmd);
    }
  });

  test("a human re-enables it per-command via allowOpaque; deny still beats allow", () => {
    assert.equal(cliCommandRefusal("history:restore", { allowOpaque: ["history:restore"] }), null);
    assert.ok(cliCommandRefusal("history:restore", { deny: ["history:restore"], allowOpaque: ["history:restore"] }));
  });

  test("re-enabling history:restore does not re-enable the opaque-accept set", () => {
    const policy = { allowOpaque: ["history:restore"] };
    for (const cmd of OPAQUE_ACCEPT_CLI_COMMANDS) assert.ok(cliCommandRefusal(cmd, policy), cmd);
  });
});

describe("runCommandRefusal: command ids", () => {
  test("quickadd:* ids are denied by default; ordinary ids are not", () => {
    assert.ok(runCommandRefusal("quickadd:runQuickAdd", {}));
    assert.equal(runCommandRefusal("editor:toggle-bold", {}), null);
    assert.equal(runCommandRefusal("daily-notes", {}), null);
  });

  test("allowOpaque: an exact entry re-enables one id; a trailing-* entry re-enables a family of command ids", () => {
    assert.equal(runCommandRefusal("quickadd:runQuickAdd", { allowOpaque: ["quickadd:runQuickAdd"] }), null);
    assert.ok(runCommandRefusal("quickadd:toggleMacro", { allowOpaque: ["quickadd:runQuickAdd"] }));
    // A glob is honoured for command ids (Nelson, 2026-10-14).
    assert.equal(runCommandRefusal("quickadd:toggleMacro", { allowOpaque: ["quickadd:*"] }), null);
    assert.equal(runCommandRefusal("quickadd:choice:qan:Notes/New idea.md#choice", { allowOpaque: ["quickadd:choice:*"] }), null);
    assert.ok(runCommandRefusal("quickadd:toggleMacro", { allowOpaque: ["quickadd:choice:*"] }), "outside the family");
  });

  test("a glob never re-enables an accept verb's QuickAdd choice; only an exact entry can", () => {
    const policy = { allowOpaque: ["quickadd:*", "quickadd:choice:*"] };
    for (const verb of ["Verify current note", "Reopen current note", "Request revision", "Answer current note", "Reject current note"]) {
      const id = `quickadd:choice:qan:00-09 System/00 System management/00.14 QuickAdd choices/${verb}.md#choice`;
      assert.ok(runCommandRefusal(id, policy), verb);
      assert.equal(isAcceptVerbCommandId(id), true, verb);
    }
    const exact = "quickadd:choice:qan:00-09 System/00 System management/00.14 QuickAdd choices/Verify current note.md#choice";
    assert.equal(runCommandRefusal(exact, { allowOpaque: [exact] }), null, "an exact entry is the human naming that one command");
    assert.equal(isAcceptVerbCommandId("quickadd:choice:qan:Notes/Verify current note draft.md#choice"), false);
  });

  test("Never re-enable stops a glob, not an exact entry (01.41 pick A)", () => {
    const priv = "quickadd:choice:qan:Notes/Pay the rent.md#choice";
    const other = "quickadd:choice:qan:Notes/New note.md#choice";
    const policy = { allowOpaque: ["quickadd:*"], neverOpaque: [priv] };
    assert.ok(runCommandRefusal(priv, policy), "a never-listed id stays refused under a glob");
    assert.equal(runCommandRefusal(other, policy), null, "the glob still opens the others");
    assert.equal(runCommandRefusal(priv, { allowOpaque: ["quickadd:*", priv], neverOpaque: [priv] }), null, "an exact re-enable is a deliberate act");
    assert.ok(runCommandRefusal("quickadd:choice:qan:Private/x.md#choice", { allowOpaque: ["quickadd:*"], neverOpaque: ["quickadd:choice:qan:Private/*"] }), "a prefix on the never list");
    assert.ok(runCommandRefusal(other, { allowOpaque: ["quickadd:*"], neverOpaque: [priv], deny: [other] }), "deny still wins");
  });

  test("reenabledOpaqueCommandIds lists what the policy opens today, sorted, opaque families only", () => {
    const ids = [
      "quickadd:choice:qan:Notes/B.md#choice",
      "quickadd:choice:qan:Notes/A.md#choice",
      "quickadd:choice:qan:Notes/Verify current note.md#choice",
      "js-engine:run",
      "editor:toggle-bold",
    ];
    assert.deepEqual(reenabledOpaqueCommandIds(ids, { allowOpaque: [] }), []);
    assert.deepEqual(reenabledOpaqueCommandIds(ids, { allowOpaque: ["quickadd:*"], neverOpaque: ["quickadd:choice:qan:Notes/B.md#choice"] }), [
      "quickadd:choice:qan:Notes/A.md#choice",
    ]);
    assert.deepEqual(reenabledOpaqueCommandIds(ids, { allowOpaque: ["js-engine:run"] }), ["js-engine:run"]);
  });

  test("deny still wins over a glob re-enable", () => {
    assert.ok(runCommandRefusal("quickadd:toggleMacro", { allowOpaque: ["quickadd:*"], deny: ["quickadd:toggleMacro"] }));
  });

  test("no cross-surface leak: a run_command-shaped allowOpaque entry does not re-enable CLI commands", () => {
    // The same allowOpaque list serves both surfaces. An entry meant for
    // run_command ids ('quickadd:*') must not silently re-enable the CLI's
    // quickadd:run / quickadd:run-template.
    const policy = { allowOpaque: ["quickadd:*"] };
    assert.ok(cliCommandRefusal("quickadd:run", policy));
    assert.ok(cliCommandRefusal("quickadd:run-template", policy));
    assert.ok(cliCommandRefusal("quickadd", policy));
  });

  test("deny beats allowOpaque for ids too", () => {
    assert.ok(runCommandRefusal("quickadd:runQuickAdd", { deny: ["quickadd:*"], allowOpaque: ["quickadd:runQuickAdd"] }));
  });

  test("the default id set is exactly the QuickAdd and js-engine prefixes", () => {
    assert.deepEqual([...OPAQUE_ACCEPT_COMMAND_IDS], ["quickadd:*", "js-engine:*"]);
  });

  test("the default CLI command set is exactly the five opaque-execution spellings", () => {
    // NON-WEAKENING PIN. The exact set used to be asserted a second time in the
    // host's triage-module suite, so that a triage change relaxing it failed
    // there too. Triage left for its own plugin at S5 and cannot import these
    // constants, so the pin consolidates HERE — the one place that owns them.
    // The satellite keeps its own half of the claim (its agent-facing surface
    // is a disposition id, never a command id or macro name) in its suite.
    assert.deepEqual(
      [...OPAQUE_ACCEPT_CLI_COMMANDS],
      ["quickadd", "quickadd:run", "quickadd:run-template", "eval", "command"],
    );
  });

  test("js-engine:* ids are denied by default — both built-in execute and vault-minted cmd-* ids", () => {
    // js-engine's commands execute arbitrary vault JS: the built-in file
    // runner, and the `js-engine:cmd-*` ids a register-commands startup
    // script mints from files an agent can WRITE through the guarded path
    // (a JS body carries no acceptance frontmatter, so the accept-guard
    // rightly passes the write) — the #105 laundering class on a new surface.
    assert.ok(runCommandRefusal("js-engine:execute-js-file", {}));
    assert.ok(runCommandRefusal("js-engine:cmd-stamp-accepted", {}));
    // Ordinary plugin ids stay allowed.
    assert.equal(runCommandRefusal("editor:toggle-bold", {}), null);
  });

  test("js-engine re-enable: exact for one id, a glob for a family, same as quickadd", () => {
    assert.equal(runCommandRefusal("js-engine:cmd-unfill-paragraph", { allowOpaque: ["js-engine:cmd-unfill-paragraph"] }), null);
    assert.ok(runCommandRefusal("js-engine:execute-js-file", { allowOpaque: ["js-engine:cmd-unfill-paragraph"] }));
    assert.equal(runCommandRefusal("js-engine:cmd-other", { allowOpaque: ["js-engine:*"] }), null);
  });
});

describe("configPathRefusal: config territory unreachable through the proxy", () => {
  test(".obsidian paths refuse in any param, any separator style", () => {
    assert.ok(configPathRefusal({ file: ".obsidian/plugins/vault-mcp/data.json" }));
    assert.ok(configPathRefusal({ path: "./.obsidian/app.json" }));
    assert.ok(configPathRefusal({ target: "sub\\.obsidian\\x" }));
  });

  test(".. traversal refuses; lookalikes stay clean", () => {
    assert.ok(configPathRefusal({ file: "../outside.md" }));
    assert.ok(configPathRefusal({ file: "a/../../b.md" }));
    assert.equal(configPathRefusal({ file: "notes/x.obsidian.md" }), null);
    assert.equal(configPathRefusal({ file: "notes/dots..in..name.md" }), null);
    assert.equal(configPathRefusal({ file: "Projects/A.md", content: "hello" }), null);
    assert.equal(configPathRefusal(undefined), null);
  });

  test("non-string params are ignored", () => {
    assert.equal(configPathRefusal({ silent: true, depth: 3 }), null);
  });

  test("case-fold: .Obsidian / .OBSIDIAN / mixed case all refuse (APFS is case-insensitive)", () => {
    // On macOS's default case-insensitive APFS, ".Obsidian" resolves to
    // ".obsidian", so any casing must be caught or the backstop leaks.
    assert.ok(configPathRefusal({ file: ".Obsidian/plugins/vault-mcp/data.json" }));
    assert.ok(configPathRefusal({ file: ".OBSIDIAN/plugins/vault-mcp/data.json" }));
    assert.ok(configPathRefusal({ file: ".oBsIdIaN/community-plugins.json" }));
    assert.ok(configPathRefusal({ target: "sub\\.Obsidian\\x" }));
    // A benign lookalike still stays clean regardless of casing.
    assert.equal(configPathRefusal({ file: "notes/X.Obsidian.md" }), null);
  });

  test("path-valued flags are scanned too (--file=.obsidian/… escapes params otherwise)", () => {
    assert.ok(configPathRefusal(undefined, ["--file=.obsidian/plugins/vault-mcp/data.json"]));
    assert.ok(configPathRefusal(undefined, ["--file=.Obsidian/plugins/vault-mcp/data.json"]));
    assert.ok(configPathRefusal(undefined, ["--path=../outside.md"]));
    assert.ok(configPathRefusal(undefined, ["--target=sub\\.OBSIDIAN\\x"]));
    // Boolean/format flags (no '=value') and clean path flags stay allowed.
    assert.equal(configPathRefusal(undefined, ["--json"]), null);
    assert.equal(configPathRefusal(undefined, ["--file=Projects/A.md"]), null);
    assert.equal(configPathRefusal({ file: "Projects/A.md" }, ["--json"]), null);
  });
});

// ── handler integration: the policy refuses BEFORE anything executes ─────────

function ctxWith(settings) {
  return {
    pluginVersion: "0.0.0-test",
    socketPath: "/tmp/x.sock",
    vaultName: "testvault",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [], allowDangerousCli: false, rawCliProxy: true, ...settings }),
  };
}

function cliServer(settings) {
  const server = fakeServer();
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: "ran", stderr: "", timedOut: false };
  };
  registerCliTools(server, ctxWith(settings), { binary: "/bin/obsidian", exec });
  return { handler: server.tools.get("obsidian_cli").handler, calls };
}

describe("obsidian_cli handler: policy wiring", () => {
  test("quickadd is refused typed cli_denied and never executes", async () => {
    const { handler, calls } = cliServer({});
    const res = await handler({ command: "quickadd", params: { choice: "My Macro" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[cli_denied\]/);
    assert.equal(calls.length, 0);
  });

  test("allowOpaque re-enables quickadd; the sibling commands stay denied", async () => {
    const { handler, calls } = cliServer({ cliPolicy: { deny: [], allowOpaque: ["quickadd"] } });
    const ok = await handler({ command: "quickadd", params: { choice: "My Macro" } });
    assert.notEqual(ok.isError, true);
    assert.equal(calls.length, 1);
    const denied = await handler({ command: "quickadd:run" });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /cli_denied/);
  });

  test("policy composes with the danger gate: re-enabled eval still danger-blocked", async () => {
    const { handler, calls } = cliServer({ cliPolicy: { deny: [], allowOpaque: ["eval"] } });
    const res = await handler({ command: "eval", params: { code: "1+1" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /dangerous/);
    assert.equal(calls.length, 0);
  });

  test("re-enabled eval + allowDangerousCli runs", async () => {
    const { handler, calls } = cliServer({
      allowDangerousCli: true,
      cliPolicy: { deny: [], allowOpaque: ["eval"] },
    });
    const res = await handler({ command: "eval", params: { code: "1+1" } });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });

  test("eval with allowDangerousCli but WITHOUT allowOpaque is policy-denied (the new fail-closed default)", async () => {
    const { handler, calls } = cliServer({ allowDangerousCli: true });
    const res = await handler({ command: "eval", params: { code: "1+1" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.equal(calls.length, 0);
  });

  test("a param naming .obsidian territory refuses cli_denied and never executes", async () => {
    const { handler, calls } = cliServer({});
    const res = await handler({ command: "create", params: { file: ".obsidian/plugins/vault-mcp/data.json", content: "x" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.match(res.content[0].text, /\.obsidian territory/);
    assert.equal(calls.length, 0);
  });

  test("a case-folded .Obsidian param refuses cli_denied and never executes", async () => {
    const { handler, calls } = cliServer({});
    const res = await handler({ command: "create", params: { file: ".Obsidian/plugins/vault-mcp/data.json", content: "x" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.match(res.content[0].text, /\.obsidian territory/);
    assert.equal(calls.length, 0);
  });

  test("a path-valued flag naming .obsidian refuses cli_denied and never executes", async () => {
    for (const command of ["create", "prepend"]) {
      const { handler, calls } = cliServer({});
      const res = await handler({ command, flags: ["--file=.obsidian/plugins/vault-mcp/data.json"] });
      assert.equal(res.isError, true, command);
      assert.match(res.content[0].text, /cli_denied/, command);
      assert.match(res.content[0].text, /\.obsidian territory/, command);
      assert.equal(calls.length, 0, command);
    }
  });

  test("settings deny list blocks an otherwise-ordinary command", async () => {
    const { handler, calls } = cliServer({ cliPolicy: { deny: ["theme:set"], allowOpaque: [] } });
    const res = await handler({ command: "theme:set", params: { name: "Nord" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.equal(calls.length, 0);
    const fine = await handler({ command: "history:list", params: { file: "A.md" } });
    assert.notEqual(fine.isError, true);
  });

  test("history:restore is refused typed cli_denied by default and never executes (#110)", async () => {
    const { handler, calls } = cliServer({});
    const res = await handler({ command: "history:restore", params: { file: "A.md", version: "3" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[cli_denied\]/);
    assert.equal(calls.length, 0);
  });

  test("a human re-enabling history:restore via allowOpaque lets it run (#110)", async () => {
    const { handler, calls } = cliServer({ cliPolicy: { deny: [], allowOpaque: ["history:restore"] } });
    const res = await handler({ command: "history:restore", params: { file: "A.md", version: "3" } });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
    // history:list is unaffected either way.
    const list = await handler({ command: "history:list", params: { file: "A.md" } });
    assert.notEqual(list.isError, true);
  });
});
