// tools.ts — the vaultmcp-conformance satellite's tool surface: the
// conformance-debt register (issue #211), published to the Vault MCP host
// through `vault-mcp-api` as TWO tools (see main.ts):
//
//   debt        — Part A2, the read-only report: reads the accepted-debt
//                 baseline + the metadata sidecar + a live conformance run and
//                 returns the carried debt as structured, filterable/groupable
//                 data plus the burn-down counts and the two teeth (staleness,
//                 budget). Declared read-only.
//   debt_render — Part B, MUTATING: materializes the same report as one
//                 generated register note in the vault.
//
// ── The published names changed (the suite split's usual trade) ─────────────
//
// The host publishes an external tool as `<sanitized publisher id>_<bare name>`.
// This plugin's id is `vaultmcp-conformance`, which sanitizes to
// `vaultmcp_conformance`, so the two bare names below go on the wire as
// `vaultmcp_conformance_debt` and `vaultmcp_conformance_debt_render` — NOT the
// `obsidian_conformance_debt` / `obsidian_conformance_debt_render` the host
// registered itself. The bare names shed the host's `obsidian_` namespace and
// the `conformance_` word the plugin id already carries (keeping either would
// publish a stutter). Breaking for callers of the old names; recorded in
// CLAUDE.md and README.md, with the one-line reversal (the manifest id).
//
// ── The report: read-only / agent-safe by construction ──────────────────────
//
// The report tool NEVER writes. It reads the baseline note, the sidecar JSON,
// and runs the conformance engine (a disk scan, no mutation). It exposes no
// accept verb and no path that stamps `acceptedOn`/`acceptedBy` — those are
// minted only at the human-run `--rebaseline` (kernel/cli.ts). Agents SEE debt;
// only a human MINTS acceptance.
//
// ── Allowlist posture: FAIL-CLOSED on the whole surface (issue #381) ────────
//
// Neither tool carries an argument the host recognizes as a path: `debt`'s
// `folder` is a FILTER over findings (the run still reads the whole vault), and
// `debt_render` takes no arguments at all — its write target is configuration.
// That follows the provenance precedent's rule ("path-key iff it mutates the
// note it names"): the render names no note, and the report is a read whose
// answer enumerates paths. So under an active path allowlist the host's F3 gate
// refuses BOTH outright, before a handler runs. In the host the report ran
// whole-vault under an allowlist (the documented #381 exception: every target
// it names is already a plaintext line in the baseline note) and the render
// refused unless the register path was inside the allowlist. Both are now
// refused under any allowlist — stricter, and the last tool on #381's list
// leaves the host the way health and provenance did. With NO allowlist (the
// ordinary case) nothing changes.
//
// The render's own `out_of_allowlist` check is KEPT, now over the per-call
// `CallContext` a v2 host hands the handler (`isVisible` is identity with no
// allowlist). Under F3 it cannot fire today; it is the in-handler half of the
// boundary should the host ever scope a pathless tool, and it costs nothing.
//
// ── Envelope convention (the satellite contract) ────────────────────────────
//
// A handler returns PLAIN DATA and THROWS on refusal. The host wraps a return
// value in `ok()` and a thrown error in `fail()`; `fail()` reads a
// lowercase-snake `code` off the error and renders `Error [code]: message`,
// otherwise a bare `Error: message`. That is byte-for-byte what the host's
// `codedError(code, message)` produced for `invalid_register_dir`,
// `register_baseline_collision` and `out_of_allowlist`, and what its
// `fail(e)` produced for a kernel throw (a missing baseline, a coverage
// refusal) and for `AcceptForbiddenError` (code `accept_forbidden`).
//
// ONE code is NEW: `invalid_argument`, for a `debt` filter that is empty or not
// a string, or a `group_by` outside its enum. In the host the zod `.min(1)` and
// `z.enum` ran inside the SDK's own validation; across the publishing boundary
// `min` does not survive (`json-schema-to-zod.ts` keeps `type`, `description`
// and string `enum` only), so the bound is re-applied here and needs a name.
//
// ── Config is read PER CALL ─────────────────────────────────────────────────
//
// `ctx.config` is a THUNK. The host read `modules.conformance-debt.config` per
// connection; a satellite has no per-connection rebuild, so a captured config
// would freeze at plugin load. main.ts also re-publishes on every settings
// write, for parity with the other satellites (no description here renders a
// config value today).
//
// Obsidian-free: everything arrives through the injected `DebtSource` /
// `DebtRegisterSource`, so every handler is unit-testable headlessly against a
// fake source. The live adapters are in obsidian-debt-source.ts.

