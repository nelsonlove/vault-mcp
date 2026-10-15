// rule-pack.ts — the RulePack contract and the vault snapshot packs run over.
//
// A rule pack is a named producer of Findings over a supplied snapshot — the
// same "rail feeds a listing, pack returns typed findings" contract the module
// findings functions already honor (they are pure over an injected listing).
// The module adapters (packs/) wrap `noteVocabFindings` / `schemeFindings`;
// the ported legacy checks (phase 2) implement `run` directly. No pack reads
// the vault itself — the engine injects the snapshot.

import type { Finding } from "./finding.js";
import type { VocabNote } from "@vault-mcp/core";

/** A raw source file: its vault-relative path and its full text (frontmatter
 * included), universal-newline-normalized (CRLF/CR → LF) to match Python's
 * `Path.read_text`. The ported legacy packs (structure/port/ste) scan raw text
 * line-by-line and apply the SAME regexes the Python scripts did, so they take
 * raw sources rather than the parsed `notes` listing. */
export interface SourceFile {
  path: string;
  text: string;
}

/** The read-only vault state a run sees. Built once by the engine's snapshot
 * layer (snapshot.ts, headless disk read) and shared by every pack. */
export interface VaultSnapshot {
  /** Every in-scope note with the frontmatter/body its consumers need
   * (vocab pack). */
  notes: VocabNote[];
  /** Guarded territories the walk met INSIDE the root and did not descend into
   * (#398) — recorded so the run can report them and refuse over stranded
   * baseline keys. Optional so a hand-built snapshot still satisfies the type;
   * absent reads as none skipped. */
  skippedTerritories?: { path: string; territory: string }[];
  /** Every in-scope note path (the scheme pack's listing). */
  paths: string[];
  /** Every in-scope `.md` note's raw text (structure/port/ste/drift packs).
   * Optional so a hand-built `{notes, paths}` snapshot (tests, other packs)
   * still satisfies the type. A pack that NEEDS it must reach it through
   * `requireSources` — see the absent-vs-empty note there. */
  sources?: SourceFile[];
  /** Every `.blueprint` file's raw text (the structure pack's blueprint
   * sources — emitted-H2 derivation + `{% include %}` resolution). Optional
   * for the same reason; reach it through `requireBlueprints`. */
  blueprints?: SourceFile[];
  /** Every FILE path under root (all extensions, not just note types),
   * skip-dirs and `excludedRoots` pruned, matching the walk. No pack reads it
   * since #412 retired drift's surface-existence check; it travels with
   * `dirs` into the dead-convention check, which takes the walk's two
   * listings together. Optional so a hand-built snapshot is unaffected. */
  files?: string[];
  /** Every DIRECTORY path under root (skip-dirs/`excludedRoots` pruned), for
   * the drift pack's category-collision scan (J, which enumerates the system
   * spine's direct children) and the dead-convention check. Optional. */
  dirs?: string[];
  /** Every collected `.md` note path in Python-`rglob` TRAVERSAL ORDER (raw
   * directory order, a directory's files before its subdirectories, pre-order
   * DFS) — NOT sorted. The drift pack's duplicate-uid check (E) embeds a
   * traversal-ordered homes list in its finding MESSAGE (`detail`), so it
   * must iterate the exact order `drift_audit.py`'s `iter_notes` did to stay
   * message-parity with the Python rail. The traversal order does NOT feed
   * E's finding KEY — that key is deliberately count/order-independent (issue
   * #136) — but it still governs `detail` and must match. Every other pack
   * (and drift's J) is order-independent and reads the sorted listings above.
   * Optional. */
  walkOrder?: string[];
}

export interface RulePack {
  /** Stable id — becomes the `script` field of every finding this pack emits,
   * and the ratchet key prefix. */
  readonly id: string;
  run(snapshot: VaultSnapshot): Finding[];
}

// ── absent vs empty ──────────────────────────────────────────────────────────
//
// `sources` and `blueprints` are optional on the snapshot so a hand-built
// `{notes, paths}` still typechecks. A pack that needs one of them must not
// write `snapshot.sources ?? []`: that silently converts "nobody supplied this
// listing" into "this vault contains no source files", so the pack reports zero
// findings and the ratchet then reports every one of its accepted keys as
// CLEARED — a clean bill of health produced by a missing input (#125).
//
// `[]` is a real answer and keeps working. `undefined` is the ABSENCE of an
// answer and throws, which the engine surfaces as a `conformance_engine /
// pack_error` finding naming the pack — visible and non-zero, the same
// discipline the engine already applies to a pack that crashes.
//
// This is the fourth site of this class in this codebase: a missing baseline
// read as an empty baseline (#133), an absent quickadd `data.json` reported as
// CONFORMING (#136), an unparseable frontmatter block read as no frontmatter
// (#104's residual), and this. Absence and emptiness are never the same answer.

function requireListing(
  listing: SourceFile[] | undefined,
  packId: string,
  which: "sources" | "blueprints",
): SourceFile[] {
  if (listing === undefined) {
    throw new Error(
      `rule pack '${packId}' needs the snapshot's '${which}' listing, which is absent. ` +
        `Refusing to treat a missing listing as an empty one: this pack would report zero findings ` +
        `and every accepted key it owns would then read as CLEARED. Build the snapshot with '${which}' ` +
        `(buildSnapshot supplies it), or pass an explicit [] if the vault genuinely has none.`,
    );
  }
  return listing;
}

/**
 * A snapshot listing of ANY element type, refusing when ABSENT (not merely
 * empty). Generic because the class has five recorded members: a missing
 * baseline read as empty (#133), an absent quickadd config reported as
 * CONFORMING (#136), unparseable frontmatter read as no frontmatter (#104's
 * residual), absent `sources` (#125), and the `files`/`dirs`/`walkOrder`
 * fields closed here (`obsidianConfig` was a fifth until #412 retired the
 * drift checks that read it, and the listing with them). Each cost an investigation; a shared helper
 * is what stops a sixth being written by copying the old idiom.
 */
export function requireListing_<T>(listing: T[] | undefined, packId: string, which: string): T[] {
  if (listing === undefined) {
    throw new Error(
      `rule pack '${packId}' needs the snapshot's '${which}' listing, which is absent. ` +
        `Refusing to treat a missing listing as an empty one: this pack would report zero findings ` +
        `and every accepted key it owns would then read as CLEARED. Build the snapshot with '${which}' ` +
        `(buildSnapshot supplies it), or pass an explicit [] if the vault genuinely has none.`,
    );
  }
  return listing;
}

/** The snapshot's raw `.md` sources, refusing when the listing is ABSENT (not merely empty). */
export function requireSources(snapshot: VaultSnapshot, packId: string): SourceFile[] {
  return requireListing(snapshot.sources, packId, "sources");
}

/** The snapshot's `.blueprint` sources, refusing when the listing is ABSENT (not merely empty). */
export function requireBlueprints(snapshot: VaultSnapshot, packId: string): SourceFile[] {
  return requireListing(snapshot.blueprints, packId, "blueprints");
}
