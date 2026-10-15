/**
 * vocab-module.test.mjs — the vaultmcp-vocab satellite (suite split, S7):
 * src/tools.ts (the four published tools) and src/settings.ts (the one-shot
 * adoption plus the per-instance form's pure half), all headless.
 *
 * Covered:
 *   • the four tools over a synthetic vault: enumeration with counts and
 *     examples, token resolution, parse mode, path mode, note validation,
 *     kind listing with `scope` and `vocabulary` narrowing;
 *   • THE PUBLICATION CONTRACT: the wire names (`vaultmcp_vocab_*`, with the
 *     host's `obsidian_` prefix stripped from the bare names), the untrusted
 *     read-only claim, the coded-error rendering, and — the thing that makes
 *     this package different from every prior satellite — the PER-TOOL and
 *     PER-CALL path-key status that decides what the host's F3 gate blocks;
 *   • the backslash refusals on the two hand-validated `path` arguments and on
 *     `list_vocabulary`'s `scope`;
 *   • the schema bounds re-applied in the handler, because the boundary drops
 *     `.min(1)`;
 *   • the `visible` seam — dormant in the shipped configuration, supplied here
 *     so it cannot rot — INCLUDING a test that pins what its absence costs;
 *   • the one-shot adoption of the host's top-level `vocabularies` ARRAY:
 *     latch, host-absent, host-settings-undefined, own-rows-win, coercion,
 *     bad rows dropped;
 *   • the pure settings-list helpers the settings tab renders.
 *
 * NOT covered here on purpose:
 *   • the vocabulary KERNEL. It lives in @vault-mcp/core and is tested there
 *     (`vocab-blueprint`, `vocab-glossary`, `vocab-findings`, `vocab-registry`,
 *     `vocab-scope-tags`) — this package has no `src/kernel/` and must not grow
 *     one, because the host's conformance rail is the kernel's other consumer.
 *   • the host's F3 pathless-tool block, the path allowlist, the write queue,
 *     the journal, read-only mode. Those are HOST code with host tests; a
 *     second copy could drift into asserting a posture the host does not
 *     enforce. What this package owns — which of its own argument names the
 *     host's guard would recognize — is pinned in the publication block.
 *   • obsidianVocabSource, the duck-typed Obsidian adapter (un-headless —
 *     verify live).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isVisible, VOCAB_PROVIDERS } from "@vault-mcp/core";
import { buildVocabTools, emptyVocabSource } from "../src/tools.ts";
import {
  adoptHostConfig,
  settingsOf,
  coerceVocabInstances,
  validateVocabInstances,
  parseVocabConfig,
  stringifyVocabConfig,
  addVocabInstance,
  removeVocabInstanceAt,
  updateVocabInstanceAt,
  DEFAULT_PLUGIN_SETTINGS,
} from "../src/settings.ts";
import { publishInto, OWNER, HOST_PATH_KEYS, carriesPathKey } from "./host-shim.mjs";

/** The host's `visiblePaths`, reproduced over core's published `isVisible` —
 *  the one-path predicate both sides share. It feeds the DORMANT `visible`
 *  seam so the seam's behaviour cannot rot; nothing supplies it in the shipped
 *  plugin (see tools.ts). */
const visiblePaths = (paths, settings) =>
  !settings?.allowlist?.length ? paths : paths.filter((p) => isVisible(p, settings));

// ── fixture: a blueprint registry + a glossary ──────────────────────────────

const REG_ROOT = "System/Registries";

function fakeFiles() {
  return {
    [`${REG_ROOT}/Meta registry/meta.tag/meta.tag.md`]: { frontmatter: {} },
    [`${REG_ROOT}/Meta registry/meta.tag/type.tag.md`]: {
      frontmatter: { description: "Registry-machinery tag namespace." },
    },
    [`${REG_ROOT}/Meta registry/note.tag/definition.tag.md`]: { frontmatter: {} },
    [`${REG_ROOT}/Meta registry/title.property.md`]: { frontmatter: {} },
    [`${REG_ROOT}/Meta registry/tags.property.md`]: { frontmatter: {} },
    [`${REG_ROOT}/Meta registry/Default.fileclass`]: { body: "---\n---\n" },
    [`${REG_ROOT}/Hidden registry/secret.tag.md`]: { frontmatter: {} },
    "Glossary/Canonical.md": {
      frontmatter: {
        title: "Canonical",
        description: "Holding authority for one specific claim.",
        type: "Topic/Term",
        tags: ["note/definition"],
      },
    },
    "Assent/4. The kernel.md": {
      body: "## Terms\n\n- **drift** — disagreement between projection and source\n",
    },
    "Notes/Tagged.md": { frontmatter: { title: "T", tags: ["meta/type", "rogue"] } },
  };
}

const VOCABS = [
  { id: "reg", provider: "blueprint", root: REG_ROOT },
  { id: "gloss", provider: "glossary", root: "", config: { termsRoot: "Assent" } },
];

