import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// VAULT_PATH must be set BEFORE the module is imported — vault.ts captures
// VAULT_ROOT at module load. Same dance as index-store.test.ts. On macOS,
// tmpdir() lives under /var → /private/var, so the vault root itself is
// behind a symlink — which exercises the realpath comparison for free.
let tmpRoot: string;
let outsideRoot: string;
let vault: typeof import("../src/fs-backend/vault.js");

before(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "vault-test-"));
  outsideRoot = await mkdtemp(path.join(tmpdir(), "vault-outside-"));
  process.env.VAULT_PATH = tmpRoot;
  vault = await import("../src/fs-backend/vault.js");
});

beforeEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });
});

// Matches the accept-forbidden guard's refusal shape by CODE, not message text —
// AcceptForbiddenError's stringified form is "AcceptForbiddenError: <reason>. ...",
// which does not literally contain "accept_forbidden" (that's the `.code`
// property, per accept-guard.ts).
function isAcceptForbidden(e: unknown): boolean {
  return e instanceof Error && (e as { code?: string }).code === "accept_forbidden";
}

describe("resolveInVault — lexical guards", () => {
  test("resolves a plain relative path inside the vault", () => {
    const abs = vault.resolveInVault("Projects/Plan.md");
    assert.ok(abs.endsWith(path.join("Projects", "Plan.md")));
  });

  test("refuses a path that climbs out of the vault, rather than folding it back in (#444)", () => {
    // Used to be stripped to `etc/passwd` inside the vault and written there
    // silently; a caller that asked for a path outside the vault is told so.
    assert.throws(() => vault.resolveInVault("../../etc/passwd"), /escapes the vault root/);
    assert.throws(() => vault.resolveInVault("../outside.md"), /escapes the vault root/);
    assert.throws(() => vault.resolveInVault("sub/../../outside.md"), /escapes the vault root/);
    assert.throws(() => vault.resolveInVault("/etc/passwd"), /absolute/);
    assert.throws(() => vault.resolveInVault(path.join(tmpRoot, "Plan.md")), /absolute/, "an absolute path inside the vault is refused too: a note has one spelling");
    // Climbing inside the vault is fine.
    assert.ok(vault.resolveInVault("sub/../Plan.md").endsWith(path.join(tmpRoot, "Plan.md")));
  });

  test("a root with a doubled or trailing separator is normalised once, so every path resolves and the root itself is clean (#444)", () => {
    const doubled = vault.createVaultAt(tmpRoot + path.sep + path.sep);
    assert.equal(doubled.root, path.resolve(tmpRoot), "the root is the one spelling");
    assert.ok(doubled.resolveInVault("Projects/Plan.md").endsWith(path.join("Projects", "Plan.md")));
    const trailing = vault.createVaultAt(tmpRoot + path.sep);
    assert.equal(trailing.root, path.resolve(tmpRoot));
    assert.ok(trailing.resolveInVault("Plan.md").endsWith(path.join(tmpRoot, "Plan.md")));
    assert.throws(() => trailing.resolveInVault("../outside.md"), /escapes the vault root/);
  });

  test("a backslash in a path is refused outright, on every platform, typed invalid_path", () => {
    assert.throws(() => vault.resolveInVault("..\\outside.md"), (e) => e.code === "invalid_path" && /backslash/.test(e.message));
    assert.throws(() => vault.resolveInVault("Projects\\Plan.md"), /backslash/);
    assert.throws(() => vault.resolveInVault("../outside.md"), (e) => e.code === "invalid_path");
    assert.throws(() => vault.resolveInVault("/etc/passwd"), (e) => e.code === "invalid_path");
    assert.throws(() => vault.resolveInVault(".git/config"), (e) => e.code === "invalid_path");
  });

  test("refuses ignored folders", () => {
    assert.throws(() => vault.resolveInVault(".obsidian/app.json"), /ignored folder/);
    assert.throws(() => vault.resolveInVault(".git/config"), /ignored folder/);
  });

  test("nonexistent nested path is allowed (writeNote creates parents)", () => {
    const abs = vault.resolveInVault("new/deeply/nested/note.md");
    assert.ok(abs.includes("nested"));
  });
});

