/**
 * operations-capture.test.mjs — WP2's vertical slice, Gate 0.
 *
 * The point where the observation substrate stops being contracts and starts
 * writing note text to disk. Everything here is about the conditions under
 * which that happens, because the failure that matters is not "capture broke"
 * — it is "capture happened when nobody asked for it".
 *
 * Three gates, and a read is captured only if ALL of them agree:
 *
 *   1. the human turned it on. Default off, per vault.
 *   2. the ACTION says its observations are worth keeping. A compatibility
 *      action never does — a derived contract cannot claim replayability, so
 *      the 123 pre-existing tools capture nothing even with the setting on.
 *   3. there is room under the size cap.
 *
 * The last one exists because retention does not: until a real retention pass
 * lands, an uncapped store grows forever, and "it filled the disk" is a worse
 * outcome than "it stopped recording and said so".
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createActionRegistry } from "../src/kernel/operations/registry.ts";
import { createOperationExecutor } from "../src/kernel/operations/executor.ts";
import { createObservationStore } from "../src/kernel/observations/store.ts";
import { createCapture } from "../src/kernel/observations/capture.ts";
import { NOTE_READ_V1 } from "../src/kernel/operations/actions/note-read.ts";
import { compatibilityAction } from "../src/kernel/operations/compatibility.ts";
import { isExcludedTerritory, LEGACY_TERRITORY_SEED } from "../../core/src/territories.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

function blobs() {
  const map = new Map();
  return {
    map,
    async put(k, d) { map.set(k, d); },
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async has(k) { return map.has(k); },
    async remove(k) { map.delete(k); },
    async keys() { return [...map.keys()]; },
    async totalBytes() { return [...map.values()].reduce((n, v) => n + v.length, 0); },
  };
}

/** A registry holding the native read plus one compatibility tool. */
function registry() {
  const r = createActionRegistry();
  r.register(NOTE_READ_V1);
  r.register(
    compatibilityAction({
      surface: "obsidian_doctor",
      postcondition: "Report bridge health.",
      owner: "core",
      distribution: "public-default",
      readOnly: true,
    })
  );
  r.bind({ kind: "mcp", id: "obsidian_read_note", action: NOTE_READ_V1.id, actionVersion: NOTE_READ_V1.version });
  r.bind({ kind: "mcp", id: "obsidian_doctor", action: "compat.obsidian_doctor", actionVersion: 1 });
  r.validate();
  return r;
}

function harness({ enabled = true, maxBytes = 1_000_000, excludedSource } = {}) {
  const b = blobs();
  const store = createObservationStore({ blobs: b, canReplay: () => true, canRead: () => true });
  const observations = [];
  const capture = createCapture({
    store,
    enabled: () => enabled,
    maxBytes,
    excludedSource,
    now: () => 1_700_000_000_000,
    newId: (() => { let n = 0; return () => `obs-${++n}`; })(),
    onObservation: (o) => observations.push(o),
  });
  const executor = createOperationExecutor({
    registry: registry(),
    actor: () => ({ binding: "conn-1", clientClaim: "claude-code" }),
    capture,
    // The surface knows the action's argument shape; the executor does not.
    sourcesOf: (req) => (req.inputs?.path ? [req.inputs.path] : []),
  });
  return { executor, store, blobs: b, observations, capture };
}

const READ = { action: NOTE_READ_V1.id, actionVersion: NOTE_READ_V1.version, surface: { id: "obsidian_read_note" } };
const DOCTOR = { action: "compat.obsidian_doctor", actionVersion: 1, surface: { id: "obsidian_doctor" } };

// ── gate 1: the human turned it on ───────────────────────────────────────────

