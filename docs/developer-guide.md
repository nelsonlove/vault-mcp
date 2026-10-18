# Developer guide

Governor is security-sensitive infrastructure inside a stateful application. A change is complete only when its runtime behavior, authority, observability, recovery, documentation, and migration are all coherent.

The settled implementation sequence, repository work packages, file ownership, canonical subject contract, migration path, and coding-agent handoff rules are in the [Governor coding-agent development guide](coding-agent-development-guide.md). The [settled decision register](design-decision-register.md) fixes D01–D18; implementation agents do not reopen them inside individual pull requests.

## Repository orientation

The current monorepo is organized around:

| Path | Responsibility |
|---|---|
| `packages/host/` | The Vault MCP host Obsidian plugin (id `vault-mcp`): socket transport and embedded bridge, the guard, kernel v0 (write queue, journal, idempotency, advisory locks, uid index, record guard), the operation executor and action registry, observation capture and the blob store, the core `obsidian_*` tools, scheme/JD addressing, the module host, the external-tool registry, and the governance seam. With no provider installed every seam consultation is vacuous and the host works fully standalone |
| `packages/governor/` | The Governor governance provider Obsidian plugin (id `governor`): proposals, verification, admission, cohorts, mandates, transformations/promotion, the history store, the review pane, the gesture perimeter, the legacy acceptance machinery with its migration/cutover/store-binding, and the five MCP tools it publishes through `vault-mcp-api` |
| `packages/core/` | Shared pure types and utilities, including guards used by more than one backend |
| `packages/vault-mcp-api/` | SDK through which another Obsidian plugin can publish capabilities to the host |
| `packages/skills/`, `packages/triage/`, `packages/vocab/`, `packages/health/`, `packages/bases/`, `packages/conformance/`, `packages/quickadd-choices-compile/` | Satellite plugins extracted from the host by the suite split (ids `vaultmcp-skills`, `vaultmcp-triage`, `vaultmcp-vocab`, `vaultmcp-health`, `vaultmcp-bases`, `vaultmcp-conformance`, `quickadd-choices-compile`; the fileclass, provenance and JD-scaffold satellites are beside them). Each builds its own `main.js` from its own manifest and publishes its tools through `vault-mcp-api`, so none of them is part of the Community bundle |
| `packages/server/` | Separate filesystem/server deployment; not part of the ordinary Community Plugin promise |
| `docs/` | Existing implementation and historical reference; target-state public docs must resolve status explicitly |

The Community release is built from the host and governor packages, now two Obsidian plugins rather than one. A server or private capability pack must not silently enter either distribution bundle or disclosures. The [Module directory](modules.md) accounts for every current module family and cross-cutting provider surface.

## Development setup

Use a dedicated test vault, never the primary personal vault. Install dependencies from the committed lock file, then use the package scripts:

```bash
npm test --workspaces --if-present
npm --workspace packages/host run build
npm --workspace packages/governor run build
```

The actual release process must verify the package and manifest versions agree before building.

## Adding an action and projecting a capability

### 1. Define the user outcome

Write one sentence describing the vault-state postcondition. If the entry contains “and” between unrelated effects, split it. Define the stable action id and version in the [action registry](action-registry.md), including inputs, observations, effects, posture, scope, change classes, session and mandate eligibility, verifier, recovery, idempotency, and degraded behavior. Capabilities are generated surface projections, not a second semantic owner.

### 2. Design a pure core

Put deterministic parsing, validation, planning, diffing, and policy decisions in Obsidian-free TypeScript. Pass filesystem, metadata, time, random identity, and plugin services through narrow interfaces.

A pure planner should accept declared durable observations and arguments and return either a complete plan or a typed refusal. It should not read live state during planning or depend on an ephemeral observation.

### 3. Build the live adapter

The adapter performs only irreducibly live work:

- obtain files through Obsidian's APIs;
- read metadata cache and feature state;
- call supported file, frontmatter, workspace, or plugin APIs;
- translate results into the pure interface; and
- clean up every registered resource.

Feature-check optional public APIs and return typed unavailability. Do not cast into undocumented shapes without a guarded adapter, an explicit residual, and live tests.

### 4. Bind the surface through the operation executor

Bind MCP, compact discovery, the in-app runner, automation, external publishers, and internal calls to the registered action. Never keep a raw handler reference that an alternate surface can invoke around the executor. The executor owns operation identity, policy, capture, planning, execution, verification, evidence, and receipt lifecycle.

### 5. Declare observations and effects