import { posix } from "node:path";
import { z } from "zod";
import type { CallContext, SdkToolSpec } from "vault-mcp-api";
import type { Finding } from "./kernel/finding.js";
import type { SkippedTerritory } from "./kernel/snapshot.js";
import { parseBaseline } from "./kernel/ratchet.js";
import type { DebtSidecar } from "./kernel/debt-sidecar.js";
import {
  buildDebtReport,
  filterDebtItems,
  groupDebtItems,
  DEFAULT_STALE_AFTER_DAYS,
  type DebtFilter,
  type DebtGroupKey,
} from "./kernel/debt.js";
import { buildRegisterFromRun, registerAcceptRefusal, registerNotePathFor, DEFAULT_REGISTER_MAX_ROWS } from "./kernel/debt-register.js";
import { capList, overFullOutputCap, FULL_OUTPUT_MAX_BYTES, REPORT_MAX_FINDINGS, type RunCoverage } from "./kernel/report-caps.js";

/** The report's SDK flags. `readOnly: true` is a CLAIM the host distrusts
 * unless `vaultmcp-conformance` is in `trustedReadOnlyPlugins`. */
const RO = { readOnly: true, destructive: false, idempotent: true } as const;
/** The render's SDK flags. */
const RW = { readOnly: false, destructive: false, idempotent: false } as const;

/** Default staleness threshold (days) — defined in the conformance core
 * (debt.ts) so the headless CLI shares it; re-exported here. `staleAfterDays: 0`
 * in config disables it. */
export { DEFAULT_STALE_AFTER_DAYS };

/** The group-by dimensions, as data so the handler re-checks the enum. */
const GROUP_KEYS = ["folder", "pack", "check", "kind"] as const;

/** A TYPED refusal, thrown. The host's `fail()` renders `Error [code]: message`. */
export class ConformanceRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConformanceRefusal";
    this.code = code;
  }
}

/** A function DECLARATION, so TypeScript narrows control flow through it. */
function refuse(code: string, message: string): never {
  throw new ConformanceRefusal(code, message);
}

/**
 * The vault state the debt report reads. Obsidian-free (structurally typed) so
 * the handler is headless-testable; the real adapter runs the conformance
 * engine over the on-disk vault.
 */
export interface DebtSource {
  /** The live conformance findings for a fresh run. */
  liveFindings(): Promise<Finding[]>;
  /** The accepted-debt baseline note text (its fenced key block is parsed). */
  baselineText(): Promise<string>;
  /** The metadata sidecar (tolerant: absent/corrupt reads as empty). */
  sidecar(): Promise<DebtSidecar>;
  /** Guarded territories the LAST `liveFindings()` run skipped (#398). Optional
   * so a hand-built source (tests) still satisfies the type; absent ⇒ none.
   * Read only after `liveFindings()` has resolved. */
  skippedTerritories?(): readonly SkippedTerritory[];
  /** What the LAST `liveFindings()` run checked (report cap 4). Optional like
   * `skippedTerritories`; absent ⇒ the report says nothing about coverage. */
  coverage?(): RunCoverage | null;
}

/** The extra seams the render tool needs on top of the read-only DebtSource.
 * Structurally typed and Obsidian-free; the live adapter is
 * `obsidianDebtRenderSource` (obsidian-debt-source.ts). */
export interface DebtRegisterSource extends DebtSource {
  /** The vault-relative dir the register renders into when config does not
   * override — by convention the baseline's own folder, where the sidecar and
   * trend log already live. "" = vault root. */
  defaultRegisterDir(): string;
  /** The baseline note's vault-relative path — consulted so the render can
   * REFUSE a collision (a baseline named like the register must never be
   * overwritten by its own report). */
  baselineNotePath(): string;
  /** Write a note at a vault-relative path (creating parent folders). */
  writeNote(path: string, text: string): Promise<void>;
}

