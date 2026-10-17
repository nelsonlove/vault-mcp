// tools-survey.ts — the survey module's tool surface: two tools over the
// pure kernel/survey/* core.
//
//   obsidian_survey_status — staleness of a note's filesystem-mirror slot (read-only)
//   obsidian_survey_slot   — regenerate the "## Contents (Filesystem)" section;
//                            dry_run true (mandatory, no default) previews, false persists (MUTATING)
//
// Folded in from the standalone `obsidian-jd-survey` plugin (2026-08-19),
// scoped down: this v1 assumes the mirror directory is the SAME relative path
// under a configured `mirror_root` as the note's own vault-relative folder —
// deliberately simpler than coupling to kernel/scheme's JD area/category
// model, and per-note `survey-mirror` frontmatter overrides that default when
// it's wrong (see resolveMirrorDir below). "Assume a mirrored filesystem" was
// the explicit brief; tighter scheme-coupling was considered and dropped as
// unneeded complexity for that brief.
//
// Registers directly in server.ts rather than through modules-mount.ts: that
// host's `registerAll` gate refuses a non-readOnlyHint tool UNLESS its module
// opts in via `mutating: true` (provenance, fileclass and jd-scaffold took
// that path until the mutating tier of the suite split extracted all three
// into their own plugins; no module declares it today). Direct registration,
// same shape registerSchemeWriteTools already uses immediately above this
// call in server.ts, was chosen instead for this v1 rather than building the
// module-host config surface; not because the mutating-module path is
// unavailable.
//
// Two fixes from this module's first-cut code review, both load-bearing:
//
//   - mirror_root / survey-mirror name a REAL FILESYSTEM PATH, which
//     guard.ts's PATH_KEYS allowlist never sees (it only knows vault-relative
//     paths). The first cut passed both straight to fs.statSync/readdirSync
//     with no check at all. kernel/survey/boundary.ts closes this the same
//     way the conformance rail's snapshot.ts (packages/conformance) closed the identical hole once
//     (issue #157) — checked before every filesystem read here, not just at
//     the top of the request.
//   - obsidian_survey_slot wrote via raw app.vault.process /
//     app.fileManager.processFrontMatter, bypassing the accept-guard
//     predicate every other write path in this codebase routes through — the
//     same gap #203 found and fixed on obsidian_append_at_heading, and #236
//     generalized across every transport. Fixed by reusing
//     tools-complementary.ts's guardAppendResult on the resulting content
//     before it's written, rather than defining a second "accepted" check.
//
// Prose generation is deliberately NOT called from here — see
// kernel/survey/ask-claude.ts's header for why (the write-queue's 30s budget
// vs. a real Claude Code round trip). obsidian_survey_slot takes an optional
// pre-written `snapshot_body`; a caller (a skill, a future bulk command) that
// wants generated prose calls askClaude() itself, outside this guarded,
// time-bounded write path, and passes the result in as plain text.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile } from "obsidian";
import * as fs from "node:fs";
import { ok, fail, codedError } from "./helpers.js";
import { visiblePaths, type GuardSettings } from "../guard.js";
import { guardAppendResult } from "./tools-complementary.js";
import { AcceptForbiddenError } from "@vault-mcp/core";
import { walk, type DirEntry } from "../kernel/survey/walk.js";
import { staleness, type SurveyStamp } from "../kernel/survey/staleness.js";
import { planSection } from "../kernel/survey/section.js";
import { checkMirrorBoundary, boundaryRefusalMessage } from "../kernel/survey/boundary.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export interface SurveyToolsCtx {
  getSettings?: () => GuardSettings;
}

