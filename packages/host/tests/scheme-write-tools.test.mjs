/**
 * scheme-write-tools.test.mjs — Task 4 of the scope-provider module: the
 * three mutating tools — obsidian_assign_address, obsidian_refile_address,
 * obsidian_renumber_address.
 *
 * Same fixture shape as scheme-tools.test.mjs (a synthetic vault listing),
 * driven through the fake-server pattern tests/uid-index.test.mjs uses for
 * obsidian_resolve_uid: register against a stand-in server, invoke the
 * captured handler directly.
 *
 * The write tools import `moveOne` (tools-vault-write.ts), which imports live
 * `TFile` from "obsidian" — an obsidian-free specifier at test time only via
 * the same stub-and-dynamic-import pattern link-healing.test.mjs uses.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installObsidianStub, TFile, TFolder } from "./obsidian-stub.mjs";
import { makeRegistry } from "../src/kernel/scheme/registry.ts";
import { JD_SCHEMES } from "./scheme-fixture.mjs";
import { makeGuarded } from "../src/mcp/guarded.ts";

installObsidianStub();
const { registerSchemeWriteTools } = await import("../src/mcp/tools-scheme-write.ts");

const NOTES = [
  "00-09 System/00.00 Index.md",
  "00-09 System/06 Agent tooling/06.00 JDex.md",
  "00-09 System/06 Agent tooling/06.11 Vault MCP.md",
  "00-09 System/06 Agent tooling/06.12 Bridge.md",
  "00-09 System/06 Agent tooling/scratch no address.md",
  "90-99 Projects/92021 Big thing/92021.10 Sub.md",
  "90-99 Projects/92021 Big thing/92021.11 Other.md",
  "Unfiled/loose.md",
  "Unfiled/New thing.md",
  "Random/06.13 Oops.md",
];

const FOLDERS = [
  "00-09 System",
  "00-09 System/06 Agent tooling",
  "90-99 Projects",
  "90-99 Projects/92021 Big thing",
  "Unfiled",
  "Random",
];

/** A vault that records how it was moved — same spies as
 * link-healing.test.mjs's fakeVault: vaultRename (the file-level rename
 * moveOne takes through move-with-links.ts), renameFile (throws — proves it's
 * never reached: it waits for a clean metadata cache), and createFolder. */
function fakeApp({ files = NOTES, folders = FOLDERS } = {}) {
  const tree = new Map(files.map((p) => [p, new TFile(p)]));
  const dirs = new Set(folders);
  const calls = { renameFile: [], vaultRename: [], trash: [], createFolder: [] };
  const app = {
    vault: {
      getAbstractFileByPath: (p) => tree.get(p) ?? (dirs.has(p) ? new TFolder(p) : null),
      async createFolder(p) {
        calls.createFolder.push(p);
        dirs.add(p);
      },
      async trash(file, system) {
        calls.trash.push([file.path, system]);
        tree.delete(file.path);
      },
      async rename(file, to) {
        calls.vaultRename.push([file.path, to]);
        tree.delete(file.path);
        file.path = to;
        tree.set(to, file);
      },
      getMarkdownFiles: () => [...tree.values()],
      read: async (f) => "",
      cachedRead: async (f) => "",
      async process(f, fn) { const n = fn(""); BODY.set(f.path, n); return n; },
    },
    metadataCache: { resolvedLinks: {}, getFileCache: () => ({ links: [], embeds: [] }), getFirstLinkpathDest: () => null, fileToLinktext: (f) => f.basename },
    fileManager: {
      async renameFile(file, to) {
        calls.renameFile.push([file.path, to]);
        throw new Error("renameFile waits for a clean metadata cache — moves go through moveWithLinks");
      },
    },
  };
  return { app, calls, tree };
}

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, def, handler) {
      tools.set(name, { def, handler });
    },
  };
}