export interface ConformanceToolsCtx {
  /** This plugin's debt config (the keys the host kept at
   * `modules.conformance-debt.config`): `staleAfterDays`, `debtBudget`,
   * `strictBudget`, `registerDir`, `registerMaxRows`. A THUNK, read per call. */
  config: () => Record<string, unknown> | undefined;
  /** The run's clock, injectable for tests. Defaults to `new Date()`. */
  now?: () => Date;
}

/** Resolved teeth config from a raw debt config bag. */
export function conformanceDebtConfigOf(config: Record<string, unknown> | undefined): {
  staleAfterDays: number;
  debtBudget: number | null;
  strictBudget: boolean;
} {
  const c = config ?? {};
  const stale = typeof c.staleAfterDays === "number" && Number.isFinite(c.staleAfterDays) ? c.staleAfterDays : DEFAULT_STALE_AFTER_DAYS;
  const budget = typeof c.debtBudget === "number" && Number.isFinite(c.debtBudget) && c.debtBudget >= 0 ? c.debtBudget : null;
  const strict = c.strictBudget === true;
  return { staleAfterDays: stale, debtBudget: budget, strictBudget: strict };
}

/** Render-specific config from the raw debt config bag: `registerDir`
 * (vault-relative; blank ⇒ the source's default — the baseline's folder) and
 * `registerMaxRows` (table cap). Separate from `conformanceDebtConfigOf` so the
 * teeth resolver's shape is untouched. */
export function debtRenderConfigOf(config: Record<string, unknown> | undefined): {
  registerDir: string | null;
  maxRows: number;
} {
  const c = config ?? {};
  const rawDir = typeof c.registerDir === "string" ? c.registerDir.trim().replace(/\/+$/, "") : "";
  const rawRows = c.registerMaxRows;
  const maxRows =
    typeof rawRows === "number" && Number.isFinite(rawRows) && rawRows >= 1
      ? Math.floor(rawRows)
      : DEFAULT_REGISTER_MAX_ROWS;
  return { registerDir: rawDir || null, maxRows };
}

/** An optional non-empty string argument, re-checked in the handler (the
 * boundary drops zod's `.min(1)`). */
function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) refuse("invalid_argument", `'${key}' must be a non-empty string`);
  return v;
}

/** True when a configured register dir cannot be honored: absolute (the vault
 * API expects vault-relative paths and would let `create` land outside the
 * vault base) or normalizing above the vault root. "" (the vault root) is
 * fine. The config is user-set, so this is a misconfiguration refusal, not a
 * security boundary. */
function invalidRegisterDir(dir: string): boolean {
  if (dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir)) return true;
  const n = posix.normalize(dir);
  return n === ".." || n.startsWith("../");
}

