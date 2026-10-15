/**
 * conformance-drift-pack.test.mjs — the drift rule pack (drift ← drift_audit.py)
 * as it stands after #412 retired the checks that measured a vault shape the
 * rebuilt vault no longer has: A, B, D, F and G are gone; E (duplicate uid)
 * and J (category-number collisions on the System spine) remain.
 *
 * The drift pack maps each Python finding string `"{LETTER}: {rest}"` onto the
 * canonical 4-tuple Finding keyed BYTE-IDENTICAL to the ratchet's `parse_drift`:
 *   { script: "drift_audit", check: <LETTER>, target: <rest>, kind: "" }
 * for J; E's Python message embeds volatile data (an order-dependent homes
 * list), so `parse_drift`'s docstring keys it on the uid alone (target <uid>,
 * kind "dup-uid") — the accepted-debt baseline's keys carry across the port
 * AND stay stable under unrelated edits (issue #136: keying E on the raw
 * message text produces a permanent false-NEW treadmill, since the message
 * changes on every additional claimant).
 *
 * Both surviving checks are exercised here, plus a clean fixture, the empty
 * `kind`, the E traversal-order + scope edges, the KEY STABILITY test for E,
 * and the #412 retirement pins: the retired letters are never emitted, the
 * pack reads only `systemRoot`, and the listings the retired checks needed
 * (`files`, `obsidianConfig`) are no longer required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { driftPack } from "../src/kernel/packs/index.ts";
import { LEGACY_CONVENTIONS_SEED as SEED } from "../src/kernel/vault-conventions.ts";
import { findingKey } from "../src/kernel/finding.ts";
import { runEngine } from "../src/kernel/engine.ts";

/** Build the drift-shaped snapshot: `sources`, `dirs` (J's universe) and
 * `walkOrder` (E's). Nothing else is required of it since #412. */
function snap({ sources = [], dirs = [], walkOrder = [] } = {}) {
  return { notes: [], paths: [], blueprints: [], sources, dirs, walkOrder };
}
const run = (s) => driftPack(SEED).run(s);
const targets = (findings, letter) => findings.filter((f) => f.check === letter).map((f) => f.target);

// ── key shape ─────────────────────────────────────────────────────────────────

describe("driftPack key shape", () => {
  test("script is drift_audit, check is the letter, target is the message body, kind is empty", () => {
    const findings = run(snap({ dirs: ["00-09 System/00 A", "00-09 System/00 B"] }));
    const f = findings.find((x) => x.check === "J");
    assert.ok(f, "expected a J finding");
    assert.equal(f.script, "drift_audit");
    assert.equal(f.check, "J");
    assert.equal(f.kind, ""); // empty kind → serialized key carries a trailing pipe
    assert.equal(f.target, "category number 00 is claimed by 2 folders: 00 A; 00 B");
  });

  test("the empty fixture yields no findings", () => {
    assert.deepEqual(run(snap()), []);
  });
});

// ── E. uid identity in raw traversal order ─────────────────────────────────────
//
// E is keyed specially (issue #136): its MESSAGE (`detail`) still carries the
// traversal-ordered homes list, and is asserted below exactly as before. But
// the ratchet KEY — `target`/`kind`, what `findingKey()` serializes — must NOT
// move when that volatile data changes. The "key stability" test is the
// load-bearing regression coverage: a message-level parity check cannot catch
// this class of bug by construction, only a key-level one can.

