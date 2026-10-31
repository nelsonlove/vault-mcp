# Kernel v0 — the write substrate

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


The kernel is the plugin-singleton machinery every mutating tool call routes through. It
turns "an agent editing files" into a **serialized, journaled, concurrency-safe, attributable**
stream of operations. It lives in `packages/host/src/kernel/` and is Obsidian-free by
construction (pure TypeScript, headlessly testable); the MCP layer wires it to the live vault.

The user-facing prose for these primitives is in the top-level
[reference](reference.md#write-queue--journal); this doc is the reference, with the exact
constants and file locations.

## The serialized write queue

Every **mutating** call (write, append, patch, move, delete, trash, frontmatter edit,
repoint, CLI, and mutating external tools) runs through a **single FIFO queue per plugin
instance** — one vault mutation at a time, across every connected session and background
agent. Reads never queue, so a slow write never stalls a session's reads.

- **Per-operation budget: `WRITE_TIMEOUT_MS = 30_000`** (30 seconds — a constant, not a
  setting; `packages/host/src/kernel/write-queue.ts`). If an operation hasn't settled by
  then it is **abandoned**, that one call fails with `Error [write_timeout]`, and the queue
  immediately moves on — a wedged operation can never take down the bridge or anyone else's
  session. The vault may or may not have been modified; re-read before retrying. The deadline
  is **wall-clock math re-evaluated on queue activity** (a new enqueue, a journal append,
  an explicit nudge), not just a timer — Chromium suspends renderer timers while the Obsidian
  window is occluded, so a timer-only deadline went unfired in exactly the unattended
  conditions agents operate in (#272). A per-operation timer still arms as the best-effort
  prompt path in the foreground.
- **Late settlement.** Because an abandoned operation may still finish afterwards, the queue
  reports its eventual outcome via an `onLate` hook, which the kernel turns into a
  **corrective journal record** (see below) rather than dropping the settlement silently.

## The append-only write journal

Every mutating operation appends **one JSONL line** to
`.obsidian/plugins/vault-mcp/journal/YYYY-MM.jsonl` (rolled monthly, inside the host's own
plugin folder, not the note tree). It records the **operation** — what happened, to what, on whose
behalf — never the note bytes (git already covers bytes; arguments are reduced to a digest
with bodies/long strings collapsed to `<N chars>`).

A record's shape (`packages/host/src/kernel/journal.ts`):

```json
{"ts":"2026-08-08T19:04:11.427Z","op":"obsidian_write_note",
 "target":{"path":"Inbox/Idea.md","uid":"019f…"},
 "actor":{"transport":"mcp","client":"claude-code/1.0.0","connection":"m1x8g-3",
          "server":{"vault":"obsidian","install":"3f7c…","version":"0.8.0"}},   // illustrative sample from an older release; the shape is current
 "argsDigest":{"path":"Inbox/Idea.md","content":"<812 chars>","overwrite":true},
 "outcome":"ok","durationMs":37,"queueWaitMs":0,
 "revBefore":1754680000000,"revAfter":1754680051427,
 "intent":"tidy the inbox"}
```

Key fields:

- **`op`** — the tool name. **`target`** — what was *asked for*: `path` + `uid` (the identity
  it landed on, taken from the uid index so it's present even when the frontmatter cache lags),
  or `target.ref` for operations that name no vault path (`command:editor:toggle-bold`,
  `scope:<prefix>`, `lock:<id>`, an `obsidian_cli` invocation), or `target.paths` for a batch
  move.
- **`actor`** — the transport's own assertion of identity: `transport`, `client`,
  `connection`, and `actor.server` = which **vault**, which **install**, which plugin
  **version** — so a journal copied off the machine, or two vaults' journals read together,
  stays attributable.
- **`durationMs`** (the handler alone) vs **`queueWaitMs`** (time spent waiting behind other
  writes) — a slow operation and a queued one are distinguishable. **`revBefore`** is probed
  when the operation reaches the front of the queue, not when it was enqueued.
- **`effects`** — where an operation discovers its own blast radius (`obsidian_repoint_link`
  scanning notes to find the links it rewrites, `obsidian_rename_heading` finding the links to a heading), `{"filesChanged": 12, "paths": [...]}` (paths
  capped at 20). A dry run records none.
- **`intent`** — the caller's advisory change-intent text, when supplied (see
  [B2 in agent-writes.md](agent-writes.md#b2--agent-change-intent)).

**Append-only.** Nothing in the plugin edits or deletes a record; pruning is a manual act on
whole month files. When an abandoned (timed-out) operation later settles, the original line
stands and a **corrective record** is appended — same op/target, `"outcome":"late-ok"` or
`"late-error"`, with `"corrects"` naming the `ts` of the record it amends. A failed journal
write is logged to console and dropped; it never fails the vault operation.

Non-`ok`/`error` outcomes: **`"conflict"`** (a failed `if_rev` precondition — nothing written;
`revBefore` is what was actually found, `ifRev` what the caller expected) and **`"deduped"`**
(an idempotency replay, with `dedupeOf` naming the `ts` of the record whose result was
returned).

**`"refused"`** is written only while the `refusalLog` setting is on (#618; see
[settings](settings.md#refusal-log)), for a write call refused before the queue: `refusal`,
`codeFamily`, `ts`, `op`, `target` (paths capped at 120 characters), `actor`, and no `argsDigest`,
`error`, `intent` or key; at most 20 a minute per session and code (per connection and code
on the filesystem server), then one `suppressed: <count>`
line. A call refused at dequeue keeps its own record (`error`, `conflict`) as it is, and gains only
`refusal` and `codeFamily` when its code means "refused, nothing written". Off, the journal is unchanged.

## `if_rev` — optimistic concurrency

`obsidian_read_note` / `obsidian_read_notes` return the note's current **`rev`** (its mtime in
ms — the same token the journal records). Pass that value back as **`if_rev`** on the next
write, and the write applies **only if the note is still at that revision**; otherwise nothing
is written and the call fails with `Error [rev_conflict]: … expected rev X, but found rev Y`.

The check happens **when the operation reaches the front of the queue**, not when it was
submitted — so a write queued behind someone else's write is compared against the world *that*
write left behind. That is what makes concurrent sessions **lose-update-proof** rather than
merely serialized. A target with no readable revision (deleted, never existed) is a conflict,
not a pass. On a multi-target operation, `if_rev` applies to the **first** target.

`if_rev` is a **kernel argument** — declared automatically on every mutating schema (see
[kernel arguments](#kernel-arguments)), so it works on the full surface, in Code Mode, and on
mutating tools published by other plugins; no handler ever sees it.

## Record immutability — record notes are append-only

A note the operator's **record identifier** marks (by default frontmatter **`record: true`**; see below) is a record: historical, extended only by a
dated end-of-file append, never edited in place (issue #264 — the durable, every-client layer
behind the client-side record-write hooks). The kernel refuses any mutating operation that
names one with **`Error [record_immutable]`**, naming the path and pointing at the dated-append
convention. Nothing runs; the refusal is journaled (`outcome: "error"`).

- **The one exemption is `obsidian_append_note`**, by **tool identity**
  (`RECORD_EXEMPT_OPS`, `packages/host/src/kernel/record-guard.ts`) — the only tool whose
  whole contract is a pure end-of-file append. Argument shapes never exempt anything;
  `obsidian_append_at_heading` inserts mid-file and is refused like any other mutation.
- **Every named path counts**, not just the primary: a move **onto** a record note would
  overwrite it, so either half of a move (or any member of a batch) being a record refuses the
  whole operation.
- **Checked at dequeue**, in the same closure that samples `revBefore` and consults advisory
  locks — against the vault as it is when the operation actually runs, not as it was at enqueue.
- **Fails open**, the deliberate mirror of `if_rev`'s fail-closed: the flag is read from
  Obsidian's already-parsed metadata cache (`TargetProbe.record`, cache lookup only), and a
  missing file, an unparsed cache, a throwing probe, or a build with no probe at all refuses
  nothing. The check is protective, not load-bearing — a broken cache must not become a
  vault-wide write outage. (`if_rev` fails closed because the caller explicitly asked for a
  precondition; nobody asked this check to block a note it cannot read.)
- **How a note declares itself a record is the operator's convention, not the plugin's** (#397, ruled 2026-09-22): the `recordIdentification` setting (*Record identifier* in the settings tab) picks either a frontmatter **property** holding a **value** or a **tag**, mirroring TaskNotes' `taskIdentificationMethod` / `taskTag`. The default is the old rule, property `record` with value `true` (boolean; the quoted string `"true"` is honored too — `isRecordFlag`). Under the tag method, frontmatter and inline tags both count, with or without `#`. The decision is `identifiesRecord` in `record-guard.ts`, pure and unit-tested; `obsidian-probe.ts` only gathers the note's frontmatter and tags. `false`, absence, or anything else is not a record.

Enforcement is on by default; the `enforceRecordImmutability` setting turns it off at the probe (the flag reads as unknown, which is the same fail-open path a cold cache takes).

Threat model matches the accept guard: fallible agents, not adversaries. Two boundaries are
deliberate, and both are the flip side of "the check covers the paths an operation **names**":

- **Writes that bypass the MCP server entirely** — a shell redirect, another process touching
  disk directly (the class behind the incident that motivated #264) — are out of this layer's
  reach and stay with the client-side hooks and backups.
- **Operations that *discover* their blast radius instead of naming it** can still rewrite a
  record note's body as a side effect, refusal-free: `obsidian_repoint_link` rewrites the body
  of whatever notes carry the matching wikilink (`obsidian_rename_heading` does not: it skips
  record notes and reports them), a move's link-healing rename rewrites
  backlinks wherever they live (records included, and `update_backlinks: false` is advisory —
  see [identity-and-links.md](identity-and-links.md)), and `obsidian_cli` eval / external
  tools reach the vault through their own code. Byte-exactness of a record against that class
  is what the record's git history and backups are for; this refusal is the guard against
  *addressed* mutation, not a checksum.

## `idempotency_key` — safe retries

A repeat call carrying an **`idempotency_key`** this plugin has already **completed** returns
the first call's **exact result** without running the handler or taking a queue slot; a repeat
sent while the first is **still in flight** waits for it and shares the same outcome. Four
simultaneous retries of one dropped request run the operation once and all four get one answer.

- **Window: `IDEMPOTENCY_TTL_MS = 10 minutes`, capped at `IDEMPOTENCY_MAX = 500` keys**
  (least-recently-used evicted first; `packages/host/src/kernel/idempotency.ts`).
- **Identity is `(key, operation, arguments, if_rev)`.** Reusing a key for a different tool,
  the same tool with different arguments, or the same call under a *different* `if_rev`
  (including dropping or adding one) fails with `Error [idempotency_mismatch]` and runs
  nothing — rather than replaying and silently discarding the second call's write. The error
  names which half diverged.
- **What it does *not* cover:** a call that failed with `Error [write_timeout]` was *abandoned*
  server-side and **may still have landed** — its key is deliberately **not held**, so a retry
  re-executes (and the journal appends a `late-ok`/`late-error` if the original settled).
  Replay covers whatever the first call *returned*; a failure envelope replays as that failure,
  so use a **fresh key** to genuinely retry a failed operation.
- **Keys live in memory, per plugin instance.** A plugin reload (or Obsidian restart) clears
  them, after which the same key executes again. That is the v0 boundary: it collapses retries
  within a session's lifetime; it does not make an operation exactly-once forever.

## Advisory scope locks + TTL

`obsidian_claim_scope` / `obsidian_renew_scope` / `obsidian_release_scope` /
`obsidian_list_scope_claims` (`packages/host/src/kernel/locks.ts`,
`packages/host/src/mcp/tools-locks.ts`) let two agents working the same folder tell each
other so. A claim takes a **scope** (a vault path prefix), a **reason**, and an optional
`ttl_ms`, and returns a claim id.

**Advisory and nothing else** — a claim blocks no one and queues nothing:

- **Overlapping claims by different holders are allowed**, and the claim response *lists* the
  ones it overlaps (holder + reason).
- **A write inside someone else's live claim still happens** — it just gains a *notice*: an
  extra content block on the result, an `advisory_locks` entry in the structured result, and a
  `lockNotice` on the journal record. Your own writes inside your own claim get nothing.
- **Every path an operation names is consulted** (both halves of a move; every path of a
  batch).
- **TTL: default `LOCK_TTL_DEFAULT_MS = 5 minutes`, max `30 minutes`, min `1 second`.** Claims
  **expire on their own** (lazily — an expired claim is simply gone next time anyone looks), so
  a crashed holder cannot wedge a scope. `renew` restarts the clock; **claiming a scope you
  already hold replaces that claim** (same id, restated reason, restarted clock).
- **Caps: `LOCK_MAX_PER_HOLDER = 50` per connection, `LOCK_MAX = 200` per vault.** Past a cap a
  claim is **refused** (`Error [lock_cap]` / `Error [lock_store_cap]`) — never traded for
  someone else's. What bounds a client running many connections is *time*, not identity: every
  claim expires within 30 minutes, so the store drains on its own.
- **Bounded by the path allowlist.** A session sandboxed to `Projects/` can claim inside it and
  nowhere else (`Error [out_of_allowlist]` otherwise). Listing follows the same rule: claims
  whose scope falls outside the allowlist are omitted and counted in `hidden_claims` — you
  learn that territory outside your view is claimed, not where. No allowlist ⇒ every claim,
  no `hidden_claims` key.

Claiming and releasing are treated as **mutating** (journaled with `target.ref = scope:<prefix>`
/ `lock:<id>`), so **read-only mode blocks claiming and releasing** — there is nothing for a
claim to disclose in a session that cannot write. Listing still works. Claims are held per
**connection** and live in memory (a plugin reload clears them).

## Server / install identity

Every journal record's `actor.server` carries a persistent **install id** — minted once and
kept beside the journal in `.obsidian/plugins/vault-mcp/install-id.json`
(`packages/host/src/kernel/install-id.ts`) — plus the **vault name** and host plugin
**version**. This is what keeps a journal attributable after it's copied off the machine, and keeps two
vaults' journals distinguishable when read together. The `initialize` handshake carries the
vault name too, in `serverInfo.title`.

## Kernel arguments

`if_rev`, `idempotency_key`, and `intent` are **kernel arguments**, not tool arguments: no
handler knows about them. They are declared generically on **every mutating registration**
(`withKernelArgs` in `packages/host/src/mcp/guarded.ts`) and consumed generically (stripped
from args and passed to `Kernel.runMutation`). Read-only tools are left untouched — neither
argument means anything without a write.

```
KERNEL_ARG_KEYS = ["if_rev", "idempotency_key", "intent"]
```

The declaration is load-bearing, not decoration: the MCP SDK validates a call's arguments
against the tool's zod shape and `z.object` **strips unknown keys**, so an undeclared kernel
argument would be discarded before the wrapper ever saw it. Declaring once covers both the full
surface and Code Mode's `obsidian_call_tool` (which parses against the same captured shape). A
mutating tool — built-in or external — must therefore not name an argument after one of these
reserved keys; the peel strips them at runtime regardless of the tool's own schema.