describe("capture — off by default means nothing is written", () => {
  test("with capture disabled, no payload reaches the store", async () => {
    const { executor, blobs: b, observations } = harness({ enabled: false });
    await executor.run({ ...READ, inputs: { path: "A.md" } }, async () => ({ content: "the note text" }));
    assert.equal(b.map.size, 0, "nothing on disk");
    assert.deepEqual(observations, [], "and no observation record either");
  });

  test("the operation still succeeds — capture is evidence, not a precondition", async () => {
    const { executor } = harness({ enabled: false });
    const { result, operation } = await executor.run({ ...READ, inputs: {} }, async () => "ok");
    assert.equal(result, "ok");
    assert.equal(operation.outcome, "completed");
  });

  test("the operation records that capture was off, rather than looking like nothing was readable", async () => {
    // "Absence is not emptiness": an empty observation list must be
    // distinguishable from a read that had nothing to capture.
    const { executor } = harness({ enabled: false });
    const { operation } = await executor.run({ ...READ, inputs: {} }, async () => "ok");
    assert.deepEqual(operation.observations, []);
    assert.match(operation.captureNote ?? "", /disabled/i);
  });
});

// ── gate 2: the action says so ───────────────────────────────────────────────

describe("capture — a compatibility action captures nothing, even when enabled", () => {
  test("a derived contract cannot claim replayability, so it is not captured", async () => {
    // This is what keeps the 123 pre-existing tools out of the store on day
    // one. They are not native, so they have no observation contract worth
    // acting on, and inventing one would be exactly the overclaim the
    // compatibility adapter exists to prevent.
    const { executor, blobs: b } = harness({ enabled: true });
    await executor.run({ ...DOCTOR, inputs: {} }, async () => ({ status: "ok" }));
    assert.equal(b.map.size, 0);
  });

  test("a PARTIAL result is captured too — its data half IS vault content, and the operation did its work (apiVersion 2)", async () => {
    const { executor, observations } = harness();
    const partial = { isError: true, content: [{ type: "text", text: "Error [partial]: one section was unreadable" }, { type: "text", text: "{}" }], structuredContent: { text: "the readable half" } };
    const { operation } = await executor.run({ ...READ, inputs: { path: "A.md" } }, async () => partial);
    assert.equal(operation.outcome, "partial");
    assert.equal(observations.length, 1, "captured, like a completed read");
    const refused = { isError: true, content: [{ type: "text", text: "Error [out_of_allowlist]: nope" }] };
    await executor.run({ ...READ, inputs: { path: "B.md" } }, async () => refused);
    assert.equal(observations.length, 1, "a refusal is still not captured");
  });

  test("the NATIVE read is captured when enabled", async () => {
    const { executor, blobs: b, observations } = harness({ enabled: true });
    await executor.run({ ...READ, inputs: { path: "A.md" } }, async () => ({ content: "the note text" }));
    assert.equal(b.map.size, 1, "the payload is stored");
    assert.equal(observations.length, 1);
    assert.equal(observations[0].level, "replayable");
  });

  test("the operation names the observation it produced", async () => {
    const { executor, observations } = harness({ enabled: true });
    const { operation } = await executor.run({ ...READ, inputs: { path: "A.md" } }, async () => ({ content: "x" }));
    assert.deepEqual(operation.observations, [observations[0].id]);
  });

  test("what is stored is what was returned — byte for byte", async () => {
    const { executor, store, observations } = harness({ enabled: true });
    const payload = { content: "# Heading\n\nbody text", rev: 7 };
    await executor.run({ ...READ, inputs: { path: "A.md" } }, async () => payload);
    const played = await store.playback(observations[0].result.payloadObject, { reader: "human-1" });
    assert.deepEqual(played.payload, payload);
    assert.equal(played.historical, true);
  });
});

// ── gate 3: the size cap ─────────────────────────────────────────────────────

