/**
 * frontmatter-read-sites.test.mjs — issue #189: the five plugin-side READ
 * sites that parsed raw note text with their own narrow `/^---\n/` frontmatter
 * regexes instead of the shared recognizer in @vault-mcp/core
 * (`leadingFrontmatterBlock` / `stripLeadingFrontmatter`, the #150 pair). A
 * narrow local copy reads a BOM- or CRLF-authored note as having NO
 * frontmatter at all — a silent mis-read, not a bypass.
 *
 * One describe-block PER SITE, so neutering any single site (reverting its
 * regex) fails that site's own block — the per-site non-vacuity the issue's
 * definition-of-done asks for. Each block asserts the same three things:
 *
 *   1. a BOM-prefixed note now parses (the pre-fix narrow behavior is dead),
 *   2. a CRLF note now parses (dead for the sites that were CRLF-blind;
 *      regression-pinned for the two that already handled CRLF),
 *   3. a plain LF note behaves byte-identically to before the fix — for the
 *      conformance packs that is what keeps every already-recognized note's
 *      finding set, and therefore its ratchet keys, unchanged.
 *
 * The sites (issue #189's table):
 *   - src/conformance/packs/drift.ts        `fmBlock`          (BOM+CRLF-blind)
 *   - src/conformance/packs/structure.ts    FM_STRIP + noteInfo (BOM+CRLF-blind)
 *     — MOVED OUT: the conformance rail is its own plugin since 2026-10-14;
 *     both sites are now pinned by
 *     packages/conformance/tests/frontmatter-read-sites.test.mjs
 *   - @vault-mcp/core src/vocab/blueprint.ts `scanFrontmatter`  (BOM+CRLF-blind)
 *     (was src/kernel/vocab/blueprint.ts until the S7 satellite extraction)
 *   - src/kernel/skills/transclude.ts       `stripFrontmatter` (BOM-blind)
 *     — MOVED OUT: the skills compiler is its own plugin since the suite
 *     split S4; that site is now pinned by
 *     packages/skills/tests/transclude-frontmatter.test.mjs
 *   - src/mcp/tools-complementary.ts        obsidian_read_note_parsed body strip
 *                                                              (BOM-blind)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scanFrontmatter } from "@vault-mcp/core";

// U+FEFF by code point, never a literal BOM byte in source (accept-guard.ts's
// own convention — stripLeadingBom compares 0xfeff the same way).
const BOM = String.fromCharCode(0xfeff);

// ── sites 1 and 2 (drift.ts `fmBlock`, structure.ts FM_STRIP + noteInfo) ─────
// MOVED with the conformance rail to the vaultmcp-conformance satellite on
// 2026-10-14; pinned by packages/conformance/tests/frontmatter-read-sites.test.mjs.

// ── site 3: @vault-mcp/core vocab/blueprint.ts `scanFrontmatter` ─────────────

describe("vocab blueprint.ts scanFrontmatter binds to the shared recognizer (#189)", () => {
  const WANT = { extends: "Base", retired: true, tags: ["a", "b"] };

  test("LF definition parses as before (regression)", () => {
    assert.deepEqual(scanFrontmatter("---\nextends: Base\nretired: true\ntags:\n  - a\n  - b\n---\nbody\n"), WANT);
  });

  test("BOM definition parses (pre-fix it read as having no frontmatter → {})", () => {
    assert.deepEqual(
      scanFrontmatter(BOM + "---\nextends: Base\nretired: true\ntags:\n  - a\n  - b\n---\nbody\n"),
      WANT,
    );
  });

  test("CRLF definition parses, including block lists", () => {
    assert.deepEqual(
      scanFrontmatter("---\r\nextends: Base\r\nretired: true\r\ntags:\r\n  - a\r\n  - b\r\n---\r\nbody\r\n"),
      WANT,
    );
  });

  test("no frontmatter yields {} (regression)", () => {
    assert.deepEqual(scanFrontmatter("just a body\n"), {});
  });
});

// ── site 4 LEFT THIS PACKAGE ─────────────────────────────────────────────────
//
// `stripFrontmatter` was `src/kernel/skills/transclude.ts`, the fourth of #189's
// five sites. The skills compiler became its own plugin at the suite split's S4,
// so the site and its four assertions moved with the code, unchanged, to
// packages/skills/tests/transclude-frontmatter.test.mjs. The per-site
// non-vacuity property this file exists for is preserved — it is just enforced
// in the package that now owns the site. THE OTHER FOUR SITES STAY HERE, and a
// sixth site appearing in this package still belongs in this file.

// ── site 5: mcp/tools-complementary.ts obsidian_read_note_parsed body ─────────

import { installObsidianStub, TFile } from "./obsidian-stub.mjs";
installObsidianStub();
const { registerComplementaryTools } = await import("../src/mcp/tools-complementary.ts");

function parsedServer(notes, caches) {
  const files = new Map(Object.keys(notes).map((p) => [p, new TFile(p)]));
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getAbstractFileByPath: (p) => files.get(p) ?? null,
      async read(f) { return notes[f.path]; },
      async cachedRead(f) { return notes[f.path]; },
      getName: () => "TestVault",
    },
    metadataCache: {
      getFileCache: (f) => caches[f.path] ?? null,
      getTags: () => ({}),
      unresolvedLinks: {},
    },
    workspace: { getActiveFile: () => null, activeEditor: null, getActiveViewOfType: () => null },
    internalPlugins: { getPluginById: () => null },
    plugins: { plugins: {} },
  };
  const tools = new Map();
  const ctx = {
    pluginVersion: "0.0.0",
    socketPath: "/tmp/x.sock",
    vaultName: "TestVault",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [] }),
  };
  registerComplementaryTools({ registerTool: (name, def, handler) => tools.set(name, handler) }, app, ctx);
  return (path) => tools.get("obsidian_read_note_parsed")({ path }, {});
}

describe("obsidian_read_note_parsed body strip binds to the shared recognizer (#189)", () => {
  const FM = { kind: "x" };
  const call = (content, cache = { frontmatter: FM }) => {
    const notes = { "N.md": content };
    return parsedServer(notes, { "N.md": cache })("N.md");
  };

  test("LF note: body excludes the frontmatter block, byte-identical to before (regression)", async () => {
    const res = await call("---\nkind: x\n---\n# H\nbody\n");
    assert.equal(res.structuredContent.body, "# H\nbody\n");
  });

  test("CRLF note: body excludes the frontmatter block (the old regex handled CRLF — regression)", async () => {
    const res = await call("---\r\nkind: x\r\n---\r\n# H\r\nbody\r\n");
    assert.equal(res.structuredContent.body, "# H\r\nbody\r\n");
  });

  test("BOM note: body excludes the frontmatter the cache parsed (pre-fix it carried the fence)", async () => {
    const res = await call(BOM + "---\nkind: x\n---\n# H\nbody\n");
    assert.equal(res.structuredContent.body, "# H\nbody\n");
    assert.deepEqual(res.structuredContent.frontmatter, FM);
  });

  test("no cache-recognized frontmatter: content passes through byte-identically (gate preserved)", async () => {
    const res = await call(BOM + "---\nnot: frontmatter per the cache\n---\n", {});
    assert.equal(res.structuredContent.body, BOM + "---\nnot: frontmatter per the cache\n---\n");
  });
});
