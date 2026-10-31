/**
 * modules-mount.test.mjs — the module-host MOUNT (mcp/modules-mount.ts): the
 * built-in capability modules registering THROUGH the ModuleRegistry, and the
 * mount-step security gate's testable halves:
 *
 *   gate 1 (handler reachability): every module-contributed tool is
 *          explicitly read-only, and the mount REFUSES one that is not;
 *   gate 2 (minimal host ctx): mountHost hands modules exactly
 *          {getSettings, visible} — no kernel, no sources, no registrar;
 *   gate 3 (registry-only registration): server.ts no longer calls
 *          registerSchemeTools directly (source scan);
 *   plus settings-toggling over the real modules, and tripwire/collision
 *   plumbing staying live on the mount path.
 *
 * Headless: modules-mount.ts imports nothing from `obsidian`; the vault
 * arrives as a static note listing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fakeServer } from "./fake-server.mjs";
import { mountModules, mountHost, builtinModules } from "../src/mcp/modules-mount.ts";
import { ModuleRegistry, collect, toolDocDrift, toolDocReadOnlyDrift } from "../src/kernel/modules/index.ts";
import { JD_SCHEMES } from "./scheme-fixture.mjs";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** A tiny fake vault: the scheme module gets `notes`. */
const NOTES = ["00-09 System/06 Agent tooling/06.20 obsidian-vault-mcp-plugin.md"];

/** A no-op pending-review source for the governance module — the module registers
 * governance_pending_review over it without ever calling the handler in these tests. */
const pendingReviewSource = { read: async () => null };

// Inert `vocabSource`, `healthSource` and `basesSource` fixtures lived here
// until the S7 satellite extraction; the `provenanceSource` backend and the
// fileclass presence/binary/vault-name fixtures lived here until the mutating
// tier followed. All six of those modules are separate plugins now
// (`vaultmcp-vocab`, `vaultmcp-health`, `vaultmcp-bases`, `vaultmcp-provenance`,
// `vaultmcp-fileclass`, `vaultmcp-jd-scaffold`), each with its own suite, and
// `MountDeps` no longer declares a slot for any of them — it is down to
// `getSettings` and `schemeNotes`.

/** The settings every mount below starts from: one JD instance, since a fresh
 * install has none (01.33 pick A, step b) and these tests are about the scheme
 * module's tools. A test that wants no scheme passes `schemes: []`. */
const WITH_JD = { schemes: JD_SCHEMES };

function deps(overrides = {}) {
  return {
    getSettings: () => ({ ...WITH_JD, ...(overrides.settings ?? {}) }),
    schemeNotes: () => NOTES,
    pendingReviewSource,
    ...overrides.deps,
  };
}

function mount(overrides = {}) {
  const server = fakeServer();
  const registry = mountModules((n, d, h) => server.registerTool(n, d, h), deps(overrides));
  return { server, registry };
}

