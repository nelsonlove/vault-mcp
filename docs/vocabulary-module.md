# Vocabulary provider — controlled vocabulary (read-only)

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md). Since the S7 read-tier extraction (`suite-split-design.md` §6) this reference documents the standalone **`vaultmcp-vocab`** plugin, not a module of the host plugin (`vault-mcp`).

The vocabulary provider lets an agent **check a note's tags, properties, types, and glossary
terms against the vault's controlled vocabulary** — and validate them **without writing
anything**. Validation and resolution only; nothing here mutates a note.

Files: `packages/vocab/src/tools.ts` (the four tool specs),
`packages/vocab/src/obsidian-source.ts` (the live vault adapter), `packages/vocab/src/main.ts`
/ `settings.ts` / `settings-tab.ts` (its own settings, its per-instance form, and the one-shot
adoption), and **`packages/core/src/vocab/`** — the pure engine (`provider.ts`, `registry.ts`,
`blueprint.ts`, `glossary.ts`, `scope-tags.ts`, `findings.ts`). Obsidian-import-free above the
adapter; the vault reader arrives as an injected `VocabSource` exposing only `paths()` /
`frontmatter()` / `body()` — enumeration and reads, structurally no write reach.

## Now a satellite plugin — and the engine went somewhere else again

This capability shipped as the host plugin's `vocab` module through 2026-08; as of the S7
extraction it is its own Obsidian plugin, id `vaultmcp-vocab`, publishing its tools to the host
through the `vault-mcp-api` SDK's `publishTools`. **All four tool names changed**, because the
host publishes an external tool as `<sanitized publisher id>_<bare name>` and so the plugin id
IS the tool namespace: `obsidian_vocabularies`, `obsidian_resolve_term`,
`obsidian_validate_terms` and `obsidian_list_vocabulary` are now **`vaultmcp_vocab_vocabularies`**,
**`vaultmcp_vocab_resolve_term`**, **`vaultmcp_vocab_validate_terms`** and
**`vaultmcp_vocab_list_vocabulary`**. The `obsidian_` prefix was the HOST's built-in namespace,
never this module's name, so it was stripped rather than carried into a second owner's
namespace. Sessions and prompts calling the old names must be updated.

**The pure engine did NOT move into the plugin — it moved into `@vault-mcp/core`.** It has two
consumers and always did: these four tools, and the conformance rail (the host's at the time,
the `vaultmcp-conformance` plugin since 2026-10-14), where
`kernel/packs/vocab.ts` wraps `noteVocabFindings`, `kernel/cli.ts` builds a
`VocabRegistry` per run, and `snapshot.ts` / `rule-pack.ts` are typed over `VocabNote`. Copying
it would have been the failure the split exists to avoid — two copies of a vocabulary rule core
is how one vault ends up with two vocabularies — so it was published instead, on the same
precedent as `isVisible` (S4) and `executeQuickAddChoice` (S5). Conformance became a satellite
too, so core is where both consumers meet.

**One pre-existing gap the extraction makes visible, and does not create:** the conformance rail
builds its registry from `DEFAULT_VOCABULARIES`, not from the configured instance list. It never
read the user's configured vocabularies, so conformance findings and these tools can disagree
about what is registered. That is a question for the conformance rail, recorded here because this is where a reader
would look for it.

## What it validates

Four kinds — `VocabKind = "tag" | "property" | "type" | "term"` — served by three providers:

- **scope-tags** (`scope-tags.ts`, #251) serves **`tag`** — the live per-scope whitelist model,
  two independent gates over the vault's own declarations:
  1. *existence* — a tag exists iff a registry note (`fileClass: Meta/Tag`, canonical token in
     its `tag` field) declares it; exact-match, deliberately not prefix-permissive;
  2. *placement* — each scope folder-note declares what it admits via `allowedTags`, and a
     note's effective set is the **union walking up its folder chain** (band ← category ← area
     ← the root scope note, live default `The system.md`), with subtree semantics: allowing
     `note` admits `note/task`, `note/clipping/web`, ….

  Every vault-semantic value is config (`ScopeTagsConfig`: `registryClass`, `tagKey`,
  `allowedTagsKey`, `rootNote`) with today's live shapes as defaults, validated per-provider by
  the registry (invalid config skips that one instance and reports). Two deliberate gates match
  the live rollout state: an **unseeded registry** (zero registry notes) forces no per-tag
  findings — a reportable state (counts of 0), not drift — and a note whose chain declares no
  `allowedTags` key has placement un-engaged, while a declared-empty whitelist is authoritative.
