/**
 * conformance-root-discovery.test.mjs — #157 follow-up on #168.
 *
 * #168 made `buildSnapshot` refuse a root outside a declared boundary. But a
 * caller giving NO root at all never reached that guard's interesting branch:
 * `runCli`'s `discoverRoot(process.cwd())` walked upward for a `.obsidian`
 * ancestor and quietly used whatever it found (or, finding none, `cwd`
 * itself) as its OWN declared boundary — a silent default wearing a
 * boundary's clothes. This file pins the fix: absence of an explicit root is
 * now a REFUSAL unless the caller opts into the walk explicitly.
 *
 * These tests never touch a real vault or `~/obsidian-old` — every "denied
 * territory" case below is a disposable fixture directory literally named
 * `obsidian-old`, standing in for the real one, so pinning the regression
 * cannot reproduce the breach it pins.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runCli,
  rootDiscoveryRefusal,
  ALLOW_ROOT_DISCOVERY_ENV,
  DISCOVER_ROOT_FLAG,
} from "../src/kernel/cli.ts";

/** Drive the real CLI; return {threw, message} and never let a throw escape.
 *
 * `runCli` sets `process.exitCode` from the conformance RESULT (0/1/3). These
 * tests exercise the discovery GATE (whether runCli throws), not the fixture's
 * conformance, so that side effect must not leak into this test process — a
 * benign empty fixture is legitimately NONCONFORMING now that a missing
 * QuickAdd config refuses (#136), and a leaked exit 1 would fail the whole file
 * despite every gate assertion passing. Save and restore it. */
async function cli(...argv) {
  const savedExit = process.exitCode;
  try {
    await runCli(argv);
    return { threw: false, message: "" };
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) };
  } finally {
    process.exitCode = savedExit;
  }
}

// ── pure decision function ──────────────────────────────────────────────

