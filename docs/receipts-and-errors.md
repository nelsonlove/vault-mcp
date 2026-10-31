# Receipts and errors

A receipt is the human-facing completion contract for an observable operation. It reports the state Governor can support, not the confidence or optimism of the assistant. Durable reads receive observation receipts; mutations and authority transitions also report their intended, attempted, and observed effects.

## Canonical receipt

```yaml
outcome: completed | refused | conflict | deduplicated | partial | uncertain | failed
operation:
  id: 01J...
  action: note.append
  actionVersion: 1
  surface: mcp
  summary: Appended one dated entry to a record.
session:
  id: 01J...
  actor: governor-bound client identity
  mandate: none
targets:
  requested:
    - uid:example-stable-id
  resolved:
    - Logs/Maintenance.md
observations:
  capture: replayable
  consumed:
    - obs:01J...
  produced:
    - obs:01J...
effects:
  intended:
    - append one exact tail to Logs/Maintenance.md
  attempted:
    - effect:01J...
  observed:
    - effect:01J...:confirmed
change:
  class: content
  semantic: Added the 2026-08-19 inspection entry at end of file.
  filesChanged: 1
proposal:
  subject: sha256:<canonical-proposal-digest>
  gitTree: <local Git tree id>
safeguards:
  posture: Proposing governed changes
  scope: Logs/
  previewed: true
  revisionChecked: true
  serialized: true
  protectedPropertiesChecked: true
  recordRule: pure end append
verification:
  status: confirmed
  evidence: Re-read matched the prior body plus the requested tail exactly once.
  attestation: sha256:<verification-envelope-digest>
review:
  state: Ready for review
  item: available in Governor review center
standing:
  state: proposed
  admission: none
uncertainty: none
recovery:
  action: Revert the proposal from the review center or restore the prior revision.
journal:
  status: recorded
  reference: local journal entry timestamp or identifier
```

The transport may represent this as structured JSON and text. Every semantic field above remains present or explicitly unavailable. A cohort receipt adds the frozen cohort id, subject digest, item coverage, exclusions, failures, and mandate utilization.

### Read observation receipt

A durable read uses the same operation identity but normally has no mutation effect. Its receipt names the action, operation, surface, resolved scope, capture level, returned observation digest, payload reference when replayable, redactions or truncation, and freshness. The user may play back the exact Governor-returned payload when it was captured replayably. An evidence-grade read preserves the claims needed for audit without necessarily preserving the full payload. An ephemeral read returns a result but cannot become a dependency of a proposal, verification, or admission.

## Receipt, verification, and attestation are different

- An **operation receipt** reports what the local attempt did.
- An **observation record** reports what Governor returned or observed at its boundary.
- A **verification attestation** records a named predicate over an exact immutable subject.
- An **admission attestation** records why that exact subject gained standing.
- An **effect receipt** records whether one replica realized or observed the result.

No one artifact substitutes for the others.

## Outcome meanings

### Completed

The operation ran and postcondition verification succeeded. This does not mean a judgment-bearing change is admitted, that every class-specific predicate passed, or that the result is substantively correct.

### Refused

A guard or policy stopped the operation before its handler ran. The receipt names the refusal and a safe next step. It must not suggest bypassing the guard.

### Conflict

The deciding revision no longer matches. Nothing was written by this call. Re-read and prepare a new plan.

### Deduplicated

Governor recognized a retry of the same logical completed or in-flight call and returned the first result without running a second mutation.

### Partial

Some declared effects completed and others did not. The receipt lists both. Do not retry the whole operation as if nothing happened.

### Uncertain

Governor stopped waiting before it could establish whether the underlying effect landed. Stop writes, re-read, and inspect later journal correction before acting.

### Failed

An operation failed outside a more precise class. The receipt must state whether evidence proves no mutation occurred. If it cannot, use uncertain instead.

## Verification status

| Status | Meaning |
|---|---|
| confirmed | Live re-read or equivalent host evidence matches the postcondition |
| contradicted | Live state differs from the intended postcondition |
| partial | Some postconditions match |
| unavailable | Verification source is unavailable; outcome cannot be called completed |
| not applicable | Pure state mutation such as an advisory claim, with its own observable result |
| stale | The attested subject no longer matches current content or policy |

## Standing status

| Status | Meaning |
|---|---|
| proposed | Exact subject exists without admission |
| awaiting-verification | Required predicate has not completed |
| ready-for-review | Required evidence is current and a human decision remains |
| admitted | Exact subject has standing under direct acceptance or a valid mandate |
| receiving | A synced replica lacks one or more exact subjects or attestations |
| conflicted | Current bytes no longer match the admitted subject |
| superseded | Later admitted subject replaced this one |
| revoked | Human or authorized policy removed its standing |