describe("driftPack E (duplicate uid)", () => {
  const UID = "0192f1a0-1234-7abc-8def-0123456789ab";
  const withUid = (p, uid = UID) => ({ path: p, text: `---\nuid: ${uid}\n---\nbody\n` });
  const noUid = (p) => ({ path: p, text: "---\ntitle: x\n---\nbody\n" });

  test("two notes sharing a uid → one finding, homes joined in traversal order in `detail`", () => {
    const s = snap({
      walkOrder: ["Notes/a.md", "Notes/b.md"],
      sources: [withUid("Notes/a.md"), withUid("Notes/b.md")],
    });
    const findings = run(s).filter((f) => f.check === "E");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail, `E: uid ${UID} is claimed by 2 notes: Notes/a.md; Notes/b.md`);
  });

  test("key: keyed on the uid, not the homes list (issue #136) — target is the uid, kind is 'dup-uid'", () => {
    const s = snap({
      walkOrder: ["Notes/a.md", "Notes/b.md"],
      sources: [withUid("Notes/a.md"), withUid("Notes/b.md")],
    });
    const f = run(s).find((x) => x.check === "E");
    assert.equal(f.target, UID);
    assert.equal(f.kind, "dup-uid");
    assert.equal(findingKey(f), `drift_audit|E|${UID}|dup-uid`);
  });

  test("key stability: a THIRD claimant joins (changing the homes list and its order) — the key is unchanged", () => {
    const two = snap({
      walkOrder: ["Notes/a.md", "Notes/b.md"],
      sources: [withUid("Notes/a.md"), withUid("Notes/b.md")],
    });
    const keyBefore = findingKey(run(two).find((f) => f.check === "E"));

    // A third claimant joins, ahead of the other two in traversal order —
    // this changes both the COUNT and the ORDER of the homes list embedded
    // in the message.
    const three = snap({
      walkOrder: ["Notes/zzz.md", "Notes/a.md", "Notes/b.md"],
      sources: [withUid("Notes/zzz.md"), withUid("Notes/a.md"), withUid("Notes/b.md")],
    });
    const fAfter = run(three).find((f) => f.check === "E");
    const keyAfter = findingKey(fAfter);

    assert.equal(keyAfter, keyBefore, "the E key must be stable when an unrelated claimant joins");
    // The message DID change — proving a message-level check would have
    // reported a false NEW finding here.
    assert.equal(fAfter.detail, `E: uid ${UID} is claimed by 3 notes: Notes/zzz.md; Notes/a.md; Notes/b.md`);
  });

  test("findings are sorted by uid; a uid held by one note is not a finding", () => {
    const LOW = "0000f1a0-1234-7abc-8def-0123456789ab";
    const s = snap({
      walkOrder: ["Notes/a.md", "Notes/b.md", "Notes/c.md", "Notes/d.md", "Notes/only.md"],
      sources: [withUid("Notes/a.md"), withUid("Notes/b.md"), withUid("Notes/c.md", LOW), withUid("Notes/d.md", LOW), withUid("Notes/only.md", "ffff0000-1234-7abc-8def-0123456789ab")],
    });
    assert.deepEqual(targets(run(s), "E"), [LOW, UID]);
  });

  test("a non-UUID uid value is no identity: two notes sharing one are not duplicate claimants", () => {
    const bad = (p) => ({ path: p, text: "---\nuid: not-a-uuid\n---\n" });
    const s = snap({ walkOrder: ["Notes/x.md", "Notes/y.md"], sources: [bad("Notes/x.md"), bad("Notes/y.md")] });
    assert.deepEqual(run(s), []);
  });

  test("the carve-out is GONE (#412): a duplicate claimant at the seed's former uid-exempt path IS a home, and the pair is a finding", () => {
    const tpl = "00-09 System/00 System management/00.05 Registries for the system/Daily notes/Daily note.template.md";
    const s = snap({ walkOrder: [tpl, "Notes/a.md"], sources: [withUid(tpl), withUid("Notes/a.md")] });
    const [f] = run(s);
    assert.ok(f && f.check === "E", "the former exemption no longer hides a claimant");
    assert.equal(f.detail, `E: uid ${UID} is claimed by 2 notes: ${tpl}; Notes/a.md`);
    // and no path shape is exempt under another name either
    const t2 = "Templates/x.template.md";
    assert.equal(run(snap({ walkOrder: [t2, "Notes/a.md"], sources: [withUid(t2), withUid("Notes/a.md")] })).length, 1);
  });

  test("a blank or absent uid is no identity", () => {
    const blank = (p) => ({ path: p, text: "---\nuid:\n---\n" });
    const s = snap({ walkOrder: ["T/a.md", "T/b.md", "Notes/c.md"], sources: [blank("T/a.md"), blank("T/b.md"), noUid("Notes/c.md")] });
    assert.deepEqual(run(s), []);
  });

  test("iter_notes scope: dot/.trash segments, _ roots, and Assent are excluded — a duplicate claimant there is invisible", () => {
    const outside = ["_hold/s.md", "Assent/t.md", ".obsidian/u.md", "x/.hidden/v.md"];
    for (const p of outside) {
      const s = snap({ walkOrder: [p, "Notes/real.md"], sources: [withUid(p), withUid("Notes/real.md")] });
      assert.deepEqual(run(s), [], `${p} is outside the governed scope`);
    }
    const inside = snap({ walkOrder: ["Notes/other.md", "Notes/real.md"], sources: [withUid("Notes/other.md"), withUid("Notes/real.md")] });
    assert.equal(run(inside).length, 1, "the same pair inside the scope IS a finding");
  });

  test("a walked path with no source text is skipped, not a crash (Python's `except: continue`)", () => {
    const s = snap({ walkOrder: ["Notes/gone.md", "Notes/a.md", "Notes/b.md"], sources: [withUid("Notes/a.md"), withUid("Notes/b.md")] });
    assert.equal(run(s).length, 1);
  });
});

// ── J. category-number collisions on the System spine ─────────────────────────

