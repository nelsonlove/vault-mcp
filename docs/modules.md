# Module directory

Governor's modules package bounded registered actions behind the same operation, scope, session, mandate, observation, verification, evidence, and receipt boundary as the core. A module is not trusted merely because it is installed, and an enabled module is not necessarily available.

This directory covers every current module family and the important cross-cutting surfaces already present in the repository. Runtime and documentation projections should be generated from each module's manifest so this list cannot drift from registration.

## Availability vocabulary

For every module distinguish:

- **present** — code exists in this build;
- **enabled** — the human turned it on;
- **compatible** — its Obsidian and plugin dependencies match;
- **available** — it can serve the current connection and scope now;
- **healthy** — its last check succeeded; and
- **last successful** — it has completed a real operation at a recorded time.

Absent, disabled, incompatible, unavailable, unhealthy, and empty are different results.

## Built-in module families

| Module | User outcome | Mutation posture | Target default | Important boundary |
|---|---|---|---|---|
| **Scheme** | Resolve, validate, allocate, and place notes under configured addressing systems | Reads by default; placement and renumbering are preview-first structural work | Enabled for resolution; mutating actions separately authorized | An open address is computed, not reserved; exclusions bound the scheme, not vault access |
| **Vocabulary** (satellite `vaultmcp-vocab` since S7) | Resolve controlled values and validate their scoped use in configured properties, tags, or designated fields | Report-first; repairs are separate representation or content proposals | Enabled when configured | It does not police arbitrary prose; unseeded or unavailable vocabulary is not a clean bill of health |
| **Provenance** (satellite `vaultmcp-provenance` since the mutating-tier extraction) | Inspect source relationships, freshness, reconcile generated artifacts, and regenerate them | Reports are read-only; regeneration is representation/content work | Disabled | Provenance is not acceptance; stale source must not be reported as current output |
| **Health** (satellite `vaultmcp-health` since S7) | Run whole-vault or scoped health and lint reports | Read/report | Disabled opt-in for potentially expensive scans | Findings are evidence, not automatic repair instructions |
| **Fileclass** (satellite `vaultmcp-fileclass` since the mutating-tier extraction) | Inspect and apply note-class schemas | Reads may be enabled; writes are representation/content work | Disabled | Depends on supported Fileclass surface; missing dependency is unavailable, not empty |
| **Bases** (satellite `vaultmcp-bases` since S7) | Evaluate Obsidian Base views and return scoped rows | Read-only | Enabled when supported API exists | Base is presentation, not authority; evaluated rows come from Obsidian's engine |
| **JD scaffolding** (satellite `vaultmcp-jd-scaffold` since the mutating-tier extraction) | Create and maintain configured Johnny Decimal structures and identifiers | Structural and representation work | Disabled | Exact templates and scopes required; allocation and placement remain distinct |

Skills — compile, export, release, and author agent-facing skills and policies from vault sources — is no longer a built-in module of this table: it was extracted to its own satellite plugin, `vaultmcp-skills`, per `docs/suite-split-design.md` §6. See [skills.md](skills.md) for its deep reference.

Triage — expose bounded queues and apply declared dispositions — is no longer a built-in module of this table either: it was extracted to its own satellite plugin, `vaultmcp-triage`, per `docs/suite-split-design.md` §6. See [triage.md](triage.md) for its deep reference.

Cross-session — discover channels, read deltas, attest read position, and post guarded updates — is no longer a built-in module of this table either: it was extracted to its own satellite plugin, `vaultmcp-crosssession`, per `docs/suite-split-design.md` §6. Its boundary is unchanged by the move: handles are cooperative labels, not authenticated identities, and the unread-entry guard is coordination rather than authentication. See [crosssession.md](crosssession.md) for its deep reference.

