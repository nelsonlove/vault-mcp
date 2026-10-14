/**
 * obsidian-drift-source.test.mjs — the drift pane's adapter applies the same
 * refusals `runCli` does (#294): a pack the baseline describes that did not run
 * must not read as CLEARED. Headless over a fake app; the module's `obsidian`
 * import is type-only. Since #493 the baseline path is the vault conventions'
 * `baselineRel` setting, read per scan; none configured refuses.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { obsidianDriftSource } from "../src/obsidian-drift-source.ts";
import { LEGACY_CONVENTIONS_SEED as SEED } from "../src/kernel/vault-conventions.ts";

const app = (root) => ({ vault: { adapter: { basePath: root } } });

// A local path, not a shipped one (#493). Under the seed's systemRoot, as before.
const REL = "00-09 System/Records/Conformance baseline.md";
const withRel = (conv, rel = REL) => ({ ...conv, baselineRel: rel });

const ENV_KEYS = ["GOVERNOR_BASELINE_REL", "ASSENT_BASELINE_REL"];
async function withoutEnvOverride(fn) {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
  for (const k of ENV_KEYS) delete process.env[k];
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v; else delete process.env[k];
  }
}

async function withBaseline(text, rel = REL) {
  const root = await mkdtemp(path.join(tmpdir(), "drift-source-"));
  await mkdir(path.join(root, "Notes"), { recursive: true });
  await writeFile(path.join(root, "Notes", "A.md"), "---\ntitle: A\n---\nbody\n");
  const baselinePath = path.join(root, rel);
  await mkdir(path.dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, text);
  return root;
}

describe("obsidianDriftSource — #294 coverage refusal", () => {
  test("a baseline describing drift_audit while its convention paths are dead → scan() rejects, never a silent CLEARED", async () => {
    const root = await withBaseline("```ratchet-baseline\ndrift_audit|J|category number 00 is claimed by 2 folders: 00 A; 00 B|\n```\n");
    try {
      await withoutEnvOverride(async () => {
        // The seed's systemRoot (`00-09 System`) is LIVE in this fixture, since the baseline path lives under it; a dead spine is what this test is about (#412: systemRoot is the one convention drift reads).
        await assert.rejects(() => obsidianDriftSource(app(root), () => [], () => withRel({ ...SEED, systemRoot: "Nowhere/Spine" })).scan(), /refusing to report: the baseline holds accepted debt for drift_audit/);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a baseline that describes only packs that ran → scan() completes", async () => {
    const root = await withBaseline("```ratchet-baseline\nste_lint|editable|Notes/A.md|x\n```\n");
    try {
      await withoutEnvOverride(async () => {
        const groups = await obsidianDriftSource(app(root), () => [], () => withRel(SEED)).scan();
        assert.ok(Array.isArray(groups));
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("obsidianDriftSource — #493: the baseline path is the live setting", () => {
  test("no baseline configured → scan() refuses with 'no conformance baseline is configured', never an empty-baseline scan", async () => {
    const root = await withBaseline("```ratchet-baseline\nste_lint|editable|Notes/A.md|x\n```\n");
    try {
      await withoutEnvOverride(async () => {
        await assert.rejects(() => obsidianDriftSource(app(root), () => [], () => withRel(SEED, "")).scan(), /no conformance baseline is configured/);
        await assert.rejects(() => obsidianDriftSource(app(root), () => [], () => withRel(SEED, "   ")).scan(), /no conformance baseline is configured/, "a blank setting is none");
        await assert.rejects(() => obsidianDriftSource(app(root)).scan(), /no conformance baseline is configured/, "no conventions thunk at all: none");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a configured note that is missing → scan() refuses, naming the path", async () => {
    const root = await withBaseline("x", "Elsewhere/b.md");
    try {
      await withoutEnvOverride(async () => {
        await assert.rejects(() => obsidianDriftSource(app(root), () => [], () => withRel(SEED)).scan(), /the conformance baseline note is missing: '00-09 System\/Records\/Conformance baseline\.md'/, "the same in-app refusal the debt tools give");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the SETTING beats the env override; the env override is read only when the setting is blank", async () => {
    // Only the setting's note is a valid baseline; the env one names a missing note.
    const root = await withBaseline("```ratchet-baseline\nste_lint|editable|Notes/A.md|x\n```\n");
    try {
      await withoutEnvOverride(async () => {
        process.env.GOVERNOR_BASELINE_REL = "Env/Missing baseline.md";
        assert.ok(Array.isArray(await obsidianDriftSource(app(root), () => [], () => withRel(SEED)).scan()), "the setting is read, not the env");
        await assert.rejects(() => obsidianDriftSource(app(root), () => [], () => withRel(SEED, "")).scan(), /Env\/Missing baseline\.md/, "blank setting: the env override is read");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("scan() reads the path per call: changing the setting between two scans makes the second scan use the new path", async () => {
    // Only B exists. The first scan names A (absent) and refuses as missing; the
    // second names B and completes — the same source object, no reload.
    const relA = "00-09 System/A/Conformance baseline.md";
    const relB = "00-09 System/B/Conformance baseline.md";
    const root = await withBaseline("```ratchet-baseline\nste_lint|editable|Notes/A.md|x\n```\n", relB);
    try {
      await withoutEnvOverride(async () => {
        let current = relA;
        const src = obsidianDriftSource(app(root), () => [], () => withRel(SEED, current));
        await assert.rejects(() => src.scan(), (e) => e instanceof Error && e.message.includes("A/Conformance baseline.md"), "the first scan reads A, which is missing");
        current = relB;
        assert.ok(Array.isArray(await src.scan()), "the second scan reads B");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a missing note whose path came from GOVERNOR_BASELINE_REL (the setting blank) says so; one from the setting names the setting", async () => {
    const root = await withBaseline("x", "Elsewhere/b.md");
    try {
      await withoutEnvOverride(async () => {
        process.env.GOVERNOR_BASELINE_REL = "Env/Missing baseline.md";
        await assert.rejects(() => obsidianDriftSource(app(root), () => [], () => withRel(SEED, "")).scan(), (e) => /the conformance baseline note is missing: 'Env\/Missing baseline\.md' \(GOVERNOR_BASELINE_REL in Obsidian's environment names it/.test(e.message), "fromEnv: the env is named");
        await assert.rejects(() => obsidianDriftSource(app(root), () => [], () => withRel(SEED)).scan(), (e) => /\(the Vault MCP Conformance plugin's settings name it\)/.test(e.message), "from the setting: the setting is named, even with the env set");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
