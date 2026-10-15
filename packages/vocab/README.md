# Vault Vocabulary (plugin id `vaultmcp-vocab`)

The vault's controlled vocabulary given an agent surface: enumerate the configured vocabulary sources, resolve a tag / property key / type name / glossary term to its canonical entry, report a note's own vocabulary, and check one note's frontmatter against the registries. Report-only — nothing here writes to a note. Like the triage and cross-session satellites and unlike the skills one, this plugin has no human surface beyond configuration: no pane, no palette command, no ribbon. Its entire surface is four MCP tools published to the Governor host through `vault-mcp-api`, plus a settings tab for the human who configures what counts as a vocabulary.

## Lineage

Built as the host's `vocab` capability module (`src/kernel/vocab/` + `src/mcp/tools-vocab.ts`). Extracted to its own plugin at the suite split's **S7** — the design doc's `docs/suite-split-design.md` §6 row *"Vocabulary provider | public optional | satellite"*. It follows `packages/quickadd-choices-compile` (the pilot), `packages/skills` (`vaultmcp-skills`, S4), `packages/triage` (`vaultmcp-triage`, S5) and `packages/crosssession` (`vaultmcp-crosssession`, S6).

**The kernel did NOT come with it.** The providers, the registry and the findings live in `@vault-mcp/core` at `packages/core/src/vocab/`, because they have TWO consumers and always did: these four tools, and the HOST's conformance rail (`conformance/packs/vocab.ts` wraps `noteVocabFindings`, `conformance/cli.ts` builds a `VocabRegistry` per run, and `conformance/snapshot.ts` / `rule-pack.ts` are typed over `VocabNote`). That is a dependency on the kernel, not on the user's configured list — the rail runs on `DEFAULT_VOCABULARIES`, which is a separate host fact covered in §5. Two copies of a rule core is how one vault gets two vocabularies, so publishing into core was the only non-forking answer — the `isVisible` (S4) and `executeQuickAddChoice` (S5) precedent. **There is no `src/kernel/` in this package and there must not be one.**

## Package layout

```text
packages/vocab/
├── manifest.json          plugin id `vaultmcp-vocab`, isDesktopOnly
├── esbuild.config.mjs     bundles src/main.ts → main.js (no assets, no defines)
├── src/
│   ├── main.ts            onload: settings + the one-shot adoption, settings tab, publishTools (re-published on every settings write)
│   ├── settings.ts        settings shape, the ARRAY-valued host adoption, and the per-instance form's pure half (parse/coerce/validate/add/remove/update)
│   ├── settings-tab.ts    the plugin's own settings tab — a per-instance LIST editor, not scalar fields
│   ├── tools.ts           the four tool specs, the injected VocabSource seam, the listing builder, the ctx
│   └── obsidian-source.ts the live vault adapter (getFiles + metadata cache + cachedRead)
└── tests/                 52 tests; everything but the Obsidian adapter is headless
```

Installed into a vault this is two files — `main.js` and `manifest.json` — plus, during development, an empty `.hotreload` marker in the installed plugin directory so the hot-reload plugin picks up rebuilds. The `.hotreload` file lives in the vault install, never in this repo.

## Build and test

```bash
npm run build          # esbuild → main.js
npm test               # tsc --noEmit && node --test 'tests/*.test.mjs'
```

`pretest` rebuilds `@vault-mcp/core` first, and here that is load-bearing twice over: the tests reach `isVisible` **and the whole vocabulary kernel** through `packages/core/dist` — the COMPILED output. Without the rebuild you are testing the previous build's bytes.

## It does NOT work without the host

Same as the triage and cross-session satellites. The four published tools ARE the plugin. With Governor absent it loads, keeps and validates its settings, and does nothing; `publishTools` waits on the host's ready event and registers the moment a host appears. The settings tab says so.

## The five things the extraction changed

### 1. The published tool names changed, and the `obsidian_` prefix went with them

| shipped (module)           | bare name in this package | published (satellite)         |
|----------------------------|---------------------------|-------------------------------|
| `obsidian_vocabularies`    | `vocabularies`            | `vaultmcp_vocab_vocabularies`    |
| `obsidian_resolve_term`    | `resolve_term`            | `vaultmcp_vocab_resolve_term`    |
| `obsidian_validate_terms`  | `validate_terms`          | `vaultmcp_vocab_validate_terms`  |
| `obsidian_list_vocabulary` | `list_vocabulary`         | `vaultmcp_vocab_list_vocabulary` |

