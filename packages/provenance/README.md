# Vault Provenance (plugin id `vaultmcp-provenance`)

Derived content, given an agent surface: ask whether a generated note is still true to the sources it declares, reconcile the vault's installed Obsidian plugins against the notes that describe them, and regenerate the plugin-audit note without ever touching what a human wrote in it. Like the triage, cross-session and bases satellites and unlike the skills one, this plugin has no human surface at all — no pane, no palette command, no ribbon. Its entire surface is three MCP tools published to the Governor host through `vault-mcp-api`, plus a settings tab for the human who says where the plugin notes live.

The user-facing deep reference — what `derived-from:` means, the two tiers of the deleted-source blind spot, the `derived-source-count` witness, the audit's own frontmatter — is `docs/provenance.md` at the repo root. This file is about the plugin: what is in the package, how it relates to the host, and the four things the extraction changed.

## Lineage

Built as the standalone `obsidian-provenance` Python CLI, folded into the Governor host as its `provenance` capability module, and extracted here as its own plugin in the suite split's mutating tier. It follows `packages/quickadd-choices-compile` (the pilot), the private-tier satellites `packages/skills` (S4), `packages/triage` (S5) and `packages/crosssession` (S6), and the S7 read-tier ones `packages/health`, `packages/vocab` and `packages/bases`. The freshness engine, the reconcile, the renderer, the regen and both write guards are the same code through all three homes; only who mounts them differs.

## Package layout

```text
packages/provenance/
├── manifest.json          plugin id `vaultmcp-provenance`, isDesktopOnly
├── esbuild.config.mjs     bundles src/main.ts → main.js (no assets, no defines)
├── src/
│   ├── main.ts            onload: settings + adoption, settings tab, publishTools (re-published on every config change)
│   ├── settings.ts        settings shape, the 3 field definitions, one-shot host config adoption (pure)
│   ├── settings-tab.ts    the plugin's own settings tab
│   ├── tools.ts           the three tool specs, the injected ProvenanceBackend seam, the two write guards, the ctx
│   ├── obsidian-source.ts the live vault adapter and the glob walker only it uses
│   └── kernel/            the pure core — Obsidian-free, no vault, no clock
│       ├── freshness.ts        FRESH vs STALE, both deleted-source tiers
│       ├── sources.ts          `derived-from` entry resolution (glob vs literal)
│       ├── plugins.ts          the installed / enabled / noted reconcile, both notes layouts
│       ├── render.ts           the audit note's text + human-section preservation
│       ├── regen.ts            regenerate the audit, stamping the source-count witness
│       ├── provenance-config.ts the typed config, its loud validation, degrade-to-default coercion
│       ├── provenance-source.ts the injected read seam + the regen write primitive
│       └── index.ts            the package's kernel re-exports
└── tests/                 101 tests; everything but the Obsidian adapter is headless
```

Installed into a vault this is two files — `main.js` and `manifest.json` — plus, during development, an empty `.hotreload` marker in the installed plugin directory so the hot-reload plugin picks up rebuilds. The `.hotreload` file lives in the vault install, never in this repo.

## Build and test

```bash
npm run build          # esbuild → main.js
npm test               # tsc --noEmit && node --test 'tests/*.test.mjs'
```

`pretest` rebuilds `@vault-mcp/core` first, for the same reason the host's and the other satellites' do: the tests reach a published core contract (the accept-guard) through `packages/core/dist`, so without the rebuild you are testing the previous build's bytes.

## It does NOT work without the host

Same as the triage, cross-session and bases satellites. The three published tools ARE the plugin. With Governor absent it loads, keeps and validates its settings, and does nothing; `publishTools` waits on the host's ready event and registers the moment a host appears. The settings tab says so.

## The four things the extraction changed

### 1. The published tool names changed — and so did one argument name

| shipped by the module  | bare name in this package | published by the satellite   |
|------------------------|---------------------------|------------------------------|
| `provenance_check`     | `check`                   | **`vaultmcp_provenance_check`**     |
| `provenance_reconcile` | `reconcile`               | **`vaultmcp_provenance_reconcile`** |
| `provenance_regen`     | `regen`                   | **`vaultmcp_provenance_regen`**     |

