/**
 * skills-settings-404.test.mjs — the type map and the roots are SETTINGS with
 * no shipped spelling (#404, ruled by Nelson 2026-09-26).
 *
 * The compiler hardcoded the bare frontmatter types `policy`/`agent`/`skill`/
 * `command`; the vault types by class path (`Note/AgentPolicy`, `Person/Agent`).
 * One vault's spelling baked into a plugin — the 2026-09-22 defect, same remedy:
 * the PLUGIN ships an empty type map and empty include roots (nothing compiles
 * until the operator names their classes and folders), while the KERNEL keeps an
 * identity map for its direct callers. The `~/.claude/agents` symlink loads 03.18
 * natively today, so the roots setting is also how the fleet keeps the six rank
 * files from loading twice until the switch ([C0-CC]'s word, on issue #404).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detectKind, mappedKind, spellingFor, inRoots, collectNotes, analyzeVault, markFrontmatter,
  IDENTITY_TYPE_MAP, DEFAULT_FIELDS,
} from "../src/kernel/exporter.ts";
import {
  DEFAULT_SKILLS_CONFIG, skillsConfigOf, fieldsOf, typeMapOf, parseTypeMapLines, typeMapLines, validateSkillsConfig,
} from "../src/kernel/skills-config.ts";
import { handleNoteChanged, handleNoteRenamed } from "../src/export-trigger.ts";
import { runExport, agentCandidates, acceptedEmbed } from "../src/kernel/exporter.ts";
import { transclusionRefused } from "../src/kernel/transclude.ts";
import { textAreaValue, SKILLS_FIELDS } from "../src/settings.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A fake SkillsSource over a note list. */
function sourceOf(notes) {
  return {
    notes: async () => notes,
    resolveLink: (lp) => notes.find((n) => n.path.endsWith(`/${lp}.md`) || n.path === `${lp}.md`)?.path ?? null,
    embed: async () => null,
    basePath: () => null,
  };
}
// Every fixture note is ACCEPTED unless a test says otherwise: since the
// acceptance gate (01.41 rule 8) a typed note without a human `verified` entry
// does not compile at all. `unverified()` builds the exception on purpose.
const HUMAN = { by: "human:nelson", at: "2026-09-25T05:08:39-04:00" };
const fm = (type, extra = {}) => ({ type, verified: [HUMAN], ...extra });
const unverified = (type, extra = {}) => ({ type, ...extra });
const VAULT_MAP = { "Note/AgentPolicy": "policy", "Person/Agent": "agent", "Note/Skill": "skill" };
const F = (over) => ({ ...DEFAULT_FIELDS, typeSource: "frontmatter", ...over });

describe("the kernel keeps an identity map; the plugin ships an empty one", () => {
  test("detectKind with no typeMap maps the bare kinds — every direct kernel caller is unchanged", () => {
    for (const k of ["skill", "agent", "policy", "command"]) assert.equal(detectKind({ type: k }, { type: k }, F({})), k);
    assert.deepEqual(IDENTITY_TYPE_MAP, { skill: "skill", agent: "agent", policy: "policy", command: "command" });
  });

  test("DEFAULT_SKILLS_CONFIG ships an EMPTY type map and EMPTY roots, and fieldsOf carries them", () => {
    assert.deepEqual(DEFAULT_SKILLS_CONFIG.typeMap, {});
    assert.deepEqual(DEFAULT_SKILLS_CONFIG.includeRoots, []);
    assert.deepEqual(DEFAULT_SKILLS_CONFIG.excludeRoots, []);
    const f = fieldsOf(skillsConfigOf({}));
    assert.deepEqual(f.typeMap, {}); assert.deepEqual(f.includeRoots, []); assert.deepEqual(f.excludeRoots, []);
  });

  test("under the shipped config NOTHING compiles, and the warnings say why — never a silent empty plugin", async () => {
    const src = sourceOf([{ path: "03 Agents/03.01 Inbox/Policies/P.md", frontmatter: fm("Note/AgentPolicy"), body: "p" }]);
    const warnings = [];
    const notes = await collectNotes(src, fieldsOf(skillsConfigOf({})), warnings);
    assert.deepEqual(notes, []);
    assert.ok(warnings.some((w) => /include roots are EMPTY/.test(w)), warnings.join("\n"));
  });
});

describe("mappedKind — the vault's spelling, exactly", () => {
  test("a mapped class path compiles as its kind; the bare kind does NOT when the map omits it; case and shape matter", () => {
    assert.equal(mappedKind("Note/AgentPolicy", VAULT_MAP), "policy");
    assert.equal(mappedKind("policy", VAULT_MAP), null, "the bare spelling is not in this vault's map");
    assert.equal(mappedKind("note/agentpolicy", VAULT_MAP), null, "a class path is an identifier — case-sensitive");
    assert.equal(mappedKind(["Note/AgentPolicy"], VAULT_MAP), null, "a list never matches");
    assert.equal(mappedKind(undefined, VAULT_MAP), null);
  });

  test("an unmapped type is skipped and reported ONCE per spelling with a count; an unrelated class is not counted", async () => {
    const src = sourceOf([
      { path: "P1.md", frontmatter: fm("Note/AgentPolicy"), body: "" },
      { path: "P2.md", frontmatter: fm("Note/AgentPolicy"), body: "" },
      { path: "P3.md", frontmatter: fm("Note/AgentPolicy"), body: "" },
      { path: "T.md", frontmatter: fm("Task/Decision"), body: "" },
      { path: "S.md", frontmatter: fm("Note/Skill"), body: "" },
    ]);
    const warnings = [];
    const notes = await collectNotes(src, F({ typeMap: { "Note/Skill": "skill" } }), warnings);
    assert.deepEqual(notes.map((n) => n.path), ["S.md"]);
    const unmappedLines = warnings.filter((w) => /does not name/.test(w));
    assert.equal(unmappedLines.length, 1, warnings.join("\n"));
    assert.match(unmappedLines[0], /3 note\(s\) carry type 'Note\/AgentPolicy'/);
    assert.ok(!warnings.some((w) => /Task\/Decision/.test(w)), "a class that is not agent/skill/policy/command-shaped is not a candidate");
  });
});

