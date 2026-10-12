/**
 * skills-module.test.mjs — the vaultmcp-skills satellite's tool surface. Four
 * things this must prove, three of them carried over unchanged from the
 * folded-into-the-host era (#82) and one new to the extraction:
 *
 *   1. the six tools are BUILT with the names and read/write flags that make
 *      the host publish them as `vaultmcp_skills_validate` … `vaultmcp_skills_mark`
 *      — the shipped spelling, which renaming would break for agent sessions;
 *   2. the surface contributes NO accept/approve tool;
 *   3. vaultmcp_skills_mark CANNOT write an acceptance assertion — the mark path
 *      runs the shared accept-forbidden transition guard, so a mark that would
 *      introduce/change an accepted-family field is REFUSED and nothing is
 *      written, while preserving an existing (human-granted) accepted value is
 *      allowed. This was the load-bearing requirement of the fold and it is the
 *      load-bearing requirement of the extraction: `acceptTransitionReason`
 *      lives in @vault-mcp/core, a published contract, so leaving the host did
 *      not leave the guard behind;
 *   4. the one-shot settings adoption from the host's `modules.skills.config`
 *      copies, latches, never clobbers this plugin's own values, and NEVER
 *      writes the host's settings.
 *
 * The preview read-boundary tests are kept in full even though `ctx.getSettings`
 * is not supplied in production — the filter is defence in depth for a future
 * apiVersion that can carry scope to a publisher, and an untested dormant guard
 * is a guard that will not work when it wakes up. See tools.ts's long note.
 *
 * Headless: tools.ts imports nothing from `obsidian`; the vault arrives as a
 * fake SkillsBackend and the accept guard runs over plain objects.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSkillsTools, guardSkillsMark } from "../src/tools.ts";
import { adoptHostConfig, settingsOf, SKILLS_FIELDS, ADOPTABLE_KEYS } from "../src/settings.ts";
import { AcceptForbiddenError } from "@vault-mcp/core";

/** The plugin id is `vaultmcp-skills`, which the host sanitizes to `vaultmcp_skills`;
 *  each bare spec name is published as `vaultmcp_skills_<name>`. */
const PUBLISHED = (name) => `vaultmcp_skills_${name}`;
const READ_TOOLS = ["validate", "tree", "preview"];
const WRITE_TOOLS = ["export", "release", "mark"];

const inertSkillsSource = {
  notes: async () => [],
  resolveLink: () => null,
  embed: async () => null,
  basePath: () => null,
  frontmatterOf: () => null,
  exists: () => false,
  applyFrontmatter: async () => {},
};

const build = (source = inertSkillsSource, ctx = {}) =>
  buildSkillsTools(source, { config: () => ({}), ...ctx });

const toolNamed = (specs, name) => specs.find((s) => s.name === name);

// ── 1. the published surface ────────────────────────────────────────────────