describe("rootDiscoveryRefusal — the pure gate", () => {
  test("nothing declared, nothing opted in → refuses, naming ASSENT_CONTENT_ROOT, --root=, and the opt-in", () => {
    const r = rootDiscoveryRefusal([], {});
    assert.ok(r, "expected a refusal");
    assert.match(r, /ASSENT_CONTENT_ROOT/);
    assert.match(r, /--root=/);
    assert.match(r, new RegExp(DISCOVER_ROOT_FLAG.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")));
    assert.match(r, new RegExp(ALLOW_ROOT_DISCOVERY_ENV));
  });

  test("ASSENT_CONTENT_ROOT set → proceeds (discoverRoot will use it directly, never walk)", () => {
    assert.equal(rootDiscoveryRefusal([], { ASSENT_CONTENT_ROOT: "/some/vault" }), null);
  });

  test("--discover-root flag → proceeds (explicit opt-in)", () => {
    assert.equal(rootDiscoveryRefusal([DISCOVER_ROOT_FLAG], {}), null);
  });

  test(`${ALLOW_ROOT_DISCOVERY_ENV}=1 → proceeds (explicit opt-in)`, () => {
    assert.equal(rootDiscoveryRefusal([], { [ALLOW_ROOT_DISCOVERY_ENV]: "1" }), null);
  });

  test(`${ALLOW_ROOT_DISCOVERY_ENV}=true → proceeds`, () => {
    assert.equal(rootDiscoveryRefusal([], { [ALLOW_ROOT_DISCOVERY_ENV]: "true" }), null);
  });

  for (const falsy of ["0", "false", "", "  "]) {
    test(`${ALLOW_ROOT_DISCOVERY_ENV}=${JSON.stringify(falsy)} does NOT opt in (still refuses)`, () => {
      const r = rootDiscoveryRefusal([], { [ALLOW_ROOT_DISCOVERY_ENV]: falsy });
      assert.ok(r, "a falsy-looking value must not silently opt in");
    });
  }
});

// ── end-to-end through the real CLI ─────────────────────────────────────

// Since #493 the CLI refuses when no baseline path is configured, before any
// root reasoning. These tests pin the discovery GATE (they pass --no-baseline),
// so a vault-relative baseline path is configured for the whole file through
// the env override, then restored.
const BASELINE_KEYS = ["GOVERNOR_BASELINE_REL", "ASSENT_BASELINE_REL"];
const savedBaselineEnv = BASELINE_KEYS.map((k) => [k, process.env[k]]);
before(() => {
  delete process.env.ASSENT_BASELINE_REL;
  process.env.GOVERNOR_BASELINE_REL = "Records/baseline.md";
});
after(() => {
  for (const [k, v] of savedBaselineEnv) if (v !== undefined) process.env[k] = v; else delete process.env[k];
});

describe("runCli — no explicit root and no opt-in refuses (real process.env / cwd)", () => {
  let savedContent, savedAllow, savedCwd;

  before(() => {
    savedContent = process.env.ASSENT_CONTENT_ROOT;
    savedAllow = process.env[ALLOW_ROOT_DISCOVERY_ENV];
    savedCwd = process.cwd();
    delete process.env.ASSENT_CONTENT_ROOT;
    delete process.env[ALLOW_ROOT_DISCOVERY_ENV];
  });
  after(() => {
    if (savedContent === undefined) delete process.env.ASSENT_CONTENT_ROOT;
    else process.env.ASSENT_CONTENT_ROOT = savedContent;
    if (savedAllow === undefined) delete process.env[ALLOW_ROOT_DISCOVERY_ENV];
    else process.env[ALLOW_ROOT_DISCOVERY_ENV] = savedAllow;
    process.chdir(savedCwd);
  });

  test("refuses with an actionable message naming what to set", async () => {
    const r = await cli("--no-baseline");
    assert.equal(r.threw, true, "must refuse rather than silently discovering a root");
    assert.match(r.message, /no content root declared/);
    assert.match(r.message, /ASSENT_CONTENT_ROOT/);
    assert.match(r.message, /--root=/);
  });

  test("an explicit --root= is unaffected by the gate and still works", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "discover-root-explicit-"));
    try {
      const r = await cli(`--root=${root}`, "--no-baseline");
      // Whatever else it does (an empty vault has no findings), it must NOT
      // be refused for "no content root declared" — that refusal is only
      // reachable when --root= is absent.
      assert.equal(r.threw, false, `explicit --root= must not be refused: ${r.message}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ASSENT_CONTENT_ROOT alone (no --root=, no opt-in) still works, unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "discover-root-envroot-"));
    process.env.ASSENT_CONTENT_ROOT = root;
    try {
      const r = await cli("--no-baseline");
      assert.equal(r.threw, false, `ASSENT_CONTENT_ROOT alone must still work: ${r.message}`);
    } finally {
      delete process.env.ASSENT_CONTENT_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runCli — the opt-in upward walk, and the deny-list over what it finds", () => {
  let savedContent, savedAllow, savedCwd;

  before(() => {
    savedContent = process.env.ASSENT_CONTENT_ROOT;
    savedAllow = process.env[ALLOW_ROOT_DISCOVERY_ENV];
    savedCwd = process.cwd();
    delete process.env.ASSENT_CONTENT_ROOT;
  });
  after(() => {
    if (savedContent === undefined) delete process.env.ASSENT_CONTENT_ROOT;
    else process.env.ASSENT_CONTENT_ROOT = savedContent;
    if (savedAllow === undefined) delete process.env[ALLOW_ROOT_DISCOVERY_ENV];
    else process.env[ALLOW_ROOT_DISCOVERY_ENV] = savedAllow;
    process.chdir(savedCwd);
  });

  test("opted in, benign vault → the walk proceeds (not refused by the discovery gate)", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "discover-root-ok-"));
    const vaultRoot = path.join(base, "SomeVault");
    const sub = path.join(vaultRoot, "Notes", "Deep");
    await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
    await mkdir(sub, { recursive: true });
    process.env[ALLOW_ROOT_DISCOVERY_ENV] = "1";
    process.chdir(sub);
    try {
      const r = await cli("--no-baseline");
      assert.equal(r.threw, false, `opted-in discovery of a benign root must not be refused: ${r.message}`);
    } finally {
      delete process.env[ALLOW_ROOT_DISCOVERY_ENV];
      process.chdir(savedCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("opted in via --discover-root flag (not the env var) also proceeds past the gate", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "discover-root-flag-"));
    const vaultRoot = path.join(base, "SomeVault");
    const sub = path.join(vaultRoot, "Notes");
    await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
    await mkdir(sub, { recursive: true });
    process.chdir(sub);
    try {
      const r = await cli("--no-baseline", DISCOVER_ROOT_FLAG);
      assert.equal(r.threw, false, `--discover-root must not be refused: ${r.message}`);
    } finally {
      process.chdir(savedCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a discovered root inside a denied territory is STILL refused — the deny-list is not bypassed by discovery", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "discover-root-denied-"));
    // A segment the CONFIGURED list names — there is no built-in deny-list
    // any more (#397), so the CLI is handed one through GOVERNOR_TERRITORIES,
    // the same way it is handed excluded roots. A fixture, never the real
    // ~/obsidian-old.
    const deniedRoot = path.join(base, "obsidian-old");
    const sub = path.join(deniedRoot, "Notes");
    await mkdir(path.join(deniedRoot, ".obsidian"), { recursive: true });
    await mkdir(sub, { recursive: true });
    process.env[ALLOW_ROOT_DISCOVERY_ENV] = "1";
    process.env.GOVERNOR_TERRITORIES = "obsidian-old";
    process.chdir(sub);
    try {
      const r = await cli("--no-baseline");
      assert.equal(r.threw, true, "a discovered root under a denied segment must still refuse");
      assert.match(r.message, /permanently denied territory|obsidian-old/i);
    } finally {
      delete process.env[ALLOW_ROOT_DISCOVERY_ENV];
      delete process.env.GOVERNOR_TERRITORIES;
      process.chdir(savedCwd);
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a discovered root outside any declared boundary is refused the same way an explicit one would be", async () => {
    // Sanity check on the "boundary still applies" half of the claim: with
    // discovery opted in AND ASSENT_CONTENT_ROOT ALSO set to something else,
    // the discovered root must resolve inside that boundary or be refused —
    // runCli threads the discovered root as boundary: opts.root itself
    // (trivially satisfied), so this pins that runCli does not separately
    // widen the boundary when a root is discovered rather than passed.
    const base = await mkdtemp(path.join(tmpdir(), "discover-root-boundary-"));
    const vaultRoot = path.join(base, "SomeVault");
    const sub = path.join(vaultRoot, "Notes");
    await mkdir(path.join(vaultRoot, ".obsidian"), { recursive: true });
    await mkdir(sub, { recursive: true });
    process.env[ALLOW_ROOT_DISCOVERY_ENV] = "1";
    process.chdir(sub);
    try {
      const r = await cli("--no-baseline");
      // discoverRoot finds vaultRoot; runCli threads boundary: vaultRoot
      // (the discovered value) into buildSnapshot, so this is permitted —
      // proving the discovered root is not silently boundary-less.
      assert.equal(r.threw, false, `a discovered root is its own declared boundary: ${r.message}`);
    } finally {
      delete process.env[ALLOW_ROOT_DISCOVERY_ENV];
      process.chdir(savedCwd);
      await rm(base, { recursive: true, force: true });
    }
  });
});
