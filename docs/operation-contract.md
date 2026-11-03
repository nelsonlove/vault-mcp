# Operation contract

This reference defines the semantics shared by Governor capabilities. Individual schemas may add stricter rules; they may not weaken this contract.

Governor is operation-centric. Tools, UI gestures, automations, modules, and internal services are surfaces onto registered actions; they are not separate execution architectures. The [Action registry](action-registry.md) owns each action's stable postcondition and policy. This document owns how one invocation proceeds.

## Core model

- An **action** declares a postcondition, allowable observations and effects, scope, authority, verification, retention, receipt, and recovery.
- An **operation** is one invocation of an action against normalized inputs and exact subjects.
- An **observation** is what Governor returned after enforcing the effective read boundary.
- An **effect** is what Governor attempted, what a handler reported, or what Governor independently observed changing; those facts remain distinct.
- A **surface** binds a caller or human gesture to an eligible action.
- A **receipt** is a projection of the resulting operation evidence.

Every invocation uses this contract. Durability is selective: ordinary plumbing may remain ephemeral, while governed observations, mutations, verification, and authority transitions produce durable evidence. See [Observations and replay](observations-and-replay.md).

## Operation lifecycle

An operation activates only the phases required by its action:

```text
received → action/surface resolved → inputs normalized → scope derived
         → observations captured → plan frozen → authority checked
         → queued → effect attempted → effect observed → verified
         → proposed → admitted → receipt produced → closed
```

A read normally closes after producing an observation. A plan closes without attempting an effect. A mutation may produce a proposal without admission. Acceptance and admission are separate authority operations with human-only and Governor-only surface bindings.

Each durable phase names the same operation id. Corrections append evidence; they do not rewrite an earlier outcome.

## Operation modes

| Mode | Examples | Public posture | Queue, Git, and journal | Preview |
|---|---|---|---|---|
| Read | Search, read, inspect links, query health | Looking only | No mutation queue; observation capture follows the action policy | Not applicable |
| Plan | Diff, dry run, computed destination | Drafting a change | No vault mutation; durable plan and supporting observations when later work may depend on it | Is the operation |
| Proposal mutation | Create, append, bounded patch, property edit, move, or rename | Proposing governed changes | Serialized, Git-recorded, and journaled | Required unless an exact safe rule waives it |
| Mandated mutation | Named transformation inside an accepted mandate | Working under a mandate | Serialized, Git-recorded, journaled, verified, and attested | The mandate and planner define the standing preview; apply still revalidates |
| High-authority or opaque | Hard delete, generic command, plugin lifecycle, arbitrary code, authority restoration | Not in public surface | Private pack contract | Separate human approval required |

Operation mode is not change class. Every proposal separately declares encoding, presentation, representation, structural, content, authority, or an explicit combination under [Change classes](change-classes.md).

## Registration and authority

Existence does not grant permission. An action is invocable through a surface only when all of these agree:

- it is eligible for the current distribution;
- its module is enabled;
- dependencies and Obsidian version are compatible;
- the connection posture admits its operation mode;
- the session is active and bound to the connection;
- any mandate admits the computed change class, transformation, scope, and budget;
- named and discovered targets remain inside scope; and
- capability-specific preconditions pass.

The action/surface pair is resolved before arguments reach an implementation handler. A raw tool name or UI callback cannot substitute for a registered action identity.

## Read boundary

Every path-taking operation accepts vault-relative paths and may accept registered stable addresses (`uid:`); the scheme-address path form (`jd:06.11`) is retired and refused. Governor resolves an address before scope enforcement so indirection cannot bypass the boundary.

Enumeration filters before reading. Counts and excerpts describe visible data only. A hidden direct target normally becomes unresolved. Operations that cannot be honestly bounded by path scope are refused while a scope is active or excluded publicly.

The same boundary applies to observations. Governor filters candidates before reading content or computing counts, backlinks, aggregates, or excerpts. A later replay remains subject to the reviewing human's current authorization even though it preserves the historical effective-scope digest.

## Observation semantics

A read operation returns an observation at one of three levels:

- **ephemeral** — no durable result;
- **evidence** — identities, source state, response digest and shape, omissions, ordering, truncation, and availability; or
- **replayable** — evidence plus the exact returned payload or its content-addressed object.

Substantive vault reads inside governed sessions are replayable by default. Low-information plumbing and navigation are ephemeral. An ephemeral observation cannot support a proposal, verification result, or admission. If later work depends on it, Governor re-observes under a sufficient durable policy before planning or execution.

