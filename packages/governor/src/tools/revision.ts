// The ONE agent-expressible disposition: `governance_submit_revision` (#101, phase 1 of #221).
//
// A revising agent — one whose note a human sent back with `acceptance-status: revising` and a
// `[!revision-request]` callout in the note BODY — resubmits its work: the addressed
// `[!revision-request]` callout(s) are removed (the tool writes NO frontmatter: #599), and (when a `summary`
// is given) a `[!revision-report]` callout is inserted below the H1 for the reviewer to read and
// dispose of at review. The write lands in the pending channel like any other agent write: the
// kernel journals it, so the governance pane surfaces the note for human review.
//
// AUTHORITY (the #221 axis): this verb supplies a CANDIDATE; it decides nothing. It is declared
// as the single `authority: "agent"` descriptor in governor/kernel/dispositions.ts, and it is
// an ORDINARY GUARDED MUTATING TOOL — registered through the patched registrar in server.ts
// (`readOnlyHint: false`), so read-only mode, the path allowlist, the write queue, the write
// journal and the kernel args (`if_rev` / `idempotency_key` / `intent`) all bind at the standard
// interception point. Nothing here is pane machinery, and nothing in the pane can be reached
// from here.
//
// IT CAN NEVER WRITE ACCEPTANCE. Three independent layers make that true:
//   1. It writes no frontmatter at all (#599): the plan only edits the BODY, so none of
//      `acceptance-status`, `accepted-by` or `accepted-on` is ever written.
//   2. The reviewer text/summary lands as `> `-quoted callout lines in the BODY, behind the
//      frontmatter fence recognized by the shared core recognizer — quoted lines cannot form a
//      frontmatter fence, so a hostile summary cannot smuggle an acceptance assertion into
//      properties.
//   3. Belt-and-suspenders: before writing, the (before, after) frontmatter transition is
//      re-checked with the SHARED accept guard (`acceptTransitionReason`, @vault-mcp/core — the
//      one definition of "asserts acceptance"); any accepted-family introduction/change refuses
//      with `Error [accept_forbidden]` and writes nothing.
//
// Obsidian-free by construction (the tools-pending-review.ts discipline): everything arrives
// through the injected `RevisionSource`, so the whole handler is headless-testable; only the
// adapter in server.ts touches `app`.

import { z } from "zod";
import type { SdkToolSpec } from "vault-mcp-api";
import { acceptTransitionReason, parseGuardFrontmatter, AcceptForbiddenError, isVisible, type GuardSettings } from "@vault-mcp/core";
import { refuse } from "./refusal.js";
import { planSubmitRevision, parseRevisionRequestCallouts, splitNote } from "../kernel/revision.js";
import { SUBMIT_REVISION_TOOL } from "../kernel/dispositions.js";

const REVISIONS_CAP = 100;

/** Enumeration seam for the `governance_revisions` listing: every markdown
 * note's path plus its cached frontmatter. */
export interface RevisionListSource {
  /** All markdown notes with their (metadata-cache) frontmatter; order unspecified. */
  listNotes(): Promise<Array<{ path: string; frontmatter: Record<string, unknown> | null }>>;
  /** Full note text, or null when the path names no note. */
  read(path: string): Promise<string | null>;
  /** Settings for the allowlist read boundary (absent ⇒ everything visible). Dormant — see below. */
  getSettings?: () => GuardSettings;
}

/** What the tool needs from the world — a read and a write, nothing else. */
export interface RevisionSource {
  /** Full note text, or null when the path names no note. */
  read(path: string): Promise<string | null>;
  /** Atomic full-content write of an EXISTING note (vault.process in production). */
  write(path: string, content: string): Promise<void>;
  /** Clock for the report/request date stamp. */
  now(): Date;
}


