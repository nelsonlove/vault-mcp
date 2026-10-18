// tool-declaration.ts — what a satellite tool declares about its writes (satellite
// apiVersion 3, #550): the protection it requires, how the Sync guard treats it,
// and which of its arguments carry vault paths.
//
// A host tool states these facts in its row of the surface inventory
// (inventory-mcp.ts: `protection`, `syncKind`) and in the Sync guard's two
// lists (sync-guard.ts: `STATUS_STRICT`, `DESTINATION_UNNAMED`). A satellite
// tool's name is computed at run time and has no row, so until apiVersion 3 it
// was checked for none of them. A v3 tool declares them on its spec; the
// external-tool registry validates the declaration (fail closed) and attaches
// the frozen result to the definition it registers, under the symbol below, and
// the guard (mcp/guarded.ts), the protection rule (write-protection.ts) and the
// Sync guard read it there.
//
// THE INVENTORY WINS. A declaration is consulted only for a tool the inventory
// does not know, so no declaration can weaken a host tool's row. Satellite
// names cannot collide with the inventory anyway (F1 refuses `obsidian_*`), so
// this is a backstop, not a rule anyone meets.
//
// Obsidian-free, so the rule is tested without an app.

import type { ProtectionClass, SyncKindSpec } from "./operations/inventory-mcp.js";

/** The kernel argument names: peeled off every mutating call by the guard
 *  (mcp/guarded.ts re-exports this), so no tool argument and no declared
 *  argument may be named after one. Here, not in guarded.ts, so the external-tool
 *  registry can read it without importing the guard and the kernel. */
export const KERNEL_ARG_KEYS = ["if_rev", "idempotency_key", "intent"] as const;

/** The protection a v3 tool may declare: a class, or argument-dependent exactly like an inventory row. */
export type DeclaredProtection =
  | ProtectionClass
  | { arg: string; values: Record<string, ProtectionClass>; otherwise: ProtectionClass };

/** How the Sync guard treats a v3 tool: its kind, and its membership in the guard's two lists. */
export interface DeclaredSync {
  kind: SyncKindSpec;
  /** On the strict list (`STATUS_STRICT`): a rename, move or delete that waits (up to `strictWaitSeconds`) for "Fully synced" or Sync's idle flags. */
  strictStatus: boolean;
  /** On the destination-unnamed list: a server change waiting anywhere in the vault counts. */
  destinationUnnamed: boolean;
}

/** What the host enforces for one registered satellite tool. Every field absent means "a v2 tool". */
export interface ToolDeclaration {
  protection?: DeclaredProtection;
  sync?: DeclaredSync;
  /** The argument names that carry vault paths; every one is a key the guard's path walk recognizes. */
  paths?: readonly string[];
}

/**
 * The key a registered definition carries its declaration under. A symbol, so
 * it never reaches the MCP wire (the SDK reads only the named fields of a
 * definition) and no tool's own schema or annotations can collide with it.
 * Object spread copies it, so it survives `withKernelArgs` and the strict-write
 * wrapping on its way to the guard.
 */
export const TOOL_DECLARATION: unique symbol = Symbol("vault-mcp.tool-declaration");

/** The declaration a registered definition carries, or undefined (a host tool, or a v2 satellite tool). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function declarationOf(def: any): ToolDeclaration | undefined {
  const d = def?.[TOOL_DECLARATION];
  return d && typeof d === "object" ? (d as ToolDeclaration) : undefined;
}