function toolServer({ schemes = JD_SCHEMES, notes = NOTES, folders = FOLDERS, settings = { readOnly: false, allowlist: [] } } = {}) {
  const { app, calls, tree } = fakeApp({ files: notes, folders });
  const server = fakeServer();
  registerSchemeWriteTools(server, app, {
    registry: () => makeRegistry(schemes),
    notes: () => [...tree.values()].map((f) => f.path),
    getSettings: () => ({ ...settings, schemes }),
  });
  const call = (name, args = {}) => server.tools.get(name).handler(args, {});
  return { server, call, calls, app, tree };
}

// ── registration shape ───────────────────────────────────────────────────────

describe("registration", () => {
  test("registers exactly the three expected tools, all mutating (readOnlyHint: false)", () => {
    const { server } = toolServer();
    assert.deepEqual(
      [...server.tools.keys()].sort(),
      ["obsidian_assign_address", "obsidian_refile_address", "obsidian_renumber_address"].sort(),
    );
    for (const [name, { def }] of server.tools) {
      assert.equal(def.annotations.readOnlyHint, false, `${name} must be mutating`);
    }
  });
});

// ── obsidian_assign_address ──────────────────────────────────────────────────

describe("obsidian_assign_address", () => {
  test("dry_run: true reports the computed address and move, mutating nothing", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "06", dry_run: true });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent, {
      dry_run: true,
      address: "06.10",
      moves: [{ from: "Unfiled/New thing.md", to: "00-09 System/06 Agent tooling/06.10 New thing.md" }],
    });
    assert.deepEqual(calls.vaultRename, [], "a dry run must not move anything");
  });

  test("dry_run: false performs the move via the file-level rename (moveWithLinks), never fileManager.renameFile", async () => {
    const { call, calls, tree } = toolServer();
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "06", dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent, {
      dry_run: false,
      address: "06.10",
      moves: [{ from: "Unfiled/New thing.md", to: "00-09 System/06 Agent tooling/06.10 New thing.md" }],
      filesChanged: 1,
      files: ["00-09 System/06 Agent tooling/06.10 New thing.md"],
    });
    assert.deepEqual(calls.vaultRename, [["Unfiled/New thing.md", "00-09 System/06 Agent tooling/06.10 New thing.md"]]);
    assert.deepEqual(calls.renameFile, []);
    assert.equal(tree.has("00-09 System/06 Agent tooling/06.10 New thing.md"), true);
  });

  test("an invalid scope is a coded invalid_scope refusal", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "not a scope!", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[invalid_scope\]/);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("an unknown scheme id is a plain refusal (an argument problem, not a scope problem)", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "06", scheme: "nope", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /unknown scheme/);
  });

  test("a path outside the allowlist is a coded out_of_allowlist refusal, before any planning runs", async () => {
    const { call, calls } = toolServer({ settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "06", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("an exhausted scope surfaces planAssign's own error verbatim via fail()", async () => {
    const filler = [];
    for (let n = 10; n <= 99; n++) filler.push(`00-09 System/06 Agent tooling/06.${n} Filler.md`);
    filler.push("Unfiled/New thing.md");
    const { call } = toolServer({ notes: filler });
    const res = await call("obsidian_assign_address", { path: "Unfiled/New thing.md", scope: "06", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /exhaust/i);
  });
});

// ── obsidian_refile_address ──────────────────────────────────────────────────

describe("obsidian_refile_address", () => {
  test("dry_run: true reports the misfiled note's move, mutating nothing", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_refile_address", { path: "Random/06.13 Oops.md", dry_run: true });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent, {
      dry_run: true,
      address: "06.13",
      moves: [{ from: "Random/06.13 Oops.md", to: "00-09 System/06 Agent tooling/06.13 Oops.md" }],
    });
    assert.deepEqual(calls.vaultRename, []);
  });

  test("dry_run: false performs the move via fileManager.renameFile", async () => {
    const { call, calls, tree } = toolServer();
    const res = await call("obsidian_refile_address", { path: "Random/06.13 Oops.md", dry_run: false });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.vaultRename, [["Random/06.13 Oops.md", "00-09 System/06 Agent tooling/06.13 Oops.md"]]);
    assert.deepEqual(calls.renameFile, []);
    assert.equal(tree.has("00-09 System/06 Agent tooling/06.13 Oops.md"), true);
    assert.equal(res.structuredContent.address, "06.13");
    assert.equal(res.structuredContent.filesChanged, 1);
    assert.deepEqual(res.structuredContent.files, ["00-09 System/06 Agent tooling/06.13 Oops.md"]);
  });

  test("an already-correctly-filed note reports already_correct: true and moves nothing, dry_run or not", async () => {
    const { call, calls } = toolServer();
    for (const dry_run of [true, false]) {
      const res = await call("obsidian_refile_address", { path: "00-09 System/06 Agent tooling/06.11 Vault MCP.md", dry_run });
      assert.equal(res.isError, undefined, res.content?.[0]?.text);
      assert.deepEqual(res.structuredContent, { dry_run, address: "06.11", moves: [], already_correct: true });
    }
    assert.deepEqual(calls.vaultRename, []);
  });

  test("a note with no address in any configured scheme is refused", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_refile_address", { path: "Unfiled/loose.md", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no address in any configured scheme/);
  });

  test("a path outside the allowlist is a coded out_of_allowlist refusal", async () => {
    const { call, calls } = toolServer({ settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_refile_address", { path: "Random/06.13 Oops.md", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.deepEqual(calls.vaultRename, []);
  });
});