describe("mountModules: the built-in modules register through the registry", () => {
  test("one JD scheme configured: the scheme tools are all present, no problems", () => {
    const { server, registry } = mount();
    const names = [...server.tools.keys()];
    // The scheme module's five, exactly as the direct registrations used to
    // contribute them. (The vocab module's four were listed here until the S7
    // satellite extraction; scheme is the last of the pre-host pair.)
    for (const n of [
      "obsidian_schemes",
      "obsidian_resolve_address",
      "obsidian_next_address",
      "obsidian_list_scope",
      "obsidian_expected_location",
    ]) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
    assert.deepEqual(registry.problems, []);
    const described = registry.describe();
    // ONE module remains. `acceptance` (#83) left with the governance provider
    // at the host/provider split: its capability was always an Obsidian pane
    // rather than a tool, so all it ever carried here was an `enabled` flag and
    // a config block for a surface `main.ts` wired somewhere else — and both
    // halves are the provider's now, in the provider's own `data.json` and its
    // own settings tab. (Triage was a tenth module until S5, cross-session a
    // ninth until S6, vocab, health and bases went at S7, and provenance,
    // fileclass and jd-scaffold went with the mutating tier after them; all
    // nine are satellite plugins and mount nothing here.)
    assert.deepEqual(described.map((d) => d.id), ["scheme"]);
    for (const d of described) assert.ok(d.enabled && d.tools.length > 0);
    // Nothing provenance-, fileclass- or jd-scaffold-shaped can leak from the
    // mount now: those modules are gone, and these names are exactly what a
    // half-reverted extraction would put back.
    assert.ok(!names.some((n) => n.startsWith("provenance_") || n.startsWith("vaultmcp_provenance_")));
    assert.ok(!names.some((n) => n.startsWith("fileclass_") || n.startsWith("vaultmcp_fileclass_")));
    assert.ok(!names.some((n) => n.startsWith("obsidian_jd_") || n.startsWith("vaultmcp_jd_scaffold_")));
    // Nothing triage-, vocab-, health- or bases-shaped can leak from the mount
    // at all now: those modules are gone. Kept as pins because the satellites
    // publish through the EXTERNAL registry, which is a different surface with
    // a different gate — and because these names are exactly what a
    // half-reverted extraction would put back.
    assert.ok(!names.some((n) => n.startsWith("triage_") || n.startsWith("vaultmcp_triage_")));
    assert.ok(!names.some((n) => n.startsWith("obsidian_vocab") || n === "obsidian_resolve_term" || n === "obsidian_validate_terms" || n === "obsidian_list_vocabulary"));
    assert.ok(!names.includes("obsidian_health") && !names.includes("obsidian_lint"));
    assert.ok(!names.some((n) => n.startsWith("base_") || n.startsWith("vaultmcp_bases_")));
    // governance_pending_review is NEVER on the MODULE surface (#83 cycle 2): it is
    // registered always-on in server.ts, decoupled from the governance toggle, so the
    // mount never contributes it whether governance is on or off.
    assert.ok(!names.includes("governance_pending_review"));
  });

  test("a surviving modules.acceptance row is an UNKNOWN id, not a mount", () => {
    // The row is the provider's adoption source and stays in the shared
    // `data.json` for the rollback path, so the host will keep seeing it. It
    // must be reported and ignored, never claimed: an `acceptance` module the
    // host mounted would be a settings row with no pane behind it, silently
    // diverging from the toggle the human actually uses in the provider's tab.
    const { server, registry } = mount({ settings: { modules: { acceptance: { enabled: true } } } });
    const names = [...server.tools.keys()];
    assert.ok(!names.includes("governance_pending_review"), "the pending-review READ is the provider's published tool now, never a module surface");
    assert.deepEqual(registry.problems, ["settings name unknown module 'acceptance' — ignored"]);
    assert.equal(registry.describe().find((d) => d.id === "acceptance"), undefined);
  });

  test("settings-toggle: modules.scheme.enabled=false unmounts the scheme surface", () => {
    const { server, registry } = mount({ settings: { modules: { scheme: { enabled: false } } } });
    const names = [...server.tools.keys()];
    assert.ok(!names.some((n) => n.includes("address") || n === "obsidian_schemes" || n === "obsidian_list_scope"));
    assert.equal(registry.isEnabled("scheme"), false);
  });

  test("a stale row for any extracted module is an unknown id, not a mount", () => {
    // Six modules left in two waves: vocab/health/bases at S7, then
    // provenance/fileclass/jd-scaffold as the mutating tier. An existing
    // data.json still carries their rows; the mount must simply not know them
    // rather than resurrect anything.
    const { server, registry } = mount({
      settings: {
        modules: {
          vocab: { enabled: true },
          health: { enabled: true },
          bases: { enabled: true },
          provenance: { enabled: true },
          fileclass: { enabled: true },
          "jd-scaffold": { enabled: true },
        },
      },
    });
    const names = [...server.tools.keys()];
    assert.ok(!names.some((n) => n.startsWith("obsidian_vocab") || n === "obsidian_health" || n.startsWith("base_")));
    assert.ok(!names.some((n) => n.startsWith("provenance_") || n.startsWith("fileclass_") || n.startsWith("obsidian_jd_")));
    for (const id of ["vocab", "health", "bases", "provenance", "fileclass", "jd-scaffold"]) {
      assert.equal(registry.describe().find((d) => d.id === id), undefined, id);
    }
    // INVERTED (2026-09-07): these rows are now SILENT by design. They are the
    // satellites' preserved one-shot adoption sources — satellites never write
    // the host's settings, so the rows stay forever, and warning about them
    // eight times per connection was the instrument crying wolf on the
    // operator's live console the day after S8 shipped. The "why did my module
    // tab disappear" question this warning used to answer is answered by the
    // extraction story in the settings tab and docs instead. A row naming a
    // NEVER-extracted unknown id still warns — pinned in the describe below.
    assert.deepEqual(registry.problems.filter((x) => x.includes("unknown module")), []);
  });

  test("a registered scheme tool actually answers over the injected listing", async () => {
    const { server } = mount();
    const { handler } = server.tools.get("obsidian_schemes");
    const res = await handler({});
    assert.equal(res.isError, undefined);
    assert.ok(res.structuredContent.schemes.some((s) => s.id === "jd"));
  });
});

