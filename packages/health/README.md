# Vault Health (plugin id `vaultmcp-health`)

A read-only vault health scan, given an agent surface: broken links tiered by how safe they are to fix, empty and near-empty notes, orphan attachments, exact-duplicate note groups, and low-signal tags — for the whole vault, or with findings restricted to one folder. Like the triage and cross-session satellites and unlike the skills one, this plugin has no human surface at all — no pane, no palette command, no ribbon. Its entire surface is two MCP tools published to the Governor host through `vault-mcp-api`, plus a settings tab for the one number a human configures.

It never writes. There is no mutating registrar, no write guard and no accept/approve verb anywhere in the package: the scan emits findings, and the fixing is a separate skill.

## Lineage

Born as the standalone `obsidian-vault-health` Bash + Advanced-URI-`eval` scanner: launch Obsidian, wait for `metadataCache` to settle, read the resolver through one `eval`, quit. Folded into the Governor host as the `health` capability module, which deleted that whole launch/readiness/quit dance — a plugin simply holds a live `app.metadataCache`. Extracted to its own plugin at the suite split's **S7**, the read-tier satellites, following `packages/quickadd-choices-compile` (the pilot), `packages/skills` (S4), `packages/triage` (S5) and `packages/crosssession` (S6). The tiered classifier is the same code through all three homes; only who mounts it differs.

## Package layout

```text
packages/health/
├── manifest.json          plugin id `vaultmcp-health`, isDesktopOnly
├── esbuild.config.mjs     bundles src/main.ts → main.js (no assets, no defines)
├── src/
│   ├── main.ts            onload: settings + adoption, settings tab, publishTools (re-published on every config change)
│   ├── settings.ts        settings shape, the one field definition, one-shot host config adoption (pure)
│   ├── settings-tab.ts    the plugin's own settings tab
│   ├── tools.ts           the two tool specs, the injected HealthSource seam, the ctx
│   ├── obsidian-source.ts the live vault adapter (metadataCache + the vault adapter) — read-only
│   └── kernel/            the pure core — Obsidian-free, no vault, no clock
│       ├── scan.ts          the tiered-findings scanner + the scope post-filter + the summary
│       ├── health-source.ts the injected-source seam every read goes through
│       ├── health-config.ts the typed config, its loud validation, degrade-to-default coercion
│       └── index.ts         the package's kernel re-exports
└── tests/                 46 tests; everything but the Obsidian adapter is headless
```

Installed into a vault this is two files — `main.js` and `manifest.json` — plus, during development, an empty `.hotreload` marker in the installed plugin directory so the hot-reload plugin picks up rebuilds. The `.hotreload` file lives in the vault install, never in this repo.

## Build and test

```bash
npm run build          # esbuild → main.js
npm test               # tsc --noEmit && node --test 'tests/*.test.mjs'
```

`pretest` rebuilds `@vault-mcp/core` first, for the same reason the host's and the other satellites' do: the tests reach published core contracts (`isVisible`, and through the tools `resolveScope`) via `packages/core/dist` — the COMPILED output. Without the rebuild you are testing the previous build's bytes.

## It does NOT work without the host

Same as the triage and cross-session satellites. The two published tools ARE the plugin. With Governor absent it loads, keeps and validates its one setting, and does nothing; `publishTools` waits on the host's ready event and registers the moment a host appears. The settings tab says so.

## The five things the extraction changed

### 1. The published tool names changed, and that was a deliberate trade

| shipped (as a Governor module) | bare name in this package | published (as a satellite) |
|---|---|---|
| `obsidian_health` | `scan` | `vaultmcp_health_scan` |
| `obsidian_lint`   | `lint` | `vaultmcp_health_lint`  |

**This breaks any agent session or saved prompt calling the old names.** Say it plainly rather than burying it: an agent that calls `obsidian_health` now gets an unknown-tool error, and every skill, saved prompt or runbook naming the old spellings has to be updated. The host's own locked decision says renaming shipped tool names breaks agent sessions for zero semantic gain, so the trade needs a reason.

Two compositions produce the new names. The host publishes an external tool as `<sanitized publisher id>_<bare name>`, so **the plugin id IS the tool namespace** (`vaultmcp-health` → `vaultmcp_health`); and the BARE names shed their `obsidian_` prefix, on exactly the grounds the bases satellite used for shedding `base_` — **`obsidian_` was the HOST's built-in tool namespace, never this module's own name**, so carrying it into a satellite's namespace would publish a tool named after two owners: `vaultmcp_health_obsidian_health`.

**Keeping the old bare names was available and was declined.** It is worth stating precisely, because the opposite claim is easy to make and wrong: the host's F1 check tests the **published** name, not the bare one — `const toolName = ${owner}_${spec.name}; if (toolName.startsWith("obsidian_")) throw` — and `vaultmcp_health_obsidian_health` does not start with `obsidian_`, so it would have registered fine, just stutteringly (`NAME_RE` accepts the bare `obsidian_health` too). Nothing forced this rename. What buys it is that the stuttering alternative is worse to read and to type, and that the prefix named the wrong owner.

