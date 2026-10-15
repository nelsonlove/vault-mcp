// findings.ts — the pure conformance findings core. NOT a registered tool:
// this is the rule-pack core a later task wraps as a read-only rail tool.
// Kernel-module rules apply: no "obsidian" import, no I/O, everything pure
// over a supplied `notes: string[]` vault listing.
//
// Every rule's judgment comes from the provider instance — no new hardwired
// semantic constants (Nelson's config-not-hardwired ruling). This module
// only sequences four provider-delegated checks and sorts the result.

import type { Address, SchemeFinding, ScopeProvider } from "./provider.js";
import { excludeRoots, type SchemeInstance } from "./registry.js";

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function folderOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/** `expectedFolder`'s result depends only on `addr`'s container token
 * (`addr.levels[addr.levels.length - 2]`), never on the rest of `addr` or on
 * which note is asking — but jd.ts's implementation reruns a fresh linear
 * scan of `notes` on every call (~370ms for one call on a ~1260-note vault,
 * benchmarked). `schemeFindings` calls it once per addressed note, so an
 * unmemoized listing is O(n^2) in vault size. Memoize HERE, keyed on the
 * container token, rather than in jd.ts — jd.ts's contract is "pure per
 * call", and caching inside it would either leak across calls with
 * different `notes` listings or require a cache-invalidation story the
 * provider interface doesn't have. Scoped to one `schemeFindings` call: a
 * fresh cache per invocation, never carried across calls or vaults. */
function makeExpectedFolderCache(provider: ScopeProvider, notes: string[]) {
  const cache = new Map<string, string | null>();
  return (addr: Address): string | null => {
    if (addr.levels.length < 2) return provider.expectedFolder(addr, notes);
    const token = addr.levels[addr.levels.length - 2];
    if (cache.has(token)) return cache.get(token) ?? null;
    const result = provider.expectedFolder(addr, notes);
    cache.set(token, result);
    return result;
  };
}

/**
 * Conformance findings over `notes`, per `instance`'s provider. Four rule
 * classes, each delegating its judgment to the provider:
 *
 *   - malformed_name / name_colon / name_trailing_space:
 *     `provider.validateName(basename)` per note — findings from a note in
 *     isolation, no vault context needed. Runs first because malformed_name
 *     decides whether a note's addressOf-null-ness is a BROKEN address attempt
 *     (malformed_name) or no attempt at all (unaddressed, below): those two
 *     are mutually exclusive per note, keyed on malformed_name SPECIFICALLY
 *     (the provider's numeric-looking-token heuristic), not on validateName
 *     returning anything. The name-hygiene findings (name_colon /
 *     name_trailing_space — ported from obsidian-jd-numbering's checkNote) are
 *     orthogonal to the address token and do NOT suppress unaddressed: a note
 *     can be both unaddressed and carry a trailing space.
 *   - unaddressed: `scopeOf(path)` non-null, `addressOf(path)` null, and not
 *     already malformed_name. Scratch/index conventions are NOT
 *     special-cased in v1 — the rail's ratchet baselines them.
 *   - duplicate_address: two+ notes whose `format(addressOf(path))` match —
 *     one finding per EXTRA path, in listing order; the detail names the
 *     FIRST claimant (recorded once, never overwritten), which is itself
 *     never flagged.
 *   - misfiled: an addressed note whose actual folder differs from
 *     `expectedFolder(addr, notes)`, when that is derivable (non-null).
 *
 * Output is sorted by path, then by code, for a deterministic listing.
 *
 * `instance.excludedRoots` is applied to `notes` FIRST, before any rule runs
 * — an excluded note is invisible to every rule class, not just the ones
 * whose semantics happen to mention it: it cannot be the "first claimant" a
 * later duplicate_address finding blames, cannot itself be flagged
 * misfiled/malformed_name/unaddressed, and cannot establish an
 * `expectedFolder` for some other address's container. `excludeRoots`
 * returns `notes` itself (same array) when `excludedRoots` is absent/empty,
 * so the no-exclusion path is byte-identical to before this filter existed.
 */
export function schemeFindings(instance: SchemeInstance, notes: string[]): SchemeFinding[] {
  const provider = instance.provider;
  const visible = excludeRoots(notes, instance.excludedRoots);
  const findings: SchemeFinding[] = [];
  const firstClaimant = new Map<string, string>(); // formatted address -> first path to claim it
  const expectedFolderOf = makeExpectedFolderCache(provider, visible);

  for (const path of visible) {
    const nameFindings = provider.validateName(basenameOf(path)).map((f) => ({ ...f, path }));
    findings.push(...nameFindings);

    const addr = provider.addressOf(path);

    if (addr === null) {
      // Gate `unaddressed` on the ADDRESS-attempt verdict specifically
      // (`malformed_name`), not on `validateName` returning ANYTHING: a
      // name-hygiene finding (`name_colon` / `name_trailing_space`) is
      // orthogonal to whether the name attempted an address, so it must not
      // suppress `unaddressed` the way a broken address attempt does. A note
      // that both fails to carry an address AND (say) has a trailing space is
      // legitimately both `unaddressed` and `name_trailing_space`.
      const attemptedAddress = nameFindings.some((f) => f.code === "malformed_name");
      if (!attemptedAddress) {
        const scope = provider.scopeOf(path);
        if (scope !== null) {
          findings.push({
            code: "unaddressed",
            path,
            detail: `lives in scope ${scope.kind} '${scope.token}' but has no recognizable address`,
          });
        }
      }
      continue;
    }

    const addrStr = provider.format(addr);
    const first = firstClaimant.get(addrStr);
    if (first === undefined) {
      firstClaimant.set(addrStr, path);
    } else {
      findings.push({
        code: "duplicate_address",
        path,
        detail: `address '${addrStr}' is already claimed by '${first}'`,
      });
    }

    const expected = expectedFolderOf(addr);
    const actual = folderOf(path);
    if (expected !== null && expected !== actual) {
      findings.push({
        code: "misfiled",
        path,
        detail: `expected folder '${expected}', found in '${actual}'`,
      });
    }
  }

  findings.sort((a, b) => (a.path === b.path ? a.code.localeCompare(b.code) : a.path.localeCompare(b.path)));
  return findings;
}