describe("mount gate 1: read-only-only registrar", () => {
  test("every mounted tool is explicitly read-only", () => {
    const { server } = mount();
    for (const [name, { def }] of server.tools) {
      assert.equal(def.annotations?.readOnlyHint, true, `${name} must be read-only`);
    }
  });

  test("a module tool without readOnlyHint:true is gate-refused: reported, unregistered, and NOT recorded", () => {
    // A drifted module contributing a mutating and an unannotated tool,
    // pushed through the same gate mountModules installs. The gate runs
    // BEFORE the registry's bookkeeping, so the refusal must not appear in
    // describe() and must not reserve the name for later modules.
    const server = fakeServer();
    const gate = (name, def) => (def?.annotations?.readOnlyHint === true ? null : "not explicitly read-only");
    const hostile = {
      id: "drift",
      posture: "capability",
      capabilities: ["x"],
      enabled: true,
      register(reg) {
        reg("obsidian_drift_write", { annotations: { readOnlyHint: false } }, () => ({}));
        reg("obsidian_drift_bare", {}, () => ({}));
      },
    };
    const honest = {
      id: "honest",
      posture: "capability",
      capabilities: ["y"],
      enabled: true,
      register(reg) {
        // Reuses a name the hostile module was refused on — must register
        // fine: a refusal reserves nothing.
        reg("obsidian_drift_write", { annotations: { readOnlyHint: true } }, () => ({ from: "honest" }));
      },
    };
    const reg2 = new ModuleRegistry([hostile, honest], {});
    reg2.registerAll((n, d, h) => server.registerTool(n, d, h), mountHost(deps()), { gate });
    assert.ok(!server.tools.has("obsidian_drift_bare"));
    assert.equal(reg2.problems.filter((p) => p.includes("'drift'") && p.includes("refused")).length, 2);
    // describe() is truthful: the refused tools are not listed as contributed.
    const drift = reg2.describe().find((d) => d.id === "drift");
    assert.deepEqual(drift.tools, []);
    // The refused name was never reserved — the honest module holds it now.
    assert.equal(server.tools.get("obsidian_drift_write").handler().from, "honest");
    assert.deepEqual(reg2.describe().find((d) => d.id === "honest").tools, ["obsidian_drift_write"]);
  });
});

