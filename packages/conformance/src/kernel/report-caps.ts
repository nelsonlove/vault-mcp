// report-caps.ts — the size cap every conformance report obeys.
//
// On 2026-10-01 Forge wrote a 47.8 MB `health-dashboard.json` and a 45.3 MB
// `lint-report.json` into the vault and Obsidian's renderer crashed. The vault
// task "Replace the four Forge-only checks" (Nelson's verify of 2026-10-14)
// therefore makes every replacement obey four caps; this file holds them:
//
//  1. A report note in the vault lists at most 200 findings, then one line
//     "+N more", and stays under 256 KB (`REPORT_MAX_FINDINGS`,
//     `REPORT_NOTE_MAX_BYTES`; the debt register applies both).
//  2. The full finding set goes to a JSON file OUTSIDE the vault, under
//     `~/.local/share/vault-audits/`, never inside an indexed folder
//     (`auditsDir`, `fullFindingsPathRefusal` in audit-output.ts; the CLI's
//     `--findings-json`).
//  3. A run whose full output would pass 5 MB stops and reports the count, not
//     the findings (`FULL_OUTPUT_MAX_BYTES`, `overFullOutputCap`).
//  4. Every report states what it checked as well as what it found
//     (`RunCoverage`, `coverageLine`).
//
// Pure, with no node:fs: tools.ts imports it, and tools.ts stays free of
// node:fs (its tests are headless). The two path functions of cap 2 live in
// audit-output.ts.

import type { ShapeCoverage } from "./packs/shape.js";

/** Cap 1: findings a report note in the vault lists before its "+N more" line. */
export const REPORT_MAX_FINDINGS = 200;
/** Cap 1: the most a report note in the vault may weigh, in UTF-8 bytes (it stays UNDER this). */
export const REPORT_NOTE_MAX_BYTES = 256 * 1024;
/** Cap 3: the most a run's full output may weigh before it is replaced by counts. */
export const FULL_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A requested row count, clamped to cap 1 (a non-number or a negative reads as the cap). */
export function capRows(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) return REPORT_MAX_FINDINGS;
  return Math.min(Math.floor(requested), REPORT_MAX_FINDINGS);
}

/** The first `limit` items and the count left out (cap 1's "+N more"). */
export function capList<T>(items: readonly T[], limit: number = REPORT_MAX_FINDINGS): { shown: T[]; more: number } {
  const n = Math.max(0, Math.min(limit, items.length));
  return { shown: items.slice(0, n), more: items.length - n };
}

/** Cap 3: true when this output passes 5 MB. */
export function overFullOutputCap(text: string): boolean {
  return utf8Bytes(text) > FULL_OUTPUT_MAX_BYTES;
}

/** Cap 4: what one run checked, stated in every report beside what it found. */
export interface RunCoverage {
  /** `.md` notes the walk read. */
  notes: number;
  /** Packs that ran and were measured (not dead, not thrown). */
  measuredPacks: string[];
  /** Packs registered but NOT measured (a dead convention or a throw): their silence is not a clean bill. */
  unmeasuredPacks: string[];
  /** The shape pack's coverage, when it was measured. */
  shape?: ShapeCoverage;
}

/** Cap 4 in one line, for the CLI report and the register. */
export function coverageLine(c: RunCoverage): string {
  const parts = [`${c.notes} note(s) read`, `${c.measuredPacks.length} pack(s) measured (${c.measuredPacks.join(", ") || "none"})`];
  if (c.unmeasuredPacks.length) parts.push(`NOT measured: ${c.unmeasuredPacks.join(", ")}`);
  if (c.shape) {
    parts.push(
      `shape: ${c.shape.classes} class(es), ${c.shape.uncheckedClasses} unchecked (no fence), ${c.shape.checkedNotes} typed note(s) checked, ${c.shape.unboundNotes} with a type that names no class`,
    );
  }
  return `checked: ${parts.join("; ")}`;
}