describe("vaultmcp-skills satellite: the six published tools", () => {
  test("builds exactly six tools, and they publish under the shipped vaultmcp_skills_* names", () => {
    const specs = build();
    assert.equal(specs.length, 6);
    assert.deepEqual(
      specs.map((s) => PUBLISHED(s.name)).sort(),
      [
        "vaultmcp_skills_export",
        "vaultmcp_skills_mark",
        "vaultmcp_skills_preview",
        "vaultmcp_skills_release",
        "vaultmcp_skills_tree",
        "vaultmcp_skills_validate",
      ],
    );
  });

  test("every bare name is a legal external tool name (the host's /^[a-z][a-z0-9_]*$/)", () => {
    for (const spec of build()) assert.match(spec.name, /^[a-z][a-z0-9_]*$/, spec.name);
  });

  test("the three reads claim readOnly, the three writes do not — the flag that decides read-only-mode blocking", () => {
    const specs = build();
    for (const n of READ_TOOLS) assert.equal(toolNamed(specs, n).readOnly, true, `${n} must claim read-only`);
    for (const n of WRITE_TOOLS) assert.equal(toolNamed(specs, n).readOnly, false, `${n} must be mutating`);
  });

  test("every tool has a description and a handler — the host refuses a spec without them", () => {
    for (const spec of build()) {
      assert.equal(typeof spec.handler, "function", spec.name);
      assert.ok(spec.description.length > 0, spec.name);
    }
  });

  test("only `mark` carries a path-keyed argument — which is exactly why the host blocks the other five under an allowlist", () => {
    // The host blocks a mutating external tool whose args carry no recognized
    // path key while an allowlist is active. This test pins the FACT the
    // README's allowlist posture rests on, so a later argument rename cannot
    // silently change which tools survive a sandbox.
    // Snapshot of the host's PATH_KEYS + ARRAY_PATH_KEYS (a review aid, not a live
    // tripwire — the host's own guard.test.mjs is the pin that fires). `note_path`
    // joined the host's list on 2026-09-07 (mutating-tier round 1: the kernel's record
    // guard, lock consult and journal target all ride collectPaths, and a pathless
    // single-note write had escaped all three). No tool here names it, so the
    // assertions below decide exactly as they did.
    const PATH_KEYS = ["path", "from", "to", "target_path", "template_path", "subdir", "file_path", "output_folder", "note_path", "paths", "refs"];
    const hasPathKey = (spec) => Object.keys(spec.inputSchema ?? {}).some((k) => PATH_KEYS.includes(k));
    const specs = build();
    assert.equal(hasPathKey(toolNamed(specs, "mark")), true);
    for (const n of ["validate", "tree", "preview", "export", "release"]) {
      assert.equal(hasPathKey(toolNamed(specs, n)), false, `${n} unexpectedly gained a path argument`);
    }
  });

  test("the surface contributes NO accept/approve/baseline tool", () => {
    const shaped = /accept|approve|grant|baseline/i;
    for (const spec of build()) assert.equal(shaped.test(PUBLISHED(spec.name)), false, spec.name);
  });
});

// ── 2. the settings tab's fields ────────────────────────────────────────────

describe("vaultmcp-skills satellite: settings fields", () => {
  test("renders sixteen fields — the nine from the standalone settings tab, exportOnSave, the preload cap, the three #404 settings (type map, include roots, exclude roots), and the two of 01.61 rule 8a (guarded territories, fleet-wide rules)", () => {
    assert.equal(SKILLS_FIELDS.length, 16);
    assert.equal(SKILLS_FIELDS.find((f) => f.key === "guardedRoots").type, "lines");
    assert.equal(SKILLS_FIELDS.find((f) => f.key === "fleetWideRules").type, "lines");
    assert.equal(SKILLS_FIELDS.find((f) => f.key === "typeMap").type, "typemap");
    assert.equal(SKILLS_FIELDS.find((f) => f.key === "includeRoots").type, "lines");
    assert.equal(SKILLS_FIELDS.find((f) => f.key === "excludeRoots").type, "lines");
    const cap = SKILLS_FIELDS.find((f) => f.key === "preloadCap");
    assert.equal(cap.type, "number");
    const eos = SKILLS_FIELDS.find((f) => f.key === "exportOnSave");
    assert.equal(eos.type, "toggle");
  });

  test("every rendered field is an adoptable config key — the tab and the adoption cannot drift apart", () => {
    for (const field of SKILLS_FIELDS) {
      assert.ok(ADOPTABLE_KEYS.includes(field.key), `${field.key} is rendered but not adoptable`);
    }
    assert.equal(ADOPTABLE_KEYS.length, SKILLS_FIELDS.length);
  });
});

// ── 3. the accept-forbidden guard on vaultmcp_skills_mark (load-bearing) ───────

const PREFIX = { mode: "prefix", prefix: "", key: "vaultmcp-skills", typeSource: "frontmatter" };