Provenance, Fileclass and JD scaffolding are no longer built-in modules of this table either: the three of them left together as the mutating tier of the same split, as `vaultmcp-provenance` ([provenance.md](provenance.md)), `vaultmcp-fileclass` and `vaultmcp-jd-scaffold`, per `docs/suite-split-design.md` §6. Their rows stay above because what each capability MEANS — its user outcome, its posture, its boundary — is unchanged by which plugin mounts it. Two things did change. Their published tool names carry the publisher's namespace (`vaultmcp_provenance_*`, `vaultmcp_fileclass_*`, `vaultmcp_jd_scaffold_*`), and for the seven `obsidian_jd_*` tools that was forced rather than chosen: the host refuses to publish an external tool whose name begins `obsidian_`. And their scoping is now the host's to enforce, which since 2026-09-07 splits by tool rather than by surface: a tool that MUTATES the note it names spells the argument `note_path`, which the host recognizes, so an active path allowlist scopes it per-path and the kernel's record guard, lock consult and journal target see that note; every other tool — the reads that name a note, and everything that names none — carries no recognized key, so the host blocks it outright rather than scoping one argument while the work reaches further. Per surface: provenance is refused entirely, fileclass is seven refused and `set` scoped, JD scaffolding is five refused and two scoped. The package READMEs carry the reasoning and the one residual JD scaffolding accepted.

Acceptance is no longer a built-in module of this table either: at S3c the host/governor split moved it out with the governance provider (`packages/governor`, Obsidian plugin id `governor`) rather than to a `vault-*` satellite, since its posture was governance-facing from the start and it contributed zero MCP tools. Its enabled flag and its `config` block are now the provider's own settings, in the provider's own `data.json` and its own settings tab — not `modules.acceptance.*` in the host's settings anymore. The review pane, the gavel ribbon, mandate/cohort/verification/admission/revision/history work, and the legacy acceptance machinery now live in the provider; the host keeps the governance seam, plus the grandfathered publication of the provider's five shipped tools (`governance_pending_review`, `governance_revisions`, `governance_submit_revision`, `governance_mandate_draft`, `governance_mandates`) through `vault-mcp-api`.

After that extraction, and after S3c moved Acceptance out with the governance provider, the host mounts exactly one built-in module: Scheme.

The target defaults above describe the coherent product, not proof of a particular build. [Status and compatibility](status-and-compatibility.md) owns promotion to shipped status.

## Cross-cutting kernel and provider surfaces

These are load-bearing even when they are not all mounted as ordinary modules.

### Conformance