describe("driftPack J (category numbering)", () => {
  test("a two-digit code claimed by more than one direct child of the System spine", () => {
    const dirs = [
      "00-09 System/00 Alpha",
      "00-09 System/00 Beta",
      "00-09 System/01 Gamma",
      "00-09 System/00 Alpha/nested 00 deep", // NOT a direct child → ignored
      "Other/00 Elsewhere", // NOT under the spine → ignored
    ];
    const t = targets(run(snap({ dirs })), "J");
    assert.deepEqual(t, ["category number 00 is claimed by 2 folders: 00 Alpha; 00 Beta"]);
  });

  test("J reads the INJECTED systemRoot: the same folders under another spine are a collision only when the conventions name that spine", () => {
    const dirs = ["Sys/00 Alpha", "Sys/00 Beta"];
    assert.deepEqual(targets(run(snap({ dirs })), "J"), [], "under the seed's spine these folders are invisible");
    assert.deepEqual(targets(driftPack({ ...SEED, systemRoot: "Sys" }).run(snap({ dirs })), "J"), ["category number 00 is claimed by 2 folders: 00 Alpha; 00 Beta"]);
  });

  test("the claimants in a J message are SORTED, whatever order the walk listed them (the key is a function of the vault)", () => {
    const dirs = ["00-09 System/00 Zeta", "00-09 System/00 Alpha", "00-09 System/00 Mid"];
    assert.deepEqual(targets(run(snap({ dirs })), "J"), ["category number 00 is claimed by 3 folders: 00 Alpha; 00 Mid; 00 Zeta"]);
  });

  test("a folder whose name does not start with a two-digit code and a space is not a claimant", () => {
    const dirs = ["00-09 System/00 Alpha", "00-09 System/00Beta", "00-09 System/000 Gamma", "00-09 System/Delta"];
    assert.deepEqual(run(snap({ dirs })), []);
  });
});

// ── #412: the retirement is real, and pinned ───────────────────────────────────

describe("#412 — A, B, D, F and G are retired; the pack reads only systemRoot", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, "..", "src", "kernel", "packs", "drift.ts"), "utf8");

  test("the retired letters are never emitted: a snapshot carrying every retired check's former subject yields only E and J letters", () => {
    const FBF = SEED.registriesRoot;
    const sources = [
      // G / A / D subjects: a registry family with a wrong title, a ghost choice, a missing module
      { path: `${FBF}/Actions/ghost.action.md`, text: "---\ntitle: wrong\nsurfaces:\n  quickadd-choice: Ghost\n  module: modules/missing.js\n---\n# `nope`\n" },
      { path: `${FBF}/feat/x.property.md`, text: "---\ndesc: y\n---\n" },
      { path: `${FBF}/feat/z.tag.md`, text: "---\ntitle: \"#z\"\n---\n" },
      // B subject: a plugin-stack table
      { path: "00-09 System/02 Obsidian/02.12 Plugin stack.md", text: "| Plugin | Status |\n| --- | --- |\n| Alpha | enabled |\n" },
      // F subject: uid-less notes
      { path: "Notes/n1.md", text: "---\ntitle: a\n---\n" },
      { path: "Notes/n2.md", text: "---\ntitle: b\n---\n" },
    ];
    const walkOrder = sources.map((s) => s.path);
    const findings = run(snap({ sources, walkOrder, dirs: [] }));
    assert.deepEqual(findings, [], `nothing the retired checks measured is a finding now: ${JSON.stringify(findings)}`);
    const letters = new Set(run(snap({ sources, walkOrder, dirs: ["00-09 System/00 A", "00-09 System/00 B"] })).map((f) => f.check));
    assert.deepEqual([...letters].sort(), ["J"]);
  });

  test("source pin: no push of a retired letter, and the pack reads no retired convention key", () => {
    for (const letter of ["A", "B", "D", "F", "G"]) assert.doesNotMatch(src, new RegExp(`push\\(\\s*"${letter}"`), `check ${letter} is retired`);
    for (const key of ["registriesRoot", "artifactsRoot", "pluginStackPath", "uidExemptPaths", "UID_EXEMPT", "PLUGSTACK", "BASE02", "quickadd", "registryFamily"]) {
      assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*\*[\s\S]*?\*\//g, ""), new RegExp(key), `${key} is gone from the code (comments aside)`);
    }
    assert.match(src, /const SYS_ROOT = conv\.systemRoot;/, "the one convention read");
    assert.match(src, /push\("E",[\s\S]{0,200}target: uid,/, "E is still keyed by uid");
  });

  test("the listings the retired checks required are no longer required: no `files`, no `obsidianConfig` — a snapshot without them runs clean through the engine", () => {
    const findings = runEngine([driftPack(SEED)], { notes: [], paths: [], sources: [], dirs: [], walkOrder: [] });
    assert.deepEqual(findings.filter((f) => f.check === "pack_error"), []);
  });

  test("and the listings E and J DO need are still refused when absent (absence is not emptiness, #142)", () => {
    for (const missing of ["dirs", "walkOrder"]) {
      const s = { notes: [], paths: [], sources: [], dirs: [], walkOrder: [] };
      delete s[missing];
      const errs = runEngine([driftPack(SEED)], s).filter((f) => f.check === "pack_error");
      assert.equal(errs.length, 1, `absent ${missing} refuses`);
      assert.match(errs[0].detail, new RegExp(missing));
    }
  });
});
