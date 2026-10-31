# The dev tool-runner — "Run tool…"

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


An in-Obsidian way to invoke the host's own tool surface by hand (#217): **one** palette
command — registered as "Run tool…", shown in the palette prefixed with the host plugin's
display name ("Vault MCP: Run tool…") — over the whole surface, not one command per tool — ~70 commands would spam the
palette and, since Obsidian commands are agent-reachable via `obsidian_run_command`, would
multiply the policy surface for zero gain.

Files: `packages/host/src/tool-runner.ts` (the modal chain) and `src/tool-runner-core.ts`
(the pure, headless-tested half: listing, zod-schema → form-field derivation, form parsing,
the run/confirm rules); the command is registered in `main.ts` (`id: run-tool`).

## The chain

1. **Fuzzy picker** over the tools available on the *current* surface. The listing is
   literally the Code Mode `obsidian_search_tools` result with no query (same name / title /
   description haystack), so the picker and a fresh MCP connection agree about what exists.
   Each row carries a `writes` / `read-only` badge from the same `readOnlyHint === false`
   discriminant the guard uses.
2. **Args form**, rendered from the picked tool's own zod input schema: strings and numbers
   as text fields, booleans as a toggle (or an *(omit)/true/false* dropdown when optional),
   enums as text with the options listed, and anything richer (objects, arrays, unions) as a
   raw-JSON textarea. Blank means "omit" for optional fields; parse failures are reported
   per field, all at once. The kernel arguments (`if_rev` / `idempotency_key` / `intent`)
   are excluded from the form — they are declared for agents and peeled by the guard
   wrapper, so a human form has no use for them.
3. **Write confirm**: a mutating tool gets a warning ("This tool writes to the vault. The
   run goes through the same guard, queue and journal as an agent call.") and an explicit
   "This tool writes — run it?" toggle that enables the **Run (writes)** button. A zero-arg
   *read-only* tool runs straight from the picker; a zero-arg *mutating* tool still opens
   the modal for its confirm step.
4. **Result modal**: an error banner for `isError` results (the first text block, where the
   typed codes — `[accept_forbidden]`, `[read_only]`, `[out_of_allowlist]`, … — are
   rendered), elapsed milliseconds, the args as JSON, and the result
   (`structuredContent` pretty-printed when present, else the joined text blocks), with a
   copy button.

## The guarded-pipeline invariant

The runner is **not a second tool surface**. Per invocation it builds a fresh registry via
`buildMcpServer(app, ctx, { codeMode: true, … })` — the same registration path a new MCP
connection runs, so conditional tools (Dataview / Templater / CLI / module tools) and live
settings are reflected — and the built server is connected to no transport; only its
**captured guarded handlers** are used. Invocation goes through `runCapturedTool` →
`callCapturedTool`, the exact function a Code Mode `obsidian_call_tool` delegates to, so the
guard wrapper (read-only mode, the path allowlist, `uid:` addressing and the refusal of the retired `jd:` form, the kernel
queue and journal, the accept-forbidden rule in the write primitives) binds on a runner call
exactly as on an agent call. No raw handler is reachable from the runner.

## Journal identity

Runner runs journal like MCP writes, with the actor's client set to **`tool-runner`**
(`clientLabel: "tool-runner"` in `main.ts`), so a human's runner writes are distinguishable
from agent writes in the audit stream while landing through the identical pipeline.

## Gating

The command is registered regardless of `settings.enabled` (the socket) — dev use with the
transport off is the point — but gated **live** on the `devToolRunner` setting (default
**on**) via `checkCallback`, so flipping the toggle needs no reload. The setting exists so a
locked-down vault can remove the in-app surface; the runner itself grants nothing the MCP
surface doesn't already grant (an agent with `obsidian_run_command` has the MCP tools
directly, under the same guard, and the modal chain requires real UI interaction anyway).
