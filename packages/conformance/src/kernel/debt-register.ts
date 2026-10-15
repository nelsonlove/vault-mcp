// debt-register.ts — the human-facing conformance-debt register (issue #211,
// Part B): render the debt report as ONE Obsidian markdown note that the vault
// renders natively — a summary header, a table of carried debt (each row
// linking the offending note), and a "cleared — prune these" section.
//
// PURE: a function of the debt report + a passed-in timestamp. No I/O, no
// clock — the MCP render tool and the CLI both call `buildRegisterFromRun`
// and write the returned text through their own write paths (vault API /
// node:fs respectively).
//
// ── Derived content, never an acceptance surface ─────────────────────────────
//
// The register is a report ABOUT accepted debt, not an acceptance record. Its
// frontmatter carries DERIVATION stamps only (`generated` + `generator`, the
// provenance convention — that surface is the `vaultmcp-provenance` satellite
// since the mutating-tier extraction, but the convention is unchanged) and structurally cannot carry an
// acceptance-family key: `renderDebtRegister` emits a fixed two-key block and
// nothing from the sidecar reaches frontmatter. `registerAcceptRefusal` runs
// the shared accept-guard over the rendered text anyway — running the guard is
// the load-bearing invariant (the provenance-regen discipline), not a filter
// the renderer expects to trip. Acceptance metadata itself lives in the
// sidecar and is minted only at the human-run `--rebaseline`.
//
// ── Why ONE note and no .base file ───────────────────────────────────────────
//
// Obsidian Bases build their rows from NOTES and their frontmatter properties —
// a Base cannot query rows out of a markdown table or a JSON file inside a
// single note. Driving a multi-row Base would therefore require materializing
// one stub note per debt item (hundreds of generated files), which is exactly
// the note-per-item spam this design rejects. So the register is the markdown
// table below plus the machine-readable sidecar JSON; no `.base` file is
// generated. If Bases ever gain a non-note row source, revisit.

import { AcceptForbiddenError, acceptForbiddenReason, parseGuardFrontmatter } from "@vault-mcp/core";
import { findingKey } from "./finding.js";
import { buildDebtReport, type DebtItem, type DebtReport, type DebtReportOpts } from "./debt.js";
import { capRows, coverageLine, utf8Bytes, REPORT_MAX_FINDINGS, REPORT_NOTE_MAX_BYTES, type RunCoverage } from "./report-caps.js";

/** The register note's basename — sibling of the sidecar (`Conformance
 * debt.json`), living in the register dir (default: the baseline's folder). */
export const REGISTER_BASENAME = "Conformance debt.md";

/** The `generator:` stamp on the rendered register — identifies the producer
 * (the provenance `AUDIT_GENERATOR` convention, now in the `vaultmcp-provenance`
 * satellite). Constant, not a
 * user knob. */
export const REGISTER_GENERATOR = "conformance-debt-register";

/** Carried-debt rows shown in the table before the "+N more" cap. It is
 * report cap 1 (report-caps.ts): the register is a report note in the vault,
 * so it lists at most 200 findings in all, carried rows and cleared keys
 * together, and a larger `registerMaxRows` is clamped to it. Was 300 until the
 * caps landed (2026-10-15). */
export const DEFAULT_REGISTER_MAX_ROWS = REPORT_MAX_FINDINGS;

/** The register note's vault-relative path for a register dir ("" = vault root). */
export function registerNotePathFor(registerDir: string): string {
  const dir = registerDir.replace(/\/+$/, "");
  return dir && dir !== "." ? `${dir}/${REGISTER_BASENAME}` : REGISTER_BASENAME;
}

// ── table-cell / link rendering ──────────────────────────────────────────────

/** Escape arbitrary text for a markdown table cell: `|` would open a new
 * column, a newline a new row. */