describe("resolveInVault — symlink escape guard", () => {
  test("refuses a symlinked FILE pointing outside the vault", async () => {
    const secret = path.join(outsideRoot, "secret.md");
    await writeFile(secret, "outside the vault", "utf8");
    await symlink(secret, path.join(tmpRoot, "link.md"));
    assert.throws(() => vault.resolveInVault("link.md"), /symlink/);
  });

  test("refuses a path THROUGH a symlinked dir pointing outside the vault", async () => {
    const outDir = path.join(outsideRoot, "notes");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "note.md"), "outside", "utf8");
    await symlink(outDir, path.join(tmpRoot, "sub"));
    assert.throws(() => vault.resolveInVault("sub/note.md"), /symlink/);
  });

  test("refuses a NONEXISTENT path under a symlinked dir (write-side escape)", async () => {
    const outDir = path.join(outsideRoot, "writable");
    await mkdir(outDir, { recursive: true });
    await symlink(outDir, path.join(tmpRoot, "drop"));
    // drop/new.md doesn't exist yet — the guard must still catch the dir.
    assert.throws(() => vault.resolveInVault("drop/new.md"), /symlink/);
  });

  test("allows a symlink that stays within the vault", async () => {
    await writeFile(path.join(tmpRoot, "real.md"), "hello", "utf8");
    await symlink(path.join(tmpRoot, "real.md"), path.join(tmpRoot, "alias.md"));
    const abs = vault.resolveInVault("alias.md");
    assert.ok(abs.endsWith("alias.md"));
  });

  test("readNote through an escaping symlink fails", async () => {
    const secret = path.join(outsideRoot, "creds.md");
    await writeFile(secret, "token", "utf8");
    await symlink(secret, path.join(tmpRoot, "creds.md"));
    await assert.rejects(() => vault.readNote("creds.md"), /symlink/);
  });

  test("writeNote into an escaping symlinked dir fails and writes nothing outside", async () => {
    const outDir = path.join(outsideRoot, "target");
    await mkdir(outDir, { recursive: true });
    await symlink(outDir, path.join(tmpRoot, "evil"));
    await assert.rejects(() => vault.writeNote("evil/x.md", "payload", false), /symlink/);
  });
});

// ── Issue #104 — accept-forbidden guard reaches the ACTUAL production write
// path ────────────────────────────────────────────────────────────────────
//
// packages/server's fs-failover mode (fs-mode.ts's makeBackend()) wraps
// THESE module-level singleton functions directly — not the FilesystemBackend
// class. An independent review of the initial #104 patch found the guard
// wired only to FilesystemBackend, which this handler never calls. These
// tests exercise the functions fs-mode.ts actually uses, so a future
// regression that re-wires the guard to the wrong implementation fails here.