describe("guardSkillsMark: a skills-mark can never introduce an acceptance assertion", () => {
  test("a clean mark on a clean note is allowed (returns the MarkResult, no throw)", () => {
    const result = guardSkillsMark({}, { type: "skill" }, PREFIX);
    assert.equal(result.set.type, "skill");
  });

  test("INTRODUCING an accepted-family field is REFUSED — here via a field prefix that would write `accepted-*` keys", () => {
    // A field prefix of `accepted-` makes the mark write `accepted-type` etc. —
    // an acceptance-PROVENANCE key. The shared guard must refuse it: proof the
    // mark path actually runs acceptTransitionReason, not that its fixed inputs
    // happen never to spell "accepted".
    assert.throws(
      () => guardSkillsMark({}, { type: "skill" }, { ...PREFIX, prefix: "accepted-" }),
      AcceptForbiddenError,
    );
  });

  test("INTRODUCING the live `verified` field is REFUSED the same way (#406) — via a field prefix that would write `verified-*` keys", () => {
    assert.throws(
      () => guardSkillsMark({}, { type: "skill" }, { ...PREFIX, prefix: "verified-" }),
      AcceptForbiddenError,
    );
  });

  test("PRESERVING a human's `verified` record forward is ALLOWED; a blank one is refused even as carry-forward (#406)", () => {
    const human = [{ by: "Nelson", on: "2026-09-17T06:26", said: "yes" }];
    const result = guardSkillsMark({ verified: human }, { type: "agent" }, PREFIX);
    assert.equal(result.set.type, "agent");
    assert.throws(() => guardSkillsMark({ verified: [] }, { type: "agent" }, PREFIX), AcceptForbiddenError);
  });

  test("PRESERVING an existing (human-granted) accepted value forward is ALLOWED", () => {
    // The note already carries a human-set acceptance-status: accepted; a normal
    // mark adds `type` and leaves the accepted value untouched → not a transition.
    const before = { "acceptance-status": "accepted" };
    const result = guardSkillsMark(before, { type: "agent" }, PREFIX);
    assert.equal(result.set.type, "agent");
    // The guard never mutated the caller's before-frontmatter.
    assert.deepEqual(before, { "acceptance-status": "accepted" });
  });

  test("an accepted value already present is not re-introduced by an unrelated mark (array/scalar forms)", () => {
    assert.doesNotThrow(() => guardSkillsMark({ accepted: ["yes"] }, { type: "policy" }, PREFIX));
  });
});

// ── the mark HANDLER end-to-end: refusal blocks the write ──────────────────

function markHandler(config, before) {
  const writes = [];
  const backend = {
    ...inertSkillsSource,
    exists: () => true,
    frontmatterOf: () => before,
    applyFrontmatter: async (p, mutate) => {
      const fm = { ...before };
      mutate(fm);
      writes.push({ path: p, fm });
    },
  };
  const specs = buildSkillsTools(backend, { config: () => config });
  return { handler: toolNamed(specs, "mark").handler, writes };
}

describe("vaultmcp_skills_mark handler: the guard blocks the write, not just the response", () => {
  test("a clean mark writes the frontmatter", async () => {
    // #404: a mark needs a spelling for the kind — the shipped map is empty, so the test names one.
    const { handler, writes } = markHandler({ typeMap: { skill: "skill" } }, {});
    const res = await handler({ path: "Note.md", type: "skill" });
    assert.equal(res.marked, "Note.md");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].fm.type, "skill");
  });

  test("a mark that would write an accepted-family field is refused AND nothing is written", async () => {
    // The satellite contract is THROW-on-refusal — the host renders a thrown
    // error as its error envelope, so what an agent sees is unchanged.
    const { handler, writes } = markHandler({ fieldMode: "prefix", fieldPrefix: "accepted-", typeMap: { skill: "skill" } }, {});
    await assert.rejects(() => handler({ path: "Note.md", type: "skill" }), AcceptForbiddenError);
    assert.equal(writes.length, 0, "the accept-forbidden write must not have landed");
  });

  test("a missing note fails before any write", async () => {
    const specs = buildSkillsTools({ ...inertSkillsSource, exists: () => false }, { config: () => ({}) });
    await assert.rejects(() => toolNamed(specs, "mark").handler({ path: "Nope.md", type: "skill" }), /not found/);
  });
});