export function cell(text: string | number | undefined | null): string {
  if (text === undefined || text === null || text === "") return "";
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// Characters a wikilink target cannot carry literally: `|` starts an alias,
// `[`/`]` terminate the link, `#`/`^` start a heading/block anchor.
const WIKILINK_UNSAFE = /[|[\]#^]/;

/** Percent-encode one vault path for a markdown-style link destination.
 * encodeURIComponent per segment (so `/` separators survive), plus manual
 * `(`/`)` encoding — parens are legal in URIs but terminate a markdown link. */
function encodeLinkPath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

/**
 * A clickable link to a finding's target, safe inside a markdown table cell.
 *
 *   - a note path (ends `.md`) whose linkpath is wikilink-safe → `[[path]]`
 *     (no `.md`, Obsidian's canonical form);
 *   - a note path carrying `|`, brackets, or an anchor char → a markdown-style
 *     link with a percent-encoded destination, because wikilink syntax cannot
 *     express those literally (a raw `|` reads as an alias separator AND as a
 *     table column break — the pipe-in-filename notes from #136/#209 are real);
 *   - a non-path target (a pack token, a message) → a code span, escaped for
 *     the table.
 */
export function noteLink(target: string): string {
  if (!target.endsWith(".md")) return `\`${cell(target)}\``;
  const linkpath = target.slice(0, -3);
  if (!WIKILINK_UNSAFE.test(linkpath)) return `[[${linkpath}]]`;
  const display = cell(linkpath.split("/").pop() ?? linkpath).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return `[${display}](${encodeLinkPath(target)})`;
}

// ── ordering ─────────────────────────────────────────────────────────────────

/** Free-text priority → a sort rank. Recognizes the common labels; anything
 * else (including absent) sits between high and low. */
function priorityRank(priority: string | undefined): number {
  const p = (priority ?? "").trim().toLowerCase();
  if (/^(high|urgent|critical|p0|p1)$/.test(p)) return 0;
  if (/^(low|someday|later|p3|p4)$/.test(p)) return 2;
  return 1;
}

/** Table order: stale first, then priority (high → low), then age descending
 * (unknown age last), then key — so the rows most in need of attention lead
 * and the order is a function of the report, not of Map iteration. */
export function orderDebtItems(items: DebtItem[]): DebtItem[] {
  return [...items].sort(
    (a, b) =>
      Number(b.stale ?? false) - Number(a.stale ?? false) ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      (b.ageDays ?? -1) - (a.ageDays ?? -1) ||
      a.key.localeCompare(b.key),
  );
}

// ── the note ─────────────────────────────────────────────────────────────────

export interface RegisterRenderOpts {
  report: DebtReport;
  /** Baseline keys with no live match, sorted — the "prune these" signal. */
  clearedKeys: string[];
  /** ISO timestamp stamped into `generated:`. Passed in, never sampled here. */
  generatedAt: string;
  /** Cap on listed findings (table rows first, then cleared keys); the
   * remainder collapses to a "+N more" line. Clamped to report cap 1 (200). */
  maxRows?: number;
  /** What the run checked (report cap 4); stated in the summary when given. */
  coverage?: RunCoverage;
}

/** The rows a render actually listed, so a caller can report them truthfully. */
export interface RegisterRenderResult {
  text: string;
  /** Carried rows listed in the table. */
  rows: number;
  /** Cleared keys listed. */
  clearedListed: number;
}

const TABLE_HEADER = [
  "| Note | Pack | Check | Kind | Accepted | By | Age (d) | Stale | Priority | Fix by | Reason |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

function row(it: DebtItem): string {
  const cells = [
    noteLink(it.target),
    cell(it.script),
    cell(it.check),
    cell(it.kind),
    cell(it.acceptedOn),
    cell(it.acceptedBy),
    cell(it.ageDays),
    it.stale ? "yes" : "",
    cell(it.priority),
    cell(it.fixBy),
    cell(it.reason),
  ];
  return `| ${cells.join(" | ")} |`;
}

/** Render the full register note text (frontmatter + body). Deterministic —
 * a function of its inputs. Obeys report cap 1: at most 200 findings listed
 * (carried rows, then cleared keys, in one budget) and under 256 KB — when the
 * listed rows would pass the byte cap, the budget is halved until the note
 * fits, and the "+N more" lines say how many were left out. */
export function renderDebtRegister(opts: RegisterRenderOpts): string {
  return renderDebtRegisterCapped(opts).text;
}

/** {@link renderDebtRegister}, with the counts it listed. */
export function renderDebtRegisterCapped(opts: RegisterRenderOpts): RegisterRenderResult {
  let budget = capRows(opts.maxRows ?? DEFAULT_REGISTER_MAX_ROWS);
  for (;;) {
    const r = renderWithBudget(opts, budget);
    if (utf8Bytes(r.text) < REPORT_NOTE_MAX_BYTES || budget === 0) return r;
    budget = Math.floor(budget / 2);
  }
}

function renderWithBudget(opts: RegisterRenderOpts, listBudget: number): RegisterRenderResult {
  const { report, clearedKeys, generatedAt } = opts;
  const maxRows = listBudget;
  const { summary, budget, staleAfterDays } = report;

  const budgetLine =
    budget.budget == null
      ? "no budget configured"
      : budget.over
        ? `OVER — ${budget.carried} carried > ${budget.budget} budget${budget.strict ? " (strict: the run fails)" : ""}`
        : `${budget.carried} / ${budget.budget} (within budget)`;
  const staleLine =
    staleAfterDays == null ? "staleness check off" : `Stale (≥ ${staleAfterDays} days): ${report.stale.length}`;

  const lines: string[] = [
    "---",
    `generated: ${generatedAt}`,
    `generator: ${REGISTER_GENERATOR}`,
    "---",
    "",
    "# Conformance debt",
    "",
    "Derived report — regenerate with `vaultmcp_conformance_debt_render` or the conformance CLI's " +
      "`--render-register`; hand edits are overwritten. Acceptance metadata lives in the sidecar " +
      "(`Conformance debt.json`) and is minted only at the human-run `--rebaseline` — never here.",
    "",
    "## Summary",
    "",
    `- Carried: ${summary.carried}`,
    `- Cleared: ${summary.cleared} (fixed or moved — prune from the baseline at the next rebaseline)`,
    `- New: ${summary.new}${summary.new ? " (regressions — the conformance run fails)" : ""}`,
    `- ${staleLine}`,
    `- Budget: ${budgetLine}`,
    ...(report.skippedTerritories.length
      ? [
          `- Guarded (not scanned, no claim made): ${report.skippedTerritories
            .map((t) => `${t.path} (guarded territory '${t.territory}')`)
            .join(", ")} — listed in guarded territories`,
        ]
      : []),
    ...(opts.coverage ? [`- ${coverageLine(opts.coverage)}`] : []),
    "",
    "## Carried debt",
    "",
  ];

  let rows = 0;
  let clearedListed = 0;
  if (report.items.length === 0) {
    lines.push("No carried debt.");
  } else {
    const ordered = orderDebtItems(report.items);
    const shown = ordered.slice(0, maxRows);
    rows = shown.length;
    lines.push(...TABLE_HEADER);
    for (const it of shown) lines.push(row(it));
    if (ordered.length > shown.length) {
      lines.push(
        "",
        `+${ordered.length - shown.length} more row(s) not shown — the full set is in the sidecar and the ` +
          "`vaultmcp_conformance_debt` report.",
      );
    }
  }

  lines.push("", "## Cleared — prune these from the baseline", "");
  if (clearedKeys.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(
      "These accepted keys no longer reproduce (fixed, or the target moved). A human `--rebaseline` drops them:",
      "",
    );
    // Raw keys inside code spans: a list bullet is not a table, so a `|` needs
    // no escaping — and an escape inside a code span would DISPLAY literally,
    // corrupting the key a human is meant to copy out. The cleared keys share
    // the listing budget with the table rows (report cap 1).
    const room = Math.max(0, maxRows - rows);
    const listed = clearedKeys.slice(0, room);
    clearedListed = listed.length;
    for (const k of listed) lines.push(`- \`${k}\``);
    if (clearedKeys.length > listed.length) {
      lines.push(
        "",
        `+${clearedKeys.length - listed.length} more cleared key(s) not shown — the conformance CLI lists them all (\`--findings-json\` writes the full set outside the vault).`,
      );
    }
  }
  lines.push("");
  return { text: lines.join("\n"), rows, clearedListed };
}

/** Build the register text straight from a run's raw inputs: the debt report
 * plus the cleared keyset (baseline − live), which the report only counts. */
export function buildRegisterFromRun(
  opts: DebtReportOpts & { maxRows?: number; coverage?: RunCoverage },
): { text: string; report: DebtReport; clearedKeys: string[]; rows: number; clearedListed: number } {
  const report = buildDebtReport(opts);
  // cleared = baseline − live, sorted. Recomputed here (the report carries only
  // the count) with the same findingKey identity buildDebtReport uses.
  const live = new Set(opts.live.map((f) => findingKey(f)));
  const clearedKeys = [...opts.baselineKeys].filter((k) => !live.has(k)).sort();
  const { text, rows, clearedListed } = renderDebtRegisterCapped({
    report,
    clearedKeys,
    generatedAt: opts.now.toISOString(),
    maxRows: opts.maxRows,
    coverage: opts.coverage,
  });
  return { text, report, clearedKeys, rows, clearedListed };
}

/**
 * The reason a rendered register may not be written, or throws — the shared
 * accept-guard run over the text that will land (`parseGuardFrontmatter`, the
 * same reader every write path uses). The register is a REPORT: its
 * frontmatter must never carry an acceptance-family key at all, so this uses
 * the stricter payload predicate (`acceptForbiddenReason`) rather than the
 * transition rule — even a carried-forward accepted value is refused, because
 * nothing about this derived artifact is ever accepted.
 */
export function registerAcceptRefusal(text: string): void {
  const fm = parseGuardFrontmatter(text); // throws AcceptForbiddenError on an unclassifiable block
  const reason = acceptForbiddenReason(fm);
  if (reason) throw new AcceptForbiddenError(`register render refused: ${reason}`);
}
