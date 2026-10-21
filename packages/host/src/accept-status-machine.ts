// accept-status-machine.ts — how the host reads a note's declared status
// machine for the accept guard's allowed-agent append (@vault-mcp/core,
// `setAcceptStatusTableLookup`).
//
// WHERE THE MACHINE RUNS TODAY. On a human verify, the vault's own Verify verb
// (a QuickAdd script in the vault, not code in this repository) works out the
// status move from the class's `status-transitions` table and writes it in the
// same write as the `verified` entry. Neither this host nor the governance
// provider runs that machine on a `verified` entry. So the allowed-agent append
// gets the SAME rule, run inside the guard: core's `verifyStatusMove` is the
// verb's step 7, and this file supplies the one fact core cannot reach — the
// table the note's class chain declares.
//
// HOW THE TABLE IS FOUND, and nothing here names a folder. The class notes are
// found through the vault's own construction module, the one
// `obsidian_create_note` already loads from the `createNoteFlow` setting
// (`fileclass-render`'s `definitions`); the note's class is read from the key
// the fileclass plugin is set to use (`fileClassAlias`, else `fileClass`), as
// the verb reads it. With no module set, or one that fails to load, the
// machine is `unavailable` and the guard refuses an agent entry that needs it:
// fail closed.

import type { App } from "obsidian";
import { resolveStatusTransitions, type StatusTableLookup, type StatusTableLookupResult } from "@vault-mcp/core";
import { loadFlowModules, type FlowModules } from "./mcp/tools-create-note.js";

/** The frontmatter key that names a note's class: the fileclass plugin's alias, else `fileClass` (the verb's rule). */
export function classKeyOf(app: App): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alias = (app as any).plugins?.plugins?.fileclass?.settings?.fileClassAlias;
  return typeof alias === "string" && alias.trim() ? alias : "fileClass";
}

/** The note's class: the first value of the class key, as text (the verb's `classChain` first step). */
export function noteClassOf(fm: Record<string, unknown>, classKey: string): string | null {
  const first = ([] as unknown[]).concat(fm[classKey] ?? []).map((v) => String(v)).filter(Boolean)[0];
  return first ?? null;
}

/**
 * Build the lookup the host hands to core. `flowPath` is read on every call, so
 * a settings edit takes effect on the next write; `load` is injected for tests.
 */
export function makeStatusTableLookup(
  app: App,
  flowPath: () => string,
  load: (app: App, flowRel: string) => FlowModules = loadFlowModules,
): StatusTableLookup {
  return (fm): StatusTableLookupResult => {
    const rel = (flowPath() ?? "").trim();
    if (!rel) return { state: "unavailable", why: "the createNoteFlow setting is empty, so the vault's class notes cannot be read" };
    let mods: FlowModules;
    try {
      mods = load(app, rel);
    } catch (e) {
      return { state: "unavailable", why: `the vault's construction module could not be loaded (${(e as Error)?.message ?? String(e)})` };
    }
    const read = mods.classFrontmatter;
    if (typeof read !== "function") return { state: "unavailable", why: "the vault's construction module does not read class notes" };
    return resolveStatusTransitions(noteClassOf(fm, classKeyOf(app)), (name) => read(app, name) ?? null);
  };
}