/**
 * The note's acceptance-status as a trimmed string, however the key is cased/underscored.
 * A note carrying MULTIPLE status-key spellings that DISAGREE (e.g. `acceptance_status:
 * revising` beside `acceptance-status: accepted`) reads as null — an unrecognizable state must
 * refuse `not_revising` rather than let first-key-wins pick the permissive reading. Non-string
 * values likewise read as null.
 */
export function acceptanceStatusOf(fm: Record<string, unknown> | null): string | null {
  if (!fm) return null;
  const values: string[] = [];
  for (const key of Object.keys(fm)) {
    const k = key.trim().toLowerCase();
    if (k === "acceptance-status" || k === "acceptance_status") {
      const v = fm[key];
      if (typeof v !== "string") return null;
      values.push(v.trim());
    }
  }
  if (values.length === 0) return null;
  return values.every((v) => v === values[0]) ? values[0] : null;
}

/**
 * The belt-and-suspenders accept check the handler runs on every write: the (before, after)
 * frontmatter transition must be clean under the SHARED accept guard. Returns the refusal
 * reason, or null when the write may proceed. Exported so the perimeter test can drive it
 * directly with a hostile `after` — the handler itself writes no frontmatter, so a
 * live call cannot exercise the refusing branch.
 */
export function revisionWriteRefusalReason(before: string, after: string): string | null {
  try {
    return acceptTransitionReason(parseGuardFrontmatter(before), parseGuardFrontmatter(after));
  } catch (e) {
    // parseGuardFrontmatter fails CLOSED on frontmatter it cannot confidently classify.
    return e instanceof AcceptForbiddenError ? e.message : String(e);
  }
}