describe("capture — the cap stops the store growing forever", () => {
  test("a payload over the cap is refused, and the refusal is recorded", async () => {
    // Retention does not exist yet. Until it does, an uncapped store grows
    // without bound, and "it filled the disk" is a worse outcome than "it
    // stopped recording and said so".
    const { executor, blobs: b } = harness({ enabled: true, maxBytes: 50 });
    const { operation } = await executor.run(
      { ...READ, inputs: { path: "A.md" } },
      async () => ({ content: "x".repeat(500) })
    );
    assert.equal(b.map.size, 0, "nothing stored");
    assert.deepEqual(operation.observations, []);
    assert.match(operation.captureNote ?? "", /cap/i);
  });

  test("the read still succeeds — a full store must never cost a caller their result", async () => {
    const { executor } = harness({ enabled: true, maxBytes: 10 });
    const { result } = await executor.run({ ...READ, inputs: {} }, async () => ({ content: "x".repeat(500) }));
    assert.deepEqual(result, { content: "x".repeat(500) });
  });

  test("the cap accumulates across calls on one connection", async () => {
    const { executor, blobs: b } = harness({ enabled: true, maxBytes: 120 });
    for (const n of ["a", "b", "c", "d", "e"]) {
      await executor.run({ ...READ, inputs: { path: `${n}.md` } }, async () => ({ content: n.repeat(30) }));
    }
    const total = [...b.map.values()].reduce((sum, v) => sum + v.length, 0);
    assert.ok(total <= 120 + 60, `store stayed near the cap, got ${total}`);
    assert.ok(b.map.size < 5, "not every read was stored once the cap was reached");
  });

  test("the cap survives a reconnect — it bounds the STORE, not the session", async () => {
    // The bug this pins: `storedBytes` is a counter inside createCapture, and
    // createCapture is called per CONNECTION. Starting it at zero quietly
    // turned a store-wide cap into a per-connection one, so every reconnect
    // got another capful — twenty sessions against a 50 MB cap is a gigabyte,
    // and the setting would have been describing something it did not do.
    const b = blobs();
    const reg = registry();
    // Connection 1 fills the store.
    const connect = () => {
      const store = createObservationStore({ blobs: b, canReplay: () => true, canRead: () => true });
      const capture = createCapture({ store, enabled: () => true, maxBytes: 200 });
      return createOperationExecutor({
        registry: reg,
        actor: () => ({ binding: "c", clientClaim: null }),
        capture,
        sourcesOf: (req) => (req.inputs?.path ? [req.inputs.path] : []),
      });
    };
    const first = connect();
    for (const n of ["a", "b", "c"]) {
      await first.run({ ...READ, inputs: { path: `${n}.md` } }, async () => ({ content: n.repeat(60) }));
    }
    const afterFirst = [...b.map.values()].reduce((sum, v) => sum + v.length, 0);
    assert.ok(afterFirst > 0, "the first connection stored something to fill the store");

    // Connection 2 is a brand-new capture over the SAME store.
    const second = connect();
    const { operation } = await second.run(
      { ...READ, inputs: { path: "z.md" } },
      async () => ({ content: "z".repeat(60) })
    );
    const afterSecond = [...b.map.values()].reduce((sum, v) => sum + v.length, 0);
    assert.ok(afterSecond <= 200 + 120, `store stayed near the cap across connections, got ${afterSecond}`);
    assert.deepEqual(operation.observations, [], "the reconnected session did not get a fresh allowance");
    assert.match(operation.captureNote ?? "", /cap/i);
  });
});

describe("capture — provenance comes from the handler, not the raw request", () => {
  test("a handler that resolves an address reports the RESOLVED path", async () => {
    // Callers may address a note as `uid:019f…`, and the guard
    // resolves that to a real path deep inside the call — AFTER the executor
    // has already been handed the raw arguments. Recording provenance from the
    // raw request would store the literal string `uid:019f…` as the source, and
    // playback authorization asks whether the reader can see the source PATH.
    // `uid:019f…` is not a path, so the payload would be unreadable forever.
    const { executor, store, observations } = harness({ enabled: true });
    const { operation } = await executor.run(
      { ...READ, inputs: { path: "uid:019f-abc" } },
      async (_mark, ctx) => {
        ctx.setSources(["Notes/Real Note.md"]);
        return { content: "resolved body" };
      }
    );
    assert.equal(observations.length, 1, "it was captured");
    assert.deepEqual(
      observations[0].sourceState.map((s) => s.path ?? s),
      ["Notes/Real Note.md"],
      "the resolved path is the recorded source, not the uid: address"
    );
    // And it is actually replayable, which is the whole point.
    const played = await store.playback(observations[0].result.payloadObject, { reader: "human-1" });
    assert.deepEqual(played.payload, { content: "resolved body" });
    assert.equal(operation.observations.length, 1);
  });

  test("a handler that reports nothing falls back to the surface's sourcesOf", async () => {
    const { executor, observations } = harness({ enabled: true });
    await executor.run({ ...READ, inputs: { path: "Plain.md" } }, async () => ({ content: "x" }));
    assert.equal(observations.length, 1);
  });
});