describe("mount gate 2: the host ctx handed to modules is minimal", () => {
  test("mountHost exposes exactly {getSettings, visible} — nothing else", () => {
    const host = mountHost(deps());
    assert.deepEqual(Object.keys(host).sort(), ["getSettings", "visible"]);
    assert.equal(typeof host.getSettings, "function");
    assert.equal(typeof host.visible, "function");
  });

  test("host.visible applies the allowlist", () => {
    const host = mountHost(deps({ settings: { allowlist: ["Projects"] } }));
    assert.deepEqual(host.visible(["Projects/a.md", "Archive/b.md"]), ["Projects/a.md"]);
  });

  test("builtinModules declares the ONE remaining capability module, and it is not mutating", () => {
    const mods = builtinModules(deps());
    assert.deepEqual(mods.map((m) => [m.id, m.posture]), [
      ["scheme", "capability"],
      // WHAT LEFT, and when: skills (#292) at S4, triage (#221 phase 2) at S5,
      // cross-session (#232) at S6, vocab + health + bases (#243) at S7, and
      // provenance + fileclass (#188) + jd-scaffold as the mutating tier after
      // them. All nine are satellite plugins now, reaching the vault through
      // the external-tool registry — same guarded interception point, different
      // publisher. This list is the shrinking record of the suite split; a name
      // reappearing here without a package being deleted would be a
      // half-reverted extraction.
    ]);
    // NO module declares `mutating` any more: provenance, fileclass and
    // jd-scaffold were the last three and all three left. The flag and the
    // gate's branch for it are deliberately KEPT (a documented module-host
    // capability with six shipped users behind it, not unused perimeter
    // surface), which is why this assertion is an empty list rather than a
    // deleted test — an id appearing here is a real decision someone made.
    assert.deepEqual(mods.filter((m) => m.mutating).map((m) => m.id), []);
  });

  test("the dormant `mutating` escape hatch still works — the gate branch is exercised, not merely retained", () => {
    // With no built-in module declaring `mutating`, the gate's exemption branch
    // would otherwise be dead code that nothing proves. Mount a synthetic
    // module through the same registry to keep the behaviour pinned: a
    // mutating module's non-read-only tool registers, and a non-mutating
    // module's identical tool is refused into `problems` and never reaches the
    // server.
    const server = fakeServer();
    const mutatingTool = { title: "t", description: "d", annotations: { readOnlyHint: false } };
    const make = (id, mutating) => ({
      id,
      posture: "capability",
      capabilities: ["synthetic"],
      enabled: true,
      ...(mutating ? { mutating: true } : {}),
      register: (registerTool) => registerTool(`${id}_writes`, mutatingTool, async () => ({})),
    });
    const registry = new ModuleRegistry([make("declared", true), make("undeclared", false)], {});
    registry.registerAll((n, d, h) => server.registerTool(n, d, h), mountHost(deps()), {
      gate: (name, def, moduleId) =>
        def?.annotations?.readOnlyHint === true || moduleId === "declared"
          ? null
          : "not explicitly read-only",
    });
    const names = [...server.tools.keys()];
    assert.ok(names.includes("declared_writes"), "a declared-mutating module's write tool registers");
    assert.ok(!names.includes("undeclared_writes"), "an undeclared module's write tool must be refused");
    assert.ok(registry.problems.length > 0, "the refusal is reported, not swallowed");
  });
});