**Reversing it is a one-line change** — `manifest.json`'s `id` for the prefix, plus the strings in `tests/host-shim.mjs` and the settings tab's status line; the bare names live only in `src/tools.ts` and those same two places. Nothing else in the package encodes either half. Pinned by the `publication` test.

### 2. The allowlist boundary moved to the host, and it closes on the WHOLE surface

The host's external-tool gate is now what enforces scope, and it refuses on two grounds:

- An external tool's `readOnlyHint: true` is a CLAIM the host distrusts unless the publisher's raw plugin id appears in its **`trustedReadOnlyPlugins`** setting. Untrusted, **both** tools register as mutating — so read-only mode blocks them, and each call takes a write-queue slot and a journal record even though nothing is written.
- A mutating external tool whose arguments carry **no recognized path key** is **blocked outright** while a path allowlist is active — trusted or not. The trusted exemption was closed 2026-09-05 by the skills satellite's review: trust answers read-only mode, never scoping.

Per tool, precisely:

| tool | arguments | under an active path allowlist |
|---|---|---|
| `vaultmcp_health_scan` | none | blocked outright (nothing to scope by) |
| `vaultmcp_health_lint` | `scope` (not a path key) | blocked outright (nothing to scope by) |

Adding `vaultmcp-health` to `trustedReadOnlyPlugins` restores availability in read-only mode and stops the journal recording reads as writes. It does **not** make either tool available under an allowlist.

**`scope` was deliberately NOT renamed into a path key**, which is the decision that distinguishes this extraction from triage's `target` → `target_path`. Three reasons, in order of weight:

1. **It is not the path of anything the tool reads.** `scope` is a folder PREFIX and a filter over FINDINGS. The scan reads the whole vault by design; the scope only narrows what is REPORTED. Path-keying it would hand the guard a string that does not describe the read.
2. **It would be the illusion of a check.** The host guard would let a scoped `lint` through while the underlying scan still read every note — exactly the trap the cross-session extraction named when it declined to path-key `channel`.
3. **The `to` → `to_address` precedent runs the other way.** The host renamed AWAY from a path key when the argument was not a path. `scope` is at least path-shaped, but `lint` accepts a folder OR a note path, and the guard would still be answering the wrong question about the wrong read.

Read tools blocked wholesale under an allowlist is the documented posture, not a bug — the same one `vaultmcp_triage_queue`, all four `vaultmcp_crosssession_*` tools and five of the six `vaultmcp_skills_*` tools carry.

### 3. Issue #381's whole-vault-read question is RESOLVED for these two tools

Issue **#381**, "The whole-vault read exception has grown by precedent, not by decision", names exactly three tools that scan the entire vault with no allowlist filtering — **`obsidian_health`**, `provenance_reconcile` and `obsidian_conformance_debt` — each with an inline comment arguing a partial scan would be misleading, and none of them enumerated in `packages/host/CLAUDE.md`'s exception list. It asks for one of two things: enumerate them as accepted exceptions, or decide one or more should filter.

For this satellite's two tools the question is now moot, and the honest framing is:

- **The whole-vault read is unchanged in the code.** `scanHealth` still reads every note, and the settings accessor was always declared-and-deliberately-unapplied to the scan. The argument for that is still correct and the code still relies on it: a partial health report misreports orphans (an attachment referenced from outside the allowlist would read as orphaned) and loses duplicate-group members.
- **What changed is WHERE the boundary is enforced.** As untrusted external tools with no recognized path-key argument, both are **blocked wholesale by the host's F3 gate while a path allowlist is active** — which is STRICTER than the documented-exception outcome #381 was weighing, and stricter than the in-module non-filtering it replaces. With NO allowlist configured nothing changes at all, because there was nothing to filter against.
- **So #381's three-tool list shrinks to two** — `provenance_reconcile` and `obsidian_conformance_debt`, both still in the host, both still owed the enumerate-or-filter decision the issue asks for. [Update 2026-10-14: `obsidian_conformance_debt` has left the host too, as the `vaultmcp-conformance` satellite's `vaultmcp_conformance_debt`, refused outright under an allowlist on the same terms; no tool on #381's list remains in the host. See `packages/conformance/CLAUDE.md`.] This paragraph is written for the issue's reader: the health entry can be struck, and it was struck by a structural change rather than by an argument.

This claim is about `vaultmcp_health_*` only. The sibling read-tier extractions (vocab, bases) are not on #381's list and nothing here says anything about them.

### 4. `resolveScope` was published into `@vault-mcp/core`, not copied

`obsidian_lint` hand-guards its bare `scope` argument, because `scope` is not in the host guard's `PATH_KEYS` and `guardCall` therefore never sees it. That guard is the record of a real bug: until 2026-08-29 the tool did not check `scope` at all, and a session allowlisted to `Projects/` could lint `Archive/Secrets` and get back that folder's dangling-link text, orphan-attachment paths, empty-note paths and duplicate-group paths. The fix routed lint through the same resolver `obsidian_check_links` uses, deliberately, rather than a second hand-rolled copy.

