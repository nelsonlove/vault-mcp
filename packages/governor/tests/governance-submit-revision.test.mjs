/**
 * governance-submit-revision.test.mjs — the ONE agent-expressible disposition
 * (#101): `governance_submit_revision`.
 *
 * S3c PUBLISHED IT, AND THAT MOVED HALF THIS FILE OUT OF THE PACKAGE. The tool
 * is now a `SdkToolSpec` from `buildRevisionTools`, registered by the host
 * through `vault-mcp-api`, so the handler is exercised through
 * `tests/host-shim.mjs` (the published name, `ok()`/`fail()`, and the
 * annotations the host derives from an untrusted `readOnly` claim). Its typed
 * refusals are byte-compatible with the pre-split `codedError` envelope —
 * `fail()` renders a lowercase-snake `code` as `Error [code]: message`, which is
 * exactly what the old helper produced — so every `Error [not_revising]`
 * assertion below reads unchanged, and that is the point of asserting through
 * the shim rather than against the raw return value.
 *
 * WHAT LEFT, and where it went. The file used to construct a real `Kernel` +
 * `makeGuarded` and prove read-only mode, allowlist scoping, the journal record
 * and `withKernelArgs` at the exact wrapper a live client goes through. That was
 * only possible because this suite lived in the host's tree; those are host
 * machinery with host tests, and a re-implementation here could only drift into
 * asserting a posture the host does not enforce. `packages/host/tests/
 * kernel.test.mjs`, `operations-guarded-seam.test.mjs`, `change-intent.test.mjs`
 * and `link-healing.test.mjs` cover read-only mode, `out_of_allowlist`,
 * `withKernelArgs`, the `intent` peel and the `effects` derivation over the live
 * wrapper. Two things they do NOT cover are named in this repo's S3c report
 * rather than silently dropped: the "exactly one journal record for an isError
 * return" cardinality, and `makeGuarded`'s `sessionRefusal` option.
 *
 * What STAYS, because it is provider logic: the revision plan and its byte-exact
 * output, every typed refusal, the accept perimeter (`revisionWriteRefusalReason`
 * and the shared guard), `acceptanceStatusOf`'s spelling tolerance, and the
 * source tripwire that the guard hook runs BEFORE the write.
 *
 * The one property the split makes newly assertable HERE is that
 * `governance_submit_revision` is the only one of the five published tools whose
 * argument the host recognizes as a path — see publication.test.mjs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildRevisionTools,
  revisionWriteRefusalReason,
  acceptanceStatusOf,
} from "../src/tools/revision.ts";
import { SUBMIT_REVISION_TOOL } from "../src/kernel/dispositions.ts";
import { parseGuardFrontmatter } from "@vault-mcp/core";
import { publishInto } from "./host-shim.mjs";

const NOW = new Date("2026-08-18T12:00:00Z");
const REVISING =
  "---\nacceptance-status: revising\nuid: abc\n---\n" +
  "# Note\n\n> [!revision-request] Requested changes (2026-08-17)\n> tighten the intro\n\nBody text\n";

const EMPTY_LISTING = { listNotes: async () => [], read: async () => null };

/** In-memory note store standing in for the vault, published through the host shim. */
function toolServer(files = {}) {
  const notes = new Map(Object.entries(files));
  const writes = [];
  const specs = buildRevisionTools(
    {
      read: async (p) => notes.get(p) ?? null,
      write: async (p, content) => {
        writes.push([p, content]);
        notes.set(p, content);
      },
      now: () => NOW,
    },
    EMPTY_LISTING,
  );
  const { tools } = publishInto(specs);
  const call = (args) => tools.get(SUBMIT_REVISION_TOOL).handler(args);
  return { specs, tools, call, notes, writes };
}

// ── publication shape ─────────────────────────────────────────────────────────

