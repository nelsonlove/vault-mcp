// The declared NON-MCP SURFACE INVENTORY — Gate 0, WP0 (second half).
//
// MCP is one door onto the host. It is not the only one: commands are
// agent-invocable through `obsidian_run_command`'s `executeCommandById`,
// automation runs with no caller at all, and several of this plugin's most
// consequential acts write outside the vault on every load. An inventory that
// stopped at the bridge would omit all of them.
//
// Three kinds of door are declared here:
//
//   ui          an Obsidian command, a settings button — something a human
//               clicks
//   automation  a timer, a vault or metadata event subscription, a
//               layout-ready hook — work that starts with no caller at all
//   internal    a host-to-host call
//
// ── WHAT THE S3c SPLIT TOOK OUT OF THIS FILE ────────────────────────────────
//
// The ACCEPT PERIMETER left, whole, for
// `packages/governor/src/kernel/operations/inventory-authority.ts`. What went:
// `ACCEPT_PERIMETER_FUNCTIONS`, `WIRING_EXPORTS`, `AuthorityRow` and
// `AUTHORITY_SURFACES`, the `authorityAction` projector and its nine authored
// `AUTHORITY_ACTIONS`, the one automation row for the review pane's event
// wiring, the `internal.governance.publish-pending-index` row, and the whole
// `NOT_SURFACES` exclusion list — every one of them described a function inside
// `wiring.ts`, which is `packages/governor/src/wiring/wiring.ts` now and not
// host source at all.
//
// What that changed here, item by item, because none of it is cosmetic:
//
//   • `nonMcpActions()` no longer returns the authored authority actions; it
//     is commands + automation, and the provider's `authorityActions()` is the
//     other half. Both halves project their own rows exactly as the combined
//     function did.
//   • `nonMcpBindings()` no longer emits the authority bindings, so nothing
//     host-side binds a `governorOnly` action any more. The registry fence
//     (`authority_agent_surface`) is still HOST code and still the thing that
//     refuses; what moved is the only set of actions it has to refuse for, so
//     the test proving the fence is live moved with them.
//   • `AutomationRow.touchesAuthority` survives with no `true` left to carry.
//     It is now a claim every host row must make FALSE — authority-bearing
//     automation lives in the provider — and the host test pins that rather
//     than the old "backed by a fenced action" cross-reference, which needed
//     an authority list this package no longer has.
//   • `PlainSurfaceRow.reachesAuthority` still names an action id
//     (`settings.module-enabled` → `governance.rekey-baseline`), and the host
//     can no longer check that the id is a DECLARED authority action, because
//     the declaration is in the other package. The claim is not dropped: the
//     provider's test imports `PLAIN_SURFACES` from here and re-asserts it
//     there. That is the honest cost of the split — a claim about the host,
//     checked in the provider's suite, and lost entirely if the two ever stop
//     being able to import each other.
//
// The inverse-inventory property this file exists for is unchanged for what is
// left: every declared command must be registered, every registered command
// must be declared, every file that subscribes to an event or arms a timer
// must have a row.

import type { ActionDefinition, Distribution, SurfaceKind } from "./action.js";
import { compatibilityAction } from "./compatibility.js";
import type { SurfaceBinding } from "./surface-binding.js";

// ── Obsidian commands ────────────────────────────────────────────────────────

export interface CommandRow {
  /** The command id as registered. Obsidian namespaces it as `governor:<id>`. */
  id: string;
  title: string;
  postcondition: string;
  owner: string;
  distribution: Distribution;
  readOnly: boolean;
  /** `governor-only` is refused by this inventory's test: a command is
   * agent-invocable through `obsidian_run_command`, so it may never bind an
   * authority action. */
  authority?: "governor-only";
  /** Writes outside the vault. Part of the same disclosure set as the bridge
   * rows — the footprint is a property of the PLUGIN, not of one row family. */
  outsideVault?: boolean;
  note?: string;
}