A satellite cannot import host internals, which left two options: copy the resolver, or publish it. It was **published** — `packages/core/src/scope.ts`, exported from `@vault-mcp/core` — for the reason `isVisible` (S4) and `executeQuickAddChoice` (S5) were: a forked guard predicate is the drift this repo has already paid for three times, and a copy that normalizes differently is a bypass nobody notices until it is a leak.

The move is behaviour-preserving by construction (the host's version called `guardCall({isMutating: false, args: {path: prefix}})`, whose whole dependency reduced to `isVisible`), and it gained **one new refusal**: a scope containing a **backslash** now refuses `invalid_scope`, because every downstream check splits on `/` alone and `Projects\..\..\Secrets` reads as one opaque segment here and as a traversal to whatever normalizes it later. Both callers — the host's `obsidian_check_links` and this plugin's `lint` — got stricter in the same motion, which is the point of there being one copy.

**The in-handler guard stays even though it is redundant under an allowlist** (the host's F3 gate has already refused the call). Without an allowlist — the configuration the operator actually runs — it is the only thing validating the scope at all: absolute, `..`-escaping, whitespace-padded, backslashed, and normalizes-to-nothing scopes are all refused typed rather than silently repaired or quietly reported as empty. A zeroed report for a hidden folder and a zeroed report for a genuinely clean one are indistinguishable, which is why the refusal is the more honest answer.

### 5. One adoption, and the config is read per call

Configuration used to live in the host's `data.json` at `modules.health.config` — one field, the empty-note character threshold. On first load this plugin copies it into its own `data.json` and latches, under the three rules the skills, triage and cross-session satellites established: **it never writes the host's settings**, **it runs once**, and **this plugin's own values win**. If the host is absent — or present but still mid-onload, with `settings` undefined — nothing is adopted and the latch is not set, so the one chance survives to a later load.

**There is no second adoption, and that is a checked fact rather than an omission.** Unlike cross-session's read receipts, the health module kept nothing on disk: no baseline, no cursor, no receipts. Every call recomputes the whole scan from Obsidian's live metadata cache and the notes themselves, so `modules.health.config` is the entire migration surface.

The handlers read that config through a **thunk, per call**. As a module the tool specs were rebuilt per connection, so a settings edit landed on the next agent connect; as a satellite there is no per-connection rebuild at all, so the module's registration-time `healthConfigOf(ctx.config)` capture would have frozen the threshold at plugin load forever. That was a real bug and it was fixed in the move. The tool DESCRIPTIONS still render the configured threshold and are necessarily build-time snapshots — which is why `main.ts` disposes and re-publishes on every settings write.

## Two smaller consequences worth knowing

**Refusals throw.** A handler returns plain data or throws; the host wraps the first in `ok()` and the second in `fail()`, and `fail()` renders a lowercase-snake `code` off the error as `Error [code]: message` — the same shape the module's `codedError` produced. The two ported refusals are byte-compatible with the folded era: `invalid_scope` and `out_of_allowlist` carry the same codes and the same message text, because `resolveScope`'s move into core reproduced the old `guardCall`-derived strings verbatim. Two things are additions rather than replacements: `invalid_argument` (the module had no re-applied schema bound to refuse with) and the backslash instance of `invalid_scope` (see §4).

**Schema bounds are re-applied in the handler.** The SDK converts a zod shape to JSON Schema and the host converts it back through a deliberately small subset: `type`, `description` and string `enum` survive; `default`, `min`, `max` and `pattern` do not. So `scope`'s `.min(1)` runs again in the handler, where it actually executes. This is the `vaultmcp_skills_release` semver lesson, applied before it could bite.

## Caveats that travel with the findings

Carried over from the standalone scanner's README, surfaced in the tool descriptions so a consumer scopes repoints safely:

- **A unique-basename match is not proof a link should be repointed.** In a large vault with vendored, knowledge-base or template trees, a `[[core.el]]`-style path reference can coincidentally match an unrelated note. Scope auto-safe repoints to authored areas.
- **Orphan attachments include files referenced only via frontmatter or CSS.** Those references are not in Obsidian's `resolvedLinks`. Verify before trashing, and protect sensitive trees.

## What the host still owns

Everything a published tool rides through: the guarded registration point, read-only mode, the path allowlist and its F3 pathless-tool block, the serialized write queue, the write journal, `if_rev` / `idempotency_key` / `intent`, advisory locks, and record immutability. Publishing exempts a tool from none of it.

**There is no write path in this plugin at all.** No palette command, no ribbon, no pane touches `app.vault`; the Obsidian adapter's only vault operations are `adapter.read` and `adapter.stat`, and the metadata cache is read, never mutated.

What this plugin owns is the tiered classifier, the scope post-filter, the empty/duplicate body computation, and its one setting.
