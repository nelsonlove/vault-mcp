/**
 * skills-guarded-8a.test.mjs — 01.61 rule 8a and its one exception.
 *
 * Rule 8a: a guarded territory's policies compile only into that territory's
 * own lead, and no text from it lands in a fleet-wide artifact. Amended
 * 2026-10-12 on Nelson's verify of "Revise the divorce-area rules around data
 * loss" (question 6, pick (b)): the territory's DATA-LOSS rules hold no case
 * content and must reach every writer, so they compile fleet-wide; a policy
 * note that carries case facts stays out. Here the territory is a setting
 * (`guardedRoots`) and the exception is the operator's exact list of policy
 * paths (`fleetWideRules`), so nothing in a note can put itself on it.
 *
 * Every fixture is in memory; no vault is read. The case-fact fixture's text
 * and name are invented markers (CASEFACT), never real content.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { collectNotes, guardedReach, compiles, agentCandidates, DEFAULT_FIELDS, runExport } from "../src/kernel/exporter.ts";
import { skillsConfigOf, fieldsOf, DEFAULT_SKILLS_CONFIG, validateSkillsConfig } from "../src/kernel/skills-config.ts";
import { analyzeVault } from "../src/kernel/exporter.ts";
import { handleNoteChanged } from "../src/export-trigger.ts";
import { TRANSCLUSION_GUARDED } from "../src/kernel/transclude.ts";
import { SKILLS_FIELDS } from "../src/settings.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HUMAN = { by: "human:nelson", at: "2026-10-12T00:33:22-04:00" };
const fm = (type, extra = {}) => ({ type, verified: [HUMAN], ...extra });

const AGENT = "03 Agents/Root agent.md";
const RULE = "80-89 Divorce/80.05 Agents/policies/Evidence integrity.md";
const CASE = "80-89 Divorce/80.05 Agents/policies/CASEFACT policy.md";
const CASE_SKILL = "80-89 Divorce/80.05 Agents/CASEFACT skill.md";
const CASE_NOTE = "80-89 Divorce/82 Case/CASEFACT note.md";

function sourceOf(notes, embeds = {}) {
  return {
    notes: async () => notes,
    resolveLink: (lp) => notes.find((n) => n.path.endsWith(`/${lp}.md`) || n.path === `${lp}.md`)?.path ?? null,
    embed: async (target) => {
      const hit = Object.keys(embeds).find((p) => p.endsWith(`/${target}.md`) || p === `${target}.md`);
      return hit ? { path: hit, content: embeds[hit].content, frontmatter: embeds[hit].frontmatter } : null;
    },
    basePath: () => null,
  };
}
const notes = () => [
  { path: AGENT, frontmatter: fm("agent", { description: "root" }), body: "Root agent." },
  { path: RULE, frontmatter: fm("policy", { parent: "[[Root agent]]", severity: "hard" }), body: "A source evidence note changes only by adding." },
  { path: CASE, frontmatter: fm("policy", { parent: "[[Root agent]]" }), body: "CASEFACT text." },
  { path: CASE_SKILL, frontmatter: fm("skill", { parent: "[[Root agent]]", description: "x" }), body: "CASEFACT skill." },
];
const F = (over = {}) => ({ ...DEFAULT_FIELDS, typeSource: "frontmatter", includeRoots: ["03 Agents", "80-89 Divorce"], guardedRoots: ["80-89 Divorce"], fleetWideRules: [RULE], ...over });

describe("guardedReach and compiles", () => {
  test("outside, rule and territory", () => {
    assert.equal(guardedReach(AGENT, F()), "outside");
    assert.equal(guardedReach(RULE, F()), "rule");
    assert.equal(guardedReach(CASE, F()), "territory");
    assert.equal(guardedReach("80-89 Divorce-archive/x.md", F()), "outside", "a sibling folder that continues the name is not the territory (core's boundary rule)");
  });
  test("the list is exact: case, Unicode form and a leading slash do not matter, a folder or a prefix does not count", () => {
    assert.equal(guardedReach(RULE.toUpperCase(), F()), "rule");
    assert.equal(guardedReach(RULE, F({ fleetWideRules: ["/" + RULE] })), "rule");
    const cafe = "80-89 Divorce/Café.md";
    assert.equal(guardedReach(cafe, F({ fleetWideRules: [cafe.normalize("NFD")] })), "rule");
    assert.equal(guardedReach(RULE, F({ fleetWideRules: ["80-89 Divorce/80.05 Agents/policies"] })), "territory");
    assert.equal(guardedReach(RULE, F({ fleetWideRules: ["80-89 Divorce/80.05 Agents/policies/Evidence"] })), "territory");
  });
  test("a listed rule compiles even when no include root covers it; the territory never does", () => {
    assert.equal(compiles(RULE, F({ includeRoots: ["03 Agents"] })), true);
    assert.equal(compiles(CASE, F({ includeRoots: ["03 Agents", "80-89 Divorce"] })), false);
    assert.equal(compiles(RULE, F({ excludeRoots: ["80-89 Divorce/80.05 Agents"] })), false, "the exclude roots still bind a rule");
  });
  test("no guarded roots means the old behaviour, the list ignored", () => {
    const f = F({ guardedRoots: [] });
    assert.equal(guardedReach(CASE, f), "outside");
    assert.equal(compiles(CASE, f), true);
  });
});

describe("collectNotes", () => {
  test("the data-loss rule compiles fleet-wide; the case-fact policy and skill stay out, counted and not named", async () => {
    const warnings = [];
    const got = await collectNotes(sourceOf(notes()), F(), warnings);
    const paths = got.map((n) => n.path).sort();
    assert.deepEqual(paths, [AGENT, RULE].sort());
    const all = warnings.join("\n");
    assert.match(all, /2 note\(s\) with frontmatter under a guarded territory kept out/);
    assert.ok(!all.includes("CASEFACT"), "no warning names a territory note: " + all);
  });
  test("a listed path that is not a policy is refused", async () => {
    const warnings = [];
    const got = await collectNotes(sourceOf(notes()), F({ fleetWideRules: [RULE, CASE_SKILL] }), warnings);
    assert.ok(!got.some((n) => n.path === CASE_SKILL));
    assert.ok(warnings.some((w) => /1 note\(s\) on the fleet-wide rules list are not policies/.test(w)), warnings.join("\n"));
    assert.ok(!warnings.join("\n").includes("CASEFACT"));
  });
  test("a listed rule still passes the acceptance gate", async () => {
    const ns = notes().map((n) => n.path === RULE ? { ...n, frontmatter: { type: "policy", parent: "[[Root agent]]" } } : n);
    const got = await collectNotes(sourceOf(ns), F(), []);
    assert.ok(!got.some((n) => n.path === RULE));
  });
  test("a listed path outside every guarded root is named in a warning and is no exception", async () => {
    const warnings = [];
    await collectNotes(sourceOf(notes()), F({ fleetWideRules: [RULE, "10-19 Personal/x.md"] }), warnings);
    assert.ok(warnings.some((w) => w.startsWith("10-19 Personal/x.md: on the fleet-wide rules list but under no guarded root")), warnings.join("\n"));
  });
  test("an embed of a territory note is refused at any depth, with a marker that names no path; an embed of the rule is inlined", async () => {
    const ns = [
      { path: AGENT, frontmatter: fm("agent", { description: "root" }), body: "Root.\n\n![[CASEFACT note]]\n\n![[Evidence integrity]]\n" },
      notes()[1],
    ];
    const embeds = {
      [CASE_NOTE]: { content: "CASEFACT secret body", frontmatter: { verified: [HUMAN] } },
      [RULE]: { content: "Only by adding.", frontmatter: fm("policy") },
    };
    const warnings = [];
    const got = await collectNotes(sourceOf(ns, embeds), F(), warnings);
    const agent = got.find((n) => n.path === AGENT);
    assert.ok(agent.body.includes(TRANSCLUSION_GUARDED), agent.body);
    assert.ok(!agent.body.includes("CASEFACT"), agent.body);
    assert.ok(agent.body.includes("Only by adding."), "the listed rule embeds like any accepted note");
    assert.ok(!agent.sources.some((p) => p.includes("CASEFACT")));
    const all = warnings.join("\n");
    assert.match(all, /1 embed\(s\) of a note in a guarded territory refused/);
    assert.ok(!all.includes("CASEFACT"), all);
  });
  test("a listed note that is not a policy is refused as an EMBED too; so is a listed rule under an exclude root", async () => {
    const ns = [{ path: AGENT, frontmatter: fm("agent", { description: "root" }), body: "Root.\n\n![[CASEFACT skill]]\n" }];
    const embeds = { [CASE_SKILL]: { content: "CASEFACT skill body", frontmatter: fm("skill") } };
    const warnings = [];
    const got = await collectNotes(sourceOf(ns, embeds), F({ fleetWideRules: [RULE, CASE_SKILL] }), warnings);
    const agent = got.find((n) => n.path === AGENT);
    assert.ok(agent.body.includes(TRANSCLUSION_GUARDED) && !agent.body.includes("CASEFACT"), agent.body);
    const ns2 = [{ path: AGENT, frontmatter: fm("agent", { description: "root" }), body: "Root.\n\n![[Evidence integrity]]\n" }];
    const got2 = await collectNotes(sourceOf(ns2, { [RULE]: { content: "Only by adding.", frontmatter: fm("policy") } }), F({ excludeRoots: ["80-89 Divorce/80.05 Agents"] }), []);
    assert.ok(!got2[0].body.includes("Only by adding."), got2[0].body);
  });
  test("a parent inside a guarded territory is a broken edge whose error names no path", async () => {
    const ns = [
      { path: AGENT, frontmatter: fm("agent", { description: "root" }), body: "Root." },
      { path: "03 Agents/s.md", frontmatter: fm("skill", { parent: "[[CASEFACT lead]]", description: "x" }), body: "s" },
      { path: "80-89 Divorce/80.05 Agents/CASEFACT lead.md", frontmatter: fm("agent"), body: "CASEFACT" },
    ];
    const a = await analyzeVault(sourceOf(ns), F());
    const all = [...a.errors, ...a.warnings].join("\n");
    assert.ok(a.errors.some((e) => /unresolved parent/.test(e)), all);
    assert.ok(!all.includes("CASEFACT"), all);
  });
  test("the export writes the rule into the agent and no case text anywhere in the plugin", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "skills-8a-"));
    try {
      await runExport(sourceOf(notes()), { outputDir: out, pluginName: "vault-skills", fields: F() });
      const files = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
      walk(out);
      const text = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
      assert.ok(text.includes("A source evidence note changes only by adding."), "the rule reaches the compiled agent");
      assert.ok(!text.includes("CASEFACT"), "no territory text or name in the plugin");
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("settings and the other readers", () => {
  test("both keys ship EMPTY and fieldsOf carries them; a non-.md list line is KEPT and reported, never dropped in silence", async () => {
    assert.deepEqual(DEFAULT_SKILLS_CONFIG.guardedRoots, []);
    assert.deepEqual(DEFAULT_SKILLS_CONFIG.fleetWideRules, []);
    const raw = { guardedRoots: [" 80-89 Divorce ", ""], fleetWideRules: ["/" + RULE, "80-89 Divorce/80.05 Agents/policies"] };
    const f = fieldsOf(skillsConfigOf(raw));
    assert.deepEqual(f.guardedRoots, ["80-89 Divorce"]);
    assert.deepEqual(f.fleetWideRules, [RULE, "80-89 Divorce/80.05 Agents/policies"]);
    assert.ok(validateSkillsConfig(raw).some((p) => /fleetWideRules: '80-89 Divorce\/80.05 Agents\/policies' is not a note path/.test(p)));
    assert.ok(validateSkillsConfig({ fleetWideRules: [RULE] }).some((p) => /guardedRoots is EMPTY/.test(p)));
    const warnings = [];
    await collectNotes(sourceOf(notes()), F({ fleetWideRules: [RULE, "80-89 Divorce/80.05 Agents/policies"] }), warnings);
    assert.ok(warnings.some((w) => /not a note path \(no \.md\)/.test(w)), warnings.join("\n"));
    for (const k of ["guardedRoots", "fleetWideRules"]) assert.ok(SKILLS_FIELDS.some((x) => x.key === k && x.type === "lines"), k);
  });
  test("the agent picker never offers a territory agent", () => {
    const list = [{ path: AGENT, frontmatter: fm("agent") }, { path: "80-89 Divorce/80.05 Agents/CASEFACT lead.md", frontmatter: fm("agent") }];
    assert.deepEqual(agentCandidates(list, F()), [AGENT]);
  });
  test("an edit to a territory note does not trigger an export; an edit to the listed rule does", () => {
    let n = 0;
    const deps = (f) => ({ isEnabled: () => true, requestExport: () => { n += 1; }, getFrontmatter: (file) => file.fm, fields: () => f });
    handleNoteChanged({ path: CASE, fm: fm("policy") }, deps(F()));
    assert.equal(n, 0);
    handleNoteChanged({ path: RULE, fm: fm("policy") }, deps(F({ includeRoots: ["03 Agents"] })));
    assert.equal(n, 1);
  });
});