An operation names the durable observations it consumed. This dependency link is part of the proposal and receipt evidence, but it does not assert that the model understood the returned material.

## Plan and dry-run semantics

A dry run performs the same validation and planning that apply would perform at that moment, but writes nothing. It must return:

- normalized targets;
- computed destinations;
- collisions and refusals;
- direct and documented side-effect scope;
- expected semantic change;
- computed change class and any escalation;
- review consequence;
- recovery route; and
- limits on how long the plan remains valid.

A dry run is not a reservation. Concurrent state may invalidate it. Apply uses a revision or re-validates the plan at execution.

Opaque operations that cannot preview are absent publicly. A private pack must require an explicit `dry_run: false`-style acknowledgement and say effects are unknown.

## Shared mutation arguments

### `session_id`

Names the durable Governor work envelope. Governor verifies that the current connection may use it. The client cannot use this field to choose its actor identity.

### `mandate_id`

Names the accepted delegation under which the operation is attempted. Governor checks the exact current mandate at execution. Omission means the result remains a proposal unless a direct human decision later admits it.

### `change_class`

The agent's claimed class or class combination. Governor recomputes or verifies it from the plan and diff. A mismatch refuses, splits, or escalates; it never silently uses the lower class.

### `if_rev`

An optimistic precondition. Apply only if the primary target's current revision matches the revision observed during the deciding read. Check it when the operation reaches the front of the queue.

Failure is a conflict and changes nothing. Multi-target operations must document whether one primary revision, per-item revisions, or a transaction token applies.

### `idempotency_key`

Retry safety for calls that returned or remain in flight. Identity includes key, action id/version, normalized arguments, and revision precondition. Reuse with a different identity is refused. (The shipped kernel-v0 identity is `(key, operation, arguments, if_rev)` — see [kernel-v0](kernel-v0.md); folding the action version into identity arrives with the registry-native execution path.)

Keys have a bounded lifetime and clear on plugin restart. An uncertain timeout is not retained as a completed identity.

### `intent`

Advisory agent-authored text recorded with the operation. It is never written into note content, trusted as authority, or used to decide idempotency. Review surfaces label it as the agent's claim.

### `capture`

A caller may request stronger observation capture when the action allows it. A caller cannot weaken the action, session, mandate, verifier, privacy, or authority policy. Governor returns the effective capture level in the receipt.

## Serialized write queue

One plugin-instance queue runs one mutation at a time across connections. Reads do not wait behind writes. Serialization prevents overlapping handlers but does not by itself prevent stale decisions; revision preconditions provide that protection.

Each operation has a finite wall-clock budget. If the budget expires, Governor stops waiting and advances the queue. Because the underlying operation may continue, the result is uncertain until re-read.

## Journal contract

Every durable mutation appends an operation record containing, when available:

- timestamp;
- registered action/version and invoking surface;
- target path, stable identity, path set, or non-path reference;
- Governor-derived actor/session/connection binding, descriptive client claim, vault, installation, and Governor version;
- reduced argument digest;
- outcome;
- handler duration and queue wait;
- prior and resulting revisions;
- actual effects for discovered-blast-radius operations;
- intent;
- advisory overlap notice;
- correction link for a late outcome; and
- session, mandate, computed change class, proposal subject, and cohort when available.

The record also names durable input observations, plan digest, attempted effects, observed effects, verification records, and recovery state when those phases apply.

Note bodies and long values are not recorded. Journal failure is reported as degraded observability but does not reverse a completed vault mutation.

Replayable observation payloads are not embedded in the reduced write journal. They live in content-addressed Governor storage under the retention and privacy rules in [Observations and replay](observations-and-replay.md); the operation record holds their ids and digests.

## Batch semantics

### Independent batch

Each item enters the shared operation path independently and receives its own operation record and result. One failure does not abort later items. The batch response contains completed and failed collections.

### One operation over many targets

The operation receives one queue slot and journal record. It must state ordering, stopping behavior, partial-state reporting, and recovery.

### Atomic transaction

May be claimed only when the implementation guarantees all-or-nothing state across the declared targets and has tests for rollback or commit. Serialization alone is not atomicity.

## Cohort semantics

A cohort is an immutable authority subject, not an execution promise. Governor freezes a canonical manifest containing every proposal item and digest, then verifies and admits that exact manifest. A session, collection, folder, or query may select items, but cannot remain the mutable subject of an acceptance.