describe("mount gate 3: registry-only registration (source scan)", () => {
  // The scan is over ALL of src/, not a hand-kept file list (the
  // link-healing scan's lesson): a new file calling the scheme/vocab
  // registrars directly would bypass the tripwire and collision checks.
  function tsFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return tsFiles(p);
      return e.isFile() && p.endsWith(".ts") ? [p] : [];
    });
  }

  test("registerSchemeTools is CALLED only in modules-mount.ts", () => {
    const offenders = [];
    for (const f of tsFiles(SRC)) {
      const base = path.basename(f);
      // tools-vocab.ts was in this skip list until the S7 satellite extraction.
      if (base === "modules-mount.ts" || base === "tools-scheme.ts") continue;
      const src = readFileSync(f, "utf8");
      if (/register(Scheme|Vocab)Tools\s*\(/.test(src)) offenders.push(base);
    }
    assert.deepEqual(offenders, [], `direct scheme/vocab registration outside the mount: ${offenders}`);
  });

  test("the scan is live: it would catch a planted violation", () => {
    // Feed the regex a synthetic source line to prove the pattern matches the
    // call form (not just the import form the allowlisted files contain).
    assert.ok(/register(Scheme|Vocab)Tools\s*\(/.test("  registerSchemeTools(server, ctx);"));
    assert.ok(!/register(Scheme|Vocab)Tools\s*\(/.test('import { registerSchemeTools } from "./tools-scheme.js";'));
  });
});

describe("#81 config-host: both built-in modules carry a manifest, drift-free", () => {
  test("every module builtinModules() declares has a manifest with a summary", () => {
    const mods = builtinModules(deps());
    for (const m of mods) {
      assert.ok(m.manifest, `${m.id} has no manifest`);
      assert.equal(typeof m.manifest.summary, "string");
      assert.ok(m.manifest.summary.length > 0, `${m.id}'s manifest summary is empty`);
    }
  });

  test("scheme's manifest declares the four config fields the old hand-built Schemes section rendered", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    assert.deepEqual(
      scheme.manifest.config.fields.map((f) => f.key).sort(),
      ["contentDecimalFloor", "excludedRoots", "expandedAreas", "expandedCategories"],
    );
  });

  test("NO built-in module is left to pin the empty-directory / empty-fields renderer path", () => {
    // Vocab pinned this until S7 — a REAL module with a manifest and no
    // `config` block, so the renderer's "section with zero fields" path had a
    // live subject rather than a synthetic fixture. Acceptance inherited the
    // role with the mirror case (config fields, EMPTY tool directory) and has
    // now left too, with the host/provider split.
    //
    // NAMED AS A GAP RATHER THAN QUIETLY DROPPED: `scheme` is the only built-in
    // left and it has both fields and tools, so neither degenerate path has a
    // live subject any more. The paths themselves are still covered — by the
    // synthetic modules in config-host.test.mjs — but a synthetic fixture
    // cannot catch a renderer that stops handling a shape no real module
    // happens to have. The next built-in that ships with an empty half should
    // take this pin back.
    const mods = builtinModules(deps());
    assert.deepEqual(mods.map((m) => m.id), ["scheme"]);
    assert.equal(mods.find((m) => m.id === "acceptance"), undefined, "acceptance is the governance provider's now");
    const scheme = mods[0];
    assert.ok(scheme.manifest.config.fields.length > 0);
    assert.ok(scheme.manifest.directory.tools.length > 0);
  });

  test("drift check: every ToolDoc names a tool the module ACTUALLY contributed on registerAll, and vice versa", () => {
    // Enable every default-off module so all modules contribute — the drift check
    // needs a contributed tool list to compare each manifest against.
    const { registry } = mount({ settings: { modules: { provenance: { enabled: true }, fileclass: { enabled: true }, acceptance: { enabled: true }, "jd-scaffold": { enabled: true } } } });
    const described = registry.describe();
    for (const d of described) {
      const mod = builtinModules(deps()).find((m) => m.id === d.id);
      const problems = toolDocDrift(mod.manifest.directory.tools ?? [], d.tools);
      assert.deepEqual(problems, [], `${d.id}: ${problems.join("; ")}`);
    }
  });

  test("readOnly drift: every ToolDoc's readOnly matches the tool's real registered annotation", () => {
    const { server } = mount({ settings: { modules: { provenance: { enabled: true }, fileclass: { enabled: true }, acceptance: { enabled: true }, "jd-scaffold": { enabled: true } } } });
    const mods = builtinModules(deps());
    const annotationsByName = Object.fromEntries([...server.tools].map(([name, { def }]) => [name, def.annotations]));
    for (const mod of mods) {
      const problems = toolDocReadOnlyDrift(mod.manifest.directory.tools ?? [], annotationsByName);
      assert.deepEqual(problems, [], `${mod.id}: ${problems.join("; ")}`);
    }
  });

  test("scheme's ConfigBinding round-trips against the REAL settings shape (settings.schemes[0])", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    const settings0 = { schemes: [{ id: "jd", provider: "johnny-decimal", config: { expandedAreas: ["90-99"] } }] };
    const settings1 = scheme.configBinding.write(settings0, { contentDecimalFloor: 15, excludedRoots: ["Archive"] });
    assert.deepEqual(scheme.configBinding.read(settings1), {
      expandedAreas: ["90-99"],
      contentDecimalFloor: 15,
      excludedRoots: ["Archive"],
    });
    // Non-mutating: the original settings object is untouched.
    assert.deepEqual(settings0.schemes[0].config, { expandedAreas: ["90-99"] });
    assert.equal(settings0.schemes[0].excludedRoots, undefined);
  });

  test("scheme's ConfigBinding self-heals an explicitly empty schemes: [] instead of silently no-opping the write", () => {
    // The generic renderer always shows the scheme fields (unlike the old
    // hand-built section, which hid itself when no JD instance existed) —
    // an empty schemes array must not turn a field edit into a silent no-op.
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    const settings0 = { schemes: [] };
    const settings1 = scheme.configBinding.write(settings0, { contentDecimalFloor: 5 });
    assert.equal(settings1.schemes.length, 1);
    assert.equal(settings1.schemes[0].provider, "johnny-decimal");
    assert.deepEqual(scheme.configBinding.read(settings1), { contentDecimalFloor: 5 });
    // The original (empty) array is untouched.
    assert.deepEqual(settings0.schemes, []);
  });

  test("scheme's ConfigBinding refuses to write JD-shaped keys into a schemes[0] of a foreign provider", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    const settings0 = { schemes: [{ id: "other", provider: "some-other-provider", config: { anything: true } }] };
    assert.deepEqual(scheme.configBinding.read(settings0), {});
    const settings1 = scheme.configBinding.write(settings0, { contentDecimalFloor: 5 });
    // No-op: the foreign instance's config is untouched, not corrupted with
    // a JD-shaped key it doesn't understand.
    assert.deepEqual(settings1, settings0);
  });

  test("scheme's manifest validate rejects an invalid expandedAreas token loudly (subsumes validateJdConfig)", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    const problems = scheme.manifest.config.validate({ expandedAreas: ["not-an-area"] });
    assert.ok(problems.some((p) => p.includes("expandedAreas")));
  });

  test("scheme's manifest validate rejects an invalid excludedRoots entry loudly (the instance-level sibling field)", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    const problems = scheme.manifest.config.validate({ excludedRoots: ["/absolute/not/allowed"] });
    assert.ok(problems.some((p) => p.includes("excludedRoots") && p.includes("relative")));
  });

  test("scheme's manifest validate accepts a fully valid config with no problems", () => {
    const scheme = builtinModules(deps()).find((m) => m.id === "scheme");
    assert.deepEqual(
      scheme.manifest.config.validate({ expandedAreas: ["90-99"], expandedCategories: ["27"], contentDecimalFloor: 10, excludedRoots: ["Archive"] }),
      [],
    );
  });

  test("collect() over the real mounted modules renders a section for each, scheme with fields", () => {
    const settings = { schemes: [{ id: "jd", provider: "johnny-decimal", config: { contentDecimalFloor: 20 } }], modules: {} };
    const mods = builtinModules(deps({ settings }));
    const hosted = collect(mods, settings.modules, settings);
    assert.deepEqual(hosted.map((h) => h.id), ["scheme"]);
    const scheme = hosted.find((h) => h.id === "scheme");
    assert.equal(scheme.fields.find((f) => f.key === "contentDecimalFloor").value, 20);
    // The acceptance section used to render here too — two badge-display
    // toggles plus `acceptedBy`, `gateMode` and `requiredFrontmatterKeys`, over
    // an EMPTY capability directory because its capability was an Obsidian pane
    // rather than an MCP tool. All five fields went to the governance provider
    // at the host/provider split and are rendered by its own settings tab, over
    // its own `data.json` block; that package's suite pins them. This renderer
    // is fully generic again — no module-specific branch survives it.
    // NINE modules rendered their own config tabs here and no longer do:
    // triage's eight fields left at S5, crosssession's three at S6, then at S7
    // health's one (`emptyChars`), bases' two (`queryTimeoutMs` / `rowCap`) and
    // vocab's bespoke LIST-shaped instance form — the one module-specific
    // branch this renderer ever had — and finally, with the mutating tier,
    // provenance's three (`notesDir` / `notesSource` / `auditNote`) and
    // fileclass's one (`binaryPath`). jd-scaffold is in the list too and never
    // had any: it declared no config block at all, so its satellite has nothing
    // to adopt. Each set was ported verbatim into its own package's
    // `src/settings.ts` and is pinned by that package's suite; the host hosts
    // nothing for any of them.
    for (const gone of ["triage", "crosssession", "vocab", "health", "bases", "provenance", "fileclass", "jd-scaffold"]) {
      assert.equal(hosted.find((h) => h.id === gone), undefined, `${gone} should not be hosted`);
    }
  });
});

