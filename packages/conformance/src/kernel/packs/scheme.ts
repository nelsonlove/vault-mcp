// packs/scheme.ts — the scheme rule pack: adapts kernel/scheme/findings.ts's
// pure `schemeFindings` to the canonical Finding shape, one run per configured
// scheme instance.
//
// Mapping (the frozen contract): a SchemeFinding {code, path, detail} becomes
// { script: "scheme_findings", check: code, target: path, kind: "" }. The
// (code, path) pair is already unique per finding — duplicate_address emits one
// finding per extra claimant path — so no `kind` discriminant is needed. The
// finding logic lives in the module; this only re-homes the output.
//
// worker-3 authored kernel/scheme/findings.ts; this adapter is the agreed
// `--pack scheme` slot on the RulePack interface.

import { schemeFindings } from "@vault-mcp/core";
import type { SchemeInstance } from "@vault-mcp/core";
import type { Finding } from "../finding.js";
import type { RulePack, VaultSnapshot } from "../rule-pack.js";

export const SCHEME_PACK_ID = "scheme_findings";

export function schemePack(instances: SchemeInstance[]): RulePack {
  return {
    id: SCHEME_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const out: Finding[] = [];
      for (const instance of instances) {
        for (const f of schemeFindings(instance, snapshot.paths)) {
          out.push({
            script: SCHEME_PACK_ID,
            check: f.code,
            target: f.path,
            kind: "",
            detail: f.detail,
          });
        }
      }
      return out;
    },
  };
}