// ── a capture failure never costs the caller ─────────────────────────────────

describe("capture — failure degrades observability, never the operation", () => {
  test("a throwing store does not fail the read", async () => {
    // Same rule the write journal already follows.
    const b = blobs();
    b.put = async () => { throw new Error("disk on fire"); };
    const store = createObservationStore({ blobs: b, canReplay: () => true, canRead: () => true });
    const capture = createCapture({ store, enabled: () => true, maxBytes: 1e6 });
    const executor = createOperationExecutor({
      registry: registry(),
      actor: () => ({ binding: "c", clientClaim: null }),
      capture,
      sourcesOf: () => ["A.md"],
    });
    const { result, operation } = await executor.run({ ...READ, inputs: {} }, async () => ({ content: "kept" }));
    assert.deepEqual(result, { content: "kept" });
    assert.match(operation.captureNote ?? "", /failed/i);
  });
});

// ── the native action's own contract ─────────────────────────────────────────

describe("capture — the native read declares what it can back", () => {
  test("note.read is native, replayable, and may support a proposal", () => {
    assert.equal(NOTE_READ_V1.native, true);
    assert.equal(NOTE_READ_V1.observations.defaultCapture, "replayable");
    assert.equal(NOTE_READ_V1.observations.supportsProposal, true);
  });

  test("it is a read: no change classes, no effects, not Governor-only", () => {
    assert.deepEqual(NOTE_READ_V1.changeClasses, []);
    assert.deepEqual(NOTE_READ_V1.effects.direct, []);
    assert.equal(NOTE_READ_V1.authority.governorOnly, false);
  });
});

