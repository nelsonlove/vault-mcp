# Settings

Settings now live in two places: the host (`vault-mcp`) keeps its own settings tab and `data.json` at `.obsidian/plugins/vault-mcp/`, and the governance provider (`governor`) keeps its own settings tab and `data.json` at `.obsidian/plugins/governor/` — the same folder it always used, since the provider kept the plugin id. On first load, the host copies its own host-owned keys out of the provider's `data.json` into its own, alongside `journal/` and `install-id.json`. The copy never moves or deletes anything on the provider's side; the provider's own copies are left in place. Each satellite plugin keeps its own settings too; the conformance settings below are the `vaultmcp-conformance` plugin's. This document orders both surfaces together, least to most consequential, and calls out which surface a setting belongs to only where the two could be confused. Defaults belong to the settings schema; this document explains their meaning. A release must generate or verify this reference against both schemas so prose cannot silently drift.

> [!note]
> This target-state reference uses behavior-level setting names. A release may refine the UI wording, but it must preserve the stated defaults, consequences, and recovery.

## Connection

### Local bridge

| Field | Value |
|---|---|
| Default | On after Governor is enabled |
| Effect | Accepts compatible local MCP connections through the desktop bridge |
| Takes effect | New connections; an existing client may need to reconnect |
| Dependency | Desktop Obsidian |
| Risk | Local processes running as the user may attempt to connect |
| Recovery | Turn off the bridge, disconnect clients, and inspect the journal |

The bridge is local, not an internet listener. Turning it off removes agent access but leaves the review center and existing operational records available in Obsidian.

### Code mode

| Field | Value |
|---|---|
| Default | On for clients that support discovery calls |
| Effect | Exposes a small discovery-and-call surface instead of registering every capability schema in client context |
| Takes effect | Next connection |
| Dependency | Compatible bridge and client |
| Risk | None beyond the capabilities the target call already carries |
| Recovery | Reconnect using the full surface for diagnosis |

Code mode changes discovery cost, not authority. The selected surface still resolves a registered action and passes through the same operation executor.

### Trusted read-only plugins

| Field | Value |
|---|---|
| Default | Empty |
| Effect | Lists external-plugin ids whose published tools' `readOnlyHint` claims are honored; every other external tool's read-only claim is distrusted and treated as mutating |
| Takes effect | New connections |
| Dependency | External tool registry |
| Risk | Trusting a compromised or mistaken plugin restores its untracked-mutation surface |
| Recovery | Remove the plugin id and reconnect clients |

Listing `governor` here is what restores read-only treatment to the governance provider's four read-only tools (`governance_pending_review`, `governance_revisions`, `governance_mandates`, `governance_mandate_draft`); without it they register as mutating and, under an active path allowlist, are refused wholesale.

### Secret scanner: profiles

| Field | Value |
|---|---|
| Key | `redactProfiles` |
| Default | Empty (the scanner is off) |
| Effect | Names connection profiles (such as `read+message`) whose tool replies pass through the secret scanner, which blanks key- and token-shaped strings as `[redacted:<kind>]`. Listing `full` scans local connections too. See `packages/server/README.md`, "Secret scanner" |
| Takes effect | New connections |
| Risk | A best-effort filter: it cannot catch every form of a secret. While a profile is listed, a refused config gives every remote connection (and a local one when `full` is listed) no tools until it is fixed; a name that is not a known profile, a line that cannot be parsed, or a value of the wrong type refuses every connection, local ones included |
| Recovery | Fix the name or the config, or empty the list, and reconnect clients |

### Secret scanner: config

| Field | Value |
|---|---|
| Key | `redactConfig` |
| Default | Blank (the shipped defaults) |
| Effect | JSON text: `keyNames` and `patterns` replace the shipped key names and provider token shapes; `extraKeyNames` and `extraPatterns` (`{kind, regex, ignoreCase?}`) add to them. The structural rules (private key blocks, JWTs, Authorization and bearer values, URL credentials) always run |
| Takes effect | New connections |
| Risk | A pattern you add is run as given: a pattern with nested repeats can make a scan slow. An empty `keyNames` or `patterns`, or a pattern that can match an empty span, is refused |
| Recovery | Blank the field and reconnect clients |

## Posture

### Current posture

| Field | Value |
|---|---|
| Default | **Looking only** |
| Effect | Selects the highest operation mode the connection may request |
| Takes effect | Immediately for refusals; reconnect when the capability surface changes |
| Dependency | None |
| Risk | Broader postures permit more consequential writes |
| Recovery | Return to Looking only and reconnect clients |

The selectable progression is Looking only → Drafting a change → Proposing governed changes → Working under a mandate. “Ready for review” is a proposal or cohort state, not a connection posture. A posture does not grant access outside the path scope or outside an active mandate.

### Create and append

| Field | Value |
|---|---|
| Default | Off |
| Effect | Permits new notes and pure end-of-note appends inside scope |
| Takes effect | Next connection |
| Dependency | A non-empty path scope |
| Risk | Adds or extends content; may create review work |
| Recovery | Turn off, revert proposals, or restore prior revisions |

### Structural mutation

| Field | Value |
|---|---|
| Default | Off |
| Effect | Permits preview-first edits, property changes, moves, and named repairs |
| Takes effect | Next connection |
| Dependency | Review center enabled and recovery available |
| Risk | Can change representation, meaning, location, links, and many notes; actual effects are classified separately |
| Recovery | Disable, inspect receipts, revert, or restore from verified backup |

## Scope

### Accessible folders

| Field | Value |
|---|---|
| Default | No vault content until the user chooses a scope |
| Effect | Bounds direct paths and discovery results |
| Takes effect | New connections; active handlers consult the live boundary where supported |
| Dependency | Vault-relative normalized paths |
| Risk | A broad scope exposes more private content and increases blast radius |
| Recovery | Narrow the list and reconnect |

Use one folder prefix per row. Segment boundaries matter: `Projects` includes `Projects/A.md`, not `Projects-Old/A.md`. Hidden notes remain unresolved through ordinary lookup.

### Git history scope

| Field | Value |
|---|---|
| Default | Human chooses whole ordinary-vault history or explicit included/excluded roots during Git setup |
| Effect | Defines which files Governor's local Git history may retain independently of any client's access scope |
| Takes effect | Through a reviewed history migration; never silently on reconnect |
| Dependency | Local Git repository service and disclosed outside-Sync storage |
| Risk | Historical bytes can remain after visible files change or disappear |
| Recovery | Stop history ingestion, export required evidence, and follow the documented retention/pruning procedure |

Repository identity belongs to the vault. A connection scope cannot expand history retention, and changing history scope is a human privacy and recovery decision.

## Observation capture and replay

### Guarded territories

