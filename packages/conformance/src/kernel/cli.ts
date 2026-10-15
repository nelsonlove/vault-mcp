// cli.ts — the headless conformance rail entry.
//
// `runConformance` is the testable core: build a snapshot, construct the rule
// packs from settings (the module providers/instances), run the engine, and
// ratchet the findings against the accepted-debt baseline. It does NO process
// I/O — root, baseline text, and settings come in; a result + report + a
// ready-to-write rebaseline body come out. `main` is the thin wrapper that
// reads argv/env, loads the baseline note, prints, and sets the exit code.
//
// The two module packs (vocab + scheme) always run. All four ported legacy
// checks (structure/port/ste/drift) register by DEFAULT — `--no-legacy-packs`
// opts out (the rationale is on `RunOpts.legacyPacks` below, issue #116).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
// The vocabulary kernel lives in @vault-mcp/core since the read-tier satellite
// extraction (suite split, S7) — this rail is one of its two consumers, the
// `vaultmcp-vocab` satellite's four tools being the other.
import { VocabRegistry, DEFAULT_VOCABULARIES, type VocabInstanceSettings } from "@vault-mcp/core";
import { makeRegistry, DEFAULT_SCHEMES, type SchemeInstanceConfig } from "@vault-mcp/core";
import { buildSnapshot, DEFAULT_SKIP, type SkippedTerritory } from "./snapshot.js";
import { envAliased } from "@vault-mcp/core";
import { intendedRealPath, sameFile, isInside } from "./path-identity.js";
import { runEngine, ENGINE_ID } from "./engine.js";
import { vocabPack, schemePack, structurePack, portPack, stePack, driftPack, shapePack } from "./packs/index.js";
import { conventionsOnLoad, conventionsFromHostData } from "./conventions-policy.js";
import { conventionsFromEnv, deadConventionPaths, CONVENTION_PACKS, CONVENTIONS_ENV, type DeadConvention, type VaultConventions } from "./vault-conventions.js";
import { parseBaseline, renderBaseline, ratchet, type RatchetResult } from "./ratchet.js";
import { parseKey, findingKey, type Finding } from "./finding.js";
import type { RulePack } from "./rule-pack.js";
import { budgetStatus, DEFAULT_STALE_AFTER_DAYS, type DebtBudgetStatus } from "./debt.js";
import { buildRegisterFromRun, registerAcceptRefusal, REGISTER_BASENAME } from "./debt-register.js";
import { parseSidecar, parseSidecarStrict, reconcileSidecar, serializeSidecar, sidecarPathFor, type DebtSidecar } from "./debt-sidecar.js";
import { appendTrend, trendPathFor, type DebtTrendRecord } from "./debt-trend.js";

export interface RunOpts {
  root: string;
  baselineText: string;
  vocabularies: VocabInstanceSettings[];
  schemes: SchemeInstanceConfig[];
  excludedRoots?: string[];
  /** The operator's guarded territories (#397). There is NO built-in default
   * (ruled 2026-09-22): omitted or empty means the walk refuses nothing on
   * territory grounds — honestly, rather than falling back to one vault's folder
   * names. Threaded to `buildSnapshot` rather than read from a constant: the
   * rail must refuse to walk a territory an operator added, and #397 was filed
   * because it did not. The process entry fills this from `territoriesFrom`. */
  territories?: readonly string[];
  /** The vault conventions the legacy packs read (#403). REQUIRED, with no
   * default: the process entry fills this from `VAULT_MCP_CONVENTIONS`, the
   * in-app sources from the satellite's setting, read per call; a test says what it
   * means. `runConformance` never reads `process.env` itself, so the suite is
   * hermetic by construction. An EMPTY scalar key is a dead convention. */
  conventions: VaultConventions;
  /**
   * Register the four ported legacy checks (structure/port/ste/drift — the
   * whole Python rail, now in TS). **Default ON** (issue #116).
   *
   * It defaulted OFF while the ports were landing, on the reasoning that an
   * unproven pack should not gate a run. Measured against the restored
   * baseline, that default was backwards: the accepted-debt baseline's keys are
   * *exclusively* legacy-pack keys, so a run without these packs cannot
   * reproduce a single one of them and reports the ENTIRE baseline as CLEARED —
   * 124 of 124, on every invocation. That is not a conservative default; it is
   * a guaranteed false "all previously-accepted debt is now fixed" report, and
   * it is the shape most likely to be mistaken for a real result.
   *
   * A pack set and the baseline it is ratcheted against have to describe the
   * same universe. `--no-legacy-packs` still opts out for a module-packs-only
   * run, but the caller then has to mean it.
   */
  legacyPacks?: boolean;
  /**
   * Debt-budget tooth (issue #211): the max CARRIED count before the report
   * surfaces a WARNING. Absent/null ⇒ off. Warn-only by default — the run's
   * exit code is unchanged unless `strictBudget` is set.
   */
  debtBudget?: number | null;
  /** When set, an over-budget run FAILS (exit 1) as well as warning. Off by
   * default: the budget must not refuse a run unless explicitly asked to. */
  strictBudget?: boolean;
}

export interface RunResult {
  findings: Finding[];
  /** Guarded territories the walk met INSIDE the root and did not descend into
   * (#398): reported, never silently absent. Each is a vault-relative dir path
   * and the configured entry that covered it. */
  skippedTerritories: SkippedTerritory[];
  ratchet: RatchetResult;
  /** Human report for stdout. */
  report: string;
  /** The fenced-block body to write on --rebaseline. */
  rebaseline: string;
  exitCode: 0 | 1;
  /** Ids of every pack registered for this run. */
  packIds: string[];
  /** Convention paths the walk did not see (#298) — each is also a
   * `conformance_engine / dead_convention` finding, and its pack is left out of
   * `coveredPackIds`, so a baseline describing that pack refuses. */
  deadConventions: DeadConvention[];
  /** Registered packs that did NOT throw — the set the baseline was actually measured against. */
  coveredPackIds: string[];
  /** Debt-budget tooth status (issue #211): the carried count vs the configured
   * budget, and whether it is over (and whether that is a hard failure). */
  budget: DebtBudgetStatus;
}