/** Production DirLister: real fs, `withFileTypes` so isDirectory is free. */
function realList(path: string): DirEntry[] {
  return fs.readdirSync(path, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
}

/** The mirror directory for `notePath`, honoring a `survey-mirror`
 *  frontmatter override before falling back to the same-relative-path
 *  default — using the note's actual parent folder (TFile.parent), not a
 *  regex over the path string, so a root-level note (no folder) correctly
 *  resolves to `mirror_root` itself rather than `mirror_root/<filename>`.
 *  Returns a coded refusal, an existing directory, or "not_found". */
type MirrorResolution =
  | { kind: "ok"; dir: string }
  | { kind: "refused"; code: string; message: string }
  | { kind: "not_found" };

function resolveMirrorDir(app: App, file: TFile, mirrorRoot: string): MirrorResolution {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  const override = fm?.["survey-mirror"];
  const folder = file.parent?.path ?? "";
  const candidate = typeof override === "string" && override.trim() ? override.trim() : folder ? `${mirrorRoot}/${folder}` : mirrorRoot;

  const rootRefusal = checkMirrorBoundary(mirrorRoot);
  if (rootRefusal) return { kind: "refused", code: "mirror_root_refused", message: boundaryRefusalMessage(rootRefusal) };
  const candidateRefusal = checkMirrorBoundary(candidate);
  if (candidateRefusal) return { kind: "refused", code: "mirror_dir_refused", message: boundaryRefusalMessage(candidateRefusal) };

  try {
    return fs.statSync(candidate).isDirectory() ? { kind: "ok", dir: candidate } : { kind: "not_found" };
  } catch {
    return { kind: "not_found" };
  }
}

export function registerSurveyTools(server: McpServer, app: App, ctx: SurveyToolsCtx): void {
  const visible = (paths: string[]): string[] => visiblePaths(paths, ctx.getSettings?.());
  const outOfAllowlist = (path: string) => codedError("out_of_allowlist", `"${path}" is not visible to this session.`);
  const notMd = (path: string) => (path.endsWith(".md") ? null : fail(new Error("path must end in .md")));

  server.registerTool(
    "obsidian_survey_status",
    {
      title: "Check staleness of a note's filesystem-mirror survey",
      description:
        "Walk the filesystem directory a note's `## Contents (Filesystem)` section is meant to summarize, and " +
        "report whether that section is stale relative to what's actually there now. Read-only — does not touch " +
        "the note or the mirror directory. The mirror directory defaults to the same relative path under " +
        "`mirror_root` as the note's own vault folder; a note's own `survey-mirror` frontmatter overrides that " +
        "when the mirror doesn't follow the default layout. Both are checked against a declared content-root " +
        "boundary (GOVERNOR_CONTENT_ROOT / GOVERNOR_VAULT_ROOT; legacy ASSENT_* accepted) before anything is read.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path (ending in .md) of the note to check."),
        mirror_root: z.string().min(1).describe("Absolute filesystem path the vault's folder tree is mirrored under."),
        depth: z.number().int().min(0).max(6).default(1).describe("How many directory levels deep to count, 0 = immediate children only."),
      },
      annotations: RO,
    },
    async ({ path, mirror_root, depth }) => {
      try {
        const mdError = notMd(path);
        if (mdError) return mdError;
        if (visible([path]).length === 0) return outOfAllowlist(path);

        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return codedError("not_found", `"${path}" does not exist.`);

        const resolved = resolveMirrorDir(app, file, mirror_root);
        if (resolved.kind === "refused") return codedError(resolved.code, resolved.message);
        if (resolved.kind === "not_found") return codedError("mirror_not_found", `No mirror directory found for "${path}" under "${mirror_root}".`);

        const result = walk(resolved.dir, depth, realList);
        const stamp = app.metadataCache.getFileCache(file)?.frontmatter?.survey as SurveyStamp | undefined;
        const stale = staleness(result, depth, stamp);

        return ok({ mirror_dir: resolved.dir, items: result.items, stubs: result.stubs, depth_reached: result.depthReached, ...stale });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_survey_slot",
    {
      title: "Regenerate a note's Contents (Filesystem) section from its mirror directory",
      description:
        "Walk the note's filesystem-mirror directory and write (or refresh) its `## Contents (Filesystem)` " +
        "section, stamping `survey:` frontmatter (`at`, `items`, `depth`, `by`) so future calls can tell whether " +
        "it's still current. Refuses to touch a section last stamped `by: \"claude-code\"` or `by: \"human\"` " +
        "unless `force: true` — that stamp means someone deliberately wrote prose there, not a placeholder. Pass " +
        "`snapshot_body` for pre-written prose (e.g. from a headless Claude Code call made BEFORE this tool, not " +
        "by it); omit for a bare item-count skeleton. `dry_run: true` (mandatory, no default) reports the plan " +
        "without writing; `dry_run: false` persists. Mutating.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path (ending in .md) of the note to survey."),
        mirror_root: z.string().min(1).describe("Absolute filesystem path the vault's folder tree is mirrored under."),
        depth: z.number().int().min(0).max(6).default(1).describe("How many directory levels deep to count."),
        snapshot_body: z.string().optional().describe("Pre-written prose for the section. Omit for a bare item-count skeleton."),
        force: z.boolean().default(false).describe("Overwrite a section protected by a prior human/claude-code stamp."),
        dry_run: z.boolean().describe("If true, report the plan without writing. If false, write it."),
      },
      annotations: RW,
    },
    async ({ path, mirror_root, depth, snapshot_body, force, dry_run }) => {
      try {
        const mdError = notMd(path);
        if (mdError) return mdError;
        if (visible([path]).length === 0) return outOfAllowlist(path);

        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return codedError("not_found", `"${path}" does not exist.`);

        const resolved = resolveMirrorDir(app, file, mirror_root);
        if (resolved.kind === "refused") return codedError(resolved.code, resolved.message);
        if (resolved.kind === "not_found") return codedError("mirror_not_found", `No mirror directory found for "${path}" under "${mirror_root}".`);

        const walked = walk(resolved.dir, depth, realList);
        const currentFm = app.metadataCache.getFileCache(file)?.frontmatter;
        const stampBy = (currentFm?.survey as SurveyStamp | undefined)?.by;
        const stampByStr = typeof stampBy === "string" ? stampBy : undefined;

        const by: "skeleton" | "claude-code" = snapshot_body ? "claude-code" : "skeleton";
        const bodyText = snapshot_body
          ? snapshot_body.trim()
          : `> [!info] Filesystem snapshot\n> ${walked.items} item(s), ${walked.stubs} empty subfolder(s), depth ${walked.depthReached}.`;

        const currentBody = await app.vault.read(file);
        const plan = planSection(currentBody, bodyText, stampByStr, force);

        if (plan.kind === "protected") {
          return codedError(
            "section_protected",
            `"## Contents (Filesystem)" in "${path}" was last stamped by "${plan.protectedBy}" — pass force: true to overwrite.`
          );
        }

        if (dry_run) {
          return ok({ dry_run: true, plan_kind: plan.kind, items: walked.items, stubs: walked.stubs, by });
        }

        // Route the WOULD-BE resulting content through the same accept-guard
        // predicate every other write path in this codebase uses, before
        // anything lands — #203/#236's fix, reused rather than a second
        // definition of "accepted". planSection operates on the note's FULL
        // text (frontmatter included, since the heading search runs over the
        // whole string and frontmatter always sits outside the section
        // range), so plan.newBody IS the resulting full content — checked
        // exactly, not a reconstruction that could drift from what's written.
        try {
          guardAppendResult(currentBody, plan.newBody as string);
        } catch (e) {
          if (e instanceof AcceptForbiddenError) return codedError("accept_forbidden", e.message);
          throw e;
        }

        await app.vault.process(file, () => plan.newBody as string);
        // The survey: stamp is a fixed-shape object this handler builds
        // itself (at/items/depth/by) — never derived from caller input — so
        // it cannot carry an acceptance-family key regardless of what
        // `guardAppendResult` above already cleared the BODY for.
        await app.fileManager.processFrontMatter(file, (front) => {
          front.survey = { at: new Date().toISOString(), items: walked.items, depth, by };
        });

        return ok({ dry_run: false, plan_kind: plan.kind, items: walked.items, stubs: walked.stubs, by, filesChanged: 1, files: [path] });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