export const COMMAND_SURFACES: CommandRow[] = [
  {
    id: "connect-claude-code",
    title: "Connect to Claude Code",
    postcondition: "Register this vault's bridge with the local Claude Code CLI.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    note: "spawns the `claude` binary; never writes ~/.claude.json directly",
  },
  {
    id: "run-tool",
    title: "Run tool…",
    postcondition: "Invoke any captured tool through the same guarded path a Code Mode connection uses.",
    owner: "core",
    distribution: "private",
    readOnly: false,
    // Not a bypass — it dispatches through the identical guard/queue/journal
    // path — but it IS a distinct door, and one that can reach any mutating
    // tool from inside Obsidian. Gated live on `settings.devToolRunner`.
    note: "dev tool-runner, gated on settings.devToolRunner via checkCallback",
  },
  {
    id: "show-diagnostics",
    title: "Show diagnostics",
    postcondition: "Display bridge, vault and integration state in a modal.",
    owner: "core",
    distribution: "public-default",
    readOnly: true,
  },
  {
    id: "scheme-inbox-open",
    title: "Scheme: open JD inboxes",
    postcondition: "Activate the scheme inbox view.",
    owner: "scheme",
    distribution: "public-optional",
    readOnly: true,
  },
  // The `scheme-drift-open` row lived here until 2026-10-14; the Drift pane and
  // its command left with the conformance rail for the vaultmcp-conformance
  // plugin (packages/conformance/src/main.ts registers `open-drift`).
  // The six `skills-*` command rows lived here until the S4 satellite
  // extraction; they moved out with the commands themselves, which are now
  // registered by the `vaultmcp-skills` plugin (packages/skills/src/wiring.ts).
];

// ── automation ───────────────────────────────────────────────────────────────

export interface AutomationRow {
  id: string;
  /** Repo-relative file, checked against the scan. */
  file: string;
  title: string;
  postcondition: string;
  owner: string;
  /** True when this automation can change authority state with no gesture. */
  touchesAuthority: boolean;
  /** Writes outside the vault. */
  outsideVault?: boolean;
}

export const AUTOMATION_SURFACES: AutomationRow[] = [
  // `automation.governance.events` — the governance event subscriptions and
  // the 2.5s journal poll — was the FIRST row here until S3c, and it was the
  // only one that ever set `touchesAuthority: true`. It moved to the
  // provider's `inventory-authority.ts` with the file it names. Every row left
  // is `false`, and the test pins that: an authority-bearing automation entry
  // point in this package would now be a row claiming something no host action
  // can back.
  {
    id: "automation.core.uid-index",
    file: "src/main.ts",
    title: "Stable identity index maintenance",
    postcondition: "Keep the uid index fresh from metadata-cache and vault events; gated on the socket being enabled.",
    owner: "core",
    touchesAuthority: false,
  },
  {
    id: "automation.scheme.inbox-refresh",
    file: "src/scheme/inbox-pane.ts",
    title: "Scheme inbox refresh",
    postcondition: "Rescan the inbox view when notes are created, deleted or renamed.",
    owner: "scheme",
    touchesAuthority: false,
  },
];

// ── projections ──────────────────────────────────────────────────────────────

const COMMAND_ACTION_PREFIX = "compat.command.";
const AUTOMATION_ACTION_PREFIX = "compat.automation.";

export function commandActionId(id: string): string {
  return `${COMMAND_ACTION_PREFIX}${id}`;
}

/** Every non-MCP action the HOST declares: derived ones for its commands and
 * its automation. The authored authority actions were the third member of this
 * list until S3c; they are the provider's `authorityActions()` now, and each
 * half projects its own rows exactly as the combined function did. */
export function nonMcpActions(): ActionDefinition[] {
  const commands = COMMAND_SURFACES.map((row) =>
    compatibilityAction({
      surface: `command.${row.id}`,
      postcondition: row.postcondition,
      owner: row.owner,
      distribution: row.distribution,
      readOnly: row.readOnly,
      reason: `pre-registry Obsidian command; reachable from the palette and from obsidian_run_command${row.note ? ` (${row.note})` : ""}`,
    })
  );
  const automation = AUTOMATION_SURFACES.map((row) =>
    compatibilityAction({
      surface: `automation.${row.id}`,
      postcondition: row.postcondition,
      owner: row.owner,
      // Automation has no caller, so nothing about it is read-only in the
      // sense the guard means; it is declared mutating so it can never be
      // mistaken for a free operation.
      readOnly: false,
      distribution: "private",
      reason: "pre-registry automation entry point; runs with no caller",
    })
  );
  return [...commands, ...automation];
}