export async function runConformance(opts: RunOpts): Promise<RunResult> {
  // boundary: opts.root — cli.ts already resolves `root` explicitly (--root=,
  // GOVERNOR_CONTENT_ROOT, or the .obsidian-ancestor walk), so it IS this run's
  // declared boundary; buildSnapshot's own guard (#157) still refuses a ROOT
  // that resolves into a listed territory and a symlink that escapes into one.
  // A listed territory met INSIDE the root is SKIPPED and reported (#398, ruled
  // 2026-09-22: skip, not refuse — the old refusal made the rail useless on
  // exactly the vaults that guard something). There is no built-in list since
  // #397 — none listed, none skipped.
  const snapshot = await buildSnapshot({ root: opts.root, excludedRoots: opts.excludedRoots, boundary: opts.root, territories: opts.territories });
  // A skip must not become a silent CLEARED: an accepted-baseline key under a
  // skipped territory cannot be reproduced, so the run refuses — the same
  // rule `excludedRootRefusal` applies to an --exclude (#112), for the same
  // reason. Territories differ from exclusions only in that the operator does
  // not choose them per run, so the message says what to do instead.
  const baselineKeys = parseBaseline(opts.baselineText);

  const packs: RulePack[] = [];
  let deadConventions: DeadConvention[] = [];
  const unmeasuredPackIds = new Set<string>();
  // vocab providers: built from settings over the snapshot listing (the registry
  // confines each instance to its own root).
  const vocabInstances = new VocabRegistry(opts.vocabularies).build(snapshot.notes);
  packs.push(vocabPack(vocabInstances.map((i) => i.provider)));
  // scheme instances: from settings, independent of the listing.
  packs.push(schemePack(makeRegistry(opts.schemes).instances()));
  // ported legacy checks: native packs over the snapshot's raw sources,
  // blueprint listing, and config/existence inputs (conformance_check /
  // port_lint / ste_lint / drift_audit — the full legacy rail, all in TS).
  // Opt-in until the scope ruling + staged rebaseline.
  if (opts.legacyPacks ?? true) {
    // Conventions come in as an option (#403), never from ambient env here:
    // the CLI entry reads `VAULT_MCP_CONVENTIONS`, the in-app sources read the
    // satellite's setting live, and a test says what it means.
    const conv = opts.conventions;
    // A dead convention path is loud (#298): the pack that reads it still
    // REGISTERS (so a baseline describing it is refused as uncovered, the
    // same way a pack that threw is) but does not RUN, because a pack run
    // over a path that names nothing reports clean or reports noise, never
    // the truth. `dead_convention` findings are appended below.
    deadConventions = deadConventionPaths(conv, snapshot, {
      excludedRoots: opts.excludedRoots ?? [],
      skippedTerritories: snapshot.skippedTerritories ?? [],
      skipDirs: DEFAULT_SKIP,
    });
    const unmeasured = new Set(deadConventions.flatMap((d) => CONVENTION_PACKS[d.key]));
    const legacy: RulePack[] = [structurePack({ conventions: conv }), portPack(), stePack(conv), driftPack(conv), shapePack(conv)];
    for (const pack of legacy) {
      packs.push(unmeasured.has(pack.id) ? { id: pack.id, run: () => [] } : pack);
      if (unmeasured.has(pack.id)) unmeasuredPackIds.add(pack.id);
    }
  }

  const findings = runEngine(packs, snapshot);
  for (const d of deadConventions) {
    findings.push({
      script: ENGINE_ID,
      check: "dead_convention",
      target: d.key,
      kind: d.path,
      detail:
        (d.path
          ? `convention '${d.key}' names '${d.path}', which this walk did not see under its root — `
          : `convention '${d.key}' is EMPTY (the plugin ships no vault layout) — `) +
        `${CONVENTION_PACKS[d.key].map((id) => `'${id}'`).join(" and ")} not run (they would read clean or noise, not the vault). ` +
        `Set it in the plugin settings (Conformance), or ${CONVENTIONS_ENV} for the CLI, or run with legacy packs off.`,
    });
  }
  const result = ratchet(findings, baselineKeys);
  // #398's one rule for a skip: it must never become a silent CLEARED. Two ways
  // it could, both refused here, after the ratchet so the second is visible:
  // a baseline key whose TARGET is a path under a skipped folder (unreproducible
  // by construction), and a baseline key with no path target at all — drift's
  // uid-keyed E check — that this run reports cleared while something was
  // skipped, because nothing can tell whether the skip is what cleared it
  // (#400 review). --exclude gets the first check up front in runCli; the
  // second cannot be known before the engine runs.
  const skippedPaths = (snapshot.skippedTerritories ?? []).map((t) => t.path);
  const strand = guardedTerritoryRefusal(baselineKeys, skippedPaths, result.clearedKeys);
  if (strand) throw new Error(strand);
  const packIds = packs.map((p) => p.id);
  // A pack that THREW is re-attributed by the engine to `conformance_engine /
  // pack_error`, so it contributes none of its own keys — registering it is not
  // the same as measuring it. Counting a crashed pack as "covered" would let a
  // rebaseline drop every accepted key it owns (PR #139 review, Important).
  const errored = new Set(
    findings.filter((f) => f.script === ENGINE_ID && f.check === "pack_error").map((f) => f.target),
  );
  const coveredPackIds = packIds.filter((id) => !errored.has(id) && !unmeasuredPackIds.has(id));
  // Debt-budget tooth (#211): warn when carried debt exceeds the configured
  // ceiling. Warn-only unless `strictBudget` — then an over-budget run also
  // fails, alongside the ordinary NEW-findings gate. A NEW-findings failure
  // still fails regardless of the budget.
  const budget = budgetStatus(result.carried, opts.debtBudget ?? null, opts.strictBudget ?? false);
  const exitCode: 0 | 1 = result.failed || (budget.over && budget.strict) ? 1 : 0;
  return {
    packIds,
    coveredPackIds,
    findings,
    deadConventions,
    skippedTerritories: snapshot.skippedTerritories ?? [],
    ratchet: result,
    budget,
    report: renderReport(result, packIds, baselinePackIds(baselineKeys), findings, opts.excludedRoots ?? [], budget, snapshot.skippedTerritories ?? [], deadConventions),
    // An ENGINE finding — `dead_convention`, `pack_error` — is never accepted
    // debt: it describes the RUN, not the vault, and `conformance_engine` is
    // not a pack id, so a baseline naming it would make every later run refuse
    // as uncovered (#401 review). The rebaseline text carries pack findings only.
    rebaseline: renderBaseline(findings.filter((f) => f.script !== ENGINE_ID)),
    exitCode,
  };
}

/**
 * Roots the rail does not govern — **configured, never hardcoded.**
 *
 * The rail governs live content, not frozen archives (@assent's ruling, #112).
 * But WHICH roots are archives is a property of a particular vault, and this is
 * a general-purpose plugin: baking one vault's folder names into shipped source
 * makes the rail silently wrong for every other vault, and makes a policy knob
 * require a release to change. The first version of this shipped
 * `["Vault archaeology"]` as a source constant — that was the mistake, and it
 * is the same class as `BASELINE_REL` below, which is tracked separately.
 *
 * So the default is EMPTY (govern everything, the safe default for an unknown
 * vault), and exclusions arrive from the invocation:
 *   --exclude=<root>            repeatable
 *   GOVERNOR_EXCLUDED_ROOTS       comma-separated
 * A vault that wants an archive excluded says so where its own configuration
 * lives, which is also what makes the exclusion auditable per-run rather than
 * invisible in a binary.
 */
export const DEFAULT_EXCLUDED_ROOTS: string[] = [];