describe("capture — a guarded territory is never retained outside itself", () => {
  // The gap #322 named: reads under a guarded territory (80-89 is legal/PII
  // with a standing rule that its contents do not leave it) were legal — and
  // must stay legal — but capture would have written their bodies to a durable
  // store OUTSIDE the territory. Retention is what the territory forbids, so
  // capture refuses; the read itself is untouched.
  const guarded = (path) => path.startsWith("80-89");

  test("a read sourced from a guarded territory is NOT stored, and says why", async () => {
    const { executor, blobs: b } = harness({ enabled: true, excludedSource: guarded });
    const { result, operation } = await executor.run(
      { ...READ, inputs: { path: "80-89 Sensitive/evidence.md" } },
      async () => ({ content: "sensitive body" })
    );
    assert.deepEqual(result, { content: "sensitive body" }, "the read still succeeds — reading there is legal");
    assert.equal(b.map.size, 0, "nothing durable was written");
    assert.deepEqual(operation.observations, []);
    assert.match(operation.captureNote ?? "", /guarded territory/i);
    assert.match(operation.captureNote ?? "", /80-89 Sensitive\/evidence\.md/, "the refusal names the guarded source");
  });

  test("ONE guarded source refuses the WHOLE payload — a mixed read is not split", async () => {
    // The payload is one object; keeping "just the ungoverned part" would still
    // retain the guarded part inside it.
    const { executor, blobs: b } = harness({ enabled: true, excludedSource: guarded });
    const { operation } = await executor.run(
      { ...READ, inputs: {} },
      async (_mark, ctx) => {
        ctx.setSources(["Notes/fine.md", "80-89 Sensitive/evidence.md"]);
        return { content: "merged bodies" };
      }
    );
    assert.equal(b.map.size, 0);
    assert.match(operation.captureNote ?? "", /guarded/i);
  });

  test("an ordinary read is unaffected by the gate's presence", async () => {
    const { executor, blobs: b } = harness({ enabled: true, excludedSource: guarded });
    await executor.run({ ...READ, inputs: { path: "Notes/plain.md" } }, async () => ({ content: "x" }));
    assert.equal(b.map.size, 1);
  });

  test("the PRODUCTION predicate has the semantics the tests assume", () => {
    // The behavioral tests above use a local lambda; this pins the real
    // isExcludedTerritory, so breaking its prefix semantics (startsWith → ===,
    // dropped normalization) fails here instead of leaving 3641 green tests
    // over a gate that no longer matches anything.
    assert.ok(isExcludedTerritory("80-89 Sensitive/evidence.md", LEGACY_TERRITORY_SEED), "prefix match, no trailing slash on the prefix");
    assert.ok(isExcludedTerritory("obsidian-old/anything/deep.md", LEGACY_TERRITORY_SEED));
    assert.ok(isExcludedTerritory("./80-89 Sensitive/evidence.md", LEGACY_TERRITORY_SEED), "leading ./ is normalized away");
    assert.ok(isExcludedTerritory("Notes/../80-89 Sensitive/evidence.md", LEGACY_TERRITORY_SEED), "traversal into the territory is caught");
    assert.ok(isExcludedTerritory("../outside-the-vault.md", LEGACY_TERRITORY_SEED), "an upward escape fails CLOSED");
    assert.ok(!isExcludedTerritory("Notes/plain.md", LEGACY_TERRITORY_SEED));
    assert.ok(!isExcludedTerritory("80s music/list.md", LEGACY_TERRITORY_SEED), "no false positive on a shared-prefix folder... "
      + "(80-89* does match by design; '80s' must not)");
  });

  test("the gate is actually WIRED in production, not merely available", async () => {
    // The inert-toggle bug (#318's review, finding 1) was exactly this shape:
    // the mechanism existed, tests exercised it against fixtures, and the one
    // line connecting it to production was missing. So the wiring is pinned at
    // the source: buildMcpServer must hand createCapture the shared territory
    // predicate, and the predicate must come from @vault-mcp/core territories.
    const fs = await import("node:fs");
    const server = fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    // Anchored with a trailing boundary. Without it this was a PREFIX match, so
    // `excludedSource: isExcludedTerritoryOverride` — a local always-false stub,
    // with the real import left unused (tsconfig sets no noUnusedLocals) — satisfied
    // the pin while disabling the guard that keeps capture from retaining 80-89
    // content. Found in the 2026-08-29 review; the companion import pin below was
    // already anchored, this one was not.
      // #397 made the list the operator's SETTING, so the wiring is no longer a
      // bare reference — it is a lambda resolving the configured list per call.
      // The pin FOLLOWS the change rather than being relaxed, and each of the
      // three parts it requires is a real failure mode:
      //   • `isExcludedTerritory(` — the shared predicate is still the matcher;
      //   • `resolveTerritories(` — skip it and a fresh install passes the raw
      //     EMPTY array, and `"".startsWith` is true for every path, so nothing
      //     would be guarded at all;
      //   • `ctx.getSettings()` INSIDE the lambda — read per call. Hoisting it to
      //     build time is the inert-toggle bug in a new costume: an operator's
      //     edit would not take effect until the next reconnect.
      assert.match(
        server,
        /excludedSource:\s*\(\s*p[^)]*\)\s*=>\s*isExcludedTerritory\(\s*p\s*,\s*resolveTerritories\(\s*ctx\.getSettings\(\)\.guardedTerritories\s*\)\s*\)/,
        "createCapture must receive the predicate applied to the OPERATOR'S resolved list, read per call"
      );
    // Matched as the WHOLE import statement binding this specific name, not a bare
    // `from "@vault-mcp/core"` — server.ts imports several things from the contract
    // package, so a package-only match would keep passing if `isExcludedTerritory`
    // were later re-bound to a local copy. The point of this pin is the BINDING.
    assert.match(
      server,
        /import \{ isExcludedTerritory, resolveTerritories \} from "@vault-mcp\/core"/,
      "and it must be the SHARED list from the published contract, not a local copy"
    );
    const territories = fs.readFileSync(new URL("../../core/src/territories.ts", import.meta.url), "utf8");
    assert.match(territories, /"80-89"/, "the guarded legal/PII area is on the shared list");
  });
});

describe("capture — provenance is a precondition, not a nicety", () => {
  test("a read with no recorded source is NOT stored", async () => {
    // Found by a test, not by design. The store refuses a source-less payload
    // at playback, so capturing one writes note text nobody can ever read
    // back — the whole privacy cost of retention with none of the benefit.
    const { executor, blobs: b } = harness({ enabled: true });
    const { operation } = await executor.run({ ...READ, inputs: {} }, async () => ({ content: "orphan" }));
    assert.equal(b.map.size, 0);
    assert.match(operation.captureNote ?? "", /provenance|source/i);
  });
});
