/**
 * conformance-shape-pack.test.mjs — the `shape` rule pack, check (a) of the
 * vault task "Replace the four Forge-only checks" (Nelson's verify of
 * 2026-10-14, pick A: the checks live in the vaultmcp-conformance satellite).
 *
 * Three layers. The derivation and the matcher are Forge's own (nl.11 plus
 * forge#5, ported under src/kernel/shapes with the MIT notice), so their
 * cases come across from Forge's tests/shape-lint.test.ts, re-stated over the
 * ported functions. Then the pack: the class list from `fileclassesRoot`,
 * the four finding keys, "unchecked" never read as clean, the governed scope,
 * absence refused. Then the run: the pack registers with the legacy packs, a
 * blank `fileclassesRoot` is a dead convention (the pack is NOT measured).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { deriveShapeHeadingText, deriveShapeHeadings, shapeHeadingsForClassNote } from "../src/kernel/shapes/derive.ts";
import { shapeGaps } from "../src/kernel/shapes/match.ts";
import { shapePack, runShape, typeNames, SHAPE_PACK_ID } from "../src/kernel/packs/index.ts";
import { runEngine, ENGINE_ID } from "../src/kernel/engine.ts";
import { findingKey } from "../src/kernel/finding.ts";
import { runConformance } from "../src/kernel/cli.ts";
import { EMPTY_VAULT_CONVENTIONS } from "../src/kernel/vault-conventions.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = "Sys/Fileclasses";
const CONV = { ...EMPTY_VAULT_CONVENTIONS, fileclassesRoot: ROOT };
const fmOf = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (m) for (const line of m[1].split("\n")) { const kv = line.match(/^(\w+): (.*)$/); if (kv) out[kv[1]] = kv[2]; }
  return out;
};
/** A snapshot from {path: text}: `sources` as the walk gives them, `notes` with a minimal frontmatter parse (scalar keys; a `type` list is written as JSON). */
function snap(files) {
  const sources = Object.entries(files).map(([p, text]) => ({ path: p, text }));
  const notes = sources.map((s) => {
    const fm = fmOf(s.text);
    if (typeof fm.type === "string" && fm.type.startsWith("[")) fm.type = JSON.parse(fm.type);
    return { path: s.path, frontmatter: fm, body: s.text };
  });
  return { notes, paths: sources.map((s) => s.path), sources, blueprints: [], dirs: [], walkOrder: sources.map((s) => s.path), files: [] };
}
const cls = (template) => `---\ntype: Meta/Fileclass\n---\n\n# Class\n\nProse.\n\n## Template\n\n\`\`\`\`md\n${template}\n\`\`\`\`\n`;
const run = (files) => shapePack(CONV).run(snap(files));
const keys = (findings) => findings.map(findingKey).sort();

// ── the derivation (Forge's cases) ────────────────────────────────────────────

describe("the generator-to-wildcard pass (ported from Forge)", () => {
  test("literal words survive; {{…}} tokens are kept as written", () => {
    assert.equal(deriveShapeHeadingText("Why it matters"), "Why it matters");
    assert.equal(deriveShapeHeadingText("Status of {{VALUE:url}}"), "Status of {{VALUE:url}}");
    assert.equal(deriveShapeHeadingText("Log for {{date:YYYY-MM-DD}}"), "Log for {{date:YYYY-MM-DD}}");
  });
  test("a render span becomes a placeholder; a heading that is only a placeholder collapses to {{TITLE}}", () => {
    assert.equal(deriveShapeHeadingText("Status `INPUT[status]`"), "Status {{INPUT}}");
    assert.equal(deriveShapeHeadingText("`VIEW[{title}][text]`"), "{{TITLE}}");
    assert.equal(deriveShapeHeadingText("[{{TITLE}}]({{VALUE:url}})"), "{{TITLE}}");
  });
  test("a heading with no placeholder is never collapsed; code that is not a render stays literal; an unclosed span is literal", () => {
    assert.equal(deriveShapeHeadingText("---"), "---");
    assert.equal(deriveShapeHeadingText("Use `npm test` first"), "Use `npm test` first");
    assert.equal(deriveShapeHeadingText("Status `INPUT[x"), "Status `INPUT[x");
  });
  test("a fence derives into headings at the levels written; frontmatter, prose, tables and nested code are skipped", () => {
    const fence = ["---", "status: draft", "---", "# `VIEW[{title}][text]`", "", "Prose.", "", "| a | b |", "| - | - |", "", "```js-engine", "// # Not a heading", "```", "", "## Why it matters", "### Detail for {{VALUE:url}}"].join("\n");
    assert.deepEqual(deriveShapeHeadings(fence).map((h) => ({ level: h.level, text: h.text })), [
      { level: 1, text: "{{TITLE}}" },
      { level: 2, text: "Why it matters" },
      { level: 3, text: "Detail for {{VALUE:url}}" },
    ]);
  });
});

