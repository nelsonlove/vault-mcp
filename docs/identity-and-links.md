# Identity substrate & link health

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


A path is not an identity. Rename a note, move it into a folder, let a template reorganize it
— and every path you were holding is silently wrong, usually without an error (a path that no
longer exists reads as "create a new note here"). The identity substrate gives an agent a
**stable** way to name a note, and a **read-only** way to see what has drifted.

The [reference](reference.md#addressing-notes-by-uid) carries the full prose; this is
the reference for the tools and where they live.

## The uid index and `uid:` addressing

The plugin keeps a **uid index** (`uid → path`, and the inverse), built at load from
Obsidian's own metadata cache (no file reads) and kept current from Obsidian's events — a uid
added/changed/removed by an edit, a note renamed/moved/deleted
(`packages/host/src/kernel/uid-index.ts`). Notes with no `uid` frontmatter are simply not in
it.

**Anywhere a tool takes a path, it also takes `uid:<value>`** — on reads and writes alike, on
the full surface, in Code Mode, and on path-taking tools published by other plugins. It binds
at the **same single interception point** as the accept guard and the write queue
(`packages/host/src/mcp/guarded.ts`), so handlers never see a uid reference — they get the
resolved path.

```jsonc
{"path": "uid:019fe34f-1ff0-74ae-8117-ca6d9843873f", "content": "…"}   // obsidian_write_note
{"paths": ["uid:019fe34f-…", "Notes/Literal.md"]}                      // mixed is fine
{"from": "uid:019fe34f-…", "to": "Archive/2026/Moved.md"}             // any path argument
```

Two references **refuse rather than guess**, and nothing runs in either case:

- `Error [uid_unresolved]` — no note *you can reach* carries that uid.
- `Error [uid_ambiguous]` — two or more notes *you can reach* carry it, and the error names
  them. The index records duplicates rather than picking a winner or rewriting anyone's
  frontmatter.

Both decisions are made over the notes a **path allowlist** leaves visible (see
[read-boundary containment](#read-boundary-containment)) — a duplicated uid is not a way to
read a path out of a sandbox.

### `obsidian_resolve_uid`

The read-only lookup, both directions (`packages/host/src/mcp/tools-uid.ts`):

- `{uid}` → `{path, duplicates?}`
- `{path}` → `{uid}`
- no argument → index totals plus every duplicated uid.

It reports duplicates; it never repairs them. The totals count only what your session can see,
so a sandboxed session doesn't learn how much lives outside its allowlist.

## Link healing — in band, a move heals its own links

Every move this server performs — `obsidian_move_note`, `obsidian_move_notes` (batch), and the scheme moves underneath them — goes through `moveWithLinks` (`packages/host/src/mcp/move-with-links.ts`): a file-level rename, then vault-mcp rewrites every link to the note itself and checks the result for damage. It does NOT use `app.fileManager.renameFile`, because that waits for Obsidian's metadata cache to be completely clean before it updates links, and with many sessions writing that wait lasted 1 to 25 minutes per move (Nelson's "B", 2026-09-29). Links are found from the notes' text (every note whose text contains the moved note's name, as written, `%20`-encoded or in either Unicode form, is read), so a note written moments before, whose index entry is still stale, is found like any other. Links in wikilinks, embeds, markdown links (relative, vault-path and bare, with parentheses in the path), aliases, subpaths, `%%` comments and frontmatter strings are rewritten; links in code (fenced, also inside a quote or a list, and inline, paired per paragraph) and math are not; only the target part of a link changes, and a relative link stays relative. The moved note's own relative links, markdown and wiki, are rewritten from its new folder. **Records are never rewritten** (01.44 rule 8; `packages/host/src/mcp/records.ts`): a note the operator's record identifier marks (the same "Record identifier" setting the record-immutability check reads: `record: true` by default, or another property and value, or a tag, gathered as Obsidian's `getAllTags` gathers it: frontmatter `tags` in any case, inline `#tags` outside code; read from the note's current text), or a note under a record folder (the operator's "Record folders" setting, or a folder whose name matches the "Archive folder pattern" setting, #482; each indicator has its own on/off switch; the plugin ships the folder list and the pattern EMPTY, so a fresh install protects no folder until the operator fills them in, and an install that predates the setting is seeded once with 03.04 Records, 03.16 Cross-session log, 03.20 Imported chats and the JD `NN.09 Archive…` pattern), keeps every link as written. The folder note of such a folder itself (`03.04 Records.md`, `00.09 Archive.md`) is its living index and is healed; a folder note nested deeper is a record. A moved record keeps its own links too when it is a record at both ends: a marked record stays one wherever it moves, and a note that is a record only by its folder is living once moved out of the record folders, so its own links are healed. The reverse is the moment of archiving: a living note moved INTO a record folder is living for that move, so its own relative links are healed on the way in and the record cites working targets as of its archiving; every later move leaves them as written. The "Enforce record immutability" toggle does not change this: it unblocks operations the guard refuses, and a move refuses nothing here. Each record link that no longer reaches its target after the move is listed in `link_check.records_left` (at most 100 notes; `records_left_total` counts all; `index_only: true` marks a record only Obsidian's index says links the note). These are not damage: `ok` stays true. Such a link now dangles in the record, which `obsidian_check_links` and the vault's `dangling-links` report until the record is literalised under rule 8a. The response reports `backlinks_updated`, `backlinks_files_touched` and a `link_check`: `ok`, plus any link still naming the old path unresolved, any note reaching the note fewer times than before, any note the moved note reaches by a relative link fewer times than before (`own_links_broken`), any note the index says links it more often than the links found in its text, and any note that could not be rewritten — damage is reported, never silent. Counts and lists name only notes the caller may see; `hidden` counts the rest, and `ok` covers them too. `update_backlinks: false` renames only: no link is rewritten, the moved note's own included. The parser is Obsidian's rules re-implemented, not Obsidian's parser: on a copy of 1,816 real notes it agreed with Obsidian's index on 24,749 links, 4 links were only in the index (rare backtick runs Obsidian reads its own way; the index cross-check above reports such a note when its index entry is current) and 36 only in the parser (most inside indented code or split by a table's bar, which Obsidian does not index; a move rewrites such a link if it names the moved note, which changes text Obsidian does not treat as a link). Tested on that copy: 50 real notes moved under a simulated write stream, 3,814 links rewritten, no damage.

