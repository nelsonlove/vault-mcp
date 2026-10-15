/**
 * vocab-scope-tags.test.mjs — the scope-tags VocabularyProvider over the live
 * tag model (vault spec 01.13 rules 2, 5a, 5c, 6 and 6a; 01.21 rule 3; #551):
 *
 *   • declaration — the first table under `## Tags` in a scope note's BODY;
 *     exact rows, and `head/*` family rows that admit the children but not
 *     the bare head
 *   • existence — a tag exists iff some row declares it
 *   • placement — union of the tables walking the folder chain to the root
 *     scope note (`00 System management`, the folder note of category 00),
 *     whose table joins every chain, outside 00-09 too
 *   • the switch — no root scope note ⇒ no scoping, reported loudly
 *   • the whole-vault rule pack (NOT a tool): tag_unregistered,
 *     tag_out_of_scope, tag_declared_twice_on_chain,
 *     tag_declared_on_two_branches, scope_root_missing
 *   • provider validation through VocabRegistry (good/bad config)
 *
 * The tool-layer half (bodies reaching the provider through the satellite's
 * listing) lives in `packages/vocab/tests/vocab-module.test.mjs`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  scopeTagsProvider,
  scopeTagsFindings,
  validateScopeTagsConfig,
  resolveScopeTagsConfig,
  parseTagsTable,
  isScopeTagsSource,
  DEFAULT_SCOPE_TAGS_CONFIG,
} from "../src/vocab/scope-tags.ts";
import { noteVocabFindings } from "../src/vocab/findings.ts";
import { VocabAmbiguousError } from "../src/vocab/provider.ts";
import { VocabRegistry } from "../src/vocab/registry.ts";

// ── fixture: mirrors the live vault's shapes (2026-10-14) ────────────────────

const ROOT = "00-09 System/00 System management/00 System management.md";
const AREA = "00-09 System/00-09 System.md";
const CAT = "00-09 System/01 System architecture/01 System architecture.md";
const BAND = "00-09 System/01 System architecture/01.20 Band/01.20 Band.md";
const IN_CAT_NOTE = "00-09 System/01 System architecture/cat.md";

/** A scope note's raw file, frontmatter included, as `cachedRead` returns it. */
const scopeFile = (rows, { title = "x", heading = "Tags", prose = "" } = {}) =>
  `---\ntitle: ${title}\ntype: Meta/Scope/Category\n---\n\n# ${title}\n\n${prose}## ${heading}\n\n` +
  "| Tag | Description |\n| --- | --- |\n" +
  rows.map(([t, d]) => `| \`${t}\` | ${d} |`).join("\n") +
  "\n\n## Next\n\n| not | a tag |\n| --- | --- |\n| `ghost` | after the section |\n";

const scope = (path, rows, opts) => ({ path, frontmatter: null, body: scopeFile(rows, opts) });

function fixture({ withRoot = true } = {}) {
  return [
    ...(withRoot
      ? [
          scope(ROOT, [
            ["note/*", "What kind of thing is this single note?"],
            ["note/task", "Actionable work."],
            ["agent/*", "Agent material."],
            ["person", "A note about one person."],
            ["person/*", "A person, by role."],
            ["meta", "A self-describing entry."],
          ]),
        ]
      : []),
    scope(AREA, [["github/*", "A note synced from a GitHub issue."]]),
    scope(CAT, [["spec", "A spec note."]]),
    scope(BAND, [["spec/rule", "One rule of a spec."]]),
  ];
}

const provider = (extra = [], opts = {}) => scopeTagsProvider(DEFAULT_SCOPE_TAGS_CONFIG, [...fixture(opts), ...extra]);
const noteAt = (path, tags) => ({ path, frontmatter: { tags } });

// ── the table parser ─────────────────────────────────────────────────────────

