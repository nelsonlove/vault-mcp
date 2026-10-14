// kernel/survey/boundary.ts — containment check for a survey mirror
// directory, added in response to code review on this module's first cut.
//
// The first cut passed `mirror_root` (a caller-supplied argument) and a
// note's own `survey-mirror` frontmatter override straight to `fs.statSync`/
// `fs.readdirSync` with no check at all: neither is a vault path, so
// guard.ts's PATH_KEYS allowlist never sees either one, and there was
// nothing else guarding them. A note's `survey-mirror: ~/.ssh` would have
// made obsidian_survey_status enumerate it.
//
// This repo already solved the identical problem once, for
// the conformance satellite's snapshot.ts (packages/conformance/src/kernel/) caller-named `root` (issue #157, commit
// e4efe59) — three checks, in this order: the root's real path must be
// resolvable at all; it must not fall inside a permanently denied
// territory, UNCONDITIONALLY, even when explicitly requested; and it must
// resolve inside a boundary that is DECLARED, never defaulted. Reused here
// via the same pure `intendedRealPath`/`isInside` pair (in @vault-mcp/core) snapshot.ts uses (no
// second implementation of "is this path really inside that one" — a
// symlink is exactly what a second, naive implementation would miss), with
// survey's own deny-list (there is no reason a filesystem mirror should
// ever resolve into a dotfile-hidden directory or the OS's own private
// trees) rather than snapshot.ts's vault-specific one.

import { sep } from "node:path";
import { intendedRealPath, isInside } from "@vault-mcp/core";
import { envAliased } from "../../env-alias.js";

// Dotfile/dot-directory segments only — matches walk()'s own ignore rule, so
// a mirror root can't resolve through something the walk would then silently
// skip the contents of anyway. Deliberately NOT a broader OS-path deny-list
// (an earlier draft denied "Library"/"private"/"System" by segment name and
// broke on its own test fixtures: macOS resolves the real tmpdir through
// /private/var/..., so that list would have refused every temp-directory
// mirror root, not just genuine system trees). The boundary check below is
// what does the real work; this only closes the same dotfile gap walk()
// already closes for its own traversal.
const DENIED_SEGMENT_RE = /^\./;

function deniedTerritory(realPath: string): string | null {
  for (const seg of realPath.split(sep)) {
    if (!seg) continue;
    if (DENIED_SEGMENT_RE.test(seg)) return seg;
  }
  return null;
}

/** The declared boundary a mirror root must resolve inside. Reuses the same
 *  env vars the conformance satellite's snapshot.ts declares its own boundary with — one
 *  vault-wide "where real content lives" declaration, not a second one
 *  invented for this module. NO fallback: absence is a refusal, decided by
 *  the caller, not a default guessed here. */
function declaredBoundary(): string | null {
  return (
    envAliased(process.env, "CONTENT_ROOT") ?? envAliased(process.env, "VAULT_ROOT") ?? null
  );
}

export type BoundaryRefusal =
  | { code: "unresolvable"; path: string }
  | { code: "denied_territory"; path: string; territory: string }
  | { code: "no_boundary_declared" }
  | { code: "boundary_unresolvable"; boundary: string }
  | { code: "outside_boundary"; path: string };

/**
 * Checks `candidate` (a mirror directory, already joined from mirror_root
 * and a note's vault-relative folder — or a survey-mirror override) against
 * the three rules above, in order. Returns null when permitted, or a typed
 * refusal reason when not — never throws, so callers can render it as a
 * `codedError` rather than a generic `fail()`.
 */
export function checkMirrorBoundary(candidate: string): BoundaryRefusal | null {
  const real = intendedRealPath(candidate);
  if (real === null) return { code: "unresolvable", path: candidate };

  const territory = deniedTerritory(real);
  if (territory) return { code: "denied_territory", path: candidate, territory };

  const boundary = declaredBoundary();
  if (!boundary) return { code: "no_boundary_declared" };

  const realBoundary = intendedRealPath(boundary);
  if (realBoundary === null) return { code: "boundary_unresolvable", boundary };

  if (!isInside(realBoundary, real)) return { code: "outside_boundary", path: candidate };

  return null;
}

/** Render a BoundaryRefusal as human text, for a codedError message. */
export function boundaryRefusalMessage(r: BoundaryRefusal): string {
  switch (r.code) {
    case "unresolvable":
      return `"${r.path}" could not be resolved to a real path (unreadable ancestor or a symlink loop).`;
    case "denied_territory":
      return `"${r.path}" resolves through a denied path segment ("${r.territory}").`;
    case "no_boundary_declared":
      return "no content-root boundary declared — set GOVERNOR_CONTENT_ROOT (or GOVERNOR_VAULT_ROOT; legacy ASSENT_* spellings accepted).";
    case "boundary_unresolvable":
      return `the declared boundary "${r.boundary}" could not be resolved.`;
    case "outside_boundary":
      return `"${r.path}" resolves outside the declared content-root boundary.`;
  }
}
