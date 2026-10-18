// Satellite apiVersion 3 (#550): a tool published through the external-tool
// registry declares its write protection, its Sync-guard membership and its path
// arguments, and the host enforces them exactly as for a host tool. Each test runs
// the real pipeline a satellite call takes: ExternalToolRegistry.registerTools →
// registerExternalTools → withKernelArgs → makeGuarded (with a real Kernel).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ExternalToolRegistry, registerExternalTools, validateDeclaration } from "../src/mcp/external-tools.ts";
import { makeGuarded, withKernelArgs } from "../src/mcp/guarded.ts";
import { createSyncGuard, normalizeSyncGuard, SYNC_BEHIND, syncKindOf } from "../src/kernel/sync-guard.ts";
import { requiredProtection } from "../src/kernel/write-protection.ts";
import { declarationOf, TOOL_DECLARATION } from "../src/kernel/tool-declaration.ts";
import { Kernel, WriteQueue, WriteJournal, IdempotencyStore, LockStore } from "../src/kernel/index.ts";

const OWNER = "vaultmcp-scheme";
const ACTOR = { transport: "mcp", client: "t", connection: "c" };
const NOW = 1_800_000_000_000;
const tick = () => new Promise((r) => setTimeout(r, 5));
const synced = (over = {}) => ({ state: "fields", fields: { ready: true, error: null, pause: false, syncStatus: "Fully synced", pendingPaths: [], socketOpen: true, lastMessageTs: NOW - 1000, ...over } });

