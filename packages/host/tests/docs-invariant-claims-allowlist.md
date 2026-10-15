# Docs invariant-claim allowlist (#152)

Each entry below is a span of prose from README.md or docs/*.md that
`docs-drift.test.mjs` flagged: it contains BOTH an invariant word ("never",
"every", "always", "cannot", "no way", "guarantee(s)", "impossible") AND a
security-relevant term (journal, accept/acceptance/accepted, guard, audit,
"every write", provenance). The check fails CI unless the exact span text
below is present verbatim (or, see "Known-overstated" below, is explicitly
tracked as not-yet-true rather than approved).

**This file does not assert that any claim in the approved sections is
true.** It records that a human reviewed the sentence, checked it against
the current implementation and open issues, and deliberately decided it is
safe to publish as written. Seeded from `main` at the time #152 landed (see
the seeding commit) — every entry here was reviewed at seed time, not
rubber-stamped. Re-audited in full against the open perimeter-milestone
issues (#92, #105, #107, #109, #110, #137, #153) on 2026-08-10 after an
initial seed was found to be laundering two false claims — see the
Known-overstated section for what that audit changed.

`docs/vision-walkthrough.md` and its genre-based exclusion were RETIRED by
the 2026-08-23 documentation migration (the page's content is owned by
getting-started.md and user-guide.md). No file is excluded from this check
anymore; the imported target-state corpus is handled span-by-span in the
"Imported documentation corpus" section at the bottom — tracked, not
approved — because allowlisting aspiration-written-as-fact as APPROVED would
train this control to accept exactly the thing it exists to catch.

If a claim's wording changes at all — including gaining or losing a
qualifier like "through the plugin's guarded path" — it becomes a different
span and is no longer covered by its old entry. That is intentional: a
narrowed claim needs the same conscious re-approval as a new one.

To approve a new or changed claim: confirm the current implementation and
perimeter tests substantiate it, then add the exact span text as a `- `
bullet under the file it lives in (headings below are for review grouping
only; matching is by exact text regardless of which file it's under). If
the claim is the document's stated goal rather than a currently-true fact,
and the surrounding document already carries the honest nuance, use the
Known-overstated section instead — see its header for the format.

## README.md


## docs/README.md


## docs/acceptance-model.md

- This is the reason the rule above is "decide over the honored bytes" rather than "never normalize": where normalization is unavoidable, the normalization itself becomes part of the guard's attack surface, so every bracketed normalization is decided over.
- Broader is fine; **narrower is the bypass.** The property is pinned by `tests/accept-fence-parity.test.mjs`, which asserts *write path would honor ⟹ guard refuses* across every tolerated fence variation, plus the normalization cases that motivated the second pass, plus the cost of the conservatism (prose between thematic breaks is refused — a chosen trade, pinned so it reads as a choice).
- **A value** *asserts* acceptance if — across **every value-type it can take** — it resolves to `accepted` / `accepted-*`:
- **Move is not a content write.** `obsidian_move_note` / `obsidian_move_notes` rename through `app.fileManager.renameFile` and never touch note content, so a move cannot introduce acceptance and carries no content guard — the guarantee holds by construction there rather than by an added check.
- So the CLI path grows its **own** accept-forbidden check (`cliAcceptRefusal` in `packages/host/src/mcp/tools-cli.ts`), run **before the command executes**, reusing the exact same `acceptForbiddenReason` rule — no fork of "accepted." A CLI write is always an *introduce* (the CLI path has no expression for "carry an existing human value forward"), so the introduce check is exactly right.
- So the template guard **fails closed on expansion tokens** (#137, Option 2): a template whose resolved bytes carry *any* expansion token — a Templater `<%` opener **or** a core-Templates `{{ … }}` field — is **refused outright**, because its expanded output cannot be inspected before it lands (`templateExpansionRefusal` refuses on either opener as a substring, covering every Templater tag form and the whole core-Templates field class).
- The pattern connecting every one of these: **the guard must inspect the bytes that will be honored.** Each residual is a place where something else — an escape expansion, a template processor, another plugin's config — produces the honored bytes after the guard has looked.
- `history:restore` is deliberately not promoted to a dedicated tool: restoring a prior version can reinstate an accepted value a human revoked, and the restored bytes cannot be scanned pre-exec (#110) — it stays in the proxy's default-denied uninspectable-write set.
  substantiated 2026-08-17 (CLI decomposition PR): `DEDICATED_CLI_COMMANDS` in
  tools-cli-dedicated.ts pins history/diff/base:create/plugin:install/plugin:uninstall and
  nothing else — cli-dedicated.test.mjs asserts the registered set exactly and that no
  source pins "history:restore" — and the command stays in cli-policy.ts's
  UNINSPECTABLE_WRITE_CLI_COMMANDS default-deny set, whose rationale (#110) this sentence
  restates.
- **This does not touch the agent-side guarantee.** The stamp is an in-app, human-gesture-gated `processFrontMatter` call (`stampAcceptedFrontmatter`, module-scope and unexported in `packages/governor/src/wiring/wiring.ts`, reachable only through the gesture-gated accept handler) — it **bypasses MCP entirely** and is exactly the human path the accept-forbidden guard reserves.
  substantiated 2026-08-18 (acceptance convergence, #221/#164): packages/core is diff-zero in
  that change; governance-module.test.mjs pins stampAcceptedFrontmatter as module-scope,
  unexported, with exactly one caller (acceptNote's injected stampAccepted dep on the
  gesture path) and asserts the MCP layer references none of the accept path. The residuals
  in "Known-overstated" (#137/#105/#107) qualify the agent-side guard exactly as before —
  this sentence claims the CONVERGENCE changed nothing on that side, which is what the
  zero-diff + regression run substantiate.
- A failure between the stamp and the baseline advance leaves the note stamped with the old baseline; the retry Accept sees `accepted` and takes the advance-only branch, so a double-stamp is impossible.
  substantiated 2026-08-18: governance-accept.test.mjs "setBaseline throws AFTER a landed
  stamp" pins exactly this — the retry stamps zero additional times and lands the baseline
  on the stamped bytes; acceptNote only stamps when acceptanceStatusOf(content) ===
  "proposed", which a landed stamp has made "accepted".
- Every agent transport still refuses the accepted family; `@vault-mcp/core` is unchanged.
  substantiated 2026-08-18: the accept-guard suites (accept-forbidden, accept-fence-parity,
  accept-guard-control-char, mcp-template-accept-guard, append-at-heading-accept, cli
  guards) run unchanged and green in the convergence PR, and packages/core has a zero diff.
  "Every agent transport" carries the same tracked residuals as the opening claims
  (#137/#105/#107) — unchanged BY this change, per the section above.
- The legacy QuickAdd accept-macro gated acceptance on vault-specific checks (uuid7 `uid`, `title`, `description`); that gate maps onto this config — per-vault configuration, never a hardwired vault convention in the plugin.
  substantiated 2026-08-18: requiredFrontmatterKeys defaults EMPTY (no gate) and the plugin
  source names no vault-specific key — the uid/title/description list appears only as a
  settings placeholder/example; governance-proposed.test.mjs pins the coercion and
  governance-accept.test.mjs pins empty ⇒ no gate.
- The accepted family is one hardcoded instance of a general rule, and #224 generalizes it: a **declared list** of frontmatter properties (Security › *Protected frontmatter properties*, human-only-mutable — no agent path writes plugin config) that every guarded transport enforces through the **same two predicates** the accepted family already rides (`acceptTransitionReason` / `acceptForbiddenReason` in `@vault-mcp/core`).
  substantiated 2026-08-18 (#224): the declared list lives in the module registry inside
  accept-guard.ts and is consulted INSIDE the two predicates, so every existing call site
  (fs backend, ObsidianBackend, composeNote, append_at_heading, CLI property/content,
  fileclass, skills, provenance, revision, debt-register) enforces it with zero call-site
  changes; protected-properties.test.ts, protected-properties-fs.test.ts and
  protected-properties-transports.test.mjs are the per-transport sweep. (The skills call
  site left this package at the suite split's S4; the satellite runs the identical
  `acceptTransitionReason` from `@vault-mcp/core`, which is why moving it did not move the
  guard.) "No agent path
  writes plugin config" carries the standing settings-surface caveat: settings are
  data.json, mutable by any local process outside the plugin's transports — the same
  residual the class allowlist documents (a tampered list can only extend the perimeter;
  the floor is hardcoded).
- The acceptance module's `honoredValueFromBlessed` reads the accepted **baseline** — never the raw frontmatter — so a value sneaked in through a side door (another plugin, a script, Sync) is **inert** until blessed.
  substantiated 2026-08-18 (#224/#135): honoredValueFromBlessed takes the blessed CONTENT
  (wiring reads it off the BaselineStore) and has no raw-note read path; baselines advance
  only via Accept / attributed human edit / adopt / auto-accept, each blessed by
  construction. governance-protected-policy.test.mjs's honor-rule scenario pins side-door
  inertness and the bless-then-honor flip.

## docs/agent-writes.md

- The guard monkeypatch (`server.ts`) already wraps every *mutating* registration in one `runMutation`, and the write queue is non-reentrant (a queued closure that enqueues again would deadlock behind itself).
- **Stamping never writes acceptance.** It adds no `acceptance-status` at all, never mints or elevates to `accepted`, and preserves an existing on-disk `acceptance-status` **verbatim** (including a human-granted `accepted` — changing it would destroy the human's decision).
- It is the third [kernel argument](kernel-v0.md#kernel-arguments) (`KERNEL_ARG_KEYS = ["if_rev", "idempotency_key", "intent"]`), declared on **every mutating registration** via `withKernelArgs` and **peeled by the guarded wrapper before any handler runs** (`packages/host/src/mcp/guarded.ts`).
- **Journal-only.** It is recorded verbatim on the journal record beside `op`/`actor` (`JournalRecord.intent`, `packages/host/src/kernel/journal.ts`) and **never reaches note content** — it is peeled before the handler, so it structurally cannot be written into a note's frontmatter or body.
- **Never an accept or idempotency signal.** It is **excluded from idempotency identity** — a retried call may reword its intent freely and still dedupe — and it is **never read back** as any kind of acceptance or approval signal.
- **Batch-aware.** `obsidian_write_notes` accepts a batch-level `intent` describing the change-*set*; the guarded single-writer peels it per item, so **every** item's journal record carries it and the Acceptance pane's per-note rows each show it.
- **It exposes data the governance provider published — nothing more.** The provider (`packages/governor/src/wiring/wiring.ts`) rewrites a read-only index at `<provider plugin dir>/governance/pending-index.json` — beside the acceptance log — on every review-queue refresh (`refresh()`, via the pure serializer in `packages/governor/src/kernel/pending-index.ts`); this tool reads it.
  approved 2026-08-19 (#261), reworded at S3c (2026-09-08) for the package move — the claim is unchanged, only where the publisher lives: substantiated by the publisher wired in `refresh()`
  (wiring.ts writes `serializePendingIndex` bytes to `pendingIndexPath` on every queue
  recompute) and the pending-review round-trip tests; the retired stewardship path is dead
  since #164 and no longer read.
- `readOnlyHint: true`, empty input schema, no write and no accept/baseline verb: it reports pending-ness; it cannot accept ("the accept verb is in no API").

## docs/suite-split-design.md (PROPOSAL — see the doc's status banner)

- The §9 reachability invariant says accept-class capabilities must never be reachable from `app`.
  approved 2026-08-25: a restatement of the standing invariant, already pinned by the
  governance reachability/tripwire suites (governance-module.test.mjs) — the proposal cites
  it, it does not extend it.
- What the seam must NEVER offer is the third hook class: anything that can **mutate a write in flight or assert acceptance**.
  approved 2026-08-25 AS A DESIGN RULE OF AN UNBUILT SEAM: no code exists yet; the doc itself
  says the prohibition "is a load-bearing design rule, to be pinned by test" in the S2
  package. The gap is declared in the sentence's own home; when S2 lands, this entry gains
  its test citation or the suite catches the lie.

## docs/suite-split-design.md (threat-model retriage)

- **Condition 4's per-hook byte copies.** The cheap half survives (deep-freeze `operation` and `actor`, which also catches a BUGGY hook mutating shared state); copying every write's bytes per hook is a per-write cost paid against an actor §0 excludes.
  approved 2026-08-27: a DEFERRAL record, not a safety claim — it states what the build will
  NOT do and why, against the threat model §0 records as Nelson's ruling. The strong form is
  preserved verbatim on the branch reference/hostile-threat-model (921f72e), which is the
  evidence: reversing the decision is a read, not a re-derivation.

## docs/suite-split-design.md (perimeter-review amendments)

- Rule 6 (§5) generalizes it: the seam accepts registrations that can only ADD A REFUSAL, never a predicate the host consults for permission.
  approved 2026-08-27 AS A DESIGN RULE OF AN UNBUILT SEAM: no seam code exists; §5's own
  condition 2 requires this pinned as a source scan over the seam's declared return types when
  S2 lands, and the doc says so. The rule's evidence today is the review's finding 2 (the
  boolean sessionGate could express an ALLOW) and the in-tree precedent it cites
  (setLegacyWriteGuard is permission-shaped and safe only because it is unreachable from app —
  inventory-non-mcp.ts:103 says so itself).
- Ship `registerWriteVeto` only with a real registrant and a round-trip test — §5/§6's two named registrants were both wrong on the code (the fuller transition guard is `acceptTransitionReason`, host-side in `@vault-mcp/core`; the legacy-writer guard is a provider-internal `BaselineStore` predicate that never touches the seam).
  approved 2026-08-27: a factual correction verified by the reviewer against the current tree
  (packages/core/src/accept-guard.ts's acceptTransitionReason; governor/wiring/wiring.ts's
  setLegacyWriteGuard consumed by the provider's own BaselineStore). It states what does NOT
  cross the seam, which is a claim about code that exists.

## docs/suite-split-design.md (S3 observations ruling)

- Host-held config cannot serve a provider consumer, so the only alternative to publishing is two copies — which is precisely the failure `territories.ts`'s own header names: *"a prefix present in the pane's list but missing from capture's means the pane politely skips a folder while capture quietly writes its note bodies to disk."* On this operator's vault the guarded prefixes include `80-89` (legal/PII, standing rule that its contents do not leave it), so a drift here is a PII leak into capture blobs, not a tidiness problem.
  tracked by: NOT a guarantee about shipped behavior — it is the RISK ARGUMENT for a design decision (publish `territories` as a contract rather than duplicate it), and it is substantiated by code that exists: `governor/wiring/territories.ts` has three importers landing on both sides of the split (`main.ts`, `mcp/server.ts`, `governor/wiring/wiring.ts`), and the quoted sentence is that module's own header comment, not a new claim. What it does NOT assert: that capture is currently leaking anything, or that publishing the module makes the territory list correct — the list is still this vault's folder names hardcoded, which issue #321 owns. Agent-classified during S3; pending the operator's review like every other span in this file.

## docs/suite-split-design.md (S6 cross-session extraction)

The S6 execution note's guard-argument finding. Substantiated by the same
evidence as the corresponding `docs/crosssession.md` claims below: the
`to_address` / `displace_to_address` precedent is recorded in
`packages/host/CLAUDE.md`'s scheme-module bullet (an active allowlist
checked the address string as if it were a path), `src/guard.ts`'s
`collectPaths` + `isVisible` are what would do the prefix-matching, and
`packages/crosssession/tests/crosssession-module.test.mjs`'s publication block
pins that none of the four tools' arguments is a host `PATH_KEY`. The "file
`post` writes is discovered inside the handler" half is that package's post
tests, which assert the append target is chosen from the channel folder's
members and reported back as `filesChanged` / `files` rather than named by any
argument.

- First, the guard-argument question came out the OPPOSITE way from triage's: triage renamed `target` → `target_path` to give the host's guard something to scope, but cross-session's `channel` was deliberately left un-path-keyed, because it is a REF (uid | folder-note path | folder) rather than a path, because the file `post` writes is discovered inside the handler and named by no argument, and because path-keying it would refuse every uid-addressed call under an allowlist — the bug the scheme-write `to` → `to_address` rename fixed, in reverse.

## docs/suite-split-design.md (scheme ruling, S8)

- Scheme addressing (`jd:<address>`) is wired into the host's guard interception point (`mcp/guarded.ts`) exactly like `uid:` addressing — every path argument of every tool, host or external, can carry a scheme ref, and the resolution must run before the allowlist checks the resolved path.
  approved 2026-09-07: substantiated by shipped code and its pins — `resolveSchemeArgs` binds in `makeGuarded` immediately after uid resolution and before `guardCall` (guarded.ts), which is the CLAUDE.md-documented design ("Resolution runs before the guard so the allowlist checks the RESOLVED path"), exercised by the scheme-addressing suites. The sentence is the RATIONALE for ruling scheme host-side, describing the existing wiring; it asserts no new behavior.

## docs/suite-split-design.md (host/governor split, S3c)

Three spans from the S3c execution record, all statements about code that
exists in this tree rather than about a target state.

Substantiation, in order. **The seam has no veto.** `registerWriteVeto` was
specced in §5, retriaged as condition 8 ("YAGNI at a perimeter"), and never
built: `packages/host/src/mcp/seam.ts` declares exactly two registrars
(`registerWriteObserver`, `registerSessionRefusal`), and
`packages/host/CLAUDE.md`'s seam bullet records the search for a real
registrant that came back empty — the fuller transition rule is
`acceptTransitionReason` in `@vault-mcp/core` (host-side) and the
legacy-writer guard is a provider-internal `BaselineStore` predicate off the
MCP write path. The span asserts an absence, and the absence is enumerable.

**The four reads lose their in-tool filtering.** The publishing contract
carries no caller scope — that is the standing apiVersion-2 item this file's
S7 and mutating-tier sections already track from the other side — so a
published tool cannot read `GuardSettings` from the host. What replaces the
filter is `external-tools.ts`'s F3 branch, which refuses the whole call when
an allowlist is active and `collectPaths(args)` is empty; four of the five
published tools carry no `PATH_KEYS` argument. The span says the filtering is
lost and names what replaces it, which is the honest form of the same finding
S4–S8 recorded.

**The journal is adopted by copy.** The host's first-load adoption copies
`journal/`, `install-id.json` and its own `data.json` keys out of the
provider's plugin folder and deletes nothing; the provider's folder and its
`governance/` tree are not touched. The reason is stated in the span itself
and is a correctness argument, not a safety claim: an append-only record must
not be in flight during a folder rename, and a half-completed adoption has to
leave the single-artifact rollback intact.

- Note the draft said the provider "registers the fuller transition veto" — it does not, because `registerWriteVeto` was never built (condition 8's YAGNI-at-a-perimeter ruling); the fuller guard is host-side in `@vault-mcp/core` and the legacy-writer guard is provider-internal |
- The four also lose their in-tool visibility filtering, because a satellite cannot reach the host's guard settings; what replaces it is the host's gate refusing the whole call rather than trimming the answer.
- **Fourth, the journal is ADOPTED BY COPY, never by move.** The provider keeps `.obsidian/plugins/governor/` and everything under `governance/` — zero moves for the authority state, which is the whole reason the provider took the old id rather than the host.
- **The host's module registry declares ONE built-in module (`scheme`).** A surviving `modules.acceptance` row in either `data.json` is an unknown id: reported by skip-and-report, never mounted.
  approved 2026-09-08 (S3c): `builtinModules` in packages/host/src/mcp/modules-mount.ts returns
  the `scheme` module alone, and `packages/host/tests/modules-mount.test.mjs` pins both halves —
  the declared list is exactly `["scheme"]`, and mounting with a `modules.acceptance` row present
  produces the problem line "settings name unknown module 'acceptance' — ignored" with no entry
  in `registry.describe()`. The row is kept in the file on purpose: it is the provider's adoption
  source and part of the rollback path, which is why "reported and ignored" is the claim rather
  than "removed".
- **The review queue's event drive (#261), which got narrower.** The host used to nudge the queue from inside its `journal.append` wrapper — every append.
  approved 2026-09-08 (S3c): the claim is HISTORICAL and describes code that no longer exists —
  the pre-split `packages/host/src/main.ts` wrapped `journal.append` and called
  `nudgeGovernanceQueue` from it unconditionally. It is recorded here because the sentence
  introduces the live-checklist item for what replaced it: the provider now nudges from the
  seam's write observer (`packages/governor/src/main.ts`), which fires only where the host
  produced write facts, so appends taking no queue slot and non-note-write mutations wait for
  the 2.5s interval instead. Both sides say so — `packages/host/src/main.ts`'s journal-wrapper
  comment and `packages/governor/src/wiring/wiring.ts`'s `nudgeGovernanceQueue` header — and the
  gap is named rather than closed, because closing it means a journal-growth fact on the seam.

## docs/acceptance-model.md (WP10c retirement)

- **The first consumer — the per-note auto-accept policy (#135) — RETIRED (WP10c, 2026-08-25).** `auto-accept` remains in the default declared list as authority-conferring, but the policy's operational half is deleted per the development guide's order: `auto-accept: all` no longer parses at all (a whole-note blank check never belonged in frontmatter — it reads as no policy under every authority era, including after a cutover rollback), and `auto-accept: appends` is migrated to content proposals — an appended tail is residual content like any other edit, and lands as an ordinary proposal for the human's decision.
  approved 2026-08-25 (WP10c): autoAcceptPolicyOf parses only "appends" (protected-policy.ts);
  governance-protected-policy.test.mjs pins that a blessed `all` is STILL no policy (the
  deletion is at the parser, upstream of the honor boundary) and was mutation-verified by
  resurrecting the `all` parse (9 ✖).
- The #261 composition machinery (mechanical classes plus an appended tail) was deleted with the policy; its wedge cannot recur, because nothing waits on a policy-accept anymore.
  approved 2026-08-25 (WP10c): evaluateBodyWithAppend and the allowAppend evaluator arm are
  deleted from detectors.ts; the rewritten composition suite pins the composed case now
  refuses while the class-only halves still pass.
- **The legacy sweep's event-driven design (#261), retained for the pre-cutover/rollback era.** Live diagnosis showed Chromium suspends renderer timers while the Obsidian window is occluded — the 2.5s journal poll simply never ticked during unattended sessions, which is exactly when agents write (the observed "zero auto-accept records ever").
  approved 2026-08-19 (#261), retitled 2026-08-25 (WP10c): the diagnosis stands unchanged; the
  heading now scopes it to the era whose sweep it drives.

## docs/acceptance-model.md (#261 additions)

- **The sweep is event-driven, not timer-only (#261) — and era-scoped (WP10c).** Post-cutover the legacy auto-accept sweep never runs (its writer refuses; running it was pure work and noise); the poll's automated arm is the **mandated-admission sweep** instead, which puts mandate-stamped proposal cohorts through the full admission refusal table — promotion evidence, scope, classes, verifier coverage, budgets — or leaves them for the human.
  approved 2026-08-19 (#261), era-scoped 2026-08-25 (WP10c): the #261 diagnosis stands as a
  live observation; the era swap is pinned by governance-mandate-admission.test.mjs's
  source-scan legs (the legacy sweep behind !legacyRetired, the mandated sweep as the else
  arm) and the sweep suite (the door gates every attempt).
- The kernel now nudges the governance poll after **every journal append** (`nudgeGovernanceQueue`, wired in `main.ts`), so queue refresh + sweep run within seconds of an agent write even with the window buried; the interval remains as foreground catch-up.
  approved 2026-08-19 (#261): substantiated by the main.ts append wrapper + the
  governance-module source pins ("main.ts nudges the governance queue after every journal
  append") and the live nudge run (write → refresh + sweep in ~4s, window occluded).

## docs/conformance.md

- Frontmatter is a `generated`/`generator` derivation stamp, never an acceptance field (accept-guard-checked before every write).
  substantiated 2026-08-17: `renderDebtRegister` emits a fixed two-key frontmatter block
  (nothing from the sidecar reaches frontmatter), and BOTH write paths —
  `obsidian_conformance_debt_render` (tools-conformance-debt.ts) and the CLI's
  `renderRegisterTo` (conformance/cli.ts) — call `registerAcceptRefusal` (the shared
  `parseGuardFrontmatter` + `acceptForbiddenReason` predicate) over the rendered text
  before writing; pinned by tests/conformance-debt-register.test.mjs. Re-checked
  2026-10-14 after the move to the vaultmcp-conformance plugin: the tool is now
  `vaultmcp_conformance_debt_render` (packages/conformance/src/tools.ts), the CLI path
  is packages/conformance/src/kernel/cli.ts, both still call `registerAcceptRefusal`,
  and the pin moved to packages/conformance/tests/conformance-debt-register.test.mjs.

## docs/identity-and-links.md

- It binds at the **same single interception point** as the accept guard and the write queue (`packages/host/src/mcp/guarded.ts`), so handlers never see a uid reference — they get the resolved path.

## docs/kernel-v0.md

- Every mutating operation appends **one JSONL line** to `.obsidian/plugins/vault-mcp/journal/YYYY-MM.jsonl` (rolled monthly, inside the host's own plugin folder, not the note tree).
- A failed journal write is logged to console and dropped; it never fails the vault operation.
- Claiming and releasing are treated as **mutating** (journaled with `target.ref = scope:<prefix>` / `lock:<id>`), so **read-only mode blocks claiming and releasing** — there is nothing for a claim to disclose in a session that cannot write.
- They are declared generically on **every mutating registration** (`withKernelArgs` in `packages/host/src/mcp/guarded.ts`) and consumed generically (stripped from args and passed to `Kernel.runMutation`).

## docs/module-system.md (formerly docs/modules.md — renamed 2026-08-23; spans match by text, headings are organizational)

- Because the registrar it forwards to is the **guard-patched `server.registerTool`**, every module tool lands at the **same interception point** as every hand-registered tool — guarded, queued, journaled, kernel-args-declared, Code Mode captured — with **no module-specific bypass possible**.

## docs/reference.md

- Every mutating operation also appends **one JSONL line** to `.obsidian/plugins/vault-mcp/journal/YYYY-MM.jsonl` (rolled monthly, inside the host's own folder rather than the note tree):
- If a journal write fails it is logged to the console and dropped; it never fails the vault operation.
- Safety guards that apply: read-only mode always applies (mutating external tools are blocked when read-only is on); the path allowlist scopes arguments under recognized path keys (path, from, to, paths, and a few others) — when an allowlist is active, mutating external tools whose args carry no recognized path key are blocked outright, since the host cannot scope the call.
- `readOnly: true` on a published tool is an assertion by a third-party plugin about code the host cannot inspect — and believing it exempts that tool from the write queue, the journal, the path allowlist, the kernel arguments, and read-only mode, all at once.

## docs/reference.md (#264 record immutability)

Reviewed at authoring time (#264). Both claims are substantiated by
`tests/record-immutable.test.mjs`: the per-op refusal sweep (write / patch /
frontmatter / move / trash / delete / append_at_heading), the
destination-is-a-record multi-path pin, the journaled-refusal pin, and the
fail-open pins (undefined flag, throwing probe, probe without `record`).
Scope note: "every mutating operation that names one" is scoped to the
kernel (the plugin's guarded path) and to operations that NAME the path —
the surrounding paragraph carries the fail-open qualifier, and writes that
bypass the MCP server entirely are out of scope by the stated threat model.

- The kernel refuses **every mutating operation that names one** (write, patch, frontmatter edit, move, trash, delete — and a move whose *destination* is a record, which would overwrite it) with `Error [record_immutable]: …` before the handler runs, journaled like any other refused operation.
- The check runs at the front of the write queue (same point as `if_rev`), reads the flag from Obsidian's already-parsed metadata cache, and **fails open**: a missing file, an unparsed cache, or an unreadable frontmatter never refuses anything — this guard is protective, and an unreadable note must not turn into a vault-wide write outage.

## docs/triage.md

Reviewed at authoring time (#221 phase 2), re-reviewed for the phase-3
rewrite (#241), and again at the S5 satellite extraction (triage is now the
`vaultmcp-triage` plugin, so both substantiating suites live in
`packages/triage/tests/` rather than here). Each claim is substantiated by
`packages/triage/tests/triage-module.test.mjs`: the all-agent built-in table
+ empty gesture-gated set, the merged-table collision/enum pins (no
accept-shaped id, a raw command id is not a disposition), the
acceptance-patch refuse-at-validation + sanitize/drop-at-coercion pins
(config patches AND declared-row patches) with the handler's
accept-forbidden re-check belt, the destination_occupied / out_of_allowlist
/ move_denied refusals (dry-run included, apply re-check proven), and — for
the move-primitive claim — `packages/triage/tests/link-healing.test.mjs`,
which drives the real adapter against a fake app whose `vault.rename` throws
and scans that package's own source for any call to it.

The two claims about the guarded registration point and the dormant
in-handler allowlist re-check were added at S5. The first is substantiated by
`tests/external-tools.test.mjs` here (external tools register through the
guard-patched `buildMcpServer` path, are treated as mutating unless the
publisher is trusted, and are blocked outright under an allowlist when they
carry no recognized path key) plus
`packages/triage/tests/triage-module.test.mjs`'s publication block, which pins
that `vaultmcp_triage_dispose` carries `path` and `target_path` — both host
PATH_KEYS — and that the queue carries none. The second is a claim about what
is NOT enforced and is the honest counterpart: the satellite supplies no
`visible`, which that same block documents, and the real bound on a declared
row's configured destination is `moveWhitelist`/`moveBlacklist`, pinned at
plan time and re-checked at apply.

- The **authority axis** sorts every verb with one rule: a disposition that **confers standing** (accept, adopt, revert-of-standing) is a human gesture — never an API; a disposition that is an ordinary reversible write is agent-expressible through the guarded path.
- Declared rows are *not* runtime additions to that table: they are **configuration** the planner interprets — human-only-mutable data whose authority answer is uniform (every declared row is exercised by an agent through the one guarded `vaultmcp_triage_dispose` tool; none confers standing).
- A patch carrying an acceptance field is refused at validation AND sanitized/dropped at coercion — it can never reach a note.
- Moves ride a link-healing rename (`fileManager.renameFile`, parents created, **never an overwrite**: `destination_occupied`); trash is Obsidian's trash; frontmatter transitions go through `processFrontMatter` with the shared accept-forbidden rule re-checked over every effective patch.
- Both tools are published external tools and register at the host's guarded registration point like every built-in: read-only mode, path allowlist, serialized write queue, journal, kernel args.
- The in-handler re-check of the computed destination against the allowlist is retained in the code but is dormant, since a satellite cannot reach the host's guard settings.

## docs/crosssession.md

Added at the S6 satellite extraction (cross-session coordination is now the
`vaultmcp-crosssession` plugin, so its behavioural suite lives in
`packages/crosssession/tests/` rather than here). Four claims, each checked
against the implementation at approval time:

1. **"every mutating call rides the host's guarded registration path … all
   still bind."** Substantiated here by `tests/external-tools.test.mjs`: an
   external tool registers through the guard-patched `buildMcpServer` path, is
   treated as mutating unless the publisher is trusted, and is blocked outright
   under an allowlist when it carries no recognized path key. The list of what
   binds is `src/mcp/guarded.ts`'s single interception point, which is the same
   object for built-ins and external tools alike — there is no second
   registration path a published tool could take. Note the claim is that the
   record-immutability check BINDS, not that it ever fires for these tools; see
   claim 3.

2. **The uid-would-be-prefix-matched claim.** Read against `src/guard.ts`:
   `collectPaths` collects any string under a `PATH_KEYS` name and `guardCall`
   runs each through core's `isVisible`, which normalizes and prefix-matches at
   a segment boundary. A uid string has no allowlisted prefix, so it would
   refuse `out_of_allowlist`. The named precedent is real and is recorded in
   `packages/host/CLAUDE.md`'s scheme-module bullet: `to`/`displace_to` were
   renamed to `to_address`/`displace_to_address` precisely because an active
   allowlist checked the ADDRESS STRING as if it were a path. The claim is a
   counterfactual about a rename that was NOT made, which is why it is stated
   as the reason for not making it.

3. **The `RECORD_EXEMPT_OPS` claim.** Re-verified at S6 and substantiated on
   both sides. Host side: `src/kernel/record-guard.ts`'s exemption set is
   unchanged, and `tests/record-immutable.test.mjs` pins that BOTH the old
   `crosssession_post` and the new `vaultmcp_crosssession_post` spellings are
   unexempted. The "always ran inside the kernel" half is
   `tests/modules-mount.test.mjs` (module tools register through the same
   registrar) plus `tests/external-tools.test.mjs` (published tools do too).
   The "unreachable on arguments" half is
   `packages/crosssession/tests/crosssession-module.test.mjs`'s publication
   block, which asserts that not one of the four tools' arguments appears in
   the host's `PATH_KEYS` — so `collectPaths` yields an empty list and the
   check has nothing to test. If that pin ever fails, this claim is the first
   thing to re-examine.

4. **"Nothing supplies it today."** The honest counterpart to claim 1: it is a
   claim about what is NOT enforced. `packages/crosssession/src/main.ts`
   constructs the tools without `visible` or `getSettings`, and the satellite
   has no other call site; the seams' behaviour is exercised only by that
   package's own tests, which supply them deliberately so they cannot rot.

- **What did NOT change:** the entry format, the refusal codes and their messages, the staleness policy, the cooperative-handle model, and the fact that every mutating call rides the host's guarded registration path — read-only mode, the serialized write queue, the journal, the kernel arguments and the record-immutability check all still bind, because an external mutating tool registers at the same interception point as a built-in.
- The guard would prefix-match a bare uid as if it were a path and refuse every uid-addressed call under an allowlist — exactly the bug the host fixed by renaming its scheme-write `to` → `to_address` *away* from a path key, an address string not being a path.
- On that point the host's `RECORD_EXEMPT_OPS` was re-examined at S6 and deliberately **not** widened: the post tool always ran inside the kernel — as a module tool it registered through the same guard-patched registrar a published tool now uses — and it is unreachable by the record check on *arguments*, which the extraction did not change.
- Nothing supplies it today — a satellite cannot reach the host's guard settings — and a `vault-mcp-api` that can carry the caller's scope to a publisher would light it up with no code change.


Orphan purge (2026-08-23): the allowlist→docs direction was added to
docs-drift.test.mjs (fourteenth instance — the old "no dead entries" title
promised orphan coverage its code never ran), and its first run found the
entries below the docs had outgrown: sentences from the pre-corpus README /
docs family that PR #340 replaced, plus spans reworded by the coherence-fix
pass. Each was a standing pre-approval for a sentence nobody has written —
exempt-forever if ever re-written. Deleted rather than kept: an approval
belongs to a living sentence. (Count: see the purge commit.)

## Known-overstated (tracked, not approved-as-true)

Entries here are NOT approved as currently-true claims — they are the design's stated goal/
contract for the accept-forbidden guard, in `docs/acceptance-model.md`'s own voice, at a point
in that document that precedes its (extensive, honest) enumeration of exactly where the guard
doesn't yet reach. Forcing them into the normal "approved" section above would be the same
laundering #152 exists to stop, just moved into the allowlist instead of the doc. Forcing a
rewrite of the document's opening thesis every time a new residual is filed would fight the
document's own structure (state the invariant, then rigorously name every exception below it).

This section exists so the allowlist doesn't have to lie about these either way. An entry here
still makes the check pass (a human reviewed it and judged the doc's surrounding honesty
sufficient) — it is a different epistemic status from the sections above, not a bypass.

Format: the exact span text, then an indented (non-bulleted, so it isn't itself matched as an
entry) `tracked by:` line naming the open issues that currently falsify it as a bare claim.
When all tracking issues close, promote the entry to a normal approved section (or re-verify
and narrow it) — this list is not meant to be permanent.

- What it may **never** do is declare that a change has been **accepted**.
  tracked by: #137, #105, #107 — templated note creation and CLI flag-form arguments can
  currently introduce acceptance without the guard seeing it. (#153, the CLI escape-
  reconstruction gap, is NARROWED but still open — the content path now decides over a
  bracketed reading set, but the binary's true escape vocabulary is unobserved and a residual
  remains, tracked in #153.)
- And — the part that makes it a *guarantee* rather than a *convention* — an agent cannot smuggle acceptance in as **data** either, by writing `acceptance-status: accepted` (or `accepted-by`, `accepted-on`) into a note's frontmatter.
  tracked by: #137, #105, #107 (same residuals as above — this is the same claim restated).
- The guarantee is enforced at the **shared write primitive** — the single point every filesystem-expressible write routes through — so it holds on **every write surface at once**, not tool by tool.
  tracked by: #105, #109 — `obsidian_create_note_from_template`, `fileclass_insert_fields`,
  and `append_at_heading` do not route through the shared primitive today (confirmed by
  reading their registration sites, 2026-08-10).
- The guard lives at the shared primitive in `obsidian-backend.ts`, which every filesystem-expressible write tool routes through.
  tracked by: #105, #109 (same routing gap as above — this is the same claim restated).
- The value of the model is that "an agent cannot accept" is not a rule an agent is *asked* to follow — it is a property the kernel *enforces*.
  tracked by: #137, #105, #107 (same residuals as the opening claim).
- An agent that has never heard of the acceptance model, or one actively trying to forge acceptance, hits the same wall: the write is refused before it lands.
  tracked by: #137, #105, #107 — for these specific paths, the write is not currently refused.

## docs/bases.md + docs/vocabulary-module.md (S7 read-tier extraction)

Two spans, one claim in two documents: that after S7 the enforced allowlist
boundary is the HOST's rather than the satellite's, and that the host's gate
decides per call from the arguments the call actually carries.

Substantiated, and deliberately NARROW. The mechanism is
`packages/host/src/mcp/external-tools.ts`'s F3 branch, which reads
`if (settings.allowlist.length > 0 && collectPaths(args ?? {}).length === 0)`
— evaluated inside the registered handler, on the ARGUMENTS object, not on the
declared schema. So "the arguments a call actually carries" is the literal
behaviour, and it is why the two documents go on to state a per-tool (and, for
`vaultmcp_vocab_resolve_term`, a per-CALL) posture instead of one blanket rule.
The "a satellite cannot reach the host's guard settings" half is a statement
about what is NOT wired: `vault-mcp-api`'s publishing contract carries no
caller scope at apiVersion 1, which is why both packages keep `ctx.visible` /
`ctx.getSettings` as dormant seams with tests that supply them. Pinned on the
satellite side by each package's `publication` test block (which asserts what
its own argument names are, against a SNAPSHOT of the host's `PATH_KEYS` held
as data in `tests/host-shim.mjs` — a review aid, explicitly not a live
tripwire), and on the host side by `tests/guard.test.mjs`'s pin over the live
`collectPaths` and by `tests/external-tools.test.mjs`.

What these spans do NOT assert, and both documents say so in the surrounding
prose rather than leaving it to the reader: that the extraction made every
tool stricter. It did not. `docs/bases.md` records that the row filter and
`some_rows_hidden` are now dormant, so a query on a visible base can return
rows naming notes outside the allowlist; `docs/vocabulary-module.md` records
the bounded disclosure the two still-reachable vocab tools retain. Both name
the apiVersion-2 seam that would close them. Agent-classified during S7;
pending the operator's review like every other span in this file.

- **Since S7 the enforced boundary is the HOST's, because a satellite cannot reach the host's guard settings.** The host's gate tests the arguments a call actually carries, so the two tools land differently and the difference matters:
- The enforced boundary is now the HOST's, because a satellite cannot reach the host's guard settings, and the host's gate tests the arguments a call actually carries.

## docs/suite-split-design.md (mutating-tier extraction)

- With no argument in `PATH_KEYS` all three see an empty path list on every call in the tier, so a `record: true` note is no longer protected from `vaultmcp_fileclass_set` or `vaultmcp_jd_scaffold_reindex_category` by that kernel check, a foreign scope claim covering the note is no longer disclosed, and the journal names no target path except where a handler reports `filesChanged`/`files` as effects.
  approved at the mutating-tier extraction: this is a DISCLOSURE of a reduction, not a safety claim — the class of sentence this control exists to make sure gets written rather than omitted. It is mechanically checkable in one place: `collectPaths` (packages/host/src/guard.ts) is the single walker that feeds the allowlist check, `recordImmutableRefusal`, `locks.coveringAny` and the journal's `target.path`. The `filesChanged`/`files` carve-out is the `reportedEffects` convention in mcp/guarded.ts, which the jd-scaffold and provenance write handlers do return.
  NOTE UPDATED 2026-09-07 (mutating-tier rounds 1 and 2): the sentence describes the state AT THE EXTRACTION and the paragraph it sits in now carries a dated bracket saying so — it is kept because it is the argument that made round 1 correct, not because it still describes shipped behaviour. What is true now: `note_path` IS in `collectPaths`' key list (round 1), so those three kernel checks are live for the tier's MUTATING note-naming tools (`vaultmcp_fileclass_set`, `vaultmcp_jd_scaffold_promote_to_folder`, `vaultmcp_jd_scaffold_reindex_category`), which is exactly the reduction this sentence warned about being closed. Round 2 then moved the tier's READS (`vaultmcp_fileclass_explain` / `_get`, `vaultmcp_provenance_check`) to a non-key spelling (`note`), because those checks bind at the mutating dequeue and buy a read nothing. **So the old note's claim that "the satellites' `publication` tests pin that none of their arguments is in its key list" is NO LONGER TRUE and has been removed from this entry** — those tests now pin WHICH arguments are keys (fileclass: `set` only; provenance: none; jd-scaffold: `promote_to_folder` + `reindex_category`), and the host-side pins are `tests/guard.test.mjs`'s two `collectPaths` cases for `note_path` (collects) and `note` (does not).


- For provenance and JD scaffolding it is strictly stricter than the module was, and that is the point: keeping `path` would have handed the guard one argument while the work reached further — provenance's freshness answer names every path the checked note's `derived-from` globs resolve to, JD promote-to-folder writes to destinations the plan COMPUTES and no argument names, and JD reindex reads every sibling index file vault-wide at the area and system tiers.
  approved at the mutating-tier extraction: every clause is a statement about ARGUMENT NAMES and about code that moved in this same change, and each half is pinned on the side that owns it. "Strictly stricter" is the host's F3 gate (`packages/host/src/mcp/external-tools.ts`) applied to specs that carry no key in `collectPaths`' list. The three blast-radius clauses describe the code as extracted: provenance's check returns a resolved `sources` list, JD promote-to-folder computes `folderPath`/`newFilePath` from the note path, and JD reindex fetches every `isIndexFilePath` sibling at the area/system tiers. It is a claim about what the boundary now refuses, not a claim that anything is unreachable.
  NOTE UPDATED 2026-09-07 (mutating-tier rounds 1 and 2): the sentence is a COUNTERFACTUAL — what keeping `path` would have done — and all three blast-radius clauses are still exactly true of the code, so the span stands. Its framing ("strictly stricter … keeping `path` would have handed the guard one argument") no longer describes the whole tier, and the paragraph it sits in now ends with a dated bracket that says which surfaces ship refused and which ship scoped. Concretely: provenance's `check` IS pathless as this sentence assumes (argument `note`), so its clause holds unchanged; JD promote-to-folder and JD reindex are now path-keyed (`note_path`) and scoped per-path, so for those two the guard really was handed one argument while the work reaches further — a state accepted on the record rather than avoided, with reindex's vault-wide sibling read named as the ratified residual. **The old note's claim that this is "pinned by each satellite's `publication` test ('NOT ONE argument is a host path key')" is NO LONGER TRUE and has been removed**: those tests now pin which arguments are keys, per tool.

## docs/suite-split-design.md (mutating-tier rounds 1 and 2, 2026-09-07)

Two spans from the dated bracket appended to the mutating-tier finding after
an independent review of round 1. Neither is a safety GUARANTEE: the first is
a decision record that discloses an accepted residual, the second is an
honest-limits statement about what the guard does not cover. Both are the
class of sentence this control exists to make sure gets written rather than
omitted, and both are checkable against code that exists.

- **This was weighed and ACCEPTED, not overlooked.** Accepted because the kernel protection it buys is live on every vault regardless of allowlist, while the leak requires an allowlist and the operator's allowlist is empty; and because the reversal is one word (`note_path` → `note` on that tool), which restores F3's refuse-all at the cost of the record guard on the note it rewrites.
  approved 2026-09-07 (round 2): a DISCLOSURE of a residual plus its reversal cost, not a claim
  that anything is protected. Each clause is mechanically checkable. "Live on every vault
  regardless of allowlist" — `recordImmutableRefusal`, `locks.coveringAny` and the journal's
  `target.path` all run at the mutating dequeue with no allowlist condition (packages/host/src/
  kernel/*), and `note_path` is in `collectPaths`' key list, pinned by tests/guard.test.mjs.
  "The leak requires an allowlist" — the sibling read is bounded only by `visiblePathsOf`, which
  is a no-op with no allowlist (`packages/jd-scaffold/src/tools.ts`, and the satellite supplies
  no `getSettings` at all, pinned by that package's dormant-seam tests). "The reversal is one
  word" — flipping the argument name off `PATH_KEYS` is what F3 reads; the jd-scaffold
  `publication` pin fails immediately on that edit, mutation-verified. The operator's-allowlist-
  is-empty half is a statement about this vault's configuration, not about the code.
- `vaultmcp_jd_scaffold_promote_to_folder`'s COMPUTED destinations are a different and already-documented class: discovered writes the argument-derived guard never sees, the `obsidian_repoint_link` boundary, mitigated by the `filesChanged`/`files` effects report.
  approved 2026-09-07 (round 2): an honest-limits claim — it states what the guard does NOT
  cover, so it cannot fail in the dangerous direction. Substantiated: `planPromoteToFolder`
  derives `folderPath` / `newFilePath` from the note path inside the handler, so neither is a
  call argument and `collectPaths` cannot see them; the named precedent is the shipped repoint
  containment recorded in packages/host/CLAUDE.md and docs/operation-contract.md ("The guard
  does not cover direct disk writes or every discovered side effect", already tracked in this
  file); and the mitigation is the `reportedEffects` convention in mcp/guarded.ts, which that
  handler returns as `filesChanged: 2` / `files: [folderPath, newFilePath]`, pinned by the
  package's promote tests.

## docs/modules.md (mutating-tier rounds 1 and 2, 2026-09-07)

One span: the per-tool restatement of the tier's allowlist posture, replacing
the extraction's "blocks each of them wholesale", which round 1 made false.

- And their scoping is now the host's to enforce, which since 2026-09-07 splits by tool rather than by surface: a tool that MUTATES the note it names spells the argument `note_path`, which the host recognizes, so an active path allowlist scopes it per-path and the kernel's record guard, lock consult and journal target see that note; every other tool — the reads that name a note, and everything that names none — carries no recognized key, so the host blocks it outright rather than scoping one argument while the work reaches further.
  approved 2026-09-07 (round 2): a CORRECTION of a claim this file previously carried in its
  stronger, now-false form — the class of edit this control exists to force rather than to
  block. Every clause is about argument names and is pinned on both sides. `note_path` is in
  `PATH_KEYS` and `note` is not: two live `collectPaths` cases in tests/guard.test.mjs. The
  three kernel consumers of that same list are `recordImmutableRefusal`, `locks.coveringAny`
  and the journal's `target.path`, all in packages/host/src/kernel/ and all reached from the
  mutating dequeue with no allowlist condition. Which tools carry which spelling is pinned per
  package by each satellite's `publication` test (fileclass: `set` only; provenance: none;
  jd-scaffold: `promote_to_folder` + `reindex_category`), each mutation-verified by flipping an
  argument name and watching the pin fail. The "blocks it outright" half is the host's F3 branch
  in mcp/external-tools.ts, pinned by tests/external-tools.test.mjs. What the sentence does NOT
  assert, and the package READMEs say so in place: that scoping the named note bounds
  everything a scoped tool touches — jd-scaffold's reindex reads siblings its argument cannot
  scope, an accepted residual recorded in docs/suite-split-design.md.

## docs/provenance.md (mutating-tier extraction)

- That last one is a scoping decision, not a spelling one: `path` is a key the host's guard recognizes, so keeping it would have let a session under a path allowlist run `check` scoped to the note it names — while the answer still lists every path that note's `derived-from` globs resolve to, including files the session cannot see.
  approved at the mutating-tier extraction, NOTE UPDATED 2026-09-07 (rounds 1 and 2): a claim about ARGUMENT NAMES and about a result shape, both checkable in one place each. `path` is in `PATH_KEYS` (packages/host/src/guard.ts), which is what the sentence asserts, and `check`'s argument is NOT — the spelling that keeps it out is now `note` rather than `note_path`, because `note_path` itself joined `PATH_KEYS` at round 1 for the tier's MUTATING tools and round 2 moved the reads to a third spelling. **The old note read "`note_path` is not [in PATH_KEYS]"; that is now false and has been corrected here.** Pinned on the host side by two live `collectPaths` cases in tests/guard.test.mjs (`note_path` collects, `note` does not) and on the satellite side by packages/provenance's `publication` test, whose vacuity guard asserts `path` and `note_path` ARE keys while `note` is not. The `sources` list is `checkFreshness`' resolved source set, returned verbatim by the check handler and unfiltered by anything (the satellite has no allowlist to filter by). It states what the old spelling would have permitted, not that the new one guarantees anything further.

## Imported documentation corpus (2026-08-23) — tracked, not approved-as-true, PENDING OPERATOR REVIEW

The 2026-08-23 documentation migration (PR #340, executed on the operator's
go) landed the target-state corpus, importing 48 flagged spans at once. Per
this file's own rule, an entry means a HUMAN reviewed the sentence — so be
explicit about what these entries are instead: they were classified by the
migration session (agent), each with its evidence note below, and they are
tracked here so the check tells the truth rather than being widened or
bypassed. NONE is approved-as-true by a human yet. The operator's
span-by-span review pass is the named follow-up: promote entries whose note
says "substantiated" (after checking the named pins), and leave the
gate-tracked ones here until their gate ships. The corpus-level honesty
anchor for every target-state claim is docs/status-and-compatibility.md
§ Current release state.

- An agent may accept a bounded delegation, but acceptance and admission remain outside every agent surface.
  tracked by: Gate 2 (mandates) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. The acceptance/admission-outside-agent-surface half is substantiated by the perimeter suites. [docs/README.md:51]
- portable standing begins prospectively; legacy acceptance imports as evidence, never fabricated signed authority;
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. The no-fabrication half is substantiated by WP8's import pins (no authority fields on evidence records). [docs/architecture.md:54]
- It cannot register a capability around the guard.
  tracked by: substantiated as of 0.17.0 — module host + guard interception-point suites (modules-mount refuses non-read-only registrations; the guard wraps every registration). Promotion to an approved section is the operator's call. [docs/architecture.md:91]
- The accepted family is a structural floor enforced at the shared write primitive and at every exceptional transport that can write content.
  tracked by: #137, #105, #107 — the same accept-guard residuals the entries above track; this is the corpus restating the claim those entries already refuse to launder. [docs/architecture.md:231]
- Mutating optional modules cannot receive a raw accept, admit, signer, mandate-activation, baseline, or standing-ref primitive.
  tracked by: substantiated as of 0.17.0 — no signer/mandate/standing-ref primitive exists to hand out, and the module host's gate refuses UNDECLARED mutating registrations (declared-mutating modules register through the guard-patched registrar with full kernel treatment; accept/baseline primitives are never in any module's context — pinned by the modules-mount suite). Promotion is the operator's call. [docs/architecture.md:264]
- They cannot weaken human acceptance or Governor-only admission.
  tracked by: substantiated as of 0.17.0 — perimeter suites (accept human-only; admission gesture-gated). Promotion is the operator's call. [docs/architecture.md:274]
- An agent cannot accept a result, activate or widen a mandate, choose an authoritative actor or signer, sign as the human, admit, revoke human authority, or advance a standing ref.
  tracked by: substantiated for what ships (admission gesture-gated, one-shot refs; accept human-only); mandate/signing verbs do not exist yet (Gates 2–3), so those clauses are vacuously true today. Promotion is the operator's call. [docs/coding-agent-development-guide.md:73]
- Sampling may supplement an audit but never establishes standing.
  tracked by: substantiated as of 0.17.0 — WP7 exact-and-total coverage pins (a failed or unevaluated item fails the cohort; sampling has no code path to standing). Promotion is the operator's call. [docs/coding-agent-development-guide.md:77]
- Private signing keys never enter notes, Git, journals, ordinary settings, release artifacts, or Sync.
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/coding-agent-development-guide.md:81]
- | `packages/host/src/mcp/guarded.ts` and other surface registration | Action registry plus surface bindings | Inventory both directions, bind every surface to a versioned action, and make raw handler reachability a build failure |
  tracked by: work-package directive (WP0/WP10 territory), not a shipped claim — the guide speaks in imperatives to its implementer. [docs/coding-agent-development-guide.md:111]
- | `governor/kernel/auto-accept/*` | Transformation registry, verifiers, and mandate policy | Reassess every class; no legacy entry receives automatic authority merely because it was previously allowlisted |
  tracked by: work-package directive (WP9 territory), not a shipped claim. [docs/coding-agent-development-guide.md:119]
- Never write note bodies to the audit journal.
  tracked by: substantiated as of 0.17.0 — kernel digestArgs pins (bodies collapse to `<N chars>`; journal suites). Promotion is the operator's call. [docs/data-flow.md:195]
- Treat every existing accepted property as standing** — lowest migration effort; vulnerable to stale, malformed, or agent-written properties and false provenance.
  tracked by: REJECTED-ALTERNATIVE text inside D04 — the register describing the option it declines, not a product claim. [docs/design-decision-register.md:225]
- A checkpoint may summarize prior segments but cannot erase revocation or provenance meaning.
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/design-decision-register.md:258]
- Configuration can extend protected properties but cannot redefine the accepted-family floor.
  tracked by: substantiated as of 0.17.0 — the accepted-family floor is fixed in code (`acceptForbiddenReason` in packages/core accept-guard.ts — "THE FLOOR IS NOT CONFIG"; `normalizeProtectedProperties` drops floor keys loudly); protected-properties config extends, never replaces (pinned). Promotion is the operator's call. [docs/developer-guide.md:113]
- Cohorts use canonical manifests and exact digests; mutable queries never become acceptance subjects.
  tracked by: substantiated as of 0.17.0 — WP7a freeze pins (immutable exact manifests; a drifted cohort refuses). Promotion is the operator's call. [docs/developer-guide.md:131]
- The target suite retains these because they support durable principles, not because every existing default or document is accepted unchanged.
  tracked by: meta-statement about the documentation itself, not a runtime security claim. [docs/documentation-basis.md:104]
- The assistant cannot press Accept, admit the result, or forge the records that represent standing.
  tracked by: substantiated as of 0.17.0 for the shipped surface (no agent-reachable accept; admission gesture-gated; claims carry no caller-forgeable verification) — the page's surrounding walkthrough is target-state, see its banner. [docs/getting-started.md:150]
- Git author and committer strings are never treated as authentication or acceptance.
  tracked by: substantiated as of 0.17.0 — nothing reads commit author strings for authority; admission binds gate-minted gestureRefs (D08 suites). Promotion is the operator's call. [docs/git-and-sync.md:25]
- never auto-accepts a merged conflict;
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. No merge path exists in 0.17.0, so the claim is vacuously true today. [docs/git-and-sync.md:125]
- Every path-taking operation accepts vault-relative paths and may accept registered stable or scheme addresses.
  tracked by: substantiated as of 0.17.0 — uid:/jd: addressing binds at the shared interception point (mapPaths suites). Promotion is the operator's call. [docs/operation-contract.md:62]
- A session, collection, folder, or query may select items, but cannot remain the mutable subject of an acceptance.
  tracked by: substantiated as of 0.17.0 — WP7a freeze pins. Promotion is the operator's call. [docs/operation-contract.md:178]
- The accepted family and Governor authority state are always protected.
  tracked by: #137, #105, #107 — the same accept-guard residuals the entries above track; this is the corpus restating the claim those entries already refuse to launder. [docs/operation-contract.md:213]
- The guard does not cover direct disk writes or every discovered side effect.
  tracked by: an honest-limits claim (states what the guard does NOT cover) — consistent with the shipped repoint-containment and record-immutability boundaries. [docs/operation-contract.md:221]
- Journal status never substitutes for live verification.
  tracked by: substantiated as of 0.17.0 — verification runs at admission; degraded receipts say what was not written. Promotion is the operator's call. [docs/receipts-and-errors.md:147]
- It cannot accept or admit its own work, enlarge its mandate, or choose the evidence that makes an out-of-policy result authoritative.
  tracked by: substantiated for what ships (accept human-only; admit gesture-gated; service-run verification); mandate clauses are Gate 2. See also the residual-tracked entries above. [docs/review-and-safety.md:7]
- Acceptance is always a human authority act.
  tracked by: #137, #105, #107 — the same accept-guard residuals the entries above track; this is the corpus restating the claim those entries already refuse to launder. [docs/review-and-safety.md:9]
- Configuration may extend the protected set but cannot weaken the acceptance floor.
  tracked by: substantiated as of 0.17.0 — same floor pin as docs/developer-guide.md:113. Promotion is the operator's call. [docs/review-and-safety.md:172]
- An agent cannot interpret continued conversation, silence, or prior approval as acceptance of a changed mandate.
  tracked by: Gate 2 (mandates) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/sessions-mandates-and-cohorts.md:72]
- An agent never accepts its own work.
  tracked by: #137, #105, #107 — the same accept-guard residuals the entries above track; this is the corpus restating the claim those entries already refuse to launder. [docs/sessions-mandates-and-cohorts.md:135]
- “Accept all” never means future work and never means every pending item in an evolving query.
  tracked by: substantiated in kernel terms as of 0.17.0 (cohorts freeze to exact manifests; a changed member refuses) — the session-accept UI framing is target-state (Gate 2). [docs/sessions-mandates-and-cohorts.md:153]
- | Takes effect | After a human accepts the mandate; never retroactively |
  tracked by: Gate 2 (mandates) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/settings.md:205]
- A journal-write failure never turns a completed vault mutation into a failure response.
  tracked by: substantiated as of 0.17.0 — journal failures are swallowed and never fail the vault operation (kernel suites). Promotion is the operator's call. [docs/settings.md:303]
- A later checkpoint may summarize earlier segments but cannot erase revocation or provenance meaning.
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/standing-and-attestations.md:216]
- Each authorized device or verifier role has its own private signing key in operating-system protected secret storage; private keys never enter notes, Git, journals, ordinary settings, or Obsidian Sync.
  tracked by: Gate 3 (signing / portable standing / Sync replicas) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/standing-and-attestations.md:220]
- | Human review, cohorts, mandates, and acceptance | Public default in-app surface | Acceptance never exposed to agents; prospective authority remains exact and bounded.
  tracked by: a row of the page's own TARGET-STATE product matrix, labeled as such by the table it sits in. Reworded at S3c (2026-09-08): the row gained a clause naming the governance provider as a separate plugin, which split the cell into two spans; the second carries no invariant word and is not tracked here. The claim itself is unchanged. [docs/status-and-compatibility.md:44]
- Every module surface binds a registered action through the shared operation executor; no module receives raw accept or baseline authority.
  tracked by: a contradiction-register resolution describing target architecture, labeled 'Resolved in target architecture' in place. [docs/status-and-compatibility.md:141]
- **Earlier target claim:** Every proposal required a contemporaneous individual human acceptance gesture.
  tracked by: HISTORICAL quote inside contradiction C-007 — the register quoting the earlier claim it corrects. [docs/status-and-compatibility.md:147]
- **Controls:** opaque command and code execution absent from the public surface; dynamic templates fail closed where output cannot be inspected; private packs require separate enablement and audit.
  tracked by: mixed shipped/target controls list — the shipped subset (no public code execution, allowlists, read-only default) is substantiated; verifier/mandate clauses are Gates 2–3. [docs/threat-model.md:153]
- | Acceptance and protected-property floor | Fail closed: refuse the write when honored bytes cannot be inspected |
  tracked by: the accept-guard's fail-closed posture ships (unreadable bytes refuse); the row's full mitigation table is target-labeled. [docs/threat-model.md:257]
- You accept the final mandate in Obsidian; the agent cannot broaden it later.
  tracked by: Gate 2 (mandates) per docs/status-and-compatibility.md § Current release state — target-state, not shipped in 0.17.0. [docs/user-guide.md:103]
- “Accept this session” always freezes and displays the exact current items.
  tracked by: the freeze semantics are substantiated (WP7a/WP7b pins: exact manifests, drift refuses); the session-accept UI is target-state (Gate 2). [docs/user-guide.md:134]
- It never accepts future session work. “Accept this collection” means the exact cohort currently selected from the collection, not every note that may later enter it.
  tracked by: the freeze semantics are substantiated (WP7a/WP7b pins: exact manifests, drift refuses); the session-accept UI is target-state (Gate 2). [docs/user-guide.md:134]
- **Cohort** — Governor verifies every item and you accept the frozen set once.
  tracked by: substantiated as of 0.17.0 — WP7b cohort admission (service verifies every item; one gesture, one claim; pinned). Promotion is the operator's call. [docs/user-guide.md:167]
- It cannot accept its own proposal, expand its mandate, choose its authoritative identity, or manufacture standing.
  tracked by: the accept/admit/standing clauses are substantiated (perimeter + one-shot gestureRef pins); mandate/identity clauses are Gates 2–3. [README.md:48]
- **Acceptance is always a human authority act.** You may exercise it over one result, one frozen cohort, or prospectively through a bounded mandate.
  tracked by: #137, #105, #107 — the same accept-guard residuals the entries above track; this is the corpus restating the claim those entries already refuse to launder. The cohort half ships (WP7b); the prospective-mandate half is Gate 2. [README.md:50]
- Governor cannot determine whether a judgment-bearing edit is substantively correct; it can make the edit legible and keep acceptance human.
  tracked by: an honest-limits claim — states what Governor cannot do; no implementation could falsify it in the dangerous direction. [README.md:166]

The three entries below were added 2026-08-23 by the coherence-audit fix pass
(NOT part of the original import): the module-system C-006 alignment and the
install-id path correction reworded flagged sentences, and per this file's
own rule a changed span is a new claim. Same epistemic status as the rest of
this section — agent-classified, tracked, pending the operator's review. The
count pin in docs-drift.test.mjs was bumped 48 → 51 consciously for these.

- Every journal record's `actor.server` carries a persistent **install id** — minted once and kept beside the journal in `.obsidian/plugins/vault-mcp/install-id.json` (`packages/host/src/kernel/install-id.ts`) — plus the **vault name** and host plugin **version**.
  tracked by: substantiated as of 0.17.0 — install-id.ts loadInstallId + its suite (persistent id beside the journal; ephemeral fallback); this is the previously-approved span with the file extension corrected .js → .ts. Promotion is the operator's call. [docs/kernel-v0.md]
- The only registrar a module holds is the wrapped `scoped` registrar, which runs the forbidden-name + collision + gate checks before forwarding — a module cannot walk it to a raw `registerTool` or to any accept surface.
  tracked by: substantiated as of 0.17.0 — modules-mount suite (gate + forbidden-name + collision pins) and registration-surface-sealed suite (every SDK registration method patched or sealed). Promotion is the operator's call. [docs/module-system.md]
- A declared-mutating module's handlers can reach VAULT writes — that is what the declaration grants — but only through the guarded path with the full kernel treatment; **no mounted handler, mutating or not, can reach an accept, baseline, or standing-authority surface** (those primitives are simply never in any module's context).
  tracked by: substantiated as of 0.17.0 — modules-mount suite (declared-mutating registration rides the guard-patched registrar; host ctx pinned to getSettings+visible over Object.keys) and accept-forbidden suite. This sentence is the C-006 alignment the status page's register calls for. Promotion is the operator's call. [docs/module-system.md]
