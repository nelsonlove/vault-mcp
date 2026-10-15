/**
 * conformance-rail-scope.test.mjs — #112: the rail governs LIVE content, not
 * the frozen archive (@assent's ruling, 2026-08-10).
 *
 * The ruling came with a condition: a **declared exclusion, not a silent
 * debt-clear**. Excluding a root makes every baseline key under it
 * unreproducible, so those keys would report CLEARED and quietly discard
 * accepted debt a human granted — the same failure the pack-coverage refusal
 * exists to stop, one level down (path granularity instead of pack).
 *
 * Measured before building: ZERO baseline keys fall under `Vault archaeology/`
 * today, under every pre-consolidation naming too (`_maybe`, `gen2`, `_keep`,
 * `_hold`, `_decent`). So the guarantee below costs nothing now — which is
 * exactly when it is cheap to add, and exactly the kind of fact that expires
 * silently if only a measurement records it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { excludedRootRefusal, DEFAULT_EXCLUDED_ROOTS, excludedRootsFrom } from "../src/kernel/cli.ts";

describe("#112 — an excluded root must never silently clear accepted debt", () => {
  test("a baseline key UNDER an excluded root refuses, naming the key and the root", () => {
    const r = excludedRootRefusal(
      new Set(["ste_lint|editable|Vault archaeology/_maybe/x.md|"]),
      ["Vault archaeology"],
    );
    assert.ok(r, "must refuse");
    assert.match(r, /Vault archaeology/);
    assert.match(r, /CLEARED|clear/i, "names the consequence, not just the fact");
  });

  test("keys outside every excluded root are fine", () => {
    assert.equal(
      excludedRootRefusal(new Set(["ste_lint|editable|00-09 System/x.md|"]), ["Vault archaeology"]),
      null,
    );
  });

  test("prefix matching is on a path SEGMENT, not a substring", () => {
    // "Vault archaeology notes/" is a different folder and must not be swept in.
    assert.equal(
      excludedRootRefusal(new Set(["ste_lint|editable|Vault archaeology notes/x.md|"]), ["Vault archaeology"]),
      null,
    );
  });

  test("a drift key whose target is a MESSAGE, not a path, is unaffected", () => {
    assert.equal(
      excludedRootRefusal(new Set(["drift_audit|J|category number 00 is claimed by 2 folders: 00 A; 00 B|"]), ["Vault archaeology"]),
      null,
    );
  });

  test("no excluded roots ⇒ nothing to refuse", () => {
    assert.equal(excludedRootRefusal(new Set(["ste_lint|editable|anything/x.md|"]), []), null);
  });

  // Which roots are archives is a property of a VAULT, not of this plugin.
  // Shipping a vault's folder name as a source constant makes the rail silently
  // wrong for every other vault and turns a policy knob into a release.
  test("NO vault-specific path ships as a default — govern everything unless told otherwise", () => {
    assert.deepEqual(DEFAULT_EXCLUDED_ROOTS, [], "a general-purpose plugin must not name one vault's folders");
  });

  describe("exclusions come from the invocation", () => {
    test("--exclude= flags win, and repeat", () => {
      assert.deepEqual(
        excludedRootsFrom(["--exclude=Archive", "--exclude=Old stuff"], {}),
        ["Archive", "Old stuff"],
      );
    });

    test("ASSENT_EXCLUDED_ROOTS is the fallback, comma-separated and trimmed", () => {
      assert.deepEqual(
        excludedRootsFrom([], { ASSENT_EXCLUDED_ROOTS: "Archive , Vault archaeology" }),
        ["Archive", "Vault archaeology"],
      );
    });

    test("flags override the env rather than merging (one source per run, auditable)", () => {
      assert.deepEqual(excludedRootsFrom(["--exclude=A"], { ASSENT_EXCLUDED_ROOTS: "B" }), ["A"]);
    });

    test("neither ⇒ govern everything", () => {
      assert.deepEqual(excludedRootsFrom([], {}), []);
      assert.deepEqual(excludedRootsFrom([], { ASSENT_EXCLUDED_ROOTS: "  ,  " }), []);
    });
  });
});