describe("publication shape", () => {
  test("publishes UNPREFIXED as governance_submit_revision, MUTATING (readOnlyHint: false)", () => {
    const { specs, tools } = toolServer();
    // buildRevisionTools returns BOTH revision specs; the submit verb is one of
    // them and keeps its shipped spelling through the host's grandfather table.
    assert.deepEqual(specs.map((s) => s.name).sort(), ["governance_revisions", SUBMIT_REVISION_TOOL].sort());
    const entry = tools.get(SUBMIT_REVISION_TOOL);
    assert.ok(entry, "not `governor_governance_submit_revision`");
    assert.equal(entry.bare, true);
    // Unlike the two read tools, this one never CLAIMED read-only, so trust
    // changes nothing about it: it is mutating on the publisher's own say-so and
    // the whole kernel perimeter binds either way.
    assert.equal(entry.def.claimsReadOnly, false);
    assert.equal(entry.def.annotations.readOnlyHint, false, "must be mutating so the whole kernel perimeter binds");
    assert.equal(entry.def.annotations.destructiveHint, false);
  });

  test("the description documents the agents' contract: feedback lives in the NOTE BODY, not frontmatter", () => {
    const { tools } = toolServer();
    const desc = tools.get(SUBMIT_REVISION_TOOL).def.description;
    assert.match(desc, /NOTE BODY/);
    assert.match(desc, /\[!revision-request\]/);
    assert.match(desc, /no\s+.?requested-changes.?\s+property/i);
    assert.match(desc, /cannot accept/i);
    assert.match(desc, /not_revising/);
    assert.match(desc, /writes no frontmatter/);
    assert.ok(!/sets `acceptance-status: proposed`/.test(desc), "the description must not promise a status write");
  });

  test("args are path + optional summary only (kernel args are the host's, added at ITS interception point)", () => {
    const { tools } = toolServer();
    assert.deepEqual(Object.keys(tools.get(SUBMIT_REVISION_TOOL).def.inputSchema).sort(), ["path", "summary"]);
  });
});

// ── happy path ────────────────────────────────────────────────────────────────

describe("happy path: callout swap, frontmatter untouched", () => {
  test("status untouched, request callout removed, report inserted with the run-clock date", async () => {
    const { call, notes, writes } = toolServer({ "Projects/note.md": REVISING });
    const res = await call({ path: "Projects/note.md", summary: "tightened the intro" });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    assert.equal(writes.length, 1);
    const after = notes.get("Projects/note.md");
    assert.equal(
      after,
      "---\nacceptance-status: revising\nuid: abc\n---\n" +
        "# Note\n\n> [!revision-report] Revision report (2026-08-18)\n> tightened the intro\n\nBody text\n",
    );
    assert.deepEqual(res.structuredContent, {
      path: "Projects/note.md",
      removed_requests: 1,
      report_inserted: true,
      filesChanged: 1,
      files: ["Projects/note.md"],
    });
  });

  test("no summary: resubmits without a report callout", async () => {
    const { call, notes } = toolServer({ "n.md": REVISING });
    const res = await call({ path: "n.md" });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.report_inserted, false);
    assert.ok(!notes.get("n.md").includes("[!revision-report]"));
    assert.ok(!notes.get("n.md").includes("[!revision-request]"));
    assert.match(notes.get("n.md"), /acceptance-status: revising/);
  });

  test("a submit writes none of acceptance-status, accepted-by, accepted-on (#599): the frontmatter is byte-identical", async () => {
    const { call, notes } = toolServer({ "n.md": REVISING });
    const res = await call({ path: "n.md", summary: "done" });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    const fmOf = (c) => c.slice(0, c.indexOf("\n---", 4));
    assert.equal(fmOf(notes.get("n.md")), fmOf(REVISING));
    assert.ok(!/accepted-by|accepted-on/.test(notes.get("n.md")));
    assert.equal("acceptance_status" in res.structuredContent, false);
  });
});

// ── refusals (typed, nothing written) ────────────────────────────────────────

