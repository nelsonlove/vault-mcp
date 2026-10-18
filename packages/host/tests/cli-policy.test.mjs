/**
 * cli-policy.test.mjs — the command allow/deny policy (mcp/cli-policy.ts)
 * closing the accept-scar's opaque residual, and its wiring into the
 * obsidian_cli handler.
 *
 * Load-bearing properties:
 *   • the opaque-accept set is DENIED BY DEFAULT (fail closed) on both
 *     surfaces — obsidian_cli commands and obsidian_run_command ids;
 *   • re-enable is per-command by an exact entry; a trailing-* entry is expanded at the
 *     human's save into exact QuickAdd choice ids with a script snapshot each, and a
 *     stored wildcard opens nothing at call time;
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
  quickAddChoicesFrom,
  choiceIsOrRunsVerb,
  wildcardMayOpen,
  expandOpaqueWildcards,
  runCommandSnapshotRefusal,
  normalizeCliPolicy,
  hashScript,
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

// A QuickAdd settings object in the live shape (00.14 compiled ids), for the glob tests.
const VERB_SCRIPT = "00-09 System/00 System management/00.13 Scripts/verify-current-note.md";
const qa = (id, name, commands = []) => ({ id, name, type: "Macro", command: true, macro: { name, id: `${id}#macro`, commands } });
const QA_SETTINGS = {
  choices: [
    qa("qan:Q/Verify current note.md#choice", "Verify current note", [{ type: "UserScript", path: VERB_SCRIPT }]),
    qa("qan:Q/New idea.md#choice", "New idea", [{ type: "UserScript", path: "S/new-idea.md" }]),
    qa("qan:Q/Pay the rent.md#choice", "Pay the rent", [{ type: "UserScript", path: "S/rent.md" }]),
    qa("qan:Q/A.md#choice", "A"),
    qa("qan:Q/B.md#choice", "B"),
    qa("8f1c2d3e-uuid", "Verify current note"),
    qa("qan:Q/Copy.md#choice", "Tidy up", [{ type: "UserScript", path: VERB_SCRIPT }]),
    qa("qan:Q/Runs verb.md#choice", "Runs verb", [{ type: "Choice", choiceId: "qan:Q/Verify current note.md#choice" }]),
    qa("qan:Q/Runs cmd.md#choice", "Runs cmd", [{ type: "Conditional", thenCommands: [{ type: "Obsidian", commandId: "quickadd:choice:qan:Q/Verify current note.md#choice" }] }]),
    qa("qan:Q/Runs js.md#choice", "Runs js", [{ type: "Obsidian", commandId: "js-engine:execute-js-file" }]),
    qa("qan:Q/Cond.md#choice", "Check note", [{ type: "Conditional", condition: { mode: "script", scriptPath: VERB_SCRIPT, exportName: "default" }, thenCommands: [] }]),
    qa("qan:Q/Fmt.md#choice", "Format macro", [{ type: "Wait", note: "{{MACRO:Verify current note}}" }]),
    { id: "qan:Q/Capture.md#choice", name: "Capture idea", type: "Capture", command: true, format: { enabled: true, format: "{{VALUE}}" } },
    qa("qan:Q/AI.md#choice", "Ask AI", [{ type: "AIAssistant", promptTemplate: { enable: true, name: "Prompt" } }]),
    qa("qan:Q/SameId.md#choice", "Safe one"),
    qa("qan:Q/SameId.md#choice", "Other one"),
    qa("qan:Q/Dup1.md#choice", "Same name"),
    qa("qan:Q/Dup2.md#choice", "Same name"),
    { id: "multi", name: "Folder", type: "Multi", choices: [qa("qan:Q/Nested.md#choice", "Nested", [{ type: "NestedChoice", choice: qa("inner-1", "Reject current note") }])] },
  ],
};
const CHOICES = quickAddChoicesFrom(QA_SETTINGS);
const cid = (id) => `quickadd:choice:${id}`;

describe("wildcardMayOpen: a wildcard reaches resolvable, non-verb QuickAdd choices only (#552 review 1)", () => {
  test("a plain choice may open; the lookup is required", () => {
    assert.equal(wildcardMayOpen(cid("qan:Q/New idea.md#choice"), {}, CHOICES), true);
    assert.equal(wildcardMayOpen(cid("qan:Q/New idea.md#choice"), {}, undefined), false, "no lookup: fail closed");
    assert.equal(wildcardMayOpen(cid("qan:Q/New idea.md#choice"), {}, quickAddChoicesFrom(null)), false, "QuickAdd absent: fail closed");
    assert.equal(wildcardMayOpen(cid("qan:Q/Gone.md#choice"), {}, CHOICES), false, "an id that does not resolve");
  });
  test("a wildcard never opens a non-choice quickadd command or a js-engine id", () => {
    for (const id of ["quickadd:runQuickAdd", "quickadd:toggleMacro", "js-engine:cmd-other", "js-engine:execute-js-file"]) {
      assert.equal(wildcardMayOpen(id, {}, CHOICES), false, id);
    }
  });
  test("a verb is caught by its name, its pick-day variant, its script and through another choice", () => {
    for (const id of [
      "qan:Q/Verify current note.md#choice",
      "qan:Q/Verify current note.md#choice:pick-day",
      "8f1c2d3e-uuid",
      "8f1c2d3e-uuid:pick-day",
      "qan:Q/Copy.md#choice",
      "qan:Q/Runs verb.md#choice",
      "qan:Q/Runs cmd.md#choice",
      "qan:Q/Runs js.md#choice",
      "qan:Q/Nested.md#choice",
      "qan:Q/Cond.md#choice",
      "qan:Q/Fmt.md#choice",
      "qan:Q/Capture.md#choice",
      "qan:Q/Dup1.md#choice",
      "qan:Q/Dup2.md#choice",
      "qan:Q/AI.md#choice",
      "qan:Q/SameId.md#choice",
    ]) assert.equal(wildcardMayOpen(cid(id), {}, CHOICES), false, id);
    assert.equal(choiceIsOrRunsVerb("qan:Q/New idea.md#choice", CHOICES), false);
  });
  test("an exact entry still re-enables one verb (the human naming that one command)", () => {
    const id = cid("8f1c2d3e-uuid");
    assert.equal(runCommandRefusal(id, { allowOpaque: [id] }, CHOICES), null);
  });
});

// The scripts of the fixture choices, as a fake vault.
function fakeVault(files) {
  const store = new Map(Object.entries(files));
  return {
    store,
    read: async (path) => (store.has(path) ? store.get(path) : null),
  };
}
const SCRIPTS = { "S/new-idea.md": "module.exports = async () => 1;", "S/rent.md": "pay();", [VERB_SCRIPT]: "verify();" };
const ALL_IDS = [
  ...QA_SETTINGS.choices.filter((c) => c.type === "Macro").map((c) => cid(c.id)),
  cid("qan:Q/Nested.md#choice"),
  cid("qan:Q/Verify current note.md#choice:pick-day"),
  "quickadd:runQuickAdd",
  "js-engine:execute-js-file",
  "editor:toggle-bold",
];
const save = (input, prev, { ids = ALL_IDS, choices = CHOICES, vault = fakeVault(SCRIPTS) } = {}) =>
  expandOpaqueWildcards({ allowOpaque: [], wildcards: [], neverOpaque: [], deny: [], ...input }, prev, ids, choices, vault.read);

describe("expandOpaqueWildcards: a save lists the choices a wildcard opens (01.41 pick A, 2026-10-17)", () => {
  test("a wildcard line becomes the exact ids it opens, with a script snapshot each; the wildcard is kept apart", async () => {
    const { policy, unreadable } = await save({ allowOpaque: ["quickadd:choice:*"] });
    assert.deepEqual(policy.allowOpaque, [cid("qan:Q/A.md#choice"), cid("qan:Q/B.md#choice"), cid("qan:Q/New idea.md#choice"), cid("qan:Q/Pay the rent.md#choice")]);
    assert.ok(policy.allowOpaque.every((e) => !e.endsWith("*")), "exact ids only");
    assert.deepEqual(policy.opaqueWildcards, ["quickadd:choice:*"]);
    assert.deepEqual(Object.keys(policy.opaqueSnapshot).sort(), [...policy.allowOpaque].sort());
    assert.deepEqual(policy.opaqueSnapshot[cid("qan:Q/New idea.md#choice")], { scripts: { "S/new-idea.md": hashScript(SCRIPTS["S/new-idea.md"]) } });
    assert.deepEqual(policy.opaqueSnapshot[cid("qan:Q/A.md#choice")], { scripts: {} });
    assert.deepEqual(unreadable, []);
  });

  test("the expansion skips verbs, Never re-enable, denied ids, non-choice ids and js-engine ids", async () => {
    const { policy } = await save({
      wildcards: ["quickadd:*", "js-engine:*"],
      neverOpaque: [cid("qan:Q/Pay the rent.md#choice")],
      deny: [cid("qan:Q/B.md#choice")],
    });
    assert.deepEqual(policy.allowOpaque, [cid("qan:Q/A.md#choice"), cid("qan:Q/New idea.md#choice")]);
  });

  test("an exact line the human typed keeps no snapshot, and the save leaves it alone", async () => {
    const hand = cid("qan:Q/New idea.md#choice");
    const { policy } = await save({ allowOpaque: [hand, "quickadd:runQuickAdd"], wildcards: ["quickadd:choice:*"] });
    assert.ok(policy.allowOpaque.includes(hand));
    assert.ok(policy.allowOpaque.includes("quickadd:runQuickAdd"));
    assert.equal(policy.opaqueSnapshot[hand], undefined);
    assert.equal(policy.opaqueSnapshot["quickadd:runQuickAdd"], undefined);
  });

  test("removing the wildcard removes the ids it added; a line it added is found again, not kept as hand-typed", async () => {
    const first = await save({ wildcards: ["quickadd:choice:*"] });
    const again = await save({ allowOpaque: first.policy.allowOpaque, wildcards: [] }, first.policy.opaqueSnapshot);
    assert.deepEqual(again.policy.allowOpaque, []);
    assert.deepEqual(again.policy.opaqueSnapshot, {});
  });

  test("a choice whose script cannot be read stays closed and is named", async () => {
    const vault = fakeVault({ "S/rent.md": "pay();" });
    const { policy, unreadable } = await save({ wildcards: ["quickadd:choice:*"] }, undefined, { vault });
    assert.ok(!policy.allowOpaque.includes(cid("qan:Q/New idea.md#choice")));
    assert.deepEqual(unreadable, [cid("qan:Q/New idea.md#choice")]);
  });

  test("no QuickAdd: the wildcard is kept but opens nothing", async () => {
    const { policy } = await save({ wildcards: ["quickadd:choice:*"] }, undefined, { choices: null });
    assert.deepEqual(policy.allowOpaque, []);
    assert.deepEqual(policy.opaqueWildcards, ["quickadd:choice:*"]);
  });
});

describe("the gate after a save: exact ids and snapshots (01.41 pick A)", () => {
  test("a stored wildcard opens nothing at call time (fail closed), with a message pointing to the save", async () => {
    const reason = runCommandRefusal(cid("qan:Q/New idea.md#choice"), { allowOpaque: ["quickadd:choice:*"] }, CHOICES);
    assert.match(reason, /wildcard/);
    assert.match(reason, /save/);
    assert.ok(runCommandRefusal("quickadd:toggleMacro", { allowOpaque: ["quickadd:*"] }, CHOICES));
    assert.ok(cliCommandRefusal("quickadd:run", { allowOpaque: ["quickadd:*"] }));
  });

  test("an id the save added opens while its scripts hash the same", async () => {
    const vault = fakeVault(SCRIPTS);
    const { policy } = await save({ wildcards: ["quickadd:choice:*"] }, undefined, { vault });
    const id = cid("qan:Q/New idea.md#choice");
    assert.equal(runCommandRefusal(id, policy, CHOICES), null);
    assert.equal(await runCommandSnapshotRefusal(id, policy, CHOICES, vault.read), null);
  });

  test("a changed script closes the id until the next save, and the next save opens it again", async () => {
    const vault = fakeVault(SCRIPTS);
    const { policy } = await save({ wildcards: ["quickadd:choice:*"] }, undefined, { vault });
    const id = cid("qan:Q/New idea.md#choice");
    vault.store.set("S/new-idea.md", "module.exports = async () => { /* changed */ };");
    assert.equal(runCommandRefusal(id, policy, CHOICES), null, "the sync half cannot see a hash");
    assert.match(await runCommandSnapshotRefusal(id, policy, CHOICES, vault.read), /script changed since you saved the wildcard; save the setting again to open it/);
    vault.store.delete("S/new-idea.md");
    assert.ok(await runCommandSnapshotRefusal(id, policy, CHOICES, vault.read), "a script gone");
    vault.store.set("S/new-idea.md", "v2");
    const resaved = await save({ allowOpaque: policy.allowOpaque, wildcards: policy.opaqueWildcards }, policy.opaqueSnapshot, { vault });
    assert.equal(await runCommandSnapshotRefusal(id, resaved.policy, CHOICES, vault.read), null);
  });

  test("a choice that now runs another script list is closed", async () => {
    const vault = fakeVault(SCRIPTS);
    const { policy } = await save({ wildcards: ["quickadd:choice:*"] }, undefined, { vault });
    const id = cid("qan:Q/A.md#choice");
    const edited = quickAddChoicesFrom({ choices: QA_SETTINGS.choices.map((c) => (c.id === "qan:Q/A.md#choice" ? qa(c.id, "A", [{ type: "UserScript", path: "S/rent.md" }]) : c)) });
    assert.equal(runCommandRefusal(id, policy, edited), null);
    assert.ok(await runCommandSnapshotRefusal(id, policy, edited, vault.read));
  });

  test("a choice that now runs a verb, or is on Never re-enable, is closed by the sync half", async () => {
    const { policy } = await save({ wildcards: ["quickadd:choice:*"] });
    const id = cid("qan:Q/A.md#choice");
    const edited = quickAddChoicesFrom({ choices: QA_SETTINGS.choices.map((c) => (c.id === "qan:Q/A.md#choice" ? qa(c.id, "A", [{ type: "Choice", choiceId: "qan:Q/Verify current note.md#choice" }]) : c)) });
    assert.match(runCommandRefusal(id, policy, edited), /no longer passes the wildcard's checks/);
    assert.ok(runCommandRefusal(id, { ...policy, neverOpaque: [id] }, CHOICES));
    assert.ok(runCommandRefusal(id, policy, null), "QuickAdd gone");
  });

  test("a choice added after the save stays closed until the human saves again; the count then shows it", async () => {
    const vault = fakeVault(SCRIPTS);
    const { policy } = await save({ wildcards: ["quickadd:choice:*"] }, undefined, { vault });
    const late = "qan:Q/Late.md#choice";
    const settings2 = { choices: [...QA_SETTINGS.choices, qa(late, "Late")] };
    const choices2 = quickAddChoicesFrom(settings2);
    const ids2 = [...ALL_IDS, cid(late)];
    assert.ok(runCommandRefusal(cid(late), policy, choices2), "not listed: closed");
    assert.ok(!reenabledOpaqueCommandIds(ids2, policy, choices2).includes(cid(late)));
    const resaved = await save({ allowOpaque: policy.allowOpaque, wildcards: policy.opaqueWildcards }, policy.opaqueSnapshot, { ids: ids2, choices: choices2, vault });
    assert.equal(runCommandRefusal(cid(late), resaved.policy, choices2), null);
    assert.ok(reenabledOpaqueCommandIds(ids2, resaved.policy, choices2).includes(cid(late)));
  });

  test("an id typed by hand keeps today's exact-entry behaviour: no snapshot, no hash check", async () => {
    const id = cid("qan:Q/New idea.md#choice");
    const policy = { allowOpaque: [id] };
    assert.equal(runCommandRefusal(id, policy, CHOICES), null);
    assert.equal(runCommandRefusal(id, policy), null, "no lookup needed for an exact entry");
    assert.equal(await runCommandSnapshotRefusal(id, policy, CHOICES, async () => null), null);
    assert.equal(await runCommandSnapshotRefusal("quickadd:runQuickAdd", policy, null, async () => null), null);
  });

  test("deny wins over an id the save added", async () => {
    const { policy } = await save({ wildcards: ["quickadd:choice:*"] });
    const id = cid("qan:Q/A.md#choice");
    assert.ok(runCommandRefusal(id, { ...policy, deny: [id] }, CHOICES));
  });
});

