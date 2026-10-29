# Governor

**Let AI assistants work with your Obsidian vault without giving up control of it.**

Governor ships as two desktop-only Obsidian Community Plugins working together: the host (plugin id `vault-mcp`, display name "Vault MCP") and the governance provider (plugin id `governor`, display name "Governor"), both at 0.19.0. The host alone gives a compatible local AI client audited, journaled, allowlist-scoped access to the vault — ungoverned. Installing the governance provider on top of it turns that audited access into governed access: it adds control over what the assistant can change, how results are verified, and which exact results have standing. Obsidian remains the visible home of the work either way.

`vault-mcp` was this project's original single-plugin id, later renamed to `governor`. The 0.19.0 split reintroduces `vault-mcp` as the host's own id — a live, current plugin, not a legacy alias — while `governor` stays the governance provider's id. See [Status and compatibility](docs/status-and-compatibility.md) for exact release state and [the migration plan](docs/s3c-migration-plan.md) for the cutover.

The name **Governor** comes from the **governor in an engine**: a mechanism that regulates speed and output as the load changes. The governance provider does the analogous job for human-agent work. It does not choose the destination or do the work itself; it keeps the machinery within the authority, pace, and operating limits the person set.

> [!important]
> This is a proposed target-state documentation package. It describes the coherent public product that results when the associated review recommendations are implemented. It is not evidence that every behavior described here is present in a particular build. See [Documentation basis](docs/documentation-basis.md) and [Status and compatibility](docs/status-and-compatibility.md).

## The five-minute mental model

You have two surfaces over the same notes:

- **Obsidian** is where the notes live and where you inspect, edit, link, and review them.
- **Your AI assistant** is a conversational way to work with those notes.

The Governor suite is the boundary between them. It starts with reading only. You decide which folders a connection may access and which classes of change it may attempt. For larger work, you can accept a bounded mandate once, let Governor verify the result, and decide an entire session or collection cohort together. Changes outside that authority remain proposals.

Underneath those human choices, every request becomes an **operation** of one registered **action**. Governor can preserve substantive reads as replayable **observations**, then connect them to the effects, verification, proposal, and authority decision that followed. This lets review answer both “What did it do?” and “What vault information did Governor give it?” without pretending to record the assistant's private reasoning.

You do not need to memorize tools, schemas, file paths, or MCP terminology. Ask for the outcome you want:

- “Find everything related to the house renovation and remind me where I left off.”
- “Add this idea to my inbox, but do not reorganize anything.”
- “Show me how you would merge these three notes before changing them.”
- “Open the proposals that need my decision.”
- “Check this project for broken links and inconsistent properties.”

## Four postures you can understand

Governor presents four ordinary-language postures:

| Posture | What happens |
|---|---|
| **Looking only** | The assistant can search, read, explain, navigate, and validate within its scope. Nothing in the vault changes. |
| **Drafting a change** | The assistant can prepare a plan or preview. It shows the proposed effect without applying it. |
| **Proposing governed changes** | The assistant may create bounded proposals. They have no standing until admitted. |
| **Working under a mandate** | The assistant may perform the exact classes, transformation, scope, and budget you delegated. Governor verifies the results and either presents a cohort decision or admits them under the mandate. |

These are user-facing postures, not a promise that every internal operation has only four states. Finer states remain underneath when they are needed for safety and diagnosis.

## Acceptance belongs to the person

An assistant may propose a change, accept a delegation, negotiate a narrower mandate, revise its work after feedback, and show you exactly what changed. It cannot accept its own proposal, expand its mandate, choose its authoritative identity, or manufacture standing.

**Acceptance is always a human authority act.** You may exercise it over one result, one frozen cohort, or prospectively through a bounded mandate. Governor—not the authoring agent—admits an exact verified result under that authority. There is no agent-accessible accept or admit operation.

That separation is the core guarantee: authorship does not create authority. It also avoids turning governance into hundreds of identical clicks.