Name every observation the action may consume or produce, the minimum capture level for each dependency, redaction and truncation behavior, freshness, and replay eligibility. Scope filtering happens before capture. Substantive reads in governed sessions default to replayable; eligible plumbing may remain ephemeral.

For mutating work, distinguish intended, attempted, and observed effects. A handler return is not an observed effect. For read-only work, state that no mutation effect is expected while still recording any durable returned observation.

### 6. Record the proposal without trusting the caller's identity

Route content and tree state into the local Git store through Governor's proposal builder. Actor identity comes from the registered connection and session, not from arguments, Git environment, author strings, or note content. The handler receives no raw ref-advance, signer, admission, or mandate-activation primitive.

### 7. Verify the postcondition and class invariants

Define the live re-read or equivalent evidence the receipt uses. A handler return is not enough. Each supported change class names a versioned predicate, subject construction, coverage rule, trusted verifier, and stale condition. For a discovered-blast-radius operation, return actual changed paths and count when the host can support them.

### 8. Add documentation and migration

Update generated projections, status, threat model, data flow, tests, and migration/deprecation as required by the registry change. Do not hand-edit generated capability facts.

## Supported Obsidian API practices

Follow current official Obsidian guidance:

- use `Vault.process` for background note edits rather than an unsafe read/modify/write pair;
- use `FileManager.processFrontMatter` for properties;
- use `FileManager.trashFile` for recoverable deletion;
- prefer `Vault` and `FileManager` over raw Adapter operations;
- normalize user-provided paths with `normalizePath` and still apply Governor's vault-relative boundary;
- use `Plugin.loadData()` and `Plugin.saveData()` for settings unless operational state has a documented separate store;
- use the plugin instance's `app`, not a global;
- register commands, events, intervals, views, DOM handlers, and child components through lifecycle-aware APIs;
- defer initial UI work until layout readiness; and
- support deferred views where the minimum Obsidian version requires it.

