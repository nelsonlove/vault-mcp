import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMirrorBoundary } from "../src/kernel/survey/boundary.js";

// checkMirrorBoundary reads the boundary from ASSENT_CONTENT_ROOT /
// ASSENT_VAULT_ROOT at call time (matching packages/conformance/src/kernel/snapshot.ts's own
// declaredBoundary), so these tests set and restore them around each case
// rather than mocking — there's no injection seam for env vars here, same as
// snapshot.ts's own tests.

const ORIG_CONTENT_ROOT = process.env.ASSENT_CONTENT_ROOT;
const ORIG_VAULT_ROOT = process.env.ASSENT_VAULT_ROOT;

function withBoundary(boundary, fn) {
  delete process.env.ASSENT_VAULT_ROOT;
  process.env.ASSENT_CONTENT_ROOT = boundary;
  try {
    return fn();
  } finally {
    if (ORIG_CONTENT_ROOT === undefined) delete process.env.ASSENT_CONTENT_ROOT;
    else process.env.ASSENT_CONTENT_ROOT = ORIG_CONTENT_ROOT;
    if (ORIG_VAULT_ROOT === undefined) delete process.env.ASSENT_VAULT_ROOT;
    else process.env.ASSENT_VAULT_ROOT = ORIG_VAULT_ROOT;
  }
}

function withNoBoundary(fn) {
  delete process.env.ASSENT_CONTENT_ROOT;
  delete process.env.ASSENT_VAULT_ROOT;
  try {
    return fn();
  } finally {
    if (ORIG_CONTENT_ROOT === undefined) delete process.env.ASSENT_CONTENT_ROOT;
    else process.env.ASSENT_CONTENT_ROOT = ORIG_CONTENT_ROOT;
    if (ORIG_VAULT_ROOT === undefined) delete process.env.ASSENT_VAULT_ROOT;
    else process.env.ASSENT_VAULT_ROOT = ORIG_VAULT_ROOT;
  }
}

test("checkMirrorBoundary refuses with no boundary declared — no default to $HOME or cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-boundary-"));
  try {
    const r = withNoBoundary(() => checkMirrorBoundary(dir));
    assert.equal(r?.code, "no_boundary_declared");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkMirrorBoundary permits a real path inside the declared boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "survey-boundary-"));
  const inner = join(root, "mirror");
  mkdirSync(inner);
  try {
    const r = withBoundary(root, () => checkMirrorBoundary(inner));
    assert.equal(r, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkMirrorBoundary refuses a path outside the declared boundary — the vulnerability this closes", () => {
  const boundary = mkdtempSync(join(tmpdir(), "survey-boundary-a-"));
  const outside = mkdtempSync(join(tmpdir(), "survey-boundary-b-"));
  try {
    const r = withBoundary(boundary, () => checkMirrorBoundary(outside));
    assert.equal(r?.code, "outside_boundary");
  } finally {
    rmSync(boundary, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("checkMirrorBoundary refuses a denied territory even when it's the declared boundary itself", () => {
  const root = mkdtempSync(join(tmpdir(), "survey-boundary-"));
  const denied = join(root, ".git");
  mkdirSync(denied);
  try {
    // Declaring the denied directory as ITS OWN boundary must not launder it —
    // matching snapshot.ts's "refused even when explicitly requested" rule.
    const r = withBoundary(denied, () => checkMirrorBoundary(denied));
    assert.equal(r?.code, "denied_territory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkMirrorBoundary permits a not-yet-existing path when its parent resolves inside the boundary", () => {
  // intendedRealPath resolves a plausible non-existent child to where it
  // WOULD be (it's meant for pre-flight checks on write targets), so this is
  // "permitted at the boundary layer" — resolveMirrorDir's own separate
  // fs.statSync existence check is what turns a not-yet-existing mirror dir
  // into "not_found"; checkMirrorBoundary's job stops at "would this be
  // allowed if it existed".
  const boundary = mkdtempSync(join(tmpdir(), "survey-boundary-"));
  try {
    const r = withBoundary(boundary, () => checkMirrorBoundary(join(boundary, "does-not-exist-yet")));
    assert.equal(r, null);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("checkMirrorBoundary refuses a truly unresolvable path (a symlink loop) rather than assuming it's safe", () => {
  const boundary = mkdtempSync(join(tmpdir(), "survey-boundary-"));
  const a = join(boundary, "a");
  const b = join(boundary, "b");
  try {
    symlinkSync(b, a);
    symlinkSync(a, b);
    const r = withBoundary(boundary, () => checkMirrorBoundary(a));
    assert.equal(r?.code, "unresolvable");
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("checkMirrorBoundary follows a symlink to its real target for the boundary check — a symlink cannot escape it", () => {
  const boundary = mkdtempSync(join(tmpdir(), "survey-boundary-in-"));
  const outside = mkdtempSync(join(tmpdir(), "survey-boundary-out-"));
  const link = join(boundary, "escape");
  try {
    symlinkSync(outside, link);
    const r = withBoundary(boundary, () => checkMirrorBoundary(link));
    assert.equal(r?.code, "outside_boundary");
  } finally {
    rmSync(boundary, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
