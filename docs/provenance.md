# The provenance satellite — derived-content freshness

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


The `vaultmcp-provenance` plugin (`packages/provenance`) is the fold of the standalone
`obsidian-provenance` CLI. It was a capability module of the host —
`modules.provenance`, default off, declared mutating — until the suite split's
mutating tier extracted it into its own Obsidian plugin, publishing its tools to
the host through `vault-mcp-api`. Three tools:

| Tool | What it does | Mutating? |
| --- | --- | --- |
| `vaultmcp_provenance_check` | Is a derived note FRESH or STALE against its own `derived-from:` sources? | read-only claim, distrusted by the host |
| `vaultmcp_provenance_reconcile` | Installed vs enabled vs noted Obsidian plugins | read-only claim, distrusted by the host |
| `vaultmcp_provenance_regen` | Regenerate the plugin-audit note (dry-run by default) | mutating |

**The names changed at the extraction**, and so did one argument. The host
publishes an external tool as `<sanitized publisher id>_<bare name>`, so the
plugin id is the tool namespace, and the bare names shed the `provenance_`
prefix so nothing publishes as `vaultmcp_provenance_provenance_check`. The three
names shipped by the module were `provenance_check`, `provenance_reconcile` and
`provenance_regen`; they are the three in the table above. `check`'s `path`
argument is now **`note`** — it was `note_path` from the extraction until
2026-09-07, when the host began recognizing `note_path` as a path key for the
tier's MUTATING tools and this READ moved to a third spelling to stay out of
that list. That last one is a scoping decision, not a
spelling one: `path` is a key the host's guard recognizes, so keeping it would
have let a session under a path allowlist run `check` scoped to the note it
names — while the answer still lists every path that note's `derived-from`
globs resolve to, including files the session cannot see. Named `note`, no
tool in this plugin carries a recognized path key, so the host blocks all three
outright while an allowlist is active. Fail-closed. The reversal is one word.
`packages/provenance/README.md` and `packages/provenance/CLAUDE.md` own the
detail.

Source: `packages/provenance/src/kernel/*` (pure, Obsidian-free over an injected
`ProvenanceSource`) and `packages/provenance/src/tools.ts` (the tool surface) with
`packages/provenance/src/obsidian-source.ts` (the one Obsidian adapter).
Derivation is **not** acceptance: the plugin stamps
`derived-from` / `generated` / `generator` / `derivation-mode` /
`derived-source-count`, and `vaultmcp_provenance_regen`'s write routes through the shared
accept-forbidden guard — see [acceptance-model.md](acceptance-model.md).

## The contract a derived note declares

```yaml
---
derived-from:                        # vault-relative plain paths and/or globs
  - "00-09 System/07 Repositories/*/*.md"
  - ".obsidian/community-plugins.json"
generated: 2026-08-19T11:04:00       # when the artifact was produced
derived-source-count: 48             # OPTIONAL witness — see tier 2 below
---
```

A note with **no `derived-from` is an error**, not a "fresh" verdict — the check
is opt-in by construction, and a note that never declared sources is not
something `vaultmcp_provenance_check` gets to have an opinion about.

## What the check detects

Three edits can happen to a source set. Two were always caught; the third —
**deletion** — was a silent blind spot, because an entry that resolves to nothing
simply dropped out of the comparison and the note read FRESH.

| Change to the sources | Caught by | Verdict field |
| --- | --- | --- |
| A source was **modified** | mtime > `generated` | `changed` |
| A source was **added** | the new file's own fresh mtime | `changed` |
| A **plain-path** source was deleted / moved | the entry resolves to nothing | `missing` |
| A source was deleted **inside a glob** | the `derived-source-count` witness (opt-in) | `sourcesRemoved` |

The note is STALE when **any** of `changed`, `missing`, or `sourcesRemoved` is
non-empty. `fresh: true` means all three came back clean.

### Tier 1 — missing plain-path entries (always on)

A NON-GLOB `derived-from` entry names exactly one file. If it resolves to
nothing, that file is gone (deleted, moved, or renamed) — unambiguously. The
entry is named in `missing` and the note is STALE. No schema change, nothing to
opt into.