describe("accept-forbidden guard — module-level singleton functions (issue #104 production path)", () => {
  test("writeNote with acceptance-status: accepted is REFUSED", async () => {
    await assert.rejects(
      () => vault.writeNote("note.md", "---\nacceptance-status: accepted\n---\nbody", false),
      isAcceptForbidden,
    );
  });

  test("writeNote with a normal (non-accepted) payload SUCCEEDS", async () => {
    const result = await vault.writeNote("note.md", "---\nname: N\n---\nbody", false);
    assert.equal(result.created, true);
  });

  test("REFUSING the write means nothing lands on disk", async () => {
    await assert.rejects(() => vault.writeNote("note.md", "---\naccepted-by: an-agent\n---\nbody", false));
    await assert.rejects(() => vault.readNote("note.md"), /ENOENT|no such file/i);
  });

  test("appendNote creating a NEW note whose fence asserts acceptance is REFUSED", async () => {
    await assert.rejects(
      () => vault.appendNote("note.md", "---\nacceptance-status: accepted\n---\nbody"),
      isAcceptForbidden,
    );
  });

  test("appendNote with an ordinary body SUCCEEDS", async () => {
    const result = await vault.appendNote("note.md", "hello");
    assert.equal(result.created, true);
  });

  test("setFrontmatterField(acceptance-status, accepted) is REFUSED", async () => {
    await vault.writeNote("note.md", "---\nname: N\n---\nbody", false);
    await assert.rejects(
      () => vault.setFrontmatterField("note.md", "acceptance-status", "accepted"),
      isAcceptForbidden,
    );
    const value = await vault.getFrontmatterField("note.md", "acceptance-status");
    assert.equal(value, undefined, "the field must not have been written");
  });

  test("setFrontmatterField with an ordinary key/value SUCCEEDS", async () => {
    await vault.writeNote("note.md", "---\nname: N\n---\nbody", false);
    await vault.setFrontmatterField("note.md", "status", "active");
    assert.equal(await vault.getFrontmatterField("note.md", "status"), "active");
  });

  test("preserving an existing (human-set) accepted value verbatim via setFrontmatterField is ALLOWED", async () => {
    await writeFile(path.join(tmpRoot, "note.md"), "---\nacceptance-status: accepted\n---\nbody", "utf8");
    await vault.setFrontmatterField("note.md", "acceptance-status", "accepted");
    assert.equal(await vault.getFrontmatterField("note.md", "acceptance-status"), "accepted");
  });

  test("patchNote: an anchor resolving to the START of a fence-less note's body is REFUSED for op:\"prepend\" (broader than just the leading-block case)", async () => {
    // findBlock walks backward through contiguous non-blank lines from the
    // anchor, so a SHORT/leading paragraph makes range.start land at 0 even
    // though the anchor token itself is on a later line — the reviewer's
    // finding on the initial #104 patch. Content inserted at range.start=0
    // with no existing frontmatter becomes the note's real leading fence.
    await writeFile(path.join(tmpRoot, "note.md"), "some text\n^anchor\nmore text", "utf8");
    await assert.rejects(
      () =>
        vault.patchNote(
          "note.md",
          { type: "block", value: "anchor" },
          "prepend",
          "---\nacceptance-status: accepted\n---",
        ),
      isAcceptForbidden,
    );
    // And confirm the original content is untouched.
    assert.equal(await vault.readNote("note.md"), "some text\n^anchor\nmore text");
  });

  test("patchNote with an ordinary insertion SUCCEEDS", async () => {
    await writeFile(path.join(tmpRoot, "note.md"), "some text\n^anchor\nmore text", "utf8");
    const result = await vault.patchNote("note.md", { type: "block", value: "anchor" }, "prepend", "inserted");
    assert.equal(result.found, true);
  });

  // patchNote is the SECOND consumer of the shared recognizer's match extent
  // (`fmText = match[0]`, `body = slice(match[0].length)`), so the frontmatter
  // /body boundary moving is felt here as much as in the frontmatter editor.
  // It was untested against that boundary — review of the closer fix caught
  // the omission, and caught the PR describing this function under a name
  // that does not exist in the repo.
  //
  // The property is round-trip losslessness: `fmText` gives back exactly what
  // `body` gives up, so an untouched note comes back byte-identical whatever
  // the closer looks like.
  for (const [name, input] of [
    ["plain", "---\na: 1\n---\nsome text\n^anchor\nmore text\n"],
    ["four-dash closer", "---\na: 1\n----\nsome text\n^anchor\nmore text\n"],
    ["closer with adjacent text", "---\na: 1\n---x\nsome text\n^anchor\nmore text\n"],
    ["CRLF", "---\r\na: 1\r\n---\r\nsome text\r\n^anchor\r\nmore text\r\n"],
    ["BOM + four-dash closer", "﻿---\na: 1\n----\nsome text\n^anchor\nmore text\n"],
  ]) {
    test(`patchNote preserves the frontmatter/body boundary — ${name}`, async () => {
      const file = `patch-${name.replace(/[^a-z]+/gi, "-")}.md`;
      await writeFile(path.join(tmpRoot, file), input, "utf8");
      const result = await vault.patchNote(file, { type: "block", value: "anchor" }, "prepend", "inserted");
      assert.equal(result.found, true);
      const after = await vault.readNote(file);
      // The property is LOSSLESSNESS, not insertion position: removing the one
      // inserted line must give back the original note byte for byte — closer
      // leftovers, BOM, and CRLF included. (Where `prepend` lands legitimately
      // varies: a closer leftover like `-` is body, so it joins the anchored
      // block and the insertion goes ahead of it. Asserting the position would
      // pin an unrelated decision.)
      // A CRLF note takes its inserted line with CRLF too (#596 round 3).
      const inserted = name === "CRLF" ? "inserted\r\n" : "inserted\n";
      assert.ok(after.includes(inserted), `insertion missing: ${JSON.stringify(after)}`);
      assert.equal(after.replace(inserted, ""), input, "a body byte was lost or moved across the fence boundary");
    });
  }
});

