/**
 * vocab-registry.test.mjs — VocabRegistry (kernel/vocab/registry.ts):
 * provider instances from settings, mirroring the scope-provider's `schemes`
 * settings shape: `{ id, provider, root, config }[]`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { VocabRegistry, DEFAULT_VOCABULARIES } from "../src/vocab/registry.ts";

const LISTING = [
  { path: "Reg/meta.tag/meta.tag.md" },
  { path: "Elsewhere/rogue.tag.md" },
  {
    path: "Glossary/Term.md",
    frontmatter: { title: "Term", description: "A defined word.", type: "Topic/Term" },
  },
];

describe("VocabRegistry", () => {
  test("builds one instance per configured vocabulary, in order", () => {
    const reg = new VocabRegistry([
      { id: "reg", provider: "blueprint", root: "Reg" },
      { id: "gloss", provider: "glossary", root: "" },
    ]);
    const instances = reg.build(LISTING);
    assert.deepEqual(
      instances.map((i) => [i.id, i.providerName]),
      [
        ["reg", "blueprint"],
        ["gloss", "glossary"],
      ]
    );
  });

  test("the root confines an instance's vocabulary", () => {
    const reg = new VocabRegistry([{ id: "reg", provider: "blueprint", root: "Reg" }]);
    const [inst] = reg.build(LISTING);
    assert.equal(inst.provider.resolve("meta", "tag").canonical, "meta");
    assert.equal(inst.provider.resolve("rogue", "tag"), null);
  });

  test("glossary config flows through: a custom definition tag", () => {
    const reg = new VocabRegistry([
      { id: "g", provider: "glossary", root: "", config: { definitionTag: "kb/term" } },
    ]);
    const [inst] = reg.build([
      { path: "A.md", frontmatter: { title: "Alpha", tags: ["kb/term"] } },
      { path: "B.md", frontmatter: { title: "Beta", tags: ["note/definition"] } },
    ]);
    assert.equal(inst.provider.resolve("Alpha", "term").canonical, "Alpha");
    assert.equal(inst.provider.resolve("Beta", "term"), null);
  });

  test("glossary config flows through: a custom term class", () => {
    const reg = new VocabRegistry([{ id: "g", provider: "glossary", root: "", config: { termType: "Meta/Term" } }]);
    const [inst] = reg.build([
      { path: "A.md", frontmatter: { title: "Alpha", type: "Meta/Term" } },
      { path: "B.md", frontmatter: { title: "Beta", type: "Topic/Term" } },
    ]);
    assert.equal(inst.provider.resolve("Alpha", "term").canonical, "Alpha");
    assert.equal(inst.provider.resolve("Beta", "term"), null);
  });

  test("an unknown provider name is skipped and reported, never thrown", () => {
    const reg = new VocabRegistry([
      { id: "x", provider: "sparkle", root: "" },
      { id: "reg", provider: "blueprint", root: "Reg" },
    ]);
    assert.equal(reg.build(LISTING).length, 1);
    assert.equal(reg.problems.length, 1);
    assert.match(reg.problems[0], /sparkle/);
  });

  test("a duplicate id is skipped and reported — first declaration wins", () => {
    const reg = new VocabRegistry([
      { id: "reg", provider: "blueprint", root: "Reg" },
      { id: "reg", provider: "glossary", root: "" },
    ]);
    const instances = reg.build(LISTING);
    assert.deepEqual(instances.map((i) => i.providerName), ["blueprint"]);
    assert.equal(reg.problems.length, 1);
  });

  test("the defaults: the live scope-tags model, one glossary (#551)", () => {
    assert.deepEqual(
      DEFAULT_VOCABULARIES.map((v) => [v.id, v.provider]),
      [
        ["scope-tags", "scope-tags"],
        ["glossary", "glossary"],
      ]
    );
    // The shipped defaults name NO vault path at all: every root is the whole
    // vault and no row carries a config path. A vault path in a default went
    // dead silently three times (Assent → 00.89 obsidian-governor → 00.89
    // obsidian-mcp-suite); the operator sets `termsRoot` in the satellite.
    // Options are allowed; a vault PATH is not. A string that names a folder
    // (contains a "/") or a JD address is one vault's layout.
    const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
    for (const row of DEFAULT_VOCABULARIES) {
      assert.equal(row.root, "", `${row.id}: the whole vault, no shipped folder`);
      for (const v of strings(row.config ?? {})) assert.doesNotMatch(v, /\/|\b\d\d-\d\d\b|\b\d\d\.\d\d\b/, `${row.id}: config value '${v}' is a vault path`);
      assert.equal(row.config?.termsRoot, undefined, `${row.id}: no shipped termsRoot`);
    }
  });

  test("the defaults parse a fixture mirroring the live vault shapes (2026-10-14, #551)", () => {
    // The live model, in miniature: the root scope note (the folder note of
    // category 00) with its `## Tags` table in the BODY, a category folder
    // note with its own table, and a `type: Topic/Term` note.
    const reg = new VocabRegistry(DEFAULT_VOCABULARIES);
    assert.deepEqual(reg.problems, []);
    const table = (rows) => "\n## Tags\n\n| Tag | Description |\n| --- | --- |\n" + rows.map(([t, d]) => `| \`${t}\` | ${d} |`).join("\n") + "\n";
    const instances = reg.build([
      {
        path: "00-09 System/00 System management/00 System management.md",
        frontmatter: { type: "Meta/Scope/Category" },
        body: "---\ntitle: 00 System management\n---\n# 00 System management\n" + table([["note/*", "What kind of thing is this single note?"], ["note/task", "Actionable work."]]),
      },
      {
        path: "00-09 System/03 Agents/03 Agents.md",
        frontmatter: { type: "Meta/Scope/Category" },
        body: table([["rollup", "A rollup note that gathers a period of records."]]),
      },
      {
        path: "00-09 System/01 System architecture/01.05 Controlled vocabulary/Canonical.md",
        frontmatter: { title: "Canonical", description: "Holding authority.", type: "Topic/Term" },
      },
    ]);
    const tags = instances.find((i) => i.id === "scope-tags");
    assert.equal(tags.provider.resolve("note/task", "tag").canonical, "note/task");
    assert.equal(tags.provider.resolve("note/clipping", "tag").definition, "What kind of thing is this single note?");
    assert.equal(tags.provider.list("tag").length, 3);
    assert.deepEqual(tags.provider.registryFindings(), []);
    assert.deepEqual(tags.provider.noteFindings({ path: "10-19 Personal/x.md", frontmatter: { tags: ["rollup"] } }).map((f) => f.code), ["tag_out_of_scope"]);
    const gloss = instances.find((i) => i.id === "glossary");
    assert.equal(gloss.provider.resolve("Canonical", "term").definition, "Holding authority.");
  });
});

describe("review fixes — pinned", () => {
  test("an unknown-provider row still reserves its id — later reuse reports as duplicate", () => {
    const reg = new VocabRegistry([
      { id: "reg", provider: "sparkle", root: "" },
      { id: "reg", provider: "blueprint", root: "Reg" },
    ]);
    assert.equal(reg.build(LISTING).length, 0);
    assert.equal(reg.problems.length, 2);
    assert.match(reg.problems[1], /duplicate/);
  });
});
