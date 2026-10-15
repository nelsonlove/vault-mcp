/**
 * conformance-snapshot.test.mjs — the headless vault reader.
 *
 * Walks a root, reads .md + .fileclass files, parses frontmatter (reusing
 * @vault-mcp/core's parseAllFrontmatter — no new dependency), and produces the
 * VaultSnapshot the packs consume. Vault-relative paths; excludedRoots honored
 * (the seam that keeps archaeology out of the rail, aligned with worker-3's B).
 *
 * `boundary: root` is passed on every legacy fixture call below because
 * buildSnapshot now refuses to walk without a declared boundary (#157) — see
 * the "territory guard" describe blocks at the bottom of this file for the
 * new coverage that motivated it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSnapshot } from "../src/kernel/snapshot.ts";
import { LEGACY_TERRITORY_SEED as SEED } from "../../core/src/territories.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "conf-snap-"));
  await mkdir(path.join(root, "Notes"), { recursive: true });
  await mkdir(path.join(root, "Reg"), { recursive: true });
  await mkdir(path.join(root, "Archaeology"), { recursive: true });
  await writeFile(path.join(root, "Notes", "A.md"), "---\ntitle: A\ntags:\n  - rogue\n---\n\nbody A\n");
  await writeFile(path.join(root, "Reg", "Default.fileclass"), "---\n---\n");
  await writeFile(path.join(root, "Archaeology", "Old.md"), "---\ntitle: Old\n---\n\nold\n");
  return root;
}

describe("buildSnapshot", () => {
  test("reads .md + .fileclass under root into notes with vault-relative paths + parsed frontmatter", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root, boundary: root });
      const byPath = Object.fromEntries(snap.notes.map((n) => [n.path, n]));
      assert.ok(byPath["Notes/A.md"], "A.md present");
      assert.equal(byPath["Notes/A.md"].frontmatter.title, "A");
      assert.deepEqual(byPath["Notes/A.md"].frontmatter.tags, ["rogue"]);
      assert.ok(byPath["Notes/A.md"].body.includes("body A"));
      assert.ok(byPath["Reg/Default.fileclass"], ".fileclass included (vocab types)");
      assert.ok(snap.paths.includes("Notes/A.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("excludedRoots drops a whole subtree (archaeology stays out of the rail)", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root, boundary: root, excludedRoots: ["Archaeology"] });
      assert.equal(snap.notes.some((n) => n.path.startsWith("Archaeology/")), false);
      assert.equal(snap.paths.some((p) => p.startsWith("Archaeology/")), false);
      assert.ok(snap.notes.some((n) => n.path === "Notes/A.md"), "non-excluded notes still present");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("paths is markdown-only; notes includes .fileclass too", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root, boundary: root });
      assert.equal(snap.paths.some((p) => p.endsWith(".fileclass")), false, "paths (scheme listing) is .md only");
      assert.ok(snap.notes.some((n) => n.path.endsWith(".fileclass")), "notes (vocab listing) has .fileclass");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildSnapshot CRLF", () => {
  test("a CRLF-authored note still parses frontmatter (not silently skipped)", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const p = (await import("node:path")).default;
    const { buildSnapshot } = await import("../src/kernel/snapshot.ts");
    const root = await mkdtemp(p.join(tmpdir(), "conf-crlf-"));
    try {
      await mkdir(p.join(root, "N"), { recursive: true });
      await writeFile(p.join(root, "N", "C.md"), "---\r\ntitle: C\r\ntags:\r\n  - rogue\r\n---\r\n\r\nbody\r\n");
      const snap = await buildSnapshot({ root, boundary: root });
      const note = snap.notes.find((n) => n.path === "N/C.md");
      assert.equal(note.frontmatter.title, "C");
      assert.deepEqual(note.frontmatter.tags, ["rogue"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The two halves of splitNote must agree about where the body starts (#150).
 *
 * The failure this pins is not "the note is skipped" — it is worse, because it
 * is invisible: the frontmatter parses fine through core while the body split
 * misses the same fence, so the note is read with its own frontmatter STILL
 * INSIDE its body. Every pack that greps the body then matches against YAML it
 * was never supposed to see.
 *
 * Asserting `body.includes("body")` does NOT catch this — it passes either way.
 * The assertion has to be that the frontmatter is ABSENT from the body.
 */