describe("inRoots — one boundary rule, the host's", () => {
  test("absent include roots read the whole vault; EMPTY include roots read nothing", () => {
    assert.equal(inRoots("Any/where.md", undefined), true);
    assert.equal(inRoots("Any/where.md", []), false);
  });

  test("segment boundary: `03 Agents/03.18 Claude Code agents` covers itself, not `03.180 …`; a trailing slash means exactly that folder", () => {
    const r = ["03 Agents/03.18 Claude Code agents"];
    assert.equal(inRoots("03 Agents/03.18 Claude Code agents/captain.md", r), true);
    assert.equal(inRoots("03 Agents/03.180 Other/x.md", r), false);
    assert.equal(inRoots("03 Agents/03.18 Claude Code agents (old)/x.md", r), true, "a space is a boundary — over-inclusion is the safe direction, as for territories");
    assert.equal(inRoots("03 Agents/03.18 Claude Code agents (old)/x.md", ["03 Agents/03.18 Claude Code agents/"]), false);
    // The cases a plain string-prefix match gets WRONG — the root is a character
    // prefix of the path, and the boundary rule is what says no (or yes).
    assert.equal(inRoots("03 Agents/03.180 Other/x.md", ["03 Agents/03.18"]), false, "a digit continues the name: 03.18 does not cover 03.180");
    assert.equal(inRoots("03 Agents/03.18 Claude Code agents/captain.md", ["03 Agents/03.18"]), true, "a space ends the name: 03.18 covers 03.18 Claude Code agents");
    assert.equal(inRoots("03 agents/03.18 claude code agents/captain.md", r), true, "case-insensitive, as territories are");
  });

  test("an exclude root wins over an include root", () => {
    assert.equal(inRoots("03 Agents/03.18 Claude Code agents/captain.md", ["03 Agents"], ["03 Agents/03.18 Claude Code agents"]), false);
    assert.equal(inRoots("03 Agents/03.01 Inbox/Agents/a.md", ["03 Agents"], ["03 Agents/03.18 Claude Code agents"]), true);
  });

  test("collectNotes reads only inside the roots — a typed note outside is neither compiled nor counted as unmapped", async () => {
    const src = sourceOf([
      { path: "In/A.md", frontmatter: fm("Person/Agent", { name: "a" }), body: "" },
      { path: "Out/B.md", frontmatter: fm("Person/Agent", { name: "b" }), body: "" },
      { path: "Out/C.md", frontmatter: fm("Note/Other"), body: "" },
    ]);
    const warnings = [];
    const notes = await collectNotes(src, F({ typeMap: VAULT_MAP, includeRoots: ["In"] }), warnings);
    assert.deepEqual(notes.map((n) => n.path), ["In/A.md"]);
    assert.equal(warnings.length, 0, warnings.join("\n"));
  });

  test("a parent OUTSIDE the roots is a broken edge reported as an error — the roots never silently sever the tree", async () => {
    // Obsidian resolves the wikilink whether or not the target was compiled, so
    // the compile sees a parent path it never read: that must be an error naming
    // the child, not an agent quietly re-hung on the synthesized root.
    const src = sourceOf([
      { path: "In/child.md", frontmatter: fm("Person/Agent", { name: "child", parent: "[[boss]]" }), body: "" },
      { path: "Out/boss.md", frontmatter: fm("Person/Agent", { name: "boss" }), body: "" },
    ]);
    const a = await analyzeVault(src, F({ typeMap: VAULT_MAP, includeRoots: ["In"] }));
    assert.ok(a.errors.some((e) => /^In\/child\.md: unresolved parent/.test(e)), a.errors.join("\n"));
    assert.ok(!a.tree.some((n) => n.name === "boss"), "the outside parent is not compiled");
  });
});

describe("mark writes the VAULT'S spelling", () => {
  test("spellingFor is the reverse map; markFrontmatter sets `type` to it", () => {
    assert.equal(spellingFor("policy", VAULT_MAP), "Note/AgentPolicy");
    assert.equal(spellingFor("command", VAULT_MAP), null);
    const r = markFrontmatter({ type: "policy" }, F({ typeMap: VAULT_MAP }));
    assert.equal(r.set.type, "Note/AgentPolicy");
  });

  test("a kind the map does not spell cannot be marked — refused, never guessed", () => {
    assert.throws(() => markFrontmatter({ type: "command" }, F({ typeMap: VAULT_MAP })), /names no vault spelling for 'command'/);
  });

  test("with no typeMap the kernel writes the bare kind, as before", () => {
    assert.equal(markFrontmatter({ type: "agent" }, F({})).set.type, "agent");
  });
});