**This breaks any agent session or saved prompt that calls the old names.** They are gone; the new ones are what the host publishes.

Two separate decisions produced that table. The host publishes an external tool as `<sanitized publisher id>_<bare name>`, so **the plugin id and the tool namespace are the same string**, and `vaultmcp-vocab` sanitizes to `vaultmcp_vocab` — that part is a consequence of the id, exactly like the triage and cross-session renames. Stripping `obsidian_` from the bare names is the second, and it is a CHOICE, not a forced move: the host's F1 check (`external-tools.ts:72-74`) tests the PUBLISHED name for an `obsidian_` prefix, and `vaultmcp_vocab_obsidian_vocabularies` does not start with `obsidian_`, so it would have registered fine. It would just have said the module twice and the namespace not at all — `obsidian_` was the HOST's built-in namespace, never this module's name.

**Reversing the namespace is a one-line change**: `manifest.json`'s `id`, plus the strings in `tests/host-shim.mjs` and the settings tab's status line. Nothing else in the package encodes the prefix — the specs carry BARE names, and the prefix is the host's.

### 2. The allowlist boundary moved to the host — and unlike every prior satellite, it is NOT uniform

The host's external-tool gate is now what enforces scope, and it refuses on two independent grounds:

- An external tool's `readOnlyHint: true` is a CLAIM the host distrusts unless the publisher's raw plugin id appears in its `trustedReadOnlyPlugins` setting. Untrusted, **all four** register as mutating — so **read-only mode blocks all four**, and each takes a write-queue slot and a journal record. Adding `vaultmcp-vocab` to `trustedReadOnlyPlugins` restores read-only-mode availability. It does NOT change anything below: trust answers read-only mode, never scoping (closed 2026-09-05 by the skills satellite's review).
- A mutating external tool whose arguments carry **no recognized path key** is **blocked outright** while a path allowlist is active, trusted or not. Critically, that gate (`external-tools.ts:209-229`) is evaluated **at CALL TIME on the ACTUAL ARGUMENTS** — `settings.allowlist.length > 0 && collectPaths(args ?? {}).length === 0` — not once on the declared schema.

Which makes this surface's posture per-tool, and for one tool per-call:

| tool | arguments | under an active allowlist |
|---|---|---|
| `vaultmcp_vocab_vocabularies` | none | **blocked outright** — nothing to scope by |
| `vaultmcp_vocab_list_vocabulary` | `kind`, `scope`, `vocabulary` | **blocked outright** — none is a path key |
| `vaultmcp_vocab_validate_terms` | `path` (**required**) | **available and scoped** — the host checks `path`; a hidden note refuses `out_of_allowlist` |
| `vaultmcp_vocab_resolve_term` | `path` (**optional**), `token`, `kind`, `parse`, `vocabulary` | **depends on the call** |

That last row is the single most surprising fact about this extraction, so it is worth spelling out. The same tool, in the same session, under the same allowlist:

```jsonc
// BLOCKED — the arguments carry no path key, so the host cannot scope the call
{ "name": "vaultmcp_vocab_resolve_term", "arguments": { "token": "note/task", "kind": "tag" } }

// SCOPED — `path` is a recognized path key, so the host checks it and lets the call through
{ "name": "vaultmcp_vocab_resolve_term", "arguments": { "path": "Projects/Alpha/Note.md" } }
```

`scope` was deliberately NOT renamed into a path key. It is a prefix filter over the *declaring paths of entries already in the listing*, not the path the call reads — handing the guard a prefix while the actual reads stay unscoped is the illusion of a check, the same reasoning that kept `channel` off the path-key list in the cross-session satellite.

**None of this resolves issue #381.** That issue names `obsidian_health`, `provenance_reconcile` and `obsidian_conformance_debt`; vocab is not one of the three, because its listing was already `visiblePaths`-filtered before any read. What is accurate to say is narrower, and it is in both directions — see the next section.

### 3. The dormant `visible` seam costs something real here, and that is stated rather than papered over

`ctx.visible` / `ctx.getSettings` are kept as seams and are NOT supplied in the shipped configuration, exactly like the triage and cross-session satellites' — a published tool cannot consult the host's allowlist, and that is precisely the boundary the split exists to draw. For those two packages it costs nothing enforceable, because the host blocks their whole surface under an allowlist. **Here it costs something, and only two of the four tools are strictly stricter than before.**

- As a MODULE, `buildListing` ran `visible(source.paths())` before any body was read, so a registry note outside the caller's allowlist never entered the providers at all — no entry, no count, no example, no candidate.
- As a SATELLITE, nothing supplies `visible`, so the providers are built from the WHOLE vault listing on every call. For `vocabularies` and `list_vocabulary` that is unreachable and therefore harmless — the host blocks both outright. For the two the host lets through it is reachable: the host scopes the `path` ARGUMENT, but the vocabulary the answer is computed against is not the argument and is named by no argument.

Precisely what a session under an allowlist can learn, which is narrower than a body read and wider than nothing:

- `vaultmcp_vocab_validate_terms` on a VISIBLE note: for each token that note already carries, whether a possibly-hidden registry declares it and whether it is retired — and, through the `ambiguous` finding's detail (which renders `VocabAmbiguousError.candidates`), the PATHS of the registry notes claiming a duplicated token. That last one is a genuine path oracle.
- `vaultmcp_vocab_resolve_term` with `path` on a VISIBLE note: for each token that note already carries, its canonical form, its declaring vocabulary id, and its `definition` gloss — frontmatter text lifted from a registry note that may itself be hidden. Path mode never emits candidate paths (it catches `VocabAmbiguousError` and reports a bare `ambiguous: true`); that is pinned by test.
- For the scope-tags vocabulary the "registry note" is a scope note and the gloss is the description cell of its `## Tags` table row (#551). Its `tag_out_of_scope` finding, which `validate_terms` returns, also names the scope notes that declare the tag and the scope notes on the caller's own chain: the same bounded path disclosure, for a tag the caller's visible note already carries.

Both are bounded by the tokens the caller's own visible note already carries: a session cannot ask "what else is in the hidden registry", only "is this token, which I can already read, registered somewhere". It is still a loosening relative to the folded module, and it is not fixable from inside a satellite. It becomes fixable the day `vault-mcp-api` can carry the caller's scope to a publisher (apiVersion 2), at which point `ctx.visible` goes live with no code change here — which is exactly why the seam is kept, why the tests supply it, and why one test pins what its absence does.

### 4. Refusals throw, and two envelopes changed on purpose

A handler returns plain data or throws; the host wraps the first in `ok()` and the second in `fail()`, and `fail()` renders a lowercase-snake `code` off the error as `Error [code]: message`. `ok` / `fail` / `codedError` are host-internal and are not imported here.

| refusal | before | after |
|---|---|---|
| `token` and `path` given together | `Error: give \`token\` or \`path\`, not both — …` (**codeless**) | `Error [invalid_argument]: …` |
| neither `token` nor `path` given | `Error: give \`token\` (with optional \`kind\`) or \`path\`` (**codeless**) | `Error [invalid_argument]: …` |
| an ambiguous token | `Error [vocab_ambiguous]: …` | unchanged, byte for byte |
| a hidden note named by `path` | `Error [out_of_allowlist]: …` | unchanged, byte for byte |
| a backslash in `path` | — | `Error [invalid_path]: …` (**new**) |
| a backslash in `scope` | — | `Error [invalid_scope]: …` (**new**) |
| a bad `kind`, an empty required string | `Error: …` from zod, or nothing | `Error [invalid_argument]: …` |

The two codeless ones became coded deliberately: they were the only refusals on this surface an agent could not branch on. `invalid_path` and `invalid_scope` are new codes, and they exist because two arguments here are path-shaped strings this package validates BY HAND (the host's guard only recognizes `path` for its own scoping, and `scope` not at all). **A backslash is refused outright** — the `resolveScope` / triage `target_path` precedent: every check downstream splits on `/` alone, so `Notes/x\..\..\Secrets.md` reads as one opaque segment here and as a traversal to whatever normalizes it later, and Obsidian paths never legitimately contain one. `token` and `vocabulary` are deliberately NOT backslash-refused: neither is ever split as a path, compared against a prefix, or handed to `isVisible`, so a backslash in one is an ordinary character that simply fails to resolve.

### 5. The settings moved — a top-level ARRAY, and the form came with it

Configuration did **not** live at `modules.vocab.config`. The host's `VOCAB_MANIFEST` carries no `config:` block at all, and its comment says why: the vocab settings are a LIST of structured instances, which the scalar manifest-field renderer cannot express. The real setting is `settings.vocabularies` — a **top-level** host setting of type `VocabInstanceSettings[]`, defaulted to `DEFAULT_VOCABULARIES`, edited by a bespoke per-instance form in the host's `connection-ui.ts` (`renderVocabInstances`). That form, and its pure helpers, were **removed from the host** at this extraction — they became unreachable the moment the vocab module left `builtinModules` — so this package now holds the only copy of both the list and the editor. A move, not a fork.

On first load this plugin copies that array into its own `data.json` and latches, under the three rules the skills, triage and cross-session satellites established — **it never writes the host's settings**, **it runs once**, and **this plugin's own values win**. For a LIST, that third rule means all-or-nothing: adoption happens only when this plugin has no rows of its own. Merging row-by-row would need an identity to merge on, and the only candidate (`id`) is exactly what a user renames, so a merge would silently resurrect a row they deleted here. If the host is absent — or present but still mid-onload, with `settings` undefined — nothing is adopted and the latch is not set, so the one chance survives to a later load. Structural garbage in the incoming array is dropped; an unknown provider NAME is kept, because the registry and the settings form both need to report it.

**There is no live operator state to migrate.** Unlike the cross-session satellite's receipt file, this surface writes nothing outside its own `data.json` and reads nothing outside the vault — a checked fact, not an omission.

**The host's copy stops being read**, exactly as skills', triage's and crosssession's did. Nothing in the host reads `settings.vocabularies` after S7 — `getVocabularies` is gone from the server context, and the editor is gone with the form. It is nonetheless **still declared and still defaulted** in the host's `main.ts`, deliberately, because it is the adoption source: deleting the field would destroy a user's configuration before the plugin that inherits it had a chance to read it. Removing it is a separate, dated decision for after the adoption window closes. (The host's own `vocabularies` doc comment is the canonical statement of that reasoning.)

**One genuine disagreement remains, and it is Governor's, not the split's.** The conformance rail still depends on the vocabulary KERNEL — that is exactly why the kernel went to `@vault-mcp/core` rather than into this package — but it builds its registry from the **shipped defaults**: all three `runConformance` call sites (`mcp/obsidian-drift-source.ts`, `mcp/obsidian-debt-source.ts`, and `conformance/cli.ts`'s CLI entry) pass `DEFAULT_VOCABULARIES` unconditionally, and none has ever read the user's configured list. So in a vault with a customised vocabulary, the conformance report and these tools can still disagree about what is registered — **not** because two copies of a setting drift apart, but because conformance never read the setting in the first place. That was true before this extraction and is unchanged by it; the split only makes it easy to see. The settings tab flags it as Governor's caveat. Whether conformance should honour the configured list is a live host question, recorded as a finding rather than answered here.

One small, deliberate behaviour change came with the move: **an empty configured list means "use the shipped defaults"**, where in the host an empty array meant "no vocabulary at all". A fresh satellite install starts empty and has no host to adopt from, and doing nothing out of the box is not what installing a vocabulary plugin asks for. (The host's own settings tab already *told* users an empty list falls back to the defaults; that was untrue there and is true here.) Configuring "no vocabulary at all" is what disabling the plugin is for.

## What the host still owns

Everything a published tool rides through: the guarded registration point, read-only mode, the path allowlist and the F3 pathless-tool block, the serialized write queue, the write journal, `if_rev` / `idempotency_key` / `intent`, advisory locks, and record immutability. Publishing does not exempt a tool from any of it. The host also still owns the vocabulary KERNEL's other consumer, the conformance rail — which runs on the shipped defaults, see §5 — and it still stores the old `settings.vocabularies` value, unread, purely as this plugin's adoption source.

**There is no write path in this plugin at all.** No palette command, no ribbon, no pane touches `app.vault`; the four tools read and report and never write, which is the module's original contract carried across unchanged. The only vault access is the injected `VocabSource`, and the live adapter behind it reads only.

What this plugin owns is the four tools, the listing construction (which files a configured vocabulary needs, and which of those need a body read), its own settings, and its own settings UI.
