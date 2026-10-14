// debt-trend.ts — one append-only record per conformance run capturing the
// burn-down numbers (issue #211, Part A3). Backs a debt-over-time view a later
// PR renders; here it is just the durable log.
//
// APPEND-ONLY: the only write is `appendTrend` (an fs append); there is no
// edit/prune/read-back API and the CLI never rewrites the file. The line format
// is one JSON object per line (JSONL), reusing the write journal's convention.
// The report tool never writes here — a debt run's trend point is recorded by
// the CLI rail run, not by an agent-reachable read.

import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_TREND_BASENAME = "debt-trend.jsonl";

/** One run's burn-down numbers. `new` is the regression count (a live finding
 * not in the baseline) — the same trio the ratchet reports. */
export interface DebtTrendRecord {
  /** ISO-8601 UTC timestamp of the run. */
  ts: string;
  carried: number;
  cleared: number;
  "new": number;
}

/** Where the trend log lives: next to the baseline note, alongside the sidecar. */
export function trendPathFor(baselinePath: string): string {
  return join(dirname(baselinePath), DEFAULT_TREND_BASENAME);
}

/** The single JSONL line for a record (object + newline). Stable key order so
 * the log diffs cleanly. */
export function trendLine(rec: DebtTrendRecord): string {
  return JSON.stringify({ ts: rec.ts, carried: rec.carried, cleared: rec.cleared, new: rec.new }) + "\n";
}

/**
 * Append one record to the trend JSONL. Best-effort: a write failure is
 * swallowed (returns false) rather than failing the conformance run — a broken
 * trend log must never cost a vault operation, the same discipline the write
 * journal applies. `>>`-style append is atomic for a small line.
 */
export async function appendTrend(path: string, rec: DebtTrendRecord): Promise<boolean> {
  try {
    await appendFile(path, trendLine(rec), "utf8");
    return true;
  } catch {
    return false;
  }
}