## Journal status

- **recorded** — an audit entry was appended;
- **deduplicated** — the replay entry identifies the first record;
- **degraded** — the mutation result exists but journal append failed or could not be verified;
- **not applicable** — an explicitly ephemeral read created no durable operation record.

Journal status never substitutes for live verification.

## Error classes

Stable identifiers belong to the runtime error registry. The exact set may grow, but the user behavior follows these classes.

| Class | Typical identifiers | Changed anything? | Required next action |
|---|---|---|---|
| Posture | `read_only`, `capability_disabled` | No | Preview or ask the human to enable the smallest posture |
| Scope | `out_of_allowlist`, `invalid_scope` | No | Correct or narrow the target; human may revise scope |
| Identity | `uid_unresolved`, `uid_ambiguous` | No | Resolve identity; never guess among candidates |
| Identity | `scheme_ref_retired` | No | Name the note by its path or `uid:`; look an address up with `obsidian_resolve_address` |
| Collision | `destination_occupied`, `already_exists` | No | Inspect occupant and prepare a new plan |
| Concurrency | `rev_conflict` | No | Re-read and re-plan |
| Integrity | `truncated_read` | No | The content is a cut read of a note longer than the read limit; edit the note by anchor within the read limit; never write the cut read back; for a whole rewrite, read the note whole first (`obsidian_read_note` with `full: true`) and write within ten minutes on the same connection with that read's rev |
| Retry identity | `idempotency_mismatch` | No second mutation | Use original arguments for a true retry or a new key for new work |
| Timeout | `write_timeout`, `base_timeout` | Write timeout uncertain; read timeout no mutation | Re-read writes; retry reads when safe |
| Authority | `accept_forbidden`, `protected_property` | No | Route acceptance/property decision to the human surface |
| Mandate | `mandate_missing`, `mandate_expired`, `mandate_scope`, `mandate_class`, `mandate_budget` | No new admitted effect | Narrow the work or obtain a new human-accepted mandate |
| Verification | `verification_failed`, `verification_incomplete`, `attestation_stale`, `untrusted_verifier` | Proposal may exist | Inspect findings; revise or route to human review |
| Sync/replica | `cohort_receiving`, `sync_subject_conflict` | Files may be present; standing not advanced | Wait for complete arrival or reconcile and reverify |
| Record | `record_immutable` | No | Use pure dated append or exceptional human recovery |
| Dependency | `bases_unavailable`, `plugin_unavailable`, `index_not_published` | No | Enable/update dependency or use a documented alternative |
| Opaque policy | `cli_denied`, `operation_excluded` | No | Use a bounded public capability or separately governed private pack |
| Batch | per-item errors | Some items may have changed | Inspect each result and re-read |
| Journal | `journal_degraded` | Vault mutation may have completed | Decide whether to stop under degraded audit |

## Error-message requirements

An error message must state:

- stable identifier;
- what Governor refused or could not establish;
- whether any mutation ran;
- target or scope in a safely discloseable form;
- which setting, dependency, or precondition matters;
- a safe next action; and
- whether re-read is required.

Bad:

```text
Operation failed.
```

Good:

```text
Error [rev_conflict]: The note changed after the preview. Nothing was written by this call.
Re-read the note and prepare a new preview; do not remove the revision check.
```

## User-facing receipt prose

Lead with the outcome:

> Completed: appended one dated entry to `Logs/Maintenance.md` in session `01J…`. Governor confirmed the previous content was unchanged and the new entry appears once. The content-class proposal remains Ready for review and has not been admitted. You can revert it from the review center; Git history, verification, and journal evidence are available.

For uncertainty:

> Uncertain: Governor stopped waiting for the move after 30 seconds. The destination may already exist and the source may already be absent. I have not retried. I will re-read both paths and inspect the corrective journal outcome before proposing recovery.

## What a receipt must never say

- “Safe” merely because a guard ran.
- “No changes” when the operation timed out after dispatch.
- “Accepted” because the write succeeded.
- “Verified” without naming the subject, predicate, verifier, and coverage.
- “Authorized” because the agent supplied a mandate id or Git author name.
- “Accepted this session” when the frozen cohort digest is absent.
- “Zero” when the source was unavailable.
- “All links updated: 0” when the host did not expose a count.
- “Atomic” for a serialized or sequential batch.
- “Undo available” without naming the actual recovery route.

Receipts are a discipline against plausible but unsupported success stories.
