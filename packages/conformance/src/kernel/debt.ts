import type { SkippedTerritory } from "./snapshot.js";
// debt.ts — the pure conformance-debt report core (issue #211, Part A2 + teeth).
//
// Given the accepted-debt baseline keyset, the live findings, and the metadata
// sidecar, produce the CARRIED debt as structured items enriched with the
// sidecar fields and an `ageDays` computed from `acceptedOn`, plus summary
// counts (carried/cleared/new) and the two teeth: staleness flags and a debt
// budget status. No I/O, no clock of its own — the caller passes `now`, so the
// whole thing is deterministic and headless-testable. The MCP tool
// (src/tools.ts) and the CLI compose it over a real run.

import { findingKey, parseKey, type Finding } from "./finding.js";
import type { DebtSidecar, DebtEntry } from "./debt-sidecar.js";

/** One carried-debt line: its 4-tuple identity, the metadata (if any), and the
 * computed age/stale teeth. */
export interface DebtItem {
  script: string;
  check: string;
  /** The note path (or token) the finding is about. */
  target: string;
  kind: string;
  /** The serialized `script|check|target|kind` key — the baseline line. */
  key: string;
  acceptedOn?: string;
  acceptedBy?: string;
  reason?: string;
  priority?: string;
  fixBy?: string;
  /** Whole days from `acceptedOn` to `now`; absent when `acceptedOn` is unknown
   * or unparseable. */
  ageDays?: number;
  /** True iff staleness is enabled and `ageDays >= staleAfterDays`. */
  stale?: boolean;
}

export interface DebtSummary {
  /** Live findings also in the baseline — the standing accepted backlog. */
  carried: number;
  /** Baseline keys with no live match — fixed (or moved); prune at rebaseline. */
  cleared: number;
  /** Live findings not in the baseline — regressions (would fail the run). */
  new: number;
}

/** The debt-budget tooth's status. `budget` null ⇒ no budget configured. */
export interface DebtBudgetStatus {
  /** Configured max carried count, or null when the budget is off. */
  budget: number | null;
  carried: number;
  /** carried > budget (always false when budget is null). */
  over: boolean;
  /** Whether over-budget is treated as a hard failure (`--strict-budget`);
   * report-only otherwise. */
  strict: boolean;
  /** A human-readable warning line when over budget, else null. */
  warning: string | null;
}

export interface DebtReport {
  items: DebtItem[];
  /** Guarded territories the live run stepped around (#398) — reported so a
   * folder that is absent from the register is never mistaken for clean. */
  skippedTerritories: SkippedTerritory[];
  summary: DebtSummary;
  /** The subset of `items` flagged stale (empty when staleness is off). */
  stale: DebtItem[];
  budget: DebtBudgetStatus;
  /** The staleness threshold in effect (days), or null when disabled. */
  staleAfterDays: number | null;
}

export interface DebtReportOpts {
  /** Accepted-debt keys parsed from the baseline note (ratchet.ts parseBaseline). */
  baselineKeys: Set<string>;
  /** The live conformance findings for this run. */
  live: Finding[];
  /** The metadata sidecar (empty is fine). */
  sidecar: DebtSidecar;
  /** The run's clock — passed in, never sampled here. */
  now: Date;
  /** Flag items older than this many days as stale. `undefined`/`<=0` ⇒ off. */
  staleAfterDays?: number;
  /** Max carried count before the budget warns. `undefined`/`null` ⇒ off. */
  debtBudget?: number | null;
  /** Treat over-budget as a hard failure (report-only flips to a fail signal). */
  strictBudget?: boolean;
  /** Guarded territories the live run skipped (#398); absent ⇒ none. */
  skippedTerritories?: readonly SkippedTerritory[];
}

/** Narrowing filter over debt items. All fields optional and ANDed together. */
export interface DebtFilter {
  /** Keep items whose `target` is at/under this folder prefix (segment
   * boundary — `Projects` matches `Projects/x.md`, not `Projects2/x.md`). */
  folder?: string;
  /** Keep items whose `script` (rule pack) equals this. */
  pack?: string;
  /** Keep items whose `check` equals this. */
  check?: string;
  /** Keep items whose `kind` equals this. */
  kind?: string;
}

/** Default staleness threshold (days) — a "sane default" (issue #211 teeth);
 * `staleAfterDays: 0` disables it. Lives here (not in the tool layer) so the
 * headless CLI's register render and the MCP tool agree on it without a
 * conformance → mcp import. */
export const DEFAULT_STALE_AFTER_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/** Whole days between an ISO `acceptedOn` (YYYY-MM-DD) and `now`, or undefined
 * when the date is absent/unparseable. Floored at 0 — a future acceptance date
 * is 0 days old, never negative. Compared UTC-midnight to UTC-midnight so the
 * time-of-day of `now` never shifts the day count. */
