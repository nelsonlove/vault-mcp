/**
 * conformance-report-caps.test.mjs — the size cap every conformance report
 * obeys ("Replace the four Forge-only checks", section "Every report has a
 * size cap"; Nelson's verify of 2026-10-14). On 2026-10-01 Forge wrote 47.8
 * and 45.3 MB reports into the vault and Obsidian's renderer crashed. The
 * four caps, pinned here:
 *   1. a report note in the vault lists at most 200 findings, then "+N more",
 *      and stays under 256 KB (the debt register; the debt tool's items);
 *   2. the full finding set goes to a JSON file OUTSIDE the vault, under
 *      ~/.local/share/vault-audits/ (the CLI's --findings-json);
 *   3. an output that would pass 5 MB is replaced by its counts;
 *   4. every report states what it checked.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { publishInto } from "./host-shim.mjs";
import { findingKey } from "../src/kernel/finding.ts";
import { capRows, capList, coverageLine, overFullOutputCap, utf8Bytes, REPORT_MAX_FINDINGS, REPORT_NOTE_MAX_BYTES, FULL_OUTPUT_MAX_BYTES } from "../src/kernel/report-caps.ts";
import { auditsDir, fullFindingsPathRefusal } from "../src/kernel/audit-output.ts";
import { buildRegisterFromRun, renderDebtRegisterCapped } from "../src/kernel/debt-register.ts";
import { buildDebtTool, buildDebtRenderTool } from "../src/tools.ts";
import { runConformance, findingsJsonPathFrom, fullFindingsJson, writeFullFindings } from "../src/kernel/cli.ts";
import { EMPTY_VAULT_CONVENTIONS } from "../src/kernel/vault-conventions.ts";

const F = (i, extra = "") => ({ script: "port_lint", check: "c", target: `Notes/n${String(i).padStart(5, "0")}.md`, kind: extra, detail: "d" });
const fence = (keys) => "```ratchet-baseline\n" + keys.join("\n") + "\n```\n";
const NOW = new Date("2026-10-15T12:00:00Z");
const run = (live, baselineKeys, extra = {}) =>
  buildRegisterFromRun({ baselineKeys: new Set(baselineKeys), live, sidecar: { version: 1, entries: {} }, now: NOW, ...extra });

describe("the cap constants and helpers", () => {
  test("200 findings, 256 KB a note, 5 MB a run", () => {
    assert.equal(REPORT_MAX_FINDINGS, 200);
    assert.equal(REPORT_NOTE_MAX_BYTES, 256 * 1024);
    assert.equal(FULL_OUTPUT_MAX_BYTES, 5 * 1024 * 1024);
  });
  test("capRows clamps to 200; junk reads as the cap", () => {
    assert.equal(capRows(5), 5);
    assert.equal(capRows(1000), 200);
    assert.equal(capRows(undefined), 200);
    assert.equal(capRows(-1), 200);
    assert.equal(capRows(NaN), 200);
  });
  test("capList keeps the first N and counts the rest", () => {
    assert.deepEqual(capList([1, 2, 3], 2), { shown: [1, 2], more: 1 });
    assert.deepEqual(capList([1], 2), { shown: [1], more: 0 });
    assert.equal(capList(Array.from({ length: 250 }, (_, i) => i)).shown.length, 200);
  });
  test("bytes are UTF-8 bytes, not characters; the 5 MB test is strict", () => {
    assert.equal(utf8Bytes("é"), 2);
    assert.equal(overFullOutputCap("x".repeat(FULL_OUTPUT_MAX_BYTES)), false);
    assert.equal(overFullOutputCap("x".repeat(FULL_OUTPUT_MAX_BYTES + 1)), true);
  });
});

describe("cap 1: the debt register note", () => {
  test("500 carried items list 200 rows and one '+300 more' line; the default is 200, and a larger setting is clamped", () => {
    const live = Array.from({ length: 500 }, (_, i) => F(i));
    const keys = live.map(findingKey);
    for (const maxRows of [undefined, 1000]) {
      const r = run(live, keys, { maxRows });
      assert.equal(r.rows, 200);
      assert.equal((r.text.match(/^\| \[\[/gm) ?? []).length, 200);
      assert.match(r.text, /^\+300 more row\(s\) not shown/m);
    }
  });

  test("carried rows and cleared keys share one budget of 200", () => {
    const live = Array.from({ length: 150 }, (_, i) => F(i));
    const cleared = Array.from({ length: 120 }, (_, i) => findingKey(F(1000 + i)));
    const r = run(live, [...live.map(findingKey), ...cleared]);
    assert.equal(r.rows, 150);
    assert.equal(r.clearedListed, 50);
    assert.equal((r.text.match(/^- `port_lint\|/gm) ?? []).length, 50);
    assert.match(r.text, /^\+70 more cleared key\(s\) not shown/m);
  });

  test("a note that would pass 256 KB lists fewer rows until it fits, and says how many it left out", () => {
    const long = "k".repeat(4000);
    const live = Array.from({ length: 200 }, (_, i) => F(i, long));
    const r = run(live, live.map(findingKey));
    assert.ok(utf8Bytes(r.text) < REPORT_NOTE_MAX_BYTES, `${utf8Bytes(r.text)} bytes`);
    assert.ok(r.rows < 200 && r.rows > 0, `${r.rows} rows`);
    assert.match(r.text, new RegExp(`^\\+${200 - r.rows} more row\\(s\\) not shown`, "m"));
  });

  test("cap 4: the register states what the run checked", () => {
    const coverage = { notes: 12, measuredPacks: ["shape", "drift_audit"], unmeasuredPacks: ["conformance_check"], shape: { classes: 3, uncheckedClasses: 1, checkedNotes: 7, unboundNotes: 2 } };
    const r = run([], [], { coverage });
    assert.match(r.text, /^- checked: 12 note\(s\) read; 2 pack\(s\) measured \(shape, drift_audit\); NOT measured: conformance_check; shape: 3 class\(es\), 1 unchecked \(no fence\), 7 typed note\(s\) checked, 2 with a type that names no class$/m);
    assert.equal(coverageLine({ notes: 0, measuredPacks: [], unmeasuredPacks: [] }), "checked: 0 note(s) read; 0 pack(s) measured (none)");
  });

  test("the render tool reports the rows the note actually lists", async () => {
    const live = Array.from({ length: 300 }, (_, i) => F(i));
    const keys = live.map(findingKey);
    const writes = [];
    const source = {
      liveFindings: async () => live,
      baselineText: async () => fence(keys),
      sidecar: async () => ({ version: 1, entries: {} }),
      defaultRegisterDir: () => "B",
      baselineNotePath: () => "B/Conformance baseline.md",
      writeNote: async (p, t) => { writes.push({ p, t }); },
    };
    const { tools } = publishInto([buildDebtRenderTool(source, { config: () => ({ registerMaxRows: 5000 }), now: () => NOW })], { trusted: true });
    const res = await tools.get("vaultmcp_conformance_debt_render").handler({});
    assert.equal(res.structuredContent.rows, 200);
    assert.equal(res.structuredContent.truncated, true);
    assert.ok(utf8Bytes(writes[0].t) < REPORT_NOTE_MAX_BYTES);
  });
});

describe("cap 1 and cap 3: the debt tool's answer", () => {
  const live = Array.from({ length: 450 }, (_, i) => F(i));
  const keys = live.map(findingKey);
  const source = { liveFindings: async () => live, baselineText: async () => fence(keys), sidecar: async () => ({ version: 1, entries: {} }), coverage: () => ({ notes: 450, measuredPacks: ["port_lint"], unmeasuredPacks: [] }) };
  const tool = () => publishInto([buildDebtTool(source, { config: () => ({}), now: () => NOW })], { trusted: true }).tools.get("vaultmcp_conformance_debt");

  test("at most 200 items, the rest counted with a note that says how to narrow; counts and summary are whole", async () => {
    const sc = (await tool().handler({})).structuredContent;
    assert.equal(sc.items.length, 200);
    assert.equal(sc.truncated.items_more, 250);
    assert.match(sc.truncated.note, /\+250 more item\(s\)/);
    assert.equal(sc.filtered.carried, 450);
    assert.equal(sc.summary.carried, 450);
    assert.deepEqual(sc.checked, { notes: 450, measuredPacks: ["port_lint"], unmeasuredPacks: [] }, "cap 4");
  });

  test("an answer under the cap carries no truncation block", async () => {
    const sc = (await tool().handler({ folder: "Nowhere" })).structuredContent;
    assert.equal(sc.items.length, 0);
    assert.equal(sc.truncated, undefined);
  });
});

describe("cap 2: the full finding set, outside the vault", () => {
  test("auditsDir is $XDG_DATA_HOME/vault-audits, else ~/.local/share/vault-audits", () => {
    assert.equal(auditsDir({ XDG_DATA_HOME: "/x/data", HOME: "/h" }), "/x/data/vault-audits");
    assert.equal(auditsDir({ HOME: "/h" }), "/h/.local/share/vault-audits");
    assert.equal(auditsDir({ XDG_DATA_HOME: "relative", HOME: "/h" }), "/h/.local/share/vault-audits", "a relative XDG_DATA_HOME is ignored, as the spec says");
  });

  test("--findings-json alone writes under auditsDir with a stamped name; =<path> names the file; absent is none", () => {
    assert.equal(findingsJsonPathFrom([], { HOME: "/h" }, NOW), null);
    assert.equal(findingsJsonPathFrom(["--findings-json"], { HOME: "/h" }, NOW), "/h/.local/share/vault-audits/conformance-2026-10-15T12-00-00-000Z.json");
    assert.equal(findingsJsonPathFrom(["--findings-json=/tmp/x.json"], {}, NOW), "/tmp/x.json");
  });

  test("a path inside the vault is refused — directly, at the root, or through a symlinked folder", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "caps-"));
    try {
      const vault = path.join(tmp, "vault");
      await mkdir(path.join(vault, "Notes"), { recursive: true });
      await symlink(path.join(vault, "Notes"), path.join(tmp, "alias"));
      assert.match(fullFindingsPathRefusal(path.join(vault, "Notes", "x.json"), vault), /inside the vault/);
      assert.match(fullFindingsPathRefusal(vault, vault), /inside the vault/);
      assert.match(fullFindingsPathRefusal(path.join(tmp, "alias", "new", "x.json"), vault), /inside the vault/, "a symlink into the vault is the vault");
      assert.equal(fullFindingsPathRefusal(path.join(tmp, "out", "x.json"), vault), null);
      assert.equal(fullFindingsPathRefusal(path.join(tmp, "vault-sibling", "x.json"), vault), null, "a sibling whose name starts like the vault is outside it");
      if (process.platform === "darwin") {
        // APFS ignores case: the vault typed in other case is still the vault (#555 review 1).
        assert.match(fullFindingsPathRefusal(path.join(tmp, "VAULT", "Notes", "x.json"), vault), /inside the vault/);
        assert.match(fullFindingsPathRefusal(path.join(tmp, "Vault", "new", "x.json"), vault), /inside the vault/);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("writeFullFindings writes every finding with its key and status, plus the counts and the coverage; it refuses the vault", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "caps-"));
    try {
      const vault = path.join(tmp, "vault");
      await mkdir(path.join(vault, "Notes"), { recursive: true });
      for (let i = 0; i < 3; i++) await writeFile(path.join(vault, "Notes", `n${i}.md`), "# x\n");
      const res = await runConformance({ root: vault, baselineText: "", vocabularies: [], schemes: [], conventions: { ...EMPTY_VAULT_CONVENTIONS } });
      const out = path.join(tmp, "audits", "run.json");
      const line = await writeFullFindings(res, vault, out, NOW);
      assert.match(line, /^wrote the full finding set \(\d+ finding\(s\)\) to /);
      const json = JSON.parse(await readFile(out, "utf8"));
      assert.equal(json.findings.length, res.findings.length);
      assert.ok(json.findings.every((f) => f.key && (f.status === "new" || f.status === "carried")));
      assert.equal(json.summary.findings, res.findings.length);
      assert.equal(json.coverage.notes, 3);
      await assert.rejects(() => writeFullFindings(res, vault, path.join(vault, "x.json"), NOW), /inside the vault/);
      assert.ok(!fs.existsSync(path.join(vault, "x.json")));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("cap 3: a full set over 5 MB is not written; the count is reported instead", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "caps-"));
    try {
      const big = Array.from({ length: 6000 }, (_, i) => ({ ...F(i), detail: "x".repeat(1000) }));
      const res = { findings: big, ratchet: { carried: 0, newKeys: [], clearedKeys: [] }, coverage: { notes: 0, measuredPacks: [], unmeasuredPacks: [] } };
      assert.ok(overFullOutputCap(fullFindingsJson(res, "/v", NOW)));
      const out = path.join(tmp, "big.json");
      const line = await writeFullFindings(res, "/nonexistent-vault-root", out, NOW);
      assert.match(line, /^findings JSON NOT written: the full set \(6000 finding\(s\)\) would pass 5 MB/);
      assert.ok(!fs.existsSync(out));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("cap 3 and cap 4: the CLI report", () => {
  test("a NEW/CLEARED listing over 5 MB is replaced by its counts; the coverage line is always there", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "caps-"));
    try {
      await mkdir(path.join(tmp, "Notes"), { recursive: true });
      await writeFile(path.join(tmp, "Notes", "a.md"), "# a\n");
      // 40,000 accepted port_lint keys that this vault does not reproduce: all CLEARED, about 6 MB of listing.
      const cleared = Array.from({ length: 40000 }, (_, i) => `port_lint|c|Notes/${"p".repeat(120)}${i}.md|`);
      const res = await runConformance({ root: tmp, baselineText: fence(cleared), vocabularies: [], schemes: [], conventions: { ...EMPTY_VAULT_CONVENTIONS } });
      assert.equal(res.ratchet.clearedKeys.length, 40000);
      assert.match(res.report, /^OUTPUT CAP: the NEW and CLEARED key lists \(\d+ NEW, 40000 cleared\) would pass 5 MB, so they are not printed/m);
      assert.doesNotMatch(res.report, /^CLEARED \(rebaseline to drop\):/m);
      assert.ok(!overFullOutputCap(res.report));
      assert.match(res.report.split("\n")[1], /^checked: 1 note\(s\) read; /);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("a small listing is printed in full, as before", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "caps-"));
    try {
      await mkdir(path.join(tmp, "Notes"), { recursive: true });
      const res = await runConformance({ root: tmp, baselineText: fence(["port_lint|c|Notes/gone.md|"]), vocabularies: [], schemes: [], conventions: { ...EMPTY_VAULT_CONVENTIONS } });
      assert.match(res.report, /^CLEARED \(rebaseline to drop\):\n  - port_lint\|c\|Notes\/gone\.md\|$/m);
      assert.doesNotMatch(res.report, /OUTPUT CAP/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("cap 1: the Drift pane", () => {
  test("at most 200 findings in all, the groups taking the budget in order; each group counts what it left out", async () => {
    const { capDriftGroups } = await import("../src/kernel/drift-view.ts");
    const g = (check, n) => ({ check, findings: Array.from({ length: n }, (_, i) => ({ script: "scheme", check, target: `N/${i}.md`, kind: "", detail: "" })) });
    const out = capDriftGroups([g("misfiled", 150), g("unaddressed", 120), g("name_colon", 3)]);
    assert.deepEqual(out.map((x) => [x.check, x.total, x.shown.length, x.more]), [["misfiled", 150, 150, 0], ["unaddressed", 120, 50, 70], ["name_colon", 3, 0, 3]]);
    assert.deepEqual(capDriftGroups([g("a", 2)]).map((x) => x.more), [0]);
  });
  test("the pane renders the capped groups (pinned at the source: it is Obsidian-bound)", () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "drift-pane.ts"), "utf8");
    assert.match(src, /for \(const group of capDriftGroups\(this\.groups\)\)/);
    assert.match(src, /more not shown/);
  });
});
