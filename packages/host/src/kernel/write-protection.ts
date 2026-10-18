// write-protection.ts — 01.43 rules 3, 4, 4a–4c and 01.33 rule 6f (Nelson's
// "a", 2026-09-29; the Step 5 table ruled the same day): each write operation
// declares the protection it requires, and the host refuses a call that omits
// it — no write runs unprotected.
//
//   token   the write changes content the caller read ⇒ `if_rev` required
//   key     the write is not naturally idempotent      ⇒ `idempotency_key` required
//   both    both apply
//   exempt  create-if-absent, or a write that reads no note and gives the same
//           result each time (rule 4a) ⇒ nothing required
//
// The requirement is READ FROM THE SURFACE INVENTORY (`protection` on each
// row of inventory-mcp.ts, pinned against the 01.33 table by
// tests/write-protection.test.mjs), never from a second list here: one table
// in code, one in the spec, and a test that holds them together. Obsidian-free,
// so the rule is tested without an app.

import { MCP_SURFACE_INVENTORY, EXTERNAL_PUBLISHER_ROW, type Protection, type ProtectionClass } from "./operations/inventory-mcp.js";
import type { DeclaredProtection } from "./tool-declaration.js";

const BY_TOOL: ReadonlyMap<string, Protection | undefined> = new Map(MCP_SURFACE_INVENTORY.map((r) => [r.tool, r.protection]));

/** The row that rules a tool: the inventory's when it knows the tool, else
 *  what a satellite tool declared (apiVersion 3, tool-declaration.ts). The
 *  inventory wins, so a declaration cannot weaken a host tool. */
function ruleOf(tool: string, declared?: DeclaredProtection): Protection | undefined {
  return BY_TOOL.has(tool) ? BY_TOOL.get(tool) : declared;
}

/** The protection class a call requires, or null when the call itself need
 *  carry nothing (a read, a non-write, the dispatcher, a batch checked per
 *  item, a v2 external tool, or a tool this inventory does not know and that
 *  declared nothing). `declared` is a v3 satellite tool's own declaration. */
export function requiredProtection(tool: string, args: Record<string, unknown>, declared?: DeclaredProtection): ProtectionClass | null {
  const p = ruleOf(tool, declared);
  if (p === undefined) return null;
  if (typeof p === "object") {
    const v = args[p.arg];
    const key = typeof v === "boolean" ? String(v) : typeof v === "string" ? v : undefined;
    // Own keys only (#553 review 1): an inherited name such as "constructor" must not stand in for a rule.
    return (key !== undefined && Object.hasOwn(p.values, key) && p.values[key]) || p.otherwise;
  }
  switch (p) {
    case "token":
    case "key":
    case "both":
    case "exempt":
      return p;
    default:
      return null;
  }
}

/** The code every missing-protection refusal carries. */
export const PROTECTION_REQUIRED = "protection_required";

const TOKEN_HOW =
  "if_rev: the revision of the note as you read it. Read the note first (obsidian_read_note returns `rev`) and pass that value as if_rev; " +
  "the write then fails with rev_conflict instead of overwriting if the note changed since you read it (01.43 rule 3).";
const KEY_HOW =
  "idempotency_key: a new unique string for each intended write (a UUID will do). Reuse the same key only to retry that same write; " +
  "the retry then happens once instead of twice (01.43 rule 4).";

/**
 * The refusal for a call that omits what its operation requires, or null.
 * Names every missing argument and how to get it. A create through
 * obsidian_write_note is exempt, so its refusal also says how to create.
 */