/** The read-only debt report (bare name `debt`). */
export function buildDebtTool(source: DebtSource, ctx: ConformanceToolsCtx): SdkToolSpec {
  const clock = ctx.now ?? (() => new Date());
  return {
    name: "debt",
    description:
      "Read-only conformance-debt register. Reads the accepted-debt baseline, the metadata sidecar (accepted-on/by, " +
      "reason, priority, fix-by), and a live conformance run, and returns the CARRIED debt as structured items — " +
      "each { script, check, target, kind, acceptedOn?, acceptedBy?, reason?, priority?, fixBy?, ageDays? } — plus " +
      "summary counts { carried, cleared, new }, a `stale` list (items older than the configured threshold), and a " +
      "`budget` status (warns when carried exceeds the configured max). Optional args narrow by folder prefix / pack " +
      "/ check / kind and group the counts. At most 200 items (and 200 stale) are returned, with a `truncated` count of the rest; " +
      "an answer that would pass 5 MB returns its counts only. Never writes; acceptance is a human act (via --rebaseline), never this " +
      "tool. Runs over the whole vault, so the Vault MCP host refuses it while a path allowlist is active " +
      "(no argument is a path the host can scope).",
    inputSchema: {
      folder: z.string().min(1).optional().describe("Keep only items whose target is at/under this folder prefix (segment boundary)."),
      pack: z.string().min(1).optional().describe("Keep only items from this rule pack (the finding's `script`), e.g. \"drift_audit\"."),
      check: z.string().min(1).optional().describe("Keep only items with this check code, e.g. \"unregistered_tag\"."),
      kind: z.string().min(1).optional().describe("Keep only items with this kind discriminant."),
      group_by: z.enum(GROUP_KEYS).optional().describe("Also return per-group carried counts by this dimension."),
    },
    ...RO,
    handler: async (args) => {
      const filter: DebtFilter = {
        folder: optionalText(args, "folder"),
        pack: optionalText(args, "pack"),
        check: optionalText(args, "check"),
        kind: optionalText(args, "kind"),
      };
      const groupBy = args.group_by;
      if (groupBy !== undefined && !(GROUP_KEYS as readonly unknown[]).includes(groupBy)) {
        refuse("invalid_argument", `'group_by' must be one of ${GROUP_KEYS.join(", ")}`);
      }
      const cfg = conformanceDebtConfigOf(ctx.config());
      const [live, baselineText, sidecar] = await Promise.all([
        source.liveFindings(),
        source.baselineText(),
        source.sidecar(),
      ]);
      const report = buildDebtReport({
        baselineKeys: parseBaseline(baselineText),
        live,
        sidecar,
        now: clock(),
        // Read AFTER liveFindings resolved (Promise.all above) — it reports
        // that run's skips (#398).
        skippedTerritories: source.skippedTerritories?.() ?? [],
        staleAfterDays: cfg.staleAfterDays,
        debtBudget: cfg.debtBudget,
        strictBudget: cfg.strictBudget,
      });
      const items = filterDebtItems(report.items, filter);
      const stale = filterDebtItems(report.stale, filter);
      const groups = groupBy ? groupDebtItems(items, groupBy as DebtGroupKey) : undefined;
      // Report cap 1: at most 200 items (and 200 stale) are returned, with the
      // count left out; the filters narrow to the rest. Counts and groups are
      // computed over the WHOLE filtered set, before the cap.
      const shownItems = capList(items);
      const shownStale = capList(stale);
      const coverage = source.coverage?.() ?? null;
      const result = {
        // Summary is the WHOLE-vault burn-down (never filtered — it must agree
        // with the ratchet's own carried/cleared/new).
        summary: report.summary,
        staleAfterDays: report.staleAfterDays,
        budget: report.budget,
        skipped_territories: report.skippedTerritories,
        // `filtered` counts describe the narrowed item set, before the cap.
        filtered: { carried: items.length, stale: stale.length },
        ...(coverage ? { checked: coverage } : {}),
        items: shownItems.shown,
        stale: shownStale.shown,
        ...(shownItems.more || shownStale.more
          ? {
              truncated: {
                items_more: shownItems.more,
                stale_more: shownStale.more,
                note: `+${shownItems.more} more item(s) and +${shownStale.more} more stale item(s) not returned (cap ${REPORT_MAX_FINDINGS}); narrow with folder / pack / check / kind, or run the conformance CLI with --findings-json for the full set outside the vault.`,
              },
            }
          : {}),
        ...(groups ? { groups } : {}),
      };
      // Report cap 3: an answer that would still pass 5 MB returns its counts only.
      if (overFullOutputCap(JSON.stringify(result))) {
        return {
          summary: result.summary,
          budget: result.budget,
          filtered: result.filtered,
          output_capped: `the report would pass ${FULL_OUTPUT_MAX_BYTES / (1024 * 1024)} MB, so only its counts are returned; narrow with folder / pack / check / kind.`,
        };
      }
      return result;
    },
  };
}

// ── the human-facing register render (issue #211, Part B) ────────────────────
//
// `debt_render` MATERIALIZES the debt report into the vault as ONE generated
// note (`Conformance debt.md`, default: beside the baseline/sidecar) that
// Obsidian renders natively — MCP only triggers the write; the artifact lives
// on disk. It is MUTATING (`readOnly: false`), so the host's guarded
// registration path applies (read-only mode, queue, journal, kernel args), and
// the write itself goes through the injected vault-API writer with the shared
// accept-guard run over the text that will land (`registerAcceptRefusal`) — the
// register's frontmatter is a `generated` + `generator` derivation stamp and
// can never carry an acceptance-family key.
//
// The success envelope is unchanged from the host era (`written`, `summary`,
// …). The host's argument-derived journal target is empty for this tool, as
// it was in the host: the tool never took a path.