Compares current findings with an accepted debt baseline so new drift alarms without pretending inherited debt is absent. Rebaselining is authority work. Rule packs from schemes, vocabulary, identities, and other providers remain separately identifiable. Since 2026-10-14 it ships as the separate `vaultmcp-conformance` plugin, which publishes `vaultmcp_conformance_debt` and `vaultmcp_conformance_debt_render` to the host and carries the Drift pane (see [conformance.md](conformance.md#the-plugin)).

### Survey

Collects deterministic observations about the vault for reports and planning. Survey is read/report work. A repair suggested by a survey becomes a separate classified proposal.

### QuickAdd integration

Exposes named QuickAdd choices only through declared capability bindings. Each binding states actor, write shape, change class, scope, preview, effects, and recovery. Dynamic or opaque choices remain private or refused.

### Stable identity and link health

Maintains identity across moves, resolves duplicates without guessing, reports broken relationships, and uses Obsidian's link-aware rename path. Identity repair can be representation or authority work depending on what the identifier establishes.

### Operation kernel

Resolves every invocation to a registered action, enforces posture and scope, records durable observations when required, executes reads or effects, verifies postconditions, and emits operation receipts. Mutations additionally use one queue, revision preconditions, retry identity, session binding, Git proposal objects, effect records, and recovery. Modules cannot register around it.

### External capability publishing

Other Obsidian plugins may publish actions through Governor's SDK and project eligible ones as client capabilities. Their read-only claims are untrusted until the human trusts the exact publisher. A pathless external mutation is unavailable under a path scope because Governor cannot bound it honestly.

## One manifest per module

Each module manifest owns its packaging and distribution facts and references the action registry for execution semantics. It includes:

- stable id and human title;
- outcome, action references, and surface bindings;
- public, optional, private, or excluded distribution;
- dependencies and feature probes;
- settings fields and defaults;
- registered action versions and actual read-only annotations;
- change classes and structural effects;
- scope and discovery behavior;
- session and mandate eligibility;
- preview, verifier, and admission requirements;
- observation capture, operation evidence, receipt, and recovery;
- degraded behavior;
- tests;
- documentation projections; and
- migration or predecessor status.

Build validation compares module action references, the canonical action registry, runtime handlers, surface bindings, and generated capability projections in both directions. A declared action that does not execute is drift; an executable or exposed action absent from the registry is drift.

## Module registration invariants

1. Every module action is registered once and every invocation reaches the shared operation executor used by core actions.
2. No module receives an accept, admission, baseline, signer, or raw Git-ref primitive.
3. Mutating modules declare mutation explicitly and remain off until the human enables the required posture or mandate.
4. One bad module is skipped and reported rather than taking down the core.
5. Action and capability names containing acceptance-shaped verbs are tripwires, not the sole security boundary.
6. Discovery and results are scope-filtered before disclosure.
7. Runtime availability is reported with a typed reason.
8. Module settings state when changes take effect: live, next connection, reload, or restart.

## Initial public distribution

The first Community bundle has an exact distribution profile.

**Public core:**

- acceptance, review, and admission;
- operation kernel, observation and effect evidence, receipts, journal health, and recovery;
- stable identity and link-health reads;
- basic search, note, property, link, history, diff, navigation, and availability capabilities; and
- capability/module discovery plus the external-publisher guard, with no publisher trusted by default.

**Public optional, disabled until configured or supported:**

- Bases read evaluation;
- scheme resolution and preview-first bounded placement;
- vocabulary validation;
- conformance, health, and survey reports;
- Fileclass inspection and named representation proposals when its dependency is supported (now the separate `vaultmcp-fileclass` satellite plugin — absent from the Community bundle because it is simply not part of it, not because of a manifest exclusion decision); and
- provenance inspection and staleness reports, without unconstrained regeneration (now the separate `vaultmcp-provenance` satellite plugin, on the same terms).

**Private/operator in the first release:**

- skills and policy compilation or export (now the separate `vaultmcp-skills` satellite plugin — absent from the Community bundle because it is simply not part of it, not because of a manifest exclusion decision);
- cross-session fleet coordination (now the separate `vaultmcp-crosssession` satellite plugin — absent from the Community bundle because it is simply not part of it, not because of a manifest exclusion decision);
- JD scaffolding (now the separate `vaultmcp-jd-scaffold` satellite plugin — absent from the Community bundle because it is simply not part of it, not because of a manifest exclusion decision);
- triage mutations (now the separate `vaultmcp-triage` satellite plugin — absent from the Community bundle because it is simply not part of it, not because of a manifest exclusion decision);
- QuickAdd execution bindings;
- provenance regeneration with external outputs (in the `vaultmcp-provenance` satellite, on the same terms);
- opaque or pathless third-party mutations; and
- every advanced capability pack excluded by the public contract.

Private items are absent from the public bundle, not merely disabled. Promotion requires a new manifest decision, clean-vault value, threat and recovery review, tests, disclosure, and Community review.

## Adding a module

A new module is ready only when:

1. its outcome cannot be expressed cleanly by an existing module;
2. its manifest, action definitions, and surface bindings are complete;
3. every action invokes through the shared operation boundary;
4. change classes and verifier predicates are defined;
5. scope and unavailable behavior are testable;
6. the public/private decision is explicit;
7. user, agent, operator, security, and submission projections are generated; and
8. migration and offboarding are defined.

“The tools exist” does not establish that the module is safe, enabled, usable, or documented.