describe("config coercion, the settings-tab line format, validation", () => {
  test("typeMapOf keeps only string→kind entries", () => {
    assert.deepEqual(typeMapOf({ "Note/AgentPolicy": "policy", " ": "agent", "X": "nope", "Y": 3 }), { "Note/AgentPolicy": "policy" });
    assert.deepEqual(typeMapOf("policy"), {}); assert.deepEqual(typeMapOf(["policy"]), {}); assert.deepEqual(typeMapOf(null), {});
  });

  test("parseTypeMapLines / typeMapLines round-trip, and report each bad line", () => {
    const text = "Note/AgentPolicy = policy\n  Person/Agent=agent \n\nbad line\nX = nope\n = skill";
    const { map, problems } = parseTypeMapLines(text);
    assert.deepEqual(map, { "Note/AgentPolicy": "policy", "Person/Agent": "agent" });
    assert.equal(problems.length, 3, problems.join("\n"));
    assert.deepEqual(parseTypeMapLines(typeMapLines(map)).map, map);
  });

  test("roots are resolved like territories: trimmed, blanks and non-strings dropped, leading slash stripped", () => {
    const c = skillsConfigOf({ includeRoots: [" /03 Agents ", "", null, 4], excludeRoots: ["./00.11 Templates/"] });
    assert.deepEqual(c.includeRoots, ["03 Agents"]);
    assert.deepEqual(c.excludeRoots, ["00.11 Templates/"]);
  });

  test("validateSkillsConfig names an empty map and empty roots as the reason nothing compiles, and each bad map entry", () => {
    const p0 = validateSkillsConfig({});
    assert.ok(p0.some((x) => /type map is EMPTY/.test(x)), p0.join("\n"));
    assert.ok(p0.some((x) => /include roots are EMPTY/.test(x)), p0.join("\n"));
    const p1 = validateSkillsConfig({ typeMap: { "A": "nope", " ": "agent", "B": "agent" }, includeRoots: ["X"] });
    assert.ok(p1.some((x) => /'A' → 'nope'/.test(x)));
    assert.ok(p1.some((x) => /blank vault type/.test(x)));
    assert.ok(!p1.some((x) => /type map is EMPTY/.test(x)), "one valid entry means the map is not empty");
    assert.ok(!p1.some((x) => /include roots are EMPTY/.test(x)));
    const p2 = validateSkillsConfig({ typeSource: "tags", includeRoots: ["X"] });
    assert.ok(!p2.some((x) => /type map is EMPTY/.test(x)), "tags mode does not use the map");
  });
});

describe("the switch — the test the fleet runs before retiring the ~/.claude/agents symlink", () => {
  const RANKS = ["captain", "commander", "lieutenant-commander", "lieutenant-commander-repository", "lieutenant", "lieutenant-repository"];
  const R = "03 Agents/03.18 Claude Code agents";
  // The names the compile read from the vault: every tree node except the
  // synthesized root (the one node with no parent when no note is `root: true`).
  const compiledNames = (a) => a.tree.filter((n) => n.parent !== null).map((n) => n.name).sort();
  const vault = sourceOf([
    { path: `${R}/03.18 Claude Code agents.md`, frontmatter: { type: "Collection", verified: [HUMAN] }, body: "folder note — no name, not an agent" },
    ...RANKS.map((r) => ({ path: `${R}/${r}.md`, frontmatter: fm("Person/Agent", { name: r, description: `the ${r}` }), body: `${r} duties` })),
    { path: `${R}/Promotion and demotion of sessions.md`, frontmatter: { type: "Note", verified: [HUMAN] }, body: "proposal, not an agent" },
    { path: "03 Agents/03.01 Inbox/Agents/sensitive-agent.md", frontmatter: fm("Person/Agent", { name: "sensitive-agent" }), body: "scope agent" },
    { path: "00 System management/00.11 Templates/Template, Person%2FAgent.md", frontmatter: fm("Person/Agent", { name: "template" }), body: "" },
  ]);

  test("include roots = [03.18] with `Person/Agent = agent` compiles EXACTLY the six ranks — nothing else in that folder, nothing outside it", async () => {
    const a = await analyzeVault(vault, F({ typeMap: { "Person/Agent": "agent" }, includeRoots: [R] }));
    // No rank note carries `root: true`, so the compiler synthesizes the root
    // agent ("vault", parent null) and hangs the six ranks under it: that is one
    // agent more than the ranks, and it is the ONLY extra one.
    assert.equal(a.counts.agents, RANKS.length + 1, JSON.stringify(a.counts));
    assert.deepEqual(compiledNames(a), [...RANKS].sort());
    assert.equal(a.errors.length, 0, a.errors.join("\n"));
  });

  test("before the switch: include roots = [03 Agents] with 03.18 EXCLUDED compiles the inbox agent and NOT the ranks (which Claude Code loads natively)", async () => {
    const a = await analyzeVault(vault, F({ typeMap: { "Person/Agent": "agent" }, includeRoots: ["03 Agents"], excludeRoots: [R] }));
    assert.deepEqual(compiledNames(a), ["sensitive-agent"]);
  });

  test("the template folder is never inside the roots the operator would name, so the template is not compiled", async () => {
    const a = await analyzeVault(vault, F({ typeMap: { "Person/Agent": "agent" }, includeRoots: ["03 Agents"] }));
    assert.ok(!a.tree.some((n) => n.name === "template"));
  });
});

