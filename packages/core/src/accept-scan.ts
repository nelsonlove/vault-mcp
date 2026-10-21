// accept-scan.ts — `scanForAcceptFence`: does a document about to be written
// assert acceptance anywhere in it?
//
// PUBLISHED AT S8 (the mutating tier's extraction), moved VERBATIM out of the
// host's `src/mcp/tools-cli.ts`. It had two callers there — the `obsidian_cli`
// template/content guard and the jd-scaffold module's `applyTemplate` — and
// after S8 those two callers live in DIFFERENT PLUGINS (the host's CLI proxy
// and the `vaultmcp-jd-scaffold` satellite). That is exactly the shape the
// vocabulary kernel had at S7, and it has the same forbidden answer: two copies
// of an accept predicate is how one vault gets two definitions of "accepted".
// The host imports it from here and re-exports it, so no host call site or test
// moved.
//
// The move is behaviour-preserving BY CONSTRUCTION rather than by inspection:
// every symbol this predicate is defined over — `leadingFrontmatterBlock`,
// `stripLeadingBom`, `acceptForbiddenReason`, `declaredProtectedProperties`,
// `canonicalPropertyKey` — was ALREADY core's. The host reached them through
// `mcp/write-notes-compose.ts`, which is itself a bare re-export of core's
// accept-guard. So this file computes over the same functions the host's copy
// did, not over a parallel definition.

import {
  acceptForbiddenReason,
  canonicalPropertyKey,
  duplicateFrontmatterKeyReason,
  declaredProtectedProperties,
  leadingFrontmatterBlock,
  stripLeadingBom,
} from "./accept-guard.js";

/**
 * Two checks, deliberately different in kind:
 *
 *  1. **The leading fence** — decided by `leadingFrontmatterBlock`, the SAME
 *     recognizer the write path uses, applied to the SAME BYTES the vault will
 *     honor. Parity is structural here, not a matter of two normalizations
 *     happening to agree: #126 was a BOM asymmetry, and scanning a
 *     CRLF-folded copy re-opened the identical class on `\r` (a lone CR inside
 *     a scalar is content to the write path, a line break to a folded scan).
 *     Deciding over the raw document removes the whole class rather than its
 *     latest instance.
 *  2. **Embedded fences** — a deliberately BROADER, conservative sweep over a
 *     line-ending-folded copy. `append` content is not a note's leading
 *     frontmatter, and the resulting note cannot be read pre-exec, so an
 *     acceptance-asserting block anywhere in written content is refused.
 *     Broader than the write path is fine; narrower is the bypass.
 */
export function scanForAcceptFence(honored: string, parseYaml?: (yaml: string) => unknown): string | null {
  const leading = leadingFrontmatterBlock(honored);
  if (leading !== null) {
    const reason = acceptReasonForBlock(leading, parseYaml);
    if (reason) return reason;
    // #605: a repeated key at the root or inside a `verified` record, judged by
    // the guard's own reader whatever the injected parser does with it.
    const dup = duplicateFrontmatterKeyReason(honored);
    if (dup) return dup;
  }
  const folded = stripLeadingBom(honored).replace(/\r\n?/g, "\n");
  // The closer is prefix-matched, exactly as the shared recognizer now does
  // (a line whose first three bytes are `---` closes the block, whatever
  // follows). This sweep is contractually the BROADER of the two — narrower is
  // the bypass — so leaving it on the old `---`-alone-on-its-line closer while
  // the leading recognizer widened would have inverted its own contract.
  // Refusal still requires an acceptance assertion INSIDE the block, so a
  // wider notion of "block" costs nothing on ordinary content.
  const fenceRe = /(?:^|\n)---[ \t]*\n([\s\S]*?)\n---/g;
  let m: RegExpExecArray | null;
  let sawFence = leading !== null;
  while ((m = fenceRe.exec(folded)) !== null) {
    sawFence = true;
    const reason = acceptReasonForBlock(m[1], parseYaml);
    if (reason) return reason;
  }
  return sawFence && !parseYaml
    ? "carries a frontmatter fence that cannot be verified without a YAML parser"
    : null;
}

/**
 * Does one YAML block assert acceptance? Shared by both checks above so they
 * cannot disagree about a block's meaning either — the same reasoning that
 * put the boundary itself in one place.
 *
 * With no parser injected the caller fails closed on the presence of any fence
 * (defensive; production always injects obsidian.parseYaml). A block a real
 * parser cannot read cannot be judged structurally, so one that mentions the
 * acceptance field textually is treated as suspect rather than let through.
 */
function acceptReasonForBlock(block: string, parseYaml?: (yaml: string) => unknown): string | null {
  if (!parseYaml) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    if (/acceptance[-_]status/i.test(block) && /\baccepted\b|accepted[-_]/i.test(block)) {
      return "carries an accepted acceptance-status fence";
    }
    // The live verification key (#406): a block real YAML rejects that mentions
    // `verified` anywhere is suspect, not let through — the same UNANCHORED
    // substring treatment as the declared properties below, so a quoted key
    // (`"verified": [`) or a flow form cannot slip it (the #143 quoted-key
    // requirement). Broader than the structural path is the contract here.
    // Not `\b`: an underscore is a word character, so `\bverified\b` would miss
    // `verified_by`. Bounded by "no letter or digit on either side" instead, which
    // keeps `verified_by`, `verified-on` and `"verified"` in, `unverified` and `verifier` out.
    if (/(^|[^a-z0-9])verified(?![a-z0-9])/i.test(block)) {
      return "carries a fence mentioning the verification field 'verified'";
    }
    // Same suspect-not-through treatment for the declared protected properties
    // (#224): a block real YAML rejects cannot be judged structurally, so one
    // that mentions a declared key textually (either separator form) refuses
    // rather than slipping the perimeter on a parse error.
    for (const prop of declaredProtectedProperties()) {
      const k = canonicalPropertyKey(prop.key);
      const pat = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[-_]"), "i");
      if (pat.test(block)) return `carries a fence mentioning the protected property '${prop.key}'`;
    }
    return null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return acceptForbiddenReason(parsed as Record<string, unknown>);
  }
  return null;
}
