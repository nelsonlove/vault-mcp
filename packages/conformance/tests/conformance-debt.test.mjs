/**
 * conformance-debt.test.mjs — the conformance debt register's DATA LAYER
 * (issue #211, Part A + teeth). What this proves:
 *
 *   1. sidecar round-trip: serialize → parse is stable, normalizing (unknown
 *      keys dropped, non-string values dropped, keys sorted); tolerant parse
 *      reads garbage as empty, strict parse throws on corrupt.
 *   2. REGRESSION GUARD: a baseline with NO sidecar behaves exactly as today —
 *      the debt report's carried/cleared/new equal the ratchet's own counts,
 *      and the baseline note bytes (parseBaseline/renderBaseline) are untouched.
 *   3. reconcileSidecar (the --rebaseline stamp): new keys stamped, persisting
 *      keys' human fields preserved, departed keys dropped.
 *   4. the read-only report tool: correct carried/cleared/new + filter + group
 *      + stale + budget-warn, and NO agent-writable path mints acceptedBy.
 *   5. the CLI end-to-end: --rebaseline writes the sidecar (stamping new keys,
 *      preserving hand-edited reason across a re-run) and appends a trend line;
 *      the budget tooth warns (and only fails under --strict-budget).
 *
 * Headless: the report core (kernel/debt.ts, debt-sidecar.ts) is pure; the
 * tool (tools.ts) is Obsidian-free over an injected DebtSource, and is driven
 * through tests/host-shim.mjs so the assertions are about the host's envelopes.
 * The live adapter (obsidian-debt-source.ts) is the one un-headless seam.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishInto } from "./host-shim.mjs";
import { findingKey } from "../src/kernel/finding.ts";
import { parseBaseline, renderBaseline, ratchet } from "../src/kernel/ratchet.ts";
import {
  parseSidecar,
  parseSidecarStrict,
  serializeSidecar,
  reconcileSidecar,
  emptySidecar,
  sidecarPathFor,
} from "../src/kernel/debt-sidecar.ts";
import {
  buildDebtReport,
  filterDebtItems,
  groupDebtItems,
  budgetStatus,
  ageDaysOf,
} from "../src/kernel/debt.ts";
import { trendPathFor } from "../src/kernel/debt-trend.ts";
import { buildDebtTool, conformanceDebtConfigOf, DEFAULT_STALE_AFTER_DAYS } from "../src/tools.ts";
import { runConformance, runCli } from "../src/kernel/cli.ts";
import { LEGACY_CONVENTIONS_SEED as SEED } from "../src/kernel/vault-conventions.ts";

// A finding factory; `detail` is not part of the key.
const F = (script, check, target, kind = "") => ({ script, check, target, kind, detail: `${check} on ${target}` });

// ── 1. sidecar round-trip ─────────────────────────────────────────────────────

describe("debt sidecar: round-trip + normalization", () => {
  test("serialize → parse is stable; unknown/non-string fields dropped; keys sorted", () => {
    const key1 = findingKey(F("drift_audit", "dup_uid", "Zed/Note.md"));
    const key2 = findingKey(F("vocab_findings", "unregistered_tag", "Notes/A.md", "rogue"));
    const sidecar = {
      version: 1,
      entries: {
        [key1]: { acceptedOn: "2026-01-01", acceptedBy: "human", reason: "known", junk: "drop me", priority: 7 },
        [key2]: { acceptedOn: "2026-02-02", acceptedBy: "nelson", fixBy: "2026-09-01" },
      },
    };
    const text = serializeSidecar(sidecar);
    const parsed = parseSidecar(text);
    // unknown `junk` and non-string `priority: 7` are dropped
    assert.deepEqual(parsed.entries[key1], { acceptedOn: "2026-01-01", acceptedBy: "human", reason: "known" });
    assert.deepEqual(parsed.entries[key2], { acceptedOn: "2026-02-02", acceptedBy: "nelson", fixBy: "2026-09-01" });
    // keys are sorted in the serialized output → deterministic bytes
    const order = Object.keys(JSON.parse(text).entries);
    assert.deepEqual(order, [...order].sort());
    // re-serialize is byte-identical (idempotent)
    assert.equal(serializeSidecar(parsed), text);
    // trailing newline
    assert.ok(text.endsWith("\n"));
  });

  test("tolerant parse reads absent/blank/garbage as empty; strict throws on corrupt", () => {
    assert.deepEqual(parseSidecar(null), emptySidecar());
    assert.deepEqual(parseSidecar(""), emptySidecar());
    assert.deepEqual(parseSidecar("   "), emptySidecar());
    assert.deepEqual(parseSidecar("{not json"), emptySidecar());
    assert.deepEqual(parseSidecar("[1,2,3]"), emptySidecar());
    // strict: blank/absent is still a valid empty sidecar (absence != corruption)
    assert.deepEqual(parseSidecarStrict(null), emptySidecar());
    assert.deepEqual(parseSidecarStrict(""), emptySidecar());
    // strict: present-but-corrupt throws
    assert.throws(() => parseSidecarStrict("{not json"));
    assert.throws(() => parseSidecarStrict("[1,2,3]"));
    assert.throws(() => parseSidecarStrict('{"entries": [1,2]}'));
  });
});

// ── 2. regression guard: no sidecar behaves exactly as today ──────────────────

describe("debt report: a baseline with NO sidecar behaves identically to today", () => {
  const findings = [
    F("drift_audit", "dup_uid", "Zed/Note.md"),
    F("vocab_findings", "unregistered_tag", "Notes/A.md", "rogue"),
    F("scheme", "misfiled", "Notes/B.md"),
  ];
  // A baseline that accepts two of the three live keys, plus one key that is no
  // longer live (→ cleared).
  const acceptedLive = [findingKey(findings[0]), findingKey(findings[1])];
  const departed = findingKey(F("drift_audit", "dup_uid", "Old/Gone.md"));
  const baselineBody = [...acceptedLive, departed].sort().join("\n");
  const baselineText = "```ratchet-baseline\n" + baselineBody + "\n```\n";

  test("carried/cleared/new equal the ratchet's own counts, with an empty sidecar", () => {
    const baselineKeys = parseBaseline(baselineText);
    const r = ratchet(findings, baselineKeys);
    const report = buildDebtReport({ baselineKeys, live: findings, sidecar: emptySidecar(), now: new Date() });
    assert.equal(report.summary.carried, r.carried); // 2 carried
    assert.equal(report.summary.cleared, r.clearedKeys.length); // 1 cleared
    assert.equal(report.summary.new, r.newKeys.length); // 1 NEW (the scheme finding)
  });

  test("no sidecar → items carry no metadata, no ageDays, no stale field", () => {
    const baselineKeys = parseBaseline(baselineText);
    const report = buildDebtReport({ baselineKeys, live: findings, sidecar: emptySidecar(), now: new Date() });
    for (const it of report.items) {
      assert.equal(it.acceptedOn, undefined);
      assert.equal(it.acceptedBy, undefined);
      assert.equal(it.reason, undefined);
      assert.equal(it.ageDays, undefined);
    }
    // staleness off by default → no stale flags, empty stale list
    assert.deepEqual(report.stale, []);
    assert.equal(report.staleAfterDays, null);
  });

  test("the baseline note bytes are untouched by the debt layer", () => {
    // The debt layer only READS the baseline via parseBaseline; renderBaseline
    // still emits the same sorted key body it always did.
    const rebody = renderBaseline(findings);
    assert.equal(rebody, [findingKey(findings[0]), findingKey(findings[1]), findingKey(findings[2])].sort().join("\n"));
  });
});

// ── 3. reconcileSidecar: the --rebaseline stamp ───────────────────────────────

describe("reconcileSidecar (human-run --rebaseline stamp)", () => {
  const keyA = findingKey(F("drift_audit", "dup_uid", "A.md"));
  const keyB = findingKey(F("scheme", "misfiled", "B.md"));
  const keyC = findingKey(F("vocab_findings", "unregistered_tag", "C.md", "x"));

  test("new keys stamped; persisting keys keep human fields; departed keys dropped", () => {
    const prev = {
      version: 1,
      entries: {
        [keyA]: { acceptedOn: "2026-01-01", acceptedBy: "nelson", reason: "wontfix", priority: "low", fixBy: "2026-12-01" },
        [keyB]: { acceptedOn: "2026-01-01", acceptedBy: "nelson" }, // B will depart
      },
    };
    // New baseline keeps A, drops B, adds C.
    const next = reconcileSidecar(prev, [keyA, keyC], { acceptedOn: "2026-08-17", acceptedBy: "tester" });
    // A persists verbatim (acceptedOn NOT re-stamped; human fields preserved)
    assert.deepEqual(next.entries[keyA], prev.entries[keyA]);
    // C newly entered → stamped with the passed-in date + identity
    assert.deepEqual(next.entries[keyC], { acceptedOn: "2026-08-17", acceptedBy: "tester" });
    // B departed → dropped
    assert.equal(next.entries[keyB], undefined);
    assert.deepEqual(Object.keys(next.entries).sort(), [keyA, keyC].sort());
  });

  test("a persisting key that never had an entry is stamped as newly accepted", () => {
    const next = reconcileSidecar(emptySidecar(), [keyA], { acceptedOn: "2026-08-17", acceptedBy: "human" });
    assert.deepEqual(next.entries[keyA], { acceptedOn: "2026-08-17", acceptedBy: "human" });
  });
});

// ── 4. teeth: ageDays / staleness / budget / filter / group ───────────────────

describe("debt report teeth", () => {
  const findings = [
    F("drift_audit", "dup_uid", "Projects/Old.md"),
    F("drift_audit", "dup_uid", "Projects/Newer.md"),
    F("vocab_findings", "unregistered_tag", "Notes/A.md", "rogue"),
  ];
  const keys = findings.map(findingKey);
  const baselineKeys = new Set(keys);
  const now = new Date("2026-08-17T12:00:00Z");
  const sidecar = {
    version: 1,
    entries: {
      [keys[0]]: { acceptedOn: "2026-01-01", acceptedBy: "human", reason: "legacy", priority: "high" }, // ~228d old
      [keys[1]]: { acceptedOn: "2026-08-10", acceptedBy: "human" }, // 7d old
      // keys[2] has no entry
    },
  };

  test("ageDaysOf computes whole UTC days; future/absent handled", () => {
    assert.equal(ageDaysOf("2026-08-10", now), 7);
    assert.equal(ageDaysOf("2026-08-17", now), 0);
    assert.equal(ageDaysOf("2026-09-01", now), 0); // future → floored to 0
    assert.equal(ageDaysOf(undefined, now), undefined);
    assert.equal(ageDaysOf("not-a-date", now), undefined);
  });

  test("staleness flags items over the threshold; off when disabled", () => {
    const report = buildDebtReport({ baselineKeys, live: findings, sidecar, now, staleAfterDays: 90 });
    const old = report.items.find((i) => i.key === keys[0]);
    const newer = report.items.find((i) => i.key === keys[1]);
    assert.equal(old.ageDays, ageDaysOf("2026-01-01", now));
    assert.equal(old.stale, true);
    assert.equal(newer.stale, false);
    assert.deepEqual(report.stale.map((i) => i.key), [keys[0]]);
    assert.equal(report.staleAfterDays, 90);

    // disabled (0 / undefined) → no stale flags at all
    const off = buildDebtReport({ baselineKeys, live: findings, sidecar, now, staleAfterDays: 0 });
    assert.deepEqual(off.stale, []);
    assert.equal(off.items[0].stale, undefined);
    assert.equal(off.staleAfterDays, null);
  });

  test("budget warns over the ceiling; strict flag surfaced; null = off", () => {
    const over = buildDebtReport({ baselineKeys, live: findings, sidecar, now, debtBudget: 2 });
    assert.equal(over.budget.over, true);
    assert.equal(over.budget.carried, 3);
    assert.equal(over.budget.strict, false);
    assert.match(over.budget.warning, /budget exceeded/);
    const strict = buildDebtReport({ baselineKeys, live: findings, sidecar, now, debtBudget: 2, strictBudget: true });
    assert.match(strict.budget.warning, /strict/);
    const off = buildDebtReport({ baselineKeys, live: findings, sidecar, now });
    assert.equal(off.budget.over, false);
    assert.equal(off.budget.budget, null);
    assert.equal(off.budget.warning, null);
    // budgetStatus unit
    assert.equal(budgetStatus(5, null, false).over, false);
    assert.equal(budgetStatus(5, 4, false).over, true);
    assert.equal(budgetStatus(4, 4, false).over, false);
  });

  test("filter by folder/pack/check/kind; group counts", () => {
    const report = buildDebtReport({ baselineKeys, live: findings, sidecar, now });
    assert.equal(filterDebtItems(report.items, { folder: "Projects" }).length, 2);
    assert.equal(filterDebtItems(report.items, { folder: "Notes" }).length, 1);
    assert.equal(filterDebtItems(report.items, { pack: "drift_audit" }).length, 2);
    assert.equal(filterDebtItems(report.items, { check: "unregistered_tag" }).length, 1);
    assert.equal(filterDebtItems(report.items, { kind: "rogue" }).length, 1);
    const byPack = groupDebtItems(report.items, "pack");
    assert.deepEqual(byPack, [
      { group: "drift_audit", count: 2 },
      { group: "vocab_findings", count: 1 },
    ]);
    const byFolder = groupDebtItems(report.items, "folder");
    assert.deepEqual(byFolder.find((g) => g.group === "Projects"), { group: "Projects", count: 2 });
  });
});

// ── 5. the read-only report tool ──────────────────────────────────────────────

describe("vaultmcp_conformance_debt tool", () => {
  const findings = [
    F("drift_audit", "dup_uid", "Projects/A.md"),
    F("scheme", "misfiled", "Notes/B.md"),
  ];
  const keys = findings.map(findingKey);
  const departed = findingKey(F("drift_audit", "dup_uid", "Gone.md"));
  const baselineText = "```ratchet-baseline\n" + [keys[0], departed].sort().join("\n") + "\n```\n";
  const sidecar = Object.freeze({
    version: 1,
    entries: { [keys[0]]: { acceptedOn: "2026-01-01", acceptedBy: "human", reason: "legacy" } },
  });

  // Published through the host shim; `trusted: true` so the host believes the
  // read-only claim (the untrusted default is pinned in conformance-satellite).
  function register(config, now) {
    const source = {
      liveFindings: async () => findings,
      baselineText: async () => baselineText,
      sidecar: async () => sidecar,
    };
    const { tools } = publishInto([buildDebtTool(source, { config: () => config, now: () => now })], { trusted: true });
    return tools.get("vaultmcp_conformance_debt");
  }

  test("registers read-only; correct carried/cleared/new + metadata", async () => {
    const tool = register({}, new Date("2026-08-17T00:00:00Z"));
    assert.equal(tool.def.annotations.readOnlyHint, true);
    const res = await tool.handler({});
    const sc = res.structuredContent;
    assert.equal(sc.summary.carried, 1); // keys[0] carried
    assert.equal(sc.summary.cleared, 1); // departed cleared
    assert.equal(sc.summary.new, 1); // keys[1] is live but not accepted
    const item = sc.items.find((i) => i.key === keys[0]);
    assert.equal(item.acceptedBy, "human");
    assert.equal(item.reason, "legacy");
    assert.equal(item.target, "Projects/A.md");
  });

  test("filter + group_by narrow the returned items but not the summary", async () => {
    const tool = register({}, new Date("2026-08-17T00:00:00Z"));
    const res = await tool.handler({ folder: "Nowhere" });
    assert.equal(res.structuredContent.items.length, 0);
    assert.equal(res.structuredContent.filtered.carried, 0);
    // summary is still the whole-vault burn-down
    assert.equal(res.structuredContent.summary.carried, 1);
    const grouped = await tool.handler({ group_by: "pack" });
    assert.deepEqual(grouped.structuredContent.groups, [{ group: "drift_audit", count: 1 }]);
  });

  test("budget config drives the reported budget", async () => {
    const tool = register({ debtBudget: 0 }, new Date("2026-08-17T00:00:00Z"));
    const res = await tool.handler({});
    assert.equal(res.structuredContent.budget.over, true);
    assert.match(res.structuredContent.budget.warning, /budget exceeded/);
  });

  test("NO agent-writable path: read-only, and the tool never mutates the sidecar", async () => {
    const tool = register({}, new Date("2026-08-17T00:00:00Z"));
    // The input schema has no acceptedBy/acceptedOn/accept field — an attempt to
    // pass one is simply ignored (the handler reads only its declared filters); the returned
    // acceptedBy is ONLY ever what the sidecar held, never an argument.
    const res = await tool.handler({ acceptedBy: "attacker", accept: true });
    const item = res.structuredContent.items.find((i) => i.key === keys[0]);
    assert.equal(item.acceptedBy, "human"); // unchanged — came from the sidecar, not the arg
    // The frozen sidecar object proves the read path never wrote to it.
    assert.equal(Object.isFrozen(sidecar), true);
    assert.equal(sidecar.entries[keys[0]].acceptedBy, "human");
    // No write verb exists on the tool's inputSchema.
    assert.equal(tool.def.inputSchema.acceptedBy, undefined);
    assert.equal(tool.def.inputSchema.accept, undefined);
  });

  test("conformanceDebtConfigOf defaults + coercion", () => {
    assert.deepEqual(conformanceDebtConfigOf(undefined), { staleAfterDays: DEFAULT_STALE_AFTER_DAYS, debtBudget: null, strictBudget: false });
    assert.deepEqual(conformanceDebtConfigOf({ staleAfterDays: 30, debtBudget: 10, strictBudget: true }), { staleAfterDays: 30, debtBudget: 10, strictBudget: true });
    // bad values fall back
    assert.deepEqual(conformanceDebtConfigOf({ staleAfterDays: "x", debtBudget: -1 }), { staleAfterDays: DEFAULT_STALE_AFTER_DAYS, debtBudget: null, strictBudget: false });
  });
});

// ── 6. CLI end-to-end: rebaseline writes the sidecar + trend; budget tooth ─────

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "conf-debt-"));
  await mkdir(path.join(root, "Notes"), { recursive: true });
  // an unregistered tag → a vocab finding (a SEEDED registry that doesn't
  // declare it ⇒ `rogue` unregistered; unseeded would force no findings, #251)
  await writeFile(path.join(root, "Notes", "A.md"), "---\ntitle: A\ntags:\n  - rogue\n---\nbody\n");
  await mkdir(path.join(root, "Registry"), { recursive: true });
  await writeFile(path.join(root, "Registry", "keep.md"), "---\nfileClass: Meta/Tag\ntag: keep\n---\n");
  return root;
}

describe("runConformance: budget tooth in the report + exit code", () => {
  test("over budget → WARNING in report; warn-only exit 0, strict exit 1", async () => {
    const root = await vault();
    try {
      const vocab = [{ id: "reg", provider: "blueprint", root: "Reg" }]; // empty registry ⇒ 'rogue' unregistered
      const first = await runConformance({ root, conventions: SEED, baselineText: "", vocabularies: vocab, schemes: [], legacyPacks: false });
      const baselineText = "```ratchet-baseline\n" + first.rebaseline + "\n```\n";
      const carried = first.findings.length;
      assert.ok(carried > 0);
      // budget below carried → over
      const warn = await runConformance({ root, conventions: SEED, baselineText, vocabularies: vocab, schemes: [], legacyPacks: false, debtBudget: carried - 1 });
      assert.equal(warn.budget.over, true);
      assert.match(warn.report, /WARNING: debt budget exceeded/);
      assert.equal(warn.exitCode, 0); // warn-only: no NEW, not strict
      const strict = await runConformance({ root, conventions: SEED, baselineText, vocabularies: vocab, schemes: [], legacyPacks: false, debtBudget: carried - 1, strictBudget: true });
      assert.equal(strict.exitCode, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runCli --rebaseline: writes sidecar + appends trend", () => {
  // Guard the env keys runCli consults so the test is hermetic.
  // Includes the register-render vars (#211 Part B): every --rebaseline now
  // probes ASSENT_REGISTER_DIR for an existing register to refresh, so an
  // ambient value would point these fixture runs at a real directory.
  const ENV_KEYS = ["ASSENT_CONTENT_ROOT", "ASSENT_BASELINE_REL", "GOVERNOR_BASELINE_REL", "ASSENT_EXCLUDED_ROOTS", "ASSENT_ACCEPTED_BY", "ASSENT_DEBT_BUDGET", "ASSENT_REGISTER_DIR", "ASSENT_STALE_AFTER_DAYS"];
  function withCleanEnv(fn) {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    // #493: --rebaseline refuses when no live record is configured, so name one —
    // a path these fixtures never use, so each fixture baseline is NOT the live record.
    process.env.GOVERNOR_BASELINE_REL = "Live/Conformance baseline.md";
    return Promise.resolve()
      .then(fn)
      .finally(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  }

  test("stamps new keys, appends a trend line, and preserves a hand-edited reason across re-run", async () => {
    const root = await vault();
    const baselinePath = path.join(root, "baseline.md"); // a FIXTURE, not the live path
    await writeFile(baselinePath, "# Conformance baseline\n");
    try {
      await withCleanEnv(async () => {
        // First rebaseline: seeds all live keys into the fixture, stamps the sidecar.
        await runCli([`--root=${root}`, `--baseline=${baselinePath}`, "--no-legacy-packs", "--rebaseline", "--accepted-by=tester"]);

        const sidecarPath = sidecarPathFor(baselinePath);
        assert.ok(existsSync(sidecarPath), "sidecar written next to baseline");
        const sc1 = parseSidecar(await readFile(sidecarPath, "utf8"));
        const keys = Object.keys(sc1.entries);
        assert.ok(keys.length > 0, "at least one accepted key");
        const today = new Date().toISOString().slice(0, 10);
        for (const k of keys) {
          assert.equal(sc1.entries[k].acceptedBy, "tester");
          assert.equal(sc1.entries[k].acceptedOn, today);
        }

        // Trend line appended.
        const trendPath = trendPathFor(baselinePath);
        assert.ok(existsSync(trendPath), "trend log written");
        const lines1 = (await readFile(trendPath, "utf8")).trim().split("\n").filter(Boolean);
        assert.equal(lines1.length, 1);
        const rec = JSON.parse(lines1[0]);
        assert.ok(typeof rec.ts === "string" && "carried" in rec && "cleared" in rec && "new" in rec);

        // Human edits a reason in the sidecar, then re-rebaseline.
        const firstKey = keys[0];
        sc1.entries[firstKey].reason = "hand-written note";
        await writeFile(sidecarPath, serializeSidecar(sc1));
        await runCli([`--root=${root}`, `--baseline=${baselinePath}`, "--no-legacy-packs", "--rebaseline", "--accepted-by=someone-else"]);

        const sc2 = parseSidecar(await readFile(sidecarPath, "utf8"));
        // reason preserved; acceptedOn/By preserved (persisting key, NOT re-stamped)
        assert.equal(sc2.entries[firstKey].reason, "hand-written note");
        assert.equal(sc2.entries[firstKey].acceptedBy, "tester");
        assert.equal(sc2.entries[firstKey].acceptedOn, today);
        // trend now has 2 records
        const lines2 = (await readFile(trendPath, "utf8")).trim().split("\n").filter(Boolean);
        assert.equal(lines2.length, 2);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a corrupt existing sidecar ABORTS the rebaseline before the baseline is rewritten", async () => {
    const root = await vault();
    const baselinePath = path.join(root, "baseline.md");
    await writeFile(baselinePath, "# Conformance baseline\n");
    const before = await readFile(baselinePath, "utf8");
    // Plant a corrupt sidecar next to the baseline.
    await writeFile(sidecarPathFor(baselinePath), "{ not valid json");
    try {
      await withCleanEnv(async () => {
        await assert.rejects(
          runCli([`--root=${root}`, `--baseline=${baselinePath}`, "--no-legacy-packs", "--rebaseline"]),
        );
        // The baseline note must be untouched — the strict parse runs first.
        assert.equal(await readFile(baselinePath, "utf8"), before);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
