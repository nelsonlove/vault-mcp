/**
 * env-alias.test.mjs — the GOVERNOR_* / ASSENT_* env-var alias contract
 * (0.12.0 naming unification, part 3): `envAliased` itself.
 *
 * GOVERNOR_<X> is primary; the pre-rename ASSENT_<X> spelling is a fallback
 * alias. Pinned: GOVERNOR_ wins when both are set; a set-but-empty GOVERNOR_
 * value still wins (it does not fall through to the legacy spelling). The
 * function lives in @vault-mcp/core and the host re-exports it for the survey.
 * The conformance rail's call sites moved with the rail on 2026-10-14 and are
 * pinned in packages/conformance/tests/env-alias.test.mjs.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { envAliased, envAliasNames } from "../src/env-alias.ts";

describe("envAliased — the precedence contract", () => {
  test("GOVERNOR_ wins when both are set", () => {
    assert.equal(envAliased({ GOVERNOR_X: "new", ASSENT_X: "old" }, "X"), "new");
  });
  test("ASSENT_ is read when GOVERNOR_ is unset", () => {
    assert.equal(envAliased({ ASSENT_X: "old" }, "X"), "old");
  });
  test("a set-but-empty GOVERNOR_ still wins (never falls through)", () => {
    assert.equal(envAliased({ GOVERNOR_X: "", ASSENT_X: "old" }, "X"), "");
  });
  test("neither set ⇒ undefined", () => {
    assert.equal(envAliased({}, "X"), undefined);
  });
  test("envAliasNames spells both forms", () => {
    assert.deepEqual(envAliasNames("CONTENT_ROOT"), {
      primary: "GOVERNOR_CONTENT_ROOT",
      legacy: "ASSENT_CONTENT_ROOT",
    });
  });
});