export function nonMcpBindings(): SurfaceBinding[] {
  const commands: SurfaceBinding[] = COMMAND_SURFACES.map((row) => ({
    kind: "ui",
    id: `command:${row.id}`,
    action: `compat.command.${row.id}`,
    actionVersion: 1,
    ...(row.note ? { note: row.note } : {}),
  }));
  const automation: SurfaceBinding[] = AUTOMATION_SURFACES.map((row) => ({
    kind: "automation",
    id: row.id,
    action: `compat.automation.${row.id}`,
    actionVersion: 1,
    source: row.file,
  }));
  // The thirteen authority bindings were emitted here until S3c. Nothing
  // host-side binds a `governorOnly` action any more, which is why the "every
  // authority binding is ui or automation" and "binding one to MCP fails the
  // build" tests moved to the provider's suite: the fence is still this
  // package's code, but the only actions it can refuse for are declared in the
  // other one.
  return [...commands, ...automation];
}

// ── bridge, settings, and internal surfaces ──────────────────────────────────
//
// The last of WP0's inverse inventory. What counts as a SURFACE here, and what
// does not, matters — an inventory padded with every internal helper is as
// useless as one that omits a door.
//
// A surface is something a caller can invoke, something that runs by itself, or
// something that writes outside the vault. A function invoked only as the
// implementation of an already-declared action is NOT a surface; it is that
// action's body. `stampAcceptedFrontmatter`, `buildAcceptDeps`, `appendLog`,
// `saveAllowlist` and the baseline-store writers are all in that category —
// they are how `governance.accept` and its siblings do their work, and
// declaring them again would double-count one door.
//
// Two things in this section are easy to miss and worth stating plainly:
//
//   • `writeBridge()` and `autoRegister()` run on EVERY plugin load,
//     unconditionally — not gated on `settings.enabled`. Both write outside the
//     vault (`~/.claude/governor/`), and `autoRegister` spawns the `claude`
//     binary. A user who disables the socket still gets both.
//   • enabling the `acceptance` module from the settings tab mounts governance,
//     and mounting arms a one-shot `metadataCache "resolved"` handler that runs
//     `reconcileBaselines` — a declared authority action. A settings toggle is
//     therefore an authority-adjacent control, which is not obvious from
//     looking at the toggle.

export interface PlainSurfaceRow {
  id: string;
  kind: Extract<SurfaceKind, "ui" | "automation" | "internal">;
  file: string;
  title: string;
  postcondition: string;
  owner: string;
  distribution: Distribution;
  readOnly: boolean;
  /** Writes outside the vault, which is a privacy and disclosure fact. */
  outsideVault?: boolean;
  /** Reaches the network. Distribution review asks for this explicitly. */
  network?: boolean;
  /** Runs on every plugin load regardless of settings. */
  unconditional?: boolean;
  /** Reaches a declared authority action, however indirectly. */
  reachesAuthority?: string;
  note?: string;
}