describe("parseTagsTable", () => {
  test("reads the first table under ## Tags: backticks and # stripped, header and separator skipped", () => {
    const body = "## Tags\n\nintro prose\n\n| Tag | Description |\n| --- | --- |\n| `#note/task` | Actionable work. |\n| `agent/*` | Agent material. |\n";
    assert.deepEqual(parseTagsTable(body), [
      { tag: "note/task", description: "Actionable work." },
      { tag: "agent/*", description: "Agent material." },
    ]);
  });

  test("the section ends at the next H2; a table there is not read", () => {
    assert.deepEqual(parseTagsTable(scopeFile([["a", "A."]])).map((r) => r.tag), ["a"]);
  });

  test("a leading frontmatter block is stripped, so `## Tags` inside YAML is not a section", () => {
    const raw = "---\nnote: |\n  ## Tags\n  | `fake` | x |\n---\n\nno section here\n";
    assert.deepEqual(parseTagsTable(raw), []);
  });

  test("fenced code before the table is skipped; no section → no rows; an empty table → no rows", () => {
    const fenced = "## Tags\n\n```\n| `inside` | fence |\n```\n\n| Tag | Description |\n| --- | --- |\n| `real` | R. |\n";
    assert.deepEqual(parseTagsTable(fenced).map((r) => r.tag), ["real"]);
    assert.deepEqual(parseTagsTable("# Title\n\nprose\n"), []);
    assert.deepEqual(parseTagsTable("## Tags\n\n| Tag | Description |\n| --- | --- |\n"), []);
  });

  test("an empty tag cell is no row; a custom heading is honoured; CRLF parses", () => {
    const body = "## Etiketten\r\n\r\n| Tag | D |\r\n| --- | --- |\r\n|  | blank |\r\n| `x` | X. |\r\n";
    assert.deepEqual(parseTagsTable(body, "Etiketten"), [{ tag: "x", description: "X." }]);
    assert.deepEqual(parseTagsTable(body), []);
  });

  test("the live root table's shape parses (an excerpt of 00 System management, 2026-10-14)", () => {
    const live =
      "## Tags\n\n\nThis note is the root scope note ([[01.21 Scopes & scope notes#3. The root scope is the switch|01.21 rule 3]] as amended 2026-10-14), so its table declares the tag families every note in the vault may carry.\n\n" +
      "| Tag | Description |\n| --- | --- |\n" +
      "| `meta` | A self-describing entry of the vault (the older `meta` label family). |\n" +
      "| `note/*` | What kind of thing is this single note? Assigned to an individual note, whatever folder it is in. |\n" +
      "| `for-agent/revise` | The note is under revision: it mirrors an open `[!revise]` callout directly under the note's H1 (01.17 rule 11b). |\n" +
      "\n### Allowed here\n\n```meta-bind-js-view\n---\nconst x = 1;\n```\n";
    const rows = parseTagsTable(live);
    assert.deepEqual(rows.map((r) => r.tag), ["meta", "note/*", "for-agent/revise"]);
    assert.match(rows[0].description, /older `meta` label family/);
  });
});

// ── config ───────────────────────────────────────────────────────────────────

describe("validateScopeTagsConfig / resolveScopeTagsConfig", () => {
  test("undefined and empty configs are valid; the retired #251 keys are ignored, not refused", () => {
    assert.deepEqual(validateScopeTagsConfig(undefined), []);
    assert.deepEqual(validateScopeTagsConfig({}), []);
    assert.deepEqual(validateScopeTagsConfig({ registryClass: "Meta/Tag", allowedTagsKey: "allowedTags", rootNote: "Root.md", tagsHeading: "Tags" }), []);
  });

  test("non-object, wrong-typed, and empty-heading values are problems", () => {
    assert.match(validateScopeTagsConfig("x")[0], /object/);
    assert.match(validateScopeTagsConfig([])[0], /object/);
    assert.match(validateScopeTagsConfig({ tagsHeading: " " })[0], /tagsHeading/);
    assert.match(validateScopeTagsConfig({ rootNote: 3 })[0], /rootNote/);
  });

  test('rootNote "" is valid — it means "no root scope note"', () => {
    assert.deepEqual(validateScopeTagsConfig({ rootNote: "" }), []);
    assert.equal(resolveScopeTagsConfig({ rootNote: "" }).rootNote, "");
  });

  test("the defaults are the live shapes; overrides merge over them", () => {
    assert.deepEqual(DEFAULT_SCOPE_TAGS_CONFIG, { rootNote: ROOT, tagsHeading: "Tags" });
    assert.deepEqual(resolveScopeTagsConfig({ tagsHeading: "Etiketten" }), { rootNote: ROOT, tagsHeading: "Etiketten" });
  });

  test("isScopeTagsSource: folder notes and the root note, nothing else", () => {
    assert.equal(isScopeTagsSource(CAT, ROOT), true);
    assert.equal(isScopeTagsSource(ROOT, ROOT), true);
    assert.equal(isScopeTagsSource("Root.md", "Root.md"), true);
    assert.equal(isScopeTagsSource("00-09 System/01 System architecture/loose.md", ROOT), false);
    assert.equal(isScopeTagsSource("loose.md", ROOT), false);
  });
});

