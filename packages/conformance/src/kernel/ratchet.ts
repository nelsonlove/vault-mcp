// ratchet.ts — the accepted-debt ratchet, reproducing conformance_ratchet.py's
// contract in TypeScript.
//
//   NEW     = live − baseline   → the run FAILS (exit 1) iff non-empty. Real
//                                 regressions: a finding not previously accepted.
//   CLEARED = baseline − live   → never fails; `--rebaseline` shrinks the
//                                 baseline to drop these.
//   CARRIED = live ∩ baseline   → the accepted backlog. Counted, never listed.
//
// The keyset is the 4-tuple `findingKey` (finding.ts). The baseline is a
// governed vault note carrying a ` ```ratchet-baseline ` fenced block of key
// lines; `parseBaseline` reads it and `renderBaseline` emits it (sorted), both
// byte-compatible with the existing `Conformance baseline.md`, so the current
// accepted debt carries over unchanged.

import { findingKey, type Finding } from "./finding.js";

const FENCE_OPEN = "```ratchet-baseline";
const FENCE_CLOSE = "```";

/** The set of accepted-debt keys from a baseline note's fenced block. A note
 * with no fence yields an empty set (a fresh baseline), never an error. */
export function parseBaseline(noteText: string): Set<string> {
  const keys = new Set<string>();
  const lines = noteText.split("\n");
  let inFence = false;
  for (const line of lines) {
    if (!inFence) {
      if (line.trim() === FENCE_OPEN) inFence = true;
      continue;
    }
    if (line.trim() === FENCE_CLOSE) break;
    const key = line.trim();
    if (key) keys.add(key);
  }
  return keys;
}

/** The fenced-block BODY (no fence markers) for a set of findings: their keys,
 * de-duplicated and sorted, one per line. Deterministic — a function of the
 * findings, not their order. */
export function renderBaseline(findings: Finding[]): string {
  const keys = [...new Set(findings.map(findingKey))].sort();
  return keys.join("\n");
}

export interface RatchetResult {
  /** Live keys not in the baseline — regressions. */
  newKeys: string[];
  /** Baseline keys not in the live run — resolved (or moved). */
  clearedKeys: string[];
  /** Count of live keys also in the baseline — the accepted backlog. */
  carried: number;
  /** True iff there are NEW findings. */
  failed: boolean;
  /** 1 iff failed, else 0 — the rail's gate contract. */
  exitCode: 0 | 1;
}

/** Diff a live run against the accepted-debt baseline. */
export function ratchet(live: Finding[], baseline: Set<string>): RatchetResult {
  const liveKeys = new Set(live.map(findingKey));
  const newKeys: string[] = [];
  let carried = 0;
  for (const k of liveKeys) {
    if (baseline.has(k)) carried++;
    else newKeys.push(k);
  }
  const clearedKeys: string[] = [];
  for (const k of baseline) if (!liveKeys.has(k)) clearedKeys.push(k);
  newKeys.sort();
  clearedKeys.sort();
  const failed = newKeys.length > 0;
  return { newKeys, clearedKeys, carried, failed, exitCode: failed ? 1 : 0 };
}