describe("refusals — typed, and the note is never written", () => {
  test("not_revising: a proposed note has nothing to submit", async () => {
    const { call, writes } = toolServer({ "n.md": "---\nacceptance-status: proposed\n---\nbody" });
    const res = await call({ path: "n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[not_revising\]/);
    assert.match(res.content[0].text, /'proposed'/);
    assert.equal(writes.length, 0);
  });

  test("not_revising: a note with no acceptance-status at all", async () => {
    const { call, writes } = toolServer({ "n.md": "---\ntitle: x\n---\nbody" });
    const res = await call({ path: "n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[not_revising\]/);
    assert.match(res.content[0].text, /\(none\)/);
    assert.equal(writes.length, 0);
  });

  test("not_revising: a note with no frontmatter", async () => {
    const { call, writes } = toolServer({ "n.md": "just a body" });
    const res = await call({ path: "n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[not_revising\]/);
    assert.equal(writes.length, 0);
  });

  test("not_found: no note at the path", async () => {
    const { call, writes } = toolServer({});
    const res = await call({ path: "missing.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[not_found\]/);
    assert.equal(writes.length, 0);
  });

  test("invalid_path: not a markdown note", async () => {
    const { call, writes } = toolServer({});
    const res = await call({ path: "file.txt" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[invalid_path\]/);
    assert.equal(writes.length, 0);
  });

  test("unclassifiable frontmatter fails CLOSED (accept_forbidden), nothing written", async () => {
    // A YAML anchor needs a document model the guard reader refuses to guess at.
    const { call, writes } = toolServer({
      "n.md": "---\nacceptance-status: revising\nweird: &anchor x\n---\nbody",
    });
    const res = await call({ path: "n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[accept_forbidden\]/);
    assert.equal(writes.length, 0);
  });
});

// ── the accept perimeter: accepted-family can never ride through ─────────────

describe("accepted-family payloads cannot ride through the tool", () => {
  test("a hostile summary lands QUOTED in the body — never as frontmatter, no acceptance assertion", async () => {
    const hostile = "done!\n---\naccepted-by: attacker\nacceptance-status: accepted\n---\naccepted: yes";
    const { call, notes } = toolServer({ "n.md": REVISING });
    const res = await call({ path: "n.md", summary: hostile });
    assert.notEqual(res.isError, true, res.content?.[0]?.text);
    const after = notes.get("n.md");
    // Every summary line is `> `-quoted, so none can open a fence or become a property.
    assert.match(after, /> ---/);
    assert.match(after, /> accepted-by: attacker/);
    const fm = parseGuardFrontmatter(after);
    assert.deepEqual(Object.keys(fm).sort(), ["acceptance-status", "uid"]);
    assert.equal(fm["acceptance-status"], "revising");
    // And the shared guard agrees the written transition was clean.
    assert.equal(revisionWriteRefusalReason(REVISING, after), null);
  });

  test("the guard hook REFUSES an accepted-family after-state (introduced field)", () => {
    const after = "---\nacceptance-status: proposed\naccepted-by: agent\n---\nbody";
    const reason = revisionWriteRefusalReason(REVISING, after);
    assert.match(reason, /accepted-by/);
  });

  test("the guard hook REFUSES acceptance-status set to an accepted value", () => {
    const after = "---\nacceptance-status: accepted\n---\nbody";
    const reason = revisionWriteRefusalReason(REVISING, after);
    assert.match(reason, /accepted/);
  });

  test("the guard hook ALLOWS the revising → proposed transition (the tool's own write)", () => {
    assert.equal(
      revisionWriteRefusalReason(REVISING, "---\nacceptance-status: proposed\nuid: abc\n---\nbody"),
      null,
    );
  });

  test("the guard hook ALLOWS a pre-existing human-granted accepted-by carried forward UNCHANGED", () => {
    const before = "---\nacceptance-status: revising\naccepted-by: nelson\n---\nbody";
    const after = "---\nacceptance-status: proposed\naccepted-by: nelson\n---\nbody";
    assert.equal(revisionWriteRefusalReason(before, after), null);
  });

  test("the guard hook fails CLOSED on an unclassifiable after-state", () => {
    const after = "---\nacceptance-status: proposed\n\tweird: tab-indent\n---\nbody";
    assert.notEqual(revisionWriteRefusalReason(REVISING, after), null);
  });

  test("the handler actually calls the guard hook before writing (source tripwire)", async () => {
    // RETARGETED at S3c: the module was `src/mcp/tools-governance-revision.ts`
    // in the host's tree and is `src/tools/revision.ts` in this plugin's. The
    // slice anchor moved with it — a published spec's handler takes one `raw`
    // bag rather than a destructured `({ path, summary })`, because the host
    // hands over whatever JSON arrived.
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/tools/revision.ts", import.meta.url), "utf8");
    const anchor = src.indexOf("name: SUBMIT_REVISION_TOOL");
    const start = src.indexOf("handler: async (raw", anchor);
    const end = src.indexOf('name: "governance_revisions"', start);
    assert.ok(anchor > 0 && start > anchor && end > start, "the two specs are found in order — the scan reads the file it thinks it does");
    const handlerBody = src.slice(start, end);

    const ordered = (text) => {
      const guardAt = text.indexOf("revisionWriteRefusalReason");
      const writeAt = text.indexOf("source.write");
      return guardAt >= 0 && writeAt >= 0 && guardAt < writeAt;
    };
    assert.match(handlerBody, /revisionWriteRefusalReason\(before, plan\.content\)/);
    assert.ok(ordered(handlerBody), "the guard check must run BEFORE the write");

    // VACUITY, against a planted violation: the same predicate over a copy with
    // the two lines swapped must FAIL. Without this the ordering assertion is
    // indistinguishable from a scan that always says yes.
    const guardLine = handlerBody.match(/^.*revisionWriteRefusalReason\(before, plan\.content\).*$/m)[0];
    const writeLine = handlerBody.match(/^.*await source\.write\(path, plan\.content\);.*$/m)[0];
    const planted = handlerBody.replace(guardLine + "\n", "").replace(writeLine, writeLine + "\n" + guardLine);
    assert.ok(planted.includes(writeLine) && planted.includes(guardLine), "the plant kept both lines");
    assert.ok(!ordered(planted), "the scan catches a write placed before its guard");
  });
});

// ── the bounds the publishing boundary drops ─────────────────────────────────

describe("re-applied schema bounds — the boundary keeps `type`, not `min`/`max`", () => {
  // The SDK converts zod to JSON Schema and the host converts it back through a
  // subset (`packages/host/src/mcp/json-schema-to-zod.ts`): `type`,
  // `description` and string `enum` survive; `min`, `max`, `default` and NESTED
  // OBJECT SHAPES do not. So `z.string().min(1)` validates nothing once
  // published, and every bound has to run again in the handler. This is the
  // `vaultmcp_skills_release` semver bug avoided rather than repeated — and it is
  // pinned here because a schema that LOOKS constrained is the failure mode.
  test("an empty `path` refuses invalid_argument rather than reaching the read", async () => {
    let reads = 0;
    const specs = buildRevisionTools(
      { read: async () => { reads++; return null; }, write: async () => {}, now: () => NOW },
      EMPTY_LISTING,
    );
    const { tools } = publishInto(specs);
    const res = await tools.get(SUBMIT_REVISION_TOOL).handler({ path: "" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^Error \[invalid_argument\]: /);
    assert.match(res.content[0].text, /'path'/);
    assert.equal(reads, 0, "the bound refuses before the source is touched");
  });

  test("a non-string `path` refuses invalid_argument — z.string() no longer guards it", async () => {
    const { call } = toolServer();
    const res = await call({ path: 42 });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[invalid_argument\]/);
  });

  test("`summary` bounds run again: empty and over-4000 both refuse, nothing written", async () => {
    const { call, writes } = toolServer({ "n.md": REVISING });
    for (const summary of ["", "x".repeat(4001)]) {
      const res = await call({ path: "n.md", summary });
      assert.equal(res.isError, true, JSON.stringify(summary.slice(0, 12)));
      assert.match(res.content[0].text, /Error \[invalid_argument\]/);
      assert.match(res.content[0].text, /'summary'/);
    }
    assert.equal(writes.length, 0);
    // The boundary at 4000 is inclusive — the refusal is a bound, not an off-by-one.
    const ok = await call({ path: "n.md", summary: "x".repeat(4000) });
    assert.notEqual(ok.isError, true, ok.content?.[0]?.text);
    assert.equal(writes.length, 1);
  });
});

// ── acceptanceStatusOf ───────────────────────────────────────────────────────

describe("acceptanceStatusOf — key spelling tolerance", () => {
  test("hyphen, underscore, case variants; non-string values read as null", () => {
    assert.equal(acceptanceStatusOf({ "acceptance-status": "revising" }), "revising");
    assert.equal(acceptanceStatusOf({ acceptance_status: " revising " }), "revising");
    assert.equal(acceptanceStatusOf({ "Acceptance-Status": "proposed" }), "proposed");
    assert.equal(acceptanceStatusOf({ "acceptance-status": ["revising"] }), null);
    assert.equal(acceptanceStatusOf({ other: "x" }), null);
    assert.equal(acceptanceStatusOf(null), null);
  });

  test("CONFLICTING duplicate spellings read as null — never first-key-wins (review #228.5)", () => {
    assert.equal(acceptanceStatusOf({ acceptance_status: "revising", "acceptance-status": "accepted" }), null);
    assert.equal(acceptanceStatusOf({ "acceptance-status": "accepted", acceptance_status: "revising" }), null);
    // Agreeing duplicates are fine.
    assert.equal(acceptanceStatusOf({ acceptance_status: "revising", "acceptance-status": "revising" }), "revising");
    // And one non-string spoils the set (unrecognizable state).
    assert.equal(acceptanceStatusOf({ acceptance_status: "revising", "acceptance-status": ["revising"] }), null);
  });

  test("the tool refuses not_revising on a conflicting-spellings note — nothing written", async () => {
    const { call, writes } = toolServer({
      "n.md": "---\nacceptance_status: revising\nacceptance-status: accepted\n---\n# T\nbody\n",
    });
    const res = await call({ path: "n.md" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[not_revising\]/);
    assert.equal(writes.length, 0);
  });
});

// ── WHAT MOVED TO THE HOST, RECORDED RATHER THAN DELETED SILENTLY ────────────
//
// Everything below this line used to be a `guardedHarness` in this file: a real
// `Kernel` (WriteQueue + WriteJournal + IdempotencyStore + LockStore) wrapped by
// the real `makeGuarded`, driving THIS tool through the exact interception point
// a live client reaches. It proved five things, and none of them is a property
// of this plugin:
//
//   1. read-only mode refuses the call (`Error [read_only]`), handler untouched
//        → packages/host/tests/kernel.test.mjs, "the guard still runs first — a
//          blocked call never reaches the queue or journal".
//   2. a path outside an active allowlist refuses (`Error [out_of_allowlist]`)
//      and a path inside proceeds
//        → packages/host/tests/operations-guarded-seam.test.mjs, "a mutation
//          refused by the allowlist records neither queued nor attempted".
//   3. a successful mutating call journals op / outcome / target.path / intent /
//      effects
//        → packages/host/tests/link-healing.test.mjs, "the record names what
//          actually changed, not just the target that was asked for" (op,
//          outcome, target.path, effects) + change-intent.test.mjs, "the handler
//          never sees intent; the journal record carries it".
//   4. `withKernelArgs` declares if_rev / idempotency_key / intent on a mutating
//      definition
//        → packages/host/tests/kernel.test.mjs, "withKernelArgs declares both on
//          mutating tools only" + change-intent.test.mjs's intent case.
//   5. a REFUSED mutating call (an isError envelope, not a throw) still lands
//      exactly ONE journal record.
//
// FIVE IS A GAP, and it is recorded here because dropping an assertion quietly
// is how coverage evaporates during a split. The host's kernel.test.mjs case
// "records outcome=error when a handler returns an isError envelope" asserts the
// record's OUTCOME but destructures `const [rec] = records()`, which tolerates
// zero-plus-throw or a duplicate; the cardinality this file used to assert is
// pinned nowhere. It belongs in the host's suite — the behaviour is entirely
// `Kernel.runMutation`'s — and cannot be written here, because constructing a
// Kernel means importing host code across the package boundary.
//
// The reason none of this is reproduced with a local mock: a mock of the guard
// asserts what we think the host does, and the entire value of the original
// harness was that it asserted what the host ACTUALLY does. A second copy would
// go green while the real posture drifted, which is strictly worse than a named
// gap.