## Sessions and cohorts make review scale

Governor groups work without making the group vague:

- a **session** is one bounded body of work;
- a **mandate** is the authority you delegated;
- a **cohort** is the exact frozen set being verified and considered together; and
- a **change class** says whether the effect concerns encoding, presentation, representation, filesystem structure, content, or authority.

You can start from “everything in this session” or “this collection,” drill down to individual notes, exclude exceptions, request one revision across the cohort, and accept the exact verified set once. Later additions are never included in an earlier decision.

## What every durable operation returns

Governor never treats “the command ran” as a sufficient answer. A durable operation ends with a receipt. Reads name the action, operation, scope, sources, capture level, and replay reference when available. A mutation additionally states:

- whether it completed, failed, conflicted, or has an uncertain outcome;
- which notes or scopes were affected;
- what changed in human terms;
- which safeguards applied;
- how the result was verified;
- whether anything still needs review;
- which session, mandate, cohort, and verification apply;
- how to recover or undo the change; and
- where to find the journal record, when available.

If an operation times out after it may have reached the vault, the receipt says **uncertain**. The assistant must re-read before retrying.

## Safe by default

A fresh installation begins in **Looking only**. Before enabling writes, you choose the accessible folders. The first write level is limited to scoped creation and end-of-note appends. Broader edits and structural work require preview and an explicit posture change.

Governor's normal Community Plugin surface does not expose permanent deletion, arbitrary code or generic command execution, plugin installation or removal, unconstrained configuration or CSS writing, destructive imports, unconstrained outside-vault exports, or restoration that could reinstate revoked authority.

Private operators may add separately installed capability packs. Those packs are not part of the public default and are not covered merely because Governor itself appears in the Community directory.

## Write protection: `if_rev` and `idempotency_key`

