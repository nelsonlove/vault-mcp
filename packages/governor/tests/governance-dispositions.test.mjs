/**
 * governance-dispositions.test.mjs — dispositions as data (#101, phase 1 of #221).
 *
 * The acceptance instance's disposition set is a DECLARED table
 * (governor/kernel/dispositions.ts): `{id, authority, surface, label,
 * effect, …}` per verb. These tests pin:
 *
 *   • completeness — the set contains exactly the seven declared verbs, and
 *     every pane action (pending-item buttons, the queue's adopt, the
 *     Revising section's withdraw, the back/skip control) renders FROM a
 *     descriptor (source-level: the pane builds buttons by iterating
 *     dispositionsFor / dispositionById, not from stray literals);
 *   • authority classes — submit-revision is the ONE agent verb; everything
 *     else is human; exactly one confirm gate (adopt), one text-input gate
 *     (request-changes), one stateless verb (skip);
 *   • descriptors are pure DATA — frozen, no callable rides any descriptor
 *     (an accept-capable callable on module-exported data would be an
 *     app-walkable accept gadget);
 *   • the agent verb's tool name is derived from the table
 *     (SUBMIT_REVISION_TOOL) and used by the registrar.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPOSITIONS,
  dispositionsFor,
  dispositionById,
  gestureGatedDispositions,
  acceptEffectFor,
  SUBMIT_REVISION_TOOL,
} from "../src/kernel/dispositions.ts";
import { dispositionsForSurface, dispositionByIdIn, gestureGatedIn } from "@vault-mcp/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(here, "..", "src", rel), "utf8");

describe("the declared set: completeness + authority classes", () => {
  test("exactly the seven declared verbs, no more, no less", () => {
    assert.deepEqual(
      DISPOSITIONS.map((d) => d.id).sort(),
      ["accept", "adopt", "request-changes", "revert", "skip", "submit-revision", "withdraw"],
    );
  });

  test("submit-revision is the ONLY agent-authority disposition; all others are human", () => {
    const agents = DISPOSITIONS.filter((d) => d.authority === "agent");
    assert.deepEqual(agents.map((d) => d.id), ["submit-revision"]);
    for (const d of DISPOSITIONS) {
      assert.ok(["human", "agent"].includes(d.authority), `${d.id} has an unknown authority`);
    }
  });

  test("exactly one confirm-gated verb (adopt), one input verb (request-changes), one stateless (skip)", () => {
    assert.deepEqual(DISPOSITIONS.filter((d) => d.confirm).map((d) => d.id), ["adopt"]);
    assert.deepEqual(DISPOSITIONS.filter((d) => d.input).map((d) => d.id), ["request-changes"]);
    assert.deepEqual(DISPOSITIONS.filter((d) => d.stateless).map((d) => d.id), ["skip"]);
  });

  test("surface membership + order match what the pane renders", () => {
    assert.deepEqual(dispositionsFor("pending-item").map((d) => d.id), ["accept", "revert", "request-changes"]);
    assert.deepEqual(dispositionsFor("queue").map((d) => d.id), ["adopt"]);
    assert.deepEqual(dispositionsFor("revising-item").map((d) => d.id), ["withdraw"]);
    assert.deepEqual(dispositionsFor("mcp-tool").map((d) => d.id), ["submit-revision"]);
    assert.deepEqual(dispositionsFor("navigation").map((d) => d.id), ["skip"]);
  });

  test("gestureGatedDispositions = every state-mutating HUMAN verb (all human minus stateless skip)", () => {
    assert.deepEqual(
      gestureGatedDispositions().map((d) => d.id).sort(),
      ["accept", "adopt", "request-changes", "revert", "withdraw"],
    );
    // The agent verb is NOT a pane control, so it is never in the gesture-gated set.
    assert.ok(!gestureGatedDispositions().some((d) => d.id === "submit-revision"));
  });

  test("the agent verb's tool name is derived from the table", () => {
    assert.equal(SUBMIT_REVISION_TOOL, "governance_submit_revision");
    assert.equal(dispositionById("submit-revision").label, SUBMIT_REVISION_TOOL);
  });

  test("the accept descriptor says Accept advances the baseline and writes none of the retired keys (#599)", () => {
    const accept = dispositionById("accept");
    assert.match(accept.effect, /advance this note's baseline/);
    assert.match(accept.effect, /never edited/);
    assert.match(accept.effect, /no acceptance-status, accepted-by or accepted-on/);
  });

  test("no human disposition effect promises a write of acceptance-status (#599)", () => {
    for (const id of ["request-changes", "withdraw"]) {
      assert.ok(!/acceptance-status/.test(dispositionById(id).effect), `${id} must not promise an acceptance-status write`);
    }
  });

  test("acceptEffectFor says the click advances the baseline only, whatever the note's status", () => {
    const text = acceptEffectFor();
    assert.match(text, /baseline only/);
    assert.ok(!/stamps/.test(text));
  });
});

describe("descriptors are pure data (no callable, frozen)", () => {
  test("no descriptor carries a function-valued property", () => {
    for (const d of DISPOSITIONS) {
      for (const [k, v] of Object.entries(d)) {
        assert.notEqual(typeof v, "function", `${d.id}.${k} must not be a callable`);
        assert.ok(["string", "boolean"].includes(typeof v), `${d.id}.${k} must be plain data`);
      }
    }
  });

  test("the set and every descriptor are frozen — nothing can add or mutate a verb at runtime", () => {
    assert.ok(Object.isFrozen(DISPOSITIONS), "the set must be frozen");
    for (const d of DISPOSITIONS) assert.ok(Object.isFrozen(d), `${d.id} must be frozen`);
  });

  test("effect strings are documentation, present on every verb", () => {
    for (const d of DISPOSITIONS) {
      assert.ok(typeof d.effect === "string" && d.effect.length > 0, `${d.id} must declare its effect`);
      assert.ok(typeof d.label === "string" && d.label.length > 0, `${d.id} must declare a label`);
    }
  });
});

describe("the pane renders FROM the descriptor set (source-level completeness)", () => {
  const pane = src("wiring/pane.ts");

  test("pending-item action buttons are built by iterating dispositionsFor('pending-item')", () => {
    assert.match(pane, /for \(const d of dispositionsFor\("pending-item"\)\)/);
    // and each button's text is the descriptor's label, not a literal
    assert.match(pane, /text:\s*d\.label/);
  });

  test("the withdraw button's label comes from the withdraw descriptor", () => {
    assert.match(pane, /dispositionById\("withdraw"\)/);
    assert.match(pane, /text:\s*withdrawDesc\.label/);
  });

  test("the back/skip control's label comes from the skip descriptor", () => {
    assert.match(pane, /dispositionById\("skip"\)!\.label/);
  });

  test("no stray human-disposition button literals remain (labels live in the table)", () => {
    // The old literals must be gone from button creation: the only "Accept"/"Revert" strings
    // left in the pane are notices/descriptions, not createEl text for action buttons.
    assert.ok(!/createEl\("button",\s*\{[^}]*text:\s*"Accept"/.test(pane), "Accept button text must come from the descriptor");
    assert.ok(!/createEl\("button",\s*\{[^}]*text:\s*"Revert"/.test(pane), "Revert button text must come from the descriptor");
  });

  test("the MCP registrar uses the table-derived tool name, not a second literal", () => {
    const tool = src("tools/revision.ts");
    assert.match(tool, /SUBMIT_REVISION_TOOL/);
    assert.ok(
      !/registerTool\(\s*"governance_submit_revision"/.test(tool),
      "the registrar must register via the SUBMIT_REVISION_TOOL constant",
    );
  });
});

// ── the shared substrate, from this side of the split ───────────────────────
//
// The GENERIC descriptor shape and its three helpers live in `@vault-mcp/core`
// (#221 phase 2, published at the suite split's S3 condition 9). This block
// pins that the acceptance instance behaves identically through the SHARED
// helpers as through its own one-line filters — the equivalence the
// dispositions.ts header claims.
//
// It used to live in the host's triage-module test, beside the same assertion
// for the triage table, which is what made "both instances declare against one
// shape" visible in a single file. Triage left for its own plugin at S5, so the
// claim is now pinned from both sides: here for the acceptance instance, and in
// packages/triage's suite for the triage instance. That the two suites no
// longer share a build is exactly why the shape had to be published first.

describe("the disposition substrate: the acceptance instance through the shared helpers", () => {
  test("surface, id lookup and gesture-gating agree with the local filters", () => {
    assert.deepEqual(
      dispositionsForSurface(DISPOSITIONS, "pending-item").map((d) => d.id),
      ["accept", "revert", "request-changes"],
    );
    assert.deepEqual(
      dispositionsForSurface(DISPOSITIONS, "pending-item").map((d) => d.id),
      dispositionsFor("pending-item").map((d) => d.id),
    );
    assert.equal(dispositionByIdIn(DISPOSITIONS, "adopt").confirm, true);
    assert.equal(dispositionByIdIn(DISPOSITIONS, "adopt"), dispositionById("adopt"));
    assert.deepEqual(
      gestureGatedIn(DISPOSITIONS).map((d) => d.id).sort(),
      ["accept", "adopt", "request-changes", "revert", "withdraw"],
    );
    assert.deepEqual(
      gestureGatedIn(DISPOSITIONS).map((d) => d.id).sort(),
      gestureGatedDispositions().map((d) => d.id).sort(),
    );
  });
});