export const BRIDGE_SURFACES: PlainSurfaceRow[] = [
  {
    id: "bridge.write-bridge",
    kind: "automation",
    file: "src/main.ts",
    title: "Write the bundled bridge",
    postcondition: "Write bridge.mjs to ~/.claude/governor/ and the legacy directory on every plugin load.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
    unconditional: true,
    note: "runs even when the socket is disabled",
  },
  {
    id: "bridge.write-discovery",
    kind: "automation",
    file: "src/main.ts",
    title: "Publish connection discovery",
    postcondition: "Write this vault's discovery JSON so a client can find its socket.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
    note: "gated on settings.enabled",
  },
  {
    id: "bridge.remove-discovery",
    kind: "automation",
    file: "src/main.ts",
    title: "Remove connection discovery",
    postcondition: "Delete this vault's discovery JSON at unload.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
  },
  {
    id: "bridge.claude-register",
    kind: "internal",
    file: "src/main.ts",
    title: "Register with the Claude Code CLI",
    postcondition: "Spawn the `claude` binary to add or remove this vault's MCP server registration.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
    unconditional: true,
    note: "autoRegister() runs on every load, outside the settings.enabled gate; never writes ~/.claude.json directly",
  },
  {
    // Found by review, and the most consequential omission in the first draft.
    //
    // `autoRegister()` does not stop at registering this vault's MCP server.
    // On success — and on "already registered" — it calls
    // `claudeEnsureConnectPlugin`, which runs
    //
    //     claude plugin marketplace add nelsonlove/obsidian-mcp-suite
    //     claude plugin install vault-mcp-connect@... --scope user
    //
    // That adds a third-party MARKETPLACE SOURCE to the user's Claude Code
    // configuration and installs a SECOND PLUGIN at user scope — persisted
    // outside the vault, affecting every Claude Code session on the machine
    // rather than this vault, and reaching the network to do it. It runs on
    // every plugin load, unconditionally.
    //
    // It is check-first and idempotent, so in steady state it is two `list`
    // calls and no change. That makes it cheap; it does not make it invisible,
    // and a capability that provisions software at user scope is exactly what
    // a distribution review has to be told about. Declared here with its real
    // postcondition rather than folded into "registers this vault".
    id: "bridge.ensure-connect-plugin",
    kind: "internal",
    file: "src/claude-cli.ts",
    title: "Provision the companion Claude Code plugin",
    postcondition:
      "Add the companion marketplace source to the user's Claude Code configuration and install the vault-mcp-connect plugin at user scope, if either is absent.",
    owner: "core",
    distribution: "private",
    readOnly: false,
    outsideVault: true,
    unconditional: true,
    network: true,
    note: "check-first and idempotent; reached from autoRegister(), which runs on every load outside the settings.enabled gate",
  },
];

export const SETTINGS_SURFACES: PlainSurfaceRow[] = [
  {
    id: "settings.connect-claude-code",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Connect to Claude Code",
    postcondition: "Force a CLI registration for this vault.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
  },
  {
    id: "settings.disconnect",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Disconnect",
    postcondition: "Remove this vault's CLI registration.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    outsideVault: true,
  },
  {
    id: "settings.toggle-socket",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Enable or disable the socket",
    postcondition: "Flip settings.enabled; takes effect on reload.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
  },
  {
    id: "settings.module-enabled",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Enable or disable a module",
    postcondition: "Mount or unmount a module's panes live, without a plugin reload.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
    // Enabling `acceptance` mounts governance, and mounting arms the one-shot
    // metadataCache "resolved" handler that runs reconcileBaselines. A toggle
    // that looks like a preference can therefore start an authority act.
    reachesAuthority: "governance.rekey-baseline",
    note: "acceptance -> setGovernanceMounted -> wireGovernance -> arms reconcileBaselines",
  },
  {
    id: "settings.copy-command",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Copy the setup command",
    postcondition: "Copy the registration command to the clipboard.",
    owner: "core",
    distribution: "public-default",
    readOnly: true,
  },
  {
    id: "settings.vocab-add-instance",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Add a vocabulary instance",
    postcondition: "Append a vocabulary source to settings and repaint.",
    owner: "vocab",
    distribution: "public-optional",
    readOnly: false,
  },
  {
    id: "settings.vocab-remove-instance",
    kind: "ui",
    file: "src/connection-ui.ts",
    title: "Remove a vocabulary instance",
    postcondition: "Remove a vocabulary source from settings and repaint.",
    owner: "vocab",
    distribution: "public-optional",
    readOnly: false,
  },
];