function sourceOver(files) {
  return {
    paths: () => Object.keys(files),
    frontmatter: (p) => files[p]?.frontmatter ?? null,
    body: async (p) => files[p]?.body ?? null,
  };
}

/**
 * Build the four specs, publish them through the host shim, and hand back a
 * `call(bareName, args)` that goes through the ENVELOPE the agent sees.
 *
 * `supplyVisible` decides whether the dormant seam is wired. The SHIPPED plugin
 * supplies neither `visible` nor `getSettings`; the default here is to supply
 * both, so the seam's behaviour is exercised, and the tests that pin what the
 * shipped configuration actually does pass `supplyVisible: false`.
 */
function build({ files = fakeFiles(), vocabularies = VOCABS, allowlist = [], supplyVisible = true } = {}) {
  const settings = { readOnly: false, allowlist };
  const specs = buildVocabTools(sourceOver(files), {
    getVocabularies: () => vocabularies,
    ...(supplyVisible
      ? { getSettings: () => settings, visible: (paths) => visiblePaths(paths, settings) }
      : {}),
  });
  const { tools } = publishInto(specs);
  return {
    specs,
    tools,
    call: (bare, args = {}) => tools.get(`${OWNER}_${bare}`).handler(args),
  };
}

const errText = (res) => res.content[0].text;

// ── publication: the names, the flags, and the non-uniform allowlist posture ─

describe("publication: names, flags, and what the host's guard can scope", () => {
  const specs = () => buildVocabTools(emptyVocabSource(), {});

  test("the plugin id sanitizes to `vaultmcp_vocab`, and the bare names drop the host's `obsidian_` prefix", () => {
    assert.equal(OWNER, "vaultmcp_vocab");
    assert.deepEqual(specs().map((t) => t.name), [
      "vocabularies",
      "resolve_term",
      "validate_terms",
      "list_vocabulary",
    ]);
    const { tools } = publishInto(specs());
    assert.deepEqual([...tools.keys()], [
      "vaultmcp_vocab_vocabularies",
      "vaultmcp_vocab_resolve_term",
      "vaultmcp_vocab_validate_terms",
      "vaultmcp_vocab_list_vocabulary",
    ]);
    // The rename is a CHOICE, not a forced move: the host's F1 check rejects a
    // PUBLISHED name starting with `obsidian_`, and `vaultmcp_vocab_obsidian_*`
    // does not. Keeping the shipped bare names would have registered fine and
    // read terribly. Pinned so the reasoning in CLAUDE.md stays honest.
    assert.equal("vaultmcp_vocab_obsidian_vocabularies".startsWith("obsidian_"), false);
  });

  test("all four CLAIM read-only, and an untrusted claim registers every one of them as MUTATING", () => {
    // This is why read-only mode blocks the whole surface by default: the host
    // distrusts an external tool's readOnlyHint unless the raw publisher id is
    // in trustedReadOnlyPlugins.
    const untrusted = publishInto(specs()).tools;
    for (const [name, entry] of untrusted) {
      assert.equal(entry.def.claimsReadOnly, true, name);
      assert.equal(entry.def.annotations.readOnlyHint, false, name);
    }
    const trusted = publishInto(specs(), { trusted: true }).tools;
    for (const [name, entry] of trusted) {
      assert.equal(entry.def.annotations.readOnlyHint, true, name);
    }
  });

  test("the path-key status is PER TOOL, not uniform — two blocked, one scoped, one both", () => {
    // The decision, pinned. Unlike the triage / crosssession satellites, this
    // surface is not answered by one sentence. If this test changes, the
    // README's posture section and the settings tab's status line are wrong.
    const byName = Object.fromEntries(specs().map((s) => [s.name, s]));
    const keysOf = (name) => Object.keys(byName[name].inputSchema ?? {});

    // vocabularies: no arguments at all ⇒ nothing to scope ⇒ blocked outright.
    assert.deepEqual(keysOf("vocabularies"), []);

    // list_vocabulary: three arguments, none of them a host path key. `scope`
    // is a path PREFIX over declaring paths, not a path the guard could scope
    // the call by, so naming it `scope_path` would be the illusion of a check.
    assert.deepEqual(keysOf("list_vocabulary"), ["kind", "scope", "vocabulary"]);
    for (const k of keysOf("list_vocabulary")) assert.ok(!HOST_PATH_KEYS.includes(k), k);

    // validate_terms: `path` is REQUIRED and IS a host path key ⇒ the host
    // scopes it, and this tool stays available under an allowlist.
    assert.deepEqual(keysOf("validate_terms"), ["path"]);
    assert.ok(HOST_PATH_KEYS.includes("path"));

    // resolve_term: `path` is OPTIONAL, so the tool's status is decided PER
    // CALL by F3's `collectPaths(args)`.
    assert.ok(keysOf("resolve_term").includes("path"));
  });

  test("resolve_term is BLOCKED called with `token` and SCOPED called with `path` — same tool, same session", () => {
    // The single most surprising fact about this extraction. The host's F3 gate
    // is `settings.allowlist.length > 0 && collectPaths(args).length === 0`,
    // evaluated on the ACTUAL ARGUMENTS at call time — not once on the schema.
    assert.equal(carriesPathKey({ token: "note/task" }), false, "{token} ⇒ pathless ⇒ blocked under an allowlist");
    assert.equal(carriesPathKey({ token: "note/task", kind: "tag" }), false);
    assert.equal(carriesPathKey({ path: "Notes/Tagged.md" }), true, "{path} ⇒ scopable ⇒ the host checks the path");
    // …and the other three are decided once, whatever the arguments.
    assert.equal(carriesPathKey({}), false, "vocabularies takes nothing");
    assert.equal(carriesPathKey({ kind: "tag", scope: "System" }), false, "list_vocabulary is never scopable");
    assert.equal(carriesPathKey({ path: "Notes/Tagged.md" }), true, "validate_terms always is");
  });

  test("refusals throw with a lowercase-snake code, which the host renders as `Error [code]: message`", async () => {
    const res = await build().call("validate_terms", { path: "Notes\\Tagged.md" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[invalid_path\]: /);
  });
});

// ── the four tools ───────────────────────────────────────────────────────────

describe("vaultmcp_vocab_vocabularies", () => {
  test("enumerates instances with capabilities, counts and examples", async () => {
    const res = await build().call("vocabularies");
    assert.equal(res.isError, undefined);
    const [reg, gloss] = res.structuredContent.vocabularies;
    assert.equal(reg.id, "reg");
    assert.equal(reg.provider, "blueprint");
    assert.equal(reg.capabilities.hierarchical, true);
    assert.equal(reg.counts.tag, 4); // meta, meta/type, note/definition, secret
    assert.equal(reg.counts.property, 2);
    assert.equal(reg.counts.type, 1);
    assert.ok(reg.examples.tag.includes("meta/type"));
    assert.equal(gloss.id, "gloss");
    assert.equal(gloss.counts.term, 2); // Canonical + drift
  });

  test("a settings problem is reported, not thrown", async () => {
    const res = await build({
      vocabularies: [...VOCABS, { id: "x", provider: "sparkle", root: "" }],
    }).call("vocabularies");
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.problems.length, 1);
  });

  test("an EMPTY configured list falls back to the shipped defaults, rather than serving no vocabulary", async () => {
    // A deliberate (small) change from the folded module, where an empty array
    // meant "nothing at all". A fresh satellite install starts empty and has no
    // host to adopt from; doing nothing out of the box is not what installing a
    // vocabulary plugin asks for. Disabling the plugin is how you get nothing.
    const res = await build({ vocabularies: [] }).call("vocabularies");
    const ids = res.structuredContent.vocabularies.map((v) => v.id);
    assert.deepEqual(ids, ["scope-tags", "glossary"]);
  });
});

