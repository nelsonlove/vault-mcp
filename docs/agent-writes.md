# The agent write & review surface (B1 / B2 / B3)

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


Three slices that make an agent's writes **legible to a human reviewer** without giving the
agent any accept authority: a batch writer that can stamp identity conventions (B1), an
advisory "why" that rides the journal (B2), and a read-only view of what's under review (B3).

## B1 — `obsidian_write_notes`

A batch writer: write several notes in one call, each as `{path, frontmatter?, body}`.
(`packages/host/src/mcp/tools-write-notes.ts`, pure logic in
`packages/host/src/mcp/write-notes-compose.ts`.)

The whole point of the slice is that **each item is an independent write** routed through the
**same serialized queue + journal + `if_rev`/idempotency machinery** as a single write — so
**each note gets its own journal record** and the Acceptance review pane sees it individually. (Contrast
`obsidian_move_notes`, which is *one* operation over many paths: one record, `target.paths`.)

- Items are processed **sequentially**; a failed item (out-of-allowlist, `if_rev` conflict,
  accept-forbidden) is reported in `errors` and **does not abort the batch**. Max **50** items.
- Each item may carry its own **`if_rev`** and **`idempotency_key`**.
- Existing notes are **replaced** (this writes whole notes, like `obsidian_write_note`).

### How it stays inside the kernel without deadlocking

The guard monkeypatch (`server.ts`) already wraps every *mutating* registration in one
`runMutation`, and the write queue is non-reentrant (a queued closure that enqueues again would
deadlock behind itself). So `obsidian_write_notes` follows the `obsidian_call_tool` precedent:
it **registers unguarded** (via the pre-monkeypatch registrar, so it takes no outer queue slot)
and drives a **per-item guarded single-writer** itself. That single-writer is a real
`makeGuarded` wrapper, so `uid:` addressing, read-only mode, the allowlist, `if_rev`,
idempotency, the queue, and the journal all bind **per item** exactly as on the full surface —
nothing is reimplemented, and its `readOnlyHint: false` is honest (it mutates; it bypasses the
monkeypatch, not the truth).

### Opt-in server-side stamping (`stamp: true`)

With `stamp: true`, the **server becomes the single owner of frontmatter conventions**, so
every agent stops reimplementing them:

- **`uid`** — a created-seeded **UUIDv7**, minted **only when absent**. An existing on-disk uid
  always wins and is **never overwritten** (order: existing → payload → freshly minted). The
  48-bit timestamp field is seeded from the note's `created` (not wall-clock now), so a uid
  minted for an old note sorts by when the note was authored (RFC 9562; the mint is injectable
  for deterministic tests).
- **`created`** — payload's, else the existing value, else defaulted to now.
- **`modified`** — always now.
- **Canonical field order** — `name`/`title`, `uid`, `created`, `modified`, then everything
  else in its existing order, with **`acceptance-status` pinned last**.