export function buildRevisionTools(source: RevisionSource, listing: RevisionListSource): SdkToolSpec[] {
  return [
    {
      name: SUBMIT_REVISION_TOOL,
      description:
        "Resubmit a note a human sent back for changes (`acceptance-status: revising`). THE REVISING AGENT'S " +
        "CONTRACT: the human's feedback lives in the NOTE BODY — read the `[!revision-request]` callout(s) below " +
        "the H1, plus any other inline notes the reviewer left — NOT in any frontmatter field (there is no " +
        "`requested-changes` property). After you have revised the note (via the ordinary write tools), call this " +
        "to hand it back: it removes the addressed `[!revision-request]` " +
        "callout(s) (it writes no frontmatter, so `acceptance-status` is left as it is), and — when `summary` is given — inserts a `> [!revision-report]` callout below the H1 " +
        "describing what you changed (the reviewer disposes of it at review). The note then lands in the pending " +
        "channel for human review like any other agent write. Refuses with Error [not_revising] when the note is " +
        "not in the revising state (nothing to submit). This tool cannot accept anything: it writes no " +
        "frontmatter, and the accept-forbidden guard re-checks the write — acceptance is a human gesture in the " +
        "review pane, never an API call. Pass `intent` (the standard kernel argument) if you want the write " +
        "journal to carry your summary of why.",
      inputSchema: {
        path: z.string().describe("Vault-relative path of the revising note (uid:/jd: addressing works)."),
        summary: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            "What you changed, for the reviewer — inserted into the note as a `[!revision-report]` callout " +
              "below the H1. Omit to resubmit without a report."
          ),
      },
      readOnly: false,
      handler: async (raw: Record<string, unknown>) => {
      const path = raw.path;
      const summary = raw.summary;
      // The publishing boundary drops zod min/max, so both bounds are
      // re-applied here (the vaultmcp_skills_release semver lesson).
      if (typeof path !== "string" || path.length === 0) {
        refuse("invalid_argument", "'path' must be a non-empty string");
      }
      if (summary !== undefined && (typeof summary !== "string" || summary.length < 1 || summary.length > 4000)) {
        refuse("invalid_argument", "'summary' must be a string of 1 to 4000 characters when given");
      }
      if (!path.toLowerCase().endsWith(".md")) {
        refuse("invalid_path", `not a markdown note: ${path}`);
      }
      const before = await source.read(path);
      if (before === null) refuse("not_found", `no note at ${path}`);

      // The status gate — read through the guard's own strict frontmatter reader, which fails
      // CLOSED (refuses) on YAML it cannot confidently classify rather than guessing.
      let fmBefore: Record<string, unknown> | null;
      try {
        fmBefore = parseGuardFrontmatter(before);
      } catch (e) {
        refuse("accept_forbidden", (e as Error).message);
      }
      const status = acceptanceStatusOf(fmBefore);
      if (status !== "revising") {
        refuse(
          "not_revising",
          `${path} has acceptance-status ${status === null ? "(none)" : `'${status}'`} — nothing to submit. ` +
            "Only a note a human marked 'revising' can be resubmitted."
        );
      }

      const date = source.now().toISOString().slice(0, 10);
      const plan = planSubmitRevision(before, { summary, date });

      // Belt-and-suspenders: the (before, after) transition through the SHARED accept guard.
      const refusal = revisionWriteRefusalReason(before, plan.content);
      if (refusal !== null) refuse("accept_forbidden", refusal);

      await source.write(path, plan.content);
      return {
        path,
        removed_requests: plan.removedRequests,
        report_inserted: plan.reportInserted,
        // The guarded.ts effects convention: the journal records what actually changed.
        filesChanged: 1,
        files: [path],
      };
      },
    },

    {
      // ── governance_revisions: the read-side discovery listing ──────────────
      //
      // The submit tool above closes the round-trip; this tool OPENS it: a
      // dispatcher asks "what revision work is waiting, and what did the human
      // ask for?" without reading every note. It confers nothing — the listing
      // is derived from frontmatter the pane's request-changes gesture wrote
      // and callouts in agent-readable bodies.
      //
      // Its allowlist filter is the same DORMANT SEAM the other published tools
      // keep: a satellite cannot reach the host's guard settings, and under an
      // active allowlist the host blocks this tool wholesale anyway (no
      // recognized path key, so nothing to scope). Kept because an apiVersion-2
      // SDK carrying the caller's scope wakes it with no code change, and
      // because the tests supply it so it cannot rot.
      name: "governance_revisions",
      description:
        "Notes a human sent back for changes (`acceptance-status: revising`), with the `[!revision-request]` " +
        "callout text parsed out of each note's body — the request, its date, and the note's path — so a " +
        "dispatcher can read the human's asks at a glance and route the work. THE REVISING AGENT'S CONTRACT: " +
        "the feedback lives in the NOTE BODY (the callout plus anything else the human left inline); finish with " +
        "governance_submit_revision. Read-only; capped at " + REVISIONS_CAP + ". Under a path allowlist this tool " +
        "is unavailable: `folder` is not a path key the host recognizes, so it cannot scope the call and blocks it.",
      inputSchema: {
        folder: z.string().optional().describe("Only notes under this vault-relative folder prefix."),
      },
      readOnly: true,
      handler: async (raw: Record<string, unknown>) => {
        const folder = typeof raw.folder === "string" && raw.folder.length > 0 ? raw.folder : undefined;
        const settings = listing.getSettings?.();
        const all = await listing.listNotes();
        const prefix = folder ? folder.replace(/\/+$/, "") + "/" : null;
        const revising = all.filter(
          (n) =>
            acceptanceStatusOf(n.frontmatter) === "revising" &&
            (!prefix || n.path.startsWith(prefix) || n.path === prefix.slice(0, -1)) &&
            (!settings || isVisible(n.path, settings))
        );
        const capped = revising.slice(0, REVISIONS_CAP);
        const items = [];
        for (const n of capped) {
          const text = await listing.read(n.path);
          // A cache/disk race (note deleted between list and read) drops the row
          // rather than failing the listing.
          if (text === null) continue;
          const requests = parseRevisionRequestCallouts(splitNote(text).body);
          items.push({ path: n.path, requests });
        }
        return {
          count: items.length,
          total_revising: revising.length,
          truncated: revising.length > capped.length,
          items,
        };
      },
    },
  ];
}