describe("buildSnapshot — frontmatter never leaks into the body", () => {
  for (const [name, text] of [
    ["BOM-prefixed", "﻿---\ntitle: B\nsecret-key: leaked\n---\n\nbody B\n"],
    ["CRLF", "---\r\ntitle: B\r\nsecret-key: leaked\r\n---\r\n\r\nbody B\r\n"],
    ["trailing fence whitespace", "--- \ntitle: B\nsecret-key: leaked\n--- \n\nbody B\n"],
  ]) {
    test(`${name} — body carries no frontmatter`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "conf-split-"));
      try {
        await mkdir(path.join(root, "N"), { recursive: true });
        await writeFile(path.join(root, "N", "B.md"), text);
        const snap = await buildSnapshot({ root, boundary: root });
        const note = snap.notes.find((n) => n.path === "N/B.md");
        assert.equal(note.frontmatter.title, "B", "frontmatter half must recognize the fence");
        assert.ok(note.body.includes("body B"), "the real body must survive");
        assert.ok(
          !note.body.includes("secret-key"),
          `the body half missed the fence the frontmatter half found: ${JSON.stringify(note.body)}`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

/**
 * buildSnapshot territory guard — #157.
 *
 * Filed against a real breach: a corpus measurement commissioned for #143
 * read `~/obsidian-old` (12,072 notes, including 2,998 files under
 * `80-89 Sensitive/`) to count frontmatter parse failures. Read-only, but the
 * standing rule is flat: never `~/obsidian-old`, never `80-89` legal
 * material, never anything under a hold. These tests never touch the real
 * `~/obsidian-old` — every case uses a disposable fixture standing in for it,
 * so pinning the regression cannot reproduce the breach it pins.
 */
describe("buildSnapshot territory guard (#157) — no declared boundary", () => {
  test("refuses rather than defaulting when no boundary is declared anywhere", async () => {
    const root = await fixture();
    const savedContent = process.env.ASSENT_CONTENT_ROOT;
    const savedVault = process.env.ASSENT_VAULT_ROOT;
    delete process.env.ASSENT_CONTENT_ROOT;
    delete process.env.ASSENT_VAULT_ROOT;
    try {
      await assert.rejects(() => buildSnapshot({ root }), /no content-root boundary declared/);
    } finally {
      if (savedContent !== undefined) process.env.ASSENT_CONTENT_ROOT = savedContent;
      if (savedVault !== undefined) process.env.ASSENT_VAULT_ROOT = savedVault;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ASSENT_CONTENT_ROOT alone is a sufficient declared boundary (no opts.boundary needed)", async () => {
    const root = await fixture();
    const savedContent = process.env.ASSENT_CONTENT_ROOT;
    const savedVault = process.env.ASSENT_VAULT_ROOT;
    delete process.env.ASSENT_VAULT_ROOT;
    process.env.ASSENT_CONTENT_ROOT = root;
    try {
      const snap = await buildSnapshot({ root });
      assert.ok(snap.notes.some((n) => n.path === "Notes/A.md"));
    } finally {
      if (savedContent === undefined) delete process.env.ASSENT_CONTENT_ROOT;
      else process.env.ASSENT_CONTENT_ROOT = savedContent;
      if (savedVault !== undefined) process.env.ASSENT_VAULT_ROOT = savedVault;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildSnapshot territory guard (#157) — outside the declared boundary", () => {
  test("a legitimate root under the declared boundary still works", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root, boundary: root });
      assert.ok(snap.notes.some((n) => n.path === "Notes/A.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a subdirectory of the declared boundary is permitted", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root: path.join(root, "Notes"), boundary: root });
      assert.ok(snap.notes.some((n) => n.path === "A.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a plain sibling directory (lexically outside) is refused", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "conf-bound-"));
    try {
      const boundary = path.join(parent, "vault");
      const outside = path.join(parent, "vault-2"); // shares "vault" as a string PREFIX, not a path parent
      await mkdir(boundary, { recursive: true });
      await mkdir(outside, { recursive: true });
      await assert.rejects(
        () => buildSnapshot({ root: outside, boundary }),
        /outside the declared content-root boundary/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("'..' traversal out of the declared boundary is refused", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "conf-bound-dotdot-"));
    try {
      const boundary = path.join(parent, "vault");
      const outside = path.join(parent, "outside");
      await mkdir(boundary, { recursive: true });
      await mkdir(outside, { recursive: true });
      const escapee = path.join(boundary, "..", "outside");
      await assert.rejects(
        () => buildSnapshot({ root: escapee, boundary }),
        /outside the declared content-root boundary/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("a trailing-slash variant of an outside sibling is still refused (not fooled by string prefix)", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "conf-bound-slash-"));
    try {
      const boundary = path.join(parent, "vault") + "/";
      const outside = path.join(parent, "vault-2") + "/";
      await mkdir(path.join(parent, "vault"), { recursive: true });
      await mkdir(path.join(parent, "vault-2"), { recursive: true });
      await assert.rejects(
        () => buildSnapshot({ root: outside, boundary }),
        /outside the declared content-root boundary/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("a trailing-slash variant of the boundary itself still permits the same root", async () => {
    const root = await fixture();
    try {
      const snap = await buildSnapshot({ root, boundary: root + "/" });
      assert.ok(snap.notes.some((n) => n.path === "Notes/A.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a symlink inside the boundary pointing OUTSIDE it is refused (real path, not the link's location)", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "conf-bound-symlink-"));
    try {
      const boundary = path.join(parent, "vault");
      const secret = path.join(parent, "secret");
      await mkdir(boundary, { recursive: true });
      await mkdir(secret, { recursive: true });
      await writeFile(path.join(secret, "S.md"), "---\ntitle: S\n---\n\nsecret\n");
      const escapeLink = path.join(boundary, "escape");
      await symlink(secret, escapeLink);
      await assert.rejects(
        () => buildSnapshot({ root: escapeLink, boundary }),
        /outside the declared content-root boundary/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("buildSnapshot territory guard (#157) — the CONFIGURED list overrides an explicit request (no built-in list since #397)", () => {
  test("REGRESSION: a walk rooted at a fixture standing in for ~/obsidian-old refuses, even inside a declared boundary", async () => {
    // Fixture, never the real ~/obsidian-old — reproducing the breach while
    // testing its fix would be exactly the mistake this issue exists to close.
    const homeStandIn = await mkdtemp(path.join(tmpdir(), "conf-homestandin-"));
    try {
      const oldVault = path.join(homeStandIn, "obsidian-old");
      const sensitive = path.join(oldVault, "80-89 Sensitive");
      await mkdir(sensitive, { recursive: true });
      await writeFile(path.join(sensitive, "D.md"), "---\ntitle: D\n---\n\nprivate\n");
      // The boundary EXPLICITLY includes the denied tree — proving the deny
      // list overrides an explicit request rather than merely a wide-open one.
      await assert.rejects(
        () => buildSnapshot({ root: oldVault, boundary: homeStandIn , territories: SEED }),
        /permanently denied territory.*obsidian-old/i,
      );
    } finally {
      await rm(homeStandIn, { recursive: true, force: true });
    }
  });

  test("a '80-89*' segment is refused even when the boundary is set to permit it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-8089-"));
    try {
      const legal = path.join(root, "80-89 Sensitive");
      await mkdir(legal, { recursive: true });
      await assert.rejects(
        () => buildSnapshot({ root: legal, boundary: root , territories: SEED }),
        /permanently denied territory.*80-89/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a 'Legal Hold' segment is NOT refused unless it is LISTED — the hold heuristic is retired (#397)", async () => {
    // The walker used to refuse any segment containing `hold`/`holds` as a whole
    // word, with no list consulted. That was one vault's convention shipped as
    // a rule, and it made "an empty list guards nothing" false. Both halves are
    // pinned here: unlisted, the folder is walked like any other; listed, it is
    // refused through the SAME configured-list path every other territory uses.
    const root = await mkdtemp(path.join(tmpdir(), "conf-hold-"));
    try {
      const legalHold = path.join(root, "Legal Hold");
      await mkdir(legalHold, { recursive: true });
      const snap = await buildSnapshot({ root: legalHold, boundary: root });
      assert.deepEqual(snap.notes, [], "unlisted: walked, not refused");
      await assert.rejects(
        () => buildSnapshot({ root: legalHold, boundary: root, territories: ["Legal Hold/"] }),
        /permanently denied territory.*guarded territory 'Legal Hold\/'/,
        "listed: refused, naming the configured entry",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a listed `80-89` does NOT cover `80-89-archive` — the walker shares core's boundary rule (#321)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-boundary-"));
    try {
      const archive = path.join(root, "80-89-archive");
      await mkdir(archive, { recursive: true });
      const snap = await buildSnapshot({ root, boundary: root, territories: ["80-89"] });
      assert.deepEqual(snap.notes, [], "walked, not refused");
      await mkdir(path.join(root, "80-89 Sensitive"), { recursive: true });
      const snap2 = await buildSnapshot({ root, boundary: root, territories: ["80-89"] });
      assert.deepEqual(snap2.skippedTerritories, [{ path: "80-89 Sensitive", territory: "80-89" }], "while the real area, one space later, is SKIPPED and recorded (#398)");
      assert.ok(!snap2.dirs.includes("80-89 Sensitive"), "and never entered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the walker agrees with the capture gate: a trailing slash means exactly that folder, entries are case-insensitive, and a nested entry covers only the nested folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-onerule-"));
    try {
      await mkdir(path.join(root, "Archive Old"), { recursive: true });
      const snap = await buildSnapshot({ root, boundary: root, territories: ["Archive/"] });
      assert.deepEqual(snap.notes, [], "`Archive/` does NOT cover `Archive Old` (re-review of #396: the walker used to strip the slash)");
      await mkdir(path.join(root, "Archive"), { recursive: true });
      const snapA = await buildSnapshot({ root, boundary: root, territories: ["Archive/"] });
      assert.deepEqual(snapA.skippedTerritories.map((t) => t.path), ["Archive"], "`Archive/` covers exactly `Archive`, which is skipped");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const root2 = await mkdtemp(path.join(tmpdir(), "conf-onerule2-"));
    try {
      await mkdir(path.join(root2, "80-89 Sensitive", "Notes"), { recursive: true });
      const snap = await buildSnapshot({ root: root2, boundary: root2, territories: ["80-89 Sensitive/Evidence"] });
      assert.deepEqual(snap.notes, [], "a nested entry does not refuse its parent");
      await mkdir(path.join(root2, "80-89 Sensitive", "Evidence"), { recursive: true });
      const nested = await buildSnapshot({ root: root2, boundary: root2, territories: ["80-89 Sensitive/Evidence"] });
      assert.deepEqual(nested.skippedTerritories, [{ path: "80-89 Sensitive/Evidence", territory: "80-89 Sensitive/Evidence" }], "skips exactly the nested folder, as the capture gate would exclude it");
      assert.ok(nested.dirs.includes("80-89 Sensitive"), "the parent is still walked");
      const ci = await buildSnapshot({ root: root2, boundary: root2, territories: ["80-89 sensitive"] });
      assert.deepEqual(ci.skippedTerritories.map((t) => t.path), ["80-89 Sensitive"], "case-insensitive, like the capture gate");
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });

  test("a bare `Evidence` covers a top-level `Evidence` and not `Notes/Evidence` — the walker never over-skips by name (#400 review)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-bare-"));
    try {
      await mkdir(path.join(root, "Notes", "Evidence"), { recursive: true });
      await writeFile(path.join(root, "Notes", "Evidence", "E.md"), "---\ntitle: E\n---\n\nx\n");
      const snap = await buildSnapshot({ root, boundary: root, territories: ["Evidence"] });
      assert.deepEqual(snap.skippedTerritories, []);
      assert.ok(snap.notes.some((n) => n.path === "Notes/Evidence/E.md"), "walked — the capture gate would not exclude it either");
      await mkdir(path.join(root, "Evidence"), { recursive: true });
      const top = await buildSnapshot({ root, boundary: root, territories: ["Evidence"] });
      assert.deepEqual(top.skippedTerritories, [{ path: "Evidence", territory: "Evidence" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a directory that merely CONTAINS 'hold' as a substring (not a whole word) is NOT denied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-household-"));
    try {
      const benign = path.join(root, "Household budget");
      await mkdir(benign, { recursive: true });
      const snap = await buildSnapshot({ root: benign, boundary: root });
      assert.deepEqual(snap.notes, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * buildSnapshot territory guard (#157) — MID-WALK, not just at `root`.
 *
 * Review finding on the first version of this guard: checking `root` alone
 * is not "unconditional" — it bounds what `root` may equal, not what the walk
 * may actually read. Two concrete gaps it left open, both closed here:
 *
 *   1. A symlinked FILE nested inside an otherwise-legitimate tree:
 *      `entry.isDirectory()` is false for a symlink regardless of its
 *      target, so it reaches Pass 1 untouched by the root-level check, and
 *      its REAL target is what `readFile` actually honors.
 *   2. A plainly-named denied directory nested several levels below `root`
 *      (no symlink at all) — Pass 2 previously recursed into it
 *      unconditionally.
 */
describe("buildSnapshot territory guard (#157) — checked mid-walk, not just at root", () => {
  test("a symlinked FILE nested inside a legitimate tree, pointing into a denied territory, is refused", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-midwalk-symlink-deny-"));
    try {
      await mkdir(path.join(root, "Notes"), { recursive: true });
      const oldVault = path.join(root, "..", path.basename(root) + "-oldvault-standin");
      await mkdir(path.join(oldVault, "80-89 Sensitive"), { recursive: true });
      await writeFile(path.join(oldVault, "80-89 Sensitive", "secret.md"), "---\ntitle: secret\n---\n\nprivate\n");
      const escapeLink = path.join(root, "Notes", "leaked.md");
      await symlink(path.join(oldVault, "80-89 Sensitive", "secret.md"), escapeLink);
      await assert.rejects(
        () => buildSnapshot({ root, boundary: root , territories: SEED }),
        /permanently denied territory.*80-89/i,
      );
      await rm(oldVault, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a symlinked FILE nested inside a legitimate tree, pointing merely OUTSIDE the boundary, is refused", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "conf-midwalk-symlink-out-"));
    try {
      const boundary = path.join(parent, "vault");
      const outside = path.join(parent, "elsewhere");
      await mkdir(path.join(boundary, "Notes"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, "E.md"), "---\ntitle: E\n---\n\nelsewhere\n");
      await symlink(path.join(outside, "E.md"), path.join(boundary, "Notes", "leaked.md"));
      await assert.rejects(
        () => buildSnapshot({ root: boundary, boundary }),
        /symlink resolving outside the declared content-root boundary/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("a symlinked FILE that stays INSIDE the boundary and isn't denied still works", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-midwalk-symlink-ok-"));
    try {
      await mkdir(path.join(root, "Notes"), { recursive: true });
      await mkdir(path.join(root, "Real"), { recursive: true });
      await writeFile(path.join(root, "Real", "R.md"), "---\ntitle: R\n---\n\nreal\n");
      await symlink(path.join(root, "Real", "R.md"), path.join(root, "Notes", "link.md"));
      const snap = await buildSnapshot({ root, boundary: root });
      assert.ok(snap.notes.some((n) => n.path === "Notes/link.md"), "the in-boundary symlink is walked normally");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a plainly-named listed directory NESTED several levels below root (no symlink) is SKIPPED and recorded (#398)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-midwalk-nested-deny-"));
    try {
      const nested = path.join(root, "Area", "Sub", "80-89 Sensitive");
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, "N.md"), "---\ntitle: N\n---\n\nnested\n");
      // The walker matches exactly what the capture gate matches (#400 review):
      // `80-89` is a PATH prefix, so it covers a top-level `80-89 …` folder and
      // NOT one nested under `Area/Sub/`. Guarding a nested folder means
      // listing it by its path — the same entry the capture gate would need.
      const bySeed = await buildSnapshot({ root, boundary: root, territories: SEED });
      assert.deepEqual(bySeed.skippedTerritories, [], "a bare `80-89` does not reach a nested folder — no per-segment guessing");
      assert.ok(bySeed.notes.some((n) => n.path === "Area/Sub/80-89 Sensitive/N.md"), "so it is walked, exactly as capture would retain it");
      const byPath = await buildSnapshot({ root, boundary: root, territories: ["Area/Sub/80-89 Sensitive"] });
      assert.deepEqual(byPath.skippedTerritories, [{ path: "Area/Sub/80-89 Sensitive", territory: "Area/Sub/80-89 Sensitive" }], "listed by path: skipped mid-walk and recorded (#398), never refused");
      assert.ok(!byPath.notes.some((n) => n.path.startsWith("Area/Sub/80-89 Sensitive/")), "nothing under it was read");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a nested 'Legal Holds' directory is walked when unlisted and skipped mid-walk when listed (#397, #398)", async () => {
    // The plural inflection used to be covered by the retired heuristic. Now
    // the operator lists the exact folder; the mid-walk refusal is the same one
    // any listed territory gets.
    const root = await mkdtemp(path.join(tmpdir(), "conf-midwalk-plural-"));
    try {
      const nested = path.join(root, "Area", "Legal Holds");
      await mkdir(nested, { recursive: true });
      const snap = await buildSnapshot({ root, boundary: root });
      assert.deepEqual(snap.notes, [], "unlisted: the nested folder is not refused");
      const bare = await buildSnapshot({ root, boundary: root, territories: ["Legal Holds"] });
      assert.deepEqual(bare.skippedTerritories, [], "a bare entry is a top-level prefix, not a name to hunt for anywhere");
      const listed = await buildSnapshot({ root, boundary: root, territories: ["Area/Legal Holds"] });
      assert.deepEqual(listed.skippedTerritories, [{ path: "Area/Legal Holds", territory: "Area/Legal Holds" }], "listed by path: skipped and recorded, spelled as the operator wrote it");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a nested 'Household budget' directory (substring, not whole word) is NOT denied mid-walk either", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conf-midwalk-household-"));
    try {
      const nested = path.join(root, "Area", "Household budget");
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, "B.md"), "---\ntitle: B\n---\n\nbudget\n");
      const snap = await buildSnapshot({ root, boundary: root });
      assert.ok(snap.notes.some((n) => n.path === "Area/Household budget/B.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