// ── Recognition parity (issue #104 / #126 class) ────────────────────────────
//
// The guard must recognize every leading-fence VARIANT the write path itself
// would honor — a guard narrower than reality is a bypass, not caution. These
// pin the three known divergence classes (BOM, CRLF, trailing fence
// whitespace) plus the plain control case, each asserting the write-path
// REFUSES an accepted-family value carried behind that variant. A literal
// U+FEFF byte is never written into this file's source — `"\uFEFF"` is the
// escape, matching accept-guard.ts's own `stripLeadingBom`.

describe("accept-forbidden guard — recognition parity across fence variants", () => {
  const ACCEPTED_BODY = "acceptance-status: accepted\n---\nbody";

  test("plain control case: no BOM/CRLF/trailing-ws is refused", async () => {
    await assert.rejects(() => vault.writeNote("a.md", `---\n${ACCEPTED_BODY}`, false), isAcceptForbidden);
  });

  test("a leading BOM (U+FEFF), stripped exactly once, is refused", async () => {
    const withBom = "\uFEFF---\n" + ACCEPTED_BODY;
    await assert.rejects(() => vault.writeNote("b.md", withBom, false), isAcceptForbidden);
  });

  test("a SECOND leading BOM is content, not a marker — NOT stripped, and correctly leaves the fence unrecognized", async () => {
    // Only ONE BOM is a marker. After stripping it, the text still starts
    // with a second \uFEFF, not `---` — so this is genuinely NOT a
    // recognized frontmatter fence (matches Obsidian, which also only looks
    // past a single BOM). The write succeeds because there is truly no
    // frontmatter to guard, not because the guard failed to look.
    const doubleBom = "\uFEFF\uFEFF---\n" + ACCEPTED_BODY;
    const result = await vault.writeNote("c.md", doubleBom, false);
    assert.equal(result.created, true);
  });

  test("CRLF line endings are refused", async () => {
    const crlf = "---\r\n" + ACCEPTED_BODY.replace(/\n/g, "\r\n");
    await assert.rejects(() => vault.writeNote("d.md", crlf, false), isAcceptForbidden);
  });

  test("trailing spaces/tabs after the opening and closing --- are refused", async () => {
    const trailing = "--- \t\n" + "acceptance-status: accepted\n" + "---\t\nbody";
    await assert.rejects(() => vault.writeNote("e.md", trailing, false), isAcceptForbidden);
  });
});

// ── locateFrontmatter parity — the frontmatter EDITOR recognizes what the
// guard/Obsidian recognize (issue #104 sibling-audit: a narrower editor
// prepends a SECOND frontmatter block instead of editing the real one) ──────

