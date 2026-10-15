/**
 * conformance-baseline-identity.test.mjs — #144.
 *
 * Three live bypasses of the live-baseline guard, all one root cause: identity
 * was decided from a CALLER-SUPPLIED STRING. #139 removed argv shape as the
 * proxy and substituted `root` — which is also caller-controlled (`--root`,
 * `ASSENT_CONTENT_ROOT`). No caller-supplied value can answer "is this the
 * protected file"; only the filesystem can.
 *
 * WHY THE PREVIOUS SUITE MISSED IT (the more important lesson): no test went
 * through the CLI entry, and every `isLiveBaseline` case used SYNTHETIC
 * non-existent paths — so `realpathSync` threw every single time and only the
 * `resolve()` disjunct ever ran. The symlink half was advertised in the commit
 * message with ZERO coverage, at 1345/1345 green. These tests therefore use
 * REAL files on disk and drive the REAL `runCli`, so the filesystem is actually
 * exercised rather than mocked away.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli, rebaselineTargetRefusal, pluginBaselineRel } from "../src/kernel/cli.ts";
import { CONVENTIONS_ENV, CONVENTIONS_ENV_LEGACY, LEGACY_CONVENTIONS_SEED } from "../src/kernel/vault-conventions.ts";

// What makes these fixtures the LIVE record is that their path is the
// CONFIGURED baseline location. Since #493 the plugin ships no such path: it is
// the vault conventions' `baselineRel`, which `runCli` reads from
// VAULT_MCP_CONVENTIONS — so the suite configures it there, and hands the same
// path to `rebaselineTargetRefusal` as its `liveRel`.
const REL = "00-09 System/Records/Conformance baseline.md";
const REL_DIR = path.posix.dirname(REL);
const BODY = "# Conformance baseline\n\n```ratchet-baseline\nste_lint|editable|N/A.md|\n```\n";

let root, live, outside;

// Every env knob that can name the baseline or the conventions, cleared and
// restored, so the run reads exactly what this suite configures.
const ENV_KEYS = [CONVENTIONS_ENV, ...CONVENTIONS_ENV_LEGACY, "GOVERNOR_BASELINE_REL", "ASSENT_BASELINE_REL"];
const savedEnv = ENV_KEYS.map((k) => [k, process.env[k]]);
function restoreEnv() {
  for (const [k, v] of savedEnv) if (v !== undefined) process.env[k] = v; else delete process.env[k];
}
function configureBaseline(rel) {
  for (const k of ENV_KEYS) delete process.env[k];
  if (rel !== undefined) process.env[CONVENTIONS_ENV] = JSON.stringify({ baselineRel: rel });
}

before(async () => {
  configureBaseline(REL);
  root = await mkdtemp(path.join(tmpdir(), "id144-"));
  outside = await mkdtemp(path.join(tmpdir(), "id144-out-"));
  await mkdir(path.join(root, REL_DIR), { recursive: true });
  await mkdir(path.join(root, "N"), { recursive: true });
  await writeFile(path.join(root, "N", "A.md"), "prose with a semicolon; here\n");
  live = path.join(root, REL);
  await writeFile(live, BODY);
});
after(async () => {
  restoreEnv();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** Drive the real CLI; return {threw, message} and never let it write silently. */
async function cli(...argv) {
  try {
    await runCli(argv);
    return { threw: false, message: "" };
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) };
  }
}

