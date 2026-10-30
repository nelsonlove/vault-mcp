/**
 * Scheme panes live-mount WIRING pins (governor#286 / PR #289).
 *
 * The decision core (`mountAction`) is already pinned by governance-live-mount.test.mjs and is
 * REUSED here, so this file pins the part that is easy to regress silently: the wiring in main.ts.
 * Source scans, the repo's established shape for "this call site must keep existing" invariants
 * (cf. the link-healing glob scan and the registration-surface seals) — the live Obsidian mount
 * itself is un-headless.
 *
 * Three properties, each of which was a real defect class before #289:
 *   1. the module toggle DISPATCHES to the scheme panes at all (the #286 bug: the enabled flag was
 *      read once at onload, so toggling did nothing until a plugin reload);
 *   2. the scheme panes have their OWN reconcile chain — sharing governance's would let a rapid
 *      toggle of one pane interleave with the other's mount/unmount;
 *   3. both mount paths go through `mountAction`, so enable-while-mounted and disable-while-
 *      unmounted stay idempotent no-ops rather than double-wiring or double-tearing-down.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

describe("scheme panes: live-mount wiring (#286)", () => {
  test("the module toggle dispatches to the scheme panes", () => {
    const dispatch = main.slice(main.indexOf("async onModuleEnabledChanged"));
    const body = dispatch.slice(0, dispatch.indexOf("\n  }"));
    // The acceptance branch was the other half of this dispatch until the
    // host/provider split. Its pane, its toggle and the settings row that drove
    // it all left for `packages/governor`, which mounts it from its own
    // settings tab — so there is exactly one branch here now, and a second one
    // reappearing would mean the host had re-acquired a surface it does not own.
    assert.doesNotMatch(body, /acceptance/);
    assert.match(
      body,
      // Since #621's follow-up the toggle alone is not enough: no scheme configured, no panes.
      /moduleId === "scheme"[\s\S]*setSchemePanesMounted\(enabled && schemeModuleEnabled\(this\.settings\)\)/,
      "toggling the scheme module must drive the panes live — the #286 bug was that it did not",
    );
  });

  test("the scheme panes serialize on their OWN chain, not governance's", () => {
    assert.match(main, /private schemePanesReconcile: Promise<void>/);
    assert.match(main, /this\.schemePanesReconcile\s*\.then\(|this\.schemePanesReconcile\.then\(/);
    // The interleave guard: the scheme path must never reuse the governance chain.
    // Slice exactly the setSchemePanesMounted body, anchored on the next member declaration — a
    // missing anchor would silently widen the slice and pass vacuously, so assert it was found.
    const schemeMount = main.slice(main.indexOf("async setSchemePanesMounted"));
    const end = schemeMount.indexOf("private async applySchemePanesMount");
    assert.ok(end > 0, "anchor for the end of setSchemePanesMounted not found — update this pin");
    const upToNextMember = schemeMount.slice(0, end);
    assert.doesNotMatch(
      upToNextMember,
      /governanceReconcile/,
      "sharing the governance chain would let one pane's rapid toggle interleave with the other's",
    );
  });

  // ONE mount path since the host/provider split: the review pane and its
  // gavel ribbon left with `packages/governor`, which drives its own mount
  // through the same helper in its own `main.ts`. What this pin still buys is
  // the half that stayed — the scheme panes decide through the shared,
  // idempotent helper rather than an ad-hoc `if (mounted)`.
  test("the scheme mount path decides through the idempotent mountAction helper", () => {
    assert.match(main, /mountAction\(this\.schemePanesComponent !== null, enabled\)/);
    assert.doesNotMatch(main, /governanceComponent/, "the review pane's mount left with the provider");
  });

  test("unmount is removeChild on the returned child Component (not a bespoke teardown)", () => {
    assert.match(main, /this\.removeChild\(this\.schemePanesComponent!\)/);
  });
});