export const INTERNAL_SURFACES: PlainSurfaceRow[] = [
  // `internal.governance.publish-pending-index` — the producer behind
  // `governance_pending_review` — was the first row here until S3c. It is not
  // authority-bearing, and it moved for the plainest possible reason: it lives
  // in `wiring.ts`, so a row here would name a file this package does not
  // have. It is declared in the provider's `inventory-authority.ts` and
  // projected by `authorityActions()` there, so the surface is still counted,
  // just counted somewhere else.
  {
    id: "internal.core.save-settings",
    kind: "internal",
    file: "src/main.ts",
    title: "Persist settings",
    postcondition: "Write the plugin's settings to data.json.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
  },
  {
    id: "internal.core.install-id",
    kind: "internal",
    file: "src/main.ts",
    title: "Load or mint the install id",
    postcondition:
      "Read the persistent install id beside the journal, minting one if absent and degrading to an ephemeral id if the directory is unwritable.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
  },
  {
    id: "internal.core.folder-migration",
    kind: "internal",
    file: "src/main.ts",
    title: "Migrate the plugin folder id",
    postcondition: "Reconcile a plugin directory still named for the pre-0.12.0 id with the current manifest id.",
    owner: "core",
    distribution: "public-default",
    readOnly: false,
  },
];

/** Every plain (non-authority, non-command, non-automation-family) surface. */
export const PLAIN_SURFACES: PlainSurfaceRow[] = [...BRIDGE_SURFACES, ...SETTINGS_SURFACES, ...INTERNAL_SURFACES];

/**
 * Every surface that writes outside the vault, ACROSS ALL FAMILIES.
 *
 * The first draft computed this over `PLAIN_SURFACES` alone while claiming it
 * was "the plugin's whole footprint outside the vault." It was not: at the time
 * the skills export and release COMMANDS wrote to a directory outside the vault
 * and their export-on-save AUTOMATION re-triggered the same write on a timer,
 * and a `PLAIN_SURFACES`-only computation reported none of the three. Skills
 * has since left for its own plugin, so the specific example is historical —
 * the lesson is not. A disclosure scoped to one row family is not a disclosure
 * of the plugin, and the next command or timer that writes outside the vault
 * must be caught by construction rather than by remembering to widen this.
 *
 * The footprint is a property of the PLUGIN, so it is computed over every
 * family and pinned by one test.
 */
export function outsideVaultSurfaces(): Array<{ id: string; network: boolean }> {
  return [
    ...PLAIN_SURFACES.filter((r) => r.outsideVault).map((r) => ({ id: r.id, network: r.network === true })),
    ...COMMAND_SURFACES.filter((r) => r.outsideVault).map((r) => ({ id: `command:${r.id}`, network: false })),
    ...AUTOMATION_SURFACES.filter((r) => r.outsideVault).map((r) => ({ id: r.id, network: false })),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

// `NOT_SURFACES` — the eight functions that are the BODY of an already-declared
// action rather than doors of their own — was here until S3c. All eight are
// inside `wiring.ts`, and an exclusion list is only checkable next to the file
// it excludes from, so it went whole to the provider's `inventory-authority.ts`
// along with the test that scans for each name. The host has no equivalent list
// yet, and that is a gap rather than a decision: the same "why isn't this
// listed?" question can be asked of this package's own helpers, and nothing
// here answers it.

export function plainActions(): ActionDefinition[] {
  return PLAIN_SURFACES.map((row) =>
    compatibilityAction({
      surface: row.id,
      postcondition: row.postcondition,
      owner: row.owner,
      distribution: row.distribution,
      readOnly: row.readOnly,
      reason: `pre-registry ${row.kind} surface${row.outsideVault ? "; writes outside the vault" : ""}${row.unconditional ? "; runs on every plugin load regardless of settings" : ""}`,
    })
  );
}

export function plainBindings(): SurfaceBinding[] {
  return PLAIN_SURFACES.map((row) => ({
    kind: row.kind,
    id: row.id,
    action: `compat.${row.id}`,
    actionVersion: 1,
    source: row.file,
    ...(row.note ? { note: row.note } : {}),
  }));
}
