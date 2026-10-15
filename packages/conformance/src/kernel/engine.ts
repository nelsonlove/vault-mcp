// engine.ts — runs the configured rule packs over a vault snapshot and returns
// the collected findings, sorted by key for a deterministic listing.
//
// A pack that THROWS does not abort the run — its crash surfaces as a
// `conformance_engine / pack_error` finding (target = the pack id) so a broken
// pack is VISIBLE in the report rather than silently reading as "zero
// findings" (the same discipline the Python rail's per-script sentinels
// enforce). Every other pack still runs.

import { findingKey, type Finding } from "./finding.js";
import type { RulePack, VaultSnapshot } from "./rule-pack.js";

export const ENGINE_ID = "conformance_engine";

export function runEngine(packs: RulePack[], snapshot: VaultSnapshot): Finding[] {
  const findings: Finding[] = [];
  for (const pack of packs) {
    try {
      findings.push(...pack.run(snapshot));
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      findings.push({
        script: ENGINE_ID,
        check: "pack_error",
        target: pack.id,
        kind: "",
        detail: `rule pack '${pack.id}' threw: ${detail}`,
      });
    }
  }
  // Defense in depth. `findingKey` is now TOTAL — it escapes the `|` separator
  // rather than throwing (finding.ts, issue #136 item 3) — but the sort is the
  // one keying call OUTSIDE the per-pack guard above, so a hypothetically
  // un-keyable finding must degrade to a VISIBLE `pack_error` rather than crash
  // the whole run. Key each finding defensively; anything that still cannot be
  // keyed is replaced with a keyable engine `pack_error` (an un-keyable finding
  // has no ratchet identity anyway, so surfacing the failure is the correct
  // degradation). With the escape in place this branch is unreachable.
  const keyed = findings.map((f): { f: Finding; key: string } => {
    try {
      return { f, key: findingKey(f) };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const err: Finding = {
        script: ENGINE_ID,
        check: "pack_error",
        target: f.script || "unknown",
        kind: "",
        detail: `a finding from '${f.script}' could not be keyed: ${detail}`,
      };
      return { f: err, key: findingKey(err) };
    }
  });
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed.map((k) => k.f);
}
