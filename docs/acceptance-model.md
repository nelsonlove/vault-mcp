# The acceptance model

> **This documents the LEGACY acceptance system, which now lives wholly in `packages/governor`.** It was the live authority until the WP8 cutover ran (a human-confirmed act, taken 2026-08-23; see the [cutover runbook](../packages/governor/docs/wp8-cutover-runbook.md)). Post-cutover its writers refuse and the successor model is [standing-and-attestations.md](standing-and-attestations.md). Current state: [status-and-compatibility.md](status-and-compatibility.md).


> **This is the heart of the design.** Everything else in the kernel — the queue, the
> journal, the modules — is machinery. This is the invariant the machinery exists to
> protect.

## Acceptance is a human gesture, and it goes in no API

An agent may *propose* a change to the vault. It may write notes, edit frontmatter, attach
its reasoning, and mark its own work `acceptance-status: proposed`. What it may **never** do
is declare that a change has been **accepted**. Acceptance — the moment a human blesses a
proposed change as canonical — is made by a person, in the
[acceptance module](module-system.md) review pane, and **nowhere else**.

The design scar, stated exactly as it appears throughout the source:

> **"the accept verb goes in no API."**

There is no `obsidian_accept` tool. There is no `accept` argument on any write. There is no
CLI command the proxy will run to set acceptance. And — the part that makes it a
*guarantee* rather than a *convention* — an agent cannot smuggle acceptance in as **data**
either, by writing `acceptance-status: accepted` (or `accepted-by`, `accepted-on`) into a
note's frontmatter. The kernel refuses that write.

Concretely, the three fields that constitute an acceptance assertion:

- `acceptance-status: accepted` (the status field set to an accepted value)
- `accepted-by: <name>` (who accepted)
- `accepted-on: <date>` (when)

A write that **introduces** any of these is rejected with `Error [accept_forbidden]`. Agents
write only `acceptance-status: proposed`; the accepted-family is reserved for the human's
gesture.

## The revision round-trip (dispositions as data)

Revert is not the only way a human says "not this". Since #101 (phase 1 of #221) the
reviewer can send a change back for another pass:

- **Request changes…** (pane, gesture-gated): the reviewer's feedback is inserted into the
  note as a `> [!revision-request] Requested changes (YYYY-MM-DD)` callout directly below
  the H1 (top of body when the note has no H1), and `acceptance-status` becomes `revising`.
  There is no `requested-changes` frontmatter property — the feedback lives in the note
  body, and that is where a revising agent reads it.
- **Withdraw** (pane, gesture-gated, in the Revising section): removes the
  `[!revision-request]` callout(s) the pane inserted and sets the status back to `proposed`.
- **`governance_submit_revision`** (the one agent verb): a revising agent resubmits — status
  back to `proposed`, addressed `[!revision-request]` callout(s) removed, optional summary
  inserted as a `> [!revision-report]` callout for the reviewer to dispose of at review. It
  is an ordinary guarded mutating tool (read-only mode, path allowlist, write queue, write
  journal all apply), it refuses `not_revising` when there is nothing to submit, and the
  shared accept-forbidden guard re-checks its write. `revising` and `proposed` are
  agent-legal status transitions; the accepted-family stays forbidden exactly as above.