// ── the read boundary (2026-08-29 review), now defence in depth ─────────────
//
// `vaultmcp_skills_preview` returned an entry's full compiled body for ANY source
// note, ignoring the path allowlist — `ctx.getSettings` sat on the context
// declared and never called. The compile itself is legitimately whole-vault
// (parent edges span the tree), so the fix filters BODIES, not the compile.
//
// After the satellite extraction NOTHING SUPPLIES `getSettings` in production —
// a satellite cannot reach the host's guard settings — and the host's own
// external-tool gate blocks this tool outright under an allowlist, which is
// strictly stricter. These tests supply the settings themselves and keep the
// filter honest for the apiVersion that can pass scope through.

describe("vaultmcp_skills_preview: bodies are filtered by the source note's visibility", () => {
  const twoSkills = {
    ...inertSkillsSource,
    notes: async () => [
      // ACCEPTED fixtures: since the acceptance gate (01.41 rule 8) an unverified note does not compile at all.
      { path: "Projects/Visible.md", frontmatter: { type: "skill", verified: [{ by: "human:nelson", at: "2026-09-25T05:08:39-04:00" }] }, body: "VISIBLE-BODY-MARKER" },
      { path: "Archive/Hidden.md", frontmatter: { type: "skill", verified: [{ by: "human:nelson", at: "2026-09-25T05:08:39-04:00" }] }, body: "HIDDEN-BODY-MARKER" },
    ],
  };

  // Since #404 the SHIPPED config compiles nothing (empty type map, empty
  // roots — the plugin assumes no vault spelling), so these visibility tests
  // name the fixture's own map and folders. What they test is unchanged.
  const PREVIEW_CONFIG = { typeMap: { skill: "skill" }, includeRoots: ["Projects", "Archive"] };
  const previewWith = (settings) =>
    toolNamed(buildSkillsTools(twoSkills, { config: () => PREVIEW_CONFIG, getSettings: () => settings }), "preview").handler;

  const SANDBOXED = { readOnly: false, allowlist: ["Projects"] };

  test("content:true never returns a hidden note's body", async () => {
    const res = await previewWith(SANDBOXED)({ content: true });
    assert.ok(!JSON.stringify(res).includes("HIDDEN-BODY-MARKER"), "a hidden source note's body leaked through preview");
  });

  test("the visible note's body still comes back — the filter is not a blanket refusal", async () => {
    const res = await previewWith(SANDBOXED)({ content: true });
    assert.ok(JSON.stringify(res).includes("VISIBLE-BODY-MARKER"), "the in-allowlist body should still be returned");
  });

  test("addressing a hidden note by path reads as NOT FOUND, not as forbidden", async () => {
    // Not-found rather than a distinct refusal, matching how uid/scheme
    // addressing decides: a "forbidden" answer would confirm the note exists.
    await assert.rejects(() => previewWith(SANDBOXED)({ name: "Archive/Hidden.md" }), /no preview entry matches/);
  });

  test("with NO allowlist nothing is filtered — the unsandboxed case is unchanged", async () => {
    const res = await previewWith({ readOnly: false, allowlist: [] })({ content: true });
    const blob = JSON.stringify(res);
    assert.ok(blob.includes("HIDDEN-BODY-MARKER") && blob.includes("VISIBLE-BODY-MARKER"));
  });

  test("with NO getSettings at all — the SHIPPED configuration — the filter degrades open, exactly as the `!settings ||` branch always did", async () => {
    const handler = toolNamed(buildSkillsTools(twoSkills, { config: () => PREVIEW_CONFIG }), "preview").handler;
    const blob = JSON.stringify(await handler({ content: true }));
    assert.ok(blob.includes("HIDDEN-BODY-MARKER") && blob.includes("VISIBLE-BODY-MARKER"));
  });
});