describe("extracted-module settings rows are adoption sources, not typos (2026-09-07)", () => {
  // The day after S8 shipped, the operator's console carried eight
  // "settings name unknown module — ignored" errors per connection: one per
  // extracted module whose modules.<id> row the satellites deliberately
  // preserve as their one-shot adoption source. The warning exists for
  // typos; these rows are designed-in state.
  test("a preserved satellite row raises NO problem", () => {
    const { registry } = mount({ settings: { modules: { skills: { enabled: true }, vocab: { enabled: true, config: {} } } } });
    const rowProblems = registry.problems.filter((p) => p.includes("unknown module"));
    assert.deepEqual(rowProblems, [], "extracted-module rows must be silent");
  });

  test("a genuine typo still warns — the instrument survives", () => {
    const { registry } = mount({ settings: { modules: { sklls: { enabled: true } } } });
    assert.ok(
      registry.problems.some((p) => p.includes("unknown module 'sklls'")),
      "the typo warning must not have been silenced along with the adoption rows"
    );
  });
});

// 01.28 rule 7, Nelson's pick A (2026-10-09): the scheme toggle gates the three
// hand-registered scheme WRITE tools too.
describe("scheme toggle gates the scheme write tools", () => {
  test("schemeModuleEnabled reads modules.scheme.enabled, default on, when a scheme is configured", async () => {
    const { schemeModuleEnabled } = await import("../src/mcp/modules-mount.ts");
    assert.equal(schemeModuleEnabled({ ...WITH_JD }), true);
    assert.equal(schemeModuleEnabled({ ...WITH_JD, modules: {} }), true);
    assert.equal(schemeModuleEnabled({ ...WITH_JD, modules: { scheme: { enabled: true } } }), true);
    assert.equal(schemeModuleEnabled({ ...WITH_JD, modules: { scheme: { enabled: false } } }), false);
    assert.equal(schemeModuleEnabled({ ...WITH_JD, modules: { other: { enabled: false } } }), true);
  });

  test("schemeModuleEnabled is false with no scheme configured, whatever the toggle says (01.33 pick A, step b)", async () => {
    const { schemeModuleEnabled } = await import("../src/mcp/modules-mount.ts");
    assert.equal(schemeModuleEnabled({}), false, "a fresh install's settings have no schemes key");
    assert.equal(schemeModuleEnabled({ schemes: [] }), false);
    assert.equal(schemeModuleEnabled({ schemes: [], modules: { scheme: { enabled: true } } }), false);
  });

  test("server.ts registers the write tools only when the scheme module is on", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    const at = src.indexOf("registerSchemeWriteTools(server");
    assert.ok(at > 0, "the registration call was not found — update this pin");
    const gate = src.lastIndexOf("if (schemeModuleEnabled(ctx.getSettings())) {", at);
    assert.ok(gate > 0, "registerSchemeWriteTools must sit inside the scheme toggle check");
    assert.doesNotMatch(src.slice(gate, at), /\n\s*\}/, "no block closes between the check and the registration");
    assert.equal(src.split("registerSchemeWriteTools(").length - 1, 1, "exactly one registration of the write tools");
  });

  test("the mount's scheme default and the gate agree", async () => {
    const { builtinModules, schemeModuleEnabled } = await import("../src/mcp/modules-mount.ts");
    const scheme = builtinModules({ getSettings: () => ({ allowlist: [], readOnly: false }), schemeNotes: () => [] }).find((m) => m.id === "scheme");
    assert.equal(scheme.enabled, schemeModuleEnabled({ ...WITH_JD }));
  });
});

