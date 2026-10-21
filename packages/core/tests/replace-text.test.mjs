// obsidian_replace_text's plan (replace-text.ts), which both backends run, and the file-system
// backend's replaceText over a temp vault: the write goes through its own writeNote, so the accept
// guard runs on the result. The notes are made up.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMatches, planReplaceText, REPLACE_MAX_SPANS, REPLACE_SPAN_TEXT_CAP } from "../src/index.ts";
import { FilesystemBackend } from "../src/fs-backend/filesystem-backend.ts";

const LIMIT = 1000;
const plan = (text, old, nw, o = {}) => planReplaceText("n.md", text, old, nw, { all: false, limit: LIMIT, ...o });
const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code ?? e.name;
  }
};

describe("findMatches", () => {
  test("left to right, never overlapping", () => {
    assert.deepEqual(findMatches("aaaa", "aa"), [0, 2]);
    assert.deepEqual(findMatches("aaa", "aa"), [0]);
    assert.deepEqual(findMatches("abcabc", "c"), [2, 5]);
    assert.deepEqual(findMatches("abc", ""), []);
  });
});

describe("planReplaceText", () => {
  test("one match, many with all, counts and spans", () => {
    const one = plan("a cat and a dog\n", "cat", "fox");
    assert.equal(one.text, "a fox and a dog\n");
    assert.equal(one.result.count, 1);
    assert.deepEqual(one.result.spans, [{ offset: 2, line: 1, before: "a cat and a dog\n", after: "a fox and a dog\n" }]);
    const many = plan("x\nx\nx\n", "x", "yy", { all: true });
    assert.equal(many.text, "yy\nyy\nyy\n");
    assert.deepEqual(many.result.spans.map((s) => [s.offset, s.line, s.after]), [[0, 1, "yy\nyy\nyy\n"], [2, 2, "yy\nyy\nyy\n"], [4, 3, "yy\nyy\nyy\n"]]);
  });

  test("refusals carry their code and count", () => {
    let e;
    try { plan("x x", "x", "y"); } catch (err) { e = err; }
    assert.equal(e.code, "many_matches");
    assert.equal(e.count, 2);
    try { plan("x x", "z", "y"); } catch (err) { e = err; }
    assert.equal(e.code, "no_match");
    assert.equal(e.count, 0);
    assert.equal(codeOf(() => plan("x", "", "y")), "invalid_replace");
    assert.equal(codeOf(() => plan("x", "x", "x")), "invalid_replace");
  });

  test("spans are capped in length and in number", () => {
    const big = "y".repeat(REPLACE_SPAN_TEXT_CAP * 2);
    const r = plan(`a ${big} b`, big, "z");
    assert.ok(r.result.spans[0].before.length < REPLACE_SPAN_TEXT_CAP + 100);
    assert.match(r.result.spans[0].before, /…\[\d+ chars\]…/);
    const many = plan("q".repeat(REPLACE_MAX_SPANS + 5), "q", "r", { all: true, limit: 10_000 });
    assert.equal(many.result.count, REPLACE_MAX_SPANS + 5);
    assert.equal(many.result.spans.length, REPLACE_MAX_SPANS);
    assert.equal(many.result.spans_truncated, true);
  });

  test("a span's context never splits a surrogate pair", () => {
    const text = "😀".repeat(30) + "X" + "😀".repeat(30);
    const s = plan(text, "X", "Y").result.spans[0];
    for (const t of [s.before, s.after]) assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t), false);
  });

  test("CRLF: no normalisation, a hint when an LF `old` spans lines; the line endings are reported", () => {
    const t = "a\r\nb\r\n";
    assert.throws(() => plan(t, "a\nb", "c"), /CRLF line endings/);
    const r = plan(t, "a\r\nb", "c");
    assert.equal(r.text, "c\r\n");
    assert.equal(r.result.line_endings, "crlf");
    assert.equal(plan("a\nb\r\n", "a", "c").result.line_endings, "mixed");
    assert.equal(plan("ab", "a", "c").result.line_endings, "none");
  });

  test("CRLF frontmatter: a replace inside it is recognized and kept valid", () => {
    const t = "---\r\na: 1\r\nb: 2\r\n---\r\nbody\r\n";
    const r = plan(t, "a: 1", "a: 3");
    assert.equal(r.result.frontmatter_touched, true);
    assert.equal(r.text, "---\r\na: 3\r\nb: 2\r\n---\r\nbody\r\n");
    assert.equal(codeOf(() => plan(t, "2\r\n---", "2")), "frontmatter_edit");
  });

  test("the BOM stays: a match may not start on it; a replace after it is fine", () => {
    const t = "﻿hello\n";
    assert.equal(codeOf(() => plan(t, "﻿hello", "hi")), "invalid_replace");
    assert.equal(plan(t, "hello", "hi").text, "﻿hi\n");
  });

  test("frontmatter rule", () => {
    const t = "---\ntitle: A\n---\nbody\n";
    for (const [old, nw] of [["---\ntitle", "title"], ["A\n---", "A"], ["---\nbody", "body"], ["title: A", "title: A\n---"], ["title: A", "title: [A"]]) {
      assert.equal(codeOf(() => plan(t, old, nw)), "frontmatter_edit", JSON.stringify([old, nw]));
    }
    assert.equal(codeOf(() => plan("body\n", "body", "---\na: 1\n---\nbody")), "frontmatter_edit");
    // A last line may be removed whole (its line break before the fence included); the fence must stay.
    assert.equal(plan("---\na: 1\nb: 2\n---\nbody\n", "b: 2\n", "").text, "---\na: 1\n---\nbody\n");
    assert.equal(codeOf(() => plan("---\na: 1\nb: 2\n---\nbody\n", "2\n", "3")), "frontmatter_edit");
    // A key with no value can be given one; the block stays a mapping.
    assert.equal(plan("---\nk:\n---\nbody\n", "k:", "k: v").text, "---\nk: v\n---\nbody\n");
    assert.equal(plan(t, "body", "text").result.frontmatter_touched, false);
  });

  test("the long-note rule: a match ending past the limit, unless the transport proved a whole read", () => {
    const t = "head " + "x".repeat(LIMIT) + " tail";
    assert.equal(plan(t, "head", "h").text.startsWith("h x"), true);
    assert.equal(codeOf(() => plan(t, "tail", "t")), "truncated_read");
    assert.equal(codeOf(() => plan(t, "x", "y", { all: true })), "truncated_read");
    assert.equal(plan(t, "tail", "t", { rangeRuleStandsAside: true }).text.endsWith(" t"), true);
  });

  test("`new` carrying the read trailer is refused", () => {
    assert.equal(codeOf(() => plan("a", "a", "b\n[truncated: note is 9 chars, showing first 3]")), "truncated_read");
  });
});

