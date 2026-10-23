/**
 * append-at-heading-accept.test.mjs — the accept-forbidden guard on
 * obsidian_append_at_heading (#109).
 *
 * The tool writes via raw app.vault.modify/append/create, OUTSIDE the shared
 * write primitive, so the accept-forbidden check the primitive enforces never
 * ran here. #109 routes the RESULTING full-note content through the SAME
 * transition predicate the backend uses (acceptTransitionReason /
 * parseGuardFrontmatter). These tests pin:
 *   (a) an append whose RESULT would introduce an accepted fence is REFUSED
 *       (typed accept_forbidden) and NOTHING is written; and
 *   (b) ordinary appends still SUCCEED, across all three code paths
 *       (existing-section insert, append-new-heading, create_if_missing new note).
 *
 * The handler does `file instanceof TFile`, so the "obsidian" specifier is
 * pointed at the stub before importing it (the link-healing.test.mjs pattern).
 *
 * On the LEADING-frontmatter transition guard: the create path wraps content as
 * `# heading\n\nbody`, which structurally cannot become leading frontmatter, so
 * a body-level accepted fence there is permitted (it is body, not the note's
 * acceptance) — the guard is future-proofing on that path, and the (b) test
 * confirms it does not over-refuse. The refusals in (a) are driven on the two
 * paths where the write can actually reach the leading fence: an existing-section
 * insert whose (mis-offset) heading lands the write inside the frontmatter, and
 * an append onto a note whose leading fence is still open, closed by the appended
 * content — both the real "a change to this tool escapes the perimeter" shape.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { installObsidianStub, TFile } from "./obsidian-stub.mjs";
import { fakeServer } from "./fake-server.mjs";

installObsidianStub();
const { registerComplementaryTools } = await import("../src/mcp/tools-complementary.ts");
const { structureTiming } = await import("../src/mcp/note-structure.ts");
// This harness has no Obsidian parse, so a cache that does not hold waits this long.
structureTiming.cacheWaitMs = 20;

// ── a fake vault that records every write ─────────────────────────────────────

/**
 * `files` maps path → { text, cache } where cache is the metadataCache entry
 * (headings). Spies record create/append/modify so "nothing was written" is a
 * real assertion.
 */
function harness(files = {}) {
  const tree = new Map();
  for (const [p, { text, cache }] of Object.entries(files)) {
    const f = new TFile(p);
    tree.set(p, { file: f, text, cache: cache ?? { headings: [] } });
  }
  const calls = { create: [], append: [], modify: [] };
  const app = {
    vault: {
      getAbstractFileByPath: (p) => tree.get(p)?.file ?? null,
      async read(file) {
        return tree.get(file.path).text;
      },
      async create(p, content) {
        calls.create.push([p, content]);
      },
      async append(file, content) {
        calls.append.push([file.path, content]);
      },
      async modify(file, content) {
        calls.modify.push([file.path, content]);
      },
    },
    metadataCache: {
      getFileCache: (file) => tree.get(file.path)?.cache ?? null,
    },
  };
  const ctx = { getSettings: () => ({ allowlist: [] }) };
  const server = fakeServer();
  registerComplementaryTools(server, app, ctx);
  return { handler: server.tools.get("obsidian_append_at_heading").handler, calls };
}

const isAcceptForbidden = (res) =>
  res.isError === true && /Error \[accept_forbidden\]/.test(res.content[0].text);

// ── (a) REFUSED, nothing written ──────────────────────────────────────────────