describe("export-on-save honours the roots", () => {
  const deps = (path, includeRoots) => {
    let requested = 0;
    handleNoteChanged({ path }, {
      isEnabled: () => true,
      fields: () => F({ typeMap: VAULT_MAP, includeRoots }),
      getFrontmatter: () => fm("Note/AgentPolicy"),
      requestExport: () => { requested += 1; },
    });
    return requested;
  };
  test("a typed note INSIDE the roots requests an export; the same note OUTSIDE does not", () => {
    assert.equal(deps("In/P.md", ["In"]), 1);
    assert.equal(deps("Out/P.md", ["In"]), 0);
  });
});

describe("the #405 review's findings, pinned", () => {
  test("an export that compiled ZERO notes refuses before touching disk — the previous export survives a first run under the empty defaults", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultmcp-skills-404-"));
    try {
      const full = sourceOf([{ path: "In/A.md", frontmatter: fm("Person/Agent", { name: "a", description: "a" }), body: "" }]);
      const first = await runExport(full, { outputDir, pluginName: "t", fields: F({ typeMap: VAULT_MAP, includeRoots: ["In"] }) });
      assert.ok(first.errors.length === 0, first.errors.join("\n"));
      const before = fs.readdirSync(path.join(outputDir, "agents"));
      assert.ok(before.includes("a.md"), "the first export wrote the agent");
      // The upgrade case: shipped defaults, empty map and empty roots.
      await assert.rejects(
        () => runExport(full, { outputDir, pluginName: "t", fields: F({ typeMap: {}, includeRoots: [] }) }),
        (e) => /nothing to export/.test(e.message) && /include roots are EMPTY/.test(e.message) && /type map is EMPTY/.test(e.message) && /refusing rather than remove/.test(e.message),
      );
      assert.deepEqual(fs.readdirSync(path.join(outputDir, "agents")), before, "nothing was removed");
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true }); // an mkdtemp scratch dir of this test's own
    }
  });

  test("an EMPTY type map warns in frontmatter mode even when no spelling looks like a kind — silence is not an option", async () => {
    const src = sourceOf([{ path: "In/x.md", frontmatter: fm("Note/Doctrine"), body: "" }]);
    const warnings = [];
    await collectNotes(src, F({ typeMap: {}, includeRoots: ["In"] }), warnings);
    assert.ok(warnings.some((w) => /type map is EMPTY/.test(w)), warnings.join("\n"));
    const none = [];
    await collectNotes(src, F({ typeMap: {}, includeRoots: ["In"], typeSource: "tags" }), none);
    assert.ok(!none.some((w) => /type map is EMPTY/.test(w)), "tags mode does not use the map");
    const kernel = [];
    await collectNotes(src, F({ includeRoots: ["In"] }), kernel);
    assert.ok(!kernel.some((w) => /type map is EMPTY/.test(w)), "no map at all is the kernel's identity map, not an empty one");
  });

  test("a typed note renamed OUT of the roots (or into them) requests the export; a rename that stays outside does not", () => {
    const calls = [];
    const deps = {
      isEnabled: () => true,
      fields: () => F({ typeMap: VAULT_MAP, includeRoots: ["In"] }),
      getFrontmatter: () => fm("Person/Agent", { name: "a" }),
      requestExport: () => calls.push(1),
    };
    handleNoteRenamed({ path: "Out/a.md" }, "In/a.md", deps);
    assert.equal(calls.length, 1, "moved out: the compiled file must go");
    handleNoteRenamed({ path: "In/a.md" }, "Out/a.md", deps);
    assert.equal(calls.length, 2, "moved in: the note must be compiled");
    handleNoteRenamed({ path: "Elsewhere/a.md" }, "Out/a.md", deps);
    assert.equal(calls.length, 2, "outside to outside: nothing to do");
    handleNoteRenamed({ path: "Out/a.md" }, "In/a.md", { ...deps, getFrontmatter: () => undefined });
    assert.equal(calls.length, 3, "cache not ready yet but it LEFT the roots: export anyway, the safe direction");
    handleNoteRenamed({ path: "Out/a.md" }, "In/a.md", { ...deps, isEnabled: () => false });
    assert.equal(calls.length, 3, "export-on-save off: nothing");
  });

  test("spellingFor: when two vault spellings map to one kind, the FIRST in map order is what mark writes", () => {
    const map = { "Person/Agent": "agent", "Person/Agent/Legacy": "agent", "Note/Skill": "skill" };
    assert.equal(spellingFor("agent", map), "Person/Agent");
    assert.equal(spellingFor("skill", map), "Note/Skill");
    assert.equal(spellingFor("policy", map), null);
  });

  test("the GUI mark picker's agent list is the compile's view: inside the roots, mapped to agent, nothing else", () => {
    const notes = [
      { path: "In/a.md", frontmatter: fm("Person/Agent", { name: "a" }) },
      { path: "In/Skip/b.md", frontmatter: fm("Person/Agent", { name: "b" }) },
      { path: "Out/c.md", frontmatter: fm("Person/Agent", { name: "c" }) },
      { path: "In/d.md", frontmatter: fm("Note/Skill", { name: "d" }) },
      { path: "In/e.md", frontmatter: fm("agent", { name: "e" }) },
      { path: "In/f.md", frontmatter: null },
    ];
    assert.deepEqual(agentCandidates(notes, F({ typeMap: VAULT_MAP, includeRoots: ["In"], excludeRoots: ["In/Skip"] })), ["In/a.md"]);
    assert.deepEqual(agentCandidates(notes, F({ typeMap: VAULT_MAP, includeRoots: [] })), [], "empty roots: no candidate");
    assert.deepEqual(agentCandidates(notes, F({})), ["In/e.md"], "the kernel's identity map: the bare spelling only");
  });

  test("a mistyped type-map line is a problem the tab must show, not a line it drops", () => {
    const field = SKILLS_FIELDS.find((f) => f.key === "typeMap");
    const bad = textAreaValue(field, "Person/Agent = agent\nNote/AgentPolicy = polciy");
    assert.equal(bad.problems.length, 1, bad.problems.join("\n"));
    assert.ok(/polciy/.test(bad.problems[0]));
    const good = textAreaValue(field, "Person/Agent = agent\n\n  Note/AgentPolicy = policy  ");
    assert.deepEqual(good, { value: { "Person/Agent": "agent", "Note/AgentPolicy": "policy" }, problems: [] });
    const roots = textAreaValue(SKILLS_FIELDS.find((f) => f.key === "includeRoots"), " A \n\nB/C\n");
    assert.deepEqual(roots, { value: ["A", "B/C"], problems: [] });
  });
});