// ── the ASSEMBLED-body vectors (found by an independent review of the first fix)
//
// The first version of the preview filter gated `content` on the entry's own
// `from` alone. But a compiled body is assembled from up to three notes, and
// the other two both carry bytes out of hidden paths:
//
//   • TRANSCLUSION — `![[Hidden]]` inlines that note's stripped body verbatim.
//   • POLICY INJECTION — a `type: policy` note's full body is appended to every
//     agent it is parented to, and its path never appears in `sources`.
//
// A sandboxed session can trigger both by authoring an ordinary note INSIDE its
// own allowlist. These are the regression tests for that.

describe("vaultmcp_skills_preview: assembled bodies cannot smuggle hidden notes out", () => {
  const SANDBOXED = { readOnly: false, allowlist: ["Projects"] };

  const previewFor = (notes, embed) =>
    toolNamed(
      buildSkillsTools(
        {
          ...inertSkillsSource,
          // The supplied notes stand for ACCEPTED notes (the gate excludes an unverified one before any of this runs).
          notes: async () => notes.map((n) => ({ ...n, frontmatter: { verified: [{ by: "human:nelson", at: "2026-09-25T05:08:39-04:00" }], ...n.frontmatter } })),
          embed: embed ?? (async () => null),
          // The inert source resolves nothing, which would leave a policy's
          // `parent` dangling — the policy would then be DROPPED as an error and
          // the test would pass vacuously (it did, on the first attempt). Resolve
          // a linkpath to whichever supplied note has that basename.
          resolveLink: (linkpath) =>
            notes.find((n) => n.path.split("/").pop().replace(/\.md$/, "") === linkpath.replace(/\.md$/, ""))?.path ??
            null,
        },
        { config: () => ({ typeMap: { skill: "skill", policy: "policy", agent: "agent" }, includeRoots: ["Projects", "Archive"] }), getSettings: () => SANDBOXED },
      ),
      "preview",
    ).handler;

  test("a VISIBLE skill that transcludes a HIDDEN note does not return the hidden body", async () => {
    const handler = previewFor(
      [{ path: "Projects/Host.md", frontmatter: { type: "skill" }, body: "intro ![[Archive/Secret]] outro" }],
      async (linkpath) =>
        linkpath.includes("Secret") ? { path: "Archive/Secret.md", content: "SMUGGLED-VIA-TRANSCLUSION" } : null,
    );
    const res = await handler({ content: true });
    assert.ok(
      !JSON.stringify(res).includes("SMUGGLED-VIA-TRANSCLUSION"),
      "a transcluded hidden note's body leaked through the compiled content",
    );
  });

  test("a HIDDEN policy attached to a VISIBLE agent does not return the policy body", async () => {
    const handler = previewFor([
      { path: "Projects/Agent.md", frontmatter: { type: "agent" }, body: "agent body" },
      {
        path: "Archive/Policy.md",
        frontmatter: { type: "policy", parent: "[[Agent]]" },
        body: "SMUGGLED-VIA-POLICY",
      },
    ]);
    const res = await handler({ content: true });
    assert.ok(
      !JSON.stringify(res).includes("SMUGGLED-VIA-POLICY"),
      "an injected hidden policy's body leaked through the compiled content",
    );
  });
});

// ── 4. the one-shot settings adoption from the host ─────────────────────────