A **glob matching nothing is deliberately not the same claim.** An empty folder
can be a perfectly legitimate source set (a vault with no plugin notes yet), so
globs never populate `missing`. An empty glob is reported only through the count
witness below, and is invisible without one.

### Tier 2 — the `derived-source-count` witness (opt-in, per note)

A generator may stamp how many source files the **whole** `derived-from` set
resolved to at generation time — the length of the same list `vaultmcp_provenance_check`
reports as `sources` — **including duplicates**, when two entries name the same
file — so the witness and the check are the same arithmetic. A generator that
counts a de-duplicated set over overlapping entries under-counts, and its note
reads permanently stale. When the current count is **lower**, sources were
removed:

```json
"sourcesRemoved": { "expected": 48, "actual": 47 }
```

A **higher** count is not staleness by itself. Additions are exactly the case the
mtime rule already catches, so treating "more files than before" as stale would
only add false positives — a source set that legitimately grew, every file older
than `generated`, is fresh and reads fresh.

**Why a count and not digests or a stored path list.** Pure deletion drops the
count. Delete-plus-add keeps the count, but the added file carries a fresh mtime
and the mtime rule already trips. So count + mtime cover the space between them —
without hashing every source on every check, and without freezing 48 paths into a
note's frontmatter where they would rot.

**Absent witness ⇒ exactly the pre-witness behavior.** Nothing about a note
without the field changes. But the verdict says so out loud:

```json
"globDeletionsUndetectable": true
```

`true` means this note has at least one glob entry and no usable witness, so
deletions inside the globbed set were **not checked**. `false` means either every
entry is a plain path (deletions fully covered) or a witness was available and
the count check ran. That distinction — "checked and fine" vs "could not check
that class" — is the whole point of the flag; a caller must not read a bare
`fresh: true` as the former. A malformed witness (negative, fractional,
non-numeric) is treated exactly like an absent one.

## Honest limits

| Limit | Consequence |
| --- | --- |
| Detection is **mtime-based** | `touch`ing a source with no content change ⇒ **false stale**. Edit-and-revert ⇒ still stale (the mtime moved). There is no content digest. |
| **Plain-path** deletions | Always caught. |
| A plain-path entry that is **optional**, names a **folder**, or never existed | Indistinguishable from a deletion — the check sees "this entry names no file" and nothing more. It lands in `missing` and the note stays STALE permanently, through any number of regenerations, until the entry is removed from `derived-from`. Declare only sources you require. |
| **Glob** deletions | Caught **only** with a `derived-source-count` witness; otherwise invisible, and flagged as such. |
| **Additions** | Caught by mtime, for globs and plain paths alike. No witness needed. |
| Delete + move-in with a **preserved mtime** | Undetectable. A `mv` within a filesystem keeps the file's mtime, so both the count and the newest mtime can be unchanged after a real substitution. |
| An **empty glob** with no witness | Not reported. An empty source set may be legitimate; the flag is the only signal. |
| The witness is **stamped, never verified** | It records what a generator claimed at generation time. A hand-edited or wrong witness produces a wrong count comparison — the same trust model as `generated:` itself. |
| Timestamp granularity | `generated` is stamped to **seconds** (local time); mtimes are milliseconds. A source modified inside the same second as generation can round under the comparison. |

## Who stamps the witness

Governor stamps it on **its own** generated note: `vaultmcp_provenance_regen` resolves the
audit's own `derived-from` set (`auditDerivedFrom`, the single definition the
rendered frontmatter list also comes from) and stamps
`derived-source-count: <n>`. Delete a plugin note afterwards and
`vaultmcp_provenance_check` reports `sourcesRemoved`, with no mtime anywhere having moved.

Three details of that note in particular:

- **Whether the audit is a source of itself depends on the layout, and the
  witness asks that question structurally.** In `flat` mode the audit lives at
  `{notesDir}/<basename>.md` and its own `{notesDir}/*.md` glob matches it, so
  the count is stamped for the set as it will be *after* the write lands (a
  first-ever regen adds one for the note about to be created) — otherwise the
  first deletion after a first regen would be masked by a witness one low. Under
  the shipped `jd-slots` default the audit sits *beside* the slots
  (`{root}/Plugin audit.md`, glob `{root}/*/*.md`), so its own glob does not
  match it and nothing is added. That follows from the configured path, not
  from the mode: point `auditNote` inside a slot folder and it would be matched
  again — the witness asks the glob, never the layout name.

  The distinction is load-bearing. An earlier revision asked "is it in the
  resolved set right now", which conflates *not written yet* with *structurally
  outside the glob*: under the default that added one on **every** regen, and
  the note then read permanently STALE — turning the deletion signal this
  witness exists to carry into a constant false alarm. `globMatchesPath` asks
  the structural question instead.
