// obsidian-debt-source.ts — the Obsidian adapter for the conformance-debt
// report (the one un-headless seam behind `vaultmcp_conformance_debt`). It runs
// the REAL conformance engine over the vault's on-disk root and reads the
// baseline note + metadata sidecar from disk. Kept OUT of tools.ts so that file (imported by the headless tests) never pulls in node:fs
// or the engine. Verify this against a running Obsidian; the report core it
// feeds is fully unit-tested.

import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { App } from "obsidian";
import type { DebtSource, DebtRegisterSource } from "./tools.js";
import type { Finding } from "./kernel/finding.js";
import type { SkippedTerritory } from "./kernel/snapshot.js";
import type { RunCoverage } from "./kernel/report-caps.js";
import { parseSidecar, sidecarPathFor, type DebtSidecar } from "./kernel/debt-sidecar.js";
import { runConformance, inAppBaselineRel, inAppBaselineRefusal, inAppBaselineFromEnv, excludedRootsFrom, coverageRefusal, baselinePackIds } from "./kernel/cli.js";
import { parseBaseline } from "./kernel/ratchet.js";
import { DEFAULT_VOCABULARIES, DEFAULT_SCHEMES, type SchemeInstanceConfig } from "@vault-mcp/core";
import { EMPTY_VAULT_CONVENTIONS, type VaultConventions } from "./kernel/vault-conventions.js";

/** Read a UTF-8 file, or null when it is absent/unreadable (never throws). */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** The on-disk root of this vault (FileSystemAdapter). Desktop-only, which the
 * plugin is (`isDesktopOnly: true`). */
function vaultRoot(app: App): string {
  const adapter = app.vault.adapter as unknown as { basePath?: string; getBasePath?: () => string };
  return adapter.basePath ?? adapter.getBasePath?.() ?? "";
}

/**
 * The Obsidian `DebtSource`: a live conformance run + the baseline/sidecar on
 * disk, using the SAME config resolution the CLI rail uses (default
 * vocabularies, env-driven excluded roots, legacy packs on). The schemes are
 * the host's configured ones, read per run through `schemes` (main.ts passes
 * the host's live settings, which carry any machine-local override); a source
 * built without the thunk has none, so no scheme check runs (01.33 pick A,
 * step b). The baseline
 * location is the plugin's Conformance setting, read per call, then the env
 * override (#493); none configured or a missing note refuses. `liveFindings` runs the full engine once; `baselineText`/`sidecar` are
 * cheap reads.
 */
export function obsidianDebtSource(
  app: App,
  territories?: () => readonly string[],
  conventions?: () => VaultConventions,
  schemes?: () => SchemeInstanceConfig[],
): DebtSource {
  const root = vaultRoot(app);
  // Read per call from the live setting (#493), so a changed path applies with no reload. "" ⇒ none configured.
  const baselineRelNow = () => inAppBaselineRel(conventions?.());
  const baselinePathNow = () => {
    const rel = baselineRelNow();
    return rel ? join(root, rel) : "";
  };
  const excludedRoots = excludedRootsFrom([], process.env);
  // What the last live run stepped around (#398) — read by the tools after
  // `liveFindings()` resolves, so the report and the register can name it.
  let lastSkipped: readonly SkippedTerritory[] = [];
  // What the last live run checked (report cap 4), for the report and the register.
  let lastCoverage: RunCoverage | null = null;
  // Refuses, never answers empty: a blank or wrong path must not read as "no accepted debt" (#494 review).
  const baselineText = async () => {
    const rel = baselineRelNow();
    const text = rel ? await readOrNull(join(root, rel)) : null;
    const refusal = inAppBaselineRefusal(rel, text !== null, inAppBaselineFromEnv(conventions?.()));
    if (refusal) throw new Error(refusal);
    return text as string;
  };

  return {
    async liveFindings(): Promise<Finding[]> {
      const text = await baselineText();
      const res = await runConformance({
        root,
        // The REAL baseline, not "" (#400 review): `runConformance` refuses a
        // run whose skipped territories hold accepted keys, and that refusal
        // only exists if it can see them. The tools re-parse the same text for
        // their own diff, which is the one extra disk read this costs.
        baselineText: text,
        vocabularies: DEFAULT_VOCABULARIES,
        excludedRoots,
        legacyPacks: true,
        territories: territories?.(),
        // The host's schemes, read per run after the territories (whose refusal comes first when the host cannot answer).
        schemes: schemes?.() ?? DEFAULT_SCHEMES,
        // The operator's conventions, read per call (#403) exactly as the
        // territories are; a source built without the thunk measures nothing
        // (EMPTY), loudly, rather than one vault's former paths.
        conventions: conventions?.() ?? EMPTY_VAULT_CONVENTIONS,
      });
      // #294: a pack the baseline describes that did not run (threw, or its
      // convention path is dead — #298) would report every one of its accepted
      // keys CLEARED. The CLI refuses that in `runCli`; this adapter bypasses
      // `runCli`, so it applies the same refusal here — the exported one, not
      // a reimplementation, so the two cannot drift.
      const coverage = coverageRefusal(baselinePackIds(parseBaseline(text)), new Set(res.coveredPackIds), "run");
      if (coverage) throw new Error(coverage);
      lastSkipped = res.skippedTerritories;
      lastCoverage = res.coverage;
      return res.findings;
    },
    skippedTerritories(): readonly SkippedTerritory[] {
      return lastSkipped;
    },
    coverage(): RunCoverage | null {
      return lastCoverage;
    },
    baselineText,
    async sidecar(): Promise<DebtSidecar> {
      const p = baselinePathNow();
      return parseSidecar(p ? await readOrNull(sidecarPathFor(p)) : null);
    },
  };
}

/**
 * The Obsidian `DebtRegisterSource` (issue #211, Part B): the read seams above
 * plus the register render's write half. Writes go through the VAULT API
 * (modify/create, the provenance-regen pattern) rather than node:fs, so
 * Obsidian sees the change immediately and the write behaves like every other
 * in-band note write. The default register dir is the baseline's own folder —
 * the sidecar and trend log already live there, and the baseline itself is
 * never touched.
 */
export function obsidianDebtRenderSource(
  app: App,
  territories?: () => readonly string[],
  conventions?: () => VaultConventions,
  schemes?: () => SchemeInstanceConfig[],
): DebtRegisterSource {
  // Per call, from the live setting (#493).
  const baselineRel = () => inAppBaselineRel(conventions?.());
  const vault = app.vault as unknown as {
    getAbstractFileByPath(path: string): unknown;
    modify(file: unknown, data: string): Promise<void>;
    create(path: string, data: string): Promise<unknown>;
    createFolder(path: string): Promise<unknown>;
  };
  return {
    ...obsidianDebtSource(app, territories, conventions, schemes),
    defaultRegisterDir(): string {
      const rel = baselineRel();
      const dir = rel ? posix.dirname(rel) : ".";
      return dir === "." ? "" : dir;
    },
    baselineNotePath(): string {
      return baselineRel();
    },
    async writeNote(path: string, text: string): Promise<void> {
      const existing = vault.getAbstractFileByPath(path);
      if (existing) {
        await vault.modify(existing, text);
        return;
      }
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !vault.getAbstractFileByPath(parent)) {
        try {
          await vault.createFolder(parent);
        } catch {
          /* already exists / race — proceed to create */
        }
      }
      await vault.create(path, text);
    },
  };
}