describe("THE ACCEPTANCE GATE — nothing unaccepted reaches a compiled agent prompt (01.41 rule 8; 01.61 rule 11 as strict exclusion, ruled 2026-09-27)", () => {
  const MAP = { "Person/Agent": "agent", "Note/AgentPolicy": "policy", "Note/Skill": "skill" };
  const vault = sourceOf([
    { path: "In/boss.md", frontmatter: fm("Person/Agent", { name: "boss", description: "d" }), body: "verified by a human" },
    { path: "In/draft.md", frontmatter: unverified("Person/Agent", { name: "draft", description: "d" }), body: "no verified key at all" },
    { path: "In/machine.md", frontmatter: unverified("Person/Agent", { name: "machine", description: "d", verified: [{ by: "vault-mcp/0.19.0", at: "x" }] }), body: "machine-checked only" },
    { path: "In/blank.md", frontmatter: unverified("Note/Skill", { name: "blank", verified: [] }), body: "a blank verified — the shape rule 2a refuses" },
    { path: "In/policy.md", frontmatter: unverified("Note/AgentPolicy", { name: "pol", parent: "[[boss]]" }), body: "an unratified policy" },
    { path: "In/skill.md", frontmatter: fm("Note/Skill", { name: "ok-skill", parent: "[[boss]]" }), body: "verified skill" },
  ]);
  const F2 = F({ typeMap: MAP, includeRoots: ["In"] });

  test("only the human-verified notes compile; the four others are excluded, counted per kind, named, and never in the tree", async () => {
    const a = await analyzeVault(vault, F2);
    assert.deepEqual(a.tree.filter((n) => n.parent !== null).map((n) => n.name).sort(), ["boss", "ok-skill"]);
    assert.deepEqual(a.excluded, { total: 4, byKind: { skill: 1, agent: 2, policy: 1, command: 0 }, paths: ["In/draft.md", "In/machine.md", "In/blank.md", "In/policy.md"], transclusions: [] });
    assert.equal(a.counts.policies, 0, "an unratified policy is not injected anywhere");
    const line = a.warnings.find((w) => /excluded from the compile/.test(w));
    assert.ok(line, a.warnings.join("\n"));
    assert.match(line, /4 typed note\(s\) excluded/);
    assert.match(line, /nothing unaccepted reaches a compiled agent prompt/);
    assert.doesNotMatch(line, /\b0\d\.\d\d rule \d/, "no spec rule number in the operator-facing text");
    assert.match(line, /2 agent, 1 policy/);
    assert.match(line, /In\/draft\.md/);
  });

  test("the export report carries the excluded count, and the excluded notes are not written", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultmcp-skills-gate-"));
    try {
      const r = await runExport(vault, { outputDir, pluginName: "t", fields: F2 });
      assert.equal(r.excluded.total, 4);
      assert.deepEqual(r.excluded.byKind, { skill: 1, agent: 2, policy: 1, command: 0 });
      const agents = fs.readdirSync(path.join(outputDir, "agents"));
      assert.ok(agents.includes("boss.md"));
      assert.ok(!agents.includes("draft.md") && !agents.includes("machine.md"), agents.join(","));
      assert.ok(!fs.readFileSync(path.join(outputDir, "agents", "boss.md"), "utf8").includes("unratified policy"), "the unratified policy's text reaches no prompt");
      assert.ok(r.warnings.some((w) => /excluded from the compile/.test(w)));
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("the preview reports the same excluded record as the analysis", async () => {
    const { previewVault } = await import("../src/kernel/exporter.ts");
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultmcp-skills-gate-p-"));
    try {
      const p = await previewVault(vault, { outputDir, pluginName: "t", fields: F2 });
      assert.deepEqual(p.excluded.total, 4);
      assert.ok(!p.entries.some((e) => /draft|machine|blank|\/pol\b/.test(e.relOut)), p.entries.map((e) => e.relOut).join(","));
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("the gate is the kernel's, not the plugin's: the identity map and bare kinds are gated the same", async () => {
    const src = sourceOf([
      { path: "s.md", frontmatter: { type: "skill", name: "s" }, body: "" },
      { path: "v.md", frontmatter: { type: "skill", name: "v", verified: [HUMAN] }, body: "" },
    ]);
    const a = await analyzeVault(src, F({}));
    assert.deepEqual(a.tree.filter((n) => n.parent !== null).map((n) => n.name), ["v"]);
    assert.deepEqual(a.excluded.paths, ["s.md"]);
  });

  test("the switch: the six ranks compile only once each carries a human verified entry; one unverified rank is excluded, named, and the other five compile", async () => {
    const RANKS = ["captain", "commander", "lieutenant-commander", "lieutenant-commander-repository", "lieutenant", "lieutenant-repository"];
    const R = "03 Agents/03.18 Claude Code agents";
    const notes = RANKS.map((r) => ({ path: `${R}/${r}.md`, frontmatter: r === "lieutenant" ? unverified("Person/Agent", { name: r, description: r }) : fm("Person/Agent", { name: r, description: r }), body: r }));
    const a = await analyzeVault(sourceOf(notes), F({ typeMap: { "Person/Agent": "agent" }, includeRoots: [R] }));
    assert.deepEqual(a.tree.filter((n) => n.parent !== null).map((n) => n.name).sort(), RANKS.filter((r) => r !== "lieutenant").sort());
    assert.deepEqual(a.excluded, { total: 1, byKind: { skill: 0, agent: 1, policy: 0, command: 0 }, paths: [`${R}/lieutenant.md`], transclusions: [] });
  });
});

describe("THE ACCEPTANCE GATE ON EMBEDS — an accepted note cannot carry an unaccepted note's text into a prompt", () => {
  const raw = (fm, body) => `---\n${fm}\n---\n${body}`;
  const HUMAN_YAML = "verified:\n  - by: human:nelson\n    at: 2026-09-25T05:08:39-04:00";
  const files = {
    "In/host.md": raw(`type: Note/Skill\nname: host\n${HUMAN_YAML}`, "HOST-START ![[secret]] HOST-MID ![[fine]] HOST-END"),
    "In/secret.md": raw("type: Note", "UNRATIFIED-SECRET-TEXT"),
    "In/fine.md": raw(`type: Note\n${HUMAN_YAML}`, "ACCEPTED-EMBED-TEXT ![[deeper]]"),
    "In/deeper.md": raw("type: Note\nverified: []", "DEEPER-UNACCEPTED-TEXT"),
    "In/pol.md": raw("type: Note/AgentPolicy\nname: pol\nparent: \"[[boss]]\"", "UNRATIFIED-POLICY-TEXT"),
    "In/boss.md": raw(`type: Person/Agent\nname: boss\ndescription: d\n${HUMAN_YAML}`, "BOSS ![[pol]] END"),
  };
  const fmOf = (text) => { const m = /^---\n([\s\S]*?)\n---/.exec(text); const out = {}; if (!m) return out; for (const line of m[1].split("\n")) { const mm = /^(\w[\w\/]*):\s*(.*)$/.exec(line); if (mm && mm[2] !== "") out[mm[1]] = mm[2].replace(/^"|"$/g, ""); else if (mm) out[mm[1]] = []; } if (/by: human:/.test(m[1])) out.verified = [{ by: "human:nelson", at: "2026-09-25T05:08:39-04:00" }]; return out; };
  const src = {
    notes: async () => Object.entries(files).map(([path, text]) => ({ path, frontmatter: fmOf(text), body: text })),
    resolveLink: (lp) => Object.keys(files).find((p) => p.endsWith(`/${lp}.md`)) ?? null,
    embed: async (lp) => { const p = Object.keys(files).find((q) => q.endsWith(`/${lp}.md`)); return p ? { path: p, content: files[p] } : null; },
    basePath: () => null,
  };
  const F3 = F({ typeMap: { "Note/Skill": "skill", "Person/Agent": "agent", "Note/AgentPolicy": "policy" }, includeRoots: ["In"] });

  test("acceptedEmbed over raw text (no cache): a human entry is accepted; blank, absent, machine-only or unparseable frontmatter is not", () => {
    const raw = (content) => ({ content });
    assert.equal(acceptedEmbed(raw(files["In/fine.md"])), true);
    assert.equal(acceptedEmbed(raw(files["In/secret.md"])), false);
    assert.equal(acceptedEmbed(raw(files["In/deeper.md"])), false);
    assert.equal(acceptedEmbed(raw("---\nverified:\n  - by: vault-mcp/0.19.0\n    at: 2026-09-25T05:08:39-04:00\n---\nbody")), false, "a machine actor is not a human one");
    assert.equal(acceptedEmbed(raw("---\nverified: &a\n---\nbody")), false, "unparseable fails closed");
    assert.equal(acceptedEmbed(raw("no frontmatter at all")), false);
  });

  test("acceptedEmbed prefers the CACHE's frontmatter when the lookup supplies it — the same reader as the note gate, so one note gets one answer", () => {
    assert.equal(acceptedEmbed({ content: "no frontmatter in the bytes", frontmatter: { verified: [HUMAN] } }), true, "the cache says accepted");
    assert.equal(acceptedEmbed({ content: files["In/fine.md"], frontmatter: null }), false, "the cache holds no frontmatter (as for a note the note gate never compiles), whatever the bytes say");
    assert.equal(acceptedEmbed({ content: files["In/fine.md"], frontmatter: { verified: [{ by: "vault-mcp/0.19.0" }] } }), false, "machine-only in the cache");
  });

  test("the shipped embed lookup carries the cache's frontmatter (source pin on tools.ts)", () => {
    const tools = fs.readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");
    assert.match(tools, /return \{ path: dest\.path, content: await app\.vault\.cachedRead\(dest\), frontmatter: app\.metadataCache\.getFileCache\(dest\)\?\.frontmatter \?\? null \};/);
  });

  test("an unaccepted embed is NOT inlined at any depth: a marker stands in its place, the path is recorded and named, the accepted embed still inlines", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultmcp-skills-embed-"));
    try {
      const r = await runExport(src, { outputDir, pluginName: "t", fields: F3 });
      const skill = fs.readFileSync(path.join(outputDir, "skills", "host", "SKILL.md"), "utf8");
      assert.ok(skill.includes("HOST-START") && skill.includes("HOST-END"), "the accepted host compiles");
      assert.ok(!skill.includes("UNRATIFIED-SECRET-TEXT"), "the unaccepted embed's text reaches no prompt");
      assert.ok(skill.includes(transclusionRefused("In/secret.md")), "a marker names what was refused");
      assert.equal(transclusionRefused("In/secret.md"), "<!-- transclusion refused: In/secret.md is not accepted -->");
      assert.ok(skill.includes("ACCEPTED-EMBED-TEXT"), "an accepted embed still inlines");
      assert.ok(!skill.includes("DEEPER-UNACCEPTED-TEXT"), "gated at every depth");
      const agent = fs.readFileSync(path.join(outputDir, "agents", "boss.md"), "utf8");
      assert.ok(!agent.includes("UNRATIFIED-POLICY-TEXT"), "an excluded policy embedded by an accepted agent does not ship either");
      assert.deepEqual(r.excluded.transclusions.sort(), ["In/deeper.md", "In/pol.md", "In/secret.md"]);
      assert.deepEqual(r.excluded.paths, ["In/pol.md"], "the policy is excluded as a note too");
      assert.ok(r.sources.includes("In/secret.md"), "a refused embed is still an export source: accepting it later re-runs the export");
      const line = r.warnings.find((w) => /embedded note\(s\) refused/.test(w));
      assert.match(line ?? "", /3 embedded note\(s\) refused/);
      assert.ok(r.warnings.some((w) => /transclusion !\[\[secret\]\] refused — In\/secret\.md is not accepted/.test(w)));
      for (const w of r.warnings) assert.doesNotMatch(w, /\b0\d\.\d\d rule \d/, `no spec rule number in a warning: ${w}`);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("refused embeds alone (no typed note excluded) still warn, count and mark — the realistic case: an accepted agent embedding plain unverified notes", async () => {
    const only = {
      "In/host.md": raw(`type: Note/Skill\nname: host\n${HUMAN_YAML}`, "A ![[plain]] B ![[plain]] C ![[machine]] D"),
      "In/plain.md": raw("type: Note", "PLAIN-UNVERIFIED-TEXT"),
      "In/machine.md": raw("type: Note\nverified:\n  - by: vault-mcp/0.19.0\n    at: 2026-09-25T05:08:39-04:00", "MACHINE-ONLY-TEXT"),
    };
    const s2 = { ...src, notes: async () => Object.entries(only).map(([path, text]) => ({ path, frontmatter: fmOf(text), body: text })), resolveLink: (lp) => Object.keys(only).find((p) => p.endsWith(`/${lp}.md`)) ?? null, embed: async (lp) => { const p = Object.keys(only).find((q) => q.endsWith(`/${lp}.md`)); return p ? { path: p, content: only[p] } : null; } };
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultmcp-skills-embed-only-"));
    let a, body;
    try {
      a = await runExport(s2, { outputDir, pluginName: "t", fields: F({ typeMap: { "Note/Skill": "skill" }, includeRoots: ["In"] }) });
      body = fs.readFileSync(path.join(outputDir, "skills", "host", "SKILL.md"), "utf8");
    } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
    assert.equal(a.excluded.total, 0, "no typed note was excluded");
    assert.deepEqual(a.excluded.transclusions.sort(), ["In/machine.md", "In/plain.md"], "distinct notes: plain, embedded twice, counts once; a machine-only verification is not acceptance");
    const line = a.warnings.find((w) => /embedded note\(s\) refused/.test(w));
    assert.match(line ?? "", /^2 embedded note\(s\) refused/, "the warning is emitted with no excluded notes at all");
    assert.doesNotMatch(line ?? "", /excluded from the compile/);
    assert.ok(!/PLAIN-UNVERIFIED-TEXT|MACHINE-ONLY-TEXT/.test(body));
    assert.equal((body.match(/transclusion refused: In\/plain\.md/g) ?? []).length, 2, "one marker per embed occurrence");
  });

  test("the refused marker escapes a path containing '-->' like the file's other markers do, so it stays one inert comment", async () => {
    const tricky = {
      "In/host.md": raw(`type: Note/Skill\nname: host\n${HUMAN_YAML}`, "X ![[a --> b]] Y"),
      "In/a --> b.md": raw("type: Note", "TRICKY-TEXT"),
    };
    const s3 = { ...src, notes: async () => Object.entries(tricky).map(([path, text]) => ({ path, frontmatter: fmOf(text), body: text })), resolveLink: (lp) => Object.keys(tricky).find((p) => p.endsWith(`/${lp}.md`)) ?? null, embed: async (lp) => { const p = Object.keys(tricky).find((q) => q.endsWith(`/${lp}.md`)); return p ? { path: p, content: tricky[p] } : null; } };
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultmcp-skills-embed-tricky-"));
    let body;
    try {
      await runExport(s3, { outputDir, pluginName: "t", fields: F({ typeMap: { "Note/Skill": "skill" }, includeRoots: ["In"] }) });
      body = fs.readFileSync(path.join(outputDir, "skills", "host", "SKILL.md"), "utf8");
    } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
    assert.ok(body.includes("<!-- transclusion refused: In/a --› b.md is not accepted -->"), body);
    assert.ok(!body.includes("In/a --> b.md"), "the raw sequence never reaches the artifact");
    assert.ok(!body.includes("TRICKY-TEXT"));
  });

  test("the analysis and the preview carry the same refused-embed record", async () => {
    const a = await analyzeVault(src, F3);
    assert.deepEqual(a.excluded.transclusions.sort(), ["In/deeper.md", "In/pol.md", "In/secret.md"]);
    const { previewVault } = await import("../src/kernel/exporter.ts");
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultmcp-skills-embed-p-"));
    try {
      const p = await previewVault(src, { outputDir, pluginName: "t", fields: F3 });
      assert.deepEqual(p.excluded.transclusions.sort(), ["In/deeper.md", "In/pol.md", "In/secret.md"]);
    } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
  });

  test("the warning line truncates after eight paths and says how many more", async () => {
    const many = sourceOf(Array.from({ length: 11 }, (_, i) => ({ path: `In/u${i}.md`, frontmatter: unverified("Note/Skill", { name: `u${i}` }), body: "" })));
    const a = await analyzeVault(many, F({ typeMap: { "Note/Skill": "skill" }, includeRoots: ["In"] }));
    const line = a.warnings.find((w) => /excluded from the compile/.test(w));
    assert.match(line, /11 typed note\(s\) excluded/);
    assert.match(line, /In\/u7\.md, … 3 more/);
    assert.doesNotMatch(line, /In\/u8\.md/);
  });

  test("there is NO switch: the gate in collectNotes is an unconditional `if` on the raw frontmatter, and no detect-config key names a gate", () => {
    const exporter = fs.readFileSync(new URL("../src/kernel/exporter.ts", import.meta.url), "utf8");
    assert.match(exporter, /\n    if \(!hasHumanVerification\(fm\)\) \{\n      excludedHere\.push\(\{ path: note\.path, kind \}\);\n      continue;\n    \}/, "the gate, unconditional, on `fm` (the raw frontmatter, not the namespaced view)");
    const detect = exporter.slice(exporter.indexOf("export interface DetectConfig"), exporter.indexOf("}", exporter.indexOf("export interface DetectConfig")));
    assert.doesNotMatch(detect, /gate|accept|verif/i, "no config key can turn the gate off");
    assert.match(exporter, /resolveTransclusions\(body, from, src\.embed, warnings, sources, gate\)/, "and the embed gate is threaded into every transclusion");
  });

  test("the operator-facing lines carry the count (source pins: the pane's report line, the export and release notices)", () => {
    const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.match(read("../src/pane.ts"), /\$\{r\.excluded\.total\} not accepted \(excluded\)/, "the preview pane's header");
    assert.match(read("../src/pane.ts"), /\$\{r\.excluded\.transclusions\.length\} embedded note\(s\) refused/, "… and its embed count");
    assert.match(read("../src/wiring.ts"), /\$\{summary\.excluded\.total\} not accepted \(excluded\)/, "the export notice");
    assert.match(read("../src/wiring.ts"), /\$\{summary\.excluded\.transclusions\.length\} embedded note\(s\) refused/, "… and its embed count");
    assert.match(read("../src/commands.ts"), /\$\{summary\.excluded\.total\} not accepted \(excluded\)/, "the release notice");
    assert.match(read("../src/commands.ts"), /\$\{summary\.excluded\.transclusions\.length\} embedded note\(s\) refused/, "… and its embed count");
    assert.match(read("../src/pane.ts"), /sources \(inlined, or refused as not accepted\): /, "the detail panel does not call a refused source 'transcluded'");
    assert.match(read("../src/commands.ts"), /\$\{a\.excluded\.total\} not accepted \(excluded\)/, "the validate report");
  });
});