describe("settings adoption: the host's modules.skills.config is copied once, and never written back", () => {
  const HOST = () => ({
    modules: { skills: { enabled: true, config: { outputDir: "/tmp/mine", pluginName: "my-skills", preloadCap: 9 } } },
  });

  test("a first load with the host present adopts its config and latches", () => {
    const adopted = adoptHostConfig({ config: {}, adoptedFromHost: false }, HOST());
    assert.equal(adopted.adoptedFromHost, true);
    assert.equal(adopted.config.outputDir, "/tmp/mine");
    assert.equal(adopted.config.pluginName, "my-skills");
    assert.equal(adopted.config.preloadCap, 9);
  });

  test("adoption never mutates the host's settings object", () => {
    const host = HOST();
    const snapshot = JSON.stringify(host);
    adoptHostConfig({ config: {}, adoptedFromHost: false }, host);
    assert.equal(JSON.stringify(host), snapshot, "the host's settings must be read-only to a satellite");
  });

  test("it runs ONCE — a latched plugin ignores a later host config entirely", () => {
    assert.equal(adoptHostConfig({ config: { pluginName: "mine" }, adoptedFromHost: true }, HOST()), null);
  });

  test("this plugin's OWN values win; adoption only fills the gaps", () => {
    const adopted = adoptHostConfig({ config: { pluginName: "already-set" }, adoptedFromHost: false }, HOST());
    assert.equal(adopted.config.pluginName, "already-set");
    assert.equal(adopted.config.outputDir, "/tmp/mine");
  });

  test("a host that is ABSENT adopts nothing and does NOT latch — the one chance survives to the next load", () => {
    assert.equal(adoptHostConfig({ config: {}, adoptedFromHost: false }, undefined), null);
  });

  test("a host present with no skills config latches anyway — the question was asked and answered", () => {
    const adopted = adoptHostConfig({ config: {}, adoptedFromHost: false }, { modules: {} });
    assert.equal(adopted.adoptedFromHost, true);
    assert.deepEqual(adopted.config, {});
  });

  test("an unknown key in the host's record is NOT copied — it was never a skills config field", () => {
    const adopted = adoptHostConfig(
      { config: {}, adoptedFromHost: false },
      { modules: { skills: { config: { outputDir: "/tmp/mine", somethingElse: "no" } } } },
    );
    assert.equal(adopted.config.outputDir, "/tmp/mine");
    assert.equal("somethingElse" in adopted.config, false);
  });

  test("a corrupt data.json degrades to the defaults instead of throwing during onload", () => {
    assert.deepEqual(settingsOf(null), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf("nonsense"), { config: {}, adoptedFromHost: false });
    assert.deepEqual(settingsOf({ config: [], adoptedFromHost: "yes" }), { config: {}, adoptedFromHost: false });
  });
});

// ── the excluded record on every TOOL payload (the surface an agent reads) ────

describe("the acceptance gate's record reaches every tool payload", () => {
  const gated = {
    ...inertSkillsSource,
    notes: async () => [
      { path: "Projects/Ok.md", frontmatter: { type: "skill", verified: [{ by: "human:nelson", at: "2026-09-25T05:08:39-04:00" }] }, body: "ok" },
      { path: "Projects/No.md", frontmatter: { type: "skill" }, body: "not accepted" },
    ],
    basePath: () => null,
  };
  const CONFIG = { typeMap: { skill: "skill" }, includeRoots: ["Projects"] };
  const tool = (name) => toolNamed(buildSkillsTools(gated, { config: () => CONFIG }), name).handler;
  const EXPECT = { total: 1, byKind: { skill: 1, agent: 0, policy: 0, command: 0 }, paths: ["Projects/No.md"], transclusions: [] };

  test("validate, tree and preview carry `excluded`", async () => {
    assert.deepEqual((await tool("validate")({})).excluded, EXPECT);
    assert.deepEqual((await tool("tree")({})).excluded, EXPECT);
    assert.deepEqual((await tool("preview")({})).excluded, EXPECT);
  });

  test("export carries `excluded` in its summary", async () => {
    const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultmcp-skills-tool-"));
    try {
      const withDir = toolNamed(buildSkillsTools(gated, { config: () => ({ ...CONFIG, outputDir }) }), "export").handler;
      const r = await withDir({});
      assert.deepEqual(r.excluded, EXPECT);
    } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
  });
});