- **Consequence of self-inclusion where it applies (`flat`), pre-existing and not
  fixed here:** the audit note's own mtime moves when the regen writes it, which
  is later than the `generated:` it just stamped, so `vaultmcp_provenance_check` on the
  audit reports itself in `changed` and reads STALE immediately after a regen.
  That is a wart of that particular `derived-from` list — a glob cannot say
  "everything here except me" — not of the deletion detection above. It does not
  arise under the `jd-slots` default, where the audit is outside its own glob.

- **The audit declares one source that is really optional.**
  `.obsidian/community-plugins.json` is a plain-path entry, but `reconcile` treats
  it as optional (absent ⇒ nothing enabled). In a vault where it does not exist —
  no community plugin has yet been enabled — the audit reports
  `missing: [".obsidian/community-plugins.json"]` and reads STALE about a file
  that was absent from the start. The same class as the third row of the limits table
  above; narrow in practice, since Obsidian writes that file on the first enable.

One other Governor generator was considered and deliberately **not** stamped:

- the **conformance debt register** (`packages/conformance/src/kernel/debt-register.ts`) stamps
  `generated` + `generator` but declares **no `derived-from`** — its inputs are a
  findings run and a baseline, not a resolvable file set, so `vaultmcp_provenance_check`
  cannot check it at all and a source count would witness nothing.

(This list used to name a second generator, the **skills export**, which wrote a Claude Code plugin directory outside the vault rather than a derived *note* with frontmatter — it left this plugin's outside-vault footprint entirely with the S4 satellite extraction (`docs/suite-split-design.md` §6) and is no longer one of this plugin's generators to consider.)

Vault-side generators (QuickAdd macros, scripts, anything outside this repo) are
not touched: the field is simply **readable** if they choose to stamp it.

## The verdict shape

`vaultmcp_provenance_check` returns, additively over the original shape. `changed`,
`sources` and `generated` keep their names **and** their meaning. `fresh` keeps
its name but is deliberately **stricter** than before — an empty `missing` and no
`sourcesRemoved` are new conditions on it, which is exactly the change this
detection makes: a note whose plain-path source was deleted used to read fresh.

| Key | Always present? | Meaning |
| --- | --- | --- |
| `path` | yes | the note that was checked (echoed back — the RESULT key stayed `path` even though the ARGUMENT is now `note`; only the argument name decides how the host scopes a call) |
| `fresh` | yes | no `changed`, no `missing`, no `sourcesRemoved` |
| `changed` | yes | resolved source files with mtime > `generated` |
| `sources` | yes | every file the `derived-from` set resolved to |
| `generated` | yes | the note's `generated`, as ISO |
| `missing` | yes | non-glob entries resolving to no file |
| `globDeletionsUndetectable` | yes | glob entries present and no usable witness |
| `expectedSourceCount` | only with a witness | the witness as read |
| `sourcesRemoved` | only when the set shrank | `{expected, actual}` |

`vaultmcp_provenance_regen`'s success object gained two keys at the extraction: `filesChanged` and `files` beside the unchanged `written`. That is the host's `reportedEffects` convention — the audit's destination is configuration rather than a call argument, so without them the journal record's `effects` field for this tool was empty and the record named no file at all. Additive; nothing was renamed or removed.

## What stays un-headless

Nothing in the freshness engine. `checkFreshness` is pure over the injected
`ProvenanceSource` (`noteFrontmatter` / `stat` / `glob` — this work added **no**
new primitive to the seam), and the detection rules above are unit-tested against
an in-memory backend in `packages/provenance/tests/provenance-module.test.mjs`. The one part not covered
headlessly is the same one as before: `obsidianProvenanceBackend`'s glob walk over
the live vault adapter, which must be verified against a running Obsidian.