**An argument a write tool does not name is refused.** A write tool that vault-mcp registers (the shared tools on both servers and the plugin's own, `obsidian_write_notes` and each of its items included) answers an unknown argument with a validation error, `Unrecognized key(s)`, and writes nothing, where a plain schema would drop the argument and run the call without it (#510). The kernel arguments (`if_rev`, `idempotency_key`, `intent`) are named on each of these write tools, so they stay accepted; on the file-system server they are accepted and not checked. `obsidian_write_notes` names `intent` at the top level and `if_rev` and `idempotency_key` on each item, so a top-level `if_rev` or `idempotency_key` is refused. Read tools, and satellite tools published by other plugins, keep their own schemas.

Each of the host's own write tools declares the protection it needs, and the host refuses a call that does not carry it (01.43 rules 3–4, 01.33 rule 6f). The exceptions, the temporary exemptions, the satellite tools and the file-system fallback server, are named at the end of this section. Two arguments carry the protection. Neither reaches the tool's own code: the host takes them off the call and checks them.

- **`if_rev`** is the revision of a note as you read it. Get it by reading the note: `obsidian_read_note` (and `obsidian_read_notes`) return `rev`. Pass that value unchanged. If the note changed after you read it, the write is refused with `rev_conflict` and nothing is written, so you never overwrite a change you did not see. A tool that changes content you read needs it: an overwrite, a frontmatter set or delete, a patch replace.
- **`idempotency_key`** is any string that is new for each write you intend (a UUID is fine). If the call fails or times out and you retry, send the SAME key with the same arguments: the host then does the write once, and a retry of a finished write returns the first result. The host remembers a key for 10 minutes, and forgets it when the plugin reloads. Never reuse a key for a different write. A write that is not safe to repeat needs it: an append, a move, running a command.
- A tool that trashes or deletes a note needs both. A create needs neither: a new note has no revision, and a second create of the same note fails on its own.

Each tool's schema says it too: the argument's description opens with `REQUIRED` where the tool needs it. The [agent guide](docs/agent-guide.md#required-protection) has the same rules in short.

**What a caller sees, and what to do:**

| Error | Meaning | What to do |
| --- | --- | --- |
| `Error [protection_required]: '<tool>' requires if_rev …` | The call carried no `if_rev`. Nothing was written. | Read the note, then send the call again with its `rev` as `if_rev`. For `obsidian_write_note`, set `overwrite: false` if you meant to create a note. |
| `Error [protection_required]: '<tool>' requires idempotency_key …` | The call carried no key (an empty string counts as none). Nothing was written. | Send the call again with a new key. |
| `Error [rev_conflict]: …` | The note changed after you read it. Nothing was written. | Read it again and decide again. Do not copy the new `rev` into the old plan. |
| `Error [idempotency_mismatch]: …` | A key you used before came with a different tool, different arguments or a different `if_rev`. | Use a new key for a new write. |
| `Error [truncated_read]: …` | Either the text you supplied (a note's content, the fragment of a patch or an append, or the `new` text of a replace) carries the read trailer (`[truncated: note is N chars, showing first M]` on a line of its own), so it is a cut read or text copied from one; or you are overwriting whole a note that is longer than the read limit, which is never done whole over MCP (the read tools cut it there, so whatever you edited in, the write is of a cut read). Either way the write would delete the tail. Nothing was written. | Never write a cut read back. Edit the note by anchor (`obsidian_patch_note` on a section that ends before the limit, `obsidian_append_note`, `obsidian_append_at_heading`, `obsidian_manage_frontmatter`); the read's `rev` is good for those. A `replace` whose section runs past the limit (the top heading's runs to the end) is refused with the same code, at the write, so that one is in the journal. For a whole rewrite of a long note, read it whole first (`obsidian_read_note` with `full: true`, at your cost in context) and write with the `rev` that read returned within ten minutes; the host remembers what it served whole on that connection, and lets that overwrite through while the note is unchanged. A line quoted on purpose writes its numbers as letters (N, M). |
| `Error [no_match]`, `Error [many_matches]`, `Error [frontmatter_edit]`, `Error [invalid_replace]`: … | `obsidian_replace_text` found its `old` text 0 times, or more than once without `all: true` (the message names the count and the lines); or a match would touch a frontmatter fence, leave the frontmatter unparseable, or give a note with none a frontmatter block; or `old` is empty, equal to `new`, or starts on the note's byte-order mark. Nothing was written. | Read the note again and copy `old` exactly (in a CRLF note, a multi-line `old` uses `\r\n`); add context until it is found once, or pass `all: true`. To change a property, use `obsidian_manage_frontmatter`. |
| `Error [unsafe_name]: …` | A write or append would create a note, or a move or rename would give one a name, holding a character Obsidian Sync refuses (`\ : * ? " < > |`) or one that breaks links (`# ^ [ ]`). Nothing was written. A note that already has such a name stays writable in place, and a move may keep the note's own name and the folders it is already in; any new name or folder must be clean. `[` `]` (Nelson, 2026-10-02): allowed only in the name of a note under an existing archive folder, one the plugin's archive-pattern setting names while "Records by folder" is on, that no other note links to (checked against Obsidian's index, every note's current text, and unresolved links that the name would answer), never in a folder name; a kept bracket name may only stay under an archive; the filesystem server and triage have no archive pattern and never give or keep a bracket name. | Pick a name without them (for example ` - ` for `: `) and keep the full title in `title:`. |
| `Error [sync_behind]: …` | The Sync guard is on (a plugin setting) and this Mac's Obsidian Sync was still behind after the wait, for a rename, move, delete or create. Nothing was written. Such a write made while Sync is behind can come back from another device as a twin. | Wait until Sync has pulled that change, is connected again, or (for a rename, move or delete, which waits up to 120 s) says Fully synced; the message says which. Then send the call again. |
| `Error [sync_unknown]: …` | The Sync guard is set to refuse when it fails to read Obsidian Sync's state, and it could not. Nothing was written. | Ask the operator: an Obsidian update may have changed Sync's internals. |
| `Error [precondition_unsupported]: …` | `if_rev` was sent to a server with no kernel (tests, bare embeds), which cannot check it. | Nothing to retry there; the live plugin checks it. |

The refusal comes before the write queue, so a refused call is not in the journal, unless the `refusalLog` setting (off by default; `VAULT_MCP_REFUSAL_LOG` on the file-system server) is on: then each refused write call is one journal line with `outcome: refused` and its error code, and no argument value ([settings](docs/settings.md#refusal-log)). Exceptions: the two whole-note forms of `truncated_read` (a whole-note overwrite of a long note, and a `replace` past the limit on one) are decided at the front of the queue, where the proof of a whole read is read against the note as the write meets it, so they are in the journal as errors, and an `idempotency_key` on such a call answers with the refusal: send the corrected call with a NEW key. And an `obsidian_write_notes` item is checked when it reaches the front of the queue. An item with no `if_rev` for a note that already exists is refused there with `Error [protection_required]: '<path>' already exists, …`, and that refusal is in the journal. If the item carried an `idempotency_key`, the key now answers with the refusal, so send the overwrite with its `if_rev` and a NEW key. And `unsafe_name` is decided at the write, where the note is created or renamed, so it is in the journal as an error, and an `idempotency_key` on that call answers with the refusal: send the call with the corrected name and a NEW key (the batch `obsidian_move_notes` form too: it is checked when the call reaches the front of the queue).

**Per-tool table.** This table is rendered from `packages/host/src/kernel/operations/inventory-mcp.ts` by `protectionTableMarkdown()` in `packages/host/src/kernel/write-protection.ts`. `packages/host/tests/write-protection.test.mjs` fails when this copy differs from the inventory; run it with `VAULT_MCP_WRITE_README=1` to rewrite the copy. Read-only tools need nothing and are not listed.

<!-- protection-table:start -->
| Tool | Requires | Note |
| --- | --- | --- |
| `obsidian_append_at_heading` | `idempotency_key` |  |
| `obsidian_append_note` | `idempotency_key` |  |
| `obsidian_assign_address` | `idempotency_key` |  |
| `obsidian_base_create` | `idempotency_key` |  |
| `obsidian_call_tool` | what the tool it calls requires |  |
| `obsidian_claim_scope` | nothing (not a vault write) |  |
| `obsidian_cli` | `idempotency_key` |  |
| `obsidian_create_note` | `idempotency_key` |  |
| `obsidian_create_note_from_template` | `idempotency_key` |  |
| `obsidian_delete_note` | `if_rev` and `idempotency_key` |  |
| `obsidian_edit_file` | `if_rev` |  |
| `obsidian_fileclass_insert_fields` | `if_rev` |  |
| `obsidian_import_apple_notes` | `idempotency_key` |  |
| `obsidian_jump_to` | nothing (not a vault write) |  |
| `obsidian_manage_frontmatter` | op set, delete: `if_rev`; any other op, or none: nothing |  |
| `obsidian_move_file` | `idempotency_key` |  |
| `obsidian_move_note` | `idempotency_key` |  |
| `obsidian_move_notes` | `idempotency_key` |  |
| `obsidian_open_bookmark` | nothing (not a vault write) |  |
| `obsidian_open_in_editor` | nothing (not a vault write) |  |
| `obsidian_open_workspace` | nothing (not a vault write) |  |
| `obsidian_patch_note` | op replace: `if_rev`; op append, prepend: `idempotency_key`; any other op, or none: `if_rev` |  |
| `obsidian_periodic_note` | nothing |  |
| `obsidian_plugin_install` | nothing (not a vault write) |  |
| `obsidian_plugin_reload` | nothing (not a vault write) |  |
| `obsidian_plugin_toggle` | nothing (not a vault write) |  |
| `obsidian_plugin_uninstall` | nothing (not a vault write) |  |
| `obsidian_refile_address` | `idempotency_key` |  |
| `obsidian_release_scope` | nothing (not a vault write) |  |
| `obsidian_rename_heading` | `if_rev` |  |
| `obsidian_renew_scope` | nothing (not a vault write) |  |
| `obsidian_renumber_address` | `idempotency_key` |  |
| `obsidian_replace_text` | `if_rev` and `idempotency_key` |  |
| `obsidian_repoint_link` | nothing | Temporarily exempt (Nelson's "a", 2026-09-29): ruled token, but its only named path is target_path, the note links point AT, so an if_rev would check the wrong file; back to token with #427. |
| `obsidian_run_command` | `idempotency_key` |  |
| `obsidian_save_workspace` | nothing (not a vault write) |  |
| `obsidian_snippet_toggle` | nothing (not a vault write) |  |
| `obsidian_snippet_write` | nothing | Temporarily exempt (Nelson's "a", 2026-09-29): ruled token when it overwrites, but it names no path and .obsidian/snippets has no revision the kernel can read; back to token with #427. |
| `obsidian_survey_slot` | `if_rev` |  |
| `obsidian_toggle_view_mode` | nothing (not a vault write) |  |
| `obsidian_trash` | `if_rev` and `idempotency_key` |  |
| `obsidian_write_file` | overwrite true: `if_rev`; any other overwrite, or none: nothing |  |
| `obsidian_write_note` | overwrite true: `if_rev`; any other overwrite, or none: nothing |  |
| `obsidian_write_notes` | per item: `if_rev` to overwrite an existing note; nothing to create one |  |
| `vaultmcp_send_message` | nothing (not a vault write) |  |
| satellite tools (`vaultmcp_*`) | what the tool declares (`protection`, satellite apiVersion 3); a tool that declares nothing (apiVersion 2): not enforced | Enforced like a host tool's row once declared (#550); the gap that remains is a satellite still on apiVersion 2. |
<!-- protection-table:end -->

**Two temporary exemptions.** `obsidian_repoint_link` and `obsidian_snippet_write` are ruled `if_rev` tools, but the host cannot check an `if_rev` for them honestly yet: it checks the revision of the first path a call names, and these name no path, or only the note links point at. Nelson ruled on 2026-09-29 that they are exempt until [#427](https://github.com/nelsonlove/vault-mcp/issues/427) gives the host a revision it can check, a snippet revision and one per note found in a scan. Then they go back to requiring `if_rev`. The ruling named a third tool, `obsidian_conformance_debt_render`; it left the host with the conformance rail on 2026-10-14 and is now `vaultmcp_conformance_debt_render`, a satellite tool (see the satellite gap below).

**Satellite tools declare their own (apiVersion 3, [#550](https://github.com/nelsonlove/vault-mcp/issues/550)).** A tool published by a satellite plugin (`vaultmcp_*`) has no row in the host's table, so from host apiVersion 3 its spec declares `protection` (the same classes as the table, argument-dependent too), its place in the Sync guard (`sync`: its kind, and whether it is on the strict list or the destination-unnamed list) and its path arguments (`paths`), and the host enforces them exactly as for its own tools. A malformed declaration is refused at registration. A satellite tool that declares nothing (an apiVersion-2 spec) is still not checked; that is the gap that remains. The fields are documented in `packages/vault-mcp-api/README.md`, "Write declarations".

**The file-system fallback.** The server in `packages/server` can serve the vault from disk when Obsidian is closed. It has no kernel, so it checks neither argument: with writes turned on (`VAULT_MCP_FS_ALLOW_WRITES`), an overwrite needs no `if_rev`. Its own deliberate differences are listed in `packages/server/src/fs-write-kernel.ts`.

## Installing today (pre-Community-directory)

Updating a live install while agents are writing has its own rules (a versioned build directory, no hot-reload marker, a quiet check, one reload): see [Updating a live install](docs/operator-guide.md#updating-a-live-install).

Neither plugin is yet in Obsidian's Community Plugins directory (the submission is target state — see [Status and compatibility](docs/status-and-compatibility.md)). Governor ships as two plugins: install the host, and optionally install the governance provider on top of it.

1. **Build** (or grab a [release](https://github.com/nelsonlove/vault-mcp/releases) — BRAT-installable):
   ```bash
   npm install && npm run build      # builds both packages/host and packages/governor
   ```
2. **Install the host** — copy its build output into your vault and enable it:
   ```bash
   cp packages/host/main.js packages/host/manifest.json <vault>/.obsidian/plugins/vault-mcp/
   ```
   Then Settings → Community plugins → enable **Vault MCP**. On its own, this gives a compatible local AI client audited, journaled, allowlist-scoped access to the vault — ungoverned.
3. **Optionally install the governance provider** for accept/mandate/cohort governance on top of the host:
   ```bash
   cp packages/governor/main.js packages/governor/manifest.json <vault>/.obsidian/plugins/governor/
   ```
   Then Settings → Community plugins → enable **Governor**.
4. **Connect Claude Code** — run **`Vault MCP: Connect to Claude Code`** from the command palette (one-time; the exact registration line is always in **Settings → Vault MCP** if you'd rather paste it yourself). The Claude Code MCP server name is `vault-mcp` and its tool prefixes are `mcp__vault-mcp__*` (the hyphen survives into the prefix). It was `governor` between 0.12.0 and the host/provider split; a registration from that era keeps working — the bridge finds the socket through discovery, not through the registration name — but the tools stay under the old prefix until you re-register. See [the migration plan](docs/s3c-migration-plan.md) for the two-step rename, including the `mcp__governor__*` permission entries that need re-adding under the new prefix.
5. **Restart any open Claude Code session** — MCP servers load at session start.

Migrating an existing single-`governor`-plugin install (0.17.0–0.18.2) onto the 0.19.0 split, or upgrading from ≤0.11 (plugin id `vault-mcp`, before the earlier rename to `governor`): see [the migration plan](docs/s3c-migration-plan.md) and [Status and compatibility](docs/status-and-compatibility.md) for exact release state — the split is built and not yet cut over.

## Start in ten minutes

1. Install the host, and optionally the governance provider, and enable them (see **Installing today**, above — the Community Plugins directory listing is target state).
2. Open **Settings → Governor**.
3. Keep the initial posture at **Looking only**.
4. Use **Connect a local assistant** and follow the client-specific instructions.
5. Choose the folders this connection may access. Start with one low-consequence folder.
6. Ask the assistant to find or explain something and have it open the source note in Obsidian.
7. When you are comfortable, preview a small append or new note.
8. Enable proposing governed changes, apply it, re-open the note, and read the receipt.
9. Accept the proposal in Obsidian. Introduce mandates only after you understand individual proposals and recovery.

You can stop after step 6 and keep a useful read-only system indefinitely.

The detailed walkthrough is in [Getting started](docs/getting-started.md).

## Five ways to use Governor

### Find and orient

Search notes, properties, links, views, and history; recover context after time away; open the exact note or heading used in an answer. This is read-only by default.

### Capture and add

Create a note in an allowed folder or append information to an existing note. Governor shows the destination, verifies the landed content, and returns a receipt.

### Improve and organize

Preview edits, moves, metadata cleanup, and link-aware maintenance. Structural changes show their scope and recovery route before they run.

### Review and decide

Use one review center for individual proposals, sessions, collection cohorts, mandates, verification, and history. Drafts, requested revisions, admitted material, and operational activity remain distinct.

### Check and maintain

Inspect broken links, inconsistent properties, stale derived material, unavailable dependencies, and other actionable health findings without silently “fixing” ambiguous cases.

See the [User guide](docs/user-guide.md) and [Capability directory](docs/capabilities.md).

## What Governor can and cannot protect

Governor adds application-level safeguards: a read boundary, write postures, previews, serialized mutations, revision checks, retry protection, protected properties, a journal, a review center, and recoverable operations.

It is **not an operating-system sandbox**. Community Plugins inherit Obsidian's local privileges, and a malicious local program or another fully privileged plugin may bypass Governor. Use a test vault for development, keep verified backups, review dependencies, and enable only the authority you need.

Governor is desktop-only because its local bridge and some operational storage use desktop APIs. The public configuration is local-first and contains no client-side telemetry. Read [Security](SECURITY.md), [Privacy](PRIVACY.md), [Threat model](docs/threat-model.md), and [Data flow](docs/data-flow.md) before connecting a sensitive vault.

Governor's local Git store is outside Obsidian Sync and retains historical note and attachment bytes from the governed scope, including content later changed or deleted. Configure its scope and retention as you would a sensitive backup.

Replayable observations are also sensitive: they may retain the exact note content or metadata Governor returned during an earlier session. They stay in protected replica-local storage by default, have a separate retention policy, and are not portable-standing Sync data.

## Documentation

- [Documentation map](docs/README.md)
- [Getting started](docs/getting-started.md)
- [User guide](docs/user-guide.md)
- [Vocabulary](docs/vocabulary.md)
- [Action registry](docs/action-registry.md)
- [Observations and replay](docs/observations-and-replay.md)
- [Review and safety](docs/review-and-safety.md)
- [Change classes](docs/change-classes.md)
- [Sessions, mandates, and cohorts](docs/sessions-mandates-and-cohorts.md)
- [Standing and attestations](docs/standing-and-attestations.md)
- [Git, Sync, and portability](docs/git-and-sync.md)
- [Module directory](docs/modules.md)
- [Capability directory](docs/capabilities.md)
- [Settings](docs/settings.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](SECURITY.md) and [Privacy](PRIVACY.md)
- [Agent guide](docs/agent-guide.md)
- [Architecture](docs/architecture.md) and [Developer guide](docs/developer-guide.md)
- [Operator guide](docs/operator-guide.md)
- [Community Plugin submission packet](submission/community-plugin-submission.md)

## Honest limits

- Governor cannot determine whether a judgment-bearing edit is substantively correct; it can make the edit legible and keep acceptance human.
- A scope limits what Governor exposes through its own surface. It does not reduce Obsidian's or another plugin's operating-system permissions.
- An uncertain timeout may have changed the vault. Re-read before retrying.
- Playback covers what crossed Governor's own boundary, not the model's reasoning, complete client context, or information obtained elsewhere.
- Optional integrations can disappear or become incompatible. Governor reports that state explicitly rather than returning a false empty result.
- Review capacity is finite. Governor supports cohorts, full-coverage verification, bounded mandates, budgets, and supersession, but the user still owns the governing judgment.
- Obsidian Sync moves files individually, not as a Governor transaction. A receiving device does not admit a synced cohort until every exact subject and required attestation is present.
- A Community directory listing is distribution and review infrastructure, not a security certification.

## Support, security, and contribution

- For ordinary issues, follow [Support](SUPPORT.md).
- For vulnerabilities, follow [Security](SECURITY.md) and do not disclose sensitive details in a public issue.
- For development and documentation contributions, follow [Contributing](CONTRIBUTING.md).
- An actual submission repository must include its license in a root-level `LICENSE` file, as required by Obsidian's Community Plugin policies.

Your notes remain Markdown files in your vault. Governor uses standard Git objects for local history and portable signed attestations for evidence and standing. Obsidian Sync can continue moving the visible vault normally; Governor's Git database stays outside Sync. Uninstalling the plugin does not convert your notes into a proprietary format. That is the exit guarantee.