describe("VocabRegistry wiring", () => {
  test("a scope-tags row with good config builds an instance", () => {
    const reg = new VocabRegistry([{ id: "st", provider: "scope-tags", root: "" }]);
    const [inst] = reg.build(fixture());
    assert.equal(inst.providerName, "scope-tags");
    assert.equal(inst.provider.resolve("note/task", "tag").canonical, "note/task");
    assert.deepEqual(reg.problems, []);
  });

  test("a scope-tags row with bad config is skipped and reported, never thrown", () => {
    const reg = new VocabRegistry([
      { id: "bad", provider: "scope-tags", root: "", config: { tagsHeading: 42 } },
      { id: "st", provider: "scope-tags", root: "" },
    ]);
    assert.equal(reg.build(fixture()).length, 1);
    assert.equal(reg.problems.length, 1);
    assert.match(reg.problems[0], /bad/);
    assert.match(reg.problems[0], /tagsHeading/);
    assert.match(reg.problems[0], /skipped/);
  });

  test("config overrides flow through: a custom root note and heading", () => {
    const reg = new VocabRegistry([{ id: "st", provider: "scope-tags", root: "", config: { rootNote: "Root.md", tagsHeading: "Etiketten" } }]);
    const [inst] = reg.build([{ path: "Root.md", body: scopeFile([["meta", "M."]], { heading: "Etiketten" }) }]);
    assert.equal(inst.provider.resolve("meta", "tag").canonical, "meta");
    assert.deepEqual(inst.provider.validateToken("other", "tag").map((f) => f.code), ["tag_unregistered"]);
  });

  test("the root confines the instance's listing — the root note outside it switches scoping off, loudly", () => {
    const reg = new VocabRegistry([{ id: "st", provider: "scope-tags", root: "00-09 System/01 System architecture" }]);
    const [inst] = reg.build(fixture());
    assert.equal(inst.provider.resolve("spec", "tag").canonical, "spec");
    assert.equal(inst.provider.resolve("note/task", "tag"), null);
    assert.deepEqual(inst.provider.validateToken("anything", "tag"), []);
    assert.deepEqual(inst.provider.registryFindings().map((f) => f.code), ["scope_root_missing"]);
  });
});

// ── existence and resolution ─────────────────────────────────────────────────

describe("existence", () => {
  test("an exact row resolves to its entry: gloss, hierarchy, declaring note", () => {
    const e = provider().resolve("note/task", "tag");
    assert.equal(e.canonical, "note/task");
    assert.equal(e.path, ROOT);
    assert.equal(e.definition, "Actionable work.");
    assert.equal(e.parent, "note");
    assert.equal(e.deprecated, false);
  });

  test("a family row declares every child: the entry is the token's, with the family row's path and gloss", () => {
    const e = provider().resolve("note/clipping/web", "tag");
    assert.equal(e.canonical, "note/clipping/web");
    assert.equal(e.path, ROOT);
    assert.equal(e.definition, "What kind of thing is this single note?");
    assert.equal(e.parent, "note/clipping");
    assert.deepEqual(provider().validateToken("agent/log", "tag"), []);
  });

  test("a family row does NOT declare the bare head (01.13 rule 5c)", () => {
    const p = provider();
    assert.equal(p.resolve("note", "tag"), null);
    assert.equal(p.validateToken("note", "tag")[0].code, "tag_unregistered");
  });

  test("an exact row is exact — no subtree: `meta` declares `meta`, not `meta/tag`", () => {
    const p = provider();
    assert.deepEqual(p.validateToken("meta", "tag"), []);
    assert.equal(p.validateToken("meta/tag", "tag")[0].code, "tag_unregistered");
    assert.equal(p.validateToken("spec/other", "tag")[0].code, "tag_unregistered");
  });

  test("an exact row wins over its family row; `person` and `person/*` coexist", () => {
    const p = provider();
    assert.equal(p.resolve("note/task", "tag").definition, "Actionable work.");
    assert.equal(p.resolve("person", "tag").definition, "A note about one person.");
    assert.equal(p.resolve("person/student", "tag").definition, "A person, by role.");
  });

  test("normalization strips # and whitespace", () => {
    const p = provider();
    assert.equal(p.resolve(" #note/task ", "tag").canonical, "note/task");
    assert.deepEqual(p.validateToken("#meta", "tag"), []);
  });

  test("one token on two branches with two descriptions refuses resolution; with one description it resolves", () => {
    const other = (d) => scope("10-19 Personal/10-19 Personal.md", [["spec", d]]);
    assert.throws(() => provider([other("Another sense.")]).resolve("spec", "tag"), VocabAmbiguousError);
    assert.equal(provider([other("A spec note.")]).resolve("spec", "tag").definition, "A spec note.");
  });

  test("a table on a non-folder-note declares nothing", () => {
    const p = provider([scope("00-09 System/01 System architecture/stray.md", [["stray", "S."]])]);
    assert.equal(p.resolve("stray", "tag"), null);
  });

  test("list is sorted, carries the family rows as written, and is scope-filterable by declaring path", () => {
    const p = provider();
    const all = p.list("tag").map((e) => e.canonical);
    assert.deepEqual(all, [...all].sort());
    assert.ok(all.includes("note/*"));
    assert.ok(all.includes("spec/rule"));
    assert.equal(all.length, 9);
    assert.deepEqual(p.list("tag", "Nowhere"), []);
    assert.deepEqual(p.list("tag", "00-09 System/01 System architecture").map((e) => e.canonical), ["spec", "spec/rule"]);
  });

  test("only kind 'tag' is served, with no deprecations (a table row has no retired flag)", () => {
    const p = provider();
    assert.deepEqual(p.kinds, ["tag"]);
    assert.equal(p.capabilities.deprecations, false);
    assert.deepEqual(p.validateToken("anything", "property"), []);
    assert.equal(p.resolve("meta", "type"), null);
    assert.deepEqual(p.list("term"), []);
  });
});