describe("locateFrontmatter parity — frontmatter-edit writes never duplicate an existing fence", () => {
  test("setFrontmatterField on a BOM-prefixed note edits the EXISTING frontmatter, not a duplicate", async () => {
    const withBom = "\uFEFF---\nname: N\n---\nbody";
    await writeFile(path.join(tmpRoot, "bom.md"), withBom, "utf8");
    await vault.setFrontmatterField("bom.md", "status", "active");
    const after = await vault.readNote("bom.md");
    const fenceMarkerCount = (after.match(/---/g) || []).length;
    assert.equal(fenceMarkerCount, 2, "exactly one frontmatter block (2 fence markers) — not a second block prepended");
    assert.match(after, /status: active/);
    assert.match(after, /name: N/);
  });

  test("setFrontmatterField on a CRLF note edits the EXISTING frontmatter, not a duplicate", async () => {
    const crlf = "---\r\nname: N\r\n---\r\nbody";
    await writeFile(path.join(tmpRoot, "crlf.md"), crlf, "utf8");
    await vault.setFrontmatterField("crlf.md", "status", "active");
    const after = await vault.readNote("crlf.md");
    const fenceMarkerCount = (after.match(/---/g) || []).length;
    assert.equal(fenceMarkerCount, 2, "exactly one frontmatter block — not a second block prepended");
    assert.match(after, /status: active/);
  });

  // The tests above count fence markers, which proves the editor RECOGNIZED
  // the fence but says nothing about where it decided the body starts. That
  // boundary moved when the closer became prefix-matched, so it needs its own
  // assertions: an editor that consumes one byte too many silently eats body
  // text, and one that consumes too few silently inserts a line.

  test("a frontmatter edit on a CRLF note does not insert a blank line before the body", async () => {
    const crlf = "---\r\nname: N\r\n---\r\nbody line one\r\nbody line two\r\n";
    await writeFile(path.join(tmpRoot, "crlf-body.md"), crlf, "utf8");
    await vault.setFrontmatterField("crlf-body.md", "status", "active");
    const after = await vault.readNote("crlf-body.md");
    const body = after.slice(after.indexOf("---", 3) + 3).replace(/^\r?\n/, "");
    assert.equal(
      body,
      "body line one\r\nbody line two\r\n",
      "a \\n-only strip leaves the CR of the closer's line break behind as a line of its own",
    );
    assert.ok(!/\n\r\n/.test(after), `stray CR line inserted: ${JSON.stringify(after)}`);
  });

  // The vault closes on the first three dashes and treats the rest of that
  // line as body (probed live). An editor that swallowed the remainder would
  // silently delete content the note visibly has.
  //
  // These assert the WHOLE resulting file, not a suffix or a /match/. An
  // earlier revision asserted `after.endsWith("-\nbody\n")` and was vacuous:
  // the reassembled closing fence is `---`, which itself ends in `-`, so the
  // assertion passed just as well when the leftover dash had been deleted.
  // A partial assertion about a boundary tends to be satisfied by the fence
  // sitting next to it — pin the bytes.
  for (const [name, input, expected] of [
    [
      "four-dash closer",
      "---\nname: N\n----\nbody\n",
      "---\nname: N\nstatus: active\n---\n-\nbody\n",
    ],
    [
      "closer with adjacent text",
      "---\nname: N\n---x\nbody\n",
      "---\nname: N\nstatus: active\n---\nx\nbody\n",
    ],
    [
      "CRLF note whose closer carries text",
      "---\r\nname: N\r\n---x\r\nbody\r\n",
      "---\nname: N\nstatus: active\n---\nx\r\nbody\r\n",
    ],
    [
      "ordinary closer (control)",
      "---\nname: N\n---\nbody\n",
      "---\nname: N\nstatus: active\n---\nbody\n",
    ],
  ]) {
    test(`a frontmatter edit preserves body on the closing fence line — ${name}`, async () => {
      const file = `${name.replace(/[^a-z]+/gi, "-")}.md`;
      await writeFile(path.join(tmpRoot, file), input, "utf8");
      await vault.setFrontmatterField(file, "status", "active");
      assert.equal(await vault.readNote(file), expected);
    });
  }

  test("setFrontmatterField on a note with trailing fence whitespace edits the EXISTING frontmatter, not a duplicate", async () => {
    const trailing = "--- \t\nname: N\n---\t\nbody";
    await writeFile(path.join(tmpRoot, "trailing.md"), trailing, "utf8");
    await vault.setFrontmatterField("trailing.md", "status", "active");
    const after = await vault.readNote("trailing.md");
    const fenceMarkerCount = (after.match(/---/g) || []).length;
    assert.equal(fenceMarkerCount, 2, "exactly one frontmatter block — not a second block prepended");
    assert.match(after, /status: active/);
  });
});

// ── moveNote's backlink rewrite — accept-forbidden guard (issue #104 gap) ───
//
// `rewriteBacklinks`'s `fs.writeFile(absSrc, next, "utf8")` had NO
// `guardWrittenContent` call at all — the only one of the four content-write
// paths on this backend that didn't. No exploit was demonstrated for this
// gap; it's closed on the same "every content write on this backend is
// guarded, no exceptions" basis as the other three, not a proven bypass.