// ── obsidian_renumber_address ────────────────────────────────────────────────

describe("obsidian_renumber_address", () => {
  test("dry_run: true reports the single move when the target is free, mutating nothing", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.20",
      dry_run: true,
      on_occupied: "fail",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent, {
      dry_run: true,
      address: "06.20",
      moves: [{ from: "Unfiled/New thing.md", to: "00-09 System/06 Agent tooling/06.20 New thing.md" }],
      displaced: null,
    });
    assert.deepEqual(calls.vaultRename, []);
  });

  test("dry_run: false performs the single move when the target is free", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.20",
      dry_run: false,
      on_occupied: "fail",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.vaultRename, [["Unfiled/New thing.md", "00-09 System/06 Agent tooling/06.20 New thing.md"]]);
    assert.equal(res.structuredContent.address, "06.20");
    assert.equal(res.structuredContent.filesChanged, 1);
    assert.deepEqual(res.structuredContent.files, ["00-09 System/06 Agent tooling/06.20 New thing.md"]);
  });

  test("on_occupied 'fail' (the default) refuses when the target is occupied, with no moves performed", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.11",
      dry_run: false,
      on_occupied: "fail",
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /occupied/);
    assert.deepEqual(calls.vaultRename, []);
  });

  // The fake harness (like scheme-tools.test.mjs's and link-healing.test.mjs's)
  // invokes handlers directly and does not run the SDK's zod parsing, so a
  // schema-level `.default(...)` never applies to an omitted argument through
  // this harness — it's exercised at the schema itself instead.
  test("on_occupied's zod schema defaults to 'fail'", () => {
    const { server } = toolServer();
    const schema = server.tools.get("obsidian_renumber_address").def.inputSchema.on_occupied;
    assert.equal(schema.parse(undefined), "fail");
  });

  test("on_occupied 'auto' — dry_run reports both moves, occupant first, mutating nothing", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.11",
      dry_run: true,
      on_occupied: "auto",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(res.structuredContent.moves, [
      { from: "00-09 System/06 Agent tooling/06.11 Vault MCP.md", to: "00-09 System/06 Agent tooling/06.10 Vault MCP.md" },
      { from: "Unfiled/New thing.md", to: "00-09 System/06 Agent tooling/06.11 New thing.md" },
    ]);
    assert.equal(res.structuredContent.displaced, "00-09 System/06 Agent tooling/06.10 Vault MCP.md");
    assert.deepEqual(calls.vaultRename, []);
  });

  test("on_occupied 'auto' — apply performs BOTH moves, occupant strictly before source (call-log order)", async () => {
    const { call, calls, tree } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.11",
      dry_run: false,
      on_occupied: "auto",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.vaultRename, [
      ["00-09 System/06 Agent tooling/06.11 Vault MCP.md", "00-09 System/06 Agent tooling/06.10 Vault MCP.md"],
      ["Unfiled/New thing.md", "00-09 System/06 Agent tooling/06.11 New thing.md"],
    ]);
    assert.deepEqual(calls.renameFile, []);
    assert.equal(tree.has("00-09 System/06 Agent tooling/06.10 Vault MCP.md"), true);
    assert.equal(tree.has("00-09 System/06 Agent tooling/06.11 New thing.md"), true);
    assert.equal(res.structuredContent.displaced, "00-09 System/06 Agent tooling/06.10 Vault MCP.md");
    assert.equal(res.structuredContent.filesChanged, 2);
    assert.deepEqual(res.structuredContent.files, [
      "00-09 System/06 Agent tooling/06.10 Vault MCP.md",
      "00-09 System/06 Agent tooling/06.11 New thing.md",
    ]);
  });

  test("on_occupied 'manual' — requires displace_to_address, and moves occupant there first", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.11",
      dry_run: false,
      on_occupied: "manual",
      displace_to_address: "06.50",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.vaultRename, [
      ["00-09 System/06 Agent tooling/06.11 Vault MCP.md", "00-09 System/06 Agent tooling/06.50 Vault MCP.md"],
      ["Unfiled/New thing.md", "00-09 System/06 Agent tooling/06.11 New thing.md"],
    ]);
  });

  test("on_occupied 'manual' without displace_to_address is refused by the planner", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.11",
      dry_run: true,
      on_occupied: "manual",
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /displace_to/);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("an unparseable `to_address` is refused before any planning runs", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", { path: "Unfiled/New thing.md", to_address: "not an address!", dry_run: true });
    assert.equal(res.isError, true);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("an unparseable displace_to_address (on_occupied manual) is refused before any planning runs", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.11",
      dry_run: true,
      on_occupied: "manual",
      displace_to_address: "not an address!",
    });
    assert.equal(res.isError, true);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("a path outside the allowlist is a coded out_of_allowlist refusal", async () => {
    const { call, calls } = toolServer({ settings: { readOnly: false, allowlist: ["00-09 System"] } });
    const res = await call("obsidian_renumber_address", { path: "Unfiled/New thing.md", to_address: "06.20", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("a partial failure mid-execution reports which step landed and which failed, naming both paths", async () => {
    const { app, calls, tree } = fakeApp();
    // Make the SECOND move (the source note into 06.11) fail by having the
    // file-level rename throw only for that specific destination — the
    // occupant's own displacement (the first step) must still succeed.
    const originalRename = app.vault.rename.bind(app.vault);
    app.vault.rename = async (file, to) => {
      if (to === "00-09 System/06 Agent tooling/06.11 New thing.md") {
        calls.vaultRename.push([file.path, to]);
        throw new Error("simulated failure");
      }
      return originalRename(file, to);
    };
    const server = fakeServer();
    registerSchemeWriteTools(server, app, {
      registry: () => makeRegistry(JD_SCHEMES),
      notes: () => [...tree.values()].map((f) => f.path),
      getSettings: () => ({ readOnly: false, allowlist: [], schemes: JD_SCHEMES }),
    });
    const call = (name, args = {}) => server.tools.get(name).handler(args, {});

    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.11",
      dry_run: false,
      on_occupied: "auto",
    });

    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /inconsistent state/);
    assert.match(res.content[0].text, /00-09 System\/06 Agent tooling\/06\.11 Vault MCP\.md/);
    assert.match(res.content[0].text, /00-09 System\/06 Agent tooling\/06\.10 Vault MCP\.md/);
    assert.match(res.content[0].text, /Unfiled\/New thing\.md/);
    // The occupant's own move already landed — the vault really is in the
    // reported inconsistent state, not merely described as such.
    assert.equal(tree.has("00-09 System/06 Agent tooling/06.10 Vault MCP.md"), true);
    assert.equal(tree.has("Unfiled/New thing.md"), true, "the source note never moved");
  });
});

