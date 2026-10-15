// packs/vocab.ts — the vocab rule pack: adapts the vocabulary kernel's pure
// `noteVocabFindings` to the canonical Finding shape.
//
// The kernel it wraps moved to `@vault-mcp/core` at the read-tier satellite
// extraction (suite split, S7). This pack is why: it is the SECOND consumer of
// the vocabulary rule core, and it stayed in the host while the four vocabulary
// TOOLS left for the `vaultmcp-vocab` satellite. Two consumers in two plugins is
// exactly the `queryBaseRows` shape, and it has the same forbidden answer —
// two copies of a rule core is how one vault gets two vocabularies — so the
// kernel was published rather than copied or stranded. (The pack then left the
// host with the rest of the rail, for the vaultmcp-conformance satellite, on
// 2026-10-14; the kernel stays in core with its two consumers.)
//
// Mapping (the frozen contract): a VocabFinding {code, token, path, detail}
// becomes { script: "vocab_findings", check: code, target: path, kind: token }.
// The token's CASE IS PRESERVED in the key: two distinct-case tokens on one
// note are distinct findings, so lower-casing them would collapse them to one
// ratchet key and could mask a genuinely-new violation (a ratchet must never
// silently drop a regression — false-NEW churn is safer than false-CARRIED).
// The finding logic is NOT re-implemented here — this only re-homes the output.
//
// Source-level findings (`vocabularyFindings`: the scope-tags table lint and
// `scope_root_missing`) run ONCE per pass, before the per-note ones, so a dead
// root scope note is loud here rather than silently switching scoping off
// (#551 review). A finding with no path targets its token (the root path).

import { noteVocabFindings, vocabularyFindings, type VocabFinding, type VocabularyProvider } from "@vault-mcp/core";
import type { Finding } from "../finding.js";
import type { RulePack, VaultSnapshot } from "../rule-pack.js";

export const VOCAB_PACK_ID = "vocab_findings";

export function vocabPack(providers: VocabularyProvider[]): RulePack {
  return {
    id: VOCAB_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const toFinding = (f: VocabFinding): Finding => ({
        script: VOCAB_PACK_ID,
        check: f.code,
        target: f.path ?? f.token,
        kind: f.token,
        detail: f.detail,
      });
      const out: Finding[] = vocabularyFindings(providers).map(toFinding);
      for (const note of snapshot.notes) {
        for (const f of noteVocabFindings({ path: note.path, frontmatter: note.frontmatter ?? null }, providers)) {
          out.push(toFinding(f));
        }
      }
      return out;
    },
  };
}