describe("a class note's shape, and which fence it comes from (ported from Forge)", () => {
  const templateFence = ["## Template", "", "```md", "# [{{TITLE}}]({{VALUE:url}})", "## Why it matters", "## Status", "```"].join("\n");
  const shapeFence = ["## Shape", "", "```md", "# {{TITLE}}", "## Why it matters", "### Status key", "```"].join("\n");
  const texts = (note) => shapeHeadingsForClassNote(note).map((h) => `${"#".repeat(h.level)} ${h.text}`);

  test("derives from ## Template when there is no ## Shape; an explicit ## Shape wins, wherever it sits", () => {
    assert.deepEqual(texts(`---\ntitle: Link\n---\n\n# Link\n\n${templateFence}\n`), ["# {{TITLE}}", "## Why it matters", "## Status"]);
    const expected = ["# {{TITLE}}", "## Why it matters", "### Status key"];
    assert.deepEqual(texts(`# Link\n\n${shapeFence}\n\n${templateFence}\n`), expected);
    assert.deepEqual(texts(`# Link\n\n${templateFence}\n\n${shapeFence}\n`), expected);
  });
  test("neither fence, or an empty Template fence, is no shape at all", () => {
    assert.deepEqual(shapeHeadingsForClassNote("---\ntitle: Bare\n---\n\n# Bare\n\nProse only.\n"), []);
    assert.deepEqual(shapeHeadingsForClassNote("# Bare\n\n## Template\n\n```md\n```\n"), []);
  });
  test("an unusable ## Shape section (empty fence, bare heading, prose) falls through to the Template", () => {
    const derived = ["# {{TITLE}}", "## Why it matters", "## Status"];
    assert.deepEqual(texts(`# C\n\n## Shape\n\n\`\`\`md\n\`\`\`\n\n${templateFence}\n`), derived);
    assert.deepEqual(texts(`# C\n\n## Shape\n\n${templateFence}\n`), derived);
    assert.deepEqual(texts(`# C\n\n## Shape\n\nProse.\n\n${templateFence}\n`), derived);
  });
  test("a nested fence of the same length truncates (reports less, never wrongly); a longer outer fence keeps every heading", () => {
    const nested = ["## Template", "", "```md", "# {{TITLE}}", "", "```js-engine", "// a view", "```", "", "## Why it matters", "## Status", "```"].join("\n");
    assert.deepEqual(texts(`# C\n\n${nested}\n`), ["# {{TITLE}}"]);
    const longer = nested.replace("```md", "````md").replace(/```$/, "````");
    assert.deepEqual(texts(`# C\n\n${longer}\n`), ["# {{TITLE}}", "## Why it matters", "## Status"]);
  });
  test("a fence in the class note's own frontmatter is not read; a ## Shape inside the Template fence is not a Shape (forge#5)", () => {
    assert.deepEqual(texts("---\nnote: |\n  ## Shape\n  ```md\n  # Wrong\n  ```\n---\n\n# Real\n\n" + templateFence + "\n"), ["# {{TITLE}}", "## Why it matters", "## Status"]);
    const note = ["# Class", "", "## Template", "", "````md", "# {{TITLE}}", "## Overview", "## Shape", "", "```md", "# Decoy", "```", "", "## Template", "````", ""].join("\n");
    assert.deepEqual(texts(note), ["# {{TITLE}}", "## Overview", "## Shape", "## Template"]);
  });
});

// ── the matcher (Forge's cases, missing and order only) ──────────────────────

describe("the matcher: missing headings and order (ported from Forge)", () => {
  const shape = (t) => deriveShapeHeadings(t);
  test("a leading # {{TITLE}} is optional: sections are checked under the title, or at the top when there is none", () => {
    const s = shape("# {{TITLE}}\n\n## Overview\n\n## Outcome\n");
    assert.equal(s[0].optional, true);
    assert.deepEqual(shapeGaps("---\ntype: Task\n---\n# My task\n\n## Overview\n\nx\n\n## Outcome\n\ny\n", s), []);
    assert.deepEqual(shapeGaps("---\ntype: Task\n---\n## Overview\n\nx\n\n## Outcome\n\ny\n", s), []);
    assert.deepEqual(shapeGaps("---\ntype: Task\n---\n## Overview\n\nx\n", s), [{ kind: "missing", level: 2, text: "Outcome", parent: null }]);
  });
  test("only a leading H1 that derives to the bare title is optional", () => {
    assert.equal(deriveShapeHeadings("## Intro\n# {{TITLE}}\n")[1].optional, undefined);
    assert.equal(deriveShapeHeadings("# Fixed title\n## A\n")[0].optional, undefined);
  });
  test("a wildcard needs concrete text, and never consumes a fixed sibling", () => {
    assert.deepEqual(shapeGaps("# Log for \n", [{ level: 1, text: "Log for {{DATE}}", lineIndex: 0 }]).map((g) => g.kind), ["missing"]);
    const gaps = shapeGaps("# Summary\nDone\n", [{ level: 1, text: "{{TITLE}}", lineIndex: 0 }, { level: 1, text: "Summary", lineIndex: 1 }]);
    assert.deepEqual(gaps, [{ kind: "missing", level: 1, text: "{{TITLE}}", parent: null }]);
  });
  test("namespaced placeholders match non-empty text", () => {
    assert.deepEqual(shapeGaps("# Apollo Migration\nBody\n## Log for 2026-08-24\nEntry\n", shape("# {{TITLE}}\n## Log for {{DATE}}\n")), []);
  });
  test("headings out of order are one order gap naming the expected order", () => {
    const gaps = shapeGaps("# T\n## Outcome\n\n## Overview\n", shape("# {{TITLE}}\n## Overview\n## Outcome\n"));
    assert.deepEqual(gaps, [{ kind: "order", parent: "{{TITLE}}", expected: ["overview", "outcome"] }]);
  });
  test("a missing nested heading names its parent; headings in code blocks or %% comments are not headings", () => {
    const s = shape("# {{TITLE}}\n## Context\n### Detail\n");
    assert.deepEqual(shapeGaps("# T\n## Context\n```\n### Detail\n```\n%% ### Detail %%\n", s), [{ kind: "missing", level: 3, text: "Detail", parent: "Context" }]);
  });
  test("extra headings and empty sections are NOT reported (the plan carries missing and order only)", () => {
    assert.deepEqual(shapeGaps("# T\n## Overview\n## Something else\n## Outcome\n", shape("# {{TITLE}}\n## Overview\n## Outcome\n")), []);
  });
});

// ── the pack ──────────────────────────────────────────────────────────────────

describe("shape pack", () => {
  const TASK = cls("# {{TITLE}}\n\n## Ask\n\n## Response");
  const files = (extra) => ({ [`${ROOT}/Task/AgentTask.md`]: TASK, [`${ROOT}/Bare.md`]: "---\ntype: Meta/Fileclass\n---\n# Bare\nNo fence.\n", ...extra });

  test("a note of a class with its headings, in order, is clean", () => {
    const f = run(files({ "Notes/a.md": "---\ntype: Task/AgentTask\n---\n# A\n## Ask\nx\n## Response\ny\n" }));
    assert.deepEqual(f.filter((x) => x.target === "Notes/a.md"), []);
  });

  test("missing_heading and heading_order: keyed on the path, the class and the heading — no line numbers", () => {
    const f = run(files({
      "Notes/miss.md": "---\ntype: Task/AgentTask\n---\n# A\n## Ask\nx\n",
      "Notes/order.md": "---\ntype: Task/AgentTask\n---\n# A\n## Response\ny\n## Ask\nx\n",
    }));
    const k = keys(f.filter((x) => x.target.startsWith("Notes/")));
    assert.deepEqual(k, ["shape|heading_order|Notes/order.md|Task/AgentTask: {{TITLE}}", "shape|missing_heading|Notes/miss.md|Task/AgentTask: {{TITLE}} > ## Response"]);
    const miss = f.find((x) => x.check === "missing_heading");
    assert.equal(miss.detail, "missing heading '## Response' under '{{TITLE}}' (required by class 'Task/AgentTask')");
    const order = f.find((x) => x.check === "heading_order");
    assert.match(order.detail, /Expected: 'ask' → 'response'/);
  });

  test("a note with no title heading is checked at its top level (the optional title, 01.14 rule 7a)", () => {
    const f = run(files({ "Notes/untitled.md": "---\ntype: Task/AgentTask\n---\n## Ask\nx\n" }));
    assert.deepEqual(keys(f.filter((x) => x.target === "Notes/untitled.md")), ["shape|missing_heading|Notes/untitled.md|Task/AgentTask: ## Response"]);
  });

  test("a class with neither fence is reported ONCE as unchecked, never read as clean — and its notes are not checked", () => {
    const f = run(files({ "Notes/b1.md": "---\ntype: Bare\n---\nbody\n", "Notes/b2.md": "---\ntype: Bare\n---\nbody\n" }));
    const unchecked = f.filter((x) => x.check === "unchecked_class");
    assert.deepEqual(keys(unchecked), [`shape|unchecked_class|${ROOT}/Bare.md|Bare`]);
    assert.match(unchecked[0].detail, /NOT checked \(not clean\)/);
    assert.deepEqual(f.filter((x) => x.target.startsWith("Notes/")), []);
  });

  test("unbound_type: a type that names no class is one finding per note and type value", () => {
    const f = run(files({ "Notes/old.md": "---\ntype: runtime_workflow\n---\nbody\n" }));
    assert.deepEqual(keys(f.filter((x) => x.target === "Notes/old.md")), ["shape|unbound_type|Notes/old.md|runtime_workflow"]);
    // The class notes themselves are `type: Meta/Fileclass`, which this fixture declares no class for: unbound too, as in a vault without that class note.
    assert.deepEqual(keys(f.filter((x) => x.check === "unbound_type" && x.target.startsWith(ROOT))), [`shape|unbound_type|${ROOT}/Bare.md|Meta/Fileclass`, `shape|unbound_type|${ROOT}/Task/AgentTask.md|Meta/Fileclass`]);
  });

  test("the class name is exact: the path under the root without .md", () => {
    const f = run(files({ "Notes/case.md": "---\ntype: task/agenttask\n---\n# A\n" }));
    assert.deepEqual(keys(f.filter((x) => x.target === "Notes/case.md")), ["shape|unbound_type|Notes/case.md|task/agenttask"]);
  });

  test("a list-valued type checks every class it names; repeats are checked once; non-strings claim nothing", () => {
    assert.deepEqual(typeNames(["A", " A ", "B", 3, null, ""]), ["A", "B"]);
    assert.deepEqual(typeNames("  X "), ["X"]);
    assert.deepEqual(typeNames(5), []);
    const f = run(files({ "Notes/two.md": '---\ntype: ["Task/AgentTask", "Nope"]\n---\n# A\n## Ask\nx\n' }));
    assert.deepEqual(keys(f.filter((x) => x.target === "Notes/two.md")), ["shape|missing_heading|Notes/two.md|Task/AgentTask: {{TITLE}} > ## Response", "shape|unbound_type|Notes/two.md|Nope"]);
  });

  test("a note with no type is not this pack's (that is no finding, and not counted as checked)", () => {
    const r = runShape(snap(files({ "Notes/plain.md": "---\ntitle: x\n---\nbody\n" })), CONV);
    assert.deepEqual(r.findings.filter((x) => x.target === "Notes/plain.md"), []);
    assert.equal(r.coverage.checkedNotes, 0, "nothing in this fixture names a class with a shape");
  });

  test("scope: dot/.trash segments, _ roots and Assent are not checked", () => {
    const bad = "---\ntype: Task/AgentTask\n---\n# A\n";
    const f = run(files({ "_hold/a.md": bad, "Assent/b.md": bad, ".obsidian/c.md": bad, "x/.hidden/d.md": bad, "Notes/e.md": bad }));
    assert.deepEqual([...new Set(f.filter((x) => x.check === "missing_heading").map((x) => x.target))], ["Notes/e.md"]);
  });

  test("coverage: classes, unchecked classes, checked notes and unbound notes", () => {
    const r = runShape(snap(files({ "Notes/a.md": "---\ntype: Task/AgentTask\n---\n# A\n", "Notes/old.md": "---\ntype: gone\n---\n" })), CONV);
    assert.deepEqual(r.coverage, { classes: 2, uncheckedClasses: 1, checkedNotes: 1, unboundNotes: 3 });
  });

  test("the absent `sources` listing is refused, not read as an empty vault (#125)", () => {
    const s = snap(files({}));
    delete s.sources;
    const errs = runEngine([shapePack(CONV)], s).filter((f) => f.script === ENGINE_ID && f.check === "pack_error");
    assert.equal(errs.length, 1);
    assert.match(errs[0].detail, /'sources' listing, which is absent/);
  });

  test("the pack reads ONE convention, fileclassesRoot, and names no folder of its own (pinned at the source)", () => {
    const src = fs.readFileSync(path.join(HERE, "..", "src", "kernel", "packs", "shape.ts"), "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*\*[\s\S]*?\*\//g, "");
    assert.match(code, /conv\.fileclassesRoot/);
    assert.doesNotMatch(code, /00\.10|Fileclasses"/);
    assert.equal(SHAPE_PACK_ID, "shape");
  });

  test("the Forge MIT notice travels with the ported code", () => {
    const dir = path.join(HERE, "..", "src", "kernel", "shapes");
    assert.match(fs.readFileSync(path.join(dir, "LICENSE"), "utf8"), /MIT License[\s\S]*Copyright \(c\) 2026 Joshua Walls/);
    for (const f of ["derive.ts", "headings.ts", "identity.ts", "match.ts", "shape-source.ts"]) {
      assert.match(fs.readFileSync(path.join(dir, f), "utf8"), /Ported from Forge[\s\S]{0,200}MIT licence, copyright \(c\) 2026 Joshua Walls/, f);
    }
  });
});

// ── the run ───────────────────────────────────────────────────────────────────

describe("the shape pack in a conformance run", () => {
  async function vault() {
    const root = await mkdtemp(path.join(os.tmpdir(), "shape-run-"));
    await mkdir(path.join(root, ROOT, "Task"), { recursive: true });
    await mkdir(path.join(root, "Notes"), { recursive: true });
    await writeFile(path.join(root, ROOT, "Task", "AgentTask.md"), cls("# {{TITLE}}\n\n## Ask\n\n## Response"));
    await writeFile(path.join(root, "Notes", "a.md"), "---\ntype: Task/AgentTask\n---\n# A\n## Ask\nx\n");
    return root;
  }
  const base = { baselineText: "", vocabularies: [], schemes: [] };

  test("blank fileclassesRoot: the pack registers, is NOT measured, and the run says so (a dead convention, never clean)", async () => {
    const root = await vault();
    try {
      const res = await runConformance({ ...base, root, conventions: { ...EMPTY_VAULT_CONVENTIONS } });
      assert.ok(res.packIds.includes("shape"));
      assert.ok(!res.coveredPackIds.includes("shape"));
      assert.ok(!res.findings.some((f) => f.script === "shape"));
      assert.ok(res.findings.some((f) => f.script === ENGINE_ID && f.check === "dead_convention" && f.target === "fileclassesRoot"));
      assert.match(res.report, /DEAD CONVENTION: fileclassesRoot = \(empty\) — 'shape' not measured/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fileclassesRoot named: the pack is measured, and its findings are NEW", async () => {
    const root = await vault();
    try {
      const res = await runConformance({ ...base, root, conventions: { ...EMPTY_VAULT_CONVENTIONS, fileclassesRoot: ROOT } });
      assert.ok(res.coveredPackIds.includes("shape"));
      assert.ok(res.ratchet.newKeys.includes("shape|missing_heading|Notes/a.md|Task/AgentTask: {{TITLE}} > ## Response"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