describe("moveNote — backlink rewrite is guarded (issue #104 moveNote gap)", () => {
  test("a backlink rewrite whose resulting content would introduce an accepted-family value is REFUSED", async () => {
    // The rewritten wikilink target is renamed to literally "accepted" — the
    // substituted token `[[accepted]]` is unquoted, so to a real YAML parser
    // it is a NESTED flow sequence (a list containing a list containing the
    // string "accepted"), which `isAcceptedValue` already recurses through.
    // This subset does not attempt to parse nested flow collections at all —
    // it refuses them as unclassifiable (Task 1 of this same fix) — so
    // either way the write must be refused: recognized as accepted, or not
    // confidently ruled out. Exercises the SAME `guardWrittenContent` call
    // now wired into this path.
    await writeFile(
      path.join(tmpRoot, "linker.md"),
      "---\nacceptance-status: [[old-name]]\n---\nbody",
      "utf8",
    );
    await writeFile(path.join(tmpRoot, "old-name.md"), "content", "utf8");

    const backlinksProvider = (p: string) => (p === "old-name.md" ? ["linker.md"] : []);
    const resolveRef = (ref: string) => (ref === "old-name" ? "old-name.md" : undefined);

    // Since #614 the refusal is per note: the note is left unchanged and named
    // in `backlinks_skipped` with the guard's reason, and the move (which has
    // already landed by the time backlinks are rewritten) is not reported as a
    // failure half-done.
    const result = await vault.moveNote("old-name.md", "accepted.md", {
      update_backlinks: true,
      overwrite: false,
      backlinks_provider: backlinksProvider,
      resolve_ref: resolveRef,
    });
    assert.equal(result.backlinks_files_touched, 0);
    assert.equal(result.backlinks_updated, 0);
    assert.equal(result.backlinks_skipped?.length, 1);
    assert.equal(result.backlinks_skipped?.[0].path, "linker.md");
    assert.match(result.backlinks_skipped?.[0].reason ?? "", /^accept_forbidden: /);

    // The backlink file must be untouched — refusal means nothing lands in it.
    const linkerContent = await vault.readNote("linker.md");
    assert.match(linkerContent, /\[\[old-name\]\]/, "the un-rewritten link must still be present");
    assert.doesNotMatch(linkerContent, /\[\[accepted\]\]/);
  });

  test("an ORDINARY backlink rewrite (no acceptance involved) still SUCCEEDS", async () => {
    await writeFile(
      path.join(tmpRoot, "linker.md"),
      "---\nname: N\n---\nSome text [[old-name]] more text",
      "utf8",
    );
    await writeFile(path.join(tmpRoot, "old-name.md"), "content", "utf8");

    const backlinksProvider = (p: string) => (p === "old-name.md" ? ["linker.md"] : []);
    const resolveRef = (ref: string) => (ref === "old-name" ? "old-name.md" : undefined);

    const result = await vault.moveNote("old-name.md", "new-name.md", {
      update_backlinks: true,
      overwrite: false,
      backlinks_provider: backlinksProvider,
      resolve_ref: resolveRef,
    });
    assert.equal(result.backlinks_updated, 1);
    assert.equal(result.backlinks_files_touched, 1);
    const linkerContent = await vault.readNote("linker.md");
    assert.match(linkerContent, /\[\[new-name\]\]/);
  });

  test("preserving an existing (human-set) accepted value verbatim through a backlink rewrite is ALLOWED", async () => {
    // The link lives in the BODY, well away from frontmatter — an ordinary
    // shape, not the exotic wikilink-as-frontmatter-value case above — and
    // the note's PRE-EXISTING acceptance is untouched by the rewrite.
    await writeFile(
      path.join(tmpRoot, "linker.md"),
      "---\nacceptance-status: accepted\n---\nSee [[old-name]] for detail.",
      "utf8",
    );
    await writeFile(path.join(tmpRoot, "old-name.md"), "content", "utf8");

    const backlinksProvider = (p: string) => (p === "old-name.md" ? ["linker.md"] : []);
    const resolveRef = (ref: string) => (ref === "old-name" ? "old-name.md" : undefined);

    const result = await vault.moveNote("old-name.md", "new-name.md", {
      update_backlinks: true,
      overwrite: false,
      backlinks_provider: backlinksProvider,
      resolve_ref: resolveRef,
    });
    assert.equal(result.backlinks_files_touched, 1);
    const linkerContent = await vault.readNote("linker.md");
    assert.match(linkerContent, /\[\[new-name\]\]/);
    assert.match(linkerContent, /acceptance-status: accepted/);
  });
});