| Field | Value |
|---|---|
| Default | **Empty — the plugin ships no list** (ruled 2026-09-22, #397). An install upgrading from a build that had a built-in list is seeded once with that list's four names, then the key is persisted so the seeding never repeats |
| Effect | Vault-relative folder prefixes, one per line, that observation capture never retains and the conformance rail never walks — the areas that must not leave the vault. Committed when the field loses focus. Matching is case-insensitive. An entry covers its own folder, everything under it, and every folder whose name begins with the entry and then breaks — a letter, digit, `_` or `-` right after the entry continues the name, anything else ends it — so `80-89` covers `80-89 Sensitive/`, `80-89/` and `80-89 Sensitive (old)/` but not `80-891/` or `80-89-archive/`; end an entry with `/` to mean exactly that folder. The conformance check steps around a listed folder that sits inside the vault, says so in its report (`guarded (not scanned, no claim made): …`), and refuses to run only if the accepted baseline still holds a key inside that folder — take the key out deliberately, or take the folder off the list |
| Takes effect | Live, per call |
| Dependency | None; Governor reads this same list from the host and keeps none of its own. When Governor is unable to ask the host (not loaded, or too old to publish the list) it fails closed and governs nothing — no proposals, no history, nothing accepted on its own — until the host answers |
| Risk | An **empty list guards nothing**, honestly: nothing is refused on territory grounds, and capture refuses to turn on until at least one territory is listed. A renamed folder silently leaves the list |
| Recovery | Add the prefix; review `~/.claude/vault-mcp/observations/` for anything retained before it was listed |

The standalone conformance CLI has no settings; it receives the list from `--territory=<prefix>` (repeatable) or `GOVERNOR_TERRITORIES` (comma-separated), and with neither refuses nothing on territory grounds.

### Governed-session read capture

| Field | Value |
|---|---|
| Default | Replayable for substantive vault reads in governed sessions |
| Effect | Preserves the exact Governor-returned payload and a content digest for review and playback |
| Takes effect | New operations |
| Dependency | Protected local observation store; **at least one guarded territory configured** — the toggle refuses to turn on while the list is empty, and the runtime gate enforces the same condition |
| Risk | Historical note content and metadata remain after the visible note changes or is deleted |
| Recovery | Shorten retention, delete eligible payloads through the audited control, or close the session and export only required evidence |

Governor may reduce low-information navigation and plumbing observations to ephemeral. Any read used to support a proposal, verification, or admission must be captured at evidence or replayable durability; Governor re-observes it if necessary.

### Ad hoc durable read capture

| Field | Value |
|---|---|
| Default | Evidence |
| Effect | Preserves the claims and digests needed for audit without necessarily retaining the full returned payload |
| Takes effect | New operations outside a governed session |
| Dependency | Operation evidence store |
| Risk | Paths, queries, result digests, and timing can still be sensitive |
| Recovery | Use ephemeral capture for eligible plumbing reads or prune evidence under policy |

### Replay retention

| Field | Value |
|---|---|
| Default | Retain through the session's review and recovery window, then apply the configured local retention policy |
| Effect | Controls how long replay payloads remain available; immutable digests and authority evidence may outlive the payload |
| Takes effect | New retention evaluations; never rewrites signed claims |
| Dependency | Observation store and retention worker |
| Risk | Long retention increases privacy exposure; short retention can remove historical playback needed for review or incidents |
| Recovery | Export a scoped audit bundle before expiry or delete payloads earlier through a recorded human action |

Playback access is checked against the current human/operator authorization as well as the original capture scope. Possession of an operation id is not read authority.

### Scheme exclusions

| Field | Value |
|---|---|
| Default | Empty |
| Effect | Removes configured roots from one addressing scheme's claims without hiding those notes from ordinary scoped access |
| Takes effect | Live for resolution |
| Dependency | Scheme module |
| Risk | A scheme may report a slot free because an excluded note occupies it |
| Recovery | Remove the exclusion or use a literal/stable identity reference |

## Review

### Review center

| Field | Value |
|---|---|
| Default | On |
| Effect | Shows proposals, revisions, history, and mechanical activity; owns human acceptance |
| Takes effect | Immediately |
| Dependency | None for the in-app surface |
| Risk | Turning it off removes the normal human decision surface, not the underlying prohibition on agent acceptance |
| Recovery | Re-enable; unpublished queue state must be reported explicitly |

### Review budget

| Field | Value |
|---|---|
| Default | 10 judgment-bearing proposals |
| Effect | Pauses creation of additional governed proposals when the pending budget is full |
| Takes effect | Immediately |
| Dependency | Review center |
| Risk | Too high creates review debt; too low may pause useful work |
| Recovery | Review, expire superseded proposals, narrow scope, or deliberately raise the budget |

### Stale-proposal age

| Field | Value |
|---|---|
| Default | 14 days |
| Effect | Marks untouched proposals stale and allows superseded ones to expire into history |
| Takes effect | Next review refresh |
| Dependency | Review center |
| Risk | Expiry can hide unfinished intent if the history view is ignored |
| Recovery | Restore a proposal from history as a new proposal, never as admitted standing |

### Cohort grouping and verification

| Field | Value |
|---|---|
| Default | Group only exact matching change classes and transformations; verify every item for admission |
| Effect | Reduces repetitive review while preserving an immutable decision subject and per-item evidence |
| Takes effect | Next eligible change |
| Dependency | Frozen cohort manifest, named verifier, and direct human decision or active mandate |
| Risk | A bad transformation or verifier can repeat a bad result at scale |
| Recovery | Block admission, inspect failed items, revoke the mandate if needed, and revert the exact admitted cohort |

Sampling may supplement audit, but it is not a substitute for full-coverage verification when mandated admission changes standing.

### Mandates

| Field | Value |
|---|---|
| Default | None active |
| Effect | Allows one delegate/session to perform a named transformation in a bounded scope and may authorize Governor to admit exact verified cohorts |
| Takes effect | After a human accepts the mandate; never retroactively |
| Dependency | Session binding, change-class verifier, recovery baseline, and review center |
| Risk | A wrong rule or overly broad scope can repeat at scale |
| Recovery | Revoke the mandate, stop its sessions, inspect attestations, and revert admitted cohorts by exact subject |

Every mandate shows delegate, purpose, scope, class, transformation, limits, verifier, admission mode, expiry, and recovery. Agents may draft or counter-propose but cannot change an active mandate.

### Portable standing across Sync

| Field | Value |
|---|---|
| Default | Off |
| Effect | Writes immutable mandate, verification, admission, and revocation attestations to Governor community-plugin data so Obsidian Sync can carry them when that data category is enabled |
| Takes effect | New attestation writes; receiving replicas import existing immutable envelopes after validation |
| Dependency | Obsidian Sync community-plugin data enabled separately on every relevant device |
| Risk | Authority metadata, paths, identifiers, and purpose may sync; partial arrival and conflicts remain possible |
| Recovery | Turn off portable writes, preserve evidence, reconcile each replica, and revoke compromised keys or mandates |

The local Git object database is never placed in Obsidian Sync by this setting.

### Signing identity and recovery

| Field | Value |
|---|---|
| Default | One local signing identity per authorized device or verifier role; portable pairing off until the human initiates it |
| Effect | Signs small authority and verification claims so another replica can validate their issuer |
| Takes effect | After local registration or explicit device pairing |
| Dependency | Operating-system protected secret storage |
| Risk | A stolen private key can issue claims in its registered role until revoked |
| Recovery | Revoke the old key, register a new one, or restore an optional encrypted key backup kept outside the vault and Sync |

This feature does not encrypt notes, attachments, Git history, or the vault.

## Protected properties and records

### Protected frontmatter properties

| Field | Value |
|---|---|
| Default | Acceptance/standing family plus mandate, signer, verifier-trust, and admission pointers as authority-conferring |
| Effect | Prevents agents from introducing, changing, or removing declared human-owned properties |
| Takes effect | Immediately on guarded writes |
| Dependency | Shared write guard |
| Risk | Overbroad declarations may block legitimate carry-forward edits |
| Recovery | Change the declaration in Governor settings through a human action; do not bypass the guard |

The acceptance family is a non-configurable floor. Configuration may extend it, never remove or weaken it.

### Record immutability

| Field | Value |
|---|---|
| Default | On |
| Effect | Protects notes the record identifier marks (default `record: true`; see below) from addressed in-place mutation; pure end append remains available |
| Takes effect | Immediately |
| Dependency | Metadata cache can read the flag |
| Risk | The protective check may fail open if metadata is unavailable; side-effect rewrites remain outside its addressed-path boundary |
| Recovery | Keep backups; disable only for a reviewed exceptional operation |

### Refusal log

| Field | Value |
|---|---|
| Key | `refusalLog` |
| Default | Off |
| Effect | Marks each refused write call in the write journal, so a later sweep can count how often each guard refuses. Two kinds of mark. **A call refused before the write queue** (nothing ran, no idempotency key was taken) gets a new line with `"outcome": "refused"`, `refusal` (the error code, for example `write_scope`) and `codeFamily` (the guard stage, for example `write_scope`). These stages: the strict input schema (`input_validation`, family `schema`), the connection profile, read-only mode and the allowlist, the write scope, `uid:` and scheme address resolution, the required `if_rev` and `idempotency_key`, the cut-read rule (`truncated_read`), the Sync guard, the headless gate. The line holds the stamp, the tool, the target path (a path over 120 characters is recorded as `<N chars>`), the actor (with its session), the code and the family, and no argument value: no `argsDigest`, no error text, no `intent`, no idempotency key. At most 20 such lines a minute are written per session and code; the rest are counted, and the count is written as one line with `suppressed: <count>` when the minute ends. **A call refused at or after dequeue** (the record guard, an `if_rev` conflict, an idempotency mismatch, the long-note rule, the accept guard and the protected properties, a tool's own refusal such as `no_match`, `cache_mismatch` or `h1_replace`) keeps the record the journal writes today, unchanged, and gains only `refusal` and `codeFamily`. Only a code on a fixed list of codes that mean "refused, nothing written" gains the mark; a failure after a write landed (a partial batch, a failed reload) gains nothing. A replay of a key (`deduped`) is not a new refusal. Read calls are not marked |
| Takes effect | Immediately |
| Risk | More journal lines while it is on, at most 20 a minute per session and code. Idempotency is the same on and off: dequeue records keep their keys, so a retry after a restart replays as before |
| Recovery | Turn it off; the lines already written stay in the journal |

The filesystem server reads the same switch from the environment variable `VAULT_MCP_REFUSAL_LOG` (`true`, `1`, `yes` or `on`; unset is off) and writes the lines to its own write journal. The setting can be put in the machine-local settings override, so one machine logs refusals and the synced `data.json` stays off.

### Record identifier

| Field | Value |
|---|---|
| Default | Frontmatter property `record` holding `true` |
| Effect | How a note declares itself a record — the operator's convention, not the plugin's (#397). Either a frontmatter **property** with a required **value** (case-insensitive; YAML `true` matches `true`), or a **tag** (with or without `#`; frontmatter and inline tags both count). Mirrors TaskNotes' task identifier setting |
| Takes effect | Live, per call |
| Dependency | Metadata cache has parsed the note |
| Risk | Changing the identifier stops protecting notes marked the old way until they are re-marked; a blank field falls back to the default rather than protecting nothing |
| Recovery | Restore the previous identifier; notes are never rewritten by this setting |

### Records by note marker

| Field | Value |
|---|---|
| Default | On |
| Effect | The note marker's own switch (#482). Off: no note is a record by its marker, for the write check, the moves and heading renames alike |
| Takes effect | Live, per call |
| Risk | Off removes the marker's protection everywhere at once; the folder rule (below), if on, still protects notes for moves and heading renames |
| Recovery | Turn it back on |

### Records by folder

| Field | Value |
|---|---|
| Default | On |
| Effect | The folder rule's own switch (#482). On: a note under a record folder, or under a folder whose name matches the archive pattern, is a record for moves and heading renames (they leave its links as written); a record folder's own index note is not a record. The write check judges by the note marker only. Off: no note is a record by its folder, and no folder is an archive for the bracket rule either |
| Takes effect | Live, per call |
| Risk | Off lets a move or heading rename rewrite links inside notes that are records only by their folder |
| Recovery | Turn it back on |

### Record folders

| Field | Value |
|---|---|
| Default | **Empty — the plugin ships no folder names** (Nelson, 2026-10-03). An install that predates the setting is seeded once with the folders #455 hard-coded (03.04 Records, 03.16 Cross-session log, 03.20 Imported chats), then the key is persisted so the seeding never repeats |
| Effect | One vault folder path per line; every note under it is a record (see Records by folder). Saved when the field is left, or when the settings tab closes |
| Takes effect | Live, per call |
| Risk | A fresh install protects no folder until filled in |
| Recovery | Add the folders back; nothing is rewritten by this setting |

### Archive folder pattern

| Field | Value |
|---|---|
| Default | **Empty**. An install that predates the setting is seeded once with the JD archive pattern `^\d\d(?:\.\d\d)*\.09 Archive(?: \|$)` (`00.09 Archive`, `41.09 Archive for …`, dotted IDs) |
| Effect | A regular expression matched against each folder NAME on a note's path; a match makes that folder an archive: a record folder for moves and heading renames, and an archive for the bracket rule (Nelson, 2026-10-02: "Brackets should only be permissible on archived notes that no other note links to"). Saved as written when the field is left or the tab closes; the field's line says whether it is in force |
| Takes effect | Live, per call |
| Risk | A pattern that does not compile matches nothing (it never widens); empty means no folder is an archive. The filesystem server and the triage plugin have no settings and never give or keep a bracket name |
| Recovery | Re-enter the pattern |

## Sync guard

Before an agent's write, vault-mcp can wait for this Mac's Obsidian Sync to catch up (01.43; Nelson's pick A, 2026-10-12). The version check (`if_rev`) holds only inside one Mac, so a rename made while Sync is behind can come back as a twin folder from another device. The guard reads Sync's internal state (an undocumented Obsidian API: `ready`, `error`, `pause`, `syncStatus`, the path of each `newServerFiles` entry, whether `server.socket` is open, and `server.lastMessageTs`, and nothing else of that object, which also holds the vault's key). Sync is behind when it is not ready, has an error, is paused, has no open socket to its server, has had no server message for 2 minutes, or has a server change waiting at a path the write names (the note, a folder that holds it, or a note under a target folder). For a create, the status text is shown but not judged (#528): on a busy day it says "Indexing..." for hours while the socket is open and changes flow, and judging it refused nearly every create; this Mac's own uploads are not behind either. The scheme address tools, `obsidian_periodic_note` and `obsidian_base_create` do not name where they write, so for them a server change waiting anywhere in the vault counts. A rename, move or delete is stricter (#533, Nelson's pick A): it also waits for "Fully synced", because a rename made while this Mac's own changes are still going up is how the 2026-10-10 twin folder came back, and Sync gives no per-file upload signal. On a busy day the "Fully synced" moments are short and far apart (measured: 354 "Fully synced" moments in about 16.6 h, the longest gap 58 min), so such a write waits up to its own, longer wait (`strictWaitSeconds`, 120 s), looks again every half second, and goes on at the first such moment; if none comes it is refused and needs a retry. A create does not judge the text. It proves only that this Mac is current: it cannot know what another device has pulled, and it covers only writes through vault-mcp. `obsidian_doctor` reports the settings and what the guard reads now (`sync_guard`: `sync` for a create, `sync_rename` for a rename, move or delete).

A rename, move, delete or create (the structure kinds: `syncKind` on each row of `inventory-mcp.ts`) waits, then follows the mode. An edit or append always waits, then goes on with a warning. The kinds follow the ruling's list: structure = `obsidian_move_note`, `obsidian_move_notes`, the three scheme address tools, `obsidian_delete_note`, `obsidian_trash`, `obsidian_create_note_from_template`, `obsidian_create_note`, `obsidian_base_create`, `obsidian_periodic_note`, `obsidian_write_note` with `overwrite: false` and an `obsidian_write_notes` item without `if_rev`; content = an overwrite, a patch, a frontmatter change, a heading rename, an append. An append or overwrite that happens to create a missing note counts as content, and a tool with no `syncKind` (an import, a command, a satellite's tools) is not checked. Once a wait has run out with Sync disconnected (or not ready, paused, or silent), calls on the same MCP connection in the next `waitSeconds` are judged at once without a second wait, so a batch pays the wait once; after a rename, move or delete waited out "not Fully synced", the next renames, moves and deletes in the next `strictWaitSeconds` are judged at once too (creates are not affected); a change waiting at one write's paths is not held for the others; a retry whose `idempotency_key` the kernel already holds skips the guard and is replayed. Keep the wait under the MCP client's own timeout (about 60 s), or a content write may land after the caller has given up. The rename wait (120 s by default) is longer than that timeout: a caller can give up while its rename still waits, and the rename then lands or is refused unseen; a retry with the same `idempotency_key` is replayed, not done twice. A refusal is `Error [sync_behind]` (or `Error [sync_unknown]`), before the write queue, so it is not journaled. A warning goes on the result (`sync_warning`, and a `Warning [sync_behind]` or `Warning [sync_unknown]` text line; on an `obsidian_write_notes` item, `sync_warning` on that item's row in `written`) and on the journal record (`syncWarning`).

### Check Obsidian Sync before a write

| Field | Value |
|---|---|
| Key | `syncGuard.enabled` |
| Default | Off (turned on per vault) |
| Effect | On: the guard runs before each agent write it classifies. Off: no check. When the Sync plugin is off in the vault, the guard does nothing |
| Takes effect | Live, per call |
| Risk | On: a structure write can wait up to the wait below, and in Refuse mode is refused while Sync is behind |
| Recovery | Turn it off |

### When a rename, move, delete or create finds Sync behind

| Field | Value |
|---|---|
| Key | `syncGuard.mode` |
| Default | Refuse |
| Effect | Refuse: wait, then refuse with `sync_behind`, nothing written. Wait: wait, then go on with a warning. Warn: no wait, only a warning |
| Takes effect | Live, per call |
| Risk | Wait and Warn let a rename go on while Sync is behind, which is how a twin folder is made |
| Recovery | Set it back to Refuse |

### Wait for Sync to catch up (seconds)

| Field | Value |
|---|---|
| Key | `syncGuard.waitSeconds` |
| Default | 30 (0 to 600) |
| Effect | How long a write waits for Sync before the mode applies (a rename, move or delete uses the wait below instead). The wait is before the write queue, so it holds no other write |
| Takes effect | Live, per call |
| Risk | A long wait makes a caller wait as long |
| Recovery | Lower it |

### Wait for a rename, move or delete (seconds)

| Field | Value |
|---|---|
| Key | `syncGuard.strictWaitSeconds` |
| Default | 120 (0 to 600) |
| Effect | How long a rename, move or delete (`obsidian_move_note`, `obsidian_move_notes`, `obsidian_move_file`, the three scheme address tools, `obsidian_delete_note`, `obsidian_trash`, and a satellite tool that declares `strictStatus`) waits for Sync to say "Fully synced" before the mode applies. It looks again every half second and goes on at the first such moment |
| Takes effect | Live, per call |
| Risk | Longer than the MCP client's timeout (about 60 s): the caller can give up while the rename still waits |
| Recovery | Lower it |

### When Sync cannot be read

| Field | Value |
|---|---|
| Key | `syncGuard.onUnknown` |
| Default | Warn |
| Effect | When the Sync plugin is on but its state cannot be read (no instance, or an Obsidian update changed the fields). Warn: the write goes on with a warning. Refuse: refused with `sync_unknown` |
| Takes effect | Live, per call |
| Risk | Refuse can stop every classified write after an Obsidian update until vault-mcp is fixed |
| Recovery | Set it to Warn, or turn the guard off |

## What agents may write

Separate from what agents may read: the path allowlist limits reads and writes together, and this setting limits writes alone. One key, `writeScope`, in the settings tab or in `data.json`, for example `{"writeScope": {"mode": "create-only", "paths": ["**/[0-9][0-9].01 Inbox/*.md"]}}`. No folder name is built into the plugin: the patterns are the operator's.

### What agents may write

| Field | Value |
|---|---|
| Key | `writeScope.mode` |
| Default | All |
| Effect | All: any write that read-only mode and the allowlist allow. Create new notes only: a write is allowed only when it creates a new note, in a folder that already exists, at a path matching one of `writeScope.paths`, through `obsidian_write_note` (without `overwrite`), an `obsidian_write_notes` item without `if_rev`, or `obsidian_create_note`. Other writes are refused with `write_scope` before the queue: an overwrite, an edit, an append, a frontmatter change, a rename, a move, a delete, a trash, a command, a snippet or plugin change, and any tool not on that list, a satellite's included (a satellite plugin listed in `trustedReadOnlyPlugins` is believed to be read-only and is not checked). Reads do not change. A value that is present but is not exactly `all` or `create-only` with a list of patterns (a misspelt mode, for example) refuses all writes |
| Takes effect | Live, per call |
| Risk | Create new notes only with no patterns: no writes at all |
| Recovery | Set it to All, or add the patterns |

### Where new notes may be created

| Field | Value |
|---|---|
| Key | `writeScope.paths` |
| Default | Empty |
| Effect | Glob patterns over the vault-relative note path, one per line in the tab: `**` is any folders (or none), `*` and `?` stay within one name, `[0-9]` is a character class. A character class does not match `/`. A path is judged after `.` and `..` are resolved. A pattern that does not compile is dropped. Used only with Create new notes only |
| Takes effect | Live, per call |
| Risk | A pattern wider than meant, such as `**`, allows a new note anywhere |
| Recovery | Narrow or remove the pattern |

The filesystem server (the FS fallback of the HTTP front) reads the same value as JSON from the environment variable `VAULT_MCP_WRITE_SCOPE`. Unset: no write rule. A value that does not parse, or that is not exactly the setting's shape, refuses all writes, so a typo does not open what it was meant to close.

## Moving files

### File types obsidian_move_file moves

| Field | Value |
|---|---|
| Key | `fileMoveExtensions` |
| Default | `png jpg jpeg gif webp svg bmp avif` (images), `mp3 wav m4a ogg flac webm 3gp` (audio), `mp4 mov mkv ogv` (video), `pdf`, and `docx xlsx pptx odt zip` |
| Effect | The extensions (lower case, without the dot) of the files `obsidian_move_file` moves and renames between folders, besides `.base` and `.canvas`, which always move. The extension is kept, in the same case. On this plugin, links and embeds in notes that reach the file (`![[Scan.pdf]]`, `[[Scan.pdf\|scan]]`, `![](Scan.pdf)`) are rewritten to the new path and damage-checked, as for a note move; HTML embeds (`<img src>`, `<video src>`, `<audio src>`) and file nodes in other `.canvas` files are not rewritten. A move never replaces an existing attachment: `overwrite: true` is refused (`overwrite_refused`) unless the file is a `.base` or `.canvas`. A note (`md`) is never moved by this tool, whatever the list says: `obsidian_move_note` moves notes. The guards of a note move apply too: `idempotency_key`, the Sync guard (a move is a structure write that waits for "Fully synced"), the path allowlist at both ends, the write scope (Create new notes only refuses the move), the name checks, the hidden-folder refusal, the connection profile (only `full` offers the tool) and the journal. Writing and editing files (`obsidian_write_file`, `obsidian_edit_file`) stays `.base` and `.canvas` only. Empty: only `.base` and `.canvas` move. Absent from `data.json` (an install from before the setting): the default list, so an upgrade turns the wider move on; set the list to empty to keep the old behaviour. A value that is present but not a list (for example `null` or a string) also means only `.base` and `.canvas`, and a warning is logged. `obsidian_doctor` reports the list in use as `file_move_extensions`. In the tab: extensions separated by spaces, commas or new lines; an entry is trimmed, its dot dropped, lower-cased, and dropped when it is not 1 to 16 letters or digits, or is `md`, `base` or `canvas`; a notice names each entry dropped |
| Takes effect | Live, per call (the tool's description lists the types as they were when the connection was made) |
| Risk | A type added to the list can be moved by any agent with the full profile, for example a script or a config file outside the hidden folders. The default holds no executable, script or config type (`json`, `css`, `js`). Files in hidden folders, such as the app's config folder, never move here |
| Recovery | Remove the type from the list |

The filesystem server reads the same list from the environment variable `VAULT_MCP_FILE_MOVE_EXTENSIONS` (extensions separated by commas or spaces). Unset: the default list. Set but empty, or with no valid entry: only `.base` and `.canvas` (a warning names what was left out). That server does not rewrite links or embeds to a moved file (its link index covers notes only); its reply's `links_note` says so.

Deleting such a file: `obsidian_trash` on this plugin takes any file and moves it to the system trash (it needs `if_rev` and `idempotency_key`). To get the `rev`, call `obsidian_read_note` on the file: for a binary file (a type on the default list or on this one, or a file with NUL bytes) it returns only `{path, rev, size, binary: true}`, with no content and no read of the bytes as text, on both servers (the filesystem server has no `rev`). The filesystem server has no trash tool, and its one removal tool, `obsidian_delete_note`, is a permanent delete that stays notes-only.

## Creating notes

### Construction module for obsidian_create_note

| Field | Value |
|---|---|
| Key | `createNoteFlow` |
| Default | Empty (the plugin ships no vault folder name) |
| Effect | The vault-relative path of the vault's `flow.js`, the module with `applyFileclass`. Set: agents get `obsidian_create_note`, which makes a note of a fileclass from that class's own `## Template` (#531): the values fill its `{{VALUE:…}}` blanks, quoted as YAML needs (a string stays a string), the missing required ones are named together in one refusal, `{{DATE}}` is filled (a format that ends in a time, `HH:mm` or `HH:mm:ss`, gets the local offset), a value for a field the class declares that the note does not set goes into the frontmatter and a value used nowhere is listed in the result's `unused_values`, each new note gets a `uid` and `created`/`modified` with the local offset (#537), `frontmatter` adds keys the template does not write (not the class key, acceptance or `verified`), the note lands in the class's declared folder or the caller's `folder`, and an existing note, an unsafe name, a value with a line break, acceptance or `verified` in the result, or a path outside the allowlist is refused. The note is rendered in memory, checked, and written once through the plugin's own guarded write; nothing is written when a check fails. Its path is computed, so scope claims and the journal's target do not see it (the journal's effects do). Empty: the tool is not offered |
| Takes effect | On the next MCP connection |
| Risk | A wrong path: each call is refused with `unavailable` and nothing is written |
| Recovery | Correct or clear the field |

## Running headless

For a host with no Obsidian window, such as vaultd's headless plugin host. The bridge (`bridge.mjs`) and the HTTP front read the environment variable `VAULT_MCP_STATE_DIR` as the plugin does, so a front started with it reaches a plugin whose state folder is outside `~/.claude/`; the front passes it on to each bridge it starts. The four keys sit under one setting, `host`, so one entry in `data.json` sets them all, for example `{"host": {"headless": "on", "stateDir": "/srv/vault-mcp/state", "autoRegisterClaude": false}}`. When the headless host gets the vault through Obsidian Sync, put these keys in the [machine-local override](#machine-local-override) instead, so they do not reach the desktop.

### Headless

| Field | Value |
|---|---|
| Key | `host.headless` |
| Default | Auto |
| Effect | On (or Auto with `VAULT_MCP_HEADLESS=1`): the tools that need the Obsidian app (`obsidian_open_in_editor`, `obsidian_jump_to`, `obsidian_toggle_view_mode`, `obsidian_open_workspace`, `obsidian_save_workspace`, `obsidian_list_workspaces`, `obsidian_open_bookmark`, and the tools that run the `obsidian` CLI: `obsidian_note_history`, `obsidian_note_diff`, `obsidian_base_create`, `obsidian_plugin_install`, `obsidian_plugin_uninstall`, `obsidian_cli`) are not offered, and two tools refuse one form of a call (`obsidian_periodic_note` with action open, `obsidian_run_command` with `file_path`); the commands that open a view or a dialog (the scheme panes, Connect to Claude Code, Run tool, Show diagnostics) are not added; and the load-time registration with Claude Code does not run. Auto: the environment variable `VAULT_MCP_HEADLESS` decides when it is set (`1` acts as On, `0` as Off); without it those tools and call forms refuse with `headless_unsupported` when the workspace has no leaf once its layout is ready, which Obsidian itself does not have. Off: as in Obsidian |
| Takes effect | When the plugin next loads; the call-time refusal in Auto is live |
| Risk | On in a real Obsidian: the editor and CLI tools disappear from every connection |
| Recovery | Set it to Auto or Off and reload the plugin |

### State folder

| Field | Value |
|---|---|
| Key | `host.stateDir` |
| Default | Empty: `~/.claude/vault-mcp/` (or the environment variable `VAULT_MCP_STATE_DIR`; inside the plugin the setting wins) |
| Effect | An absolute path (a relative one is ignored): where the socket, `bridge.mjs`, the discovery file and the observation store go. Set: the plugin also writes no grace-period legacy copy into `~/.claude/governor/`. The bridge finds the discovery file in its own folder, so a Claude Code registration that runs `<state folder>/bridge.mjs` works with no variable. The HTTP front reads only the variable: start it with `VAULT_MCP_STATE_DIR` set to the same folder |
| Takes effect | When the plugin next loads |
| Risk | A Claude Code registration that points at `~/.claude/vault-mcp/bridge.mjs` no longer finds this vault |
| Recovery | Clear the field and reload the plugin |

### Socket path

| Field | Value |
|---|---|
| Key | `host.socketPath` |
| Default | Empty: `<state folder>/<vault>.sock` |
| Effect | An absolute path (a relative one is ignored): the socket the plugin listens on. Point the HTTP front's `VAULT_MCP_SOCKET` at the same path |
| Takes effect | When the plugin next loads |
| Risk | Two vaults set to one path: the second one to load does not get the socket |
| Recovery | Clear the field and reload the plugin |

### Register with Claude Code at load

| Field | Value |
|---|---|
| Key | `host.autoRegisterClaude` |
| Default | Off on a fresh install. An install whose saved settings predate the key keeps On; the plugin writes the key once at its next load, so the value stays. A saved value, On or Off, is kept |
| Effect | On: at load the plugin runs `claude mcp` to add itself to Claude Code when it finds the `claude` CLI. Off, or headless declared (Headless on, or Auto with `VAULT_MCP_HEADLESS=1`), or `VAULT_MCP_NO_AUTOREGISTER=1`: it starts no `claude` process at load. The Connect to Claude Code command still works where it exists |
| Takes effect | When the plugin next loads |
| Risk | Off on a new Mac: Claude Code is not connected until someone runs the command |
| Recovery | Turn it on, or run Connect to Claude Code |

## Machine-local override

Obsidian Sync carries the plugin's `data.json` to every device that syncs the vault, so every device reads the same settings. A headless replica (a server that gets the vault, and this plugin, through Sync and runs it with no Obsidian window) needs settings that the desktop must not get, and the desktop has settings that the server must not get. The machine-local override is a second settings file, outside the vault, that only one machine reads (#579). Sync never carries it, because it is not in the vault.

### Where the file is

| Field | Value |
|---|---|
| Variable | `VAULT_MCP_LOCAL_SETTINGS`: an absolute path to the file |
| Default | `<base state folder>/local/settings.json`, where the base state folder is the environment variable `VAULT_MCP_STATE_DIR`, else `~/.claude/vault-mcp/`. The file is in the `local` subfolder on purpose: the bridge, the Claude Code health hook and the plugin read the `*.json` files directly in the state folder as vault discovery files. They also skip any JSON file there that has no `socket_path`, so a stray file is never read as a vault |
| Absent file | No override: the synced settings apply as they are. At the default path, a file where the `local` folder would be (the error ENOTDIR) also counts as absent. Any other error at the default path, such as no permission (EACCES) or a loop of links (ELOOP), stops the plugin. A file that `VAULT_MCP_LOCAL_SETTINGS` names but that does not exist is an error (see below), because to name it is to say that it exists; with the variable set, every error stops the plugin |
| Takes effect | When the plugin next loads. The file is read once, at load, so a change to it needs a plugin reload (or an Obsidian restart) |

The plugin looks for the file through the environment only, never through the `host.stateDir` setting. `host.stateDir` is a setting, so it can come from the synced `data.json`; if it chose where the override is read, a value synced in from another device could move this machine's override out of sight, and this machine would quietly run on the synced settings. The override itself may set `host.stateDir`: that moves the socket, `bridge.mjs` and the discovery file, as the setting always does, and it does not move the override. To keep the override inside a state folder of your own, set `VAULT_MCP_STATE_DIR` (or `VAULT_MCP_LOCAL_SETTINGS`) in the environment the plugin runs in.

### How it merges

The file is one JSON object with the same keys as `data.json`. The plugin loads the synced `data.json` first, then merges the override on top, key by key:

- An object merges into the synced object: `{"host": {"headless": "on"}}` sets `host.headless` and keeps the synced `host.socketPath`.
- Any other value replaces the synced value. A list replaces the synced list; it is never merged item by item. An empty list in the override replaces a full synced list, so `{"allowlist": []}` means "no allowlist on this machine".
- `null` is refused. To take the synced value, leave the key out.

After the merge, each value goes through the same checks as a value in `data.json`.

### When the file is bad

A bad override stops the plugin. It does not serve (no socket, no bridge, no discovery file, no Claude Code registration, and other plugins that ask it for settings get no answer), it logs the reason in the console and it shows the reason in a notice that stays until you close it. It never falls back to the synced settings: an override often makes a machine stricter (headless on, create-only writes, no registration), so to drop it would loosen the machine without anyone choosing that. The file is bad when:

- it is not a regular file (a folder, or a link to nothing), or it cannot be read (see the table above for ENOTDIR at the default path);
- it is not valid JSON, or not one JSON object;
- a key is not a setting of this plugin (a misspelt key would otherwise do nothing), or a key under a setting with fixed keys (such as `host` or `writeScope`) is not one of its keys; keys under `modules` and `cliPolicy.opaqueSnapshot` are free, as in `data.json`;
- a value has the wrong type (a string where the setting is a boolean, an item that is not a string in a list of folders);
- a value is one the setting does not take, so that its check would change it (an unknown mode, a relative path, a `writeScope.paths` pattern that does not compile, a record folder that is blank or only slashes, a number out of range), or a `recordFolders.archivePattern` that does not compile as a regular expression (in `data.json` such a pattern matches nothing; in the override it is refused);
- a value is `null`, or a key is `__proto__`, `constructor`, `prototype`, empty, or holds a `.` (keys are read as dotted paths);
- `VAULT_MCP_LOCAL_SETTINGS` names a relative path, or a file that does not exist.

Fix or remove the file, then reload the plugin.

### What the settings tab and a save do

The settings tab names the file and the keys it sets, above the tabs. Each control whose key the override sets is locked (it cannot be changed) and says where its value comes from. A save from the settings tab never writes this machine's values into the synced `data.json`: for each overridden key it writes the value that the synced file holds now, or, when the synced file does not hold that key, the value it had when the plugin loaded; every other key is saved as usual. So the other devices keep their own values for the keys this machine overrides.

Satellite plugins that copy settings from the host once, on their first load (such as `vaultmcp-conformance`), read the host's synced `data.json`, not the override.

`obsidian_doctor` reports the override as `local_settings`: the path it is looked up at, whether it comes from `VAULT_MCP_LOCAL_SETTINGS` or the default, whether the file was found, and the names of the keys it sets. It never reports their values.

### Which keys belong in the override

Put a key in the override when its right value depends on the machine, not on the vault. For a headless replica, these usually belong there:

| Key | Why on this machine only |
|---|---|
| `host.headless` | `on` on the server; the desktop needs `auto` or `off`, or its editor and CLI tools go away |
| `host.stateDir`, `host.socketPath` | Folders on the server's own disk; the desktop's folders do not exist there, and the server's do not exist on the desktop |
| `host.autoRegisterClaude` | Off on a server that has no Claude Code to register with, or that registers its clients another way |
| `writeScope` | A server that agents reach from outside is often limited to creating notes (`create-only` with its own patterns), while the desktop keeps `all` |
| `readOnly`, `allowlist` | A replica can be made read-only, or limited to some folders, without limiting the desktop |
| `redactProfiles`, `redactConfig` | The secret scanner is for remote connections; a server that serves them turns it on, a desktop with local connections only may leave it off |
| `enabled` | The socket can be off on one device and on on the other |

Keys that describe the vault itself (guarded territories, record identification and record folders, protected properties, the command policy) usually stay in the synced `data.json`, so the devices share them. You can override them too; that is your choice.

An example override for a made-up server: `{"host": {"headless": "on", "stateDir": "/srv/example/vault-mcp/state", "autoRegisterClaude": false}, "writeScope": {"mode": "create-only", "paths": ["Inbox/*.md"]}}`.

An override can also make one machine less strict than the synced settings (for example `{"readOnly": false}` where the synced file says `true`). That is the operator's choice for that machine; the plugin does not stop it.

### The filesystem server

The filesystem server in `packages/server` (the HTTP front's fallback when Obsidian is closed) does not read `data.json` at all: it takes its settings from environment variables (for example `VAULT_MCP_WRITE_SCOPE`), which are already local to the machine. The override does not apply to it.

## Conformance

These settings belong to the separate `vaultmcp-conformance` plugin since 2026-10-14 (its own settings tab and `data.json` at `.obsidian/plugins/vaultmcp-conformance/`). Until then they were the host's Conformance tab. On its first load with the host present, the plugin copies the host's `vaultConventions` and `modules["conformance-debt"].config` once and does not write the host's settings; the host keeps the old keys in its `data.json` and reads neither.

### Vault conventions

| Field | Value |
|---|---|
| Default | **Empty — the plugin ships no vault layout** (ruled 2026-09-26, #403). The plugin adopts the host's conventions once; a host record without them gives the former built-in paths only when the former baseline note exists in the vault, and is empty otherwise |
| Effect | The three paths the conformance rail's legacy checks read: the registries root (the structure check's blueprint registry) and the system root (the drift check's category-number scan), two single paths, and the ungoverned roots (one path per line). Committed when a field loses focus. A blank single path means that convention is **dead**: the checks that read it register, are not measured, and the report says `DEAD CONVENTION: <key> = (empty)`; an empty list means none (nothing ungoverned). Until #412 there were six; the artifacts root, the plugin-stack note and the uid-exempt notes fed only drift checks that measured a vault shape the rebuilt vault no longer has, and retired with them. A path that names nothing under the walked root is dead the same way, with the path shown. **The fourth field, Conformance baseline note** (`baselineRel`, #493), is not a check path: it names the accepted-debt baseline note that the debt tools and the drift pane read when they run. Blank (with no `GOVERNOR_BASELINE_REL` in Obsidian's environment) means no baseline, and those views refuse; a name that does not exist refuses too. An install that predates the field is filled once with the path it was reading |
| Takes effect | Live, per call (the in-app debt tools and the drift pane read the setting on every run) |
| Dependency | The Vault MCP host, for its guarded territories: with no host answering, the debt tools and the Drift pane refuse to run. The standalone CLI does not read the check paths; it reads only the baseline note, as a last fallback (see below) |
| Risk | Blank or stale paths make the legacy checks report nothing for the vault, and say so on every run rather than reading clean; a folder renamed in the vault leaves its convention dead until re-pointed |
| Recovery | Point each field at the live folder; the report names the dead key and the checks it feeds |

The standalone conformance CLI has no settings of its own; it reads `VAULT_MCP_CONVENTIONS` (a JSON object over the same keys, `baselineRel` included). For the baseline it reads, in order, `--baseline=<path>`, `GOVERNOR_BASELINE_REL`, `baselineRel` in that object, then the plugin's setting in the vault: `.obsidian/plugins/vaultmcp-conformance/data.json` when it holds the conventions, else the host's `.obsidian/plugins/vault-mcp/data.json` (before the plugin has adopted them); with none of them it refuses to run (#493). The path is derived by the plugin's own load rule, so a data.json that predates the field gives the path the plugin will fill. `--rebaseline` refuses a target that is any live baseline it can see (the CLI's, the `VAULT_MCP_CONVENTIONS` one when `GOVERNOR_BASELINE_REL` shadows it, the plugin's), and refuses outright when none names one. `GOVERNOR_VAULT_CONVENTIONS` and `ASSENT_VAULT_CONVENTIONS` are read as legacy aliases for one release, each with a warning naming the new spelling.

### Debt register

| Field | Value |
|---|---|
| Default | Stale after 90 days, no debt budget, budget not strict, the register beside the baseline note, at most 300 table rows |
| Effect | `staleAfterDays` (0 turns staleness off), `debtBudget` (the carried count above which the report warns), `strictBudget` (report an overrun as a failure), `registerDir` (the folder the register note is written to), `registerMaxRows` (the table cap). Read by `vaultmcp_conformance_debt` and `vaultmcp_conformance_debt_render`. In the host these were a hand edit of `modules["conformance-debt"].config`; the plugin shows them as fields |
| Takes effect | Live, per call |
| Dependency | None |
| Risk | A `registerDir` that is absolute or climbs out of the vault makes the render refuse (`invalid_register_dir`) |
| Recovery | Clear the field to go back to the default |

## Modules

Optional modules use one common availability vocabulary: available, disabled, missing dependency, incompatible version, outside scope, or temporarily unavailable.

| Module | Default | Consequence | Dependency | Recovery |
|---|---|---|---|---|
| Stable identity and link health | On | Read-only reports and stable references | Metadata cache | Repair duplicates deliberately |
| Bases (satellite `vaultmcp-bases`) | On when public API is available | Evaluated read-only rows | Supported Obsidian Bases API | Disable or update Obsidian |
| Vocabulary (satellite `vaultmcp-vocab`) | Off until configured | Read-only validation | Vocabulary sources | Fix config or disable |
| Scheme addressing | Off until configured | Resolution and preview-first placement | Scheme provider | Use literal paths or stable identities |
| Conformance | Off until baselined | New-drift reporting | Accepted baseline and declared territory | Run report-only, repair or review debt |
| Provenance (satellite `vaultmcp-provenance`) | Off | Freshness, reconciliation, and governed regeneration | Declared sources and generator | Report only or restore prior generated artifact |
| Health (satellite `vaultmcp-health`) | Off | Scoped or whole-vault reports | Scanner rules and resource budget | Disable or narrow scan |
| Fileclass (satellite `vaultmcp-fileclass`) | Off | Schema inspection and governed representation changes | Compatible Fileclass plugin and CLI surface | Disable or edit through ordinary note operations |
| JD scaffolding (satellite `vaultmcp-jd-scaffold`) | Off | Configured structure and identifier scaffolding | Templates and scheme configuration | Dry-run, restore exact cohort, disable |
| Survey | Report-only when available | Deterministic observations for planning | Survey adapters | Disable or use direct reads |
| QuickAdd bindings | Off until explicitly bound | Named choice capabilities | Installed QuickAdd and declared binding manifests | Disable binding; opaque choices remain private |

The complete module list and each module's target default are in the [Module directory](modules.md); this summary is not a second inventory owner. Skills is no longer a module of this plugin's settings tab — its config moved to the separate `vaultmcp-skills` plugin's own settings tab, with a one-shot adoption of the recognized keys out of this plugin's former `modules.skills.config` on that plugin's first load (see [skills.md](skills.md)). Triage is no longer a module of this plugin's settings tab either — its config moved to the separate `vaultmcp-triage` plugin's own settings tab, with a one-shot adoption of the recognized keys out of this plugin's former `modules.triage.config` on that plugin's first load (see [triage.md](triage.md)). Cross-session coordination is no longer a module of this plugin's settings tab either — its config moved to the separate `vaultmcp-crosssession` plugin's own settings tab on the same one-shot terms, out of this plugin's former `modules.crosssession.config`; that plugin also adopts this one's `crosssession-receipts.json` read-receipt file once, because the receipts are live operational state rather than configuration (vaultmcp-crosssession was retired on 2026-10-15 (Nelson's verify of 'Retire vaultmcp-crosssession')). Provenance, Fileclass and JD scaffolding left the settings tab together as the mutating tier: provenance and Fileclass config moved to the `vaultmcp-provenance` and `vaultmcp-fileclass` plugins' own tabs on the same one-shot terms, out of this plugin's former `modules.provenance.config` and `modules.fileclass.config`; JD scaffolding had no config rows at all, so the `vaultmcp-jd-scaffold` plugin has nothing to adopt and says so rather than shipping an empty migration. Acceptance is no longer a module of this table either, but for the opposite reason: rather than moving to a new satellite, its enabled flag and config block simply stay the governance provider's own — the `governor` plugin kept its id and its own `data.json` in the host/provider split. Nothing about it moved; only its classification did, from a module row in this table to a setting the provider now owns outright (see [acceptance-model.md](acceptance-model.md)).

For the first Community release, skills/policy compilation (now the separate `vaultmcp-skills` satellite plugin), JD scaffolding (now the separate `vaultmcp-jd-scaffold` satellite plugin), triage mutations (now the separate `vaultmcp-triage` satellite plugin), QuickAdd execution bindings, and provenance regeneration (now inside the separate `vaultmcp-provenance` satellite plugin) are private/operator features and are absent from the public bundle. Bases, scheme, vocabulary, conformance, health, survey, Fileclass inspection, and provenance inspection may ship as bounded public optionals when their dependencies and manifests are satisfied — six of them as their own plugins rather than as sections of the host's settings tab: Bases, vocabulary and health since the S7 read-tier extraction, and Fileclass, provenance and JD scaffolding since the mutating tier followed them.

## Operation evidence and retention

### Write journal retention

| Field | Value |
|---|---|
| Default | Monthly append-only files retained until the user prunes whole months |
| Effect | Records operation metadata and reduced argument digests, not note bodies |
| Takes effect | New journal records |
| Dependency | Writable plugin data directory |
| Risk | Paths, operation names, intent, and timing can still be sensitive |
| Recovery | Export for incident evidence, then prune whole files under a documented retention policy |

A journal-write failure never turns a completed vault mutation into a failure response. It must produce a visible health warning because audit evidence is degraded.

### Replayable observation retention

| Field | Value |
|---|---|
| Default | Session review and recovery window, followed by configured local expiry |
| Effect | Retains content-addressed Governor-returned payloads separately from the reduced operation journal |
| Takes effect | New captures and scheduled retention runs |
| Dependency | Protected local observation store |
| Risk | Payloads may contain complete note bodies, metadata, queries, and historical content |
| Recovery | Inspect dependencies, export required evidence, then delete eligible payloads through the audited retention control |

The reduced journal and replay store serve different purposes. Journal minimization does not imply that a replayable observation contains no note content.

## Advanced and private settings

Private capability packs have their own enablement, scope, audit, and offboarding. They are absent from the normal public agent surface. Turning on a private pack is a deployment decision, not a casual feature toggle. See [Advanced capability packs](advanced-capability-packs.md).

## After changing settings

Governor distinguishes live settings, next-connection settings, and restart-required settings. The UI must say which applies beside every control. When in doubt, reconnect the client and ask Governor for the current capability directory; do not infer availability from the presence of a setting alone.