## Link health — out of band, `obsidian_check_links` reports drift and repairs nothing

Links rot for reasons the server didn't cause: a note deleted in Finder, a rename by another
tool, a `[[wikilink]]` typed against a note nobody created, a uid pasted into a second note.

**`obsidian_check_links`** (`packages/host/src/mcp/tools-links.ts`) is a **read-only** report
— no queue slot, no journal record, no `fix`/`heal` argument, works in read-only mode:

```jsonc
{"scope": "Projects"}   // optional — omit for everything you can see
→ {
    "dangling_links":  {"note_count": …, "link_count": …, "truncated": false, "items": […]},
    "duplicate_uids":  {"available": true, "count": …, "truncated": false, "items": […]},
    "uid_coverage":    {"available": true, "notes_total": …, "notes_with_uid": …,
                        "notes_without_uid": …, "truncated": false, "uncovered": […]}
  }
```

Dangling links come from Obsidian's own `unresolvedLinks` map, duplicate uids from the uid
index — both already computed, so the report never reads a file. **`uid_coverage`** is the
identity half: how many visible notes carry a uid, and which don't. When a build has no uid
index, `available: false` and the uid-derived counts are **`null`, not `0`** (unknown, and
shaped so `notes_with_uid` + `notes_without_uid` always sum to `notes_total` whenever they are
numbers). Counts are exact for everything visible and in scope; lists cap at 100 each with a
`truncated` flag. A bad `scope` is **refused, never widened** — `Error [invalid_scope]` for an
absolute/empty/above-root/backslash-containing scope, `Error [out_of_allowlist]` for one naming
an area you can't see. The validator behind both codes is `resolveScope`, which moved to
`@vault-mcp/core` at S7 so this tool and the `vaultmcp-health` satellite's lint share one copy; the
backslash case arrived with that move and made both callers stricter at once.

## `obsidian_repoint_link` — the deliberate link repair

To act on a report, **`obsidian_repoint_link`** (`packages/host/src/mcp/tools-vault-write.ts`)
rewrites every wikilink matching a name to a target you choose — `dry_run` first,
`unresolved_only` to leave working links alone. One deliberate call, one decision. It **is a
mutating operation** (queued, journaled) and the journal records what actually changed via an
`effects: {filesChanged, paths}` field (omitted for a `dry_run`).

Its blast radius isn't in its arguments (it scans notes to find the links it rewrites), so it
is contained by the **same allowlist**: with an allowlist configured it reads, rewrites, and
names only visible notes — the response says `scoped_to_allowlist: true`, and the repair is
then **partial** (dangling links to the same name survive outside the allowlist).

## `obsidian_rename_heading` — renaming a heading heals its links

A heading is part of every link that names it (`[[Note#Heading]]`), so changing the heading text with an ordinary edit breaks those links and nothing reports it. **`obsidian_rename_heading`** (`packages/host/src/mcp/tools-vault-write.ts`, #424) is the headless form of Obsidian's *Rename this heading* command: it renames one heading and rewrites every link to it, in wikilinks, embeds, markdown links, same-note links and heading chains. It matches links the way Obsidian's `resolveSubpath` does (punctuation stripped, case ignored), and refuses a rename that a link could not tell apart from another heading. It discovers its blast radius like the repair above and is contained by the same allowlist (`scoped_to_allowlist`); it also leaves record notes as they are and reports them under `skipped`.

## Read-boundary containment

Every tool that reads or enumerates the vault is bounded by the **path allowlist** (one
vault-relative prefix per line; empty = whole vault). Every path a call *names* is checked —
including inside batches and behind `uid:` addressing, which resolves *before* the check
so they can't be a way around it — and every enumerating tool bounds its own iteration by the
same rule, **filtering before it reads rather than after**. The full per-surface table
(search, listings, backlinks, resolve, tags, bookmarks, Dataview/CLI refusal, and the four
documented "known oracles") is in the [reference](reference.md#the-path-allowlist).

For the identity tools specifically: `obsidian_resolve_uid`, `obsidian_check_links`, and
`obsidian_repoint_link` are all filtered as above — a uid carried only outside your allowlist
reads as unresolved, an ambiguity names only paths you could have named yourself, and totals
count only what your session can see.
