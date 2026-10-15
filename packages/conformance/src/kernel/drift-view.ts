// drift-view.ts — the drift panel's cross-reference (Stage C of the
// jd-dashboard fold): which findings from a conformance run are (a) produced
// by the scheme pack and (b) NEW per the ratchet (not already-accepted
// debt), with full human-readable `detail` recovered and grouped by check —
// mirroring the original jd-dashboard drift panel's grouping by issue type
// (its own `wrong-folder`/`duplicate-id`/etc. naming doesn't survive the
// port; this groups by the current scheme pack's own `check` codes instead:
// misfiled/duplicate_address/malformed_name/unaddressed/name_colon/
// name_trailing_space — see kernel/scheme/provider.ts's SchemeFinding).
//
// `RatchetResult.newKeys` is a list of finding KEYS (the `(script, check,
// target, kind)` 4-tuple, stringified) — not full Finding objects, so it
// carries no `detail` a human could read. The cross-reference here is: build
// a key -> Finding map from the run's OWN `findings` (scoped to the scheme
// pack only), then look up each new key in that map. A newKey with no match
// (produced by some OTHER pack) is silently skipped — this view only ever
// wants the scheme pack's slice.
//
// Pure — no obsidian import, no I/O — operates on an already-computed
// conformance run (cli.ts's `runConformance` return shape: `findings` +
// `ratchet`). The live, in-process call path (matching the ALREADY-SHIPPED
// `vaultmcp_conformance_debt` tool's pattern, not a new one this fold had to
// invent) lives in the Obsidian adapter, src/obsidian-drift-source.ts.

import { findingKey, type Finding } from "./finding.js";
import type { RatchetResult } from "./ratchet.js";
import { SCHEME_PACK_ID } from "./packs/scheme.js";

export interface DriftGroup {
  /** The scheme pack's check code, e.g. "misfiled", "duplicate_address". */
  check: string;
  /** This check's new findings, busiest-... well, just deterministically
   *  ordered by target — a drift panel has no "busiest" concept the way the
   *  inbox panel's counts do; each row here IS one finding. */
  findings: Finding[];
}

/**
 * The scheme pack's NEW findings from a conformance run, grouped by check,
 * groups ordered largest-first (ties broken by check name) and each group's
 * findings ordered by target.
 */
export function newSchemeDrift(findings: Finding[], result: RatchetResult): DriftGroup[] {
  const schemeByKey = new Map<string, Finding>();
  for (const f of findings) {
    if (f.script !== SCHEME_PACK_ID) continue;
    schemeByKey.set(findingKey(f), f);
  }

  const byCheck = new Map<string, Finding[]>();
  for (const key of result.newKeys) {
    const f = schemeByKey.get(key);
    if (!f) continue; // a NEW key from some other pack — not this view's business
    const list = byCheck.get(f.check) ?? [];
    list.push(f);
    byCheck.set(f.check, list);
  }

  return [...byCheck.entries()]
    .map(([check, list]) => ({ check, findings: [...list].sort((a, b) => a.target.localeCompare(b.target)) }))
    .sort((a, b) => b.findings.length - a.findings.length || a.check.localeCompare(b.check));
}
