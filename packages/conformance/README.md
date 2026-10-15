# Vault MCP Conformance (plugin id `vaultmcp-conformance`)

The conformance rail for an Obsidian vault: rule packs run over the vault, the findings are compared with an accepted-debt baseline, and the report keeps new drift apart from debt that is already accepted. It was part of the Vault MCP host until 2026-10-14 and is now a plugin of its own. The full model is in [`docs/conformance.md`](../../docs/conformance.md).

## What it adds

- **`vaultmcp_conformance_debt`** — the read-only debt report: carried items with their sidecar metadata, the carried/cleared/new counts, the stale list and the budget status. Filters: `folder`, `pack`, `check`, `kind`; `group_by` for per-group counts.
- **`vaultmcp_conformance_debt_render`** — writes the debt register note (`Conformance debt.md`, by default beside the baseline). It writes only that note.
- **The Drift pane** — the scheme pack's new findings, grouped by check, with a ribbon icon and the command "Open conformance drift". Refresh is a button.
- **The settings tab** — the vault conventions (the folders the legacy packs measure and the baseline note) and the debt register settings.
- **The CLI** — `npm run conformance -- --root=<vault> …` from this folder, or `node --import tsx src/kernel/main.ts …`.

Both MCP tools are published to the Vault MCP host (plugin id `vault-mcp`) through `vault-mcp-api`, so they need the host. The Drift pane and the tools also need the host's guarded territories, which the plugin reads from the host on each run; with no host answering they refuse to run.

## Package layout

```text
packages/conformance/
├── manifest.json          plugin id `vaultmcp-conformance`, isDesktopOnly
├── esbuild.config.mjs     bundles src/main.ts → main.js
├── src/
│   ├── main.ts            onload: settings + adoption, settings tab, publishTools (re-published on settings writes), the Drift pane
│   ├── tools.ts           the two tool specs over an injected DebtSource
│   ├── settings.ts        settings shape, the one-shot adoption from the host, the debt register fields
│   ├── settings-tab.ts    the plugin's settings tab
│   ├── host-lookup.ts     finds the host; its territories, settings and headless flag
│   ├── obsidian-debt-source.ts / obsidian-drift-source.ts   the live sources (run the engine over the vault on disk)
│   ├── drift-pane.ts      the Drift pane view
│   └── kernel/            the rail: engine, packs, snapshot, ratchet, debt, register, CLI (moved from the host's src/conformance/)
└── tests/                 headless tests; tests/host-shim.mjs stands in for the host's publication
```

## Build and test

```bash
npm run build          # esbuild → main.js
npm test               # builds @vault-mcp/core, then tsc --noEmit && node --test 'tests/*.test.mjs'
```

## What the move changed

1. **Tool names.** `obsidian_conformance_debt` is now `vaultmcp_conformance_debt`, and `obsidian_conformance_debt_render` is now `vaultmcp_conformance_debt_render`. Sessions and prompts that call the old names must be updated.
2. **Under a path allowlist both tools are refused by the host**, because neither takes an argument the host can scope. In the host the report ran over the whole vault under an allowlist, and the render refused only when the register path was outside it. With no allowlist nothing changes.
3. **Settings live here.** On the first load with the host present, the plugin copies the host's `vaultConventions` and `modules["conformance-debt"].config` into its own data.json, once. It does not write the host's settings, and the host no longer reads them.
4. **One new refusal code**, `invalid_argument`, for an empty filter or an unknown `group_by`; the other refusals and the success results are those of the host tools.
5. **The Drift pane is this plugin's**: its view type and command id changed, so a saved workspace drops an open Drift leaf once.