Two compositions produce that. First, the host publishes an external tool as `<sanitized publisher id>_<bare name>`, so **the plugin id and the tool namespace are the same string**, and `vaultmcp-provenance` sanitizes to `vaultmcp_provenance` — the same rename class as triage's, cross-session's and bases'. Second, the bare names shed their `provenance_` prefix, because keeping it would have published the stuttering `vaultmcp_provenance_provenance_check`.

**Beside the tool rename, one ARGUMENT was renamed — twice.** `check`'s `path` became `note_path` at the extraction and is now **`note`**:

| tool | at the fold | extraction (S8) | **now (round 2, 2026-09-07)** | why this spelling |
|---|---|---|---|---|
| `check` | `path` | `note_path` | **`note`** | a READ whose answer enumerates every path the note's `derived-from` globs resolve to — not a host path key, so the host refuses the call outright under an allowlist instead of half-scoping it |
| `reconcile` | — | — | — | no arguments at all |
| `regen` | `write` | `write` | `write` | a boolean; the audit's destination is configuration, named by no argument |

Round 1 (2026-09-07) added `note_path` to the host's path-key list for the tier's MUTATING tools, which briefly made `check` per-path scopable — the exact thing §2 rejects. Round 2 moved it to `note`. None of this is cosmetic; §2 is the argument for it.

**This breaks any agent session or saved prompt that calls the old names, or that passes `path` to the freshness check.** That cost is real and should not be understated: the host's own locked decision says renaming shipped tool names breaks agent sessions for zero semantic gain. What buys it here is that the alternative spelling is actively worse to read and to type, and that the rename is one motion rather than two.

**Reversing the tool names is a one-line change**: `manifest.json`'s `id`, plus the strings in `tests/host-shim.mjs` and the settings tab's status line. Nothing else in the package encodes the prefix — the specs carry BARE names, and the prefix is the host's. **Reversing the argument name is one word**: rename `note` back to `path` (or to `note_path`, which is a host key since round 1) in `src/tools.ts`, at which point `check` becomes host-scoped per-path again and the posture below stops being uniform.

### 2. The allowlist boundary moved to the host, and it closes on the WHOLE surface

The host's external-tool gate is what enforces scope now, and it refuses on two grounds:

