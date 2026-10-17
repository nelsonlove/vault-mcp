# Governor documentation

This documentation is deliberately layered. You should be able to learn the public product without inheriting the private operator system, while a developer or agent integrator can still reach the exact contracts they need.

Governor today ships as two plugins: the host (`packages/host`, Obsidian plugin id `vault-mcp`, display name "Vault MCP") and the governance provider (`packages/governor`, Obsidian plugin id `governor`, display name "Governor"), both at 0.19.0. The host alone is a complete, honest product — audited, journaled, allowlist-scoped vault access, ungoverned; installing the provider turns that audited access into governed access. This split is built and not yet cut over on the operator's vault — see [the migration plan](s3c-migration-plan.md) for the cutover procedure.

> [!note]
> This corpus describes the coherent target product; it is not, by itself, a claim that a particular Governor build implements every described behavior. What IS shipped is owned by one section: [Current release state](status-and-compatibility.md#current-release-state) (Gate 1 shipped as 0.17.0–0.18.2; the authority cutover ran 2026-08-23 and the marker is bound — admission is the standing authority). [Documentation basis](documentation-basis.md) explains the evidence classes.

## Choose your path

### I am new to Obsidian and AI assistants

Read in this order:

1. [Getting started](getting-started.md)
2. [User guide](user-guide.md)
3. [Vocabulary](vocabulary.md)
4. [Review and safety](review-and-safety.md)
5. [Sessions, mandates, and cohorts](sessions-mandates-and-cohorts.md)
6. [Git, Sync, and portability](git-and-sync.md)
7. [Troubleshooting](troubleshooting.md)

You do not need the architecture or operation-contract documents.

### I already use Obsidian

Start with:

1. [Capability directory](capabilities.md)
2. [Settings](settings.md)
3. [Review and safety](review-and-safety.md)
4. [Change classes](change-classes.md)
5. [Module directory](modules.md)
6. [Privacy](../PRIVACY.md)

The capability directory explains outcomes and consequences rather than listing low-level tools.

### I am connecting or designing an agent

Read:

1. [Agent guide](agent-guide.md)
2. [Operation contract](operation-contract.md)
3. [Observations and replay](observations-and-replay.md)
4. [Sessions, mandates, and cohorts](sessions-mandates-and-cohorts.md)
5. [Change classes](change-classes.md)
6. [Standing and attestations](standing-and-attestations.md)
7. [Receipts and errors](receipts-and-errors.md)
8. [Threat model](threat-model.md)
9. [Status and compatibility](status-and-compatibility.md)

These documents are normative for agent behavior. An agent may accept a bounded delegation, but acceptance and admission remain outside every agent surface.

### I am contributing to Governor

Read:

1. [Contributing](../CONTRIBUTING.md)
2. [Architecture](architecture.md)
3. [Developer guide](developer-guide.md), with its two companions: the [design decision register](design-decision-register.md) (D01–D18, settled — never reopened in feature work) and the [coding-agent development guide](coding-agent-development-guide.md) (the work-package process; Gate 1 complete)
4. [Action registry](action-registry.md)
5. [Capability projection](capability-manifest.md)
6. [Observations and replay](observations-and-replay.md)
7. [Module directory](modules.md)
8. [Standing and attestations](standing-and-attestations.md)
9. [Git, Sync, and portability](git-and-sync.md)
10. [Testing and release](testing-and-release.md)
11. [Migration and deprecation](migration-and-deprecation.md)

### I am reviewing security or privacy

Read:

1. [Security](../SECURITY.md)
2. [Privacy](../PRIVACY.md)
3. [Threat model](threat-model.md)
4. [Data flow](data-flow.md)
5. [Operation contract](operation-contract.md)
6. [Observations and replay](observations-and-replay.md)
7. [Standing and attestations](standing-and-attestations.md)
8. [Git, Sync, and portability](git-and-sync.md)
9. [Reviewer notes](../submission/reviewer-notes.md)

### I operate the fuller private system

Read the public documents first, then:

1. [Operator guide](operator-guide.md)
2. [Advanced capability packs](advanced-capability-packs.md)
3. [Status and compatibility](status-and-compatibility.md)
4. [Migration and deprecation](migration-and-deprecation.md)

The operator layer may widen authority. It does not redefine the public safety contract.

### I am preparing or reviewing a Community Plugin submission

Use the [submission packet](../submission/community-plugin-submission.md), then review:

- [Listing copy](../submission/listing-copy.md)
- [Reviewer notes](../submission/reviewer-notes.md)
- [Release checklist](../submission/release-checklist.md)
- [Documentation basis](documentation-basis.md)

## Shipped-implementation deep references

The documents above own the concepts and the target design. The shipped implementation also carries a set of deep references — older, detailed, and accurate about behavior that exists today. Each one banners its role and defers to the owners above on any conflict.

- [Kernel v0](kernel-v0.md) — the transport-hardening kernel: write queue, journal, if_rev/idempotency, locks, uid index and addressing, record immutability
- [Tool reference](reference.md) and [Tool runner](tool-runner.md) — the full shipped tool surface
- [Agent writes](agent-writes.md) — how agent writes behave under the shipped guard
- [Acceptance model](acceptance-model.md) — **the legacy acceptance system**, the standing authority until the 2026-08-23 cutover; its writers now refuse (see its banner)
- [Review SOP](review-sop.md) — the shipped review workflow
- [Module system](module-system.md) — how capability modules register and gate (the mechanism; the [module directory](modules.md) is the inventory)
- Module deep references: [conformance](conformance.md), [scope provider](scope-provider.md), [identity and links](identity-and-links.md)
- Satellite plugin deep references: [skills](skills.md) — `vaultmcp-skills`, [triage](triage.md) — `vaultmcp-triage`, [vocabulary provider](vocabulary-module.md) — `vaultmcp-vocab`, [Bases](bases.md) — `vaultmcp-bases`, and [provenance](provenance.md) — `vaultmcp-provenance`, all extracted from the module list above per `docs/suite-split-design.md` §6. vaultmcp-crosssession was retired on 2026-10-15 (Nelson's verify of 'Retire vaultmcp-crosssession'), and its deep reference went with it. Three satellites have no deep reference of their own and their package READMEs are their documentation: the health scan (`packages/health/README.md`), the fileclass CLI proxy (`packages/fileclass/README.md`) and JD scaffolding (`packages/jd-scaffold/README.md`).
- [WP8 cutover runbook](../packages/governor/docs/wp8-cutover-runbook.md) — the operator's one-page procedure for the authority cutover

## Documentation layers

| Layer | Audience | Status |
|---|---|---|
| Public product | Ordinary Governor users | The normal Community Plugin promise |
| Optional public | Users who deliberately enable additional governed modules | Still inside the documented public boundary |
| Private operator | A supported private deployment with broader capability packs | Not a default Community Plugin promise |
| Developer and agent | Implementers and integrators | Normative technical contracts |
| Submission | Maintainers and Obsidian reviewers | Publication evidence and official requirement mapping |

## Which document owns what

| Subject | Authority |
|---|---|
| Product promise and quick orientation | [Root README](../README.md) |
| Public terms and state axes | [Vocabulary](vocabulary.md) |
| Action identity, execution, effects, and eligible surfaces | [Action registry](action-registry.md) and [Operation contract](operation-contract.md) |
| Capabilities and public eligibility | [Capability directory](capabilities.md) and generated [Capability projection](capability-manifest.md) |
| Setting defaults and consequences | [Settings](settings.md) |
| Acceptance and review behavior | [Review and safety](review-and-safety.md) |
| Change classification | [Change classes](change-classes.md) |
| Session, delegation, mandates, and cohorts | [Sessions, mandates, and cohorts](sessions-mandates-and-cohorts.md) |
| Standing, identity claims, and signed evidence | [Standing and attestations](standing-and-attestations.md) |
| Git history, Obsidian Sync, and portability | [Git, Sync, and portability](git-and-sync.md) |
| Module inventory and module contracts | [Module directory](modules.md) |
| Security assumptions and residual risk | [Threat model](threat-model.md) |
| Data categories and retention | [Privacy](../PRIVACY.md) and [Data flow](data-flow.md) |
| Agent behavior | [Agent guide](agent-guide.md) |
| Operation lifecycle, concurrency, and retry behavior | [Operation contract](operation-contract.md) |
| Observation capture, replay, and read evidence | [Observations and replay](observations-and-replay.md) |
| Receipts and errors | [Receipts and errors](receipts-and-errors.md) |
| Runtime structure | [Architecture](architecture.md) |
| Shipped, optional, private, deprecated, or excluded status | [Status and compatibility](status-and-compatibility.md) |
| Cutover and predecessor retirement | [Migration and deprecation](migration-and-deprecation.md) |
| Evidence and external standards | [Documentation basis](documentation-basis.md) |

## Reading principle

The README summarizes; it does not silently create a second contract. When two documents appear to disagree, follow the owner in the table above and record the contradiction in [Status and compatibility](status-and-compatibility.md) rather than choosing the most convenient wording.