// ── finding #3: a COMPUTED destination is allowlist-checked too ─────────────
//
// `expectedFolder` derives the destination folder from the notes listing by
// finding a folder segment whose own name is the container's JD token — NOT
// from where the visible notes themselves happen to sit. So a note visible
// deep inside a narrower allowlist prefix can still compute a destination
// folder that is a SHORTER prefix, outside that narrower allowlist, even
// though the note that triggered the computation is itself fully visible.

describe("computed destination containment (finding #3)", () => {
  test("a computed destination outside a narrower allowlist prefix is refused, dry_run or not, before any move runs", async () => {
    const notes = [
      "00-09 System/06 Agent tooling/Sub/06.11 Existing.md",
      "00-09 System/06 Agent tooling/Sub/New thing.md",
    ];
    const folders = ["00-09 System", "00-09 System/06 Agent tooling", "00-09 System/06 Agent tooling/Sub"];
    // expectedFolder finds the folder actually NAMED "06 Agent tooling" (the
    // category container) via scopesAlongPath, not the deeper "Sub" folder
    // the visible notes happen to live in — so category "06"'s computed
    // destination is "00-09 System/06 Agent tooling", outside this allowlist
    // even though the source note itself is inside it.
    const allowlist = ["00-09 System/06 Agent tooling/Sub"];

    for (const dry_run of [true, false]) {
      const { call, calls } = toolServer({ notes, folders, settings: { readOnly: false, allowlist } });
      const res = await call("obsidian_assign_address", {
        path: "00-09 System/06 Agent tooling/Sub/New thing.md",
        scope: "06",
        dry_run,
      });
      assert.equal(res.isError, true, res.content?.[0]?.text);
      assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
      assert.match(res.content[0].text, /computed destination/);
      assert.deepEqual(calls.vaultRename, [], `dry_run=${dry_run}: no move must be attempted once the destination check refuses it`);
    }
  });
});