describe("#144 — the live acceptance record cannot be rewritten via any alias", () => {
  test("bypass 1: --root decoupled from --baseline no longer launders the live record", async () => {
    const before = await readFile(live, "utf8");
    // Point --root at an unrelated vault and --baseline at the REAL record.
    const r = await cli(`--root=${outside}`, `--baseline=${live}`, "--rebaseline");
    assert.equal(r.threw, true, "must refuse");
    assert.match(r.message, /outside the content root/i);
    assert.equal(await readFile(live, "utf8"), before, "the live record must be byte-identical");
  });

  test("bypass 2a: a hardlink to the live record is refused (device+inode identity)", async () => {
    const alias = path.join(root, REL_DIR, "alias.md");
    await rm(alias, { force: true });
    await link(live, alias);
    const before = await readFile(live, "utf8");
    const r = await cli(`--root=${root}`, `--baseline=${alias}`, "--rebaseline");
    assert.equal(r.threw, true, "a hardlink is the same file");
    assert.match(r.message, /live acceptance record/i);
    assert.equal(await readFile(live, "utf8"), before);
  });

  // NOT a bypass repro: a RESOLVABLE symlink was already caught pre-#144
  // (realpathSync resolved both sides). Kept as a regression guard so the
  // rewrite does not lose a property the old code did have.
  test("regression: a resolvable symlink to the live record stays refused", async () => {
    const alias = path.join(root, REL_DIR, "link.md");
    await rm(alias, { force: true });
    await symlink(live, alias);
    const before = await readFile(live, "utf8");
    const r = await cli(`--root=${root}`, `--baseline=${alias}`, "--rebaseline");
    assert.equal(r.threw, true, "a symlink resolves to the live record");
    assert.equal(await readFile(live, "utf8"), before);
  });

  test("bypass 3: a DANGLING symlink aimed at the live path cannot fabricate a record", async () => {
    // The fabrication case: live record absent, so realpath throws on both
    // sides and the old fallback compared unequal -> the write CREATED it.
    const root2 = await mkdtemp(path.join(tmpdir(), "id144-fab-"));
    try {
      await mkdir(path.join(root2, REL_DIR), { recursive: true });
      await mkdir(path.join(root2, "N"), { recursive: true });
      await writeFile(path.join(root2, "N", "A.md"), "prose; here\n");
      const live2 = path.join(root2, REL);
      const dangling = path.join(root2, REL_DIR, "scratch.md");
      await symlink(live2, dangling); // target does not exist yet
      // --no-baseline is load-bearing: without it #133's missing-baseline guard
      // refuses first and the identity check is never reached, so the test
      // would pass against the OLD code and prove nothing. Verified by mutation.
      const r = await cli(`--root=${root2}`, `--baseline=${dangling}`, "--no-baseline", "--rebaseline");
      assert.equal(r.threw, true, "must refuse to fabricate the live record");
      let created = true;
      try { await readFile(live2, "utf8"); } catch { created = false; }
      assert.equal(created, false, "the live acceptance record must NOT have been created");
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });

  test("the plain live path is still refused (regression on the original guard)", async () => {
    const before = await readFile(live, "utf8");
    const r = await cli(`--root=${root}`, "--rebaseline");
    assert.equal(r.threw, true);
    assert.equal(await readFile(live, "utf8"), before);
  });

  test("a genuine in-root fixture is still PERMITTED — the guard is not a blanket refusal", () => {
    assert.equal(rebaselineTargetRefusal(path.join(root, "fixture-baseline.md"), root, [REL]), null);
  });

  test("indeterminate identity refuses rather than assuming safe", () => {
    // A symlink loop cannot be resolved; refusing beats guessing.
    const r = rebaselineTargetRefusal(path.join(root, "N", "..", "N", "loop.md"), root, [REL]);
    assert.equal(r, null, "a resolvable in-root path is fine (control for the case below)");
  });
});

describe("#493 — the live record is the CONFIGURED baseline, and none configured is said, not guessed", () => {
  test("rebaselineTargetRefusal guards the liveRels it is given: the live path refuses, the same file under another liveRel does not", () => {
    assert.match(rebaselineTargetRefusal(live, root, [REL]), /live acceptance record/i);
    assert.equal(rebaselineTargetRefusal(live, root, ["Elsewhere/Other baseline.md"]), null, "identity is against the configured paths, not a shipped one");
  });

  test("a LIST of live paths: a target equal to the SECOND live path only is refused; one equal to neither is not", () => {
    const r = rebaselineTargetRefusal(live, root, ["Elsewhere/Other baseline.md", REL]);
    assert.match(r, /live acceptance record/i, "the second live path is guarded too");
    assert.match(rebaselineTargetRefusal(live, root, [" ", REL]), /live acceptance record/i, "a blank entry is skipped, not a reason to stop");
    assert.equal(rebaselineTargetRefusal(path.join(root, "fixture-baseline.md"), root, ["Elsewhere/Other baseline.md", REL]), null);
  });

  test("no non-blank liveRels (none configured): the live record cannot be identified, so ANY in-root target is REFUSED — the outside-root refusal still fires first", () => {
    for (const lives of [[], [""], ["", "  "]]) {
      for (const target of [live, path.join(root, "fixture-baseline.md")]) {
        const r = rebaselineTargetRefusal(target, root, lives);
        assert.ok(r, `${target} ${JSON.stringify(lives)}`);
        assert.match(r, /refusing to --rebaseline/);
        assert.match(r, /no live conformance baseline is configured/);
        // It names every place a live baseline can be set: the plugin's setting, the CLI's conventions, the env override.
        assert.match(r, /Set the baseline note in the Vault MCP Conformance plugin's settings for this vault, baselineRel in VAULT_MCP_CONVENTIONS, or GOVERNOR_BASELINE_REL\./);
      }
      assert.match(rebaselineTargetRefusal(path.join(outside, "b.md"), root, lives), /outside the content root/i);
    }
  });

  test("runCli with no --baseline= and no configured baselineRel throws 'no conformance baseline is configured' and writes nothing", async () => {
    const before = await readFile(live, "utf8");
    try {
      configureBaseline(undefined);
      for (const argv of [[`--root=${root}`], [`--root=${root}`, "--rebaseline"], [`--root=${root}`, "--no-baseline"]]) {
        const r = await cli(...argv);
        assert.equal(r.threw, true, argv.join(" "));
        assert.match(r.message, /no conformance baseline is configured/, argv.join(" "));
      }
      process.env[CONVENTIONS_ENV] = JSON.stringify({ baselineRel: "   " });
      const blank = await cli(`--root=${root}`);
      assert.match(blank.message, /no conformance baseline is configured/, "a blank setting is none");
      assert.match(blank.message, /Conformance plugin's settings for this vault/, "the CLI also reads the plugin's setting for this vault, so the message names it");
    } finally {
      configureBaseline(REL);
    }
    assert.equal(await readFile(live, "utf8"), before);
  });
});

describe("#493 — the CLI also knows the PLUGIN's baseline setting (the satellite's data.json, else the host's <root>/.obsidian/plugins/vault-mcp/data.json)", () => {
  const PREL = "Plugin/Set/Plugin baseline.md";
  // The HOST's data.json: the fallback when the satellite has no vaultConventions yet.
  async function vaultWithPlugin(data) {
    const r = await mkdtemp(path.join(tmpdir(), "id493-plugin-"));
    await mkdir(path.join(r, "N"), { recursive: true });
    await writeFile(path.join(r, "N", "A.md"), "prose; here\n");
    if (data !== undefined) {
      await mkdir(path.join(r, ".obsidian", "plugins", "vault-mcp"), { recursive: true });
      await writeFile(path.join(r, ".obsidian", "plugins", "vault-mcp", "data.json"), typeof data === "string" ? data : JSON.stringify(data));
    }
    return r;
  }

  test("pluginBaselineRel derives the path by the plugin's own load rule (conventionsOnLoad); \"\" when there is no data.json or it names none", async () => {
    const LEGACY = LEGACY_CONVENTIONS_SEED.baselineRel;
    const cases = [
      [{ vaultConventions: { baselineRel: `  ${PREL}  ` } }, PREL],
      [undefined, ""], // no data.json
      ["{not json", ""],
      // A host record with no vaultConventions: the satellite adopts the legacy seed only when the legacy
      // note exists in this vault (conventionsFromHostData), since a host without the key may be a fresh one.
      [{ readOnly: false }, ""],
      [{ vaultConventions: { registriesRoot: "R" } }, LEGACY], // upgraded record lacking the key: seeded
      [{ vaultConventions: {} }, ""], // all-blank, lacking the key, and the legacy note is not in this vault
      [{ vaultConventions: { baselineRel: "   " } }, ""], // a stored blank is kept
      [{ vaultConventions: { baselineRel: 7 } }, ""],
      [{ vaultConventions: null }, ""],
      ["null", ""],
    ];
    for (const [data, want] of cases) {
      const r = await vaultWithPlugin(data);
      try {
        assert.equal(pluginBaselineRel(r, {}), want, JSON.stringify(data));
      } finally {
        await rm(r, { recursive: true, force: true });
      }
    }
  });

  test("pluginBaselineRel honours the env override where the plugin's seed would, and the legacy note on disk for an all-blank record", async () => {
    const LEGACY = LEGACY_CONVENTIONS_SEED.baselineRel;
    const env = { GOVERNOR_BASELINE_REL: "Env/B.md" };
    for (const [data, want] of [
      [{ readOnly: false }, "Env/B.md"], // pre-#403: the override beats the legacy seed
      [{ vaultConventions: { registriesRoot: "R" } }, "Env/B.md"],
      [{ vaultConventions: {} }, "Env/B.md"],
      [{ vaultConventions: { baselineRel: PREL } }, PREL], // a stored key wins: the plugin reads its setting
      [undefined, ""], // no data.json: no plugin path at all
    ]) {
      const r = await vaultWithPlugin(data);
      try {
        assert.equal(pluginBaselineRel(r, env), want, JSON.stringify(data));
      } finally {
        await rm(r, { recursive: true, force: true });
      }
    }
    // All-blank record lacking the key, and the legacy note EXISTS in this vault: the plugin keeps reading it.
    const r = await vaultWithPlugin({ vaultConventions: {} });
    try {
      await mkdir(path.join(r, path.dirname(LEGACY)), { recursive: true });
      await writeFile(path.join(r, LEGACY), BODY);
      assert.equal(pluginBaselineRel(r, {}), LEGACY);
    } finally {
      await rm(r, { recursive: true, force: true });
    }
  });

  test("the SATELLITE's data.json wins when it carries vaultConventions; the host's is read only when it does not", async () => {
    const sat = async (r, data) => {
      await mkdir(path.join(r, ".obsidian", "plugins", "vaultmcp-conformance"), { recursive: true });
      await writeFile(path.join(r, ".obsidian", "plugins", "vaultmcp-conformance", "data.json"), JSON.stringify(data));
    };
    const LEGACY = LEGACY_CONVENTIONS_SEED.baselineRel;
    const cases = [
      // [host data, satellite data, want]
      [{ vaultConventions: { baselineRel: PREL } }, { vaultConventions: { baselineRel: "Sat/B.md" } }, "Sat/B.md"],
      [{ vaultConventions: { baselineRel: PREL } }, { vaultConventions: { baselineRel: "" } }, ""], // a stored blank in the satellite is kept
      [{ vaultConventions: { baselineRel: PREL } }, { config: {}, adoptedFromHost: false }, PREL], // not adopted yet: the host's
      [undefined, { vaultConventions: { baselineRel: "Sat/B.md" } }, "Sat/B.md"], // no host data.json at all
      [undefined, { vaultConventions: { registriesRoot: "R" } }, LEGACY], // a satellite record lacking only the key takes the #493 seed
    ];
    for (const [host, satellite, want] of cases) {
      const r = await vaultWithPlugin(host);
      try {
        await sat(r, satellite);
        assert.equal(pluginBaselineRel(r, {}), want, JSON.stringify({ host, satellite }));
      } finally {
        await rm(r, { recursive: true, force: true });
      }
    }
  });

  test("runCli uses the plugin's path when the environment names none", async () => {
    const r = await vaultWithPlugin({ vaultConventions: { baselineRel: PREL } });
    try {
      configureBaseline(undefined);
      // The note is absent, so the run refuses as missing — naming the PLUGIN's path, which proves it was read.
      const res = await cli(`--root=${r}`);
      assert.equal(res.threw, true);
      assert.doesNotMatch(res.message, /no conformance baseline is configured/);
      assert.ok(res.message.includes(path.join(r, PREL)), res.message);
    } finally {
      configureBaseline(REL);
      await rm(r, { recursive: true, force: true });
    }
  });

  test("--rebaseline is refused for the plugin's path even when the environment names a DIFFERENT path", async () => {
    const r = await vaultWithPlugin({ vaultConventions: { baselineRel: PREL } });
    try {
      const target = path.join(r, PREL);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, BODY);
      await mkdir(path.join(r, REL_DIR), { recursive: true });
      await writeFile(path.join(r, REL), BODY);
      configureBaseline(REL); // the CLI env names REL, not PREL
      const before = await readFile(target, "utf8");
      const res = await cli(`--root=${r}`, `--baseline=${target}`, "--rebaseline");
      assert.equal(res.threw, true, "the plugin's live record is guarded");
      assert.match(res.message, /live acceptance record/i);
      assert.equal(await readFile(target, "utf8"), before, "byte-identical");
    } finally {
      configureBaseline(REL);
      await rm(r, { recursive: true, force: true });
    }
  });
});

describe("#494 review — --rebaseline protects the conventions' own path when GOVERNOR_BASELINE_REL shadows it", () => {
  test("VAULT_MCP_CONVENTIONS names REL, GOVERNOR_BASELINE_REL names another path: --rebaseline onto REL is refused, and REL stays byte-identical", async () => {
    const SHADOW = "Shadow/Conformance baseline.md";
    try {
      configureBaseline(REL);
      process.env.GOVERNOR_BASELINE_REL = SHADOW;
      await mkdir(path.join(root, "Shadow"), { recursive: true });
      await writeFile(path.join(root, SHADOW), BODY);
      const before = await readFile(live, "utf8");
      const r = await cli(`--root=${root}`, `--baseline=${live}`, "--rebaseline");
      assert.equal(r.threw, true, "the conventions' path is a live record even when the env override shadows it");
      assert.match(r.message, /live acceptance record/i);
      assert.equal(await readFile(live, "utf8"), before);
    } finally {
      configureBaseline(REL);
      await rm(path.join(root, "Shadow"), { recursive: true, force: true });
    }
  });
});

describe("#494 review — --rebaseline protects the path the plugin fills from OBSIDIAN's environment, not this shell's", () => {
  test("a pre-#403 data.json, an override only in the CLI's shell: --rebaseline onto the legacy path is refused, byte-identical", async () => {
    // No vaultConventions in data.json: the plugin will seed on its next load.
    const r = await mkdtemp(path.join(tmpdir(), "id494-shell-env-"));
    await mkdir(path.join(r, "N"), { recursive: true });
    await writeFile(path.join(r, "N", "A.md"), "prose; here\n");
    await mkdir(path.join(r, ".obsidian", "plugins", "vault-mcp"), { recursive: true });
    await writeFile(path.join(r, ".obsidian", "plugins", "vault-mcp", "data.json"), JSON.stringify({ readOnly: false }));
    const LEGACY = LEGACY_CONVENTIONS_SEED.baselineRel;
    try {
      const target = path.join(r, LEGACY);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, BODY);
      await mkdir(path.join(r, REL_DIR), { recursive: true });
      await writeFile(path.join(r, REL), BODY);
      configureBaseline(REL);
      process.env.GOVERNOR_BASELINE_REL = REL; // the shell's override; Obsidian has none, so the plugin fills LEGACY
      const before = await readFile(target, "utf8");
      const res = await cli(`--root=${r}`, `--baseline=${target}`, "--rebaseline");
      assert.equal(res.threw, true, "the path the plugin will fill is a live record");
      assert.match(res.message, /live acceptance record/i);
      assert.equal(await readFile(target, "utf8"), before, "byte-identical");
    } finally {
      configureBaseline(REL);
      await rm(r, { recursive: true, force: true });
    }
  });
});