Adding, removing, revising, or resolving a conflict in any item creates a new cohort digest and invalidates old verification for the new result.

## Content mutation

- Creation refuses an occupied target unless replacement is an explicit operation.
- Replacement reads and guards the final content that would land.
- Append verifies a strict end append when that distinction matters.
- Section patch operates on a named structural region and refuses ambiguity.
- Frontmatter uses Obsidian's supported processing API and the same protected-property transition rule as whole-note writes.
- User annotations, links, citations, and unknown properties are preserved unless the request explicitly and safely changes them.

## Structural mutation

Moves and renames use Obsidian's link-aware file manager path. They never overwrite an occupied destination. A response must not invent a backlink count that Obsidian does not expose.

Operations that compute destinations must re-check scope and occupancy at apply. A free scheme address is computed, not reserved; use an advisory claim for coordination and still refuse a race at landing.

Structural is reserved for filesystem-level change that preserves meaning and standing. If path or containment changes status, policy reach, or semantics, the proposal also carries content or authority class.

## Git transition contract

Governor records the base and proposed state in its local Git object store and links those objects to the producing operation. Proposal and session refs may advance as work is revised. Admitted standing advances only through Governor's admission operation after exact subject, observation, verification, and human authority checks.

The agent does not invoke Git, choose commit author identity, or advance refs. Git object ids provide content evidence; they do not provide acceptance.

## Verification and attestations

Class-specific verification runs as a registered operation against the frozen subject and its required durable observations and effects. The resulting attestation names its operation, subject digest, verifier identity and version, predicate type, result, coverage, and time. A passing verifier result satisfies only that predicate.

Admission requires the exact required attestations plus a direct human acceptance or valid mandate. See [Standing and attestations](standing-and-attestations.md).

## Protected properties

The accepted family and Governor authority state are always protected. A write may preserve an existing human-granted value unchanged; it may not introduce or alter admitted state, mandates, signer bindings, or standing refs. Declared protected properties may also prohibit removal.

The guard must recognize at least the frontmatter forms Obsidian will honor and must inspect the bytes that will land. If an expansion or opaque command prevents that inspection, the public operation is refused or absent.

## Records

For a named `record: true` (the default record identifier; the settings tab can name another property/value or a tag) target, every ordinary addressed mutation is refused except pure end-of-file append. The check is protective and may fail open when metadata is unreadable; the receipt or health surface must expose that degradation when known.

The guard does not cover direct disk writes or every discovered side effect. Record preservation ultimately relies on history and backups.

## External capabilities

Third-party published capabilities bind registered actions through Governor's operation executor. A claimed read-only action is treated conservatively as mutating unless the publishing plugin identity and binding are trusted. Under an active path scope, an external mutation with no recognized path argument is refused because it cannot be bounded honestly.

Trust does not change the publisher's code. It changes which guard posture Governor applies.

## Availability and degradation

Every conditional action or capability returns or publishes a typed availability reason. Missing plugin, disabled module, unsupported Obsidian version, stale index, and timeout are distinct states.

A capability may degrade only to a state that preserves its authority contract. Examples:

- unavailable read provider → typed unavailable, not empty;
- unavailable required replay storage → refuse proposal-producing, verification, and authority operations;
- unavailable optional observation storage → read may complete only with a visible degraded-capture result when policy permits;
- missing audit writer → mutation result plus degraded audit warning;
- unavailable protected-authority or admission guard → refuse the write;
- unavailable record metadata → allow with documented protective degradation;
- unscopable operation under scope → refuse;
- incomplete Sync cohort → receiving/pending, never partially admitted;
- attestation or key unavailable → remain proposed.

## Error outcomes

| Outcome | Did the intended mutation run? | Required behavior |
|---|---|---|
| Completed | Yes | Verify and return receipt |
| Refused | No | Explain guard and safe next step |
| Conflict | No | Re-read and re-plan |
| Deduplicated | The first logical call ran | Return first result and identify replay |
| Partial | Some effects landed | Name each effect; re-read before recovery |
| Uncertain | Unknown | Stop, re-read, inspect late journal correction |
| Failed | Capability-specific | State whether evidence proves nothing changed |

The canonical user form is in [Receipts and errors](receipts-and-errors.md). Registry and compatibility rules are in [Action registry](action-registry.md).