/** Excluded roots for this invocation: `--exclude=` flags, else the env var, else none. */
export function excludedRootsFrom(argv: string[], env: Record<string, string | undefined>): string[] {
  const flags = argv
    .filter((a) => a.startsWith("--exclude="))
    .map((a) => a.slice("--exclude=".length).trim())
    .filter(Boolean);
  if (flags.length) return flags;
  return (envAliased(env, "EXCLUDED_ROOTS") ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * Guarded territories for this invocation (#397): `--territory=<prefix>` flags,
 * else `GOVERNOR_TERRITORIES` (comma-separated), else NONE. The same shape as
 * `excludedRootsFrom`, for the same reason: the list is the operator's, so it
 * arrives from the invocation and is never a source constant. Inside Obsidian
 * the in-app sources pass the host's `guardedTerritories` setting instead; this is the
 * standalone CLI's only way to receive one, and with neither the walk refuses
 * nothing on territory grounds — which is the ruling, not a gap.
 */
export function territoriesFrom(argv: string[], env: Record<string, string | undefined>): string[] {
  const flags = argv
    .filter((a) => a.startsWith("--territory="))
    .map((a) => a.slice("--territory=".length).trim())
    .filter(Boolean);
  if (flags.length) return flags;
  return (envAliased(env, "TERRITORIES") ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * The identity stamped as `acceptedBy` on keys newly entering the baseline at
 * `--rebaseline` (issue #211). `--accepted-by=<name>`, else
 * `GOVERNOR_ACCEPTED_BY`, else the literal "human". Never an agent identity — the
 * sidecar write only happens at the human-run rebaseline, and this only names
 * WHICH human. Blank/whitespace falls through to the default.
 */
export const DEFAULT_ACCEPTED_BY = "human";
export function acceptedByFrom(argv: string[], env: Record<string, string | undefined>): string {
  const flag = argv.find((a) => a.startsWith("--accepted-by="))?.slice("--accepted-by=".length).trim();
  if (flag) return flag;
  const e = (envAliased(env, "ACCEPTED_BY") ?? "").trim();
  return e || DEFAULT_ACCEPTED_BY;
}

/**
 * The debt budget for this invocation (issue #211): `--debt-budget=<n>`, else
 * `GOVERNOR_DEBT_BUDGET`, else null (off). A non-numeric or negative value is
 * ignored (off) rather than throwing — the budget is a soft guardrail.
 */
export function debtBudgetFrom(argv: string[], env: Record<string, string | undefined>): number | null {
  const raw =
    argv.find((a) => a.startsWith("--debt-budget="))?.slice("--debt-budget=".length).trim() ??
    (envAliased(env, "DEBT_BUDGET") ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** ISO date (YYYY-MM-DD) for a clock, in UTC so `acceptedOn` agrees with the
 * `ageDays` computation (debt.ts), which also works in UTC. */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The staleness threshold (days) for a register render (issue #211, Part B):
 * `--stale-after=<n>`, else `GOVERNOR_STALE_AFTER_DAYS`, else the shared default
 * (90). `0` disables the check; a non-numeric or negative value falls back to
 * the default — a soft display knob, never a refusal.
 */
export function staleAfterFrom(argv: string[], env: Record<string, string | undefined>): number {
  const raw =
    argv.find((a) => a.startsWith("--stale-after="))?.slice("--stale-after=".length).trim() ??
    (envAliased(env, "STALE_AFTER_DAYS") ?? "").trim();
  if (!raw) return DEFAULT_STALE_AFTER_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_STALE_AFTER_DAYS;
}

/**
 * An explicit register directory for this invocation (issue #211, Part B):
 * `--register-dir=<path>`, else `GOVERNOR_REGISTER_DIR`, else null — the caller
 * then defaults to the baseline's own folder, where the sidecar and trend log
 * already live. Relative values are root-relative (resolved by the caller).
 */
export function registerDirFrom(argv: string[], env: Record<string, string | undefined>): string | null {
  const flag = argv.find((a) => a.startsWith("--register-dir="))?.slice("--register-dir=".length).trim();
  if (flag) return flag;
  const e = (envAliased(env, "REGISTER_DIR") ?? "").trim();
  return e || null;
}

/** Baseline keys whose target sits under any of `roots` (segment-bounded) — the
 *  keys a run that does not walk those roots could never reproduce. Shared by
 *  the --exclude refusal (#112) and the skipped-territory refusal (#398). */
export function strandedKeysUnder(baselineKeys: Set<string>, roots: readonly string[]): string[] {
  if (!roots.length) return [];
  const stranded: string[] = [];
  for (const key of baselineKeys) {
    // Split on UNescaped separators and unescape the target — a note path can
    // legitimately hold a `|` (finding.ts escapes it), which a raw `.split("|")`
    // would mis-field. `parseKey` is the exact inverse of `findingKey`.
    const target = parseKey(key).target;
    for (const root of roots) {
      const r = root.replace(/\/$/, "");
      if (target === r || target.startsWith(r + "/")) {
        stranded.push(key);
        break;
      }
    }
  }
  return stranded;
}

function shownKeys(stranded: string[]): string {
  const shown = stranded.slice(0, 5).map((k) => `  ${k}`).join("\n");
  const more = stranded.length > 5 ? `\n  (+${stranded.length - 5} more)` : "";
  return `${shown}${more}`;
}

/**
 * #398: a guarded territory met inside the walked root is skipped, and a skip
 * over accepted debt would report it CLEARED — so a run whose skipped
 * territories hold baseline keys refuses, exactly as an --exclude would. The
 * way out is a human act, either direction: drop those keys from the baseline
 * deliberately, or narrow the territory list so the rail may look there again.
 */
export function guardedTerritoryRefusal(
  baselineKeys: Set<string>,
  skippedPaths: readonly string[],
  clearedKeys: readonly string[] = [],
): string | null {
  if (!skippedPaths.length) return null;
  const stranded = strandedKeysUnder(baselineKeys, skippedPaths);
  // A cleared key with no path target cannot be placed inside or outside the
  // skipped folder, so once anything was skipped its clearing is unverifiable.
  const unplaceable = clearedKeys.filter((k) => {
    const { script, check } = parseKey(k);
    return NON_PATH_KEYED_CHECKS.has(`${script}|${check}`);
  });
  if (!stranded.length && !unplaceable.length) return null;
  const parts: string[] = [];
  if (stranded.length) {
    parts.push(
      `holds ${stranded.length} key(s) inside a guarded territory this run skipped — those keys cannot be ` +
        `reproduced, so they would report CLEARED and silently discard debt a human granted:\n${shownKeys(stranded)}`,
    );
  }
  if (unplaceable.length) {
    parts.push(
      `has ${unplaceable.length} key(s) this run would clear that are keyed by uid, not by path (drift E) — with a ` +
        `territory skipped, nothing can tell whether the skip is what cleared them:\n${shownKeys(unplaceable)}`,
    );
  }
  return (
    `refusing to run: a guarded territory was skipped (${skippedPaths.join(", ")}) and the accepted-debt baseline ` +
    parts.join("\nand ") +
    `\nEither remove the keys from the baseline deliberately (a human act), or take the folder off the ` +
    `guarded-territories list.`
  );
}

/** The checks whose baseline KEY carries no path — drift's E (`target: uid`);
 *  F (`target: "uid-coverage"`) was the other until #412 retired it. See
 *  packs/drift.ts's frozen-contract notes. Pinned by `conformance-cli.test.mjs`
 *  against the pack's own emitted keys. */
export const NON_PATH_KEYED_CHECKS: ReadonlySet<string> = new Set(["drift_audit|E"]);

/** The checks #412 retired (drift's A, B, D, F, G). A baseline key of one of
 *  these clears because nothing produces it any more, not because the vault
 *  was fixed — and the coverage refusal cannot see that, since it works at
 *  pack granularity and `drift_audit` still runs. So the report NAMES them
 *  beside the CLEARED count instead of letting them read as repairs; pruning
 *  them is a human act (`--rebaseline --baseline=<copy>` over a reviewed
 *  copy, then applied by hand: the live acceptance record refuses
 *  `--rebaseline` by design), which is why this is a line and not a refusal
 *  (a refusal would brick the rail until that hand edit landed). */
export const RETIRED_CHECKS: ReadonlySet<string> = new Set(["drift_audit|A", "drift_audit|B", "drift_audit|D", "drift_audit|F", "drift_audit|G"]);

/** The cleared keys whose check is retired: cleared by retirement, not repair. */
export function retiredClears(clearedKeys: readonly string[]): string[] {
  return clearedKeys.filter((k) => {
    const { script, check } = parseKey(k);
    return RETIRED_CHECKS.has(`${script}|${check}`);
  });
}

/**
 * The reason an excluded root would silently discard accepted debt, or null.
 *
 * Excluding a root makes every baseline key beneath it unreproducible, so the
 * ratchet reports those keys CLEARED — indistinguishable from "a human fixed
 * them". That is a silent debt-clear, which is what @assent's ruling
 * explicitly forbade ("declared exclusion, not silent debt-clear"), and it is
 * the pack-coverage refusal's failure one level down: path granularity rather
 * than pack granularity.
 *
 * Measured at the time of writing: ZERO baseline keys fall under any excluded
 * root, so this refuses nothing today. That is the argument FOR carrying it
 * rather than against — a measurement records what was true once; a guard
 * keeps it true. The same reasoning `PHASE1_PACKS_INCOMPLETE` failed to apply
 * when its stated reason silently expired.
 *
 * Segment-boundary matching, so `Vault archaeology notes/` is a different
 * folder; a key whose target is a message rather than a path never matches.
 */
export function excludedRootRefusal(baselineKeys: Set<string>, excludedRoots: string[]): string | null {
  const stranded = strandedKeysUnder(baselineKeys, excludedRoots);
  if (!stranded.length) return null;
  const shown = shownKeys(stranded);
  return (
    `refusing to run: the accepted-debt baseline holds ${stranded.length} key(s) under a root this run ` +
    `does not govern (${excludedRoots.join(", ")}). Those keys cannot be reproduced, so they would ` +
    `report CLEARED and silently discard debt a human granted. Excluding territory is a scope ` +
    `decision and must be declared, never taken by quietly dropping its accepted findings — remove ` +
    `the keys from the baseline deliberately (a human act), or stop excluding the root:\n${shown}`
  );
}

/**
 * The pack ids the accepted-debt baseline actually describes — the first field
 * of each ratchet key (`script|check|target|kind`).
 *
 * This is what makes the rebaseline guard a COMPUTED fact rather than a
 * hardcoded constant that goes stale. A key with no `|` contributes itself, so
 * a malformed baseline degrades to naming a pack that is not registered — which
 * refuses — rather than throwing or silently naming nothing.
 */
export function baselinePackIds(baselineKeys: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const key of baselineKeys) {
    // Field 0 (the pack id / `script`) is a fixed pack constant — it never
    // holds a `|` or the `\` escape — so a raw split on the first separator is
    // already the unescaped value; no `parseKey` needed here.
    const id = key.split("|")[0];
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The reason a run may not trust this baseline at all, or null when it may.
 *
 * The baseline names accepted debt for a pack that did not run (or ran and
 * THREW — see `coveredPackIds`). Two distinct harms, one cause:
 *
 * - on a plain run, those keys all report CLEARED and nothing reports NEW, so
 *   the run exits 0 / CONFORMING while silently clearing accepted debt — a
 *   false green, which is the exact shape this whole change exists to remove.
 *   Measured with `--no-legacy-packs` against the live baseline: `0 carried,
 *   0 NEW, 2 cleared, CONFORMING`. The live vault masks it because vocab/scheme
 *   force NONCONFORMING anyway, so it looks fine precisely where it is tested.
 * - on `--rebaseline`, the written keyset cannot contain those keys, so the
 *   accepted debt is destroyed.
 *
 * Both are refusals, not warnings: a report nobody can trust must not also be
 * green, and an unreadable/unmeasured input must never read as an empty one.
 */
export function coverageRefusal(
  baselinePackIds: Set<string>,
  coveredPackIds: Set<string>,
  action: "run" | "--rebaseline" = "run",
): string | null {
  const uncovered = [...baselinePackIds].filter((id) => !coveredPackIds.has(id)).sort();
  if (!uncovered.length) return null;
  const consequence =
    action === "--rebaseline"
      ? "Rewriting it now would drop those accepted keys — debt a human granted — because a run cannot reproduce a pack it never measured."
      : "Every one of those keys would report CLEARED while nothing reports NEW, so this run would exit CONFORMING while silently clearing accepted debt.";
  return (
    `refusing to ${action === "--rebaseline" ? "--rebaseline" : "report"}: the baseline holds accepted debt for ` +
    `${uncovered.join(", ")}, which did not run (or threw) in this configuration. ${consequence} ` +
    `Re-run with those packs enabled, target a baseline that does not describe them, or pass --no-baseline to ` +
    `measure from zero deliberately.`
  );
}

/**
 * Does this baseline path name the LIVE accepted-debt record?
 *
 * Decided over **the file that will actually be written**, not over the shape
 * of argv. The earlier `!baselineArg` test was a proxy: passing
 * `--baseline=<the live baseline's own path>` made it false and the live
 * acceptance record was rewritten — reproduced end-to-end, an accepted key
 * erased from the file (PR #139 review, Critical 1).
 *
 * This is the same failure mode as a guard scanning a normalized copy instead
 * of the bytes that land: deciding over a proxy for the thing rather than the
 * thing. Resolved both sides, and through symlinks where they exist, so an
 * alias cannot launder the identity either.
 */

/**
 * The reason `--rebaseline` may not write to `baselinePath`, or null when it may.
 *
 * Replaces `isLiveBaseline` (#144), which decided over `join(resolve(root),
 * BASELINE_REL)` — and `root` is caller-controlled (`--root` / the
 * `GOVERNOR_CONTENT_ROOT` env var). Pointing `--root` somewhere harmless and
 * `--baseline=` at the real acceptance record made the live record read as "not
 * live", and it was rewritten at exit 0. The first fix removed *argv shape* as
 * the proxy for "which file this writes" and substituted `root`, which is
 * another caller-controlled string. **The lesson is not "use a better string":
 * it is that no caller-supplied value can answer "is this the protected file".
 * Only the filesystem can.**
 *
 * Every branch here fails CLOSED. That is affordable precisely because the
 * refused set is tiny — writing an acceptance baseline is rare and is a human
 * act anyway — which is the test the fail-closed rule actually requires
 * (measure the refused population; do not assume it is exotic).
 */
export function rebaselineTargetRefusal(
  baselinePath: string,
  root: string,
  // The LIVE records' vault-relative paths: what this invocation configures AND what the plugin's own
  // settings in this vault name (#494 review: the two can differ). Empty when none is known.
  liveRels: readonly string[],
): string | null {
  // 1. Outside the content root ⇒ refuse outright, rather than "not live".
  //    This is what closes the decoupled-root bypass: if --root points
  //    elsewhere, the real acceptance record is no longer inside it.
  if (!isInside(root, baselinePath)) {
    return (
      `refusing to --rebaseline ${baselinePath}: it is outside the content root (${resolve(root)}). ` +
      `A baseline is only meaningful relative to the vault it describes, and permitting an out-of-root ` +
      `target lets --root and --baseline be pointed at different vaults so the live acceptance record ` +
      `reads as somebody else's fixture.`
    );
  }

  // No live record known: nothing can be shown NOT to be it. Refuse, rather than let
  // --baseline= rewrite it unchecked (#144).
  const lives = [...new Set(liveRels.map((r) => r.trim()).filter(Boolean))];
  if (lives.length === 0) {
    return (
      `refusing to --rebaseline ${baselinePath}: no live conformance baseline is configured, so this target ` +
      `cannot be checked against it. Set the baseline note in the Vault MCP Conformance plugin's settings for this vault, ` +
      `baselineRel in ${CONVENTIONS_ENV}, or GOVERNOR_BASELINE_REL.`
    );
  }
  for (const liveRel of lives) {
    const r = liveTargetRefusal(baselinePath, root, liveRel);
    if (r) return r;
  }
  return null;
}

/** Checks 2–4 against ONE live record. */
function liveTargetRefusal(baselinePath: string, root: string, liveRel: string): string | null {
  const livePath = join(resolve(root), liveRel);

  // 2. Same name.
  if (resolve(baselinePath) === livePath) return liveRefusal(baselinePath);

  // 3. Same file by device+inode — catches hardlinks and case-insensitive
  //    aliases, neither of which any string comparison can see. (On APFS,
  //    realpath does NOT case-canonicalize, so `.../CONFORMANCE BASELINE.md`
  //    and the real name are different strings and the same inode.)
  const same = sameFile(baselinePath, livePath);
  if (same === true) return liveRefusal(baselinePath);

  // 4. Where each would actually land, symlinks followed by hand.
  const target = intendedRealPath(baselinePath);
  const live = intendedRealPath(livePath);
  if (target === null || live === null) {
    return (
      `refusing to --rebaseline ${baselinePath}: cannot establish whether this is the live acceptance ` +
      `record. Refusing an indeterminate target rather than assuming it is safe — the consequence of ` +
      `being wrong is rewriting or fabricating a record only a human may grant.`
    );
  }
  if (target === live) return liveRefusal(baselinePath);
  // Case-insensitive match: conservative, because a filesystem that folds case
  // makes these one file and we cannot always tell which kind we are on.
  if (target.toLowerCase() === live.toLowerCase()) return liveRefusal(baselinePath);

  return null;
}

function liveRefusal(shown: string): string {
  return (
    `refusing to --rebaseline ${shown}: it is the live acceptance record (by filesystem identity, not ` +
    `by name — hardlinks, symlinks and case aliases all resolve to it). Rewriting it accepts every ` +
    `current finding, and creating it accepts them from zero. Acceptance is a human gesture only — it ` +
    `is never granted by running a tool.`
  );
}

/**
 * The reason a `--rebaseline` must be refused, or null when it may proceed.
 *
 * TWO independent reasons, and they are not the same check:
 *
 * 1. **Uncovered packs.** The baseline names a pack that is not in this run's
 *    registered set, so rebaselining would write out a keyset that cannot
 *    contain that pack's keys — silently DESTROYING accepted debt a human
 *    granted. This applies to a fixture baseline as much as the live one; the
 *    old hardcoded guard only protected the live path.
 * 2. **The live baseline is an acceptance record.** Rewriting it re-accepts
 *    whatever the current run found, and acceptance is human-only. That reason
 *    does not expire when the pack set becomes complete, which is exactly why
 *    this must not collapse into check 1 — with every pack registered, a
 *    coverage-only guard would start PERMITTING the live rebaseline, quietly
 *    turning a governance boundary into a pack-completeness detail.
 *
 * Replaces `GUARD_LIVE_REBASELINE`/`PHASE1_PACKS_INCOMPLETE`, whose stated
 * reason ("drift_audit is unported") silently became false when the drift pack
 * landed. A constant encoding a fact about the pack set has to be computed from
 * the pack set.
 */
export function rebaselineRefusal(opts: {
  targetsLiveBaseline: boolean;
  baselinePackIds: Set<string>;
  registeredPackIds: Set<string>;
}): string | null {
  const cov = coverageRefusal(opts.baselinePackIds, opts.registeredPackIds, "--rebaseline");
  if (cov) return cov;
  if (opts.targetsLiveBaseline) {
    return (
      "refusing to --rebaseline the live baseline: it is an acceptance record, and rewriting it accepts every " +
      "current finding. Acceptance is a human gesture only — it is never granted by running a tool. Target a " +
      "fixture with --baseline=<path> instead."
    );
  }
  return null;
}

/** Registered packs contributing findings that the baseline says nothing about. */
function packsWithoutBaseline(
  registered: string[],
  baseline: Set<string>,
  findings: Finding[],
): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.script, (counts.get(f.script) ?? 0) + 1);
  return registered
    .filter((id) => !baseline.has(id) && (counts.get(id) ?? 0) > 0)
    .map((id) => ({ id, count: counts.get(id) as number }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function renderReport(
  r: RatchetResult,
  registeredPackIds: string[] = [],
  baselineIds: Set<string> = new Set(),
  findings: Finding[] = [],
  excludedRoots: string[] = [],
  budget?: DebtBudgetStatus,
  skippedTerritories: readonly SkippedTerritory[] = [],
  deadConventions: readonly DeadConvention[] = [],
): string {
  const lines: string[] = [];
  lines.push(`conformance: ${r.carried} carried, ${r.newKeys.length} NEW, ${r.clearedKeys.length} cleared`);
  // Debt-budget tooth (#211): a WARNING line when carried debt is over the
  // configured ceiling, so slow-leaking debt is visible in the plain report.
  // Warn-only unless --strict-budget, which also fails the run (see exitCode).
  if (budget?.warning) lines.push(`WARNING: ${budget.warning}`);
  // An exclusion that is not printed is indistinguishable from a rail that
  // simply found nothing there — declare it, per the ruling (#112).
  if (excludedRoots.length) {
    lines.push(`ungoverned (not scanned, no claim made): ${excludedRoots.join(", ")} — --govern-all to include`);
  }
  // Same rule for a guarded territory the walk stepped around (#398): a folder
  // that is silently absent reads as clean. Name it, and the entry that covered it.
  if (skippedTerritories.length) {
    const shown = skippedTerritories.map((t) => `${t.path} (guarded territory '${t.territory}')`).join(", ");
    lines.push(`guarded (not scanned, no claim made): ${shown} — listed in guarded territories`);
  }
  // A convention that names nothing must never read as "checked and clean"
  // (#298): name the key, the dead path, and the pack that therefore did not run.
  for (const d of deadConventions) {
    lines.push(`DEAD CONVENTION: ${d.key} = ${d.path || "(empty)"} — ${CONVENTION_PACKS[d.key].map((id) => `'${id}'`).join(", ")} not measured; set it in the plugin settings (Conformance) or ${CONVENTIONS_ENV}`);
  }
  // A key that clears because its CHECK was retired (#412) is not a repair,
  // and nothing else in the report can tell the two apart: say so, with the
  // count, so the CLEARED number reads right and the prune is deliberate.
  const retired = retiredClears(r.clearedKeys);
  if (retired.length) {
    lines.push(`RETIRED CHECK: ${retired.length} of the ${r.clearedKeys.length} cleared key(s) clear because their check was retired (#412: drift_audit A/B/D/F/G), not because the vault was fixed — prune them by a reviewed rebaseline (--rebaseline --baseline=<copy>, then a human applies it to the acceptance record)`);
  }
  // A pack with NO baseline representation reports its entire output as NEW.
  // Undistinguished, that is indistinguishable from a catastrophic regression —
  // the same silent-zero class the engine's pack sentinels and the missing
  // baseline already refuse, at pack granularity. Say which packs those are so
  // the NEW count can be read correctly instead of alarming.
  const uncovered = packsWithoutBaseline(registeredPackIds, baselineIds, findings);
  if (uncovered.length) {
    const total = uncovered.reduce((n, p) => n + p.count, 0);
    lines.push(
      "",
      `NOTE: ${uncovered.length} pack(s) have NO accepted baseline, contributing ${total} of the ${r.newKeys.length} NEW keys:`,
    );
    for (const p of uncovered) lines.push(`  ! ${p.id} — ${p.count} finding(s), 0 accepted`);
    lines.push(
      "  These are unmeasured, not newly broken. Accepting a baseline for them is a human act; no run can grant it.",
    );
  }
  if (r.newKeys.length) {
    lines.push("", "NEW (regressions — run fails):");
    for (const k of r.newKeys) lines.push(`  + ${k}`);
  }
  if (r.clearedKeys.length) {
    lines.push("", "CLEARED (rebaseline to drop):");
    for (const k of r.clearedKeys) lines.push(`  - ${k}`);
  }
  lines.push("", r.failed ? "NONCONFORMING: new findings present" : "CONFORMING within the accepted baseline");
  return lines.join("\n");
}

// ── thin process entry (not unit-tested; the wiring above is) ─────────────────

/** The plugin folders whose data.json can hold this vault's conventions, in
 *  the order they are asked: the vaultmcp-conformance satellite (which owns the
 *  setting since 2026-10-14), then the Vault MCP host (which held it from #403
 *  and keeps it in data.json for the satellite's one-shot adoption). */
export const CONVENTIONS_PLUGIN_DIRS = ["vaultmcp-conformance", "vault-mcp"] as const;

/**
 * The baseline path the in-app rail in this vault reads (#493), or "" when
 * no plugin settings file names one. Derived by the plugins' OWN load-time
 * rules, not the raw key, so a data.json that predates the key yields the path
 * the plugin will seed, not "" (#494 review): the satellite's data.json when it
 * carries `vaultConventions` (`conventionsOnLoad`), else the host's
 * (`conventionsFromHostData`, the rule the satellite adopts by). The CLI cannot
 * see the plugin's live settings any other way, and it needs them twice: as its
 * own path when its environment names none, and as a live record --rebaseline
 * must never rewrite. Read-only; never throws.
 */
export function pluginBaselineRel(root: string, env: Record<string, string | undefined> = process.env): string {
  const vault = resolve(root);
  const exists = (r: string) => existsSync(join(vault, r));
  const read = (dir: string): Record<string, unknown> | null => {
    try {
      const data = JSON.parse(readFileSync(join(vault, ".obsidian", "plugins", dir, "data.json"), "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  try {
    const own = read(CONVENTIONS_PLUGIN_DIRS[0]);
    let rel: unknown;
    if (own && Object.prototype.hasOwnProperty.call(own, "vaultConventions")) {
      rel = conventionsOnLoad(own, undefined, env, exists).conventions.baselineRel;
    } else {
      const host = read(CONVENTIONS_PLUGIN_DIRS[1]);
      if (!host) return "";
      rel = conventionsFromHostData(host, env, exists).baselineRel;
    }
    return typeof rel === "string" ? rel.trim() : "";
  } catch {
    return "";
  }
}

/**
 * The baseline path the IN-APP sources read (#493): the plugin's own setting
 * first, so an edit in Settings always takes effect; the process-environment
 * override only when the setting is blank. ("" ⇒ none configured.)
 */
export function inAppBaselineRel(conventions?: Pick<VaultConventions, "baselineRel"> | null): string {
  return (conventions?.baselineRel ?? "").trim() || baselineRelFrom(process.env);
}

/** True when the in-app path comes from the process environment: the plugin's setting is blank and the override is set. */
export function inAppBaselineFromEnv(conventions?: Pick<VaultConventions, "baselineRel"> | null): boolean {
  return (conventions?.baselineRel ?? "").trim() === "" && baselineRelFrom(process.env) !== "";
}

/**
 * The in-app refusal when no baseline is configured, or the configured note is
 * missing. `fromEnv` says the path came from GOVERNOR_BASELINE_REL (the setting
 * is blank), so the message names the place the operator must fix.
 */
export function inAppBaselineRefusal(rel: string, exists: boolean, fromEnv = false): string | null {
  if (!rel) {
    return "no conformance baseline is configured: set the baseline note in the Vault MCP Conformance plugin's settings (vault conventions, baselineRel), or set GOVERNOR_BASELINE_REL in Obsidian's environment";
  }
  if (!exists) {
    const where = fromEnv
      ? "GOVERNOR_BASELINE_REL in Obsidian's environment names it, because the Conformance setting is blank"
      : "the Vault MCP Conformance plugin's settings name it";
    return `the conformance baseline note is missing: '${rel}' (${where}) — refusing to report every finding as NEW against an empty baseline`;
  }
  return null;
}

/**
 * The baseline's vault-relative path for this invocation: the `BASELINE_REL`
 * environment override (`GOVERNOR_BASELINE_REL`, or the legacy `ASSENT_BASELINE_REL`) first,
 * else the vault conventions' `baselineRel` setting (#493), else "" — none
 * configured. The plugin ships no path (Nelson, 2026-10-03: "No folder names
 * are ever in the live code"); an install that predates the key is seeded once
 * by `withBaselineSeed` (conventions-policy.ts). The CLI also takes
 * `--baseline=` (absolute), and falls back to `pluginBaselineRel` when this
 * returns "". In-app the order is the other way round: `inAppBaselineRel`.
 */
export function baselineRelFrom(
  env: Record<string, string | undefined>,
  conventions?: Pick<VaultConventions, "baselineRel"> | null,
): string {
  const v = (envAliased(env, "BASELINE_REL") ?? "").trim();
  return v || (conventions?.baselineRel ?? "").trim();
}
const FENCE = "```ratchet-baseline";

/**
 * Env var that opts INTO the legacy upward `.obsidian`-ancestor walk (#157
 * follow-up on #168). Never consulted implicitly — `rootDiscoveryRefusal`
 * decides whether `discoverRoot`'s walk may run at all; the walk itself has
 * no fallback of its own once that gate has passed.
 */
export const ALLOW_ROOT_DISCOVERY_ENV = "GOVERNOR_ALLOW_ROOT_DISCOVERY";
/** Pre-0.12.0 spelling, still honored as a fallback alias (env-alias.ts). */
export const LEGACY_ALLOW_ROOT_DISCOVERY_ENV = "ASSENT_ALLOW_ROOT_DISCOVERY";

/** The same opt-in, spelled as an argv flag for one-off interactive use
 * without exporting an env var. Either form is sufficient. */
export const DISCOVER_ROOT_FLAG = "--discover-root";

function truthyEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false";
}

/**
 * The reason `runCli` may not fall back to `discoverRoot`'s upward filesystem
 * walk, or null when it may proceed — either because `GOVERNOR_CONTENT_ROOT` is
 * set (`discoverRoot` will use it directly and never walk), or because the
 * walk itself has been explicitly opted into.
 *
 * The remaining half of #157: #168 made `buildSnapshot` refuse a root outside
 * a declared boundary, but a caller that supplied NO root at all still
 * reached `discoverRoot`, which walked upward from `process.cwd()` and
 * quietly used whatever `.obsidian`-ancestor it found — or, finding none,
 * `cwd` itself — as its OWN boundary (`runConformance` threads `boundary:
 * opts.root`). That is a silent default wearing a boundary's clothes:
 * nothing outside this function ever saw the absence of a declared root,
 * because the walk manufactured one instead of saying so.
 *
 * `discoverRoot` is pre-existing dev convenience (walk up to find the vault
 * you're standing inside, so a developer running the CLI from a subdirectory
 * doesn't have to spell out `--root=`) and was NOT the vector that caused the
 * #157 breach — that was a standalone script, not this CLI. So it is kept,
 * not deleted, but demoted from silent default to an explicit opt-in:
 * `--discover-root` or `GOVERNOR_ALLOW_ROOT_DISCOVERY=1`. Absent both, and
 * absent `GOVERNOR_CONTENT_ROOT`, this refuses — naming every way to proceed
 * rather than guessing one.
 *
 * A discovered root (opt-in path) is not a bypass of #168's guard: `runCli`
 * still threads it into `buildSnapshot` as `boundary: opts.root`, exactly
 * like an explicit `--root=`, so the configured territories (`--territory=` /
 * `GOVERNOR_TERRITORIES`; none built in since #397) and the boundary check
 * apply to it identically — this function only
 * gates whether the walk may run at all, never what it is allowed to find.
 */
export function rootDiscoveryRefusal(argv: string[], env: Record<string, string | undefined>): string | null {
  if (envAliased(env, "CONTENT_ROOT")) return null;
  if (argv.includes(DISCOVER_ROOT_FLAG) || truthyEnv(envAliased(env, "ALLOW_ROOT_DISCOVERY"))) return null;
  return (
    `refusing to run: no content root declared. Set GOVERNOR_CONTENT_ROOT=<path> (legacy alias ` +
    `ASSENT_CONTENT_ROOT), or pass --root=<path>, naming ` +
    `the vault to run against. There is no default to $HOME, the current working directory, or any hardcoded ` +
    `path. (Interactive dev convenience only: ${DISCOVER_ROOT_FLAG} or ${ALLOW_ROOT_DISCOVERY_ENV}=1 (legacy ` +
    `${LEGACY_ALLOW_ROOT_DISCOVERY_ENV}=1) opts back ` +
    `into walking upward from the current directory for a \`.obsidian\` ancestor — a root found this way is ` +
    `still subject to the same deny-list and boundary checks as any other.)`
  );
}

/** GOVERNOR_CONTENT_ROOT (legacy alias ASSENT_CONTENT_ROOT) wins, else walk up
 * from `start` to the `.obsidian`
 * ancestor (the same discovery the Python scripts use), else `start`. Only
 * ever called after `rootDiscoveryRefusal` has returned null for the current
 * argv/env — see that function for why the walk is no longer reached by
 * default. */
function discoverRoot(start: string): string {
  const env = envAliased(process.env, "CONTENT_ROOT");
  if (env) return resolve(env);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".obsidian"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

/** Replace (or append) the ratchet-baseline fence body in a baseline note.
 * Throws if the note has an opening fence marker but no complete fence block
 * (truncated/corrupt) — a silent no-op there would report "rebaselined" while
 * leaving the accepted debt untouched. The replacement uses a FUNCTION replacer
 * so `$`-sequences in `body` (vault paths can contain `$&` etc.) are inserted
 * literally, never interpreted as `String.replace` substitution patterns. */
export function writeFence(noteText: string, body: string): string {
  const block = `${FENCE}\n${body}\n\`\`\``;
  if (!noteText.includes(FENCE)) {
    return `${noteText.trimEnd()}\n\n${block}\n`;
  }
  const re = /```ratchet-baseline\n[\s\S]*?\n```/;
  if (!re.test(noteText)) {
    throw new Error("baseline note has an opening ```ratchet-baseline marker but no complete fence block — refusing to rebaseline a corrupt baseline");
  }
  return noteText.replace(re, () => block);
}

/**
 * Refusal text when the baseline is missing, or null when the run may proceed.
 *
 * A MISSING baseline must not silently read as empty: an empty baseline makes
 * every finding NEW and every accepted-debt key CLEARED — a report that looks
 * like catastrophic regression but is really a missing file, and the shape most
 * likely to be mistaken for a real result. This is the same silent-zero class
 * the engine's pack sentinels already refuse (`conformance_engine/pack_error`);
 * the baseline gets the same treatment.
 *
 * `--no-baseline` is the explicit opt-in for a genuine from-zero run (a first
 * run, or a deliberate reset) — the refusal is about the SILENT case, not about
 * forbidding zero baselines.
 */
export function baselineMissingRefusal(baselinePath: string, exists: boolean, noBaseline: boolean): string | null {
  if (noBaseline || exists) return null;
  return (
    `baseline not found at ${baselinePath} — refusing to run against an empty baseline, which would report every ` +
    `finding as NEW and every accepted key as CLEARED. Point at it with --baseline=<path>, or pass --no-baseline ` +
    `to run from zero deliberately.`
  );
}

export async function runCli(argv: string[]): Promise<void> {
  const rebaseline = argv.includes("--rebaseline");
  // The run's clock, sampled ONCE at entry. Threaded into the sidecar stamp and
  // the trend record so both agree, and so a shared bundle never assumes a live
  // Date.now() in a context that lacks one (issue #211).
  const now = new Date();
  const debtBudget = debtBudgetFrom(argv, process.env);
  const strictBudget = argv.includes("--strict-budget");
  const rootArg = argv.find((a) => a.startsWith("--root="))?.slice("--root=".length);
  let root: string;
  if (rootArg) {
    root = resolve(rootArg);
  } else {
    // No --root=: either GOVERNOR_CONTENT_ROOT is set (discoverRoot uses it
    // directly, no walk) or the caller opted into the upward walk. Absent
    // both, refuse rather than let discoverRoot manufacture a boundary by
    // guessing — see rootDiscoveryRefusal.
    const discoveryRefusal = rootDiscoveryRefusal(argv, process.env);
    if (discoveryRefusal) throw new Error(discoveryRefusal);
    root = discoverRoot(process.cwd());
  }
  const baselineArg = argv.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length);
  const conventions = conventionsFromEnv(process.env);
  // The plugin's own setting in this vault (#494 review): the CLI's path when its environment names none,
  // and always a live record --rebaseline must not rewrite.
  const pluginRel = pluginBaselineRel(root);
  const baselineRel = baselineRelFrom(process.env, conventions) || pluginRel;
  if (!baselineArg && !baselineRel) {
    throw new Error(
      `no conformance baseline is configured: set baselineRel in ${CONVENTIONS_ENV} or in the Vault MCP Conformance ` +
        "plugin's settings for this vault, set GOVERNOR_BASELINE_REL, or pass --baseline=<path>"
    );
  }
  const baselinePath = baselineArg ? resolve(baselineArg) : join(root, baselineRel);
  // A MISSING baseline is refused, not silently treated as empty. An empty
  // baseline makes every finding read NEW and every accepted-debt key read
  // CLEARED — a report that looks like catastrophic regression but is really a
  // missing file, and the shape most likely to be mistaken for a real result.
  // This is the silent-zero class the engine's pack sentinels already refuse;
  // the baseline deserves the same treatment. `--no-baseline` is the explicit
  // opt-in for a genuine from-zero run (a first run, or a deliberate reset).
  const noBaseline = argv.includes("--no-baseline");
  const refusal = baselineMissingRefusal(baselinePath, existsSync(baselinePath), noBaseline);
  if (refusal) throw new Error(refusal);
  const baselineText = !noBaseline && existsSync(baselinePath) ? await readFile(baselinePath, "utf8") : "";

  // Scope (#112): excluded territory is content the rail makes no claim about.
  // `--govern-all` opts back in to a whole-vault run. Checked BEFORE the run:
  // an exclusion that would strand accepted debt is refused, not reported
  // afterwards, so no CLEARED line ever appears for a key we chose not to look at.
  const excludedRoots = argv.includes("--govern-all") ? [] : excludedRootsFrom(argv, process.env);
  const strandRefusal = excludedRootRefusal(parseBaseline(baselineText), excludedRoots);
  if (strandRefusal) throw new Error(strandRefusal);

  const res = await runConformance({
    root,
    baselineText,
    vocabularies: DEFAULT_VOCABULARIES,
    schemes: DEFAULT_SCHEMES,
    // Default ON — see RunOpts.legacyPacks. The baseline describes these packs
    // and nothing else, so omitting them clears it wholesale.
    legacyPacks: !argv.includes("--no-legacy-packs"),
    // The rail governs live content, not the frozen archive (#112 ruling).
    excludedRoots,
    // Guarded territories the walk must refuse (#397) — from the invocation,
    // never a constant; none given means none refused.
    territories: territoriesFrom(argv, process.env),
    // The vault conventions (#403): from the invocation's environment
    // (`VAULT_MCP_CONVENTIONS`; the two old spellings read once more, warned),
    // never a constant; unset means every convention dead, said loudly.
    conventions,
    // Debt-budget tooth (#211): warn-only unless --strict-budget.
    debtBudget,
    strictBudget,
  });

  // Coverage is checked on EVERY run, not only before a rebaseline: a baseline
  // naming packs this run did not measure makes those keys report CLEARED with
  // nothing NEW, i.e. exit 0 / CONFORMING while silently clearing accepted debt.
  // Green-and-wrong is worse than red. (PR #139 review, Critical 2.)
  const baselineIds = baselinePackIds(parseBaseline(baselineText));
  const covered = new Set(res.coveredPackIds);
  const coverage = coverageRefusal(baselineIds, covered, rebaseline ? "--rebaseline" : "run");
  if (coverage) {
    // The refusal says "did not run (or threw)". When the cause is a dead
    // convention (#298) the pack did not run BECAUSE its path names nothing,
    // and the real remedy is the conventions setting (or VAULT_MCP_CONVENTIONS
    // for the CLI) — which the report names and this throw would otherwise
    // discard. Say the cause with the refusal (#401 review).
    const dead = res.deadConventions.map((d) => `  ${d.key} = ${d.path || "(empty)"} (${CONVENTION_PACKS[d.key].join(", ")})`);
    throw new Error(dead.length ? `${coverage}\nThe unmeasured pack(s) read a DEAD convention path — set it in the plugin settings (Conformance) or ${CONVENTIONS_ENV}:\n${dead.join("\n")}` : coverage);
  }

  // Trend (#211, A3): one append-only record per run capturing the burn-down
  // numbers, beside the baseline. Best-effort — a broken trend log never fails
  // the run (appendTrend swallows). Recorded on every run that got this far
  // (past all refusals), including a rebaseline, whose counts describe the
  // state the human is about to accept.
  const trendRec: DebtTrendRecord = {
    ts: now.toISOString(),
    carried: res.ratchet.carried,
    cleared: res.ratchet.clearedKeys.length,
    new: res.ratchet.newKeys.length,
  };
  await appendTrend(trendPathFor(baselinePath), trendRec);

  // ── the human-facing register (issue #211, Part B) ─────────────────────────
  // `--render-register` writes `Conformance debt.md` (default: beside the
  // baseline; `--register-dir=`/`GOVERNOR_REGISTER_DIR` overrides). At
  // `--rebaseline` an EXISTING register is refreshed automatically — the debt
  // set just changed under it — but one is never created unasked. DERIVED
  // output only: it never touches the baseline or the sidecar.
  const renderRegister = argv.includes("--render-register");
  const registerDirArg = registerDirFrom(argv, process.env);
  const registerDir = registerDirArg
    ? isAbsolute(registerDirArg)
      ? resolve(registerDirArg)
      : join(root, registerDirArg)
    : dirname(baselinePath);
  const registerPath = join(registerDir, REGISTER_BASENAME);
  const staleAfterDays = staleAfterFrom(argv, process.env);
  const renderRegisterTo = async (baselineKeys: Set<string>, sidecar: DebtSidecar): Promise<void> => {
    // A baseline note named like the register would be overwritten by its own
    // report — refuse the collision rather than clobber an acceptance record.
    // Case-folded: the default macOS filesystem treats case variants as one
    // file, and `resolve` does not case-canonicalize (the same caveat the
    // rebaseline identity guard documents). A symlink alias of the register
    // dir can still evade a string compare — accepted residual: it requires
    // deliberately aliasing the baseline's own folder AND naming the baseline
    // like the register.
    if (resolve(registerPath).toLowerCase() === resolve(baselinePath).toLowerCase()) {
      throw new Error(
        `refusing to render the register over the baseline itself (${registerPath}) — point --register-dir elsewhere`,
      );
    }
    const { text } = buildRegisterFromRun({
      baselineKeys,
      live: res.findings,
      sidecar,
      now,
      staleAfterDays,
      debtBudget,
      strictBudget,
    });
    // The shared accept-guard over the text that will land — same invariant as
    // the MCP render tool: the register can never carry an acceptance field.
    registerAcceptRefusal(text);
    await writeFile(registerPath, text);
    process.stdout.write(`rendered register ${registerPath}\n`);
  };

  if (rebaseline) {
    // Computed from the run that just happened, not a hardcoded constant, and
    // keyed on the FILE THIS WILL WRITE rather than on argv shape — pointing
    // --baseline= at the live baseline's own path used to slip this guard
    // entirely. Checked BEFORE the write: a refused rebaseline must leave the
    // accepted debt exactly as it was.
    // Identity first: whether this write lands on the live acceptance record is
    // decided by the filesystem, before any coverage reasoning (#144).
    // Every live record this invocation can see: its own path, the conventions' own path when the env override
    // shadows it, and the plugin's setting in this vault, with and without this shell's override (#494 review).
    // The plugin seeds from Obsidian's environment, not this shell's, so the path it fills with no override is protected too.
    const targetRefusal = rebaselineTargetRefusal(baselinePath, root, [
      baselineRel,
      conventions.baselineRel,
      pluginRel,
      pluginBaselineRel(root, {}),
    ]);
    if (targetRefusal) throw new Error(targetRefusal);
    const refusal = rebaselineRefusal({
      targetsLiveBaseline: false, // established above; a live target already threw
      baselinePackIds: baselineIds,
      registeredPackIds: covered,
    });
    if (refusal) throw new Error(refusal);
  }

  if (rebaseline) {
    // Debt metadata sidecar (#211, A1): reconcile it against the keyset being
    // written. New keys get `acceptedOn` (this run's clock) + `acceptedBy` (the
    // human identity); persisting keys carry their entry forward verbatim
    // (human reason/priority/fixBy preserved); departed keys are dropped. This
    // is the ONE place acceptance metadata is minted, and it runs only here, at
    // the human-run --rebaseline. Parsed/reconciled BEFORE the baseline write so
    // a corrupt existing sidecar (strict parse throws) aborts the WHOLE
    // rebaseline atomically — never leaving the baseline rewritten while the
    // human's annotations we could not read are clobbered or stranded.
    const sidecarPath = sidecarPathFor(baselinePath);
    const prevSidecarText = existsSync(sidecarPath) ? await readFile(sidecarPath, "utf8") : "";
    const prevSidecar = parseSidecarStrict(prevSidecarText); // throws on a present-but-corrupt sidecar
    // Same rule as `rebaseline` above: engine findings are not debt.
    const baselineKeysWritten = new Set(res.findings.filter((f) => f.script !== ENGINE_ID).map((f) => findingKey(f)));
    const nextSidecar = reconcileSidecar(prevSidecar, baselineKeysWritten, {
      acceptedOn: isoDate(now),
      acceptedBy: acceptedByFrom(argv, process.env),
    });

    const next = writeFence(baselineText || "# Conformance baseline\n", res.rebaseline);
    await writeFile(baselinePath, next);
    await writeFile(sidecarPath, serializeSidecar(nextSidecar));

    process.stdout.write(`rebaselined ${baselinePath} (${baselineKeysWritten.size} findings)\n`);

    // Refresh the register from the POST-rebaseline state (every live PACK key
    // is now accepted; engine findings are never accepted, so a dead
    // convention still reads NEW here — correctly, the next run fails on it) —
    // when asked, or when a register already exists (it just went stale).
    // Never created unasked.
    if (renderRegister || existsSync(registerPath)) {
      await renderRegisterTo(baselineKeysWritten, nextSidecar);
    }
    return;
  }

  if (renderRegister) {
    const sidecarPath = sidecarPathFor(baselinePath);
    // Tolerant parse (the read tool's discipline): a broken sidecar renders a
    // register without metadata rather than failing the run over a display
    // artifact — the strict parse stays reserved for the sidecar WRITE path.
    const sidecar = parseSidecar(existsSync(sidecarPath) ? await readFile(sidecarPath, "utf8") : "");
    await renderRegisterTo(parseBaseline(baselineText), sidecar);
  }

  process.stdout.write(res.report + "\n");
  process.exitCode = res.exitCode;
}

// The process entry lives in ./main.ts (kept separate so this importable core
// carries no `import.meta` — the plugin bundles `runConformance` from here for
// the read-only debt tool, and esbuild cannot represent `import.meta` in CJS).