describe("FilesystemBackend.replaceText", () => {
  test("writes through writeNote, so the accept guard runs on the result; a missing note is not created", async () => {
    const root = await mkdtemp(join(tmpdir(), "replace-text-"));
    try {
      const note = "---\ntitle: A\nstatus: draft\n---\nbody text\n";
      await writeFile(join(root, "n.md"), note);
      const b = new FilesystemBackend(root);
      const r = await b.replaceText("n.md", "body text", "new text", { all: false });
      assert.equal(r.count, 1);
      assert.equal(await readFile(join(root, "n.md"), "utf8"), "---\ntitle: A\nstatus: draft\n---\nnew text\n");
      await assert.rejects(b.replaceText("n.md", "status: draft", "acceptance-status: accepted", { all: false }), (e) => e.code === "accept_forbidden");
      await assert.rejects(b.replaceText("n.md", "status: draft", "verified:\n  - by: human:pat", { all: false }), (e) => e.code === "accept_forbidden");
      assert.equal(await readFile(join(root, "n.md"), "utf8"), "---\ntitle: A\nstatus: draft\n---\nnew text\n");
      await assert.rejects(b.replaceText("none.md", "a", "b", { all: false }));
      await assert.rejects(readFile(join(root, "none.md"), "utf8"));
      await assert.rejects(b.replaceText("../out.md", "a", "b", { all: false }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
