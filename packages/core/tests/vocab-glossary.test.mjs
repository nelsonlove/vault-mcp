/**
 * vocab-glossary.test.mjs — the glossary VocabularyProvider
 * (kernel/vocab/glossary.ts), over the vault's term surfaces:
 *
 *   (a) term notes — `type: Topic/Term` (the live model, about 651 notes on
 *       2026-10-14, #551): term = title (fallback: basename), gloss =
 *       `description` frontmatter, aliases = `aliases`.
 *   (b) definition-tag notes — the retired `note/definition` convention, off
 *       by default and still available through `definitionTag`.
 *   (c) `## Terms` sections — `- **term** — definition` bullets in the
 *       framework chapters.
 *
 * The deleted obsidian-new `defines:`/`Terms.base` scheme is NOT here — the
 * entry shape leaves room for it, but v1 parses what the vault actually has.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { glossaryProvider, resolveGlossaryConfig, DEFAULT_GLOSSARY_CONFIG } from "../src/vocab/glossary.ts";
import { VocabAmbiguousError } from "../src/vocab/provider.ts";

function notes(extra = []) {
  return [
    {
      path: "System/Glossary/Canonical.md",
      frontmatter: {
        title: "Canonical",
        description: "Canonical describes the status of holding authority for one specific claim.",
        type: "Topic/Term",
      },
    },
    {
      path: "System/Glossary/Term.md",
      frontmatter: {
        title: "Term",
        description: "A term is a defined word in the controlled vocabulary of the system.",
        type: "Topic/Term",
        aliases: ["Terms"],
      },
    },
    // an ordinary note — not a definition, contributes nothing
    { path: "Projects/Notes.md", frontmatter: { tags: ["project"] } },
    // a chapter with a ## Terms section
    {
      path: "Assent/4. The kernel.md",
      body:
        "# The kernel\n\nprose\n\n## Terms\n\n" +
        "- **drift** — disagreement between a projection and its source of record\n" +
        "- **rail** — the cross-entity conformance check\n\n" +
        "## Next section\n\n- **not-a-term** — bullets outside ## Terms don't count\n",
    },
    ...extra,
  ];
}

const provider = (extra) => glossaryProvider(DEFAULT_GLOSSARY_CONFIG, notes(extra));

describe("glossary config", () => {
  test("the defaults are the live model: `type: Topic/Term`, the definition tag off", () => {
    assert.deepEqual(DEFAULT_GLOSSARY_CONFIG, { typeKey: "type", termType: "Topic/Term", definitionTag: "" });
    assert.deepEqual(resolveGlossaryConfig(undefined), DEFAULT_GLOSSARY_CONFIG);
  });

  test("overrides merge over the defaults; wrong-typed values are ignored; an empty typeKey keeps the default", () => {
    assert.deepEqual(resolveGlossaryConfig({ termType: "Meta/Term", definitionTag: "note/definition" }), {
      typeKey: "type",
      termType: "Meta/Term",
      definitionTag: "note/definition",
    });
    assert.deepEqual(resolveGlossaryConfig({ termType: 7, typeKey: "" }), DEFAULT_GLOSSARY_CONFIG);
  });
});

describe("glossary provider: term notes", () => {
  test("capabilities: definitions and deprecations, flat; kinds = term", () => {
    const p = provider();
    assert.deepEqual(p.capabilities, {
      validate: true,
      resolveDefinition: true,
      hierarchical: false,
      deprecations: true,
    });
    assert.deepEqual(p.kinds, ["term"]);
  });

  test("a Topic/Term note is a term entry: title, description, aliases", () => {
    const e = provider().resolve("Term", "term");
    assert.equal(e.canonical, "Term");
    assert.equal(e.kind, "term");
    assert.equal(e.path, "System/Glossary/Term.md");
    assert.equal(e.definition, "A term is a defined word in the controlled vocabulary of the system.");
    assert.deepEqual(e.aliases, ["Terms"]);
  });

  test("resolution is case-insensitive, canonical case is preserved", () => {
    const e = provider().resolve("canonical", "term");
    assert.equal(e.canonical, "Canonical");
  });

  test("an alias resolves to its entry", () => {
    const e = provider().resolve("terms", "term");
    assert.equal(e.canonical, "Term");
  });

  test("a title-less definition note falls back to its basename", () => {
    const p = provider([
      { path: "System/Glossary/Scope.md", frontmatter: { type: "Topic/Term" } },
    ]);
    assert.equal(p.resolve("Scope", "term").canonical, "Scope");
  });

  test("a [superseded] definition note is deprecated, and validateToken flags it", () => {
    const p = provider([
      {
        path: "System/Glossary/[superseded] Locus.md",
        frontmatter: { title: "Locus", type: "Topic/Term" },
      },
    ]);
    assert.equal(p.resolve("Locus", "term").deprecated, true);
    assert.equal(p.validateToken("Locus", "term")[0].code, "deprecated");
  });
});

describe("glossary provider: term-note shapes", () => {
  test("a wikilinked class value, and a list value, still mark a term note", () => {
    const p = provider([
      { path: "G/Wiki.md", frontmatter: { title: "Wiki", type: "[[00.10 Fileclasses/Topic/Term.md|Term]]" } },
      { path: "G/List.md", frontmatter: { title: "Listed", type: ["Topic/Term"] } },
    ]);
    assert.equal(p.resolve("Wiki", "term").path, "G/Wiki.md");
    assert.equal(p.resolve("Listed", "term").path, "G/List.md");
  });

  test("another class, and the retired tag under the defaults, are not terms", () => {
    const p = provider([
      { path: "G/Topic.md", frontmatter: { title: "Topical", type: "Topic/Subject" } },
      { path: "G/Old.md", frontmatter: { title: "Old", tags: ["note/definition"] } },
    ]);
    assert.equal(p.resolve("Topical", "term"), null);
    assert.equal(p.resolve("Old", "term"), null);
  });

  test("the retired definition tag still works when configured, beside term notes", () => {
    const p = glossaryProvider({ definitionTag: "note/definition" }, notes([{ path: "G/Old.md", frontmatter: { title: "Old", tags: ["note/definition"] } }]));
    assert.equal(p.resolve("Old", "term").path, "G/Old.md");
    assert.equal(p.resolve("Term", "term").path, "System/Glossary/Term.md");
  });

  test("a custom type key and class are honoured; termType '' turns term notes off", () => {
    const listing = [{ path: "G/K.md", frontmatter: { title: "K", fileClass: "Meta/Term" } }];
    assert.equal(glossaryProvider({ typeKey: "fileClass", termType: "Meta/Term" }, listing).resolve("K", "term").path, "G/K.md");
    assert.equal(glossaryProvider({ termType: "" }, notes()).resolve("Term", "term"), null);
  });

  test("two Topic/Term notes sharing a title with different glosses refuse resolution (the pattern-language case)", () => {
    const p = provider([{ path: "Other/Term.md", frontmatter: { title: "Term", type: "Topic/Term", description: "Another system's sense." } }]);
    assert.throws(() => p.resolve("Term", "term"), VocabAmbiguousError);
  });
});

describe("glossary provider: ## Terms sections", () => {
  test("a Terms bullet is a term entry anchored to its chapter", () => {
    const e = provider().resolve("drift", "term");
    assert.equal(e.canonical, "drift");
    assert.equal(e.path, "Assent/4. The kernel.md");
    assert.equal(e.definition, "disagreement between a projection and its source of record");
  });

  test("bullets outside the ## Terms section do not register", () => {
    assert.equal(provider().resolve("not-a-term", "term"), null);
  });

  test("list is sorted case-insensitively across both surfaces", () => {
    const terms = provider().list("term").map((e) => e.canonical);
    assert.deepEqual(terms, ["Canonical", "drift", "rail", "Term"]);
  });
});

describe("glossary provider: validation and ambiguity", () => {
  test("validateToken: a known term is clean, an unknown one is a finding", () => {
    assert.deepEqual(provider().validateToken("drift", "term"), []);
    const f = provider().validateToken("mystery", "term");
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "unknown_term");
  });

  test("two sources with two senses: resolve refuses, list keeps both", () => {
    const p = provider([
      {
        path: "Elsewhere/Chapter.md",
        body: "## Terms\n\n- **drift** — a different sense entirely\n",
      },
    ]);
    assert.throws(() => p.resolve("drift", "term"), VocabAmbiguousError);
    assert.equal(p.list("term").filter((e) => e.canonical === "drift").length, 2);
  });

  test("identical duplicate senses collapse instead of refusing", () => {
    const p = provider([
      {
        path: "Elsewhere/Chapter.md",
        body: "## Terms\n\n- **drift** — disagreement between a projection and its source of record\n",
      },
    ]);
    assert.equal(p.resolve("drift", "term").path, "Assent/4. The kernel.md");
  });

  test("resolve of a kind this provider does not serve is null", () => {
    assert.equal(provider().resolve("meta/type", "tag"), null);
  });
});