The full verb set is declared as **data** (`packages/governor/src/kernel/dispositions.ts`): each
disposition carries `{id, authority, surface, label, effect}`, and the pane renders its
controls from that table. The authority axis (#221) is what sorts them — a verb that confers
standing is a human gesture; a mechanical, reversible write is agent-expressible. Accept
stays non-writing on the body: it advances the baseline and touches no callout, so the
reviewer prunes `[!revision-report]` callouts at review or keeps them as history.

## The acceptance convergence — the pane's Accept is the ONE accept (#221/#164)

The vault used to have **two** acceptance lifecycles: the pane's baseline lifecycle
(pending → Accept → baseline advanced) and the frontmatter lifecycle
(`acceptance-status: proposed` → a human stamps `accepted` by hand or via a QuickAdd macro).
They are now converged: the pane's gesture-gated **Accept is context-aware** and serves both.

| Note's `acceptance-status` | What one Accept click does |
| --- | --- |
| `proposed` | Conformance-gate check, then **stamp** `acceptance-status: accepted`, `accepted-by: <configured identity>`, `accepted-on: <YYYY-MM-DDTHH:mm local>` (minutes precision — date-only was a fixed bug) via Obsidian's own `app.fileManager.processFrontMatter`, then advance the baseline **from the post-stamp content** |
| absent / any other value | Advance the baseline exactly as before — the note is **byte-untouched** |
| `revising` | Never stamped (baseline advance only) — a revising note goes through withdraw / `governance_submit_revision` back to `proposed` first |

**Ordering is the load-bearing part**: the stamp itself changes the note, so `acceptNote`
(`packages/governor/src/kernel/accept.ts`) stamps FIRST, re-reads, **verifies the fold** — status now
`accepted`, body byte-identical to pre-stamp, and the non-stamp frontmatter **key set**
unchanged; a foreign write racing into the accept window that changes the body or adds or
removes a frontmatter key aborts the accept with no baseline advance — and only then
advances the baseline from those post-stamp bytes. The stamp therefore can never re-enter
the pending queue as a fresh unreviewed change, and there is no state where the baseline
advanced but the queue re-shows the stamp.

*Honest limit of the fold verification:* a foreign **value** change to a pre-existing
non-stamp key, landing inside the sub-second read→stamp→re-read window of a human's Accept
click, passes the fold checks and is folded into the accepted snapshot. Verifying value equality would
false-abort legitimate accepts: `processFrontMatter` re-serializes the whole frontmatter,
so post-stamp values legitimately differ in form.
Such a write is journaled (it went through MCP) but no surface flags it; this value-level
sliver is the same inherent race window the pre-convergence accept already had (which read,
wrote and baselined without any re-verification at all — and clobbered a racing frontmatter
write instead of accepting it). A failure between the stamp and the baseline advance leaves the note
stamped with the old baseline; the retry Accept sees `accepted` and takes the advance-only
branch, so a double-stamp is impossible. The accept also clears the genuine-human-input
record for the path (#228's race discipline), so a stale human-input record does not launder
a later unrelated write into a silent baseline advance — the reconciler falls back to its
fail-safe ambiguous classification instead.

**This does not touch the agent-side guarantee.** The stamp is an in-app,
human-gesture-gated `processFrontMatter` call (`stampAcceptedFrontmatter`, module-scope and
unexported in `packages/governor/src/wiring/wiring.ts`, reachable only through the gesture-gated accept
handler) — it **bypasses MCP entirely** and is exactly the human path the accept-forbidden
guard reserves. Every agent transport still refuses the accepted family; `@vault-mcp/core`
is unchanged.

The pane also gains a **Proposed section**: notes with `acceptance-status: proposed` and no
pending write delta (built from the metadata cache like the Revising section, deduped
against the pending queue — a pending proposed note shows Accept in its queue row only —
and respecting the excluded roots). Row actions: the same context-aware Accept, and the
existing Request changes… disposition. The Accept controls surface what will be stamped
(tooltip + notice with the configured identity) — still exactly one click.

Two acceptance-module config fields parameterize the convergence
(`modules.acceptance.config`, rendered in the settings tab like the badge fields —
human-only by construction):

- **`acceptedBy`** (text, default `local-human`) — the identity stamped as `accepted-by`
  and recorded in the acceptance log.
- **`requiredFrontmatterKeys`** (CSV, default **empty = no gate**) — the conformance gate:
  when set, Accept on a `proposed` note **refuses with no partial write** (no stamp AND no
  baseline advance) while any listed key is missing or empty. The legacy QuickAdd
  accept-macro gated acceptance on vault-specific checks (uuid7 `uid`, `title`,
  `description`); that gate maps onto this config — per-vault configuration, never a
  hardwired vault convention in the plugin.

## The accept-forbidden guard

The guarantee is enforced at the **shared write primitive** — the single point every
filesystem-expressible write routes through — so it holds on **every write surface at once**,
not tool by tool. The rule itself is defined once
(`packages/host/src/mcp/write-notes-compose.ts`) and reused everywhere; there is no second
definition of "accepted" to drift.

### Recognition parity: a guard stricter than the write path is a bypass

One definition of *accepted* is not sufficient on its own — the guard and the write path must
also agree on **what counts as frontmatter in the first place**. They once did not, and that
gap was a live bypass (#126): the write-path recognizer tolerated a leading byte-order mark
before the opening `---` (as Obsidian itself does), while the fence scanner did not. An
acceptance fence behind one invisible byte was therefore *scanned clean and honored on
landing* — the guard was stricter than reality, which reads as caution and behaves as a hole.

The rule this leaves behind: **anything deciding "would this content assert acceptance?" must
recognize at least what the vault will honor — and must decide over the same bytes the vault
will honor.** The second clause is not a flourish. A guard that normalizes a *copy* (folding
line endings, expanding escapes, stripping marks) and scans that has stopped looking at the
document that lands; review of the first fix found the identical bug already re-opened on a
different byte, because a lone `\r` is content to the write path and a line break to a folded
scan.

The class recurred a third time, on the **closing** fence, and the shape of that recurrence is
worth keeping. Each earlier fix asked "does the guard see the same *opening* fence the vault
does?" and the answer kept being made correct — while the closer went unexamined because it was
assumed symmetric with the opener. It is not. Probing a live Obsidian shows the opener must be
exactly `---`, whereas the closer is the first later line whose first three bytes are `---`,
with the remainder of that line becoming body. So a note whose closer read `----` carried
frontmatter the vault parsed and honored, and the guard saw no frontmatter at all and refused
nothing. The lesson to carry: **"recognize what the vault honors" is a claim about every
boundary of the construct, not just the one that failed last time** — and the way to settle it
is to ask the vault, not to reason from the half you already fixed.

So the boundary is defined once, in `@vault-mcp/core`
(`accept-guard.ts`: `stripLeadingBom`, `LEADING_FRONTMATTER_RE`,
`leadingFrontmatterBlock`, `stripLeadingFrontmatter`) — in **core** specifically, so both the
Obsidian backend and the filesystem backend can bind to it rather than each re-deriving a
boundary. `frontmatterOf`, `parseGuardFrontmatter` and the accept scanner's leading-fence check
are all callers of that one recognizer, run against the raw honored bytes.

`leadingFrontmatterBlock` and `stripLeadingFrontmatter` are the two halves of that one
recognizer — "what is the frontmatter?" and "what is left after it?" — and they are deliberately
a pair rather than two regexes that happen to agree. A caller that needs the *body* (an outlink
scanner, a conformance snapshot) will otherwise re-derive the shape, and re-derivation is the
thing this section exists to stop: when the halves disagree the note is neither skipped nor read
correctly, it is read with its own frontmatter still inside its body (#150).

**One caller cannot avoid normalizing, and is handled by not trusting a single normalization:**
the CLI content path (`contentAcceptRefusal`) must expand the escapes the CLI itself expands
before the vault sees them, so it necessarily decides over a *reconstruction* of the honored
document rather than the bytes it was handed. A reconstruction is a model of another program's
escape semantics, and a model can be wrong: the original one recognized `\n`/`\r\n`/`\t` but had
no notion of an **escaped backslash** (`\\`), so a crafted payload could make the guard perceive
the frontmatter fence ending in a different place than the honored document has it, hiding an
acceptance assertion inside the real fence (#153, found by #146's review).

Rather than bet the accept boundary on guessing the external binary's exact escape semantics,
the guard **does not pick a reading**. It brackets the plausible readings along two axes and
refuses if **any** of them asserts acceptance inside a `---` fence — a union of readings can only
*add* refusals, so a bracketing reading is pure fail-closed insurance. Axis 1 is the
escaped-backslash treatment, which leaves exactly three coherent readings: R1 (no escaped escape;
the original model, kept verbatim so no prior refusal weakens), R2 (escaped escape, an
unrecognized `\X` kept literal), and R3 (escaped escape, `\X` collapsed to `X`). Axis 2 is the
recognized-escape vocabulary — R1/R2/R3 all freeze it at `{\n, \r\n, \t}`, itself a bet on the
binary, so a fourth reading R4 (a maximal decoder: R3 plus the numeric escapes
`\xHH`/`\uHHHH`/`\u{…}`/octal decoded to their code points) brackets a CLI that honors a richer
set — otherwise `\x2d`→`-` and `\x0a`→a real LF could encode a whole fence invisibly (found by
this fix's independent review). `contentAcceptRefusal` expands under **all four** readings and
refuses if any asserts acceptance in a fence. Its property is *no **bracketed** reading of these
bytes asserts acceptance* — the recognized set is **bracketed, not assumed**. This is the reason
the rule above is "decide over the honored bytes" rather than "never normalize": where
normalization is unavoidable, the normalization itself becomes part of the guard's attack surface,
so every bracketed normalization is decided over.

**This narrows #153; it does not close it.** The reading set is a strict improvement — it brackets
the common escape dialects (escaped-backslash, `\n`/`\r`/`\t`, hex/unicode/octal) that every
standard un-escaper uses — but the shipped `obsidian` binary's *actual* escape vocabulary was
never observed, and review showed the enumeration keeps sprouting sub-axes (e.g. a greedy `\x`
that consumes all trailing hex, or surrogate-pair handling) that can slip a fence past a
finite reading set. So a residual remains: an escape convention outside the bracketed set could
still land acceptance on this path. That residual is **tracked in #153** and its durable fix is
architectural/empirical (this outbound reconstruction is the *sole* guard on the CLI content
path — the official CLI's `create` bypasses the plugin's app-side honored-byte guard), not
one-more-reading. The false-positive surface the bracketing leaves is small and bounded (benign
content that, under some reading, would form a fence asserting acceptance — which agents may not
write anyway); it is pinned by `cli-tools.test.mjs`'s escape-semantics fixtures.

The scanner then adds a deliberately **broader** second pass — embedded fences over a
line-ending-folded copy — because appended content the note will carry cannot be read back
pre-exec. Broader is fine; **narrower is the bypass.** The property is pinned by
`tests/accept-fence-parity.test.mjs`, which asserts *write path would honor ⟹ guard refuses*
across every tolerated fence variation, plus the normalization cases that motivated the second
pass, plus the cost of the conservatism (prose between thematic breaks is refused — a chosen
trade, pinned so it reads as a choice).

### What counts as "accepted" (every value-type, every key spelling)

The detector (`isAcceptedValue` / `isAcceptedKey` in `write-notes-compose.ts`) is deliberately
broad, because an agent trying to slip acceptance through would reach for the shapes a naive
string check misses:

- **A key** is acceptance-provenance if it matches `/^accepted([-_ ].*)?$/` (case-insensitive,
  trimmed): `accepted`, `accepted-by`, `accepted-on`, `accepted_by`, `accepted on`, …
- **The live verification key** (#406, ruled 2026-09-26) is guarded beside that retired family: a key matching `/^verified([-_ ].*)?$/` (`verified`, `verified-by`, `verified_on`, …) may not be introduced, changed or **removed** by an agent write on the transports that see the note's prior frontmatter (a byte-identical carry-forward of a human's record is allowed there, and the stamped `write_note` path carries a filled record forward by name, as it does `acceptance-status`); on the payload-only paths (CLI property and content writes, templates, fileclass field writes, the debt register) presence alone refuses, as for the accepted family, since those paths have no before to prove a carry-forward. A **present-but-empty** value (`[]`, `{}`, `""`, null) is refused outright, carry-forward included, because a key that is present and empty reads as a field somebody may fill in (01.41 The accept perimeter, rule 2a); the one agent move on such a note is to remove the blank key, which is allowed, so a note the Fileclass plugin scaffolded with `verified: []` is repaired, not frozen. A YAML timestamp value is a value, not a blank. Since the vault retired `accepted*`, `verified` is the key that actually confirms a note, so this is the half of the floor that matters day to day; the retired family stays guarded, so a stray old-format note is not re-accepted by accident.
- **A value** *asserts* acceptance if — across **every value-type it can take** — it resolves
  to `accepted` / `accepted-*`:
  - a **scalar string** (`accepted`, `accepted-by-nelson`);
  - an **array** containing one (`[accepted]`) — this was the "S3 hole" a string-only check
    left open;
  - a **map** wrapping one (`{value: accepted}`).
- The **`acceptance-status`** key (and `acceptance_status`) is checked for an *asserting*
  value specifically — `acceptance-status: proposed` is fine, `acceptance-status: accepted`
  is not.

### It checks the note that would land on disk — body-embedded frontmatter included

The guard runs over the **resulting frontmatter of the note that would actually be written**,
parsed from the final markdown with Obsidian's own YAML parser — not over a structured
argument. This closes the "S2" evasion: a caller who embeds a raw
`---\nacceptance-status: accepted\n---` fence in a note **body** (rather than in a structured
frontmatter argument) still has that fence become the note's real frontmatter, so it is
parsed and caught. `frontmatterOf()` matches a leading `---` fence exactly the way Obsidian
recognizes one (`packages/host/src/mcp/obsidian-backend.ts`, `guardWrittenContent`).

### It is a transition, not a snapshot — a human's `accepted` survives

The rule is about **introducing or changing** acceptance, not about the mere presence of an
accepted value. `acceptTransitionReason(before, after)` compares the resulting frontmatter
against the note's current on-disk frontmatter:

- **Introducing** an accepted-family field that was not there before → rejected.
- **Changing** an existing accepted value to a different one → rejected.
- **Preserving** an existing (human-granted) accepted value **verbatim** → **allowed**.

This is essential: a legitimate agent edit to a note a human *already accepted* must be able
to carry that `accepted` value forward unchanged. Destroying the human's decision would
violate the invariant just as much as forging it would. So the on-disk value is read and
equality-checked; an exact carry-forward passes, anything else does not. (Historically the
before-read was skipped whenever the result asserted nothing; with declared protected
properties — next section — absence can be a *removal*, so the shared
`acceptTransitionNeedsBefore` helper decides when the shortcut is still sound.)

## Declared protected properties (#224) — the generalized perimeter

The accepted family is one hardcoded instance of a general rule, and #224 generalizes it: a
**declared list** of frontmatter properties (Security › *Protected frontmatter properties*,
human-only-mutable — no agent path writes plugin config) that every guarded transport
enforces through the **same two predicates** the accepted family already rides
(`acceptTransitionReason` / `acceptForbiddenReason` in `@vault-mcp/core`). No second
definition, no per-transport reimplementation: a transport that enforces the accepted family
enforces the declared list by construction.

Two grades per declared property:

- **`agent-forbidden`** — no agent transport may **introduce, change, or remove** the
  property; byte-identical carry-forward is allowed. (Removal *is* refused for declared
  keys — stripping a human's declaration is as much a mutation as changing it. The accepted
  family keeps its exact historical semantics untouched.) Key matching is canonical —
  case-insensitive with `_`/`-` folded — and compares the full multiset of matching keys, so
  an `auto_accept` written beside an existing `auto-accept` is a change, not a carry-forward.
- **`authority-conferring`** — agent-forbidden **plus honor-only-if-blessed**: the value only
  takes *effect* once the write that set it is attributed to a human (the reconciler's
  isTrusted human-input capture) or accepted in review. The acceptance module's
  `honoredValueFromBlessed` reads the accepted **baseline** — never the raw frontmatter — so
  a value sneaked in through a side door (another plugin, a script, Sync) is **inert** until
  blessed. A side-door change to any declared property also **surfaces in the review queue**
  as a `(side-door)` row (inert, but seen).

**The floor is not config.** The accepted-family checks run unconditionally, before and
independently of the declared list; `normalizeProtectedProperties` drops (loudly) any config
entry naming an accepted-family key or `acceptance-status`. Config can only *extend* the
perimeter — never shrink, downgrade, or restate the floor. `acceptance-status`'s
non-accepted values stay deliberately agent-writable workflow state (`proposed`,
`revising`), exactly as before.

**The first consumer — the per-note auto-accept policy (#135) — RETIRED (WP10c, 2026-08-25).** `auto-accept` remains in the default declared list as authority-conferring, but the policy's operational half is deleted per the development guide's order: `auto-accept: all` no longer parses at all (a whole-note blank check never belonged in frontmatter — it reads as no policy under every authority era, including after a cutover rollback), and `auto-accept: appends` is migrated to content proposals — an appended tail is residual content like any other edit, and lands as an ordinary proposal for the human's decision. The key stays protected (historical notes carry it; agents must not toggle it), and the review pane badges a note's legacy `appends` declaration read-only, with the retirement stated. The #261 composition machinery (mechanical classes plus an appended tail) was deleted with the policy; its wedge cannot recur, because nothing waits on a policy-accept anymore. Rename captures still persist (`governance/rename-records.json`, TTL 30 days, capped) for the link-heal oracle.

**The sweep is event-driven, not timer-only (#261) — and era-scoped (WP10c).** Post-cutover the legacy auto-accept sweep never runs (its writer refuses; running it was pure work and noise); the poll's automated arm is the **mandated-admission sweep** instead, which puts mandate-stamped proposal cohorts through the full admission refusal table — promotion evidence, scope, classes, verifier coverage, budgets — or leaves them for the human. The auto-accept classes were reassessed individually per the guide: none carries automatic authority into the admission era; a class that deserves a future automatic life returns as a registered transformation through its own review, with promotion evidence from zero.

**The legacy sweep's event-driven design (#261), retained for the pre-cutover/rollback era.** Live diagnosis showed Chromium
suspends renderer timers while the Obsidian window is occluded — the 2.5s journal poll
simply never ticked during unattended sessions, which is exactly when agents write (the
observed "zero auto-accept records ever"). The kernel now nudges the governance poll after
**every journal append** (`nudgeGovernanceQueue`, wired in `main.ts`), so queue refresh +
sweep run within seconds of an agent write even with the window buried; the interval
remains as foreground catch-up. The nudge changes only *when* the poll runs — the
journal-growth signature gate, the in-flight guard, and the eligibility decision are
untouched, and it is a no-op while governance is unmounted.

## Every write surface is covered

The guard lives at the shared primitive in `obsidian-backend.ts`, which every
filesystem-expressible write tool routes through. The methods that carry it:

| Write surface | Tool(s) | Guard call |
| --- | --- | --- |
| Whole-note write | `obsidian_write_note` | `guardWrittenContent` over the final content |
| Batch write | `obsidian_write_notes` | per-item `composeNote` guard **and** the same `guardWrittenContent` via the guarded single-writer |
| Append | `obsidian_append_note` | `guardWrittenContent` over `existing + appended` (both the "note exists" and "creating the note" branches — closing the "S5" empty-note case where an appended leading fence becomes real frontmatter) |
| Frontmatter edit | `obsidian_manage_frontmatter` | `guardResultingFrontmatter(before, after)` |
| Structured patch | `obsidian_patch_note` | `guardResultingFrontmatter` over the parsed before/after |

**Move is not a content write.** `obsidian_move_note` / `obsidian_move_notes` rename through
`app.fileManager.renameFile` and never touch note content, so a move cannot introduce
acceptance and carries no content guard — the guarantee holds by construction there rather
than by an added check.

Because the guard is at the *shared primitive*, `obsidian_write_notes`' per-item dispatch
also reaches it (its single-writer calls the same `writeNote`), so the invariant holds on the
batch surface for free rather than being reimplemented (this is the "S1/S4" property: one
primitive, so no write tool — present or future — can register a path around it).

## The `obsidian_cli` proxy path

**Demoted (default off):** the raw proxy now registers only when the Security ›
**"Raw CLI proxy"** setting is on — its observed real usage is covered by dedicated
pinned-subcommand tools (`obsidian_note_history`, `obsidian_note_diff`,
`obsidian_base_create`, the snippet tools, `obsidian_plugin_install`/`uninstall`)
with typed arguments, and the free-text command string below is the root of the
guard complexity this section describes. Everything in this section still applies
whenever the proxy is enabled, and `obsidian_base_create` runs the same
`base:create` content scan through the shared rule. `history:restore` is
deliberately not promoted to a dedicated tool: restoring a prior version can
reinstate an accepted value a human revoked, and the restored bytes cannot be
scanned pre-exec (#110) — it stays in the proxy's default-denied
uninspectable-write set.

`obsidian_cli` proxies ~104 official Obsidian CLI commands, which run *inside* Obsidian and
therefore **bypass the MCP note-write primitive** where the guard above lives. That is a real
hole — an agent could otherwise persist acceptance through the CLI. So the CLI path grows its
**own** accept-forbidden check (`cliAcceptRefusal` in `packages/host/src/mcp/tools-cli.ts`),
run **before the command executes**, reusing the exact same `acceptForbiddenReason` rule — no
fork of "accepted." A CLI write is always an *introduce* (the CLI path has no expression for
"carry an existing human value forward"), so the introduce check is exactly right.

The complete set of CLI commands that write note content or frontmatter — all guarded:

- **`property:set`** family (`property:set name=<prop> value=<val>`, and the direct
  `key=value` shorthand; a defensive `frontmatter:set`/`add`/`update`/`patch` alias). A
  property literally named `status` set to `accepted` (`property:set name=status
  value=accepted`) is **allowed** — only the acceptance fields are keyed on, matching the MCP
  path.
- **Content writers** `create`, `append`, `prepend`, **`base:create`**, and the periodic-note
  variants `daily|weekly|monthly|quarterly|yearly:(create|append|prepend)`. Their
  caller-controlled `content=` is scanned for an acceptance-asserting frontmatter fence,
  including one hidden behind the CLI's escape expansion — scanned under a **bracketed set of
  escape readings** (#153; see the accept-guard section on the CLI reconstruction, which
  narrows this path but does not fully close it — the binary's true escape vocabulary is
  unobserved), and including embedded (not just leading) fences. With no YAML parser injected
  the scan **fails closed** on any fence at all.

The refusal is a typed `Error [accept_forbidden]`, and nothing runs.

### The opaque-macro residual — CLOSED by the command policy

Some CLI commands execute **opaque code** whose effect cannot be inspected before it runs:

```
OPAQUE_ACCEPT_CLI_COMMANDS = ["quickadd", "quickadd:run", "quickadd:run-template", "eval", "command"]
OPAQUE_ACCEPT_COMMAND_IDS  = ["quickadd:*", "js-engine:*"]   // obsidian_run_command ids
```

These are now **denied by default — fail closed** — by the settings-driven command policy
(`mcp/cli-policy.ts`), on both surfaces (`obsidian_cli` commands and `obsidian_run_command`
ids), with a typed `Error [cli_denied]` before anything executes. Re-enabling goes through the human-only settings (`Security › "Re-enabled opaque commands"`): an exact entry re-enables one command or command id, and a trailing-`*` entry re-enables a family of `obsidian_run_command` ids, never a CLI command and never an accept verb's QuickAdd choice (Nelson, 2026-10-14);
a settings deny list always wins, including over a re-enable. The policy **composes** with the
older gates rather than replacing them: a re-enabled `eval`/`command` still needs the
**"Allow dangerous CLI commands"** toggle, and the accept guard on inspectable writes is
untouched. The human-only property is itself enforced: the MCP write primitives refuse
non-`.md` paths, the opaque surfaces that could write settings from inside are what the policy
denies, and the CLI proxy bars its own param values from `.obsidian` territory
(`configPathRefusal`), so no agent-reachable path rewrites the policy.

`create template=<t>` draws frontmatter from a template note the call only *names*. The
**template guard** resolves it (in the core Templates folder, exactly where the CLI resolves
it) and scans it with the same rule pre-exec; unresolvable fails closed. That closes the
**static** case: a template carrying a literal accepted fence is refused.

The scan alone would **not** close the path, and saying otherwise would be worse than the gap
itself. The vault expands Templater `<% %>` tags *after* the guard has scanned — so the bytes
inspected are not the bytes that land, which is the #126 defect shape one level up: an
expansion can emit both an acceptance assertion and the fence characters around it from a
template that literally contains neither (Templater's date-format facility honors moment's
`[…]` literal escape, which is enough to synthesize arbitrary bytes). **A static scan is a
floor, not a proof.**

So the template guard **fails closed on expansion tokens** (#137, Option 2): a template whose resolved bytes carry *any* expansion token — a Templater `<%` opener **or** a core-Templates `{{ … }}` field — is **refused outright**, because its expanded output cannot be inspected before it lands (`templateExpansionRefusal` refuses on either opener as a substring, covering every Templater tag form and the whole core-Templates field class).
The refusal names the escape hatch — expand
the template in Obsidian first, or use a
template without expansion tokens. Both create-from-template surfaces route through the one
predicate (`templateContentAcceptRefusal` in `tools-cli.ts`): the CLI `create template=` /
`quickadd:run-template path=` path **and** the MCP `obsidian_create_note_from_template` tool
(`tools-integrations.ts`), so neither twin can be left unguarded. The core Templates plugin's
`{{date:FORMAT}}`/`{{time:FORMAT}}` fields run FORMAT through moment, which honors the `[…]`
literal escape and so can emit an acceptance assertion and its `---` fence from a template
carrying neither — the same arbitrary-emission vector as Templater's date format, reached
through the plain `create template=` path — which is why the whole `{{ … }}` class is refused
rather than a carved-out "safe" subset (an earlier fix exempted these fields on a false "no
arbitrary-emission facility" claim; that exemption *was* the #137 hole).

What remains open, honestly named:

- a **periodic create with no `content=`** draws its body from the Daily/Periodic Notes plugin
  config's template — no param names it; the same class as the documented
  `obsidian_periodic_note` write residual;
- a re-enabled `quickadd:run-template path=<p>` still stays in the default-denied set: even
  with its template file scanned and expansion-token-refused, QuickAdd's *own* format syntax
  can compute frontmatter at run time from something no param names — a distinct opacity from
  the template file's bytes.

The pattern connecting every one of these: **the guard must inspect the bytes that will be
honored.** Each residual is a place where something else — an escape expansion, a template
processor, another plugin's config — produces the honored bytes after the guard has looked.

## Why this is structural, not procedural

The value of the model is that "an agent cannot accept" is not a rule an agent is *asked* to
follow — it is a property the kernel *enforces*. An agent that has never heard of the
acceptance model, or one actively trying to forge acceptance, hits the same wall: the write is
refused before it lands. Combined with the [module system's](module-system.md) accept/baseline
name tripwire (no module may even *register* a tool whose name mentions `accept`/`approve`/
`baseline`) and the fact that no module is handed a write or accept surface at all, the
invariant is defended at the write path, at the CLI path, and at the extension boundary
simultaneously.

The human's accept gesture stays exactly where it belongs: in a person's hands, in the review
pane.
