/**
 * conformance-packs.test.mjs — the RulePack interface, the two module-pack
 * adapters (vocab + scheme), and the engine that runs packs over a snapshot.
 *
 * The adapters map each module's typed finding onto the canonical 4-tuple
 * Finding. THIS MAPPING IS THE FROZEN CONTRACT worker-3's schemeFindings port
 * targets:
 *   vocab  → { script: "vocab_findings",  check: code, target: notePath, kind: token(lower) }
 *   scheme → { script: "scheme_findings", check: code, target: notePath, kind: "" }
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { vocabPack, schemePack } from "../src/kernel/packs/index.ts";
import { runEngine } from "../src/kernel/engine.ts";
import { blueprintProvider } from "@vault-mcp/core";
import { makeRegistry } from "@vault-mcp/core";

// ── vocab pack ────────────────────────────────────────────────────────────────

const REG = "Reg";
const vocabProviders = () => [
  blueprintProvider({ root: REG }, [
    { path: `${REG}/meta.tag/meta.tag.md` },
    { path: `${REG}/title.property.md` },
    { path: `${REG}/tags.property.md` },
  ]),
];

function snapshot(notes) {
  return { notes, paths: notes.map((n) => n.path) };
}

describe("vocabPack", () => {
  test("maps a VocabFinding to the vocab_findings 4-tuple (target=path, kind=token, case preserved)", () => {
    const pack = vocabPack(vocabProviders());
    const snap = snapshot([{ path: "Notes/N.md", frontmatter: { title: "N", tags: ["Rogue"] } }]);
    const findings = pack.run(snap);
    const tag = findings.find((f) => f.check === "unregistered_tag");
    assert.ok(tag, "expected an unregistered_tag finding");
    assert.equal(tag.script, "vocab_findings");
    assert.equal(tag.target, "Notes/N.md");
    assert.equal(tag.kind, "Rogue"); // case preserved — distinct-case tokens stay distinct keys
    assert.ok(tag.detail.length > 0);
  });

  test("distinct-case tokens produce distinct keys (a ratchet must not mask a regression)", () => {
    const pack = vocabPack(vocabProviders());
    const snap = snapshot([{ path: "Notes/N.md", frontmatter: { title: "N", tags: ["Rogue", "rogue"] } }]);
    const kinds = pack.run(snap).filter((f) => f.check === "unregistered_tag").map((f) => f.kind);
    assert.deepEqual(kinds.sort(), ["Rogue", "rogue"]);
  });

  test("a fully registered note yields no vocab findings", () => {
    const pack = vocabPack(vocabProviders());
    const snap = snapshot([{ path: "Notes/N.md", frontmatter: { title: "N", tags: ["meta/anything"] } }]);
    // title/tags are registered properties; meta/anything is namespace-permissive under meta
    assert.deepEqual(pack.run(snap).filter((f) => f.check === "unregistered_tag"), []);
  });
});

// ── scheme pack ───────────────────────────────────────────────────────────────

describe("schemePack", () => {
  const instances = () => makeRegistry([{ id: "jd", provider: "johnny-decimal" }]).instances();

  test("maps a SchemeFinding to the scheme_findings 4-tuple (target=path, kind='')", () => {
    const pack = schemePack(instances());
    // a filename whose leading token looks like a JD id but does not parse → malformed_name
    const snap = snapshot([{ path: "00-09 System/06 Foo/06.99.99 Bad.md" }]);
    const findings = pack.run(snap);
    const f = findings.find((x) => x.check === "malformed_name");
    assert.ok(f, "expected a malformed_name finding");
    assert.equal(f.script, "scheme_findings");
    assert.equal(f.target, "00-09 System/06 Foo/06.99.99 Bad.md");
    assert.equal(f.kind, "");
  });
});

// ── engine ────────────────────────────────────────────────────────────────────

describe("runEngine", () => {
  test("runs every pack over the snapshot and concatenates, sorted by key", () => {
    const packs = [vocabPack(vocabProviders()), schemePack([])];
    const snap = snapshot([
      { path: "Notes/B.md", frontmatter: { title: "B", tags: ["zzz"] } },
      { path: "Notes/A.md", frontmatter: { title: "A", tags: ["yyy"] } },
    ]);
    const findings = runEngine(packs, snap);
    const keys = findings.map((f) => `${f.script}|${f.check}|${f.target}|${f.kind}`);
    assert.deepEqual([...keys].sort(), keys, "engine output is sorted by key");
    assert.ok(keys.some((k) => k.includes("Notes/A.md")));
    assert.ok(keys.some((k) => k.includes("Notes/B.md")));
  });

  test("a pack that throws does not abort the engine — its failure is surfaced, others still run", () => {
    const boom = { id: "boom", run() { throw new Error("pack blew up"); } };
    const snap = snapshot([{ path: "Notes/N.md", frontmatter: { title: "N", tags: ["rogue"] } }]);
    const findings = runEngine([boom, vocabPack(vocabProviders())], snap);
    // vocab still produced its finding
    assert.ok(findings.some((f) => f.script === "vocab_findings"));
    // the crash surfaced as an engine_error finding (so a broken pack is visible, not silent)
    assert.ok(findings.some((f) => f.script === "conformance_engine" && f.check === "pack_error" && f.target === "boom"));
  });
});