- **`acceptance-status`** — not added by stamp (#519: the key is retired in this vault; a note is confirmed by a `verified` entry). An existing on-disk value is carried forward when the payload is silent.

**Stamping never writes acceptance.** It adds no `acceptance-status` at all, never mints or
elevates to `accepted`, and preserves an existing on-disk `acceptance-status` **verbatim**
(including a human-granted `accepted` — changing it would destroy the human's decision). Any
item whose frontmatter introduces `accepted`/`accepted-by`/`accepted-on`, or introduces, changes, blanks or removes a filled live `verified` field (#406; removing a blank one is allowed), is **rejected**
(`Error [accept_forbidden]`) whether or not `stamp` is set — see
[acceptance-model.md](acceptance-model.md).

`stamp` is **opt-in per call**; nothing turns it on automatically. Leave it **off** for
templates/blueprints, where a `uid` on a merge-payload would corrupt every instance's uid.

### Result shape

```jsonc
{ "count": 3, "error_count": 1, "stamped": true,
  "written": [{"path":"Inbox/A.md","created":true,"stamped":true,"rev":175468…}, …],
  "errors":  [{"path":"Secret/x.md","code":"out_of_allowlist","error":"…"}] }
```

Partial failure is tolerated; total failure (every item failed) carries the MCP error flag
while keeping the structured per-item report.

## B2 — agent change-intent

An optional **`intent`** kernel argument: free text answering *"why is this change being
made?"* — the PR-description of a proposed change. It is the third
[kernel argument](kernel-v0.md#kernel-arguments) (`KERNEL_ARG_KEYS = ["if_rev",
"idempotency_key", "intent"]`), declared on **every mutating registration** via
`withKernelArgs` and **peeled by the guarded wrapper before any handler runs**
(`packages/host/src/mcp/guarded.ts`).

Its properties are deliberately narrow:

- **Journal-only.** It is recorded verbatim on the journal record beside `op`/`actor`
  (`JournalRecord.intent`, `packages/host/src/kernel/journal.ts`) and **never reaches note
  content** — it is peeled before the handler, so it structurally cannot be written into a
  note's frontmatter or body.
- **Advisory and untrusted.** Review surfaces display it per pending row as "agent says"; it is
  agent-authored free text (≤ **2000** chars) and is never trusted (a review pane consuming it
  must escape it).
- **Never an accept or idempotency signal.** It is **excluded from idempotency identity** — a
  retried call may reword its intent freely and still dedupe — and it is **never read back** as
  any kind of acceptance or approval signal. `intent` is recorded, unlike `if_rev`, because it
  asserts nothing about a precondition; it just annotates the operation.
- **Batch-aware.** `obsidian_write_notes` accepts a batch-level `intent` describing the
  change-*set*; the guarded single-writer peels it per item, so **every** item's journal
  record carries it and the Acceptance pane's per-note rows each show it.
- **Degrades quietly** when the kernel is absent (bare embeds, tests).

## B3 — `governance_pending_review`

A **read-only** view of the notes currently pending human review, so a well-behaved agent can
**avoid stepping on a note a human is about to review**
(`packages/governor/src/tools/pending-review.ts`). It is published by the governance provider
through `vault-mcp-api` under its unchanged shipped name, via the host's closed grandfather
table (`GRANDFATHERED_TOOL_NAMES` in `packages/host/src/mcp/external-tools.ts`) — the one
carve-out for a tool name that predates the host/provider split — rather than registered
directly by the host as a plain read tool.

- **It exposes data the governance provider published — nothing more.** The provider
  (`packages/governor/src/wiring/wiring.ts`) rewrites a read-only index at
  `<provider plugin dir>/governance/pending-index.json` — beside the acceptance log — on every
  review-queue refresh (`refresh()`, via the pure serializer in
  `packages/governor/src/kernel/pending-index.ts`); this tool reads it. It is the same data the
  review pane shows — **no new source of truth, and nothing here changes review state**.
  `readOnlyHint: true`, empty input schema, no write and no accept/baseline verb: it reports
  pending-ness; it cannot accept ("the accept verb is in no API"). As an external tool, though,
  that `readOnlyHint: true` claim is distrusted by default — the host treats the tool as
  mutating unless the operator lists `governor` in `trustedReadOnlyPlugins`.
- **Filtering moved from in-tool to the host's gate.** The index is written from the whole
  vault; the provider publishes this tool as an external tool, so it no longer has access to
  the host's guard settings to run the old in-tool `isVisible` check itself — that per-entry
  filtering is gone. Under an active path allowlist, the host's F3 gate refuses the whole call
  instead, because the tool's arguments carry no recognized path key, so a sandboxed session
  gets no entries rather than a filtered list. With no allowlist active, entries are reported
  as before. `count` is the reported length.
- **Degrade is explicit, never silent (#261).** A missing index (provider not installed or
  disabled, or never refreshed — the provider removes the file on unmount) or an unrecognizable
  one reads as **`published: false` with a `reason`** — still never a tool error, but **never a
  bare empty queue** (the #133/#142 silent-zero class). A genuinely clear queue is
  `published: true, count: 0`. Within a well-formed index, entries stay drift-tolerant:
  non-object items and unknown fields are ignored; an entry with no `path` can't be
  allowlist-checked so it is dropped. The path is a fixed constant relative to the provider's
  plugin dir (derived from `app.vault.configDir`, respecting a renamed config dir), so no index
  content can redirect the read.

```jsonc
// governance_pending_review  (no arguments)
→ { "published": true,
    "pending": [{"path":"Projects/alpha.md","status":"pending","agent":"claude-code/1.0.0",
                 "op":"obsidian_write_note","when":"…","writeCount":2}, …],
    "count": 2 }
// governance provider not installed / index never published:
→ { "published": false, "reason": "index-not-published — …", "pending": [], "count": 0 }
```

The descriptive fields (`status`, `agent`, `op`, `when`, `writeCount`) are the governance
provider's own, passed through verbatim when present and well-typed. See
[the review workflow](review-sop.md) (legacy name annotation: the channel was designed under the framework's former name) for how this
closes the loop back to the human.

> **Migration note (#261).** Before the #164 decommission this index was published by the
> legacy standalone Stewardship plugin at `<config-dir>/plugins/stewardship/pending-index.json`.
> That path is dead: nothing publishes it, and this tool no longer reads it. The governance
> provider — which owns the queue — publishes the index at the path above (now under the
> provider's own plugin folder), and the tool's absent-index state became the explicit
> `published: false` rather than a silent `{pending: [], count: 0}`.
