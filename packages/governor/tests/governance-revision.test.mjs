/**
 * governance-revision.test.mjs — the revision round-trip's pure content
 * machinery (#101): callout insert/remove + the submit-revision transform
 * (governor/kernel/revision.ts).
 *
 * Pinned properties:
 *   • insertion lands DIRECTLY BELOW the note's H1; a note with no H1 gets the
 *     callout at the top of the body (after frontmatter);
 *   • frontmatter boundaries come from the shared core recognizer — BOM and
 *     CRLF notes split exactly where the vault honors the fence, never a
 *     bespoke /^---/;
 *   • removal removes ONLY [!revision-request] blocks — other callouts
 *     (including [!revision-report]) and all surrounding content survive
 *     byte-for-byte, and insert→remove round-trips to the original body;
 *   • CRLF notes keep CRLF for inserted lines;
 *   • (setAcceptanceStatusProposed was removed by #599; nothing writes the status) (it takes
 *     no value parameter — structurally cannot write an accepted family value)
 *     and preserves the rest of the frontmatter block verbatim;
 *   • planSubmitRevision = proposed + requests removed + optional report.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  splitNote,
  buildRevisionCallout,
  h1LineIndex,
  insertCalloutBelowH1,
  removeRevisionRequestCallouts,
  insertRevisionRequest,
  withdrawRevisionRequests,
  planSubmitRevision,
} from "../src/kernel/revision.ts";

const BOM = String.fromCharCode(0xfeff);
const FM = "---\nacceptance-status: revising\nuid: abc\n---\n";

// ── splitNote: the shared-recognizer boundary ────────────────────────────────

describe("splitNote — frontmatter boundary via the shared core recognizer", () => {
  test("no frontmatter: head empty, body is everything", () => {
    assert.deepEqual(splitNote("# T\nbody\n"), { head: "", body: "# T\nbody\n" });
  });

  test("LF frontmatter: head ends after the closer + one terminator", () => {
    const { head, body } = splitNote(FM + "# T\nbody\n");
    assert.equal(head, FM);
    assert.equal(body, "# T\nbody\n");
  });

  test("CRLF frontmatter splits at the honored fence (not blind to \\r\\n)", () => {
    const content = "---\r\na: 1\r\n---\r\n# T\r\nbody\r\n";
    const { head, body } = splitNote(content);
    assert.equal(head, "---\r\na: 1\r\n---\r\n");
    assert.equal(body, "# T\r\nbody\r\n");
  });

  test("BOM-prefixed frontmatter is still seen; the BOM stays in the head", () => {
    const { head, body } = splitNote(BOM + FM + "body");
    assert.equal(head, BOM + FM);
    assert.equal(body, "body");
  });

  test("head + body always re-joins to the original content", () => {
    for (const c of ["x", FM + "b", BOM + FM + "# H\nb", "---\r\na: 1\r\n---\r\nb", "---\nunclosed"]) {
      const { head, body } = splitNote(c);
      assert.equal(head + body, c);
    }
  });
});

// ── callout building + H1 placement ──────────────────────────────────────────

describe("buildRevisionCallout + h1LineIndex", () => {
  test("multi-line text quotes every line; blank lines become bare '>'", () => {
    assert.deepEqual(buildRevisionCallout("revision-request", "Requested changes", "a\n\nb", "2026-08-18"), [
      "> [!revision-request] Requested changes (2026-08-18)",
      "> a",
      ">",
      "> b",
    ]);
  });

  test("h1 detection: first ATX H1, skipping code fences; H2 is not an H1", () => {
    assert.equal(h1LineIndex(["intro", "# Title", "body"]), 1);
    assert.equal(h1LineIndex(["## Sub", "body"]), -1);
    assert.equal(h1LineIndex(["```", "# in a fence", "```", "# Real"]), 3);
    assert.equal(h1LineIndex(["no heading at all"]), -1);
  });

  test("fence tracking is per MARKER: a ``` inside a ~~~ fence is content, not a closer (review #228.1)", () => {
    // The "``` example wrapped in ~~~" doc pattern: the H1 inside the tilde fence must be
    // skipped; the real H1 after the fence closes is the insertion anchor.
    assert.equal(h1LineIndex(["~~~", "```", "# inside tilde fence", "~~~", "# Real"]), 4);
    // And symmetrically for a ~~~ inside a ``` fence.
    assert.equal(h1LineIndex(["```", "~~~", "# inside backtick fence", "```", "# Real"]), 4);
  });
});

describe("insertCalloutBelowH1", () => {
  const CO = ["> [!revision-request] Requested changes (2026-08-18)", "> fix it"];

  test("directly below the H1, blank-line separated from following content", () => {
    assert.equal(
      insertCalloutBelowH1("# T\nContent\n", CO),
      "# T\n\n> [!revision-request] Requested changes (2026-08-18)\n> fix it\n\nContent\n",
    );
  });

  test("an existing blank line after the H1 is not doubled", () => {
    assert.equal(
      insertCalloutBelowH1("# T\n\nContent\n", CO),
      "# T\n\n> [!revision-request] Requested changes (2026-08-18)\n> fix it\n\nContent\n",
    );
  });

  test("no H1 ⇒ at the very top of the body, blank-line separated", () => {
    assert.equal(
      insertCalloutBelowH1("Content\n", CO),
      "> [!revision-request] Requested changes (2026-08-18)\n> fix it\n\nContent\n",
    );
  });

  test("empty body ⇒ just the callout", () => {
    assert.equal(insertCalloutBelowH1("", CO), CO.join("\n") + "\n");
  });

  test("CRLF body ⇒ CRLF-joined insertion", () => {
    const out = insertCalloutBelowH1("# T\r\nContent\r\n", CO);
    assert.equal(out, "# T\r\n\r\n> [!revision-request] Requested changes (2026-08-18)\r\n> fix it\r\n\r\nContent\r\n");
  });
});

// ── removal ──────────────────────────────────────────────────────────────────

describe("removeRevisionRequestCallouts — surgical, request-callouts only", () => {
  test("removes the block + its quoted continuation; preserves everything else", () => {
    const body =
      "# T\n\n> [!revision-request] Requested changes (2026-08-18)\n> fix it\n> > nested quote\n\nContent\n";
    const { body: out, removed } = removeRevisionRequestCallouts(body);
    assert.equal(removed, 1);
    assert.equal(out, "# T\n\nContent\n");
  });

  test("removes MULTIPLE request callouts in one pass", () => {
    const body =
      "# T\n\n> [!revision-request] Requested changes (2026-08-01)\n> first\n\nMiddle\n\n" +
      "> [!revision-request] Requested changes (2026-08-18)\n> second\n\nEnd\n";
    const { body: out, removed } = removeRevisionRequestCallouts(body);
    assert.equal(removed, 2);
    assert.equal(out, "# T\n\nMiddle\n\nEnd\n");
  });

  test("preserves UNRELATED callouts — [!note] and [!revision-report] survive verbatim", () => {
    const body =
      "# T\n\n> [!note] keep me\n> noted\n\n> [!revision-request] Requested changes (2026-08-18)\n> fix\n\n" +
      "> [!revision-report] Revision report (2026-08-17)\n> did things\n\nContent\n";
    const { body: out, removed } = removeRevisionRequestCallouts(body);
    assert.equal(removed, 1);
    assert.equal(
      out,
      "# T\n\n> [!note] keep me\n> noted\n\n> [!revision-report] Revision report (2026-08-17)\n> did things\n\nContent\n",
    );
  });

  test("case-insensitive callout type (Obsidian semantics)", () => {
    const { removed } = removeRevisionRequestCallouts("> [!Revision-Request] X\n> y\n");
    assert.equal(removed, 1);
  });

  test("no request callout ⇒ body unchanged, removed 0", () => {
    const body = "# T\n\n> [!warning] not ours\nContent\n";
    assert.deepEqual(removeRevisionRequestCallouts(body), { body, removed: 0 });
  });

  test("CRLF bodies stay CRLF after removal", () => {
    const body = "# T\r\n\r\n> [!revision-request] R (d)\r\n> x\r\n\r\nContent\r\n";
    assert.equal(removeRevisionRequestCallouts(body).body, "# T\r\n\r\nContent\r\n");
  });

  test("a callout with NO trailing blank never merges the surrounding paragraphs (review #228.2)", () => {
    // e.g. the revising agent edited around the callout: content follows it directly. The
    // preceding blank must SURVIVE — eating it would glue para1 and para2 into one paragraph.
    const body = "para1\n\n> [!revision-request] R (d)\n> x\npara2\n";
    assert.deepEqual(removeRevisionRequestCallouts(body), { body: "para1\n\npara2\n", removed: 1 });
  });

  test("a trailing callout at EOF still collapses its preceding separator blank", () => {
    const body = "para\n\n> [!revision-request] R (d)\n> x";
    assert.deepEqual(removeRevisionRequestCallouts(body), { body: "para", removed: 1 });
  });
});

// ── full-content round trips ─────────────────────────────────────────────────

describe("insert → withdraw round-trips to the original content", () => {
  const cases = {
    "H1 + frontmatter": FM + "# T\n\nContent\n",
    "no H1": FM + "Content only\n",
    "CRLF": "---\r\nacceptance-status: revising\r\n---\r\n# T\r\n\r\nContent\r\n",
    "BOM + H1": BOM + FM + "# T\n\nContent\n",
    "no frontmatter": "# T\n\nContent\n",
  };
  for (const [name, original] of Object.entries(cases)) {
    test(`round-trip: ${name}`, () => {
      const inserted = insertRevisionRequest(original, "please fix\nthe thing", "2026-08-18");
      assert.notEqual(inserted, original, "insertion must change the note");
      assert.match(inserted, /\[!revision-request\]/);
      const { content: withdrawn, removed } = withdrawRevisionRequests(inserted);
      assert.equal(removed, 1);
      assert.equal(withdrawn, original);
    });
  }

  test("the ONE round-trip normalization: content that hugged its H1 gains the blank separator", () => {
    // `# T\nContent` and `# T\n\nContent` produce IDENTICAL inserted bytes (the callout must be
    // blank-line separated on both sides), so removal cannot know which original it came from —
    // it deterministically restores the canonical `# T\n\nContent` form. Documented, pinned.
    const inserted = insertRevisionRequest("# T\nContent\n", "x", "2026-08-18");
    assert.equal(inserted, insertRevisionRequest("# T\n\nContent\n", "x", "2026-08-18"));
    assert.equal(withdrawRevisionRequests(inserted).content, "# T\n\nContent\n");
  });

  test("the request callout sits DIRECTLY below the H1, above prior content", () => {
    const out = insertRevisionRequest(FM + "# Title\n\nBody text\n", "shorten this", "2026-08-18");
    assert.equal(
      out,
      FM + "# Title\n\n> [!revision-request] Requested changes (2026-08-18)\n> shorten this\n\nBody text\n",
    );
  });
});

// ── planSubmitRevision ───────────────────────────────────────────────────────

describe("planSubmitRevision — request removed + optional report, frontmatter untouched", () => {
  const revising =
    FM + "# T\n\n> [!revision-request] Requested changes (2026-08-01)\n> fix the intro\n\nContent\n";

  test("full flow with a summary: status untouched, request removed, report inserted below H1", () => {
    const plan = planSubmitRevision(revising, { summary: "rewrote the intro", date: "2026-08-18" });
    assert.equal(plan.removedRequests, 1);
    assert.equal(plan.reportInserted, true);
    assert.equal(
      plan.content,
      "---\nacceptance-status: revising\nuid: abc\n---\n" +
        "# T\n\n> [!revision-report] Revision report (2026-08-18)\n> rewrote the intro\n\nContent\n",
    );
  });

  test("no summary: no report callout, requests still removed, status untouched", () => {
    const plan = planSubmitRevision(revising, { date: "2026-08-18" });
    assert.equal(plan.reportInserted, false);
    assert.equal(plan.content, "---\nacceptance-status: revising\nuid: abc\n---\n# T\n\nContent\n");
  });

  test("a whitespace-only summary counts as no summary", () => {
    const plan = planSubmitRevision(revising, { summary: "   ", date: "2026-08-18" });
    assert.equal(plan.reportInserted, false);
  });

  test("the plan writes none of acceptance-status, accepted-by, accepted-on: the frontmatter is byte-identical (#599)", () => {
    const plan = planSubmitRevision(revising, { summary: "x", date: "2026-08-18" });
    const fm = (c) => c.slice(0, c.indexOf("\n---", 4));
    assert.equal(fm(plan.content), fm(revising));
    assert.ok(!/accepted-by|accepted-on/.test(plan.content));
  });

  test("multiple outstanding requests are ALL removed on submit", () => {
    const two =
      FM +
      "# T\n\n> [!revision-request] Requested changes (2026-08-01)\n> a\n\n" +
      "> [!revision-request] Requested changes (2026-08-02)\n> b\n\nContent\n";
    const plan = planSubmitRevision(two, { date: "2026-08-18" });
    assert.equal(plan.removedRequests, 2);
    assert.ok(!plan.content.includes("[!revision-request]"));
  });

  test("an existing [!revision-report] from a prior round is PRESERVED (reviewer disposes of reports)", () => {
    const withReport =
      FM + "# T\n\n> [!revision-report] Revision report (2026-08-01)\n> round one\n\n" +
      "> [!revision-request] Requested changes (2026-08-02)\n> more\n\nContent\n";
    const plan = planSubmitRevision(withReport, { date: "2026-08-18" });
    assert.match(plan.content, /Revision report \(2026-08-01\)/);
    assert.ok(!plan.content.includes("[!revision-request]"));
  });

  test("CRLF note: the whole plan keeps CRLF", () => {
    const crlf =
      "---\r\nacceptance-status: revising\r\n---\r\n# T\r\n\r\n> [!revision-request] R (d)\r\n> x\r\n\r\nC\r\n";
    const plan = planSubmitRevision(crlf, { summary: "done", date: "2026-08-18" });
    assert.ok(!plan.content.replace(/\r\n/g, "").includes("\n"), "no bare LF may appear in a CRLF note");
    assert.match(plan.content, /acceptance-status: revising\r\n/);
  });
});