export function protectionRefusal(
  tool: string,
  args: Record<string, unknown>,
  given: { ifRev?: number; idempotencyKey?: string },
  declared?: DeclaredProtection,
): { code: string; message: string } | null {
  const need = requiredProtection(tool, args, declared);
  if (need === null || need === "exempt") return null;
  const missing: string[] = [];
  if ((need === "token" || need === "both") && given.ifRev === undefined) missing.push(TOKEN_HOW);
  if ((need === "key" || need === "both") && (given.idempotencyKey === undefined || given.idempotencyKey === "")) missing.push(KEY_HOW);
  if (missing.length === 0) return null;
  const names = missing.map((m) => m.slice(0, m.indexOf(":"))).join(" and ");
  const createHint =
    tool === "obsidian_write_note"
      ? " To CREATE a new note, set overwrite: false instead; a create needs neither."
      : tool === "obsidian_write_file"
        ? " To CREATE a new file, set overwrite: false instead; a create needs neither."
        : "";
  return {
    code: PROTECTION_REQUIRED,
    message: `'${tool}' requires ${names} (protection '${need}', 01.33 rule 6f). Nothing was written. ${missing.join(" ")}${createHint}`,
  };
}

/**
 * The sentence a tool's schema opens `if_rev` or `idempotency_key` with, when
 * the tool's row requires it — so an agent reading the tool learns the
 * requirement before its first call is refused. Null when the argument is
 * optional for this tool.
 */
export function requirementNote(tool: string, which: "if_rev" | "idempotency_key", declared?: DeclaredProtection): string | null {
  const p = ruleOf(tool, declared);
  if (p === undefined) return null;
  const needs = (c: ProtectionClass) => (which === "if_rev" ? c === "token" || c === "both" : c === "key" || c === "both");
  if (typeof p === "object") {
    const when = Object.entries(p.values).filter(([, c]) => needs(c)).map(([v]) => `${p.arg} is ${v}`);
    if (needs(p.otherwise)) when.push(`${p.arg} is anything else or omitted`);
    return when.length ? `REQUIRED when ${when.join(" or ")} (01.33 rule 6f); a call without it is refused.` : null;
  }
  if (p === "token" || p === "key" || p === "both") {
    return needs(p) ? "REQUIRED for this tool (01.33 rule 6f); a call without it is refused." : null;
  }
  return null;
}

const NEEDS: Record<ProtectionClass, string> = {
  token: "`if_rev`",
  key: "`idempotency_key`",
  both: "`if_rev` and `idempotency_key`",
  exempt: "nothing",
};

/** What a row requires, in words, for the README's table. */
function requirementText(p: Protection): string {
  if (typeof p === "object") {
    const byClass = new Map<ProtectionClass, string[]>();
    for (const [v, c] of Object.entries(p.values)) byClass.set(c, [...(byClass.get(c) ?? []), v]);
    const parts = [...byClass].map(([c, vs]) => `${p.arg} ${vs.join(", ")}: ${NEEDS[c]}`);
    parts.push(`any other ${p.arg}, or none: ${NEEDS[p.otherwise]}`);
    return parts.join("; ");
  }
  switch (p) {
    case "token": case "key": case "both": case "exempt": return NEEDS[p];
    case "not-a-write": return "nothing (not a vault write)";
    case "dispatcher": return "what the tool it calls requires";
    case "per-item": return "per item: `if_rev` to overwrite an existing note; nothing to create one";
    case "external": return "what the tool declares (`protection`, satellite apiVersion 3); a tool that declares nothing (apiVersion 2): not enforced";
  }
}

/**
 * The README's per-tool protection table, rendered from the inventory: one
 * row per write tool, plus the satellite row. The README carries a copy
 * between markers, and tests/write-protection.test.mjs fails when the copy
 * differs from this, so the two cannot drift.
 */
export function protectionTableMarkdown(): string {
  const rows = MCP_SURFACE_INVENTORY.filter((r) => !r.readOnly && r.protection !== undefined)
    .sort((a, b) => a.tool.localeCompare(b.tool))
    .map((r) => `| \`${r.tool}\` | ${requirementText(r.protection!)} | ${(r.protectionNote ?? "").replace(/\|/g, "\\|")} |`);
  rows.push(`| satellite tools (\`vaultmcp_*\`) | ${requirementText(EXTERNAL_PUBLISHER_ROW.protection!)} | Enforced like a host tool's row once declared (#550); the gap that remains is a satellite still on apiVersion 2. |`);
  return ["| Tool | Requires | Note |", "| --- | --- | --- |", ...rows].join("\n");
}