// ── #614: every backlink rewrite of a move passes the written-content guard ──
//
// A link inside a `verified` entry, an acceptance key or a declared protected
// property is never rewritten: that note is left unchanged and named in
// `backlinks_skipped` with the guard's reason; links in other keys and in the
// body are rewritten as before, and the rest of the move lands.
describe("#614 moveNote: the written-content guard on every backlink rewrite", () => {
  const VERIFIED = "---\nverified:\n  - by: \"human:someone\"\n    at: 2026-01-02\n    note: \"see [[old-name]]\"\n---\nBody [[old-name]]\n";
  const ORDINARY = "---\nrelated: \"[[old-name]]\"\n---\nBody [[old-name]]\n";
  const ACCEPT_KEY = "---\nacceptance-status: \"[[old-name]]\"\n---\nBody [[old-name]]\n";
  const DIVERGE = "---\nverified:\n  - by: \"human:someone\"\n    at: 2026-01-02\nrelated: '[[old-name]]'\n---\nBody [[old-name]]\n";
  const move = (to: string, sources: string[]) =>
    vault.moveNote("old-name.md", to, {
      update_backlinks: true,
      overwrite: false,
      backlinks_provider: (p: string) => (p === "old-name.md" ? sources : []),
      resolve_ref: (ref: string) => (ref === "old-name" ? "old-name.md" : undefined),
    });
  const reasonOf = (r: { backlinks_skipped?: Array<{ path: string; reason: string }> }, p: string) => r.backlinks_skipped?.find((x) => x.path === p)?.reason ?? "";

  test("a verified entry's link and an acceptance key's link are not rewritten and are reported; an ordinary key and the body are rewritten", async () => {
    await writeFile(path.join(tmpRoot, "old-name.md"), "content", "utf8");
    await writeFile(path.join(tmpRoot, "v.md"), VERIFIED, "utf8");
    await writeFile(path.join(tmpRoot, "o.md"), ORDINARY, "utf8");
    await writeFile(path.join(tmpRoot, "b.md"), "Body [[old-name]]\n", "utf8");
    await writeFile(path.join(tmpRoot, "k.md"), ACCEPT_KEY, "utf8");
    const r = await move("new-name.md", ["v.md", "o.md", "b.md", "k.md"]);
    assert.equal(await vault.readNote("v.md"), VERIFIED);
    assert.match(reasonOf(r, "v.md"), /^accept_forbidden: .*verification field 'verified'/);
    assert.equal(await vault.readNote("k.md"), ACCEPT_KEY);
    assert.match(reasonOf(r, "k.md"), /^accept_forbidden: a link rewrite would change the guarded frontmatter key 'acceptance-status'/);
    assert.equal(await vault.readNote("o.md"), "---\nrelated: \"[[new-name]]\"\n---\nBody [[new-name]]\n");
    assert.equal(await vault.readNote("b.md"), "Body [[new-name]]\n");
    assert.equal(r.backlinks_files_touched, 2);
    assert.equal(r.backlinks_updated, 3, "only the links actually written are counted");
    assert.equal(await vault.readNote("new-name.md"), "content", "the move itself lands");
  });

  test("a rewrite that YAML would read differently in a block holding a guarded key is refused", async () => {
    await writeFile(path.join(tmpRoot, "old-name.md"), "content", "utf8");
    await writeFile(path.join(tmpRoot, "d.md"), DIVERGE, "utf8");
    const r = await move("It's.md", ["d.md"]);
    assert.equal(await vault.readNote("d.md"), DIVERGE);
    assert.match(reasonOf(r, "d.md"), /^accept_forbidden: .*cannot read as YAML does/);
  });

  test("an ordinary move reports no backlinks_skipped key at all", async () => {
    await writeFile(path.join(tmpRoot, "old-name.md"), "content", "utf8");
    await writeFile(path.join(tmpRoot, "b.md"), "Body [[old-name]]\n", "utf8");
    const r = await move("new-name.md", ["b.md"]);
    assert.equal("backlinks_skipped" in r, false);
  });
});
