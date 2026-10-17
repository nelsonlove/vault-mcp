# The module system

> **Deep reference for the shipped implementation.** Canonical concepts and the target design live in the [documentation corpus](README.md); what is shipped versus target is owned by [status-and-compatibility.md](status-and-compatibility.md).


Capability providers — the [scope provider](scope-provider.md) chief among them — are not hard-wired into the tool surface. They are
**modules**: settings-toggleable units that register their tools **through a registry**, behind
a set of gates that keep the acceptance model intact even as the plugin grows new capabilities.
(The [vocabulary provider](vocabulary-module.md) was the other founding example; it ships as the
separate `vaultmcp-vocab` satellite plugin since S7 and is documented here as the pattern's origin.)

Files: `packages/host/src/kernel/modules/` (the host — pure, Obsidian-free) and
`packages/host/src/mcp/modules-mount.ts` (the mount — wires the built-in modules to the live
plugin).

## What a module is

A `VaultModule` (`kernel/modules/module.ts`) is identity + posture + capabilities + a default
enabled state + one verb:

```ts
interface VaultModule {
  id: string;                      // unique; also its key in settings (modules.<id>) 
  posture: "capability" | "governance";
  capabilities: string[];          // e.g. ["addressing","allocation"] or ["vocabulary"]
  enabled: boolean;                // default; settings override per id
  settingsSchema?: ModuleSettingsSchema;
  register(reg, host, config): void;  // called once per built server, only when enabled
}
```

**Posture** distinguishes the two kinds of surface a module could face:

- **`capability`** — faces agents; contributes tools.
- **`governance`** — faces the human; a deliberately one-way, read-only surface (the shape of the acceptance module's review pane, back when acceptance was a host module — see below for where it went at S3c). **The v1 host refuses governance-postured modules outright** at construction. The fold (#83) landed by clearing that gate rather than lifting it: the acceptance module (module id `acceptance`; the posture name `governance` is unrelated to the retired module id of the same spelling) declared posture `capability` and contributed ZERO MCP tools — its whole surface was the in-Obsidian pane. The posture exists in the type so the contract models the asymmetry, even though no module currently registered uses `governance`.

## Registration goes *through* the registry — the key property

`server.ts` no longer calls the scope registrar directly (nor, while it existed here, the vocab one). It calls **`mountModules(...)`**,
which builds a `ModuleRegistry` over the built-in modules and registers each enabled module's
tools through the registry's wrapped registrar. Because the registrar it forwards to is the
**guard-patched `server.registerTool`**, every module tool lands at the **same interception
point** as every hand-registered tool — guarded, queued, journaled, kernel-args-declared, Code
Mode captured — with **no module-specific bypass possible**. A source-scan test pins that the
registrar is never called outside the mount.

## The gates the registry enforces

`ModuleRegistry` (`kernel/modules/module-registry.ts`) treats module lists and settings as
user-shaped input: every defect — a duplicate id, a settings row naming an unknown module, a
governance posture, a tool-name collision, a forbidden tool name, a throwing `register()` or
`validate()` — is **skipped and reported** via a `problems` array, **never thrown**. (One carve-out since 2026-09-07: a settings row naming an EXTRACTED module id — the satellites' preserved one-shot adoption sources, `EXTRACTED_MODULE_IDS` in module-registry.ts — is skipped silently; it is designed-in state, not a defect.) One bad
module must not take the tool surface down; a bad tool must not take its module down. (`server.ts`
logs `problems` per connection.)

Two refusals are load-bearing policy, not hygiene:

### 1. The accept / baseline name tripwire

No module may register a tool whose name reads as advancing a baseline or minting acceptance:

```
FORBIDDEN_NAME_FRAGMENTS = ["accept", "approve", "baseline"]   // case-insensitive substring
```

A tool whose name contains any of these is **refused and reported**. This is a **tripwire, not
the security boundary** — the boundary is that no accept-capable code is reachable from any
module the v1 registry will instantiate at all. The tripwire exists so a future module that
*tries* grows a loud, greppable, test-pinned failure instead of a quiet registration.

### 2. The read-only mount gate

`mountModules` passes the registry a **gate**: a module's tool must be **explicitly**
read-only (`readOnlyHint === true`, strict — absent or `false` both refused) **unless the
module itself declares `mutating: true`** in its registration row. A refused tool is **not
registered, not recorded in `describe()`, and does not reserve its name** (the gate runs
*before* the registration is recorded, so bookkeeping stays truthful).

The `mutating: true` declaration is a real, deliberate escape hatch — **no current module uses
it**, and six did over the suite split's life (see the table below) — not a bypass of any write
control: a declared-mutating
module's tools still register through the guard-patched registrar, so they take the full
kernel treatment (read-only mode, path allowlist, write queue, journal, kernel args) exactly
like built-in mutating tools. What the gate refuses is the UNDECLARED case: slipping a
mutating handler into a module that did not declare itself mutating fails the mount loudly
rather than drifting onto the write path. This matches the resolution the status page's
contradiction C-006 records: the module contract distinguishes read-only from declared
mutating actions; no module receives raw accept or baseline authority either way.

## The host context handed to modules is minimal

`mountHost(deps)` returns **exactly** `{ getSettings, visible }` and nothing else
(`modules-mount.ts`) — pinned by a `Object.keys` test:

- `getSettings` — the read-only settings accessor (readOnly / allowlist / …).
- `visible` — the `visiblePaths` allowlist filter (paths in, the visible subset out), so a
  module bounds its answers by the read boundary **exactly** like the built-in tools, without
  importing `guard.ts`.

There is **no raw server, no raw `registerTool`, no baseline/accept primitive**. The only
registrar a module holds is the wrapped `scoped` registrar, which runs the forbidden-name +
collision + gate checks before forwarding — a module cannot walk it to a raw `registerTool`
or to any accept surface. A declared-mutating module's handlers can reach VAULT writes — that
is what the declaration grants — but only through the guarded path with the full kernel
treatment; **no mounted handler, mutating or not, can reach an accept, baseline, or
standing-authority surface** (those primitives are simply never in any module's context).

## Toggling a module

Each module has a row in plugin settings under `modules.<id>`
(`kernel/modules/settings.ts`):

```ts
type ModuleSettings = Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
```

- **`modules.<id>.enabled`** overrides the module's default. The **Modules** section of the
  plugin settings tab (`connection-ui.ts`) renders a GENERATED section per registered module —
  an "Enabled" toggle plus whatever config controls the module's manifest declares — so a new
  module gets its settings surface from its manifest rather than hand-built UI.
- **`modules.<id>.config`** is merged over the module's `settingsSchema.defaults` (shallow).
- **When it takes effect.** Config the *handlers* read (allowlist, scheme rows) is
  a thunk, so those edits land live. But `enabled` is read once **per mount, i.e. per
  connection**, so toggling a module takes effect on the **next session connect** (exactly what
  the settings tab says). This was live-verified: disabling the scheme module dropped the live
  tool count from 56 to 51 on the next connect (the 5 scheme tools gone, the vocab module's
  four — still a module at the time — intact), and re-enabling restored it — while `jd:` addressing kept resolving at the kernel level even with
  the module off.
  - **Historical (removed at S3c) — the acceptance module's Obsidian surface used to mount LIVE.** While acceptance was still a host module it contributed zero MCP tools; its `enabled` flag gated an in-Obsidian *review pane + gavel ribbon*, not a tool surface, and that pane mounted/unmounted the moment the toggle flipped, with no plugin reload (`main.ts setGovernanceMounted` → `wireGovernance` returning a child `Component` the plugin `removeChild`s on disable). The always-on read-only `governance_pending_review` MCP view was unaffected by the toggle either way. At S3c acceptance left the host's module registry entirely with the governance provider — see [modules.md](modules.md) for where its enabled flag and config now live — and `governance_pending_review` is now one of the five tools the provider publishes through `vault-mcp-api` under the host's closed grandfather table, not a host built-in view. The scheme module's in-Obsidian panes (Inbox/Drift) still live-mount the same way the acceptance pane used to. Tool surfaces for every currently-registered module stay next-connect.

## The built-in modules

The authoritative inventory is the [module directory](modules.md); this table is the
mount-registration view (id, default, declared posture). One module registers today:

| Module id | Default | Posture | Capabilities |
| --- | --- | --- | --- |
| `scheme` | enabled | read-only | `addressing`, `allocation` — deep ref: [scope-provider.md](scope-provider.md) |

It does not declare `mutating`. The flag and its gate branch remain in the module host as a tested, dormant seam: `provenance`, `fileclass` and `jd-scaffold` were the last three modules that used it (skills, triage and cross-session used it before them), and all six left as satellite plugins. `acceptance` left too, at S3c, but unlike the other six it did not become a `vault-*` satellite: it departed with the governance provider (`packages/governor`, Obsidian plugin id `governor`), the same plugin that already held mandates, cohorts and the history store, so its enabled flag and config now live in the provider's own settings rather than a new satellite's. A module that needs the `mutating` declaration again declares it the same way the six satellites did.

Skills is no longer a built-in module: it now ships as its own satellite plugin, `vaultmcp-skills`, publishing the same six tools through `vault-mcp-api` — see [skills.md](skills.md).

Triage is no longer a built-in module either: it now ships as its own satellite plugin, `vaultmcp-triage`, publishing the same two tools through `vault-mcp-api` — see [triage.md](triage.md).

Cross-session coordination is no longer a built-in module either: from S6 it shipped as its own satellite plugin, `vaultmcp-crosssession`, publishing its four tools through `vault-mcp-api`, until that plugin was retired on 2026-10-15 (Nelson's verify of 'Retire vaultmcp-crosssession'). Their NAMES changed in the move (`crosssession_*` → `vaultmcp_crosssession_*`), because the plugin id is the tool namespace — the same trade triage made, and unlike skills, whose id happened to reproduce its shipped prefix.

The whole **read tier** left together at S7 — the vocabulary provider (`vaultmcp-vocab`, [vocabulary-module.md](vocabulary-module.md)), the health scan (`vaultmcp-health`) and the Bases surface (`vaultmcp-bases`, [bases.md](bases.md)) — publishing `vaultmcp_vocab_*`, `vaultmcp_health_{scan,lint}` and `vaultmcp_bases_{list,query}` respectively. All eight names changed, for the same plugin-id-is-the-namespace reason, and `base_`/`obsidian_` were stripped rather than carried into a second namespace.

The **mutating tier** left next, and it was the last of them: the fileclass CLI proxy (`vaultmcp-fileclass`), derived-content provenance (`vaultmcp-provenance`, [provenance.md](provenance.md)) and JD scaffolding (`vaultmcp-jd-scaffold`), publishing `vaultmcp_fileclass_*`, `vaultmcp_provenance_{check,reconcile,regen}` and `vaultmcp_jd_scaffold_*`. Their names changed too, and the seven `obsidian_jd_*` tools had no choice about it: the host refuses to publish an external tool whose name begins `obsidian_`. All three took the same fail-closed allowlist posture at the extraction — no tool in the tier carried an argument the host recognizes as a path key, so under an active path allowlist the host blocked each surface wholesale rather than scoping an argument narrower than the work it names. That was corrected in two rounds on 2026-09-07, because the same argument names also decide whether the kernel's record guard, lock consult and journal target can see a satellite's write, and none of those is allowlist-gated. The rule now: a tool spells its note argument `note_path` — a recognized key — **iff it mutates the note it names**, so the kernel watches the write and the allowlist scopes it per-path; a read whose answer can name paths the caller cannot see spells it `note` instead and is blocked outright. Per surface that lands as provenance refused entirely, fileclass refused except for `set`, and JD scaffolding refused except for `promote_to_folder` and `reindex_category`. `docs/suite-split-design.md` carries the full record, including the one residual JD scaffolding accepted rather than closed.

The **conformance rail** left on 2026-10-14 as `vaultmcp-conformance` ([conformance.md](conformance.md#the-plugin)), publishing `vaultmcp_conformance_debt` and `vaultmcp_conformance_debt_render`. It was never a mounted module: its two tools were registered by hand in `server.ts`, but their config sat in a `modules.conformance-debt` row, so `conformance-debt` is now in `EXTRACTED_MODULE_IDS` and that row is skipped silently as the satellite's adoption source.

`scheme` is the last of the modules that pre-date the host, so its config rows still live in the top-level `schemes`
setting (not `modules.<id>.config`) and its tool layer filters via its own
`getSettings` + guard imports — preserved verbatim so the mount is a pure re-wiring with **zero
behavior change**. (Vocab was the other, on the top-level `vocabularies` setting, until S7.) A *new* module should instead read `host`/`config` and use `host.visible`,
per the module-host adapters convention.
