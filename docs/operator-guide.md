# Operator guide

This guide is for a person operating Governor as part of a larger private knowledge and agent system. It assumes the public safety contract is already in place. Private operation may add capabilities and policy, but it may not weaken human acceptance, Governor-only admission, exact mandate and subject checks, path containment, honest availability, receipts, or recovery.

## Deployment profiles

### Public core

Read-heavy, scope-first, preview-first, with human review. Use this profile unless a concrete operational need justifies more authority.

### Advanced governed

Adds configured schemes, vocabulary, Bases evaluation, the health scan, and conformance. (Only schemes are still the host's own module — since the host/Governor plugin split, the `acceptance` module has left the host's registry entirely and its settings now live in the Governor plugin's own `data.json` and settings tab. Triage and cross-session coordination ship as the separate `vaultmcp-triage` and `vaultmcp-crosssession` satellite plugins; since the S7 read-tier extraction, vocabulary, health and Bases ship as the separate `vaultmcp-vocab`, `vaultmcp-health` and `vaultmcp-bases` satellite plugins, and since 2026-10-14 conformance ships as the separate `vaultmcp-conformance` plugin. Each is installed, enabled and configured on its own, and publishes its tools to the host, Vault MCP, through `vault-mcp-api`.) These remain bounded and observable but require maintenance of their declarations and baselines.

### Private high-authority

Adds separately installed capability packs for effects excluded from the Community surface. Use only with dedicated threat additions, backups, incident ownership, and offboarding.

Do not collapse these profiles into one “enabled” switch.

## Operator responsibilities

The operator owns:

- client registration and scope;
- posture and private-pack enablement;
- dependency versions;
- capability and settings manifests;
- protected properties;
- session, mandate, verifier, signer, cohort, standing, and review integrity;
- local Git stores, bundles, and replica reconciliation;
- vocabulary and scheme sources;
- conformance debt and ratchet;
- journals and retention;
- replayable observation capture, access, retention, export, and deletion;
- backup and restoration tests;
- migration closure;
- health monitoring; and
- incident response.

An agent may report and perform bounded work. It does not become the operator because it can call tools.

## Initial deployment

1. Install the public core — the Vault MCP host plugin and the Governor provider plugin — in a test vault.
2. Verify Looking only and empty-scope behavior.
3. Register one client and one narrow scope.
4. Test read, preview, scoped append, revision conflict, uncertain timeout procedure, receipt, individual review, and Governor admission.
5. Establish independent backup and restore evidence.
6. Configure review budget and daily/weekly cadence.
7. Test one frozen cohort with full-coverage verification.
8. Test one narrow, short-lived mandate and its revocation.
9. Add one optional module at a time.
10. Capture compatibility and degraded-mode evidence.
11. Configure each additional Sync replica deliberately.
12. Add private packs last, through separate change records.

## Updating a live install

A reload drops the plugin's socket while agents are writing. On 2026-09-29 two reloads during live writes let a queued create run twice (#435). The host now refuses writes still waiting at unload (the refusal is in the journal; a caller over the socket sees its connection drop) and keeps its idempotency keys across a reload, including the key of a write still running, so a retry with the same key waits for it or replays it. Two limits: a retry WITHOUT a key can still repeat a write, and the first reload onto a build with this fix is unprotected, because the build it replaces has none of it. So a deploy should still disturb as little as possible:

1. **Never point the vault's plugin folder into a git working tree.** `main.js` and `manifest.json` in `.obsidian/plugins/vault-mcp/` are symlinks into a versioned build directory, `~/.local/share/obsidian-plugin-builds/vault-mcp/<version>-<sha>/`, holding the built files and a `BUILD.txt` that names the commit. A build or a branch switch in a checkout then cannot change the running plugin.
2. **No hot-reload marker** (`.hotreload`) in the host's or a satellite's plugin folder. With the Hot Reload plugin enabled, a marker makes every rebuild reload the plugin by itself, mid-write.
3. **Quiet check before you build and before you swap:** no journal record for two minutes. Writes are journaled when they FINISH, so a quiet journal means nothing finished lately: a slow write could still be running, and writes could be waiting behind it. Two quiet minutes make a running write unlikely; they do not prove there is none.
4. **Swap in one step:** replace each symlink with an atomic rename to the new build directory. Then reload once and probe the running plugin (loaded, version, the vault's base path).

If the new build is byte-identical to the running one, the swap needs no reload.

If you are upgrading an existing deployment across the host/Governor plugin split rather than deploying fresh, see [the migration plan](s3c-migration-plan.md) for the cutover procedure. The Claude Code MCP server name moves back to `vault-mcp` at the split, so tool prefixes become `mcp__vault-mcp__*`. An existing `governor` registration keeps working through the grace period (the bridge resolves the socket through discovery, never through the registration name), so the client change is not urgent — but it is the one operator action the split does not do for you, and any `mcp__governor__*` permission entry needs re-adding under the new prefix. Steps 11–12 of the migration plan are the whole procedure.

## Scope design

Assign scope by the work a client needs, not by convenience. Separate sensitive or differently governed territories rather than expecting an agent policy to remember them.

For each connection record:

- owner and purpose;
- allowed roots;
- operation posture;
- optional modules;
- private packs;
- model/provider data policy;
- review budget contribution;
- allowed session and mandate shape;
- signer and verifier trust policy;
- expiry or review date; and
- incident contact.

Revoke stale connections.

## Controlled vocabulary

The vocabulary tools are no longer part of this plugin: since the S7 satellite extraction they ship as the separate `vaultmcp-vocab` plugin, which publishes its four tools to the host, Vault MCP, through `vault-mcp-api` (see [vocabulary-module.md](vocabulary-module.md)). The requirements below are unchanged and are that plugin's to satisfy; what changes for an operator is that it is installed and configured separately, and that its tools are named `vaultmcp_vocab_*`. The vocabulary rule core itself lives in `@vault-mcp/core`, shared with the host's conformance rail, so one vault keeps one vocabulary.

Use controlled vocabulary only when a term changes validation, permission, lifecycle, filing, retrieval, receipt, or recovery. Every vocabulary source has:

- authority and status;
- exact grammar;
- scope;
- duplicate/ambiguity behavior;
- seeding state;
- deprecation behavior;
- editor and agent projection; and
- conformance consumer.

A missing root scope note is reported as `scope_root_missing` (tag scoping is then off), not as proof that all tags are valid. Report findings before automatic changes.

Review vocabulary quarterly. Demote terms with no operational consumer to ordinary prose.

## Address schemes

A scheme provider declares what it can validate, order, allocate, and place. Do not force a Johnny Decimal shape onto every organizational system.

Operator rules:

- stable identity and scheme address remain different;
- scheme exclusions bound what that provider claims, not ordinary vault scope;
- “next free” is computed, not reserved;
- ambiguous addresses refuse;
- mutations plan first and never overwrite;
- renumbering owns its explicit cascade or stops; and
- compatibility definitions remain data when feasible.

Audit duplicates and misfiling before allocation runs.

## Conformance

Conformance is a rail, not a cleanup bot. It compares current findings with an accepted baseline so new drift alarms while old debt remains visible. It is the separate `vaultmcp-conformance` plugin: install it beside Vault MCP to get the debt tools, the Drift pane and the conventions settings. On its first load it copies the conventions and the debt settings from Vault MCP once.

Maintain:

- declared territory and permanently excluded roots;
- registered rule packs;
- baseline pack coverage;
- debt metadata and trend;
- stale and high-priority debt budgets;
- generated register integrity; and
- human-reviewed rebaseline procedure.

A rebaseline is an authority act. Run it against a review fixture, inspect added and removed keys, then apply through the human process. Never let a missing rule pack make old debt appear cleared.

## Triage

Triage is a queue predicate plus a declared disposition set. Keep the built-in set mechanical. Richer verbs are human-declared configuration and must not confer standing.

For each disposition record:

- plain-language meaning;
- action class;
- required destination or patch;
- move whitelist/blacklist;
- preview behavior;
- partial-failure behavior;
- acceptance protection;
- review consequence; and
- retirement procedure.

Opaque macro-backed dispositions belong in a private profile. Their effects remain unknown and must surface through the review audit net.

## Cross-session coordination

Coordination channels provide discovery, delta reads, read-position attestation, and guarded posting. Handles are cooperative assertions, not authentication.

This capability is no longer part of this plugin: since the S6 satellite extraction it ships as the separate `vaultmcp-crosssession` plugin, which publishes its four tools to the host, Vault MCP, through `vault-mcp-api` (see [crosssession.md](crosssession.md)). The requirements below are unchanged and are that plugin's to satisfy; what changes for an operator is that it is installed and configured separately, and that its tools are named `vaultmcp_crosssession_*`.

Operational requirements:

- one authoritative channel shape per audience;
- stable channel identity;
- posting refuses unread foreign entries;
- read receipts remain per-install operational state;
- log appends preserve the message grammar;
- generic append bypass is documented; and
- channel health detects ambiguous or missing log files.

Coordination helps fallible peers stay current. It is not an adversarial authorization layer.

## Policy and skill layers

Compiled agent skills and policies are downstream projections. The vault source owns status and authority; generated files do not become a second constitution.

Before export:

- exclude or visibly stamp proposed policy according to the chosen policy;
- validate parent, scope, and collision rules;
- preview the full diff;
- verify the output root;
- preserve human-authored regions;
- export atomically where possible; and
- repoint consumers before retiring an old exporter.

After export, verify a fresh agent session loads the intended version. “Files generated” does not establish “agents are running them.”

## Review capacity planning

Estimate:

```text
weekly review demand = judgment proposals + cohort decisions + mandate audits + exceptions + stale decisions + incident reviews
```

Set agent schedules and budgets below demonstrated review throughput. Track:

- pending count by consequence and age;
- acceptance, revision, revert, expiry, and supersession rates;
- median and oldest time to decision;
- mechanical sample failures;
- verifier failures, class escalations, mandate budget stops, and cohort exclusions;
- proposals generated per source loop; and
- time spent reviewing.

Pause producers when debt rises. Do not use automation to conceal the queue.

## Backup verification

A backup job is healthy only when:

- intended source roots resolve;
- input count and size are plausible and non-zero;
- destination has recent objects;
- failures alert;
- encryption and key recovery are known; and
- a restore into a separate vault succeeds.

Sync is not backup. Journals, observation/effect evidence, and baselines may need their own retention if plugin data or replica-local application data is excluded from note backups.

## Git, attestations, and replica operations

For every desktop or headless replica record:

- vault and replica identity;
- local Git directory and health;
- key registrations and revocations;
- portable-standing mode;
- Obsidian Sync community-plugin data setting;
- last imported attestation and effect receipt;
- receiving/conflicted cohorts; and
- last successful reconstruction from a vault snapshot, Git bundle, and portable ledger.

Never run Obsidian desktop Sync and Headless Sync against the same local vault on the same device. Do not copy `.git` through Obsidian Sync. Treat each replica's local standing ref as derived from exact files and validated authority evidence, not from device labels.

## Observability

Maintain a control view showing:

- connected clients and last activity;
- current scopes and postures;
- served, disabled, missing, incompatible, and private capabilities;
- queue depth, wait, timeout, and late corrections;
- journal health and retention;
- observation-store integrity, replay authorization failures, payload volume, and retention backlog;
- pending review budget and age;
- active sessions and mandates, utilization, expiry, and revocation;
- cohorts by receiving, verification, ready, admitted, and conflicted state;
- signer, verifier, Git, attestation-ledger, and replica health;
- conformance new/carried/cleared debt;
- dependency last success;
- backup last verified restore; and
- open migrations and contradictions.

Do not collapse installed, enabled, running, healthy, and last successful.

## Maintenance cadence

### Daily

- review high-consequence and old proposals;
- review mandate exceptions, verifier failures, and receiving/conflicted cohorts;
- inspect timeouts, partial outcomes, and journal warnings;
- release stale advisory claims; and
- verify unattended loops did not exceed budget.

### Weekly

- sample mechanical groups;
- audit admitted cohorts and mandate utilization;
- clear superseded proposals;
- inspect dependency health and conformance new findings;
- triage support and security reports; and
- verify backup freshness.

### Monthly

- test a restoration;
- review scopes, clients, protected properties, and private packs;
- review signers, verifiers, mandates, replicas, portable-standing configuration, and Git health;
- prune journals according to policy;
- examine performance and queue trends;
- close migrations and contradictions; and
- update dependencies through the release process.

### Quarterly

- prune vocabulary and stale policy;
- reassess public/private boundaries;
- rotate or review secrets;
- run a clean-vault onboarding exercise; and
- rehearse incident shutdown and recovery.

## Incident response

1. Stop the bridge and connected clients.
2. Preserve current vault, plugin state, required replayable observations, effect records, logs, receipts, and journal.
3. Identify scope and whether outcome is known, partial, or uncertain.
4. Protect secrets and notify affected data owners.
5. Reproduce in a copy or fixture, not the live vault.
6. Restore narrowly after comparing evidence.
7. Fix the defect class and neighboring variants.
8. Review whether scope, pack, or operating cadence made the incident worse.
9. Publish or record the necessary security and migration action.

## Decommissioning

For a client, module, pack, or whole deployment:

- stop writers;
- export required evidence;
- resolve or expire proposals;
- revoke registrations and secrets;
- disable schedules and services;
- remove operational indexes and sockets after verification;
- preserve notes as plain Markdown;
- retain or dispose journals, observation payloads, effect records, and baselines under policy;
- verify no consumer still calls the retired surface; and
- record dated closure.

The exit guarantee is strong only when the operator finishes the cutover.