describe("vaultmcp_vocab_resolve_term", () => {
  test("token + kind resolves to the entry, naming its vocabulary", async () => {
    const res = await build().call("resolve_term", { token: "meta/type", kind: "tag" });
    const sc = res.structuredContent;
    assert.equal(sc.found, true);
    assert.equal(sc.entry.canonical, "meta/type");
    assert.equal(sc.entry.definition, "Registry-machinery tag namespace.");
    assert.equal(sc.vocabulary, "reg");
  });

  test("kind omitted searches every kind and still resolves a unique token", async () => {
    const res = await build().call("resolve_term", { token: "drift" });
    assert.equal(res.structuredContent.entry.kind, "term");
  });

  test("an unknown token is found:false, not an error", async () => {
    const res = await build().call("resolve_term", { token: "sprocket", kind: "tag" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.found, false);
  });

  test("parse mode validates without resolving", async () => {
    const res = await build().call("resolve_term", { token: "rogue", kind: "tag", parse: true });
    const sc = res.structuredContent;
    assert.equal(sc.valid, false);
    assert.equal(sc.findings[0].code, "unregistered_tag");
    assert.equal(sc.entry, undefined);
  });

  test("parse mode with no vocabulary serving the kind is vacuously valid, not silently invalid", async () => {
    const only = [{ id: "reg", provider: "blueprint", root: REG_ROOT }];
    const res = await build({ vocabularies: only }).call("resolve_term", {
      token: "drift",
      kind: "term",
      parse: true,
    });
    assert.equal(res.structuredContent.valid, true);
    assert.deepEqual(res.structuredContent.findings, []);
  });

  test("path mode reports the note's own vocabulary, resolved", async () => {
    const res = await build().call("resolve_term", { path: "Notes/Tagged.md" });
    const terms = res.structuredContent.terms;
    const tagTokens = terms.filter((t) => t.kind === "tag").map((t) => t.token);
    assert.deepEqual(tagTokens.sort(), ["meta/type", "rogue"]);
    assert.equal(terms.find((t) => t.token === "meta/type").found, true);
    assert.equal(terms.find((t) => t.token === "rogue").found, false);
  });

  test("path mode reports string-form tags frontmatter like its sibling tools", async () => {
    const files = {
      [`${REG_ROOT}/Meta registry/meta.tag/meta.tag.md`]: { frontmatter: {} },
      "Notes/S.md": { frontmatter: { tags: "meta" } },
    };
    const res = await build({
      files,
      vocabularies: [{ id: "reg", provider: "blueprint", root: REG_ROOT }],
    }).call("resolve_term", { path: "Notes/S.md" });
    const tagTerms = res.structuredContent.terms.filter((t) => t.kind === "tag");
    assert.deepEqual(tagTerms.map((t) => [t.token, t.found]), [["meta", true]]);
  });

  test("an ambiguous token is a coded refusal naming the candidates", async () => {
    const vocabularies = [...VOCABS, { id: "reg2", provider: "blueprint", root: `${REG_ROOT}/Meta registry` }];
    const res = await build({ vocabularies }).call("resolve_term", { token: "meta/type", kind: "tag" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[vocab_ambiguous\]/);
  });

  test("path mode reports an ambiguity WITHOUT its candidates — the candidate list is registry PATHS", async () => {
    // This branch is the one a session under an allowlist can actually reach
    // (path mode carries a host path key). Emitting candidates here would hand
    // it the paths of registry notes it may not be able to see.
    const vocabularies = [...VOCABS, { id: "reg2", provider: "blueprint", root: `${REG_ROOT}/Meta registry` }];
    const res = await build({ vocabularies }).call("resolve_term", { path: "Notes/Tagged.md" });
    assert.equal(res.isError, undefined);
    const term = res.structuredContent.terms.find((t) => t.token === "meta/type");
    assert.equal(term.ambiguous, true);
    assert.equal(JSON.stringify(res.structuredContent).includes(REG_ROOT), false);
  });
});

describe("vaultmcp_vocab_validate_terms", () => {
  test("a note's frontmatter yields findings anchored to the note", async () => {
    const res = await build().call("validate_terms", { path: "Notes/Tagged.md" });
    const sc = res.structuredContent;
    assert.equal(sc.path, "Notes/Tagged.md");
    const codes = sc.findings.map((f) => f.code);
    assert.ok(codes.includes("unregistered_tag")); // rogue
    assert.equal(sc.findings.find((f) => f.code === "unregistered_tag").path, "Notes/Tagged.md");
    assert.equal(sc.clean, false);
  });

  test("a registered tag raises no tag finding; unregistered keys still do", async () => {
    const res = await build().call("validate_terms", { path: "Glossary/Canonical.md" });
    const findings = res.structuredContent.findings;
    // `note/definition` is registered (note.tag/definition.tag.md) — clean.
    assert.equal(findings.some((f) => f.code === "unregistered_tag"), false);
    // `description` is not in the fixture's property registry — flagged.
    assert.ok(findings.some((f) => f.code === "undefined_property" && f.token === "description"));
  });
});

// ── the scope-tags vocabulary through the tools: bodies reach the provider ──

describe("scope-tags through the tools (the `## Tags` table model, #551)", () => {
  const ROOT = "00-09 System/00 System management/00 System management.md";
  const table = (rows) =>
    "\n## Tags\n\n| Tag | Description |\n| --- | --- |\n" + rows.map(([t, d]) => `| \`${t}\` | ${d} |`).join("\n") + "\n";
  // raw files, frontmatter included, as `cachedRead` returns them
  const files = () => ({
    [ROOT]: { body: "---\ntitle: 00 System management\n---\n# 00 System management\n" + table([["note/*", "What kind of note."], ["person", "One person."]]) },
    "00-09 System/03 Agents/03 Agents.md": { body: "---\ntitle: 03 Agents\n---\n" + table([["rollup", "A rollup note."]]) },
    "00-09 System/03 Agents/log.md": { frontmatter: { tags: ["rollup", "note/log", "sprocket"] }, body: "## Tags\n\n| Tag | D |\n| --- | --- |\n| `stray` | not a scope note |\n" },
    "10-19 Personal/x.md": { frontmatter: { tags: ["rollup", "person"] } },
  });
  const ROWS = [{ id: "scope-tags", provider: "scope-tags", root: "" }];

  test("validate_terms reads the tables from the scope notes' bodies: unregistered and out-of-scope fire", async () => {
    const inAgents = (await build({ files: files(), vocabularies: ROWS }).call("validate_terms", { path: "00-09 System/03 Agents/log.md" })).structuredContent;
    assert.deepEqual(inAgents.findings.map((f) => [f.code, f.token]), [["tag_unregistered", "sprocket"]]);
    const outside = (await build({ files: files(), vocabularies: ROWS }).call("validate_terms", { path: "10-19 Personal/x.md" })).structuredContent;
    assert.deepEqual(outside.findings.map((f) => [f.code, f.token]), [["tag_out_of_scope", "rollup"]]);
  });

  test("the defaults alone read the live layout: list_vocabulary counts the rows of the folder notes and the root", async () => {
    const res = await build({ files: files(), vocabularies: [] }).call("list_vocabulary", { kind: "tag", vocabulary: "scope-tags" });
    assert.deepEqual(res.structuredContent.entries.map((e) => e.canonical), ["note/*", "person", "rollup"]);
  });

  test("bodies are read only for folder notes and the root note — never an ordinary note", async () => {
    const read = [];
    const f = files();
    const source = {
      paths: () => Object.keys(f),
      frontmatter: (p) => f[p]?.frontmatter ?? null,
      body: async (p) => {
        read.push(p);
        return f[p]?.body ?? null;
      },
    };
    const { tools } = publishInto(buildVocabTools(source, { getVocabularies: () => ROWS }));
    await tools.get(`${OWNER}_vocabularies`).handler({});
    assert.deepEqual(read.sort(), [ROOT, "00-09 System/03 Agents/03 Agents.md"].sort());
  });
});

describe("vaultmcp_vocab_list_vocabulary", () => {
  test("lists a kind sorted, with the declaring vocabulary named", async () => {
    const res = await build().call("list_vocabulary", { kind: "term" });
    const entries = res.structuredContent.entries;
    assert.deepEqual(entries.map((e) => e.canonical), ["Canonical", "drift"]);
    assert.equal(entries[0].vocabulary, "gloss");
    assert.equal(res.structuredContent.count, 2);
  });

  test("scope confines the listing by declaring path", async () => {
    const res = await build().call("list_vocabulary", { kind: "term", scope: "Assent" });
    assert.deepEqual(res.structuredContent.entries.map((e) => e.canonical), ["drift"]);
  });

  test("an empty scope is a first-class value meaning everything, not a refusal", async () => {
    // Why `scope` is NOT routed through core's `resolveScope`, which refuses
    // "": the providers' own `list(kind, "")` returns everything, and this
    // argument filters DECLARING paths rather than authorizing a vault read.
    const res = await build().call("list_vocabulary", { kind: "term", scope: "" });
    assert.deepEqual(res.structuredContent.entries.map((e) => e.canonical), ["Canonical", "drift"]);
  });

  test("vocabulary narrows to one instance", async () => {
    const res = await build().call("list_vocabulary", { kind: "tag", vocabulary: "gloss" });
    assert.deepEqual(res.structuredContent.entries, []);
  });
});

// ── argument hygiene: the bounds the boundary drops, and the backslash class ─

describe("schema bounds are re-applied in the handler", () => {
  // The SDK converts zod to JSON Schema and the host converts it back through a
  // small subset: `type`, `description`, string `enum` and the object's
  // `required` list survive; `min`, `max`, `default` and `pattern` do NOT. So
  // every `.min(1)` runs again where it actually executes. This is the
  // `vaultmcp_skills_release` semver lesson, applied before it could bite.

  test("an empty-string `path` refuses in the handler rather than reaching the vault", async () => {
    for (const bare of ["validate_terms", "resolve_term"]) {
      const res = await build().call(bare, { path: "   " });
      assert.equal(res.isError, true, bare);
      assert.match(errText(res), /^Error \[invalid_argument\]: 'path'/, bare);
    }
  });

  test("an empty-string `token` and `vocabulary` refuse too", async () => {
    const a = await build().call("resolve_term", { token: "" });
    assert.match(errText(a), /^Error \[invalid_argument\]/);
    const b = await build().call("list_vocabulary", { kind: "tag", vocabulary: " " });
    assert.match(errText(b), /^Error \[invalid_argument\]: 'vocabulary'/);
  });

  test("`kind` is re-checked even though its string enum DOES survive the boundary", async () => {
    // The enum and the `required` list both survive, so a well-formed SDK spec
    // is already guarded upstream. It is re-checked because both handlers
    // BRANCH on the value, and a hand-written publisher JSON Schema can reach
    // the host as a bare `{}` that degrades to `z.unknown()`.
    const missing = await build().call("list_vocabulary", {});
    assert.match(errText(missing), /^Error \[invalid_argument\]: 'kind'/);
    const bogus = await build().call("list_vocabulary", { kind: "sparkle" });
    assert.match(errText(bogus), /^Error \[invalid_argument\]: 'kind' must be one of/);
    const bogusOnResolve = await build().call("resolve_term", { token: "x", kind: "sparkle" });
    assert.match(errText(bogusOnResolve), /^Error \[invalid_argument\]: 'kind'/);
  });
});

describe("backslash refusals on the hand-validated path-shaped arguments", () => {
  // The `resolveScope` / triage `target_path` precedent (2026-09-05). Every
  // check downstream — the host guard's `collectPaths` + `normalizePosix`,
  // `isVisible`'s prefix match, the providers' `underRoot` — splits on "/"
  // alone, so a backslash reads as ONE opaque segment here and as a traversal
  // to whatever normalizes it later. Obsidian paths never contain one.

  test("validate_terms refuses a backslash `path` — coded `invalid_path`, before any visibility check", async () => {
    const res = await build({ allowlist: ["Notes"] }).call("validate_terms", { path: "Notes\\x\\..\\..\\Secrets.md" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[invalid_path\]: 'path' contains a backslash/);
  });

  test("resolve_term refuses a backslash `path` the same way", async () => {
    const res = await build().call("resolve_term", { path: "Notes\\Tagged.md" });
    assert.match(errText(res), /^Error \[invalid_path\]: 'path' contains a backslash/);
  });

  test("list_vocabulary refuses a backslash `scope` — coded `invalid_scope`", async () => {
    const res = await build().call("list_vocabulary", { kind: "tag", scope: "System\\Registries" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[invalid_scope\]: scope contains a backslash/);
  });

  test("`token` and `vocabulary` are NOT path-shaped and are deliberately not backslash-refused", async () => {
    // A vocabulary TOKEN is a tag / property key / type name / term, and a
    // `vocabulary` is a configured instance id. Neither is ever split on "/" as
    // a path, neither reaches `isVisible`, and neither is compared against a
    // path prefix — so a backslash in one is an ordinary character that simply
    // fails to resolve. Refusing it would reject a legitimate (if odd) token
    // for a threat that does not exist on this argument.
    const res = await build().call("resolve_term", { token: "weird\\token", kind: "tag" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.found, false);
  });
});

// ── the envelope changes this extraction made, on purpose ───────────────────

describe("envelope changes (recorded in CLAUDE.md)", () => {
  test("`token` AND `path` together is now CODED `invalid_argument` — it used to render codeless", async () => {
    const res = await build().call("resolve_term", { token: "x", path: "Notes/Tagged.md" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[invalid_argument\]: give `token` or `path`, not both/);
  });

  test("neither `token` nor `path` is coded `invalid_argument` too", async () => {
    const res = await build().call("resolve_term", {});
    assert.match(errText(res), /^Error \[invalid_argument\]: give `token` \(with optional `kind`\) or `path`/);
  });

  test("`vocab_ambiguous` and `out_of_allowlist` keep their exact codes and messages", async () => {
    const ambiguous = await build({
      vocabularies: [...VOCABS, { id: "reg2", provider: "blueprint", root: `${REG_ROOT}/Meta registry` }],
    }).call("resolve_term", { token: "meta/type", kind: "tag" });
    assert.match(errText(ambiguous), /^Error \[vocab_ambiguous\]: 'meta\/type' has 2 senses — refusing to pick: /);

    const hidden = await build({ allowlist: ["Glossary"] }).call("validate_terms", { path: "Notes/Tagged.md" });
    assert.equal(errText(hidden), "Error [out_of_allowlist]: 'Notes/Tagged.md' is outside this session's allowlist");
  });
});

// ── the dormant `visible` seam, and what its absence costs ──────────────────

describe("the `visible` seam (dormant in the shipped configuration)", () => {
  test("supplied, a vocabulary entry outside the allowlist neither resolves nor lists", async () => {
    const allowlist = [`${REG_ROOT}/Meta registry`, "Glossary", "Assent", "Notes"];
    const s = build({ allowlist });
    const res = await s.call("resolve_term", { token: "secret", kind: "tag" });
    assert.equal(res.structuredContent.found, false);
    const list = await s.call("list_vocabulary", { kind: "tag" });
    const tags = list.structuredContent.entries.map((e) => e.canonical);
    assert.equal(tags.includes("secret"), false);
    assert.ok(tags.includes("meta/type"));
  });

  test("supplied, counts and examples are visible-filtered too", async () => {
    const res = await build({ allowlist: [`${REG_ROOT}/Meta registry`] }).call("vocabularies");
    assert.equal(res.structuredContent.vocabularies[0].counts.tag, 3); // secret gone
  });

  test("supplied, a single-path argument refuses coded rather than answering", async () => {
    const res = await build({ allowlist: ["Glossary"] }).call("validate_terms", { path: "Notes/Tagged.md" });
    assert.equal(res.isError, true);
    assert.match(errText(res), /^Error \[out_of_allowlist\]/);
  });

  test("UNSUPPLIED — the shipped configuration — the listing is NOT filtered, and that is the documented cost", async () => {
    // This pins the one direction in which the extraction is not strictly
    // stricter, so nobody rediscovers it as a surprise. As a MODULE the host
    // supplied `getSettings`, so `buildListing` dropped hidden registry notes
    // before any provider saw them. As a SATELLITE nothing supplies it: a
    // published tool cannot consult the host's allowlist, which is exactly the
    // boundary the split draws.
    //
    // For `vocabularies` and `list_vocabulary` it is unreachable — the host
    // blocks both outright under an allowlist (no path argument). For the two
    // the host DOES let through it is reachable, bounded by the tokens the
    // caller's own visible note already carries. Fixable only by an
    // apiVersion-2 `vault-mcp-api` that carries the caller's scope to a
    // publisher, at which point `visible` goes live with no code change.
    const shipped = build({ supplyVisible: false });
    const res = await shipped.call("validate_terms", { path: "Notes/Tagged.md" });
    assert.equal(res.isError, undefined, "no allowlist is consulted, so nothing refuses");
    // `secret` is declared only in the fixture's Hidden registry, and it is in
    // the providers regardless of any allowlist.
    const list = await shipped.call("list_vocabulary", { kind: "tag" });
    assert.ok(list.structuredContent.entries.map((e) => e.canonical).includes("secret"));
  });
});

// ── one-shot adoption of the host's top-level `vocabularies` ARRAY ──────────

describe("settings adoption (pure)", () => {
  const HOST = (vocabularies) => ({ vocabularies });
  const fresh = () => ({ ...DEFAULT_PLUGIN_SETTINGS, vocabularies: [] });
  const ROWS = [{ id: "scope-tags", provider: "scope-tags", root: "" }];

  test("adopts the host's ARRAY once and latches", () => {
    const out = adoptHostConfig(fresh(), HOST(ROWS));
    assert.deepEqual(out.vocabularies, ROWS);
    assert.equal(out.adoptedFromHost, true);
    assert.equal(adoptHostConfig(out, HOST([{ id: "changed", provider: "glossary", root: "" }])), null, "one-shot");
  });

  test("it reads a TOP-LEVEL `vocabularies`, not `modules.vocab.config` — which never existed", () => {
    // The host's VOCAB_MANIFEST carries no `config:` block at all: the setting
    // is a list of structured instances the scalar manifest-field renderer
    // cannot express, so it lives at the top level with a bespoke form.
    const out = adoptHostConfig(fresh(), { modules: { vocab: { enabled: true, config: { root: "X" } } } });
    assert.deepEqual(out.vocabularies, [], "nothing under modules.vocab.config is a vocabulary row");
    assert.equal(out.adoptedFromHost, true, "the question was asked and answered");
  });

  test("the satellite's OWN rows win outright — adoption is all-or-nothing for a list", () => {
    // Merging row-by-row would need an identity to merge ON, and the only
    // candidate (`id`) is exactly what a user renames — a merge would silently
    // resurrect a row deleted here.
    const mine = [{ id: "mine", provider: "glossary", root: "Notes" }];
    const out = adoptHostConfig({ ...fresh(), vocabularies: mine }, HOST(ROWS));
    assert.deepEqual(out.vocabularies, mine);
    assert.equal(out.adoptedFromHost, true);
  });

  test("an ABSENT host adopts nothing and does NOT latch — the one chance survives", () => {
    assert.equal(adoptHostConfig(fresh(), undefined), null);
    assert.equal(adoptHostConfig(fresh(), null), null);
  });

  test("a host whose `settings` is still UNDEFINED reads as NOT READY, never as an empty host", () => {
    // The host declares `settings` without an initializer and assigns it
    // mid-onload, so an instance visible in app.plugins.plugins before that
    // assignment must not burn the latch. main.ts's guard is `!== undefined`,
    // never a truthiness test; the pure function sees `undefined` and declines.
    assert.equal(adoptHostConfig(fresh(), undefined), null);
    // …whereas a host that IS ready with no rows latches on an empty list.
    const ready = adoptHostConfig(fresh(), {});
    assert.deepEqual(ready.vocabularies, []);
    assert.equal(ready.adoptedFromHost, true);
  });

  test("incoming rows are COERCED: a non-array is empty, structural garbage is dropped", () => {
    assert.deepEqual(adoptHostConfig(fresh(), HOST("nope")).vocabularies, []);
    assert.deepEqual(adoptHostConfig(fresh(), HOST(null)).vocabularies, []);
    const messy = [null, 42, "row", ["nested"], { id: "ok", provider: "glossary", root: "R" }];
    assert.deepEqual(adoptHostConfig(fresh(), HOST(messy)).vocabularies, [
      { id: "ok", provider: "glossary", root: "R" },
    ]);
  });

  test("an unknown PROVIDER is kept, not dropped — the registry and the form must be able to report it", () => {
    // Dropping it would hide a misconfiguration the user needs to see; the
    // registry skips-and-reports it, and validateVocabInstances names it.
    const out = adoptHostConfig(fresh(), HOST([{ id: "x", provider: "sparkle", root: "" }]));
    assert.deepEqual(out.vocabularies, [{ id: "x", provider: "sparkle", root: "" }]);
    assert.equal(validateVocabInstances(out.vocabularies).length, 1);
  });

  test("settingsOf coerces a corrupt or hand-edited data.json to the defaults", () => {
    assert.deepEqual(settingsOf(null), { vocabularies: [], adoptedFromHost: false });
    assert.deepEqual(settingsOf([1, 2]), { vocabularies: [], adoptedFromHost: false });
    assert.deepEqual(settingsOf({ vocabularies: "nope", adoptedFromHost: "yes" }), {
      vocabularies: [],
      adoptedFromHost: false,
    });
    assert.deepEqual(settingsOf({ vocabularies: [{ id: "a", provider: "glossary", root: "" }], adoptedFromHost: true }), {
      vocabularies: [{ id: "a", provider: "glossary", root: "" }],
      adoptedFromHost: true,
    });
  });
});

// ── the per-instance form's pure half ───────────────────────────────────────

describe("settings-list helpers (the settings tab's pure half)", () => {
  test("parseVocabConfig: blank is no config, valid JSON object parses, anything else is a LOUD refusal", () => {
    assert.deepEqual(parseVocabConfig("  "), { ok: true, config: undefined });
    assert.deepEqual(parseVocabConfig('{"termsRoot": "A"}'), { ok: true, config: { termsRoot: "A" } });
    assert.equal(parseVocabConfig("{oops").ok, false);
    assert.equal(parseVocabConfig("[1,2]").ok, false);
    assert.equal(parseVocabConfig("null").ok, false);
    assert.equal(parseVocabConfig('"str"').ok, false);
  });

  test("stringifyVocabConfig round-trips, and an empty config renders blank", () => {
    assert.equal(stringifyVocabConfig(undefined), "");
    assert.equal(stringifyVocabConfig({}), "");
    assert.deepEqual(parseVocabConfig(stringifyVocabConfig({ termsRoot: "A" })).config, { termsRoot: "A" });
  });

  test("coerceVocabInstances never throws and preserves problems rather than rewriting them", () => {
    assert.deepEqual(coerceVocabInstances(undefined), []);
    assert.deepEqual(coerceVocabInstances({ not: "an array" }), []);
    assert.deepEqual(coerceVocabInstances([{ id: 7, provider: null, root: [], config: "x" }]), [
      { id: "", provider: "", root: "" },
    ]);
    assert.deepEqual(coerceVocabInstances([{ id: "a", provider: "sparkle", root: "R", config: { k: 1 } }]), [
      { id: "a", provider: "sparkle", root: "R", config: { k: 1 } },
    ]);
  });

  test("validateVocabInstances names blank ids, duplicates, unknown providers and whitespace-only roots", () => {
    assert.deepEqual(validateVocabInstances([{ id: "a", provider: "glossary", root: "" }]), []);
    const problems = validateVocabInstances([
      { id: "", provider: "glossary", root: "" },
      { id: "a", provider: "sparkle", root: "" },
      { id: "a", provider: "glossary", root: " " },
    ]);
    assert.equal(problems.length, 4);
    assert.match(problems[0], /id is required/);
    assert.match(problems[1], /unknown provider 'sparkle'/);
    assert.match(problems[2], /duplicate id 'a'/);
    assert.match(problems[3], /whitespace-only/);
  });

  test('root "" is first-class ("whole vault"), not a validation problem', () => {
    assert.deepEqual(validateVocabInstances([{ id: "g", provider: "glossary", root: "" }]), []);
  });

  test("add / remove / update are pure and never mutate the input", () => {
    const list = [{ id: "a", provider: "glossary", root: "" }];
    const added = addVocabInstance(list);
    assert.equal(list.length, 1);
    assert.equal(added.length, 2);
    // Parity with the host's form, deliberately: a new blank row preselects
    // `VOCAB_PROVIDERS[0]`, which is `blueprint` — the LEGACY grammar, not the
    // live `scope-tags` model. Reordering `VOCAB_PROVIDERS` in core would
    // change the host's dropdown too, so the preselection is left alone and
    // pinned here rather than silently diverging between the two forms.
    assert.equal(added[1].provider, VOCAB_PROVIDERS[0]);
    assert.equal(added[1].provider, "blueprint");

    assert.deepEqual(removeVocabInstanceAt(added, 1), list);
    assert.deepEqual(removeVocabInstanceAt(list, 9), list, "an out-of-range index is a no-op copy");

    const patched = updateVocabInstanceAt(list, 0, { root: "R" });
    assert.deepEqual(patched, [{ id: "a", provider: "glossary", root: "R" }]);
    assert.deepEqual(list, [{ id: "a", provider: "glossary", root: "" }], "input untouched");
  });

  test("an `undefined` patch value REMOVES the key — the blank-config-means-no-config convention", () => {
    const withConfig = [{ id: "a", provider: "glossary", root: "", config: { termsRoot: "A" } }];
    const cleared = updateVocabInstanceAt(withConfig, 0, { config: undefined });
    assert.equal("config" in cleared[0], false);
  });
});
