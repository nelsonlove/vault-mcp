/**
 * full-read.test.mjs — the road through the whole-note policy (#443).
 *
 * #442 made a note longer than the read limit unwritable whole over MCP. This
 * is the proof that lets one through, and it is mechanism: `obsidian_read_note`
 * with `full: true` serves the whole note with its rev, the transport
 * remembers (path, rev) for the idempotency window (`WholeReads`), and the two
 * whole-note rules stand aside for a call conditioned on that rev while the
 * note is still at it. Pinned here over the real FilesystemBackend:
 *   - the memory: same path and rev only, and only within the window;
 *   - the full read: whole content, `whole: true`, the rev, the memory told,
 *     and a backend without a whole read says so;
 *   - the rules: they stand aside on a proven whole read and nowhere else,
 *     and the trailer check never stands aside.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FilesystemBackend } from "../src/fs-backend/filesystem-backend.ts";
import { registerFsTools } from "../src/register-fs-tools.ts";
import { CHARACTER_LIMIT } from "../src/fs-backend/vault.ts";
import { WholeReads, WRITE_WINDOW_MS } from "../src/whole-reads.ts";
import { wholeNoteOverwriteRefusal } from "../src/truncation.ts";

const LONG = 150_000;
const BODY = "# Big\n\n" + "x".repeat(LONG - 7 - 10) + "\n\n## Tail\n";

function fakeServer() {
  const handlers = new Map();
  return {
    registerTool(name, meta, handler) { handlers.set(name, handler); return { name, meta }; },
    call(name, args) { return handlers.get(name)(args); },
  };
}

async function fixture({ rev = () => 1700, onWholeRead, wholeToken, onCutRead } = {}) {
  const vaultRoot = await mkdtemp(join(tmpdir(), "vault-443-"));
  const backend = new FilesystemBackend(vaultRoot);
  await backend.writeNote("Big.md", BODY, false);
  const server = fakeServer();
  registerFsTools(server, backend, { rev, onWholeRead, wholeToken, onCutRead });
  return { vaultRoot, backend, server };
}

describe("WholeReads — the memory", () => {
  test("remembers the path at its rev, for the window, and nothing else", () => {
    let now = 1_000_000;
    const m = new WholeReads(WRITE_WINDOW_MS, () => now);
    m.remember("A.md", 10);
    assert.equal(m.has("A.md", 10), true);
    assert.equal(m.has("A.md", 11), false, "another rev of the same path proves nothing");
    assert.equal(m.has("B.md", 10), false, "a remembered rev never carries to another path");
    assert.equal(m.has("A.md", undefined), false);
    m.remember("A.md", 12);
    assert.equal(m.has("A.md", 10), false, "a newer whole read replaces the older");
    assert.equal(m.has("A.md", 12), true);
    m.remember("A.md", 11);
    assert.equal(m.has("A.md", 11), true, "the latest whole read is the one remembered, whatever its token: a token is not ordered");
    assert.equal(m.has("A.md", 12), false);
    m.remember("S.md", "1700:123");
    assert.equal(m.has("S.md", "1700:123"), true, "a composed string token");
    assert.equal(m.has("S.md", "1700:124"), false);
    m.forget("S.md");
    assert.equal(m.has("S.md", "1700:123"), false, "a forgotten path proves nothing");
    assert.equal(WRITE_WINDOW_MS, 10 * 60_000, "one window, ten minutes");
    now += WRITE_WINDOW_MS + 1;
    assert.equal(m.has("A.md", 12), false, "the window is the idempotency window");
  });

  test("remember sweeps every entry past the window, so a sweep of whole reads holds only the last window", () => {
    let now = 1_000_000;
    const m = new WholeReads(WRITE_WINDOW_MS, () => now);
    for (let i = 0; i < 500; i++) m.remember(`N${i}.md`, i);
    assert.equal(m.size, 500);
    now += WRITE_WINDOW_MS + 1;
    for (let i = 0; i < 64; i++) m.remember(`Late${i}.md`, i);
    assert.ok(m.size <= 64, `the sweep ran within 64 remembers: ${m.size}`);
    assert.equal(m.has("Late63.md", 63), true);
    assert.equal(m.has("N1.md", 1), false);
  });
});

describe("obsidian_read_note full: true", () => {
  test("serves the whole note with whole: true and its rev, and tells the memory", async () => {
    const told = [];
    const { server } = await fixture({ onWholeRead: (p, r) => told.push([p, r]), wholeToken: () => ({ token: "1700:7", rev: 1700 }) });
    const res = await server.call("obsidian_read_note", { path: "Big.md", full: true });
    const sc = res.structuredContent;
    assert.equal(sc.content, BODY);
    assert.equal(sc.whole, true);
    assert.equal(sc.truncated, false);
    assert.equal(sc.rev, 1700);
    assert.deepEqual(told, [["Big.md", "1700:7"]]);
  });

  test("without full the read is cut as before; the memory is not told, and a cut read tells onCutRead (a whole one does not)", async () => {
    const told = [];
    const cuts = [];
    const { server, backend } = await fixture({ onWholeRead: (p, r) => told.push([p, r]), onCutRead: (p) => cuts.push(p) });
    const sc = (await server.call("obsidian_read_note", { path: "Big.md" })).structuredContent;
    assert.equal(sc.truncated, true);
    assert.equal("whole" in sc, false);
    assert.deepEqual(told, []);
    assert.deepEqual(cuts, ["Big.md"]);
    await backend.writeNote("Small.md", "# Small", false);
    await server.call("obsidian_read_note", { path: "Small.md" });
    await server.call("obsidian_read_notes", { paths: ["Small.md", "Big.md"] });
    assert.deepEqual(cuts, ["Big.md", "Big.md"], "only a cut read, on either read tool, tells it");
  });

  test("a backend with no whole read says so", async () => {
    const server = fakeServer();
    registerFsTools(server, { async readNote() { return "# A"; } }, {});
    const res = await server.call("obsidian_read_note", { path: "A.md", full: true });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cannot read a note whole/);
  });

  test("wholeToken names the whole read, sampled once before the content, with the rev the response shows", async () => {
    const told = [];
    const order = [];
    const vaultRoot = await mkdtemp(join(tmpdir(), "vault-443-"));
    const backend = new FilesystemBackend(vaultRoot);
    await backend.writeNote("Big.md", BODY, false);
    const inner = backend.readNoteWhole.bind(backend);
    backend.readNoteWhole = async (p) => { order.push("read"); return inner(p); };
    const server = fakeServer();
    registerFsTools(server, backend, { rev: () => 9999, wholeToken: (p) => { order.push("token"); return { token: `${p}:tok`, rev: 1700 }; }, onWholeRead: (p, t) => told.push([p, t]) });
    const whole = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    assert.equal(whole.whole, true);
    assert.equal(whole.rev, 1700, "the rev shown is the one sampled WITH the token, never a second sample");
    assert.deepEqual(told, [["Big.md", "Big.md:tok"]]);
    assert.deepEqual(order, ["token", "read"], "the token is sampled before the content is read");
    const noRev = fakeServer();
    registerFsTools(noRev, backend, { wholeToken: (p) => ({ token: `${p}:tok` }), onWholeRead: () => {} });
    assert.equal("rev" in (await noRev.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent, false, "a token without a rev shows none");
    const batch = (await server.call("obsidian_read_notes", { paths: ["Big.md"] })).structuredContent.notes[0];
    assert.equal(batch.rev, 9999, "the cut and batch roads show the rev hook's value as before; only the whole read samples it with the token");
  });

  test("without wholeToken nothing is remembered: a bare rev would never match the token's spelling", async () => {
    const told = [];
    const { server } = await fixture({ onWholeRead: (p, t) => told.push([p, t]) });
    const whole = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    assert.equal(whole.whole, true);
    assert.equal(whole.rev, 1700, "the rev is still shown");
    assert.deepEqual(told, []);
  });

  test("with a token source but no rev the whole read is served, remembered, and shows no rev", async () => {
    const told = [];
    const { server } = await fixture({ rev: () => undefined, wholeToken: () => ({ token: "t" }), onWholeRead: (p, r) => told.push([p, r]) });
    const sc = (await server.call("obsidian_read_note", { path: "Big.md", full: true })).structuredContent;
    assert.equal(sc.whole, true);
    assert.equal("rev" in sc, false);
    assert.deepEqual(told, [["Big.md", "t"]]);
  });
});

describe("the whole-note rules stand aside on a proven whole read only", () => {
  const noteLength = async (p) => (p === "Big.md" || p === "Other.md" ? LONG : undefined);
  test("the overwrite rule: proven → stands aside; not proven → refuses; the trailer check never stands aside", async () => {
    const { backend } = await fixture();
    const cut = await backend.readNote("Big.md");
    const yes = async () => true;
    const no = async () => false;
    assert.equal(await wholeNoteOverwriteRefusal({ path: "Big.md", content: BODY, overwrite: true }, noteLength, CHARACTER_LIMIT, yes), null);
    assert.equal((await wholeNoteOverwriteRefusal({ path: "Big.md", content: BODY, overwrite: true }, noteLength, CHARACTER_LIMIT, no))?.code, "truncated_read");
    assert.equal((await wholeNoteOverwriteRefusal({ path: "Big.md", content: BODY, overwrite: true }, noteLength, CHARACTER_LIMIT))?.code, "truncated_read");
    assert.ok(cut.includes("[truncated:"), "the cut read is the trailer check's business, not this rule's");
  });

  test("the replace rule: patchNote with rangeRuleStandsAside lands a replace past the limit; without, refuses", async () => {
    const { backend, vaultRoot } = await fixture();
    await assert.rejects(backend.patchNote("Big.md", { type: "heading", value: "Big" }, "replace", "whole rewrite"), { code: "truncated_read" });
    // `wholeSection`: the H1's section is the whole note, replaced on purpose (#601).
    const r = await backend.patchNote("Big.md", { type: "heading", value: "Big" }, "replace", "whole rewrite", { rangeRuleStandsAside: true, wholeSection: true });
    assert.equal(r.found, true);
    const disk = await readFile(join(vaultRoot, "Big.md"), "utf8");
    assert.match(disk, /^# Big\n[\s\S]*whole rewrite/);
    assert.equal(disk.includes("## Tail"), false, "the section past the limit was replaced, as the proven whole read allows");
    assert.ok(disk.length < 100, "the note is the rewrite, not the old body");
  });

  test("readNoteWhole is the whole note, and a rewrite from it lands through the backend", async () => {
    const { backend, vaultRoot } = await fixture();
    const whole = await backend.readNoteWhole("Big.md");
    assert.equal(whole, BODY);
    await writeFile(join(vaultRoot, "Big.md"), BODY);
    await backend.writeNote("Big.md", whole.replace("# Big", "# Big (rewritten)"), true);
    assert.match(await readFile(join(vaultRoot, "Big.md"), "utf8"), /^# Big \(rewritten\)/);
  });
});