- **blueprint** (`blueprint.ts`) serves **`tag`**, **`property`**, **`type`** in the *gen-old
  registry grammar*: tags from `<name>.tag.md` notes (namespace-prefix permissive), properties
  from flat `<key>.property.md`, types from `<Name>.fileclass` files (`extends` = parent,
  `retired: true` = deprecated). No longer in the shipped defaults (that grammar has no live
  surface); available via settings.
- **glossary** (`glossary.ts`) serves **`term`**: definition notes tagged `note/definition`
  (term = `title`, gloss = `description`) and `## Terms` sections of `- **term** — definition`
  bullets.

The registry (`VocabRegistry`) skip-and-reports duplicate ids, unknown providers, and invalid
per-provider configs into a `problems` array (it never throws), reserving an id before the
provider check. Shipped defaults: one `scope-tags` instance over the whole vault and one `glossary` over the whole vault with no `termsRoot`. The plugin ships no vault path (the #403 ruling, applied here after the default's `termsRoot` went dead silently three times as the framework folder was renamed). Without `termsRoot` the glossary serves definition notes only; set it in the vocab satellite's settings to read a folder's `## Terms` chapters. An install upgrading from the host adopts the value it already had.

## The four tools

All declared read-only, published to the host through `vault-mcp-api`. (They registered through the host's module registry until S7; see the allowlist section below for what the host now believes about that read-only declaration.)

| Tool | Input | Returns |
| --- | --- | --- |
| **`vaultmcp_vocab_vocabularies`** | *(none)* | `{ vocabularies: [{ id, provider, root, capabilities, kinds, counts, examples }], problems }` — every configured vocabulary, its served kinds, per-kind counts and examples. |
| **`vaultmcp_vocab_resolve_term`** | `token?` **xor** `path?`; plus `kind?` (`tag`\|`property`\|`type`\|`term`), `parse?`, `vocabulary?` | `token` → `{ token, found, vocabulary, entry }` (one sense) or `{ found:false }`; `token` + `parse:true` → `{ token, valid, findings }` (validate-only); `path` → `{ path, terms:[{ token, kind, found, canonical?, vocabulary?, definition?, deprecated?, ambiguous? }] }` (the note's own tags/properties/types). |
| **`vaultmcp_vocab_validate_terms`** | `path` | `{ path, findings, clean }` — the note's vocabulary findings. Report-only; findings are returned, never fixed, nothing is written. |
| **`vaultmcp_vocab_list_vocabulary`** | `kind`, `scope?`, `vocabulary?` | `{ kind, count, entries }` — every registered term of that kind, case-insensitively sorted, each carrying its `vocabulary` id. |

### Error codes and finding shapes

Coded tool errors (`Error [code]: …`):

- **`out_of_allowlist`** — a `path` argument outside the session's allowlist
  (the resolve tool's path branch, and the validate tool).
- **`vocab_ambiguous`** — a token with more than one sense across kinds; the resolver refuses to
  pick and names the candidates (the resolve tool's token branch).
- **`invalid_argument`** — the two argument-shape errors (`token` and `path` together, or
  neither). New at S7 only in the sense that they now carry a code: as a module they were
  codeless `Error: …` text.
- **`invalid_path`** / **`invalid_scope`** — a `path` or `scope` argument containing a
  backslash, refused outright. New at S7: every check downstream splits on `/` alone, so a
  backslash reads as one opaque segment here and as a traversal to whatever normalizes it
  later, and Obsidian paths never legitimately contain one.

Finding codes (`VocabFinding.code`, shape `{ code, token, path, detail }`):

```
unregistered_tag | undefined_property | unknown_type | unknown_term
deprecated | ambiguous | malformed_token
tag_unregistered | tag_out_of_scope | allowedTags_unregistered
registry_entry_untagged | registry_duplicate
```

blueprint maps an unknown-per-kind token to `unregistered_tag` / `undefined_property` /
`unknown_type`; glossary emits `unknown_term` / `deprecated`; the whole-note rule pack
(`findings.ts`) adds `malformed_token` (e.g. a whitespace tag) and `ambiguous`; the last five
are the scope-tags provider's pack (below).

## Allowlist behaviour since S7 — per tool, and for one tool per CALL

The enforced boundary is now the HOST's, because a satellite cannot reach the host's guard settings, and the host's gate tests the arguments a call actually carries. The four tools therefore land differently and the difference is worth reading twice:

- **`vaultmcp_vocab_vocabularies`** takes no arguments, and **`vaultmcp_vocab_list_vocabulary`** takes `kind` / `scope` / `vocabulary`, none of which is a recognized path key. Under an active path allowlist both are **blocked outright** — stricter than the in-module listing filter they replace.
- **`vaultmcp_vocab_validate_terms`** requires `path`, which IS a path key, so it is **not blocked**: the host scopes it and refuses `out_of_allowlist` for a hidden note.
- **`vaultmcp_vocab_resolve_term`** takes `path` OPTIONALLY, so the same tool is **blocked when called with `{token}` and scoped when called with `{path}`**. That per-call asymmetry is the most surprising fact about this extraction and is not a bug: the host cannot scope a call whose arguments name no path.

The in-plugin LISTING filter — which ran the vault enumeration through the allowlist before any body was read — is now dormant, since nothing supplies it. **Be precise about what that costs**, because "no tool became looser" would be false: the two tools the host still lets through build their providers from the whole-vault listing, so for a token the caller's own visible note already carries, they can disclose whether a hidden registry declares it, its definition gloss, and — through the ambiguity detail — the paths of registry notes claiming a duplicated token. Bounded (you can only ask about tokens you can already read) but real, and not closable from inside a satellite. The `visible` seam is kept, unsupplied, with its tests still driving it, so an apiVersion-2 `vault-mcp-api` able to carry the caller's scope to a publisher closes it with no code change.

## Read-only, and the findings rule packs

Every tool declares `readOnly: true` and the plugin has no write path at all. `findings.ts`
(`noteVocabFindings` — the pure whole-note rule pack) is exposed for a single named note through
the validate tool but is **not registered as its own tool**: capabilities arrive as rule
packs, never as new mutating surface. Note what the declaration buys since S7: the host
DISTRUSTS an external tool's read-only claim unless `vaultmcp-vocab` is listed in its
`trustedReadOnlyPlugins` setting, so by default all four register as mutating — read-only mode
blocks them, and each call takes a write-queue slot and a journal record. Trusting the publisher
restores read-only-mode availability; it does not change the scoping gate below. Deciding whether an unregistered tag *should* be added to
the vocabulary, or a note re-tagged, is a decision the tool **names for you** — it never takes
it.

The scope-tags provider adds its **five-finding whole-vault rule pack** (`scopeTagsFindings` in
`scope-tags.ts` — also not a tool; rail material):

- `tag_unregistered` — a note carries a tag no registry note declares
- `tag_out_of_scope` — registered, but outside the note's chain union
- `allowedTags_unregistered` — a scope whitelists a tag that isn't in the registry
- `registry_entry_untagged` — a registry note with an empty/missing `tag` field
- `registry_duplicate` — two registry notes claiming one token

Per-note, `tag_out_of_scope` and `allowedTags_unregistered` also surface through
the validate tool via the optional `noteFindings` seam on `VocabularyProvider` (provider-
specific whole-note checks, called by `noteVocabFindings`); `tag_unregistered` rides the
ordinary token path. Report-first throughout — no write-time refusal; curation is human.
