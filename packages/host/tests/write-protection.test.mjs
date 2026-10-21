/**
 * write-protection.test.mjs — 01.33.5 (Nelson's "a" on 01.43, 2026-09-29; the
 * 01.33 Step 5 table ruled the same day): every guarded tool declares the
 * protection it requires, the host refuses a call that omits it, and the code
 * agrees with the spec's table.
 *
 * Three layers:
 *   1. COVERAGE — every mutating inventory row carries `protection`, every
 *      read-only row carries none.
 *   2. AGREEMENT — TABLE below is a pinned copy of the 01.33 Step 5 table,
 *      operation label → the tools (and arguments) it names → the ruled class.
 *      The code must match it row by row; every inventory tool must be named
 *      by some row. Where the vault is present, the pinned copy is checked
 *      against the live note, so the spec and this file cannot drift apart.
 *   3. BEHAVIOUR — the refusal names the missing argument and how to get it,
 *      and makeGuarded applies it before the queue.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCP_SURFACE_INVENTORY, EXTERNAL_PUBLISHER_ROW } from "../src/kernel/operations/inventory-mcp.ts";
import { requiredProtection, protectionRefusal, requirementNote, protectionTableMarkdown, PROTECTION_REQUIRED } from "../src/kernel/write-protection.ts";
import { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } from "../src/kernel/index.ts";
import { makeGuarded, withKernelArgs } from "../src/mcp/guarded.ts";

// ── the pinned copy of the 01.33 Step 5 table ─────────────────────────────────
// `class` is the ruled value; `calls` are the host calls the row names
// ([tool, args]); `code` is what the inventory says when it differs from the
// ruled class ON PURPOSE (a temporary exemption, #427), with the reason.
const NOT = "not a vault write";
const TABLE = [
  { op: "overwrite an existing note", class: "token", calls: [["obsidian_write_note", { overwrite: true }], ["obsidian_write_file", { overwrite: true }]], note: "obsidian_write_file overwrites a .base or .canvas file (#575): the same class" },
  { op: "frontmatter set", class: "token", calls: [["obsidian_manage_frontmatter", { op: "set" }]] },
  { op: "frontmatter delete", class: "token", calls: [["obsidian_manage_frontmatter", { op: "delete" }]] },
  { op: "patch (replace)", class: "token", calls: [["obsidian_patch_note", { op: "replace" }], ["obsidian_edit_file", {}]], note: "obsidian_edit_file replaces or removes one keyed item of a .base or .canvas file (#575): content read, so a token" },
  { op: "patch (replace)", class: "token", calls: [["obsidian_replace_text", {}]], code: "both", why: "obsidian_replace_text replaces content you read (a token, as the row rules) and also requires idempotency_key, so a retry after a lost reply replays the first result instead of meeting a rev conflict: stricter than the row, as its brief asked; the 01.33 table has no row of its own for it yet" },
  { op: "append, append at heading, cross-session post", class: "key", calls: [["obsidian_append_note", {}], ["obsidian_append_at_heading", {}]], note: "cross-session post is a satellite tool" },
  { op: "patch append, patch prepend", class: "key", calls: [["obsidian_patch_note", { op: "append" }], ["obsidian_patch_note", { op: "prepend" }]] },
  { op: "frontmatter list append", class: "key", calls: [], note: "the host's manage_frontmatter has no list-append operation (get, set, delete)" },
  { op: "run a command", class: "key", calls: [["obsidian_run_command", {}]] },
  { op: "create if absent", class: "exempt", calls: [["obsidian_write_note", { overwrite: false }], ["obsidian_write_note", {}], ["obsidian_write_file", { overwrite: false }], ["obsidian_write_file", {}]] },
  { op: "move, rename", class: "key", calls: [["obsidian_move_note", {}], ["obsidian_move_notes", {}], ["obsidian_move_file", {}]] },
  { op: "rename a heading", class: "token", calls: [["obsidian_rename_heading", {}]] },
  { op: "scheme move", class: "key", calls: [["obsidian_assign_address", {}], ["obsidian_refile_address", {}], ["obsidian_renumber_address", {}]] },
  { op: "repoint a link", class: "exempt (temporary)", calls: [["obsidian_repoint_link", {}]], code: "exempt", why: "its only named path is target_path, the note links point AT, not the notes it rewrites; a token would check the wrong file" },
  { op: "trash", class: "both", calls: [["obsidian_trash", {}]] },
  { op: "delete", class: "both", calls: [["obsidian_delete_note", {}]] },
  { op: "run code in the application", class: "key", calls: [["obsidian_cli", {}]] },
  { op: "compile the choice configuration", class: "exempt", calls: [], note: "a satellite tool (quickadd-choices-compile)" },
  { op: "claim, renew, release scope", class: NOT, calls: [["obsidian_claim_scope", {}], ["obsidian_renew_scope", {}], ["obsidian_release_scope", {}]] },
  { op: "plugin toggle, reload, install, uninstall", class: NOT, calls: [["obsidian_plugin_toggle", {}], ["obsidian_plugin_reload", {}], ["obsidian_plugin_install", {}], ["obsidian_plugin_uninstall", {}]] },
  { op: "snippet toggle", class: NOT, calls: [["obsidian_snippet_toggle", {}]] },
  { op: "open in editor, jump to, toggle view mode, open workspace, open bookmark", class: NOT, calls: [["obsidian_open_in_editor", {}], ["obsidian_jump_to", {}], ["obsidian_toggle_view_mode", {}], ["obsidian_open_workspace", {}], ["obsidian_open_bookmark", {}]] },
  { op: "save workspace", class: NOT, calls: [["obsidian_save_workspace", {}]] },
  { op: "send a message", class: NOT, calls: [["vaultmcp_send_message", {}]] },
  { op: "snippet write", class: "exempt (temporary)", calls: [["obsidian_snippet_write", {}]], code: "exempt", why: "it names no path and its file is under .obsidian/snippets, which has no revision the kernel can read; a required if_rev would refuse every overwrite" },
  { op: "periodic note", class: "exempt", calls: [["obsidian_periodic_note", {}]] },
  { op: "create note from template", class: "key", calls: [["obsidian_create_note_from_template", {}], ["obsidian_create_note", {}]] },
  { op: "base create", class: "key", calls: [["obsidian_base_create", {}]] },
  { op: "import Apple Notes", class: "key", calls: [["obsidian_import_apple_notes", {}]] },
  { op: "Obsidian CLI (run code in the application)", class: "key", calls: [["obsidian_cli", {}]] },
  { op: "fileclass insert fields", class: "token", calls: [["obsidian_fileclass_insert_fields", {}]] },
  { op: "survey slot", class: "token", calls: [["obsidian_survey_slot", {}]] },
  { op: "conformance debt render", class: "exempt (temporary)", calls: [["obsidian_conformance_debt_render", {}]], code: "exempt", why: "it names no path (it computes where the register goes), so a required if_rev would refuse every run" },
  { op: "call tool", class: "dispatcher", calls: [["obsidian_call_tool", {}]] },
  { op: "write note", class: "arg", calls: [], note: "covered by 'overwrite an existing note' and 'create if absent'" },
  { op: "write notes (batch)", class: "per-item", calls: [["obsidian_write_notes", {}]] },
  { op: "patch note, manage frontmatter", class: "arg", calls: [], note: "covered by the per-operation rows above" },
  { op: "satellite tools", class: "external", calls: [], note: "EXTERNAL_PUBLISHER_ROW" },
];

const ROWS = new Map(MCP_SURFACE_INVENTORY.map((r) => [r.tool, r]));
const expectedCode = (row) => {
  if (row.code) return row.code;
  if (row.class === NOT) return "not-a-write";
  return row.class;
};
const codeOf = (tool, args) => {
  const p = ROWS.get(tool)?.protection;
  if (p === undefined) return undefined;
  if (typeof p === "object") return requiredProtection(tool, args);
  return p;
};

describe("coverage — every guarded tool is classified", () => {
  test("every mutating inventory row carries a protection value; no read-only row does", () => {
    for (const r of MCP_SURFACE_INVENTORY) {
      if (r.readOnly) assert.equal(r.protection, undefined, `${r.tool} is read-only and needs no protection`);
      else assert.notEqual(r.protection, undefined, `${r.tool} is a write and is not classified (01.33 rule 6f)`);
    }
    assert.equal(EXTERNAL_PUBLISHER_ROW.protection, "external", "satellite tools are the named known gap");
  });

  test("every mutating inventory tool is named by some row of the 01.33 table", () => {
    const named = new Set(TABLE.flatMap((r) => r.calls.map(([t]) => t)));
    for (const r of MCP_SURFACE_INVENTORY) if (!r.readOnly) assert.ok(named.has(r.tool), `${r.tool} has no row in the 01.33 table`);
  });
});

describe("agreement — the code matches the pinned 01.33 table", () => {
  for (const row of TABLE) {
    for (const [tool, args] of row.calls) {
      if (!ROWS.has(tool)) continue; // a tool not on this branch yet (see the row's note)
      test(`${row.op} → ${tool}${Object.keys(args).length ? " " + JSON.stringify(args) : ""}: ${expectedCode(row)}`, () => {
        assert.equal(codeOf(tool, args), expectedCode(row), row.why ?? "");
      });
    }
  }
  // Nelson ruled three temporary exemptions; the third, obsidian_conformance_debt_render,
  // left the host with the conformance rail on 2026-10-14 (now the satellite tool
  // vaultmcp_conformance_debt_render, under the "satellite tools" row). Its 01.33
  // table row stays above, and is skipped here because the host no longer has the tool.
  test("the temporary exemptions in the host are Nelson's three less the one that left with the rail, each exempt with a one-line reason naming #427", () => {
    const noted = MCP_SURFACE_INVENTORY.filter((r) => r.protectionNote !== undefined);
    assert.deepEqual(noted.map((r) => r.tool).sort(), ["obsidian_repoint_link", "obsidian_snippet_write"]);
    for (const r of noted) {
      assert.equal(r.protection, "exempt", r.tool);
      assert.match(r.protectionNote, /^Temporarily exempt \(Nelson's "a", 2026-09-29\): .*back to token with #427\.$/, r.tool);
      assert.doesNotMatch(r.protectionNote, /\n/, `${r.tool}: one line`);
    }
    for (const row of TABLE.filter((r) => r.code)) assert.ok(row.why && row.why.length > 40, row.op);
  });
});

// ── the live note, where the vault is present ─────────────────────────────────
const NOTE = path.join(process.env.VAULT_MCP_LIVE_VAULT ?? path.join(os.homedir(), "obsidian"), "00-09 System/01 System architecture/01.33 Actions & the operation registry/01.33 Actions & the operation registry.md");
describe("the pinned table agrees with the 01.33 note (skipped where the vault is absent)", { skip: fs.existsSync(NOTE) ? false : `no note at ${NOTE}` }, () => {
  test("every row of Step 5's table is in the pinned copy with the same class, and no pinned row is missing from the note", () => {
    const text = fs.readFileSync(NOTE, "utf8");
    const start = text.indexOf("Declare the write protection of each write operation");
    const rows = text.slice(start).split("\n").filter((l) => /^\s*\| /.test(l)).slice(2)
      .map((l) => l.trim().split("|").slice(1, -1).map((c) => c.trim()))
      .map(([op, cls]) => ({ op, cls }));
    assert.ok(rows.length >= 30, `found ${rows.length} rows`);
    const norm = (c) => c.replace(/`/g, "").replace(/\s+/g, " ").trim();
    const noteClass = (c) => {
      const n = norm(c);
      if (/^not a vault write/.test(n)) return NOT;
      if (/^exempt with overwrite off; token with overwrite on/.test(n)) return "arg";
      if (/^token for replace, set, delete; key for append, prepend/.test(n)) return "arg";
      if (/^per item/.test(n)) return "per-item";
      if (/^— \(not classified\)/.test(n)) return "dispatcher";
      if (/^— \(known gap\)/.test(n)) return "external";
      return n;
    };
    const pinned = new Map(TABLE.map((r) => [r.op, r.class]));
    for (const { op, cls } of rows) {
      assert.ok(pinned.has(op), `the note has a row the pinned copy lacks: '${op}'`);
      assert.equal(noteClass(cls), pinned.get(op), `'${op}': the note says '${cls}'`);
    }
    const inNote = new Set(rows.map((r) => r.op));
    for (const op of pinned.keys()) assert.ok(inNote.has(op), `the pinned copy has a row the note lacks: '${op}'`);
  });
});

// ── the refusal ───────────────────────────────────────────────────────────────
describe("protectionRefusal — which argument, and how to get it", () => {
  test("token: names if_rev and says to read the note for its rev; write_note adds how to create instead", () => {
    const r = protectionRefusal("obsidian_write_note", { overwrite: true }, {});
    assert.equal(r.code, PROTECTION_REQUIRED);
    assert.match(r.message, /^'obsidian_write_note' requires if_rev \(protection 'token', 01\.33 rule 6f\)\. Nothing was written\./);
    assert.match(r.message, /obsidian_read_note returns `rev`/);
    assert.match(r.message, /To CREATE a new note, set overwrite: false instead/);
    assert.equal(protectionRefusal("obsidian_write_note", { overwrite: true }, { ifRev: 5 }), null);
  });
  test("key: names idempotency_key and says a new one per intended write; an empty key is no key", () => {
    const r = protectionRefusal("obsidian_append_note", {}, {});
    assert.match(r.message, /requires idempotency_key \(protection 'key'/);
    assert.match(r.message, /a new unique string for each intended write/);
    assert.doesNotMatch(r.message, /To CREATE/);
    assert.ok(protectionRefusal("obsidian_append_note", {}, { idempotencyKey: "" }));
    assert.equal(protectionRefusal("obsidian_append_note", {}, { idempotencyKey: "k" }), null);
  });
  test("both: names both when both are missing, and only the one that is", () => {
    assert.match(protectionRefusal("obsidian_trash", {}, {}).message, /requires if_rev and idempotency_key/);
    assert.match(protectionRefusal("obsidian_trash", {}, { ifRev: 1 }).message, /requires idempotency_key \(/);
    assert.match(protectionRefusal("obsidian_trash", {}, { idempotencyKey: "k" }).message, /requires if_rev \(/);
    assert.equal(protectionRefusal("obsidian_trash", {}, { ifRev: 1, idempotencyKey: "k" }), null);
  });
  test("exempt, not-a-write, dispatcher, per-item, the temporary exemptions, external and unknown tools require nothing", () => {
    for (const [t, a] of [["obsidian_write_note", { overwrite: false }], ["obsidian_write_note", {}], ["obsidian_periodic_note", {}], ["obsidian_claim_scope", {}], ["obsidian_call_tool", {}], ["obsidian_write_notes", {}], ["obsidian_repoint_link", {}], ["obsidian_snippet_write", {}], ["obsidian_conformance_debt_render", {}], ["vaultmcp_skills_export", {}], ["no_such_tool", {}]]) {
      assert.equal(protectionRefusal(t, a, {}), null, `${t} ${JSON.stringify(a)}`);
    }
  });
  test("argument-dependent: patch replace is a token, patch append a key; frontmatter get needs nothing", () => {
    assert.equal(requiredProtection("obsidian_patch_note", { op: "replace" }), "token");
    assert.equal(requiredProtection("obsidian_patch_note", { op: "append" }), "key");
    assert.equal(requiredProtection("obsidian_patch_note", {}), "token", "an absent op falls to the stricter class");
    assert.equal(requiredProtection("obsidian_manage_frontmatter", { op: "get" }), "exempt");
  });
});

// ── through the guard ─────────────────────────────────────────────────────────
function kernelHarness(revs = new Map()) {
  const files = new Map();
  const adapter = { async exists(p) { return files.has(p); }, async mkdir() {}, async write(p, d) { files.set(p, d); }, async append(p, d) { files.set(p, (files.get(p) ?? "") + d); } };
  const journal = new WriteJournal(adapter, "j", () => new Date("2026-09-29T12:00:00Z"));
  const kernel = new Kernel(new WriteQueue(1000), journal, { uid: () => undefined, rev: (p) => revs.get(p) }, new IdempotencyStore(), new LockStore());
  const records = () => (files.get("j/2026-09.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { kernel, records };
}
const RW = { annotations: { readOnlyHint: false } };
const ACTOR = { transport: "mcp", client: "t", connection: "c" };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("makeGuarded refuses a call missing its protection, before the queue", () => {
  test("an overwrite without if_rev is refused with the coded message; the handler never runs and nothing is journaled", async () => {
    const { kernel, records } = kernelHarness(new Map([["A.md", 7]]));
    const g = makeGuarded({ getSettings: () => ({ readOnly: false, allowlist: [] }), kernel, actor: () => ACTOR });
    let ran = false;
    const res = await g(RW, async () => { ran = true; return { content: [] }; }, "obsidian_write_note")({ path: "A.md", content: "x", overwrite: true }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[protection_required\]: 'obsidian_write_note' requires if_rev/);
    assert.equal(ran, false);
    await tick();
    assert.deepEqual(records(), [], "refused before the queue: no journal record");
  });
  test("the same overwrite WITH the note's rev runs; a create without one runs; an append needs its key", async () => {
    const { kernel } = kernelHarness(new Map([["A.md", 7]]));
    const g = makeGuarded({ getSettings: () => ({ readOnly: false, allowlist: [] }), kernel, actor: () => ACTOR });
    const ok = async () => ({ content: [{ type: "text", text: "ok" }] });
    assert.equal((await g(RW, ok, "obsidian_write_note")({ path: "A.md", content: "x", overwrite: true, if_rev: 7 }, {})).content[0].text, "ok");
    assert.equal((await g(RW, ok, "obsidian_write_note")({ path: "N.md", content: "x", overwrite: false }, {})).content[0].text, "ok");
    assert.match((await g(RW, ok, "obsidian_append_note")({ path: "A.md", content: "x" }, {})).content[0].text, /requires idempotency_key/);
    assert.equal((await g(RW, ok, "obsidian_append_note")({ path: "A.md", content: "x", idempotency_key: "k1" }, {})).content[0].text, "ok");
  });
  test("a non-write, a satellite tool and a build with no kernel are not refused", async () => {
    const { kernel } = kernelHarness();
    const g = makeGuarded({ getSettings: () => ({ readOnly: false, allowlist: [] }), kernel, actor: () => ACTOR });
    const ok = async () => ({ content: [{ type: "text", text: "ok" }] });
    assert.equal((await g(RW, ok, "obsidian_claim_scope")({ scope: "A" }, {})).content[0].text, "ok");
    assert.equal((await g(RW, ok, "vaultmcp_skills_export")({}, {})).content[0].text, "ok", "a satellite tool that declares nothing (apiVersion 2) is not enforced; tests/satellite-api-v3.test.mjs pins the declared case");
    const bare = makeGuarded({ getSettings: () => ({ readOnly: false, allowlist: [] }), actor: () => ACTOR });
    assert.equal((await bare(RW, ok, "obsidian_append_note")({ path: "A.md", content: "x" }, {})).content[0].text, "ok", "no kernel: neither argument could be honored");
  });
});

describe("the schema tells the agent before the guard does", () => {
  test("each kernel argument's description opens with the requirement the row states", () => {
    const d = (tool, arg) => withKernelArgs({ annotations: { readOnlyHint: false }, inputSchema: {} }, tool).inputSchema[arg].description;
    assert.match(d("obsidian_append_note", "idempotency_key"), /^REQUIRED for this tool \(01\.33 rule 6f\)/);
    assert.doesNotMatch(d("obsidian_append_note", "if_rev"), /REQUIRED/);
    assert.match(d("obsidian_trash", "if_rev"), /^REQUIRED for this tool/);
    assert.match(d("obsidian_trash", "idempotency_key"), /^REQUIRED for this tool/);
    assert.match(d("obsidian_write_note", "if_rev"), /^REQUIRED when overwrite is true \(01\.33 rule 6f\)/);
    assert.match(d("obsidian_patch_note", "if_rev"), /^REQUIRED when op is replace or op is anything else or omitted/);
    assert.match(d("obsidian_patch_note", "idempotency_key"), /^REQUIRED when op is append or op is prepend/);
    assert.doesNotMatch(d("obsidian_claim_scope", "if_rev"), /REQUIRED/);
    assert.doesNotMatch(d("obsidian_repoint_link", "if_rev"), /REQUIRED/, "a temporary exemption requires nothing until #427");
    assert.doesNotMatch(withKernelArgs({ annotations: { readOnlyHint: false }, inputSchema: {} }).inputSchema.if_rev.description, /REQUIRED/, "no name, no claim");
    assert.equal(requirementNote("no_such_tool", "if_rev"), null);
  });
  test("server.ts passes the tool's name to withKernelArgs (source pin)", () => {
    const src = fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    assert.match(src, /register\(name, withKernelArgs\(strictIfWrite\(def\), name\), handler\)/);
  });
});

// ── the README's copy of the table ────────────────────────────────────────────
describe("the README's per-tool table is the inventory's (Nelson: 'core host is fine as long as it's all documented in the readme')", () => {
  const README = new URL("../../../README.md", import.meta.url);
  const START = "<!-- protection-table:start -->\n", END = "\n<!-- protection-table:end -->";
  test("the copy between the markers equals protectionTableMarkdown(); VAULT_MCP_WRITE_README=1 rewrites it", () => {
    const text = fs.readFileSync(README, "utf8");
    const a = text.indexOf(START), b = text.indexOf(END);
    assert.ok(a >= 0 && b > a, "README.md has the protection-table markers");
    const want = protectionTableMarkdown();
    if (process.env.VAULT_MCP_WRITE_README === "1") fs.writeFileSync(README, text.slice(0, a + START.length) + want + text.slice(b));
    else assert.equal(text.slice(a + START.length, b), want, "README.md's protection table is stale: run this test with VAULT_MCP_WRITE_README=1");
  });
  test("the table names every write tool once, the three exemptions with their notes, and the satellite gap", () => {
    const t = protectionTableMarkdown();
    for (const r of MCP_SURFACE_INVENTORY.filter((r) => !r.readOnly)) assert.equal(t.split(`| \`${r.tool}\` |`).length - 1, 1, r.tool);
    assert.match(t, /\| `obsidian_repoint_link` \| nothing \| Temporarily exempt .*#427\. \|/);
    assert.match(t, /\| `obsidian_write_note` \| overwrite true: `if_rev`; any other overwrite, or none: nothing \|/);
    assert.match(t, /\| satellite tools \(`vaultmcp_\*`\) \| what the tool declares \(`protection`, satellite apiVersion 3\); a tool that declares nothing \(apiVersion 2\): not enforced \|/);
    assert.doesNotMatch(t, /obsidian_read_note`/, "read-only tools are not listed");
  });
  test("the README explains both arguments, every refusal a caller can see, the exemptions and the gap", () => {
    const text = fs.readFileSync(README, "utf8");
    for (const s of ["## Write protection: `if_rev` and `idempotency_key`", "`Error [protection_required]", "`Error [rev_conflict]", "`Error [idempotency_mismatch]", "`Error [precondition_unsupported]", "issues/427", "apiVersion 3", "obsidian_read_note` (and `obsidian_read_notes`) return `rev`"]) {
      assert.ok(text.includes(s), s);
    }
  });
});
