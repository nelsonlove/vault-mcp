# Testing and release

Governor's release process must prove more than compilation. It must show that the product boundary, degraded states, recovery, documentation, and Community Plugin artifacts agree with the code being shipped.

This document defines required evidence. It does not assert that a particular release has captured it.

## Test environments

Maintain at least:

- a minimal clean vault with no optional plugins;
- a feature vault with Bases and supported public integrations;
- a large synthetic vault with representative note, link, property, and view counts;
- a security fixture vault containing malformed paths, frontmatter variants, protected properties, and hostile note instructions;
- a migration vault from each supported predecessor;
- a two-replica Sync fixture with community-plugin data both enabled and disabled;
- a Git/attestation fixture with registered, revoked, unknown, and compromised-key simulations; and
- an observation fixture with ephemeral, evidence, replayable, redacted, truncated, expired, and missing payloads; and
- a private-pack vault kept separate from Community release evidence.

Never use the primary personal vault as the development test environment.

## Test layers

### Pure-core tests

Cover:

- path normalization and segment boundaries;
- stable address parsing, scheme address parsing, and the refusal of the retired scheme-ref path form;
- planning and collision refusal;
- frontmatter recognition parity;
- accepted-family and protected-property transitions;
- record flags;
- revision and idempotency identity;
- action-registry schema, version, handler, and surface-binding validation;
- operation lifecycle, dependency, observation, effect, and receipt construction;
- capture-policy selection and the prohibition on authority dependencies from ephemeral observations;
- replay payload digest, redaction, retention, deletion, export, and access-control behavior;
- journal reduction and correction records;
- receipt construction;
- availability states;
- manifest validation;
- review budgets, grouping, sampling, staleness, and supersession;
- change-class classification and escalation;
- canonical session, mandate, proposal, and cohort subjects;
- mandate scope/class/transformation/budget/expiry/revocation checks;
- DSSE envelope and in-toto statement validation;
- signer/verifier trust and stale-attestation behavior;
- Git object/ref and admission-transition integrity; and
- migration and contradiction state transitions.

### Operation-boundary integration tests

Prove that full schema mode, compact code mode, in-app tool runner, batch dispatch, module registration, internal automation, and external capability publishing all resolve a registered action and reach the same operation executor. Scope filtering must occur before observation capture or disclosure. Source-scan tests should reject raw registration or handler paths where architecture requires one interception point.

### Live Obsidian tests

Verify behavior that a headless fake cannot establish:

- metadata-cache identity updates;
- Obsidian-honored frontmatter boundaries;
- link-aware file moves;
- `processFrontMatter` serialization;
- trash behavior;
- active workspace and deferred views;
- Bases evaluation and cleanup (since the S7 satellite extraction this is the `vaultmcp-bases` plugin's evidence to capture, not this plugin's);
- optional plugin feature detection;
- review gesture and focus behavior;
- configuration-directory handling; and
- renderer timer behavior while the window is hidden or occluded.

Record Obsidian version, installer version, operating system, vault size, enabled plugins, foreground/background state, and exact steps.

### Adversarial perimeter tests

At minimum:

- absolute and traversal paths;
- path-prefix collisions;
- stable reference outside scope, or a retired scheme reference;
- hidden counts and backlink paths;
- duplicate and ambiguous identities;
- accepted status as scalar, array, map, alternate key spelling, BOM-prefixed frontmatter, unusual closer, embedded fence, and encoded content;
- protected-property introduction, change, removal, and duplicate spelling;
- dynamic template or opaque command refusal;
- untrusted external read-only claim;
- surface binding to an unregistered action or mismatched action version;
- replayable read outside scope or captured before scope filtering;
- proposal, verification, or admission depending on an ephemeral observation;
- replay payload corruption, unauthorized playback, retention expiry, and deleted payload;
- historical playback recomputed from current vault state instead of the stored observation;
- external client trace presented as Governor-owned evidence;
- pathless external mutation under scope;
- stale revision at dequeue;
- simultaneous identical retries;
- idempotency mismatch;
- timeout with late success and late failure;
- journal failure after successful mutation;
- record replacement, move, append-at-heading, and pure end append;
- prompt injection that asks to widen scope or accept;
- caller-supplied actor, author, signer, or verifier identity ignored or refused;
- mandate replay across session, scope, class, transformation, expiry, and revocation;
- author self-verification where role separation is required;
- attestation replay over a changed or expanded cohort;
- direct Git standing-ref advance without admission;
- portable-ledger tampering, duplicate envelope, and revoked key;
- partial Sync file and attestation arrival in every order;
- Sync merge/conflict invalidating old verification; and
- notes-only Sync never implying portable standing.

A security fix includes a regression fixture and neighboring variants of the defect class, not only the reported byte sequence.

### Degraded-operation tests

For every optional capability:

- module disabled;
- dependency absent;
- dependency disabled;
- compatible and incompatible versions;
- offline or remote error when applicable;
- path scope active;
- empty result while healthy;
- stale or missing operational index;
- timeout;
- malformed dependency response; and
- recovery after the dependency returns.

The expected output names availability; it never converts unavailable to a healthy empty set.

### Product tests

Have a new evaluator follow [Getting started](getting-started.md) in a clean vault without maintainer help. Capture:

- installation of both plugins (Vault MCP, then Governor) and first connection;
- Looking only success;
- scope selection;
- first preview and scoped append;
- live verification and receipt;
- review-center decision;
- one frozen cohort decision and one bounded mandate counter-proposal/acceptance flow;
- portable-standing behavior on a second desktop replica when Sync is configured;
- missing-dependency explanation;
- disconnect and uninstall; and
- accessibility with keyboard and screen-reader inspection.

The evaluator should not need the maintainer's private vault structure or raw tool names.

## Performance evidence

Measure:

- plugin load and layout-ready work;
- first connection and surface construction;
- evidence and replayable observation capture for small and large reads;
- playback of stored observations without re-reading current vault state;
- search and identity-index warm/cold behavior;
- write queue latency under concurrent clients;
- large note and batch operations;
- Bases query foreground and occluded (the `vaultmcp-bases` satellite's measurement since S7, taken through the same published tools);
- review queue refresh with small and large pending sets;
- cohort freeze, full-coverage verification, and drill-down at 10, 100, 1,000, and 10,000 items;
- Git object ingestion, diff, bundle, and garbage-collection behavior;
- signature verification and portable-ledger import;
- Sync-replica reconciliation under partial arrival;
- journal append and month rollover; and
- memory after repeated connect/disconnect and hidden-view cleanup.

Report distributions and environment, not a single best number. Define release budgets before interpreting results. A regression outside budget blocks release or requires an explicit compatibility note.

## Accessibility

Verify:

- complete keyboard operation of settings and review center;
- visible focus;
- meaningful control names;
- diff information not conveyed by color alone;
- scalable text and narrow-pane behavior;
- reduced-motion preference;
- notices and errors announced appropriately; and
- no inaccessible confirmation that becomes the only safety gate.

## Build and test commands

From the monorepo root:

```bash
npm test --workspaces --if-present
npm --workspace packages/host run build
npm --workspace packages/governor run build
```

`packages/host` (the Vault MCP plugin) and `packages/governor` (the Governor plugin) build independently; a release build runs both. The release record stores command, commit, environment, exit status, and artifact digest for each. It must not rely on a prose statement that tests passed.

## Version integrity

Before building, verify all version owners agree — now doubled across both plugins:

- each plugin's `manifest.json` (`packages/host` and `packages/governor`);
- each plugin's package version where used;
- version mapping file if present;
- release tag;
- GitHub release assets; and
- documentation status record.

Keep the two plugins' versions in step: a release should not ship one at 0.19.0 and the other at a different version without an explicit compatibility note.

Semantic versions use `x.y.z`. The release tag must match each plugin's manifest version exactly as required by the official submission process.

## Community release artifacts

There are now two release bundles, one per plugin. Attach to the matching GitHub release, for each of `packages/host` and `packages/governor`:

- `main.js`;
- `manifest.json`; and
- `styles.css` only when the plugin uses one.

Whether the two bundles ship under one GitHub release with six assets or as two separate releases is not decided here; this page only records that the artifact count doubled. Do not commit either built `main.js` to the source repository merely to satisfy release packaging. Inspect each minified bundle for:

- secrets and personal paths;
- undeclared hosts or network calls;
- analytics or telemetry libraries;
- source maps with unintended source content;
- test fixtures and debug logging;
- private server or capability-pack code;
- signing secrets, private keys, local Git paths, or synced test attestations;
- dynamic code loading;
- self-install or self-update behavior; and
- license obligations.

## Manifest review

Two manifests now need this check: `packages/host/manifest.json` (id `vault-mcp`, name `Vault MCP`) and `packages/governor/manifest.json` (id `governor`, name `Governor`). For each, verify:

- its id remains unique and policy-valid;
- its name follows naming rules;
- description is at most 250 characters, ends with a period, and states an outcome;
- `version` is semantic and matches the release;
- `minAppVersion` is the minimum actually tested version, not an aspirational floor;
- `isDesktopOnly` is `true` while desktop APIs are required;
- author and optional funding fields are accurate; and
- sample-plugin names and code are absent.

## Dependency review

For every changed dependency:

- review license and source;
- inspect transitive additions;
- check advisories;
- search for telemetry and network behavior;
- measure bundle effect;
- verify desktop compatibility;
- record why the dependency is necessary; and
- define update and removal ownership.

Commit the lock file used for release.

## Documentation and disclosure review

Check README, SECURITY, PRIVACY, data flow, threat model, action registry, capability projection and directory, settings, status, migration, and submission packet against both plugins' runtime registries and bundles.

Verify that network use, outside-vault access, account/payment requirements, server telemetry, closed-source components, desktop-only status, and private packs are disclosed exactly where current Obsidian policy requires.

## Migration and rollback

Before release:

- run migrations on copies of supported predecessor vaults;
- verify consumer repointing and predecessor deactivation;
- preserve a pre-migration backup;
- test downgrade or state restoration when supported;
- state any irreversible format or authority change;
- verify uninstall leaves notes readable; and
- complete the closure record in [Migration and deprecation](migration-and-deprecation.md).

For the host/Governor plugin split specifically, treat [the migration plan](s3c-migration-plan.md) as the closure record's source of truth for the cutover procedure, the state-dir moves, and the grace-period bridge left behind at the legacy `~/.claude/governor` location.

## Release decision

A release is ready only when:

- all required evidence is captured for the release commit;
- no critical or high security finding remains open;
- public/private bundle separation is verified;
- clean-vault onboarding succeeds;
- review and receipt behavior match documentation;
- action registry, runtime handlers, surface bindings, and generated projections agree in both directions;
- operation, observation, effect, and replay-boundary tests pass;
- migration is closed;
- session, mandate, cohort, Git, attestation, and Sync-replica evidence is captured;
- versions and assets match;
- official policy and submission checks pass; and
- rollback and support ownership are named.

Community directory automation may still find new issues. Address them with a new semantic version and matching release; never replace assets under an existing version.

## Post-release monitoring

After release:

- inspect the Community directory safety scorecard;
- triage install, connection, data-loss, privacy, and performance reports first;
- compare failures with degraded-mode expectations;
- publish a fixed release rather than editing old assets;
- update status and known residuals; and
- trigger rollback guidance when integrity or authority is at risk.

Publication is the start of operational responsibility, not the end of review.