describe("obsidian_append_at_heading — accept-forbidden guard refuses (#109)", () => {
  test("existing-section insert: a cache that mis-reports offsets INSIDE the leading frontmatter is not used (#593): cache_mismatch, nothing written", async () => {
    // Two headings, both mis-reported at offsets inside the leading
    // frontmatter. Before #593 the section-insert landed the content between
    // `foo: bar` and the closing `---`, and only this guard stopped it. Now
    // the offsets are checked against the text, which has no heading H.
    const text = "---\nfoo: bar\n---\n\nbody\n";
    const cache = {
      headings: [
        { heading: "H", level: 2, position: { start: { line: 1, offset: 4 } } },
        { heading: "Next", level: 2, position: { start: { line: 2, offset: 13 } } },
      ],
    };
    const { handler, calls } = harness({ "N.md": { text, cache } });
    const res = await handler({ path: "N.md", heading: "H", content: "accepted-by: hacker", create_if_missing: false });
    assert.match(res.content[0].text, /^Error \[cache_mismatch\]/);
    assert.equal(calls.modify.length, 0, "nothing written");
  });

  test("existing-section insert: a write that closes an open leading fence and introduces an accepted key is refused", async () => {
    // The fence is still OPEN, so `## H` is a heading of the body; appending
    // at the end of its section closes the fence, and the resulting leading
    // frontmatter would gain `accepted-by`.
    const text = "---\nfoo: bar\n## H\n";
    const at = text.indexOf("## H");
    const cache = { headings: [{ heading: "H", level: 2, position: { start: { line: 2, offset: at }, end: { line: 2, offset: at + 4 } } }] };
    const { handler, calls } = harness({ "N.md": { text, cache } });
    const res = await handler({ path: "N.md", heading: "H", content: "accepted-by: hacker\n---", create_if_missing: false });
    assert.ok(isAcceptForbidden(res), res.content[0].text);
    assert.equal(calls.modify.length, 0, "nothing written");
  });

  test("append-new-heading: appended content that closes an open leading fence with an accepted key is refused", async () => {
    // The note's leading fence is still OPEN (no closing `---`), so it currently
    // has NO frontmatter; the appended content closes it and asserts acceptance.
    const text = "---\nfoo: bar\n";
    // The cache Obsidian gives an open fence and no heading: none.
    const cache = { headings: [] };
    const { handler, calls } = harness({ "N.md": { text, cache } });
    const res = await handler({
      path: "N.md",
      heading: "New",
      content: "accepted-by: hacker\n---",
      create_if_missing: true,
    });
    assert.ok(isAcceptForbidden(res), res.content[0].text);
    assert.equal(calls.append.length, 0, "nothing written");
  });

  test("existing-section insert into a proposed note: a mis-offset cache is not used (#593): cache_mismatch, nothing written", async () => {
    // The note carries a human `acceptance-status: proposed`; before #593 a
    // mis-offset insert landed inside the fence and ADDED `accepted-by`, and
    // only this guard stopped it. Now the offsets are checked against the text.
    const text = "---\nacceptance-status: proposed\n---\n\nbody\n";
    const cache = {
      headings: [
        { heading: "H", level: 2, position: { start: { line: 1, offset: 4 } } },
        { heading: "Next", level: 2, position: { start: { line: 2, offset: 32 } } },
      ],
    };
    const { handler, calls } = harness({ "N.md": { text, cache } });
    // Offset 4 is the start of `acceptance-status`; offset 32 the closing `---`.
    const res = await handler({ path: "N.md", heading: "H", content: "accepted-by: x", create_if_missing: false });
    assert.match(res.content[0].text, /^Error \[cache_mismatch\]/);
    assert.equal(calls.modify.length, 0, "nothing written");
  });

  test("existing-section insert that closes an open fence carrying a proposed status and adds an accepted-provenance key is refused", async () => {
    const text = "---\nacceptance-status: proposed\n## H\n";
    const at = text.indexOf("## H");
    const cache = { headings: [{ heading: "H", level: 2, position: { start: { line: 2, offset: at }, end: { line: 2, offset: at + 4 } } }] };
    const { handler, calls } = harness({ "N.md": { text, cache } });
    const res = await handler({ path: "N.md", heading: "H", content: "accepted-by: x\n---", create_if_missing: false });
    assert.ok(isAcceptForbidden(res), res.content[0].text);
    assert.equal(calls.modify.length, 0, "nothing written");
  });
});

// ── (b) ordinary appends SUCCEED across all three paths ───────────────────────

describe("obsidian_append_at_heading — ordinary appends still succeed (#109)", () => {
  test("existing-section insert of clean body content succeeds, even into an already-accepted note (preserve is allowed)", async () => {
    const text = "---\nacceptance-status: accepted\n---\n\n## Log\n\nold entry\n";
    // Real heading offsets: "## Log" begins at offset 32.
    const logOffset = text.indexOf("## Log");
    const cache = { headings: [{ heading: "Log", level: 2, position: { start: { line: 4, offset: logOffset }, end: { line: 4, offset: logOffset + 6 } } }] };
    const { handler, calls } = harness({ "N.md": { text, cache } });
    const res = await handler({ path: "N.md", heading: "Log", content: "new entry", create_if_missing: false });
    assert.notEqual(res.isError, true, res.content[0].text);
    assert.equal(calls.modify.length, 1);
    // The human-granted accepted value is carried forward unchanged.
    assert.match(calls.modify[0][1], /acceptance-status: accepted/);
    assert.match(calls.modify[0][1], /new entry/);
  });

  test("append-new-heading of clean content succeeds", async () => {
    const text = "---\nacceptance-status: proposed\n---\n\n## Existing\n\nbody\n";
    const at = text.indexOf("## Existing");
    const cache = { headings: [{ heading: "Existing", level: 2, position: { start: { line: 4, offset: at }, end: { line: 4, offset: at + 11 } } }] };
    const { handler, calls } = harness({ "N.md": { text, cache } });
    const res = await handler({ path: "N.md", heading: "Brand New", content: "hello", create_if_missing: true });
    assert.notEqual(res.isError, true, res.content[0].text);
    // Written as the whole note, only if it still holds the text read (#596).
    assert.equal(calls.modify.length, 1);
    assert.match(calls.modify[0][1], /## Brand New/);
  });

  test("create_if_missing new note succeeds (a body-level fence cannot become leading frontmatter)", async () => {
    const { handler, calls } = harness({});
    // Even a body that literally contains an accepted fence is fine here: it lands
    // under the `# heading`, so it is body, never the note's acceptance.
    const res = await handler({
      path: "Fresh.md",
      heading: "Title",
      content: "---\nacceptance-status: accepted\n---",
      create_if_missing: true,
    });
    assert.notEqual(res.isError, true, res.content[0].text);
    assert.equal(calls.create.length, 1);
    assert.match(calls.create[0][1], /^# Title/);
  });
});