// ── placement: the chain union ───────────────────────────────────────────────

const placement = (path, tags, extra = [], opts = {}) =>
  provider(extra, opts).noteFindings(noteAt(path, tags)).filter((f) => f.code === "tag_out_of_scope");

describe("chain-union placement", () => {
  const IN_BAND = "00-09 System/01 System architecture/01.20 Band/deep/note.md";
  const IN_CAT = "00-09 System/01 System architecture/cat.md";

  test("a band-level note unions band + category + area + root", () => {
    assert.deepEqual(placement(IN_BAND, ["spec/rule", "spec", "github/sync", "note/task", "person"]), []);
  });

  test("a category-level note does not inherit the band's row", () => {
    const out = placement(IN_CAT, ["spec/rule"]);
    assert.equal(out.length, 1);
    assert.equal(out[0].token, "spec/rule");
    assert.equal(out[0].path, IN_CAT);
    assert.match(out[0].detail, /declared at .*01\.20 Band\.md/);
    assert.match(out[0].detail, /01 System architecture\.md/);
  });

  test("the root's table joins EVERY chain — a note outside 00-09 carries the families", () => {
    assert.deepEqual(placement("10-19 Personal/11 Health/x.md", ["note/daily", "person", "agent/chat"]), []);
    assert.equal(placement("10-19 Personal/11 Health/x.md", ["github/sync"]).length, 1);
  });

  test("the root note's folder rows are not the category's alone — the root speaks for the whole vault", () => {
    assert.deepEqual(placement("loose.md", ["meta"]), []);
  });

  test("a scope note validates against its own table too", () => {
    assert.deepEqual(placement(CAT, ["spec"]), []);
  });

  test("an undeclared tag never fires placement — existence owns it", () => {
    assert.deepEqual(placement("loose.md", ["sprocket"]), []);
  });
});

// ── the switch ───────────────────────────────────────────────────────────────

describe("the root scope note is the switch", () => {
  test("with the root note absent, no per-note finding fires and the state is reported", () => {
    const p = provider([], { withRoot: false });
    assert.deepEqual(p.validateToken("anything", "tag"), []);
    assert.deepEqual(p.noteFindings(noteAt(CAT, ["github/x", "nope"])), []);
    const out = scopeTagsFindings([noteAt("loose.md", ["anything"])], p);
    assert.deepEqual(out.map((f) => f.code), ["scope_root_missing"]);
    assert.equal(out[0].token, ROOT);
  });

  test("a root note with no table still switches scoping on", () => {
    const p = scopeTagsProvider(DEFAULT_SCOPE_TAGS_CONFIG, [{ path: ROOT, frontmatter: null, body: "# 00 System management\n" }]);
    assert.equal(p.validateToken("anything", "tag")[0].code, "tag_unregistered");
    assert.deepEqual(p.registryFindings(), []);
  });

  test('rootNote "" — scoping is on whenever any table is declared, and nothing is vault-wide', () => {
    const p = scopeTagsProvider({ rootNote: "", tagsHeading: "Tags" }, fixture());
    assert.equal(p.validateToken("sprocket", "tag")[0].code, "tag_unregistered");
    // the root note is now an ordinary category folder note: its rows reach only its folder
    assert.equal(p.noteFindings(noteAt(IN_CAT_NOTE, ["note/task"]))[0].code, "tag_out_of_scope");
    assert.deepEqual(p.registryFindings(), []);
    assert.deepEqual(scopeTagsProvider({ rootNote: "", tagsHeading: "Tags" }, []).validateToken("x", "tag"), []);
  });
});
// ── the rule pack ────────────────────────────────────────────────────────────