function kernelHarness() {
  const files = new Map();
  const adapter = { async exists(p) { return files.has(p); }, async mkdir() {}, async write(p, d) { files.set(p, d); }, async append(p, d) { files.set(p, (files.get(p) ?? "") + d); } };
  const journal = new WriteJournal(adapter, "j", () => new Date("2026-10-15T12:00:00Z"));
  const kernel = new Kernel(new WriteQueue(1000), journal, { uid: () => undefined, rev: () => 1 }, new IdempotencyStore(), new LockStore());
  const records = () => (files.get("j/2026-10.jsonl") ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { kernel, records };
}

// A scheme-like satellite tool: moves the note `path` names to a computed address.
const schema = { type: "object", properties: { path: { type: "string" }, address: { type: "string" }, dry_run: { type: "boolean" }, note_path: { type: "string" } } };
function tool(name, extra = {}, onRun = () => {}) {
  return { name, description: `${name} desc`, inputSchema: schema, handler: async (args) => { onRun(args); return { moved: args.path ?? null }; }, ...extra };
}
const V3_ASSIGN = { protection: "key", sync: { kind: "structure", strictStatus: true, destinationUnnamed: true }, paths: ["path"] };

/** Publish `specs` and return a caller for each bare name, through the real guard. */
function publish(specs, { settings = { readOnly: false, allowlist: [] }, syncGuard } = {}) {
  const { kernel, records } = kernelHarness();
  const reg = new ExternalToolRegistry();
  reg.registerTools(OWNER, specs);
  const calls = [];
  const server = { registerTool: (name, def, handler) => calls.push({ name, def, handler }) };
  registerExternalTools(server, { plugins: { plugins: { [OWNER]: {} } } }, { getSettings: () => settings, getExternalTools: () => reg.entries() });
  const g = makeGuarded({ getSettings: () => settings, kernel, actor: () => ACTOR, ...(syncGuard ? { syncGuard } : {}) });
  const call = (bare) => {
    const c = calls.find((x) => x.name === `vaultmcp_scheme_${bare}`);
    assert.ok(c, `registered ${bare}`);
    const def = withKernelArgs(c.def, c.name);
    return (args) => g(def, c.handler, c.name)(args, {});
  };
  return { call, calls, records, reg };
}

function clockGuard(stateOf) {
  let t = NOW;
  const sleeps = [];
  const guard = createSyncGuard(() => ({ settings: normalizeSyncGuard({ enabled: true, waitSeconds: 5, strictWaitSeconds: 5 }), read: () => stateOf(t), now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, pollMs: 1000 }));
  return { guard, sleeps, elapsed: () => t - NOW };
}

describe("Sync guard: a v3 satellite tool is on the list it declares", () => {
  test("a v3 rename (strictStatus) waits for Fully synced, then runs", async () => {
    let ran = 0;
    // "Indexing..." for the first 2 s, then Fully synced.
    const { guard, sleeps, elapsed } = clockGuard((t) => synced({ syncStatus: t - NOW < 2000 ? "Indexing..." : "Fully synced" }));
    const { call } = publish([tool("assign", V3_ASSIGN, () => ran++)], { syncGuard: guard });
    const res = await call("assign")({ path: "A/n.md", idempotency_key: "k1" });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.ok(sleeps.length > 0 && elapsed() >= 2000, "it waited for the status to say Fully synced");
    assert.equal(ran, 1);
  });
  test("a v3 rename is refused sync_behind while Sync never says Fully synced; the handler never runs", async () => {
    let ran = 0;
    const { guard } = clockGuard(() => synced({ syncStatus: "Indexing..." }));
    const { call } = publish([tool("assign", V3_ASSIGN, () => ran++)], { syncGuard: guard });
    const res = await call("assign")({ path: "A/n.md", idempotency_key: "k1" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, new RegExp(`^Error \\[${SYNC_BEHIND}\\]: 'vaultmcp_scheme_assign'`));
    assert.match(res.content[0].text, /Fully synced/);
    assert.equal(ran, 0);
  });
  test("destinationUnnamed: a server change waiting anywhere in the vault holds a v3 structure write; without the flag it does not", async () => {
    const elsewhere = () => synced({ pendingPaths: ["Z/other.md"] });
    const g1 = clockGuard(elsewhere);
    const named = publish([tool("assign", V3_ASSIGN)], { syncGuard: g1.guard });
    assert.match((await named.call("assign")({ path: "A/n.md", idempotency_key: "k" })).content[0].text, /^Error \[sync_behind\].*not yet pulled/);
    const g2 = clockGuard(elsewhere);
    const plain = publish([tool("move", { protection: "key", sync: { kind: "structure" }, paths: ["path"] })], { syncGuard: g2.guard });
    assert.equal((await plain.call("move")({ path: "A/n.md", idempotency_key: "k" })).isError, undefined, "the pending change is not at the write's path");
  });
  test("an argument-dependent kind: a dry run is content (warns), a real run is structure (refused)", async () => {
    const { guard } = clockGuard(() => synced({ socketOpen: false }));
    const spec = tool("assign", { protection: "key", sync: { kind: { arg: "dry_run", values: { true: "content" }, otherwise: "structure" } }, paths: ["path"] });
    const { call } = publish([spec], { syncGuard: guard });
    assert.match((await call("assign")({ path: "A/n.md", idempotency_key: "a" })).content[0].text, /^Error \[sync_behind\]/);
    const dry = await call("assign")({ path: "A/n.md", dry_run: true, idempotency_key: "b" });
    assert.equal(dry.isError, undefined);
    assert.ok(dry.content.some((c) => /^Warning \[sync_behind\]/.test(c.text)));
  });
  test("v2 unchanged: the same tool without a declaration is not checked by the Sync guard", async () => {
    let asked = 0;
    const { guard } = clockGuard(() => { asked++; return synced({ syncStatus: "Indexing...", socketOpen: false }); });
    const { call } = publish([tool("assign")], { syncGuard: guard });
    const res = await call("assign")({ path: "A/n.md" });
    assert.equal(res.isError, undefined);
    assert.equal(asked, 0, "a tool the guard does not know is not judged");
  });
});

describe("write protection: a v3 satellite tool's declared class is enforced like a host row", () => {
  test("declared key: a call without idempotency_key is refused before the queue and not journaled; with one it runs", async () => {
    let ran = 0;
    const { call, records } = publish([tool("assign", V3_ASSIGN, () => ran++)]);
    const res = await call("assign")({ path: "A/n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[protection_required\]: 'vaultmcp_scheme_assign' requires idempotency_key \(protection 'key'/);
    assert.equal(ran, 0);
    await tick();
    assert.deepEqual(records(), [], "refused before the queue");
    assert.equal((await call("assign")({ path: "A/n.md", idempotency_key: "k1" })).isError, undefined);
    assert.equal(ran, 1);
  });
  test("declared token and both: if_rev is required, and both names whichever is missing", async () => {
    const { call } = publish([
      tool("edit", { protection: "token", paths: ["path"] }),
      tool("drop", { protection: "both", paths: ["path"] }),
    ]);
    assert.match((await call("edit")({ path: "A.md" })).content[0].text, /requires if_rev \(protection 'token'/);
    assert.equal((await call("edit")({ path: "A.md", if_rev: 1 })).isError, undefined);
    assert.match((await call("drop")({ path: "A.md" })).content[0].text, /requires if_rev and idempotency_key/);
    assert.match((await call("drop")({ path: "A.md", if_rev: 1 })).content[0].text, /requires idempotency_key \(/);
    assert.equal((await call("drop")({ path: "A.md", if_rev: 1, idempotency_key: "k" })).isError, undefined);
  });
  test("argument-dependent protection follows the argument; exempt requires nothing", async () => {
    const { call } = publish([
      tool("assign", { protection: { arg: "dry_run", values: { true: "exempt" }, otherwise: "key" }, paths: ["path"] }),
      tool("make", { protection: "exempt", paths: ["path"] }),
    ]);
    assert.equal((await call("assign")({ path: "A.md", dry_run: true })).isError, undefined);
    assert.match((await call("assign")({ path: "A.md" })).content[0].text, /requires idempotency_key/);
    assert.equal((await call("make")({ path: "A.md" })).isError, undefined);
  });
  test("the same idempotency key replays the first result and is journaled as deduped, exactly as for a host tool", async () => {
    let ran = 0;
    const { call, records } = publish([tool("assign", V3_ASSIGN, () => ran++)]);
    const first = await call("assign")({ path: "A/n.md", idempotency_key: "same" });
    const second = await call("assign")({ path: "A/n.md", idempotency_key: "same" });
    assert.equal(ran, 1, "the retry did not run again");
    assert.deepEqual(second.structuredContent, first.structuredContent);
    await tick();
    assert.deepEqual(records().map((r) => [r.op, r.outcome]), [["vaultmcp_scheme_assign", "ok"], ["vaultmcp_scheme_assign", "deduped"]]);
    assert.equal(records()[0].target.path, "A/n.md");
  });
  test("the schema says what the guard enforces", () => {
    const { calls } = publish([tool("assign", V3_ASSIGN)]);
    const def = withKernelArgs(calls[0].def, calls[0].name);
    assert.match(def.inputSchema.idempotency_key.description, /^REQUIRED for this tool \(01\.33 rule 6f\)/);
    assert.doesNotMatch(def.inputSchema.if_rev.description, /REQUIRED/);
  });
  test("v2 unchanged: a satellite tool that declares nothing requires nothing", async () => {
    const { call } = publish([tool("assign")]);
    assert.equal((await call("assign")({ path: "A.md" })).isError, undefined);
  });
  test("the inventory wins: a declaration cannot weaken a host tool's row", () => {
    assert.equal(requiredProtection("obsidian_move_note", {}, "exempt"), "key");
    assert.equal(requiredProtection("vaultmcp_scheme_assign", {}, "both"), "both");
    assert.equal(requiredProtection("vaultmcp_scheme_assign", {}), null);
  });
  test("a declaration with a '__proto__' value key is refused at registration (#553 review 2)", () => {
    const values = JSON.parse('{"__proto__": "both"}');
    assert.throws(() => validateDeclaration(tool("assign", { protection: { arg: "address", values, otherwise: "both" }, paths: ["path"] })), /__proto__/);
  });
  test("an inherited key never stands in for a per-argument rule (#553 review 1)", () => {
    const prot = { arg: "mode", values: { dry: "exempt" }, otherwise: "both" };
    for (const mode of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      assert.equal(requiredProtection("vaultmcp_x_write", { mode }, prot), "both", mode);
    }
    assert.equal(requiredProtection("vaultmcp_x_write", { mode: "dry" }, prot), "exempt");
    const sync = { arg: "mode", values: { dry: "content" }, otherwise: "structure" };
    for (const mode of ["constructor", "toString", "__proto__"]) {
      assert.equal(syncKindOf("vaultmcp_x_write", { mode }, { kind: sync }), "structure", mode);
    }
  });
});

describe("path allowlist: a v3 path-declared write is checked per path", () => {
  const settings = { readOnly: false, allowlist: ["Allowed"] };
  test("an allowed path passes; another path is refused out_of_allowlist; the handler runs only for the first", async () => {
    const ran = [];
    const { call } = publish([tool("assign", V3_ASSIGN, (a) => ran.push(a.path))], { settings });
    assert.equal((await call("assign")({ path: "Allowed/a.md", idempotency_key: "k1" })).isError, undefined);
    const out = await call("assign")({ path: "Other/b.md", idempotency_key: "k2" });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /^Error \[out_of_allowlist\]: path 'Other\/b\.md'/);
    assert.deepEqual(ran, ["Allowed/a.md"]);
  });
  test("a call none of whose declared path arguments carries a path is refused, naming the declared arguments", async () => {
    let ran = 0;
    const { call } = publish([tool("assign", { protection: "key", paths: ["note_path"] }, () => ran++)], { settings });
    const res = await call("assign")({ address: "06.11", idempotency_key: "k" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /declared path arguments \(note_path\)/);
    assert.equal((await call("assign")({ note_path: "Allowed/x.md", idempotency_key: "k2" })).isError, undefined);
    assert.match((await call("assign")({ note_path: "Elsewhere/x.md", idempotency_key: "k3" })).content[0].text, /^Error \[out_of_allowlist\]/);
    assert.equal(ran, 1);
  });
  test("v2 unchanged: a pathless v2 tool is still blocked wholesale under an allowlist", async () => {
    const { call } = publish([{ ...tool("assign"), inputSchema: { type: "object", properties: { address: { type: "string" } } } }], { settings });
    assert.match((await call("assign")({ address: "06.11" })).content[0].text, /no recognized path field/);
  });
});

describe("registration fails closed on a malformed declaration", () => {
  const throwsFor = (extra, re, base = {}) => {
    const reg = new ExternalToolRegistry();
    assert.throws(() => reg.registerTools(OWNER, [tool("ok_tool"), tool("bad", { ...extra }), ...[base].filter((b) => b.name)]), (e) => e instanceof TypeError && re.test(e.message), JSON.stringify(extra));
    assert.equal(reg.entries().length, 0, "atomic: nothing registered");
  };
  test("each malformed shape is refused with a message naming the fault", () => {
    throwsFor({ protection: "strong" }, /protection must be one of token, key, both, exempt/);
    throwsFor({ protection: 3 }, /protection must be a class string/);
    throwsFor({ protection: { arg: "missing", values: {}, otherwise: "key" } }, /'missing' is not a property of the tool's inputSchema/);
    throwsFor({ protection: { arg: "dry_run", values: { true: "none" }, otherwise: "key" } }, /values\['true'\] must be one of/);
    throwsFor({ protection: { arg: "dry_run", values: {}, otherwise: "key", extra: 1 } }, /unknown key 'extra'/);
    throwsFor({ protection: "key", sync: { kind: "rename" } }, /sync\.kind must be structure, content/);
    throwsFor({ protection: "key", sync: {} }, /sync\.kind is required/);
    throwsFor({ protection: "key", sync: { kind: "structure", strictstatus: true } }, /unknown key 'strictstatus'/);
    throwsFor({ protection: "key", sync: { kind: "structure", strictStatus: "yes" } }, /sync\.strictStatus must be a boolean/);
    throwsFor({ protection: "key", sync: { kind: "content", strictStatus: true } }, /apply to a structure write/);
    throwsFor({ protection: "key", paths: "path" }, /paths must be an array/);
    throwsFor({ protection: "key", paths: ["address"] }, /'address' is not a path key the host recognizes/);
    throwsFor({ protection: "key", paths: ["path", "path"] }, /listed twice/);
    throwsFor({ protection: "key", paths: ["to"] }, /'to' is not a property of the tool's inputSchema/);
    throwsFor({ protection: { arg: "if_rev", values: {}, otherwise: "key" } }, /is a kernel argument/);
    throwsFor({ sync: { kind: "structure" } }, /must also declare protection/);
    throwsFor({ paths: ["path"] }, /must also declare protection/);
    throwsFor({ annotations: { readOnlyHint: true }, protection: "key" }, /claims readOnlyHint cannot declare protection/);
    throwsFor({ annotations: { readOnlyHint: true }, sync: { kind: "content" } }, /claims readOnlyHint cannot declare sync/);
  });
  test("a read-only tool may declare paths alone, and a valid declaration is frozen on the entry", () => {
    const reg = new ExternalToolRegistry();
    reg.registerTools(OWNER, [tool("look", { annotations: { readOnlyHint: true }, paths: ["path"] }), tool("assign", V3_ASSIGN)]);
    const [look, assign] = reg.entries();
    assert.deepEqual(look.declaration, { paths: ["path"] });
    assert.deepEqual(assign.declaration, { protection: "key", sync: { kind: "structure", strictStatus: true, destinationUnnamed: true }, paths: ["path"] });
    assert.ok(Object.isFrozen(assign.declaration) && Object.isFrozen(assign.declaration.sync) && Object.isFrozen(assign.declaration.paths));
    // A later edit of the publisher's spec object changes nothing the host enforces.
    assign.spec.protection = "exempt";
    assert.equal(reg.entries()[1].declaration.protection, "key");
  });
  test("a malformed entry that bypassed the registry is skipped at connection build, the others register", () => {
    const calls = [];
    const server = { registerTool: (name, def, handler) => calls.push({ name, def, handler }) };
    const entries = [
      { ownerId: OWNER, toolName: "vaultmcp_scheme_bad", spec: tool("bad", { protection: "nope" }) },
      { ownerId: OWNER, toolName: "vaultmcp_scheme_good", spec: tool("good", V3_ASSIGN) },
    ];
    registerExternalTools(server, { plugins: { plugins: { [OWNER]: {} } } }, { getSettings: () => ({ readOnly: false, allowlist: [] }), getExternalTools: () => entries });
    assert.deepEqual(calls.map((c) => c.name), ["vaultmcp_scheme_good"]);
    assert.equal(declarationOf(calls[0].def).protection, "key");
  });
});

describe("v2 behaviour is unchanged", () => {
  test("a v2 spec has no declaration, and its registered definition carries none", () => {
    assert.equal(validateDeclaration(tool("assign")), undefined);
    const { calls, reg } = publish([tool("assign")]);
    assert.equal(reg.entries()[0].declaration, undefined);
    assert.equal(TOOL_DECLARATION in calls[0].def, false);
    assert.equal(declarationOf(withKernelArgs(calls[0].def, calls[0].name)), undefined);
  });
  test("the declaration survives withKernelArgs, and never reaches a string key the MCP wire could serialize", () => {
    const { calls } = publish([tool("assign", V3_ASSIGN)]);
    const def = withKernelArgs(calls[0].def, calls[0].name);
    assert.equal(declarationOf(def).protection, "key");
    assert.equal(JSON.stringify(Object.keys(def)).includes("declaration"), false);
  });
  test("a trusted read-only tool carries no declaration to the guard", () => {
    const reg = new ExternalToolRegistry();
    reg.registerTools(OWNER, [tool("look", { annotations: { readOnlyHint: true }, paths: ["path"] })]);
    const calls = [];
    registerExternalTools({ registerTool: (name, def, handler) => calls.push({ name, def, handler }) }, { plugins: { plugins: { [OWNER]: {} } } }, { getSettings: () => ({ readOnly: false, allowlist: [], trustedReadOnlyPlugins: [OWNER] }), getExternalTools: () => reg.entries() });
    assert.equal(calls[0].def.annotations.readOnlyHint, true);
    assert.equal(declarationOf(calls[0].def), undefined);
  });
});