describe("no scheme configured: the scheme module contributes no tool (01.33 pick A, step b)", () => {
  for (const [label, settings] of [["schemes: []", { schemes: [] }], ["no schemes key", { schemes: undefined }]]) {
    test(`${label}: no scheme tool is registered, and the mount reports no problem`, () => {
      const { server, registry } = mount({ settings });
      const names = [...server.tools.keys()];
      for (const n of ["obsidian_schemes", "obsidian_validate_name", "obsidian_resolve_address", "obsidian_next_address", "obsidian_list_scope", "obsidian_expected_location"]) {
        assert.ok(!names.includes(n), `${n} must not be registered with no scheme`);
      }
      assert.deepEqual(names, [], "the scheme module is the only built-in module, so nothing at all is mounted");
      assert.deepEqual(registry.problems, []);
    });
  }

  test("the settings binding reads blank with no scheme, and the first field written turns plain JD on", () => {
    const scheme = builtinModules(deps({ settings: { schemes: [] } })).find((m) => m.id === "scheme");
    assert.deepEqual(scheme.configBinding.read({ schemes: [] }), {});
    const next = scheme.configBinding.write({ schemes: [] }, { expandedAreas: ["50-59"] });
    assert.deepEqual(next.schemes, [{ id: "jd", provider: "johnny-decimal", config: { expandedAreas: ["50-59"] } }]);
  });
});