describe("the whole-vault rule pack", () => {
  test("tag_unregistered — fires for an undeclared tag, anchored to the note; not for a declared one", () => {
    const out = scopeTagsFindings([noteAt("loose.md", ["sprocket", "meta"])], provider());
    assert.deepEqual(out.map((f) => [f.code, f.token, f.path]), [["tag_unregistered", "sprocket", "loose.md"]]);
  });

  test("tag_out_of_scope — fires for declared-but-unadmitted; not for admitted", () => {
    const notes = [noteAt("10-19 Personal/a.md", ["spec"]), noteAt("00-09 System/b.md", ["github/x"])];
    assert.deepEqual(scopeTagsFindings(notes, provider()).map((f) => [f.code, f.path]), [["tag_out_of_scope", "10-19 Personal/a.md"]]);
  });

  test("tag_declared_twice_on_chain — reported at the LOWER row, naming the upper", () => {
    const out = scopeTagsFindings([], provider([scope("00-09 System/01 System architecture/01.30 Other/01.30 Other.md", [["spec", "Again."]])]));
    const f = out.filter((x) => x.code === "tag_declared_twice_on_chain");
    assert.equal(f.length, 1);
    assert.equal(f[0].token, "spec");
    assert.equal(f[0].path, "00-09 System/01 System architecture/01.30 Other/01.30 Other.md");
    assert.match(f[0].detail, /01 System architecture\.md/);
  });

  test("tag_declared_twice_on_chain — a root row repeated below, and a row repeated in one table", () => {
    const lower = scope("00-09 System/01 System architecture/01.40 B/01.40 B.md", [["meta", "M."], ["x", "X."], ["x", "X."]]);
    const f = scopeTagsFindings([], provider([lower])).filter((x) => x.code === "tag_declared_twice_on_chain");
    assert.deepEqual(f.map((x) => x.token).sort(), ["meta", "x"]);
    assert.match(f.find((x) => x.token === "x").detail, /twice in this note's table/);
  });

  test("tag_declared_on_two_branches — only when the descriptions differ", () => {
    const branch = (d) => scope("10-19 Personal/10-19 Personal.md", [["spec", d]]);
    const differ = scopeTagsFindings([], provider([branch("Another sense.")])).filter((x) => x.code === "tag_declared_on_two_branches");
    assert.equal(differ.length, 1);
    assert.match(differ[0].detail, /10-19 Personal\.md/);
    assert.deepEqual(scopeTagsFindings([], provider([branch("A spec note.")])), []);
  });

  test("the clean fixture has no findings at all", () => {
    assert.deepEqual(scopeTagsFindings([noteAt(CAT, ["spec", "note/task"])], provider()), []);
  });

  test("the pack emits ONLY its five codes, and each can fire", () => {
    const five = ["tag_unregistered", "tag_out_of_scope", "tag_declared_twice_on_chain", "tag_declared_on_two_branches", "scope_root_missing"];
    const extra = [
      scope("10-19 Personal/10-19 Personal.md", [["spec", "Another sense."]]),
      scope("00-09 System/01 System architecture/01.30 Other/01.30 Other.md", [["spec/rule", "Again."], ["meta", "Again."]]),
    ];
    const notes = [noteAt("loose.md", ["sprocket", "github/x"])];
    const codes = new Set([
      ...scopeTagsFindings(notes, provider(extra)).map((f) => f.code),
      ...scopeTagsFindings([], provider([], { withRoot: false })).map((f) => f.code),
    ]);
    for (const c of codes) assert.ok(five.includes(c), c);
    for (const c of five) assert.ok(codes.has(c), `missing ${c}`);
  });
});

// ── integration: noteVocabFindings ───────────────────────────────────────────

describe("noteVocabFindings integration", () => {
  test("placement and existence findings flow through the generic per-note rule pack", () => {
    const findings = noteVocabFindings(noteAt("10-19 Personal/a.md", ["spec", "sprocket", "note/task"]), [provider()]);
    assert.deepEqual(findings.map((f) => f.code).sort(), ["tag_out_of_scope", "tag_unregistered"]);
    for (const f of findings) assert.equal(f.path, "10-19 Personal/a.md");
  });

  test("an ambiguous token (two senses) surfaces as `ambiguous`", () => {
    const p = provider([scope("10-19 Personal/10-19 Personal.md", [["spec", "Another sense."]])]);
    const findings = noteVocabFindings(noteAt(CAT, ["spec"]), [p]);
    assert.deepEqual(findings.map((f) => f.code), ["ambiguous"]);
  });
});