describe("normalizeCliPolicy", () => {
  test("defaults: empty lists and an empty snapshot", () => {
    for (const raw of [undefined, null, "x", 3, []]) {
      assert.deepEqual(normalizeCliPolicy(raw), { deny: [], allowOpaque: [], neverOpaque: [], opaqueWildcards: [], opaqueSnapshot: {} });
    }
  });
  test("drops malformed values and keeps well-formed ones", () => {
    const h = hashScript("x");
    const out = normalizeCliPolicy({
      deny: ["a", 3],
      allowOpaque: ["quickadd:choice:ok", "quickadd:choice:bad", "quickadd:choice:hand", null],
      neverOpaque: "nope",
      opaqueWildcards: ["quickadd:choice:*", "not-a-glob", 7],
      opaqueSnapshot: {
        "quickadd:choice:ok": { scripts: { "S/x.md": h } },
        "quickadd:choice:bad": { scripts: { "S/x.md": "not-a-hash" } },
        "quickadd:choice:gone": { scripts: {} },
      },
    });
    assert.deepEqual(out.deny, ["a"]);
    assert.deepEqual(out.neverOpaque, []);
    assert.deepEqual(out.opaqueWildcards, ["quickadd:choice:*"]);
    assert.deepEqual(out.opaqueSnapshot, { "quickadd:choice:ok": { scripts: { "S/x.md": h } } });
    assert.deepEqual(out.allowOpaque, ["quickadd:choice:ok", "quickadd:choice:hand"], "an id with a malformed snapshot is dropped, never kept as hand-typed");
  });
  test("a snapshot that is an array is dropped", () => {
    assert.deepEqual(normalizeCliPolicy({ allowOpaque: ["x"], opaqueSnapshot: [1] }).opaqueSnapshot, {});
  });
});