// ── finding #4: excludedRoots discipline matches the read tools ─────────────

describe("excludedRoots discipline (finding #4)", () => {
  const EXCLUDED_SCHEMES = [{ id: "jd", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] }];

  test("obsidian_assign_address refuses when `path` itself is under an excluded root", async () => {
    const notes = [...NOTES, "Vault archaeology/loose.md"];
    const folders = [...FOLDERS, "Vault archaeology"];
    const { call, calls } = toolServer({ schemes: EXCLUDED_SCHEMES, notes, folders });
    const res = await call("obsidian_assign_address", { path: "Vault archaeology/loose.md", scope: "06", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /excluded/);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("obsidian_renumber_address refuses when `path` itself is under an excluded root", async () => {
    const notes = [...NOTES, "Vault archaeology/loose.md"];
    const folders = [...FOLDERS, "Vault archaeology"];
    const { call, calls } = toolServer({ schemes: EXCLUDED_SCHEMES, notes, folders });
    const res = await call("obsidian_renumber_address", {
      path: "Vault archaeology/loose.md",
      to_address: "06.20",
      dry_run: true,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /excluded/);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("obsidian_refile_address refuses when the note's only recognizing instance excludes it", async () => {
    const notes = [...NOTES, "Vault archaeology/06.13 Archived.md"];
    const folders = [...FOLDERS, "Vault archaeology"];
    const { call, calls } = toolServer({ schemes: EXCLUDED_SCHEMES, notes, folders });
    const res = await call("obsidian_refile_address", { path: "Vault archaeology/06.13 Archived.md", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /excludedRoots/);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("a note under an excluded root is not counted as an occupant — the address it duplicates reads as free", async () => {
    // "06.11" is claimed only by a note under the excluded root; the live
    // spine has no note at 06.11. Without excludeRoots applied to the notes
    // listing planRenumber plans against, occupantOf would find the archived
    // note and report a spurious conflict (or, with 'auto'/'manual', try to
    // displace a note this instance does not even speak for).
    const notes = [
      "00-09 System/06 Agent tooling/06.00 JDex.md",
      "Vault archaeology/06.11 Archived dup.md",
      "Unfiled/New thing.md",
    ];
    const folders = ["00-09 System", "00-09 System/06 Agent tooling", "Vault archaeology", "Unfiled"];
    const { call, calls } = toolServer({ schemes: EXCLUDED_SCHEMES, notes, folders });
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.11",
      dry_run: false,
      on_occupied: "fail",
    });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.deepEqual(calls.vaultRename, [["Unfiled/New thing.md", "00-09 System/06 Agent tooling/06.11 New thing.md"]]);
  });
});

// ── finding #2: to_address/displace_to_address vs. the guard's PATH_KEYS ────
//
// guard.ts's PATH_KEYS includes "to" (a well-known path-argument name across
// the tool surface). obsidian_renumber_address's target is a SCHEME ADDRESS
// ("06.20"), not a path — so under the tool's original "to" argument name, a
// call through the real guard wrapper with an active path allowlist got
// checked as if "06.20" were a path, and refused as out_of_allowlist even
// though the note actually being operated on (`path`) was fully inside the
// allowlist. Renamed to `to_address`/`displace_to_address`, which collide
// with nothing in PATH_KEYS/ARRAY_PATH_KEYS, so only `path` is ever checked.
//
// This drives the REAL makeGuarded wrapper (not the raw handler) — the same
// harness link-healing.test.mjs's `journaledRepoint` uses — so it proves the
// fix at the actual interception point a live client goes through, not just
// against the bare tool handler.

const ACTOR = { transport: "mcp", client: "test-client/1.0.0", connection: "test-conn-1" };

describe("obsidian_renumber_address through the real guard wrapper (finding #2)", () => {
  test("to_address/displace_to_address are never mistaken for paths — a call whose source path IS in the allowlist succeeds", async () => {
    const { app, calls } = fakeApp();
    const server = fakeServer();
    // Both roots allowlisted: "Unfiled" so the source note is visible, and
    // "00-09 System" so the "06" category's folder can still be derived from
    // a visible member — this test is about to_address not colliding with
    // the guard's own path check, not about a narrow-allowlist edge case
    // (that is finding #3's "computed destination containment" test, above).
    const allowlist = ["Unfiled", "00-09 System"];
    registerSchemeWriteTools(server, app, {
      registry: () => makeRegistry(JD_SCHEMES),
      notes: () => NOTES,
      getSettings: () => ({ readOnly: false, allowlist, schemes: JD_SCHEMES }),
    });
    const { def, handler } = server.tools.get("obsidian_renumber_address");
    const guarded = makeGuarded({
      getSettings: () => ({ readOnly: false, allowlist }),
      actor: () => ACTOR,
    })(def, handler, "obsidian_renumber_address");

    const res = await guarded(
      {
        path: "Unfiled/New thing.md", // inside the allowlist
        to_address: "06.20", // NOT a path — must never be allowlist-checked
        displace_to_address: "06.50", // ditto, even though unused by on_occupied:"fail"
        dry_run: true,
        on_occupied: "fail",
      },
      {}
    );

    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.doesNotMatch(res.content?.[0]?.text ?? "", /out_of_allowlist/);
    assert.equal(res.structuredContent.address, "06.20");
    assert.deepEqual(calls.vaultRename, [], "dry_run must not move anything");
  });
});

// ── code-review PR #214, finding #2: obsidian_refile_address must not
// silently pick the FIRST configured scheme instance when a note's address
// parses under more than one. Matches the discipline
// resolveBareOrRef/resolveAddressAndInstance (tools-scheme.ts) already apply
// to the `address` argument direction of obsidian_resolve_address /
// obsidian_expected_location.

describe("obsidian_refile_address instance-selection ambiguity (PR #214 finding #2)", () => {
  const TWO_SCHEMES = [
    { id: "jd1", provider: "johnny-decimal" },
    { id: "jd2", provider: "johnny-decimal" },
  ];

  test("a note whose address parses under two configured scheme instances is refused, not silently resolved against the first", async () => {
    const { call, calls } = toolServer({ schemes: TWO_SCHEMES });
    const res = await call("obsidian_refile_address", { path: "Random/06.13 Oops.md", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[scheme_ambiguous\]/);
    assert.match(res.content[0].text, /jd1/);
    assert.match(res.content[0].text, /jd2/);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("a single configured instance is unaffected — still refiles normally", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_refile_address", { path: "Random/06.13 Oops.md", dry_run: true });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(res.structuredContent.address, "06.13");
  });
});

// ── code-review PR #214, finding #3: `path` must be rejected upfront when it
// doesn't end in .md — before any allowlist/instance/planning logic runs, and
// with `dry_run: true` never returning a plan — matching
// obsidian_move_notes's static validateMoves precedent.

describe("path must end in .md, checked upfront (PR #214 finding #3)", () => {
  test("obsidian_assign_address rejects a non-.md path immediately", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_assign_address", { path: "Unfiled/SomeFile.txt", scope: "06", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /must end in \.md/);
    assert.equal(res.structuredContent, undefined, "dry_run: true must never return a plan for a rejected path");
    assert.deepEqual(calls.vaultRename, []);
  });

  test("obsidian_refile_address rejects a non-.md path immediately", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_refile_address", { path: "Unfiled/SomeFile.txt", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /must end in \.md/);
    assert.equal(res.structuredContent, undefined);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("obsidian_renumber_address rejects a non-.md path immediately", async () => {
    const { call, calls } = toolServer();
    const res = await call("obsidian_renumber_address", { path: "Unfiled/SomeFile.txt", to_address: "06.20", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /must end in \.md/);
    assert.equal(res.structuredContent, undefined);
    assert.deepEqual(calls.vaultRename, []);
  });
});

// ── code-review PR #214, finding #4: refusals a caller might branch on carry
// a stable `codedError` code, matching out_of_allowlist/invalid_scope/
// scheme_unavailable two lines away in the same file — not a codeless plain
// `fail()`.

describe("coded refusals (PR #214 finding #4)", () => {
  test("obsidian_renumber_address's occupied refusal is coded address_occupied", async () => {
    const { call } = toolServer();
    const res = await call("obsidian_renumber_address", {
      path: "Unfiled/New thing.md",
      to_address: "06.11",
      dry_run: false,
      on_occupied: "fail",
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[address_occupied\]/);
  });

  test("an excludedRoots territory refusal is coded excluded_root", async () => {
    const EXCLUDED_SCHEMES = [{ id: "jd", provider: "johnny-decimal", excludedRoots: ["Vault archaeology"] }];
    const notes = [...NOTES, "Vault archaeology/loose.md"];
    const folders = [...FOLDERS, "Vault archaeology"];
    const { call } = toolServer({ schemes: EXCLUDED_SCHEMES, notes, folders });
    const res = await call("obsidian_assign_address", { path: "Vault archaeology/loose.md", scope: "06", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[excluded_root\]/);
  });
});

describe("scheme moves check the new name before any step and before a dry run answers", () => {
  const notes = [...NOTES, "Unfiled/New: thing.md"];

  test("assign_address: the dry run refuses what the real run would refuse", async () => {
    const { call, calls } = toolServer({ notes });
    const res = await call("obsidian_assign_address", { path: "Unfiled/New: thing.md", scope: "06", dry_run: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /unsafe_name/);
    assert.deepEqual(calls.vaultRename, []);
  });

  test("renumber with displacement: a refused name on step 2 stops it before step 1 moves the occupant", async () => {
    const { call, calls } = toolServer({ notes });
    const res = await call("obsidian_renumber_address", { path: "Unfiled/New: thing.md", to_address: "06.11", dry_run: false, on_occupied: "auto" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /unsafe_name/);
    assert.deepEqual(calls.vaultRename, [], "the occupant was not moved");
    const dry = await call("obsidian_renumber_address", { path: "Unfiled/New: thing.md", to_address: "06.11", dry_run: true, on_occupied: "auto" });
    assert.equal(dry.isError, true, "and the dry run says so");
  });
});
