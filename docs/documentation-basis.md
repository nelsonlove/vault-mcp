# Documentation basis

This document explains where the Governor suite's claims come from and how a claim may become a public guarantee. It preserves the status of source material instead of flattening history, proposals, implementation, and external policy into one authority.

## This package's status

The suite is a proposed target-state documentation package produced from a multi-perspective review. Product prose intentionally reads as a coherent finished contract. That voice is a design technique, not evidence that the live repository already implements every promise.

Actual shipped status belongs to [Status and compatibility](status-and-compatibility.md) and a matching release evidence bundle.

## Source corpus

The design was grounded in:

1. *Tool map for vault-mcp* — a live served-surface inventory dated 2026-08-19.
2. *Design source and open patterns* — implementation patterns, settled rationale, open hypotheses, and explicit not-now decisions.
3. *Agent doctrine and fleet policy* — status-keyed authority and operating rules.
4. *Machinery rules and hazards* — incident-derived rules and known failure modes.
5. *Machinery principles and vocabulary* — durable principles, distinctions, vocabulary, and status models.
6. *Machinery history* — generational narrative and dated event ledger.
7. Current repository README, manifest, package metadata, architecture, kernel, acceptance, module, vocabulary, scheme, Bases, triage, coordination, and developer-operation documents.
8. The completed multi-perspective review preceding this suite.
9. The subsequent design decisions on change classes, delegated acceptance, durable sessions, collection/session cohorts, verifier attestations, Git-backed history, actor identity, Obsidian Sync compatibility, universal operations, selective observation durability, the Governor playback boundary, and incremental compatibility migration.

The five synthesis notes are marked `acceptance-status: proposed`. They are valuable design and historical evidence but are not represented here as individually ratified constitutional authority.

## Evidence classes

### Durable source principle

A repeated semantic invariant or incident-backed rule that remains useful across implementations. Examples:

- one authority for each assertion;
- path is not identity;
- presentation is not authority;
- provenance is not acceptance;
- deterministic checks should not be replaced by model judgment;
- a successful command is not proof of a successful change;
- absent capability and empty result are different; and
- migrations include decommissioning and closure.

### Current implementation evidence

Behavior documented in source, tests, live tool inventory, or observed runtime. It establishes what a particular build or session appears to do. It does not automatically establish public eligibility, safe defaults, deployed migration, or Community review compliance.

### Historical evidence

Prior behavior, incident, or design generation. It remains evidence for why a rule exists even when its implementation claim has been superseded.

### Proposed design

A target behavior not yet supported by complete release evidence. Most proportionality improvements in this suite—four postures, review budgets, action registry and generated projections, universal operations, replayable governed observations, immutable cohorts, class-specific verification, stale expiry, and narrower public distribution—begin in this class.

### External official requirement

A current rule or process from a primary official Obsidian source. It governs Community distribution but does not define Governor's internal architecture.

### Shipped public guarantee

A proposed design promoted only after implementation, manifest, bundle, runtime, tests, migration, documentation, and release evidence agree.

## Official external sources

Verified for this package on 2026-08-20:

- [Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
- [Submission requirements for plugins](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)
- [Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)
- [Manifest reference](https://docs.obsidian.md/Reference/Manifest)
- [Obsidian October plugin self-critique checklist](https://docs.obsidian.md/oo/plugin)
- [Official plugin security guidance](https://github.com/obsidianmd/obsidian-help/blob/master/en/Extending%20Obsidian/Plugin%20security.md)
- [Obsidian Sync settings and selective syncing](https://obsidian.md/help/sync/settings)
- [Obsidian local and remote vaults](https://obsidian.md/help/Obsidian%2BSync/Local%2Band%2Bremote%2Bvaults)
- [Obsidian Headless Sync](https://obsidian.md/help/sync/headless)
- [Git commit reference](https://git-scm.com/docs/git-commit)
- [in-toto Attestation Framework](https://github.com/in-toto/attestation/blob/main/spec/README.md)
- [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
- [in-toto Envelope](https://github.com/in-toto/attestation/blob/main/spec/v1/envelope.md)
- [DSSE background](https://github.com/secure-systems-lab/dsse/blob/master/background.md)

Official requirements can change. Submission material must re-open these pages immediately before release.

## Source-backed mechanisms retained in the target design

The repository and supplied records support these architectural mechanisms:

- live Obsidian application access rather than a separate Markdown-only interpretation;
- local socket plus stdio bridge;
- compact code-mode discovery over the same registry;
- read-only mode and path allowlist;
- stable identity and scheme addressing;
- single serialized write queue;
- optimistic revision preconditions;
- bounded in-memory idempotency;
- append-only reduced-argument journal;
- advisory scope claims;
- record immutability guard;
- protected acceptance family and human-only accept surface;
- in-app review pane and pending review index;
- read/report modules for schemes and conformance, plus vocabulary, health, Bases evaluation, and provenance — of which vocabulary, health and Bases became the separate `vaultmcp-vocab`, `vaultmcp-health` and `vaultmcp-bases` satellite plugins at the S7 read-tier extraction, and provenance the separate `vaultmcp-provenance` one when the mutating tier followed, and conformance the separate `vaultmcp-conformance` one on 2026-10-14;
- optional mutating triage and coordination, extracted at S5 and S6 into the separate `vaultmcp-triage` and `vaultmcp-crosssession` satellite plugins (the latter retired on 2026-10-15), and optional mutating Fileclass writes and JD scaffolding, extracted with the mutating tier into `vaultmcp-fileclass` and `vaultmcp-jd-scaffold`; and
- explicit residuals for timeouts, link-resolution oracles, opaque output, metadata failure, and third-party APIs.

The target suite retains these because they support durable principles, not because every existing default or document is accepted unchanged.

## Target-state judgments added by the review

These are professional design recommendations written as product contract in this suite:

- a narrower Community distribution than the private system;
- Looking only first, then scoped create/append, then broader preview-first work;
- exactly four public posture labels;
- one plain-language review center;
- separate development, verification, authority, record, and operational axes;
- review budgets that pause new governed work;
- consequence grouping, full-coverage standing predicates, supplementary sampling, and superseded-proposal expiry;
- one action registry plus generated capability/module projections for runtime, settings, docs, disclosures, and tests;
- standard operation, observation, effect, and mutation receipts;
- mandatory degraded-mode explanations;
- public threat model and data flow;
- migration closure as definition of done;
- controlled vocabulary retained only when an operational consumer exists;
- six semantic change classes separated from scale and consequence;
- durable Governor sessions and human-accepted bounded mandates;
- immutable review cohorts selected by session, collection, scope, and class;
- cohort acceptance and prospective mandate-based admission;
- Git as an internal history/transaction engine rather than the user or authority interface;
- in-toto/DSSE-style signed proposal, mandate, verification, admission, revocation, and effect attestations;
- Governor-derived actor identity rather than client-provided or Git author strings; and
- Sync-compatible replica reconciliation with optional portable standing;
- every invocation as an operation of a registered action, independent of its surface;
- ephemeral, evidence, and replayable observation levels, with substantive governed reads replayable by default;
- a prohibition on proposal, verification, or admission dependencies from ephemeral observations;
- playback limited to what crossed Governor's own boundary; and
- Gate 0 compatibility migration instead of a big-bang rewrite.

These must not be described as shipped until promoted through the gate below.

## Claim-promotion gate

A proposed behavior becomes a shipped public guarantee only when:

1. the action registry or appropriate settings owner declares it, and the capability projection references it;
2. implementation reaches every intended surface through the shared operation executor;
3. pure, live, adversarial, and degraded-mode evidence exists;
4. observation/effect contracts, postcondition verification, and receipt are implemented;
5. threat model, privacy, and data flow are updated;
6. migration and predecessor deactivation are closed;
7. clean-vault onboarding confirms independence from private conventions;
8. Git, session, mandate, cohort, verifier, attestation, and replica invariants pass;
9. action registry, runtime handlers, surface bindings, capability/module projections, bundle, runtime status, and documentation agree;
10. a semantic release publishes matching assets; and
11. status and compatibility promotes the claim.

Use of a proposed behavior in a private deployment does not skip this gate.

## Contradictions

When two sources conflict:

1. preserve both claims with their source and status;
2. identify whether the conflict concerns durable principle, implementation, deployment, or authority;
3. inspect current runtime and source evidence;
4. choose one target owner;
5. record migration and compatibility action; and
6. close through the contradictions register.

Examples in [Status and compatibility](status-and-compatibility.md) cover tool counts, versions, Bases readability, acceptance deployment, product naming, and module mutation rules.

Deleting the older evidence is not resolution.

## Documentation ownership

| Fact | Owner |
|---|---|
| Action identity, postcondition, observations, effects, authority, verification, recovery, eligible surfaces | Action registry |
| Capability availability, distribution, risk, dependencies, and public eligibility | Capability projection |
| Operation/observation/effect evidence and receipt fields | Operation, observation, effect, and receipt schemas |
| Settings keys and defaults | Settings schema |
| Stable errors | Error registry |
| Receipt fields | Receipt schema |
| Acceptance and review | Review center contract |
| Change classification | Change-class registry and [Change classes](change-classes.md) |
| Session, mandate, and cohort semantics | Session/mandate schemas and [Sessions, mandates, and cohorts](sessions-mandates-and-cohorts.md) |
| Signers, verification, admission, and standing | Attestation/predicate registries and [Standing and attestations](standing-and-attestations.md) |
| Git and replica behavior | Git/replica schemas and [Git, Sync, and portability](git-and-sync.md) |
| Module inventory | Module manifests and [Module directory](modules.md) |
| Security assumptions | Threat model |
| Data categories and retention | Privacy and data flow |
| Shipped/optional/private/excluded state | Status and compatibility |
| Deprecation and cutover | Migration register |
| Official submission rules | Linked primary official source |

Summaries link to these owners and may explain them. They do not become competing authorities.

## Updating this suite

An update must:

- name the evidence class of each substantive new claim;
- preserve proposed or historical status;
- update the owning document first;
- regenerate or reconcile projections;
- add contradictions rather than hiding them;
- verify official links;
- run local-link and terminology checks; and
- include a promotion or migration decision when public promises change.

This discipline allows the documentation to be candid about the present without losing the clarity of a coherent target product.
