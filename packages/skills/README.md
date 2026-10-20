# Vault Skills (plugin id `vaultmcp-skills`)

Compiles the vault's skill / agent / policy / command notes into a Claude Code plugin and materializes it to disk. Two surfaces over one compiler core: an in-Obsidian human surface (a preview pane, six palette commands, a ribbon icon, opt-in export-on-save) and an agent-facing surface of six MCP tools published to the Governor host.

The user-facing deep reference — the flat output model, the multi-valued `parent:` edge, `preload:` semantics, `no-skills:` — is `docs/skills.md` at the repo root. This file is about the plugin: what is in the package, how it relates to the host, and the two things the extraction changed.

## Lineage

Written as the standalone `obsidian-vault-skills` plugin, folded into the Governor host as a capability module (`modules.skills`, issue #82), and extracted back out to its own plugin at the suite split's S4 — the design doc's `docs/suite-split-design.md` §6 row *"Skills compiler | private operator | satellite — the biggest single extraction; least entangled"*. It follows `packages/quickadd-choices-compile`, the pilot satellite. The compiler code is the same code through all three homes; only who mounts it differs.

## Package layout

```text
packages/skills/
├── manifest.json          plugin id `vaultmcp-skills`, isDesktopOnly
├── esbuild.config.mjs     bundles src/main.ts → main.js; embeds assets/new-skill/*
├── assets/new-skill/      the bundled "new-skill" skill the exporter emits
├── src/
│   ├── main.ts            onload: settings + adoption, settings tab, wiring, publishTools
│   ├── settings.ts        settings shape, the 11 field definitions, one-shot host adoption (pure)
│   ├── settings-tab.ts    the plugin's own settings tab
│   ├── tools.ts           the six tool specs, obsidianSkillsBackend, guardSkillsMark
│   ├── wiring.ts          pane registration, ribbon, six commands, export-on-save
│   ├── pane.ts            the preview pane
│   ├── commands.ts        validate / tree / mark / release command bodies + modals
│   ├── export-trigger.ts  the debounce and the change-relevance predicate (Obsidian-free)
│   ├── version.ts         bumpPatch (Obsidian-free)
│   └── kernel/            the pure compiler core — Obsidian-free, over an injected SkillsSource
│       ├── transform.ts   the tree, the parent/preload/no-skills model
│       ├── exporter.ts    analyzeVault / previewVault / runExport
│       ├── transclude.ts  ![[…]] resolution + stripFrontmatter
│       ├── assets.ts      the supporting-files tree
│       ├── skills-config.ts   the typed config + validation
│       ├── skills-source.ts   the injected read seam
│       ├── static-skills.ts   the compiled-in new-skill + hooks.json
│       └── index.ts
└── tests/                 82 tests; everything but the Obsidian adapter is headless
```

Installed into a vault this is three files — `main.js`, `manifest.json`, and (during development) a `.hotreload` marker file in the installed plugin directory so the hot-reload plugin picks up rebuilds. The `.hotreload` file lives in the vault install, never in this repo.

## Build and test

```bash
npm run build          # esbuild → main.js
npm test               # tsc --noEmit && node --test 'tests/*.test.mjs'
```

`pretest` rebuilds `@vault-mcp/core` first, for the same reason the host's does: several tests import published core contracts from `packages/core/dist`, so without the rebuild you are testing the previous build's bytes.

## Nothing unaccepted compiles, and nothing compiles until the operator names their classes and folders

A typed note compiles only when a human has verified it (a `verified` entry naming a `human:` actor); the excluded notes are counted and named on every surface. The rule and its pins are in `CLAUDE.md` and `docs/skills.md`.

Since #404 the plugin ships no vault convention: the type map (`<vault type> = skill|agent|policy|command`) and the folders to compile (`includeRoots` / `excludeRoots`) are settings with EMPTY defaults, and the compile, the preview and the settings validation say so loudly rather than compile nothing in silence. The kernel keeps an identity map for its direct callers, so `analyzeVault` / `runExport` over bare `type: skill` notes are unchanged. `tests/skills-settings-404.test.mjs` holds the switch test the fleet runs before retiring the `~/.claude/agents` symlink: with the rank folder as the only root and `Person/Agent = agent`, exactly the rank definitions compile. The full account is `docs/skills.md` ("Config") and the locked decision in `CLAUDE.md`.

## It works with no host installed

The pane, the commands, the ribbon, and export-on-save are pure Obsidian plus the compiler core. With Governor absent all of that still works; only the six MCP tools go unpublished, and they appear on their own the moment a host loads (the SDK registers on the host's ready event). `main.ts` registers the human surface before it publishes, so the claim and the code agree.

## The two things the extraction changed

### 1. The allowlist boundary moved to the host — and got stricter

While skills was a module, `vaultmcp_skills_preview` filtered the compiled BODIES it returned by each contributing note's visibility under the host's path allowlist. That filter is still in `src/tools.ts`, in full, and nothing was deleted from it — but it is **defence in depth now, not the enforced boundary**, and in the shipped configuration it does nothing at all: a satellite cannot reach the host's guard settings, so `ctx.getSettings` is undefined and the filter degrades through exactly the `!settings ||` branch it always had.

The enforced boundary is the host's external-tool gate, and it refuses more than the filter ever did:

- An external tool's `readOnlyHint: true` is a CLAIM the host distrusts unless the publisher's raw plugin id appears in the host's `trustedReadOnlyPlugins` setting. Untrusted, all six of these register as **mutating**.
- A mutating external tool whose arguments carry **no recognized path key** is **blocked outright** while a path allowlist is active — it cannot be scoped, so it is refused rather than guessed at.

Five of the six tools (`validate`, `tree`, `preview`, `export`, `release`) carry no path argument. So under an active allowlist they are refused **wholesale**, where the module version merely filtered `preview`'s bodies. That is fail-closed and it is strictly stricter than before. `vaultmcp_skills_mark` carries `path`, so it is scoped normally by the guard, and it still runs the accept-forbidden guard before any write.

The in-satellite filter is kept because the expensive part of it is correct and hard-won: a compiled body is ASSEMBLED from up to three notes — the entry's own source, everything it transcludes, and every `type: policy` note injected into an agent — and an independent review found the first version of the fix checking only the first of those. That reasoning becomes live again the moment `vault-mcp-api` can carry the caller's scope to a publisher, which is an apiVersion-2 item. Its tests supply `getSettings` themselves so the dormant guard stays honest.

### 2. Settings adopt once from the host, and never write back

Configuration used to live in the host's `data.json` at `modules.skills.config`. On first load this plugin copies the recognized keys into its own `data.json` and latches:

- **It never writes the host's settings** — not to delete the adopted keys, not to mark them migrated. The host's copy stays where it is and simply stops being read.
- **It runs once.** A later host edit cannot reach back in.
- **This plugin's own values win.** Adoption only fills gaps.
- **If the host is absent, nothing is adopted and the latch is not set** — so the one chance survives to a later load, and standalone installs are unaffected.

See `src/settings.ts`; the rules are pinned by `tests/skills-module.test.mjs`.

## The tool names did not change

Each spec in `src/tools.ts` carries a bare name (`validate`, `tree`, `preview`, `export`, `release`, `mark`). The host publishes an external tool as `<sanitized publisher id>_<bare name>`, and `vaultmcp-skills` sanitizes to `vaultmcp_skills` — so the wire names are still exactly `vaultmcp_skills_validate` … `vaultmcp_skills_mark`. That is deliberate: renaming shipped tool names breaks agent sessions for zero semantic gain, which is the host's own locked-decision precedent for `governance_revisions` / `governance_submit_revision`.

## What the host still owns

Everything a published tool rides through: the guarded registration point, read-only mode, the path allowlist, the serialized write queue, the write journal, `if_rev` / `idempotency_key` / `intent`, advisory locks, and record immutability. Publishing does not exempt a tool from any of it. What the satellite owns is the compiler, the human surface, its own settings, and the accept-forbidden guard on `mark` — which runs `acceptTransitionReason` from `@vault-mcp/core`, a published contract, so leaving the host did not leave the guard behind.