/** The register render (bare name `debt_render`). */
export function buildDebtRenderTool(source: DebtRegisterSource, ctx: ConformanceToolsCtx): SdkToolSpec {
  const clock = ctx.now ?? (() => new Date());
  return {
    name: "debt_render",
    description:
      "Regenerate the human-facing conformance-debt register: runs the conformance engine, diffs against the " +
      "accepted-debt baseline + metadata sidecar, and writes `Conformance debt.md` (default: beside the baseline) " +
      "— a summary header, a table of carried debt with each row wikilinked to the offending note (stale + " +
      "high-priority first), and a 'cleared — prune these from the baseline' section. DERIVED content: the note " +
      "carries only `generated`/`generator` frontmatter and never any acceptance field (the accept-guard is run " +
      "over the rendered text before writing). Mutating — it writes the register note; it never touches the " +
      "baseline or the sidecar. The Vault MCP host refuses it while a path allowlist is active (it takes no path " +
      "argument the host can scope).",
    inputSchema: {},
    ...RW,
    handler: async (_args, callCtx?: CallContext) => {
      const raw = ctx.config();
      const cfg = conformanceDebtConfigOf(raw);
      const renderCfg = debtRenderConfigOf(raw);
      const registerDir = renderCfg.registerDir ?? source.defaultRegisterDir();
      if (invalidRegisterDir(registerDir)) {
        refuse(
          "invalid_register_dir",
          `registerDir (${registerDir}) must be a vault-relative folder — not absolute, not escaping the vault root.`,
        );
      }
      // Normalized before use, so the path checked (allowlist, collision) is
      // the path written.
      const notePath = registerNotePathFor(registerDir === "" ? "" : posix.normalize(registerDir));
      // A baseline named like the register must never be overwritten by its
      // own report — the CLI's collision refusal, mirrored here (case-folded:
      // the default macOS filesystem treats case variants as one file).
      if (notePath.toLowerCase() === source.baselineNotePath().toLowerCase()) {
        refuse(
          "register_baseline_collision",
          `the register path (${notePath}) is the baseline note itself — rendering would overwrite the ` +
            "acceptance record. Configure `registerDir` elsewhere or rename the baseline.",
        );
      }
      // Identity with no allowlist; under one, the host's F3 gate has already
      // refused this pathless call. Kept as the handler's own half — see header.
      if (callCtx && !callCtx.isVisible(notePath)) {
        refuse(
          "out_of_allowlist",
          `the register note (${notePath}) is outside this session's path allowlist — the render writes there. ` +
            "Widen the allowlist to cover it, or configure `registerDir` inside the allowlisted area.",
        );
      }
      const [live, baselineText, sidecar] = await Promise.all([
        source.liveFindings(),
        source.baselineText(),
        source.sidecar(),
      ]);
      const { text, report, clearedKeys, rows } = buildRegisterFromRun({
        baselineKeys: parseBaseline(baselineText),
        live,
        sidecar,
        now: clock(),
        // Read AFTER liveFindings resolved (Promise.all above) — it reports
        // that run's skips (#398).
        skippedTerritories: source.skippedTerritories?.() ?? [],
        staleAfterDays: cfg.staleAfterDays,
        debtBudget: cfg.debtBudget,
        strictBudget: cfg.strictBudget,
        maxRows: renderCfg.maxRows,
        coverage: source.coverage?.() ?? undefined,
      });
      // The accept-guard over the text that will land — load-bearing
      // invariant, not a filter the renderer expects to trip.
      registerAcceptRefusal(text);
      await source.writeNote(notePath, text);
      return {
        written: notePath,
        summary: report.summary,
        budget: report.budget,
        skipped_territories: report.skippedTerritories,
        staleAfterDays: report.staleAfterDays,
        stale: report.stale.length,
        // What the note actually lists: report cap 1 clamps `registerMaxRows`
        // to 200 and keeps the note under 256 KB.
        rows,
        truncated: report.items.length > rows,
        cleared: clearedKeys.length,
      };
    },
  };
}

/** Both published tools, in publication order. */
export function buildConformanceTools(source: DebtRegisterSource, ctx: ConformanceToolsCtx): SdkToolSpec[] {
  return [buildDebtTool(source, ctx), buildDebtRenderTool(source, ctx)];
}