See the official [Obsidian October plugin self-critique checklist](https://docs.obsidian.md/oo/plugin).

## File and path safety

- Accept vault-relative normalized paths only.
- Reject absolute paths, traversal above root, whitespace-changing ambiguity, and non-Markdown targets where the operation is note-specific.
- Match scope prefixes on path-segment boundaries.
- Resolve symlink or real-path identity before enforcing the configured guarded territories in filesystem-facing code.
- Check both source and destination for moves.
- Check every item in a batch.
- Bound discovered targets inside the handler before reading or writing.
- Use Obsidian's link-aware rename path.
- Never overwrite a destination merely because a plan computed it as free earlier.

## Frontmatter and protected data

Do not manually derive a stricter frontmatter grammar than Obsidian honors. Reuse the shared leading-frontmatter recognizer for the raw bytes that will land.

All content writers must pass through the same protected transition predicate. Exceptional transports—CLI, templates, external operations—either prove they inspect honored bytes or remain excluded from the public surface.

Configuration can extend protected properties but cannot redefine the accepted-family floor.

## Operation lifecycle, concurrency, and retries

Every invocation has an operation id, registered action/version, surface, actor/session binding, inputs, capture policy, dependencies, state transitions, and receipt. Mutations also declare queue, revision, idempotency, effect, and recovery semantics. Validation must not strip kernel arguments before the executor sees them.

- Check revisions at dequeue, not submission.
- Include revision in idempotency identity.
- Do not retain abandoned timeouts as completed keys.
- Append late corrections rather than rewriting journal history.
- Preserve observation and effect links across late settlement.
- State multi-target revision behavior explicitly.
- Test simultaneous identical retries and key mismatch.

## Sessions, mandates, cohorts, and standing

- Sessions are durable records with explicit lifecycle, expiry, actor binding, and base state.
- Mandates are immutable signed authority statements. Amendments create new mandates.
- Cohorts use canonical manifests and exact digests; mutable queries never become acceptance subjects.
- Verification attestations follow the registered predicate and cover the exact subject.
- Only the admission service may advance standing refs or emit admission attestations.
- Content and authority changes require role separation unless a documented policy explicitly provides an independent deterministic verifier.
- Revocation appends history; it does not rewrite old attestations.

See [Sessions, mandates, and cohorts](sessions-mandates-and-cohorts.md) and [Standing and attestations](standing-and-attestations.md).

## Git and Obsidian Sync

Keep the Git object database outside the Obsidian Sync file set. Do not treat `.git`, mtime, commit author, or Sync log labels as Governor identity or authority.

Portable attestation files are immutable and content-addressed so concurrent devices do not overwrite a shared mutable ledger. The replica reconciler must tolerate any arrival order, remain in `receiving` while incomplete, and invalidate verification on conflict or digest mismatch. Test Sync settings with community-plugin data both on and off.

Replayable observation payloads are replica-local by default and are not portable-standing content. A portable claim may carry an observation digest without the payload. Never present a current re-read as playback of a historical observation.

## Error design

Define a stable error identifier in the registry and map it to:

- whether the handler ran;
- whether any change may have landed;
- safe user action;
- agent retry behavior;
- receipt outcome; and
- documentation.

Do not throw an untyped message for a condition an agent must branch on.

## Settings design

Every setting declares:

- default;
- human-facing consequence;
- live, reconnect, reload, or restart timing;
- dependency;
- risk;
- recovery; and
- whether an agent can observe but not change it.

Human authority settings have no agent-mutable storage path. UI text uses sentence case and places warnings beside the consequential control.

## User interface

- Prefer one review center and one capability directory over command proliferation.
- Keep the four public posture labels exact: Looking only, Drafting a change, Proposing governed changes, and Working under a mandate.
- Keep Ready for review as a review state, not a connection posture.
- Make unavailable and empty visually distinct.
- Do not rely on color alone.
- Preserve keyboard navigation, focus order, reduced motion, and readable diff semantics.
- Use Obsidian components and CSS classes rather than hard-coded inline styling.
- Do not give default hotkeys to plugin commands.

## Performance

- Keep startup registration cheap and defer heavy scans.
- Use metadata indexes for path and identity lookup.
- Cap and paginate large results.
- Serialize hidden-view engines that consume global app resources.
- Apply belt deadlines around third-party promises that may never settle.
- Measure foreground and background/occluded behavior because Chromium may throttle timers.
- Record vault size, platform, Obsidian version, enabled modules, and measurement method.

Do not claim performance results until [Testing and release](testing-and-release.md) contains captured evidence.

## Testing layers

| Layer | Purpose |
|---|---|
| Pure unit | Grammar, planning, policy, diff, error, action registry, operation lifecycle, and projection validation |
| Operation integration | One executor path for every surface, with scope-before-capture and dependency enforcement |
| Observation and replay | Capture levels, payload integrity, access, redaction, retention, deletion, and historical playback |
| Live adapter | Supported Obsidian behavior and feature probes |
| Adversarial | Path escape, acceptance smuggling, protected removal, retry, timeout, opaque denial |
| Degraded mode | Missing/disabled/incompatible/offline/slow dependencies |
| Product | Clean-vault onboarding, review capacity, accessibility, uninstall |
| Release | Bundle, manifest, license, assets, dependencies, and official scanner readiness |
| Git and attestations | Object/ref integrity, canonical subjects, signatures, trust, revocation, admission, and recovery |
| Replica and Sync | Partial arrival, ordering, portable-state off/on, conflict, offline queue, and local standing |

## Outside names check

A pull request must not hard-wire a name from the operator's own setup (a LaunchAgent label, a home path, a domain, a vault folder name, a Claude Code path, and so on). `scripts/outside-names.json` lists each pattern with a short reason and the path globs that may carry it (tests, docs, and the files that are the intended home). `scripts/check-outside-names.mjs` reads `git diff --unified=0 <base>...HEAD`, looks at added lines only, and exits 1 for a match in a file that is not allowed; the `Outside names` workflow runs it on every pull request. Run it locally with `node scripts/check-outside-names.mjs origin/main`. When it flags a line, add a row to the vault-mcp assumptions ledger (07.36) or make the name a setting. A line that must stay can end with a comment `outside-name-ok: <reason>`. When a name moves to a new intended home, edit the allowed list in the same pull request so the ledger and the check stay in step.

## Documentation ownership

Action semantics derive from the action registry; capability facts are generated projections; setting facts derive from the schema; errors from the registry; operation, observation, effect, and receipt fields from their schemas; status from status-and-compatibility; security assumptions from the threat model; migrations from the migration register.

A pull request that changes one owner must update or regenerate every projection. Documentation drift is a test failure, not a later editorial chore.

## Definition of done

An action and each of its projected capabilities are done when:

- its pure and live behavior are tested;
- it is registered once and invoked only through the operation executor;
- scope, posture, observation capture, effect contract, protected data, queue, journal, timeout, retry, verification, and recovery are addressed;
- registry, handler, surface bindings, and generated projections agree in both directions;
- degraded dependencies are explicit;
- user, agent, developer, security, and submission projections agree;
- migration is closed and predecessor surfaces are disabled;
- Git, attestation, session, mandate, cohort, and Sync/replica contracts are addressed; and
- release evidence is captured.

Code merged without deployment, migration, consumer repointing, and documentation closure is not a completed change.