- An external tool's `readOnlyHint: true` is a CLAIM the host distrusts unless the publisher's raw plugin id appears in its **`trustedReadOnlyPlugins`** setting. Untrusted, **all three** register as mutating — so **read-only mode blocks all three**, and each takes a write-queue slot and a journal record even though two of them write nothing. Listing `vaultmcp-provenance` in that setting restores read-only-mode availability; it does **not** change the gate below (the trusted exemption was closed 2026-09-05 by the skills satellite's review — trust answers read-only mode, never scoping).
- A mutating external tool whose arguments carry **no recognized path key** is **blocked outright** while a path allowlist is active. The host evaluates this at call time on the ACTUAL ARGUMENTS.

**None of the three tools carries a recognized path key**, so under an active allowlist the entire surface is refused wholesale. `reconcile` takes no arguments and `regen` takes only a boolean, so both were pathless already; `check`'s `path` was **deliberately renamed out of the host's key list** to make the third one match — first to `note_path`, then (once `note_path` itself became a host key at round 1) to **`note`**.

That rename is the decision worth understanding, and it went the opposite way from triage's `target` → `target_path`:

1. **A satellite cannot see the host's allowlist.** `ctx.getSettings` is a dormant seam and nothing supplies it, so this plugin cannot filter anything itself.
2. **Keeping `path` would have bought a check that does not cover the answer.** The host would have scoped the ONE note named — and `check`'s reply still lists every path the note's `derived-from:` globs resolve to, including files the session cannot see. **The host scopes the note you name, not the paths the answer contains.** That is exactly the bases satellite's dormant-row-filter finding, except that there it could only be disclosed and here it can be avoided.
3. **Uniform beats partial.** One tool open and two shut is a posture nobody can state in a sentence, and the one left open is the one that leaks.

**The cost is real and is stated plainly, in the settings tab too: under an active allowlist, provenance is UNAVAILABLE rather than partially available.** With no allowlist configured — the ordinary case, and the live operator's — nothing changes at all.

### 3. Issue #381: this takes the second of three, and one remains

Issue #381 asked whether the host's whole-vault read exception had grown by precedent rather than by decision, and named three tools that scan the entire vault with no allowlist filtering: **`obsidian_health`**, **`provenance_reconcile`** and **`obsidian_conformance_debt`**.

At S7 the health extraction took the first one out of the host. As an untrusted external tool with no recognized path-key argument, `vaultmcp_health_scan` is now blocked WHOLESALE under an active allowlist — stricter than the documented-exception outcome the issue was weighing. That left two.

**This extraction takes `provenance_reconcile` out on the same terms, leaving `obsidian_conformance_debt` alone.** Health was the first, this is the second, one remains — and the remaining one is still owed the enumerate-or-filter decision the issue asked for. [Update 2026-10-14: `obsidian_conformance_debt` has left the host too, as the `vaultmcp-conformance` satellite's `vaultmcp_conformance_debt`, refused outright under an allowlist on the same terms; no tool on #381's list remains in the host. See `packages/conformance/CLAUDE.md`.]

**The issue is NOT closed, and the difference matters.** The reconcile scan still reads the whole vault: it walks `.obsidian/plugins/*/manifest.json`, `.obsidian/community-plugins.json` and every note under the configured notes root, unfiltered, exactly as it did inside the host. That is deliberate — a partial audit is a misleading one, because an unscanned slot reads exactly like a plugin nobody has ever noted — and the argument is unchanged by the move. **What changed is the outcome under an allowlist: the call is now refused outright instead of quietly returning a whole-vault answer.** Fail-closed, not filtered.

### 4. Settings adopt once from the host, and never write back

Configuration used to live in the host's `data.json` at `modules.provenance.config` — the plugin-notes root, the notes layout, and the audit note's path. On first load this plugin copies the recognized keys into its own `data.json` and latches, under the three rules the skills, triage, cross-session and bases satellites established: **it never writes the host's settings**, **it runs once**, and **this plugin's own values win** (adoption fills gaps only). If the host is absent — or present but still mid-onload, with `settings` undefined — nothing is adopted and the latch is not set, so the one chance survives to a later load. **Every failure path holds the latch open**, including a failed write: the latch lives inside the object being persisted, so it is only treated as burned once `saveData` has resolved.

Those two settings are not cosmetic. `notesDir` is the field #257 exists because of — a stale value made the audit scan a folder that no longer existed and report a clean vault it had never looked at — and `auditNote` is a WRITE destination, where a lost value aims a regen at a note the audit does not own (which the destination guard then refuses, loudly, but only after the user has been told the audit is broken).

**There is no second adoption, and that is a checked fact rather than an omission.** Cross-session needed one because it had live operational state outside `data.json` (its per-handle read receipts, in the host's plugin directory). This surface has none: the pure core reads and writes nothing but the four injected vault primitives, nothing in it ever touched the host's plugin directory, and the only write anywhere in the package is one vault NOTE — the audit — which stays exactly where it is across the extraction. The audit's own freshness witness lives in that note's frontmatter, in the vault. Pinned by a test over the settings key set.

## Three smaller consequences worth knowing

**Refusals throw.** A handler returns plain data or throws; the host wraps the first in `ok()` and the second in `fail()`, and `fail()` renders a lowercase-snake `code` off the error as `Error [code]: message`. The module caught everything and handed it to the same `fail()`, so the rendering is reproduced by letting the same errors propagate: `AcceptForbiddenError` keeps its `accept_forbidden` code, `AuditDestinationError` stays deliberately uncoded (`Error: refusing to regenerate over …`), and a kernel throw — a note with no `derived-from`, an unparseable `generated` — stays a bare `Error: …`. **Two codes are new**, and both name refusals that could not fire before: `invalid_argument` (an empty, missing or non-string `note`) and `invalid_path` (a backslash in it). As a module the zod bound ran inside the host's own registration; across the publishing boundary it does not survive, so the check moved into the handler and needed a name.

**Schema bounds are re-applied in the handler.** The SDK converts a zod shape to JSON Schema and the host converts it back through a deliberately small subset: `type`, `description` and string `enum` survive; `default`, `min`, `max` and `pattern` do not. So `note`'s `.min(1)` runs again in the handler, where it actually executes. This is the `vaultmcp_skills_release` semver lesson, applied before it could bite. The backslash refusal rides the same check, for the reason the triage and bases satellites adopted it: every check downstream splits on `/` alone, so a backslash reads as one opaque segment here and as a traversal to whatever normalizes it later.

**`regen` now reports its effect.** A successful write returns `filesChanged: 1` and `files: [<audit note>]` beside the unchanged `written` key. This is additive, and it is the host's `reportedEffects` convention: the audit's destination is CONFIGURATION and never a call argument, so the journal's argument-derived `target` is empty for this tool and this is the only way the file actually written reaches the record's `effects` field. A dry run reports no effects, because "would change" is not "changed".

## What the host still owns

Everything a published tool rides through: the guarded registration point, read-only mode, the path allowlist, the serialized write queue, the write journal, `if_rev` / `idempotency_key` / `intent`, advisory locks, and record immutability. Publishing does not exempt a tool from any of it — which is also why an untrusted read-only claim costs `check` and `reconcile` a queue slot and a journal record apiece.

**There is exactly one write path in this plugin**, and it is inside `regen`'s handler, which is only ever reached through the host. No palette command, no ribbon, no pane touches `app.vault`. Before that write runs, two guards do: the destination guard (is this note ours to rewrite?) and the shared accept-forbidden transition guard (would the rendered frontmatter introduce or change an acceptance assertion?). Both throw, and nothing is written.

What this plugin owns is the freshness model, the `derived-from` resolution, the source-count witness, the plugin reconcile in both notes layouts, the audit's text and its human-section preservation, both write guards, and its own settings.

## The full ledger on the argument rename

**ACTED ON, in two rounds — and this package ended where it started, deliberately.**

**Round 1 (2026-09-07):** the host added `note_path` to its path-key list. The ledger below is why, and it was written before anyone acted on it — the three checks are not allowlist-gated, so a pathless single-note WRITE lost them on every vault.

**Round 2 (2026-09-07), after an independent review:** round 1 reached further than its reason. The three checks it restores all bind at the MUTATING dequeue, so they buy a READ nothing — while making `check` per-path scopable re-created the exact oracle §2 exists to close. So `check`'s argument is `note`, this package carries no host path key again, and §2's fail-closed posture is what ships. The mutating tools elsewhere in the tier (`vaultmcp_fileclass_set`, `vaultmcp_jd_scaffold_promote_to_folder`, `vaultmcp_jd_scaffold_reindex_category`) keep `note_path` for exactly the reason the ledger gives. **The rule extracted from all three spellings, and the thing to carry forward: path-key an argument iff the tool MUTATES the note it names.**

**The ledger below is kept in full.** It is not obsolete: it is the argument that made round 1 correct, and anyone proposing to move either half has to answer it.

**The rename costs more than allowlist availability, and the ledger has to be complete.** The host's path-key list is not the allowlist's private walker: the same list feeds three other kernel checks — record immutability (a mutating call that NAMES a note carrying `record: true` is refused before it runs), the advisory-lock consult (a foreign scope claim covering a named path is disclosed on the call), and the journal record's argument-derived target path. With no argument in the host's path-key list, all three see an empty path list on every call this plugin makes. So a `record: true` note is no longer protected from this plugin's writes by that check; a foreign claim covering the note is no longer disclosed; and the journal names no target path, mitigated only where a handler returns `filesChanged` / `files`, which the kernel records as the operation's effects. **None of those three is gated on an allowlist**, so they are lost in the ordinary, no-allowlist case too — the opposite direction from the tightening above, and not something to fold into it as if the change were strictly stricter. The record guard's own documented posture is already fail-open and "protective, not load-bearing", so this widens a gap that was open by design rather than closing one. It is still a real reduction, it is the strongest argument for reversing the rename, and the reversal is one word per tool.