export function ageDaysOf(acceptedOn: string | undefined, now: Date): number | undefined {
  if (!acceptedOn) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(acceptedOn.trim());
  if (!m) return undefined;
  const accepted = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(accepted)) return undefined;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.floor((today - accepted) / MS_PER_DAY);
  return days < 0 ? 0 : days;
}

/** Segment-boundary prefix test: `folder` matches `target` when equal or when
 * `target` starts with `folder + "/"`. A trailing slash on `folder` is
 * tolerated. */
function underFolder(target: string, folder: string): boolean {
  const f = folder.replace(/\/+$/, "");
  if (!f) return true;
  return target === f || target.startsWith(f + "/");
}

/** Apply a filter to a list of debt items (pure; returns a new array). */
export function filterDebtItems(items: DebtItem[], filter?: DebtFilter): DebtItem[] {
  if (!filter) return items;
  return items.filter((it) => {
    if (filter.folder && !underFolder(it.target, filter.folder)) return false;
    if (filter.pack && it.script !== filter.pack) return false;
    if (filter.check && it.check !== filter.check) return false;
    if (filter.kind && it.kind !== filter.kind) return false;
    return true;
  });
}

export type DebtGroupKey = "folder" | "pack" | "check" | "kind";

export interface DebtGroup {
  /** The group value (pack id, check, kind, or top-level folder). */
  group: string;
  count: number;
}

/** The top-level folder of a target path (`Projects/Sub/Note.md` → `Projects`),
 * or "(root)" when the target has no folder / is a bare token. */
function topFolder(target: string): string {
  const i = target.indexOf("/");
  return i > 0 ? target.slice(0, i) : "(root)";
}

/** Count debt items grouped by one dimension, sorted by count desc then name. */
export function groupDebtItems(items: DebtItem[], by: DebtGroupKey): DebtGroup[] {
  const counts = new Map<string, number>();
  for (const it of items) {
    const g = by === "pack" ? it.script : by === "check" ? it.check : by === "kind" ? it.kind : topFolder(it.target);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}

/** Build the full carried-debt report. Deterministic in `now`; applies NO
 * filtering (the tool layer composes `filterDebtItems`/`groupDebtItems`). */
export function buildDebtReport(opts: DebtReportOpts): DebtReport {
  const liveKeys = new Set(opts.live.map((f) => findingKey(f)));
  const staleAfter = opts.staleAfterDays != null && opts.staleAfterDays > 0 ? opts.staleAfterDays : null;

  // carried = baseline ∩ live, materialized as enriched items (sorted by key).
  const carriedKeys = [...opts.baselineKeys].filter((k) => liveKeys.has(k)).sort();
  const items: DebtItem[] = carriedKeys.map((key) => {
    const parsed = parseKey(key);
    const meta: DebtEntry = opts.sidecar.entries[key] ?? {};
    const ageDays = ageDaysOf(meta.acceptedOn, opts.now);
    const stale = staleAfter != null && ageDays != null && ageDays >= staleAfter;
    const item: DebtItem = { ...parsed, key };
    if (meta.acceptedOn) item.acceptedOn = meta.acceptedOn;
    if (meta.acceptedBy) item.acceptedBy = meta.acceptedBy;
    if (meta.reason) item.reason = meta.reason;
    if (meta.priority) item.priority = meta.priority;
    if (meta.fixBy) item.fixBy = meta.fixBy;
    if (ageDays != null) item.ageDays = ageDays;
    if (staleAfter != null) item.stale = stale;
    return item;
  });

  const clearedCount = [...opts.baselineKeys].filter((k) => !liveKeys.has(k)).length;
  const newCount = [...liveKeys].filter((k) => !opts.baselineKeys.has(k)).length;
  const summary: DebtSummary = { carried: items.length, cleared: clearedCount, new: newCount };

  const budget = budgetStatus(items.length, opts.debtBudget ?? null, opts.strictBudget ?? false);
  const stale = staleAfter != null ? items.filter((it) => it.stale) : [];

  return { items, summary, stale, budget, staleAfterDays: staleAfter, skippedTerritories: [...(opts.skippedTerritories ?? [])] };
}

/** Compute the debt-budget status for a carried count. Warn-only unless
 * `strict`; a null budget is off (never over). */
export function budgetStatus(carried: number, budget: number | null, strict: boolean): DebtBudgetStatus {
  const over = budget != null && carried > budget;
  const warning = over
    ? `debt budget exceeded: ${carried} carried > ${budget} budget` + (strict ? " (strict: run fails)" : " (warning only)")
    : null;
  return { budget, carried, over, strict, warning };
}
