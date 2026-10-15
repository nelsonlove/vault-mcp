/**
 * conformance-debt-register.test.mjs — the conformance debt register's
 * HUMAN-FACING RENDER (issue #211, Part B). What this proves:
 *
 *   1. the pure register builder: frontmatter is a `generated`/`generator`
 *      derivation stamp and NEVER an acceptance-family key (the accept-guard
 *      passes the rendered text and refuses a forged one); summary lines carry
 *      carried/cleared/new + stale + budget; the carried-debt table renders one
 *      row per item with the sidecar metadata.
 *   2. link safety: a plain note path renders as a wikilink; a pipe-in-path
 *      note (the real #136/#209 class) falls back to a percent-encoded
 *      markdown link so neither the wikilink nor the table breaks; non-path
 *      targets render as code spans; cell text escapes pipes/newlines.
 *   3. ordering: stale first, then priority (high → low), then age descending.
 *   4. cap: rows beyond maxRows collapse to a "+N more" line.
 *   5. the cleared section lists the prune-these keys (escaped), "(none)" when
 *      empty.
 *   6. the MUTATING render tool (published through tests/host-shim.mjs):
 *      registers readOnlyHint:false, writes the note
 *      at the configured/default register path, REFUSES under an active path
 *      allowlist that does not cover the register path (Error
 *      [out_of_allowlist], over the per-call CallContext) and writes nothing,
 *      and never touches the baseline or the sidecar.
 *   7. the CLI: --render-register writes the register beside the baseline;
 *      --rebaseline refreshes an EXISTING register but never creates one
 *      unasked; a register path colliding with the baseline itself refuses.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishInto, callContextFor } from "./host-shim.mjs";
import { AcceptForbiddenError, acceptForbiddenReason, parseGuardFrontmatter, isVisible } from "@vault-mcp/core";
import { findingKey } from "../src/kernel/finding.ts";
import { parseBaseline } from "../src/kernel/ratchet.ts";
import { emptySidecar } from "../src/kernel/debt-sidecar.ts";
import { buildDebtReport } from "../src/kernel/debt.ts";
import {
  REGISTER_BASENAME,
  REGISTER_GENERATOR,
  registerNotePathFor,
  noteLink,
  cell,
  orderDebtItems,
  renderDebtRegister,
  buildRegisterFromRun,
  registerAcceptRefusal,
} from "../src/kernel/debt-register.ts";
import {
  buildDebtRenderTool,
  debtRenderConfigOf,
} from "../src/tools.ts";
import { runCli } from "../src/kernel/cli.ts";

const F = (script, check, target, kind = "") => ({ script, check, target, kind, detail: `${check} on ${target}` });
const NOW = new Date("2026-08-17T12:00:00Z");

// A standard three-finding fixture: one fully-annotated stale item, one fresh
// item, one pipe-in-path item; plus one departed (cleared) baseline key.
function fixture() {
  const findings = [
    F("drift_audit", "dup_uid", "Projects/Old.md"),
    F("scheme", "misfiled", "Notes/Fresh.md"),
    F("port_lint", "DROPPED", "Notes/--dangerously-skip-reading-code | olano.dev.md", "x|y"),
  ];
  const keys = findings.map(findingKey);
  const departed = findingKey(F("drift_audit", "dup_uid", "Gone/Away.md"));
  const baselineKeys = new Set([...keys, departed]);
  const sidecar = {
    version: 1,
    entries: {
      [keys[0]]: { acceptedOn: "2026-01-01", acceptedBy: "nelson", reason: "legacy | keep", priority: "high", fixBy: "2026-12-01" },
      [keys[1]]: { acceptedOn: "2026-08-10", acceptedBy: "human" },
    },
  };
  return { findings, keys, departed, baselineKeys, sidecar };
}

function renderFixture(extra = {}) {
  const { findings, baselineKeys, sidecar } = fixture();
  return buildRegisterFromRun({
    baselineKeys,
    live: findings,
    sidecar,
    now: NOW,
    staleAfterDays: 90,
    debtBudget: 2,
    ...extra,
  });
}

// ── 1. frontmatter: derivation stamp only, accept-guard clean ────────────────

describe("register frontmatter: generated/generator, never acceptance", () => {
  test("carries exactly the derivation stamp; the accept-guard passes it", () => {
    const { text } = renderFixture();
    const fm = parseGuardFrontmatter(text);
    assert.deepEqual(Object.keys(fm).sort(), ["generated", "generator"]);
    assert.equal(fm.generator, REGISTER_GENERATOR);
    assert.equal(fm.generated, NOW.toISOString());
    // no acceptance-family key anywhere in the frontmatter
    assert.equal(acceptForbiddenReason(fm), null);
    // the guard the tool runs before writing does not refuse
    assert.doesNotThrow(() => registerAcceptRefusal(text));
    // ...even though the sidecar's acceptedBy/acceptedOn appear in the BODY
    // table (report content, not frontmatter).
    assert.match(text, /nelson/);
  });

  test("a forged register carrying an acceptance field is refused", () => {
    const forged = "---\ngenerated: 2026-08-17\naccepted-by: nelson\n---\n\n# Conformance debt\n";
    assert.throws(() => registerAcceptRefusal(forged), AcceptForbiddenError);
    const forged2 = "---\ngenerated: 2026-08-17\nacceptance-status: accepted\n---\nbody\n";
    assert.throws(() => registerAcceptRefusal(forged2), AcceptForbiddenError);
  });
});

// ── summary + table content ──────────────────────────────────────────────────

describe("register summary and table", () => {
  test("summary lines: carried/cleared/new, stale count, budget status", () => {
    const { text, report, clearedKeys } = renderFixture();
    assert.equal(report.summary.carried, 3);
    assert.equal(clearedKeys.length, 1);
    assert.match(text, /- Carried: 3/);
    assert.match(text, /- Cleared: 1 \(fixed or moved/);
    assert.match(text, /- New: 0/);
    assert.match(text, /- Stale \(≥ 90 days\): 1/);
    assert.match(text, /- Budget: OVER — 3 carried > 2 budget/);
  });

  test("within-budget and no-budget lines", () => {
    const within = renderFixture({ debtBudget: 10 }).text;
    assert.match(within, /- Budget: 3 \/ 10 \(within budget\)/);
    const none = renderFixture({ debtBudget: null }).text;
    assert.match(none, /- Budget: no budget configured/);
    const staleOff = renderFixture({ staleAfterDays: 0 }).text;
    assert.match(staleOff, /- staleness check off/);
  });

  test("a row carries the sidecar metadata and links the note", () => {
    const { text } = renderFixture();
    const rowLine = text.split("\n").find((l) => l.includes("[[Projects/Old]]"));
    assert.ok(rowLine, "wikilinked row present");
    for (const field of ["drift_audit", "dup_uid", "2026-01-01", "nelson", "yes", "high", "2026-12-01"]) {
      assert.ok(rowLine.includes(field), `row carries ${field}`);
    }
    // the reason's pipe is escaped, not a column break
    assert.match(rowLine, /legacy \\\| keep/);
    // age in days: 2026-01-01 → 2026-08-17 = 228
    assert.match(rowLine, /\| 228 \|/);
  });

  test("no carried debt → placeholder, no table", () => {
    const { text } = buildRegisterFromRun({
      baselineKeys: new Set(),
      live: [],
      sidecar: emptySidecar(),
      now: NOW,
    });
    assert.match(text, /No carried debt\./);
    assert.ok(!text.includes("| Note |"));
  });
});

// ── 2. link + cell rendering ─────────────────────────────────────────────────

describe("noteLink / cell", () => {
  test("plain note path → wikilink without .md", () => {
    assert.equal(noteLink("Notes/A.md"), "[[Notes/A]]");
    assert.equal(noteLink("Deep/Sub/Note name.md"), "[[Deep/Sub/Note name]]");
  });

  test("pipe-in-path note → percent-encoded markdown link, table-safe", () => {
    const link = noteLink("Notes/--dangerously-skip-reading-code | olano.dev.md");
    // destination is percent-encoded — no raw pipe or space survives
    assert.ok(link.includes("%7C"), "pipe percent-encoded");
    assert.ok(!/\((?:[^)]*[ |])[^)]*\)/.test(link), "no raw space/pipe in the destination");
    // display escapes its pipe for the table
    assert.match(link, /\\\|/);
    // the whole cell has no UNescaped pipe that would break a table column
    assert.ok(!/(^|[^\\])\|/.test(link), "no unescaped pipe in the cell");
  });

  test("brackets/anchors fall back to markdown links; parens are encoded", () => {
    const b = noteLink("Notes/weird [draft].md");
    assert.ok(b.startsWith("[") && b.includes("%5B"), "brackets percent-encoded in destination");
    const p = noteLink("Notes/with (parens).md");
    assert.equal(p, "[[Notes/with (parens)]]", "parens alone are wikilink-safe");
    const h = noteLink("Notes/has#hash.md");
    assert.ok(h.includes("%23"), "anchor char forces the fallback");
  });

  test("non-path target → code span; cell escapes pipes and newlines", () => {
    assert.equal(noteLink("some_pack"), "`some_pack`");
    assert.equal(cell("a|b"), "a\\|b");
    assert.equal(cell("a\nb"), "a b");
    assert.equal(cell(undefined), "");
    assert.equal(cell(0), "0");
  });
});

// ── 3. ordering ──────────────────────────────────────────────────────────────

describe("orderDebtItems", () => {
  test("stale first, then priority, then age desc, then key", () => {
    const items = [
      { key: "d", target: "d.md", script: "s", check: "c", kind: "", ageDays: 5 },
      { key: "a", target: "a.md", script: "s", check: "c", kind: "", stale: true, ageDays: 100, priority: "low" },
      { key: "b", target: "b.md", script: "s", check: "c", kind: "", stale: true, ageDays: 200, priority: "high" },
      { key: "c", target: "c.md", script: "s", check: "c", kind: "", priority: "high", ageDays: 10 },
      { key: "e", target: "e.md", script: "s", check: "c", kind: "" },
    ];
    const order = orderDebtItems(items).map((i) => i.key);
    // stale+high (b), stale+low (a), fresh high (c), fresh unranked by age desc (d), unknown age last (e)
    assert.deepEqual(order, ["b", "a", "c", "d", "e"]);
  });
});

// ── 4. cap ───────────────────────────────────────────────────────────────────

describe("row cap", () => {
  test("rows beyond maxRows collapse to a +N more line", () => {
    const findings = Array.from({ length: 5 }, (_, i) => F("p", "c", `Notes/N${i}.md`));
    const { text } = buildRegisterFromRun({
      baselineKeys: new Set(findings.map(findingKey)),
      live: findings,
      sidecar: emptySidecar(),
      now: NOW,
      maxRows: 2,
    });
    const rows = text.split("\n").filter((l) => l.startsWith("| [[Notes/"));
    assert.equal(rows.length, 2);
    assert.match(text, /\+3 more row\(s\) not shown/);
  });
});

// ── 5. cleared section ───────────────────────────────────────────────────────

describe("cleared section", () => {
  test("lists the prune-these keys verbatim in code spans (copyable)", () => {
    const { text } = renderFixture();
    assert.match(text, /## Cleared — prune these from the baseline/);
    assert.match(text, /A human `--rebaseline` drops them/);
    // the departed key appears as a bullet, byte-for-byte (a human prunes by
    // copying it out of the register — an escape would corrupt it)
    assert.ok(text.includes("- `drift_audit|dup_uid|Gone/Away.md|`"));
  });

  test("(none) when nothing cleared", () => {
    const findings = [F("p", "c", "Notes/A.md")];
    const { text } = buildRegisterFromRun({
      baselineKeys: new Set(findings.map(findingKey)),
      live: findings,
      sidecar: emptySidecar(),
      now: NOW,
    });
    assert.match(text, /## Cleared — prune these from the baseline\n\n\(none\)/);
  });
});

// ── 6. the mutating render tool ──────────────────────────────────────────────

describe("vaultmcp_conformance_debt_render tool", () => {
  function setup({ config, settings, baselinePath } = {}) {
    const { findings, baselineKeys, sidecar } = fixture();
    const baselineText = "```ratchet-baseline\n" + [...baselineKeys].sort().join("\n") + "\n```\n";
    const writes = [];
    const source = {
      liveFindings: async () => findings,
      baselineText: async () => baselineText,
      sidecar: async () => sidecar,
      defaultRegisterDir: () => "Assent/Build/conformance",
      baselineNotePath: () => baselinePath ?? "Assent/Build/conformance/Conformance baseline.md",
      writeNote: async (p, t) => writes.push({ path: p, text: t }),
    };
    // The session's guard settings reach the handler as the v2 host's per-call
    // CallContext (the host's own makeCallContext over core's isVisible).
    const { tools } = publishInto([buildDebtRenderTool(source, { config: () => config, now: () => NOW })], {
      ...(settings ? { callContext: callContextFor(settings, isVisible) } : {}),
    });
    return { tool: tools.get("vaultmcp_conformance_debt_render"), writes, baselineText };
  }

  test("registers MUTATING and writes the register at the default path", async () => {
    const { tool, writes } = setup();
    assert.equal(tool.def.annotations.readOnlyHint, false);
    const res = await tool.handler({});
    assert.ok(!res.isError, res.content?.[0]?.text);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, `Assent/Build/conformance/${REGISTER_BASENAME}`);
    assert.match(writes[0].text, /generator: conformance-debt-register/);
    assert.match(writes[0].text, /# Conformance debt/);
    const sc = res.structuredContent;
    assert.equal(sc.written, `Assent/Build/conformance/${REGISTER_BASENAME}`);
    assert.equal(sc.summary.carried, 3);
    assert.equal(sc.cleared, 1);
    assert.equal(sc.truncated, false);
  });

  test("config registerDir overrides the default; registerMaxRows caps + reports truncated", async () => {
    const { tool, writes } = setup({ config: { registerDir: "System/Conformance/", registerMaxRows: 1 } });
    const res = await tool.handler({});
    assert.equal(writes[0].path, `System/Conformance/${REGISTER_BASENAME}`);
    assert.equal(res.structuredContent.rows, 1);
    assert.equal(res.structuredContent.truncated, true);
    assert.match(writes[0].text, /more row\(s\) not shown/);
  });

  test("REFUSES under an allowlist that does not cover the register path — nothing written", async () => {
    const { tool, writes } = setup({ settings: { readOnly: false, allowlist: ["Projects"] } });
    const res = await tool.handler({});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[out_of_allowlist\]/);
    assert.equal(writes.length, 0);
  });

  test("an allowlist covering the register path permits the render", async () => {
    const { tool, writes } = setup({ settings: { readOnly: false, allowlist: ["Assent"] } });
    const res = await tool.handler({});
    assert.ok(!res.isError, res.content?.[0]?.text);
    assert.equal(writes.length, 1);
  });

  test("a baseline named like the register REFUSES — including a case variant", async () => {
    // The exact path (via ASSENT_BASELINE_REL, a documented knob) …
    const exact = setup({ baselinePath: `Assent/Build/conformance/${REGISTER_BASENAME}` });
    const r1 = await exact.tool.handler({});
    assert.equal(r1.isError, true);
    assert.match(r1.content[0].text, /Error \[register_baseline_collision\]/);
    assert.equal(exact.writes.length, 0);
    // … and a case variant (macOS's default filesystem folds case).
    const variant = setup({ baselinePath: "assent/build/conformance/conformance DEBT.md" });
    const r2 = await variant.tool.handler({});
    assert.equal(r2.isError, true);
    assert.match(r2.content[0].text, /register_baseline_collision/);
    assert.equal(variant.writes.length, 0);
  });

  test("an absolute or vault-escaping registerDir config REFUSES — nothing written", async () => {
    for (const registerDir of ["/tmp/evil", "../outside", "a/../../outside", "C:\\evil"]) {
      const { tool, writes } = setup({ config: { registerDir } });
      const res = await tool.handler({});
      assert.equal(res.isError, true, `refused: ${registerDir}`);
      assert.match(res.content[0].text, /Error \[invalid_register_dir\]/);
      assert.equal(writes.length, 0);
    }
    // an interior `..` that still normalizes inside the vault is fine — and
    // the path written is the NORMALIZED one
    const ok = setup({ config: { registerDir: "A/../B" } });
    const res = await ok.tool.handler({});
    assert.ok(!res.isError);
    assert.equal(ok.writes[0].path, `B/${REGISTER_BASENAME}`);
  });

  test("the render never writes the baseline or the sidecar", async () => {
    const { tool, writes } = setup();
    await tool.handler({});
    for (const w of writes) {
      assert.ok(!w.path.endsWith("Conformance baseline.md"));
      assert.ok(!w.path.endsWith("Conformance debt.json"));
    }
  });

  test("debtRenderConfigOf defaults + coercion; registerNotePathFor shapes", () => {
    assert.deepEqual(debtRenderConfigOf(undefined), { registerDir: null, maxRows: 300 });
    assert.deepEqual(debtRenderConfigOf({ registerDir: "X/Y/", registerMaxRows: 5 }), { registerDir: "X/Y", maxRows: 5 });
    assert.deepEqual(debtRenderConfigOf({ registerDir: 7, registerMaxRows: 0 }), { registerDir: null, maxRows: 300 });
    assert.equal(registerNotePathFor(""), REGISTER_BASENAME);
    assert.equal(registerNotePathFor("A/B"), `A/B/${REGISTER_BASENAME}`);
    assert.equal(registerNotePathFor("A/B/"), `A/B/${REGISTER_BASENAME}`);
  });
});

// ── 7. the CLI ───────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "ASSENT_CONTENT_ROOT",
  "ASSENT_BASELINE_REL",
  "GOVERNOR_BASELINE_REL",
  "ASSENT_EXCLUDED_ROOTS",
  "ASSENT_ACCEPTED_BY",
  "ASSENT_DEBT_BUDGET",
  "ASSENT_REGISTER_DIR",
  "ASSENT_STALE_AFTER_DAYS",
];
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

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "conf-reg-"));
  await mkdir(path.join(root, "Notes"), { recursive: true });
  await writeFile(path.join(root, "Notes", "A.md"), "---\ntitle: A\ntags:\n  - rogue\n---\nbody\n");
  // Seed the live-shape root scope note (its `## Tags` table declares `keep`)
  // so the default scope-tags vocabulary is ON and `rogue` is carried debt —
  // with no root scope note scoping is off and no per-tag finding fires (#551).
  const scopeDir = path.join(root, "00-09 System", "00 System management");
  await mkdir(scopeDir, { recursive: true });
  await writeFile(
    path.join(scopeDir, "00 System management.md"),
    "---\ntitle: 00 System management\ntype: Meta/Scope/Category\n---\n# 00 System management\n\n## Tags\n\n| Tag | Description |\n| --- | --- |\n| `keep` | A tag the fixture declares. |\n"
  );
  return root;
}

describe("CLI --render-register", () => {
  test("plain run with the flag writes the register beside the baseline", async () => {
    const root = await vault();
    const baselinePath = path.join(root, "baseline.md");
    await writeFile(baselinePath, "# Conformance baseline\n");
    try {
      await withCleanEnv(async () => {
        // Seed the baseline so the run has carried debt.
        await runCli([`--root=${root}`, `--baseline=${baselinePath}`, "--no-legacy-packs", "--rebaseline", "--accepted-by=tester"]);
        const registerPath = path.join(root, REGISTER_BASENAME);
        // Rebaseline alone must NOT create a register unasked.
        assert.ok(!existsSync(registerPath), "no register created unasked at rebaseline");
        await runCli([`--root=${root}`, `--baseline=${baselinePath}`, "--no-legacy-packs", "--render-register"]);
        assert.ok(existsSync(registerPath), "register written");
        const text = await readFile(registerPath, "utf8");
        assert.match(text, /generator: conformance-debt-register/);
        assert.match(text, /## Carried debt/);
        // sidecar metadata (stamped at the rebaseline) reaches the table
        assert.match(text, /tester/);
        // baseline untouched by the render (still holds its fence)
        assert.ok(parseBaseline(await readFile(baselinePath, "utf8")).size > 0);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--rebaseline refreshes an EXISTING register automatically", async () => {
    const root = await vault();
    const baselinePath = path.join(root, "baseline.md");
    await writeFile(baselinePath, "# Conformance baseline\n");
    try {
      await withCleanEnv(async () => {
        await runCli([`--root=${root}`, `--baseline=${baselinePath}`, "--no-legacy-packs", "--rebaseline"]);
        const registerPath = path.join(root, REGISTER_BASENAME);
        await runCli([`--root=${root}`, `--baseline=${baselinePath}`, "--no-legacy-packs", "--render-register"]);
        // Plant a marker, then rebaseline WITHOUT the flag — the register regenerates.
        await writeFile(registerPath, "STALE MARKER\n");
        await runCli([`--root=${root}`, `--baseline=${baselinePath}`, "--no-legacy-packs", "--rebaseline"]);
        const text = await readFile(registerPath, "utf8");
        assert.ok(!text.includes("STALE MARKER"), "register refreshed at rebaseline");
        assert.match(text, /generator: conformance-debt-register/);
        // post-rebaseline state: nothing cleared, nothing new
        assert.match(text, /- Cleared: 0/);
        assert.match(text, /- New: 0/);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--register-dir routes the register elsewhere; a baseline-name collision refuses", async () => {
    const root = await vault();
    const baselinePath = path.join(root, "baseline.md");
    await writeFile(baselinePath, "# Conformance baseline\n");
    try {
      await withCleanEnv(async () => {
        await runCli([`--root=${root}`, `--baseline=${baselinePath}`, "--no-legacy-packs", "--rebaseline"]);
        await mkdir(path.join(root, "Reg"), { recursive: true });
        await runCli([`--root=${root}`, `--baseline=${baselinePath}`, "--no-legacy-packs", "--render-register", "--register-dir=Reg"]);
        assert.ok(existsSync(path.join(root, "Reg", REGISTER_BASENAME)));

        // A baseline named like the register in the same dir: render must refuse
        // rather than overwrite the acceptance record.
        const collidingBaseline = path.join(root, "Reg", REGISTER_BASENAME);
        await writeFile(collidingBaseline, "# Conformance baseline\n```ratchet-baseline\n```\n");
        await assert.rejects(
          runCli([`--root=${root}`, `--baseline=${collidingBaseline}`, "--no-legacy-packs", "--no-baseline", "--render-register", "--register-dir=Reg"]),
          /refusing to render the register over the baseline itself/,
        );
        // …and a CASE VARIANT of the register name collides too (the default
        // macOS filesystem folds case; the compare is case-folded).
        await mkdir(path.join(root, "Reg2"), { recursive: true });
        const caseVariant = path.join(root, "Reg2", REGISTER_BASENAME.toUpperCase());
        await writeFile(caseVariant, "# Conformance baseline\n```ratchet-baseline\n```\n");
        await assert.rejects(
          runCli([`--root=${root}`, `--baseline=${caseVariant}`, "--no-legacy-packs", "--no-baseline", "--render-register", "--register-dir=Reg2"]),
          /refusing to render the register over the baseline itself/,
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