describe("runCommandRefusal: command ids", () => {
  test("quickadd:* ids are denied by default; ordinary ids are not", () => {
    assert.ok(runCommandRefusal("quickadd:runQuickAdd", {}));
    assert.equal(runCommandRefusal("editor:toggle-bold", {}), null);
    assert.equal(runCommandRefusal("daily-notes", {}), null);
  });

  test("allowOpaque: an exact entry re-enables one id; a trailing-* entry opens nothing at call time", () => {
    assert.equal(runCommandRefusal("quickadd:runQuickAdd", { allowOpaque: ["quickadd:runQuickAdd"] }), null);
    assert.ok(runCommandRefusal("quickadd:toggleMacro", { allowOpaque: ["quickadd:runQuickAdd"] }));
    // A wildcard is expanded at the human's save (01.41 pick A, 2026-10-17); a stored one is not honoured.
    assert.ok(runCommandRefusal("quickadd:toggleMacro", { allowOpaque: ["quickadd:*"] }, CHOICES));
    assert.ok(runCommandRefusal(cid("qan:Q/New idea.md#choice"), { allowOpaque: ["quickadd:choice:*"] }, CHOICES));
  });

  test("an accept verb's QuickAdd choice: no wildcard reaches it; only an exact entry can", () => {
    for (const verb of ["Verify current note", "Reopen current note", "Request revision", "Answer current note", "Reject current note"]) {
      const id = `quickadd:choice:qan:00-09 System/00 System management/00.14 QuickAdd choices/${verb}.md#choice`;
      assert.ok(runCommandRefusal(id, { allowOpaque: ["quickadd:*", "quickadd:choice:*"] }), verb);
      assert.equal(isAcceptVerbCommandId(id), true, verb);
      assert.equal(wildcardMayOpen(id, {}, CHOICES), false, verb);
    }
    const exact = "quickadd:choice:qan:00-09 System/00 System management/00.14 QuickAdd choices/Verify current note.md#choice";
    assert.equal(runCommandRefusal(exact, { allowOpaque: [exact] }), null, "an exact entry is the human naming that one command");
    assert.equal(isAcceptVerbCommandId("quickadd:choice:qan:Notes/Verify current note draft.md#choice"), false);
  });

  test("Never re-enable stops a wildcard, not an exact entry (01.41 pick A)", () => {
    const priv = cid("qan:Q/Pay the rent.md#choice");
    assert.equal(wildcardMayOpen(priv, { neverOpaque: [priv] }, CHOICES), false);
    assert.equal(wildcardMayOpen(`${priv}:pick-day`, { neverOpaque: [priv] }, CHOICES), false, "and its pick-day variant");
    assert.equal(wildcardMayOpen(priv, { neverOpaque: ["quickadd:choice:qan:Q/Pay*"] }, CHOICES), false, "a prefix on the never list");
    assert.equal(runCommandRefusal(priv, { allowOpaque: [priv], neverOpaque: [priv] }, CHOICES), null, "an exact re-enable is a deliberate act");
  });

  test("reenabledOpaqueCommandIds lists what the policy opens today, sorted, opaque families only", () => {
    const ids = [cid("qan:Q/B.md#choice"), cid("qan:Q/A.md#choice"), cid("qan:Q/Verify current note.md#choice"), "js-engine:run", "editor:toggle-bold"];
    assert.deepEqual(reenabledOpaqueCommandIds(ids, { allowOpaque: [] }, CHOICES), []);
    assert.deepEqual(reenabledOpaqueCommandIds(ids, { allowOpaque: ["quickadd:*", "js-engine:*"] }, CHOICES), [], "stored wildcards open nothing");
    assert.deepEqual(reenabledOpaqueCommandIds(ids, { allowOpaque: [cid("qan:Q/B.md#choice"), cid("qan:Q/A.md#choice")] }, CHOICES), [cid("qan:Q/A.md#choice"), cid("qan:Q/B.md#choice")]);
    assert.deepEqual(reenabledOpaqueCommandIds(ids, { allowOpaque: ["js-engine:run"] }, CHOICES), ["js-engine:run"]);
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

  test("js-engine re-enable: exact entries only; a glob never opens vault-minted code (#552 review 1)", () => {
    assert.equal(runCommandRefusal("js-engine:cmd-unfill-paragraph", { allowOpaque: ["js-engine:cmd-unfill-paragraph"] }), null);
    assert.ok(runCommandRefusal("js-engine:execute-js-file", { allowOpaque: ["js-engine:cmd-unfill-paragraph"] }));
    assert.ok(runCommandRefusal("js-engine:cmd-other", { allowOpaque: ["js-engine:*"] }, CHOICES));
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
