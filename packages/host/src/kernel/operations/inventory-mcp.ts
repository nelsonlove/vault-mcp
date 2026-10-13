// The declared MCP SURFACE INVENTORY — Gate 0, WP0.
//
// One row per MCP tool this plugin can register. This is the FORWARD half of
// the bidirectional inventory; `tests/surface-scan.mjs` is the inverse half,
// reading the same facts out of the source, and
// `tests/operations-surface-inventory.test.mjs` fails the build when the two
// disagree in either direction.
//
// Why declare `readOnly` here when a scanner can read it? Double-entry
// bookkeeping. The registry has to be constructible inside the running plugin,
// where no source scanner exists, so the row must be self-contained — and
// because it is written independently and then checked against source, a
// transcription error and a future annotation change both fail loudly instead
// of agreeing with themselves. `readOnly` is the single most consequential
// field in this table (it is what the guard, the queue and the journal all key
// on), which is exactly why it gets two authors.
//
// WHICH COLUMNS ARE CROSS-CHECKED, precisely — because "the inventory is
// verified against source" would overstate it:
//
//   tool          cross-checked, both directions
//   readOnly      cross-checked against the registration's own annotations
//   everything else — module, distribution, postcondition, paths, gate,
//                 discovered, refusesUnderScope — is SELF-REPORT: reviewed by
//                 a human, not yet verified by a machine.
//
// That gap is not theoretical. Three rows in the first draft of this table
// were wrong in exactly those unverified columns, and an independent review
// caught them rather than a test: the three scheme-write tools claimed
// `discovered: "none"` while moving notes through the link-healing rename
// path; `obsidian_plugin_install`/`_uninstall` refuse outright under a scope
// and were unmarked; and `obsidian_conformance_debt_render` was marked as
// refusing outright when its refusal is per-path. Teaching the scanner to
// verify `refusesUnderScope` and `discovered` is WP1 work — recorded here
// rather than papered over.
//
// `distribution` is a JUDGMENT, applied from D07's profile, and it is the one
// column a reader should argue with. The rules used, in order:
//
//   public-default   basic note/property/link/history/diff/navigation and
//                    availability reads; identity and link-health reads;
//                    capability discovery; the review READ surface
//   public-optional  scoped writes; scheme resolution and preview-first
//                    placement; vocabulary; conformance, health and survey
//                    REPORTS; Bases read evaluation; provenance inspection
//   private          cross-session coordination,
//                    JD scaffolding, QuickAdd execution bindings,
//                    provenance regeneration, plugin lifecycle, opaque or
//                    pathless third-party mutations
//
// Several of those capability names now live in satellite plugins rather than
// here; the classes are unchanged, and this file declares only THIS plugin's
// surface.
//   excluded         capabilities whose effects cannot be bounded or
//                    inspected before execution, and unrecoverable deletion
//
// One row departs from a literal reading of D07 and says so in place:
// `obsidian_delete_note`, in the conservative direction. The `fileclass`
// module was the other, on Nelson's ruling rather than a proposal; it left
// with the mutating tier, and the note where its rows used to be keeps the
// ruling.

import type { Distribution } from "./action.js";
import { NOTE_READ_V1 } from "./actions/note-read.js";
import { NOTE_WRITE_V1 } from "./actions/note-write.js";
import { compatibilityAction, type CompatibilitySpec } from "./compatibility.js";
import type { ActionDefinition } from "./action.js";
import type { SurfaceBinding } from "./surface-binding.js";

export interface McpSurfaceRow {
  /** Exact MCP tool name — this is the surface identity. */
  tool: string;
  /**
   * A NATIVE action id this surface binds instead of a derived one.
   *
   * The migration counter. Every row without this is still `compat.*`: a contract derived from the registration, claiming only what the adapter could see from outside. A row WITH it has had its contract authored, and can therefore claim things a derived one may not — replayable observations, proposal support, a stated change class.
   *
   * Moving a row here is the migration, one surface at a time, in the risk order D18 asks for.
   */
  nativeAction?: { id: string; version: number };
  /** `annotations.readOnlyHint === true`, as literally declared at the
   * registration site. Verified against source by the drift test. */
  readOnly: boolean;
  /** Module responsible for implementation and migration. Note this is the
   * CONCEPTUAL owner, which is not always where the tool registers: the three
   * scheme-write tools are owned by `scheme` but hand-registered in server.ts,
   * because the module host refuses a non-read-only registration. */
  module: string;
  distribution: Distribution;
  /** What becomes true. Taken from the registration's own title/description. */
  postcondition: string;
  /** Argument names carrying a vault path. */
  paths?: string[];
  /** The registration or availability gate, verbatim, when conditional. */
  gate?: string;
  /** Set only where the blast radius is genuinely known; the adapter's default
   * for a mutating surface is `unbounded`. */
  discovered?: "none" | "bounded" | "unbounded";
  /** The surface refuses outright while a path scope is active. */
  refusesUnderScope?: boolean;
  /** Registered outside the patched `registerTool`, with the reason. */
  unguardedRegistration?: string;
  /**
   * The write protection this surface requires (01.43 rules 3, 4, 4a–4c;
   * 01.33 rule 6f; the Step 5 table, ruled 2026-09-29). REQUIRED on every
   * mutating row and absent on every read-only row — pinned by
   * `tests/write-protection.test.mjs`, which also checks the values against
   * the 01.33 table. The host refuses a call that omits what its row
   * requires (`kernel/write-protection.ts`, applied in `mcp/guarded.ts`).
   */
  protection?: Protection;
  /**
   * Why a row's `protection` differs from the class the 01.33 table rules,
   * when it does on purpose. Today: the three rows Nelson ruled "a" on
   * (2026-09-29), exempt until #427 gives the kernel a revision it can check.
   */
  protectionNote?: string;
  /**
   * What the Sync guard (`kernel/sync-guard.ts`; 01.43, Nelson's pick A of
   * 2026-10-12) treats this write as: `structure` (a rename, move, delete or
   * create: waits for Obsidian Sync, then is refused if Sync is still behind)
   * or `content` (an edit or append: waits, then goes on with a warning).
   * Argument-dependent like `protection`. Absent: the guard does not check
   * the tool.
   */
  syncKind?: SyncKindSpec;
}

/** A row's Sync kind: a kind, or argument-dependent (`arg`, its `values` as strings, `otherwise`). */
export type SyncKindSpec =
  | "structure"
  | "content"
  | { arg: string; values: Record<string, "structure" | "content">; otherwise: "structure" | "content" };

/** One class of write protection (01.33 rule 6f). */
export type ProtectionClass = "token" | "key" | "both" | "exempt";

/**
 * A row's protection. A class; or argument-dependent (`arg` names the
 * argument, `values` maps its value — booleans as "true"/"false" — to a
 * class, `otherwise` covers the rest, including the argument's absence); or
 * one of four markers that require nothing of the call itself:
 * `not-a-write` (rule 4c: claims, plugin state, navigation),
 * `dispatcher` (the code-mode meta-tool; the tool it calls carries its own),
 * `per-item` (a batch whose items each go through the guarded single writer,
 * which checks them one by one), and
 * `external` (the third-party publishing surface: a satellite's tools are not
 * classified until the SDK can carry a protection value, apiVersion 3 — the
 * 01.33 table's "satellite tools — known gap" row).
 */
export type Protection =
  | ProtectionClass
  | "not-a-write"
  | "dispatcher"
  | "per-item"
  | "external"
  | { arg: string; values: Record<string, ProtectionClass>; otherwise: ProtectionClass };

// ── packages/core — the 17 fs-expressible tools (FS_TOOLS table) ─────────────

const CORE_FS: McpSurfaceRow[] = [
  { tool: "obsidian_list_notes", readOnly: true, module: "core", distribution: "public-default", paths: ["subdir"], postcondition: "Return the visible Markdown notes under an optional subfolder, paginated." },
  { tool: "obsidian_list_folders", readOnly: true, module: "core", distribution: "public-default", paths: ["subdir"], postcondition: "Return the immediate child folders of a path with recursive note counts." },
  // FIRST NATIVE MIGRATION. Its contract is authored in `actions/note-read.ts` rather than derived, which is what lets its observations be captured at all — see the four capture gates.
  { tool: "obsidian_read_note", readOnly: true, module: "core", distribution: "public-default", paths: ["path"], nativeAction: { id: NOTE_READ_V1.id, version: NOTE_READ_V1.version }, postcondition: "Return one visible note's full content and its current revision token." },
  { tool: "obsidian_read_notes", readOnly: true, module: "core", distribution: "public-default", paths: ["paths"], postcondition: "Return several visible notes' content in one call, tolerating per-item failure." },
  { tool: "obsidian_search_notes", readOnly: true, module: "core", distribution: "public-default", postcondition: "Return case-insensitive full-text matches from visible notes only." },
  { tool: "obsidian_find_by_tag", readOnly: true, module: "core", distribution: "public-default", postcondition: "Return visible notes carrying a frontmatter or inline tag." },
  { tool: "obsidian_search_by_frontmatter", readOnly: true, module: "core", distribution: "public-default", postcondition: "Return visible notes whose named property equals a value." },
  { tool: "obsidian_resolve", readOnly: true, module: "core", distribution: "public-default", paths: ["refs", "from"], postcondition: "Resolve wikilinks, basenames, aliases and addresses to canonical visible paths." },
  { tool: "obsidian_get_backlinks", readOnly: true, module: "core", distribution: "public-default", paths: ["path"], postcondition: "Return the visible notes that wikilink to a target." },
  { tool: "obsidian_get_outlinks", readOnly: true, module: "core", distribution: "public-default", paths: ["path"], postcondition: "Return a note's outbound wikilinks, unresolved where the destination is hidden." },
  { tool: "obsidian_force_reindex", readOnly: true, module: "core", distribution: "public-default", postcondition: "Rebuild the backend index; a no-op against Obsidian's live metadata cache." },
  { tool: "obsidian_manage_frontmatter", readOnly: false, module: "core", distribution: "public-optional", paths: ["path"], discovered: "none", postcondition: "Get, set or delete one top-level frontmatter field on a visible note.", protection: { arg: "op", values: { set: "token", delete: "token" }, otherwise: "exempt" }, syncKind: "content" },
  { tool: "obsidian_patch_note", readOnly: false, module: "core", distribution: "public-optional", paths: ["path"], discovered: "none", postcondition: "Insert or replace content at a named heading or block anchor.", protection: { arg: "op", values: { replace: "token", append: "key", prepend: "key" }, otherwise: "token" }, syncKind: "content" },
  { tool: "obsidian_write_note", readOnly: false, module: "core", distribution: "public-optional", paths: ["path"], discovered: "none", nativeAction: { id: NOTE_WRITE_V1.id, version: NOTE_WRITE_V1.version }, postcondition: "Create or overwrite one visible note with exact content, or with the given frontmatter above content as its body.", protection: { arg: "overwrite", values: { true: "token" }, otherwise: "exempt" }, syncKind: { arg: "overwrite", values: { true: "content" }, otherwise: "structure" } },
  { tool: "obsidian_append_note", readOnly: false, module: "core", distribution: "public-optional", paths: ["path"], discovered: "none", postcondition: "Append markdown to a note's end, creating it if absent.", protection: "key", syncKind: "content" },
  { tool: "obsidian_move_note", readOnly: false, module: "core", distribution: "public-optional", paths: ["from", "to"], postcondition: "Move or rename one note through Obsidian's link-aware file manager.", protection: "key", syncKind: "structure" },
  // D07 lists no deletion capability in the public profile, and the threat
  // model's control #8 says the public surface uses trash rather than hard
  // delete. `obsidian_trash` already provides the recoverable form, so the
  // unrecoverable one is excluded rather than merely optional.
  { tool: "obsidian_delete_note", readOnly: false, module: "core", distribution: "excluded", paths: ["path"], discovered: "none", postcondition: "Permanently delete a note; backlinks are NOT updated.", protection: "both", syncKind: "structure" },
];

// ── core, hand-registered in server.ts ───────────────────────────────────────

const CORE_DIRECT: McpSurfaceRow[] = [
  { tool: "obsidian_doctor", readOnly: true, module: "core", distribution: "public-default", postcondition: "Report bridge, vault, version and integration availability." },
  { tool: "obsidian_get_active_note", readOnly: true, module: "core", distribution: "public-default", postcondition: "Return the focused note's path, content and selection, or null when it is hidden by scope." },
  { tool: "obsidian_read_note_parsed", readOnly: true, module: "core", distribution: "public-default", paths: ["path"], postcondition: "Return one note's structured metadata and body." },
  { tool: "obsidian_tags_list", readOnly: true, module: "core", distribution: "public-default", postcondition: "Return every tag and its usage count, recomputed over visible notes under a scope." },
  { tool: "obsidian_vault_info", readOnly: true, module: "core", distribution: "public-default", postcondition: "Return vault name, base path, config directory and attachment folder." },
  { tool: "obsidian_environment_info", readOnly: true, module: "core", distribution: "public-default", postcondition: "Return Obsidian version, plugin version, platform and enabled plugins." },
  { tool: "obsidian_get_command_ids", readOnly: true, module: "core", distribution: "public-default", postcondition: "Return every registered Obsidian command id and name." },
  { tool: "obsidian_append_at_heading", readOnly: false, module: "core", distribution: "public-optional", paths: ["path"], discovered: "none", postcondition: "Insert content at the end of a named heading's section.", protection: "key", syncKind: "content" },
  { tool: "obsidian_trash", readOnly: false, module: "core", distribution: "public-optional", paths: ["path"], discovered: "none", postcondition: "Move a note to the system trash, recoverably.", protection: "both", syncKind: "structure" },
  { tool: "obsidian_open_in_editor", readOnly: false, module: "core", distribution: "public-default", paths: ["path"], discovered: "none", postcondition: "Open a note in Obsidian's editor; changes workspace state, not vault content.", protection: "not-a-write" },
  // Generic command execution. Threat-model control #9: an opaque operation
  // whose effects cannot be inspected or bounded before execution is absent
  // from the public surface.
  { tool: "obsidian_run_command", readOnly: false, module: "core", distribution: "private", paths: ["file_path"], postcondition: "Execute an Obsidian command by id; effects are whatever that command does.", gate: "per-call command-policy refusal for opaque QuickAdd/js-engine ids", protection: "key" },
  { tool: "obsidian_move_notes", readOnly: false, module: "core", distribution: "public-optional", paths: ["moves"], postcondition: "Move or rename several notes sequentially through the link-aware file manager.", protection: "key", syncKind: "structure" },
  // The standing proof that an argument-derived blast radius is not enough:
  // this one names a target and then discovers, rewrites and reports notes of
  // its own. Bounded only by the allowlist, and only when one is active.
  { tool: "obsidian_repoint_link", readOnly: false, module: "core", distribution: "public-optional", paths: ["target_path"], discovered: "unbounded", postcondition: "Rewrite dangling wikilinks matching a name to point at a target, across every visible note.", protection: "exempt", protectionNote: "Temporarily exempt (Nelson's \"a\", 2026-09-29): ruled token, but its only named path is target_path, the note links point AT, so an if_rev would check the wrong file; back to token with #427." },
  { tool: "obsidian_rename_heading", readOnly: false, module: "core", distribution: "public-optional", paths: ["path"], discovered: "unbounded", postcondition: "Rename one heading in a note and rewrite every link to it across every visible note.", protection: "token", syncKind: "content" },
  { tool: "obsidian_write_notes", readOnly: false, module: "core", distribution: "public-optional", paths: ["notes"], postcondition: "Write several notes in one call, each as its own guarded, journaled write.", unguardedRegistration: "registers through origRegister so the dispatcher takes no queue slot; each ITEM runs through a real makeGuarded wrapper", gate: "!opts.codeMode", protection: "per-item", syncKind: { arg: "create_only", values: { true: "structure" }, otherwise: "content" } },
  { tool: "obsidian_check_links", readOnly: true, module: "core", distribution: "public-default", paths: ["scope"], postcondition: "Report dangling wikilinks, duplicate uids and uid coverage; never repairs." },
  { tool: "obsidian_resolve_uid", readOnly: true, module: "core", distribution: "public-default", paths: ["path"], postcondition: "Resolve a uid to its visible path or a path to its uid; report duplicates without choosing." },
  { tool: "obsidian_claim_scope", readOnly: false, module: "core", distribution: "public-optional", paths: ["scope"], discovered: "none", postcondition: "Record an advisory, expiring claim over a path prefix and disclose overlaps; blocks nothing.", protection: "not-a-write" },
  { tool: "obsidian_renew_scope", readOnly: false, module: "core", distribution: "public-optional", discovered: "none", postcondition: "Restart the expiry clock on a claim this holder owns.", protection: "not-a-write" },
  { tool: "obsidian_release_scope", readOnly: false, module: "core", distribution: "public-optional", discovered: "none", postcondition: "Release a claim this holder owns before it expires.", protection: "not-a-write" },
  { tool: "obsidian_list_scope_claims", readOnly: true, module: "core", distribution: "public-default", postcondition: "List live claims inside the allowlist and count, without naming, those outside it." },
];

// ── THE FIVE ACCEPTANCE ROWS WERE HERE UNTIL THE HOST/PROVIDER SPLIT (S3c) ──
//
// `governance_pending_review`, `governance_revisions`, `governance_submit_revision`,
// `governance_mandate_draft` and `governance_mandates` are published by the
// governance PROVIDER now (`packages/governor`, plugin id `governor`), through
// the external-tool registry like every satellite's tools — so, like every
// external tool, they are outside this inventory by design. Same removal as the
// six `vaultmcp_skills_*` rows at S4, the two triage rows at S5, the four
// cross-session rows at S6 and the eight read-tier rows at S7.
//
// ONE THING IS DIFFERENT HERE AND IT IS THE WHOLE POINT: their NAMES did not
// change. Every other extraction paid the `<plugin id>_<bare name>` rename tax;
// these five were already on the wire, so the host carries a closed grandfather
// table (`mcp/external-tools.ts`) that lets the `governor` publisher — and only
// it, and only for these five names — publish unprefixed, past the F1
// `obsidian_*` refusal included.

// ── navigation and host-plugin lifecycle ─────────────────────────────────────

const NAV: McpSurfaceRow[] = [
  { tool: "obsidian_jump_to", readOnly: false, module: "core", distribution: "public-default", paths: ["path"], discovered: "none", postcondition: "Open a note and scroll to a heading, block or line; workspace state only.", protection: "not-a-write" },
  { tool: "obsidian_toggle_view_mode", readOnly: false, module: "core", distribution: "public-default", paths: ["path"], discovered: "none", postcondition: "Switch the active view between source, preview and live modes.", protection: "not-a-write" },
  { tool: "obsidian_open_workspace", readOnly: false, module: "core", distribution: "public-default", discovered: "none", postcondition: "Load a saved workspace layout.", gate: "runtime: core Workspaces plugin enabled", protection: "not-a-write" },
  { tool: "obsidian_save_workspace", readOnly: false, module: "core", distribution: "public-default", discovered: "none", postcondition: "Save the current layout under a name.", gate: "runtime: core Workspaces plugin enabled", protection: "not-a-write" },
  { tool: "obsidian_list_workspaces", readOnly: true, module: "core", distribution: "public-default", postcondition: "List saved workspace names.", gate: "runtime: core Workspaces plugin enabled" },
  { tool: "obsidian_periodic_note", readOnly: false, module: "core", distribution: "public-optional", postcondition: "Open or create a daily, weekly or monthly note.", gate: "runtime: Periodic Notes, else core Daily Notes", protection: "exempt", syncKind: "structure" },
  { tool: "obsidian_create_note", readOnly: false, module: "core", distribution: "public-optional", discovered: "bounded", postcondition: "Create one new note of a fileclass from its own template, through the vault's flow.applyFileclass, checked, then written once.", gate: "settings.createNoteFlow set", protection: "key", syncKind: "structure" },
  { tool: "obsidian_open_bookmark", readOnly: false, module: "core", distribution: "public-default", discovered: "none", postcondition: "Open a bookmark by title.", gate: "runtime: core Bookmarks plugin enabled", protection: "not-a-write" },
  { tool: "obsidian_list_bookmarks", readOnly: true, module: "core", distribution: "public-default", postcondition: "List bookmarks whose targets are visible under the current scope.", gate: "runtime: core Bookmarks plugin enabled" },
  { tool: "obsidian_plugin_info", readOnly: true, module: "core", distribution: "public-default", postcondition: "Report a community plugin's running, on-disk and cached versions." },
  // Plugin lifecycle changes what code runs in the vault. Private, not public.
  { tool: "obsidian_plugin_toggle", readOnly: false, module: "core", distribution: "private", postcondition: "Enable or disable a community plugin; refuses on the Vault MCP host itself.", protection: "not-a-write" },
  { tool: "obsidian_plugin_reload", readOnly: false, module: "core", distribution: "private", postcondition: "Disable and re-enable a plugin so a rebuilt bundle is picked up.", protection: "not-a-write" },
];

// ── host-plugin integrations ─────────────────────────────────────────────────

const INTEGRATIONS: McpSurfaceRow[] = [
  // Honest about its own limit: the query runs over Dataview's index and
  // selects its own rows, so under a scope it refuses rather than filtering
  // rows it did not recognize.
  { tool: "obsidian_dataview_list_query", readOnly: true, module: "core", distribution: "public-optional", refusesUnderScope: true, postcondition: "Return the rows of a Dataview DQL LIST query.", gate: "app.plugins.plugins['dataview'] loaded" },
  { tool: "obsidian_dataview_table_query", readOnly: true, module: "core", distribution: "public-optional", refusesUnderScope: true, postcondition: "Return the rows of a Dataview DQL TABLE query.", gate: "app.plugins.plugins['dataview'] loaded" },
  { tool: "obsidian_omnisearch", readOnly: true, module: "core", distribution: "public-optional", postcondition: "Return Omnisearch full-text results, filtered to visible paths.", gate: "app.plugins.plugins['omnisearch'] loaded" },
  { tool: "obsidian_fileclass_schema", readOnly: true, module: "core", distribution: "public-optional", postcondition: "Return a Metadata Menu fileClass's field schema.", gate: "app.plugins.plugins['metadata-menu'] loaded" },
  // Runs another plugin's command, so its effects are that command's.
  { tool: "obsidian_fileclass_insert_fields", readOnly: false, module: "core", distribution: "private", paths: ["path"], postcondition: "Run Metadata Menu's insert-missing-fields against a note.", gate: "app.plugins.plugins['metadata-menu'] loaded + command-policy check", protection: "token" },
  // A Templater template is code; its output cannot be inspected before it runs.
  { tool: "obsidian_create_note_from_template", readOnly: false, module: "core", distribution: "private", paths: ["template_path", "target_path"], postcondition: "Create a note by executing a Templater template.", gate: "app.plugins.plugins['templater-obsidian'] loaded", protection: "key", syncKind: "structure" },
  { tool: "obsidian_import_apple_notes", readOnly: false, module: "core", distribution: "private", paths: ["output_folder"], postcondition: "Drive the Importer plugin's Apple Notes import headlessly into a folder.", gate: "app.plugins.plugins['obsidian-importer'] loaded + version in KNOWN_GOOD_IMPORTER_VERSIONS", protection: "key" },
];

// ── the official Obsidian CLI proxy ──────────────────────────────────────────

const CLI: McpSurfaceRow[] = [
  // A free-text subcommand proxy is the definition of an operation that cannot
  // be previewed or bounded. Default-off in settings AND excluded from the
  // public profile.
  { tool: "obsidian_cli", readOnly: false, module: "core", distribution: "excluded", refusesUnderScope: true, postcondition: "Run any official Obsidian CLI subcommand; effects are that subcommand's.", gate: "settings.rawCliProxy === true AND the CLI binary resolves", protection: "key" },
  { tool: "obsidian_note_history", readOnly: true, module: "core", distribution: "public-default", paths: ["path"], postcondition: "List a note's File Recovery version history.", gate: "the CLI binary resolves" },
  { tool: "obsidian_note_diff", readOnly: true, module: "core", distribution: "public-default", paths: ["path"], postcondition: "Diff two File Recovery or Sync versions of a note.", gate: "the CLI binary resolves" },
  { tool: "obsidian_base_create", readOnly: false, module: "core", distribution: "public-optional", paths: ["path"], discovered: "none", refusesUnderScope: true, postcondition: "Create a new item inside a Bases file.", gate: "the CLI binary resolves", protection: "key", syncKind: "structure" },
  // Both refuse OUTRIGHT under any active allowlist, the same unconditional
  // shape as obsidian_cli and obsidian_base_create beside them — a plugin id
  // is not a path, so the operation cannot be bounded by one.
  { tool: "obsidian_plugin_install", readOnly: false, module: "core", distribution: "private", refusesUnderScope: true, postcondition: "Install a community plugin by id.", gate: "the CLI binary resolves + settings.allowDangerousCli === true", protection: "not-a-write" },
  { tool: "obsidian_plugin_uninstall", readOnly: false, module: "core", distribution: "private", refusesUnderScope: true, postcondition: "Uninstall a community plugin by id; refuses on the Vault MCP host itself.", gate: "the CLI binary resolves + settings.allowDangerousCli === true", protection: "not-a-write" },
];

// ── CSS snippets — the considered `.obsidian` exception ──────────────────────

const SNIPPETS: McpSurfaceRow[] = [
  { tool: "obsidian_snippets_list", readOnly: true, module: "core", distribution: "public-optional", postcondition: "List CSS snippets and their enabled state." },
  { tool: "obsidian_snippet_read", readOnly: true, module: "core", distribution: "public-optional", postcondition: "Return one CSS snippet's text." },
  // Vault-global configuration, outside the note space a path scope describes.
  { tool: "obsidian_snippet_write", readOnly: false, module: "core", distribution: "private", refusesUnderScope: true, discovered: "none", postcondition: "Create or overwrite a CSS snippet.", protection: "exempt", protectionNote: "Temporarily exempt (Nelson's \"a\", 2026-09-29): ruled token when it overwrites, but it names no path and .obsidian/snippets has no revision the kernel can read; back to token with #427." },
  { tool: "obsidian_snippet_toggle", readOnly: false, module: "core", distribution: "private", refusesUnderScope: true, discovered: "none", postcondition: "Enable or disable a CSS snippet.", protection: "not-a-write" },
];

// ── Code Mode meta-tools ─────────────────────────────────────────────────────
// On a Code Mode connection these three REPLACE the whole surface. They
// register unguarded on purpose: guarding `obsidian_call_tool` itself would
// block reads wholesale in read-only mode. The captured target carries the
// guard instead, so enforcement lands on the call that actually does something.

const CODE_MODE: McpSurfaceRow[] = [
  { tool: "obsidian_search_tools", readOnly: true, module: "core", distribution: "public-default", postcondition: "Return captured tools matching a keyword, or all of them.", gate: "opts.codeMode", unguardedRegistration: "meta-tool; registers through origRegister so it is not itself guard-blocked" },
  { tool: "obsidian_describe_tool", readOnly: true, module: "core", distribution: "public-default", postcondition: "Return one captured tool's annotations and input schema.", gate: "opts.codeMode", unguardedRegistration: "meta-tool; registers through origRegister" },
  { tool: "obsidian_call_tool", readOnly: false, module: "core", distribution: "public-default", discovered: "unbounded", postcondition: "Invoke a captured tool by name; the target's own guard wrapper enforces read-only mode, scope, queue and journal.", gate: "opts.codeMode", unguardedRegistration: "dispatcher; registers through origRegister so it takes no queue slot and cannot deadlock on its own target", protection: "dispatcher" },
];

// ── module: scheme ───────────────────────────────────────────────────────────

const SCHEME: McpSurfaceRow[] = [
  { tool: "obsidian_schemes", readOnly: true, module: "scheme", distribution: "public-optional", postcondition: "Enumerate configured scheme instances, their capabilities and example addresses." },
  { tool: "obsidian_validate_name", readOnly: true, module: "scheme", distribution: "public-optional", postcondition: "Validate one filename against a scheme's grammar; reads nothing from the vault." },
  { tool: "obsidian_resolve_address", readOnly: true, module: "scheme", distribution: "public-optional", paths: ["path"], postcondition: "Resolve an address to visible path(s) or a path to its address; report duplicates without choosing." },
  { tool: "obsidian_next_address", readOnly: true, module: "scheme", distribution: "public-optional", postcondition: "Compute the next free address in a scope. Computes only — reserves nothing." },
  { tool: "obsidian_list_scope", readOnly: true, module: "scheme", distribution: "public-optional", postcondition: "List a scope's visible members in address order plus up to 20 open slots." },
  { tool: "obsidian_expected_location", readOnly: true, module: "scheme", distribution: "public-optional", paths: ["path"], postcondition: "Report whether a note or address is filed where its scheme expects." },
  // Owned by `scheme`, hand-registered in server.ts: the module host refuses a
  // registration whose readOnlyHint is not true.
  //
  // All three MOVE a note through `moveOne` -> `moveWithLinks`, which rewrites
  // OTHER notes' bodies to heal their links. So their blast radius is not in their arguments and they take
  // the `unbounded` default, exactly like `obsidian_move_note(s)`. Marking them
  // `none` would repeat the `obsidian_repoint_link` defect this table's own
  // header cites as the reason the optimistic default is wrong. (Their result
  // envelopes report `filesChanged: 1`, counting only the moved note — a
  // separate under-count, noted here rather than fixed in this PR.)
  { tool: "obsidian_assign_address", readOnly: false, module: "scheme", distribution: "public-optional", paths: ["path"], gate: "schemeModuleEnabled(ctx.getSettings())", postcondition: "Move a note to the next free address in a scope; never overwrites, because it always targets a free slot.", protection: "key", syncKind: "structure" },
  { tool: "obsidian_refile_address", readOnly: false, module: "scheme", distribution: "public-optional", paths: ["path"], gate: "schemeModuleEnabled(ctx.getSettings())", postcondition: "Move a note to the folder its own address expects, or report it already correct.", protection: "key", syncKind: "structure" },
  { tool: "obsidian_renumber_address", readOnly: false, module: "scheme", distribution: "public-optional", paths: ["path"], gate: "schemeModuleEnabled(ctx.getSettings())", postcondition: "Move a note to a specific address, optionally displacing the occupant first.", protection: "key", syncKind: "structure" },
];

// The four `obsidian_vocab*` rows, the two `base_*` rows and the two health
// rows were HERE until the S7 read-tier satellite extraction, for the same
// reason the six `vaultmcp_skills_*` rows left at S4, the two `triage_*` rows at
// S5 and the four `crosssession_*` rows at S6: all three are separate plugins
// now (`packages/vocab`, `packages/bases`, `packages/health`) publishing
// through the external-tool registry. On the wire they are
// `vaultmcp_vocab_{vocabularies,resolve_term,validate_terms,list_vocabulary}`,
// `vaultmcp_bases_{list,query}` and `vaultmcp_health_{scan,lint}` — the plugin id IS
// the tool namespace — and, like every external tool, they are outside this
// inventory by design.

// ── module: conformance-debt ─────────────────────────────────────────────────

const CONFORMANCE: McpSurfaceRow[] = [
  { tool: "obsidian_conformance_debt", readOnly: true, module: "conformance-debt", distribution: "public-optional", paths: ["folder"], postcondition: "Report carried conformance debt against the accepted baseline: burn-down, staleness, budget." },
  // NOT refusesUnderScope. Its refusal is CONDITIONAL — it checks whether the
  // computed register path is visible (`isVisible(notePath, settings)`) and
  // succeeds when the allowlist happens to cover that folder. `refusesUnderScope`
  // means "refuses outright whenever any scope is active", which is a stronger
  // and different claim.
  { tool: "obsidian_conformance_debt_render", readOnly: false, module: "conformance-debt", distribution: "public-optional", discovered: "none", postcondition: "Materialize the debt report as a generated register note beside the baseline, refusing when its computed path is outside the allowlist.", protection: "exempt", protectionNote: "Temporarily exempt (Nelson's \"a\", 2026-09-29): ruled token, but it names no path (it computes where the register goes), so an if_rev would refuse every run; back to token with #427." },
];

// The three `provenance_*` rows were HERE until the mutating-tier satellite
// extraction, for the same reason the read tier's rows left at S7: derived-
// content freshness is now a separate plugin (`packages/provenance`, id
// `vaultmcp-provenance`) publishing through the external-tool registry. Its tools
// are on the wire as `vaultmcp_provenance_check` / `_reconcile` / `_regen` — the
// plugin id IS the tool namespace — and, like every external tool, they are
// outside this inventory by design.

// ── module: survey ───────────────────────────────────────────────────────────

const SURVEY: McpSurfaceRow[] = [
  { tool: "obsidian_survey_status", readOnly: true, module: "survey", distribution: "public-optional", paths: ["path"], postcondition: "Report whether a note's filesystem-mirror section is stale." },
  // Regeneration with generated output, like the provenance satellite's regen.
  { tool: "obsidian_survey_slot", readOnly: false, module: "survey", distribution: "private", paths: ["path"], discovered: "none", postcondition: "Regenerate a note's Contents (Filesystem) section from a mirror root.", protection: "token" },
];

// The eight `fileclass_*` rows were HERE until the mutating-tier satellite
// extraction, and their D07 story is worth keeping because it was a RULING
// rather than a reading. D07 names "Fileclass inspection and named
// representation proposals" as public-optional, while the implementation
// proxies an external CLI binary through execFile — which threat-model control
// #9 keeps out of the public surface. The tension was put to Nelson with both
// readings stated and he chose PRIVATE (2026-08-21). That ruling stands and now
// applies to a whole plugin rather than a module: `packages/fileclass`, id
// `vaultmcp-fileclass`, publishing eight `vaultmcp_fileclass_*` tools through the
// external-tool registry, outside this inventory like every external tool.

// The six `vaultmcp_skills_*` rows were HERE until the S4 satellite extraction.
// This inventory describes THIS PLUGIN's surface, and the skills compiler is
// now a separate plugin (`packages/skills`, id `vaultmcp-skills`) that publishes
// its tools through the external-tool registry like any third-party publisher.
// External tools are deliberately outside this inventory: they are not ours to
// declare, and the surface scan that pins this file against the source would
// find no registration for them here.

// The four `crosssession_*` rows were HERE until the S6 satellite extraction,
// for the same reason the six `vaultmcp_skills_*` rows left at S4 and the two
// `triage_*` rows at S5: fleet coordination is now a separate plugin
// (`packages/crosssession`, id `vaultmcp-crosssession`) publishing through the
// external-tool registry. Its tools are on the wire as
// `vaultmcp_crosssession_channels` / `_delta` / `_attest` / `_post` — the plugin
// id IS the tool namespace — and, like every external tool, they are outside
// this inventory by design.

// The seven `obsidian_jd_*` rows were HERE until the mutating-tier satellite
// extraction: JD scaffolding is now a separate plugin (`packages/jd-scaffold`,
// id `vaultmcp-jd-scaffold`) publishing through the external-tool registry. Their
// rename was the one in the whole split that was FORCED rather than chosen —
// `external-tools.ts` refuses a published name beginning `obsidian_`, so the
// seven are on the wire as `vaultmcp_jd_scaffold_*`. That is also why their
// departure shrinks the `obsidian_*` family this inventory declares.

// The two `triage_*` rows were HERE until the S5 satellite extraction, for the
// same reason the six `vaultmcp_skills_*` rows left at S4: inbox triage is now a
// separate plugin (`packages/triage`, id `vaultmcp-triage`) publishing through the
// external-tool registry. Its tools are on the wire as `vaultmcp_triage_queue` /
// `vaultmcp_triage_dispose` — the plugin id IS the tool namespace — and, like every
// external tool, they are outside this inventory.

/** Every declared MCP surface, in one list. */
export const MCP_SURFACE_INVENTORY: McpSurfaceRow[] = [
  ...CORE_FS,
  ...CORE_DIRECT,
  ...NAV,
  ...INTEGRATIONS,
  ...CLI,
  ...SNIPPETS,
  ...CODE_MODE,
  ...SCHEME,
  ...CONFORMANCE,
  ...SURVEY,
];

/**
 * Third-party publishing is ONE surface with a runtime-computed name set.
 *
 * A publisher's tools are `${sanitizedOwnerId}_${name}` and cannot be
 * enumerated statically, so the inventory registers the PUBLISHING MECHANISM
 * rather than pretending to know its output. What the registry can still
 * assert is the guard posture: an external read-only claim is disbelieved
 * unless the publisher is explicitly trusted, and a pathless external mutation
 * is refused under an active scope because it cannot be bounded honestly.
 */
export const EXTERNAL_PUBLISHER_ROW: McpSurfaceRow = {
  tool: "external-publisher",
  readOnly: false,
  module: "core",
  distribution: "public-default",
  discovered: "unbounded",
  refusesUnderScope: true,
  postcondition:
    "Project another plugin's published actions as client capabilities, treating every read-only claim as mutating unless its publisher is explicitly trusted.",
  gate: "a third-party plugin calls app.plugins.plugins['vault-mcp'].api.registerTools",
  protection: "external",
};

function specOf(row: McpSurfaceRow): CompatibilitySpec {
  return {
    surface: row.tool,
    postcondition: row.postcondition,
    owner: row.module,
    distribution: row.distribution,
    readOnly: row.readOnly,
    paths: row.paths,
    discovered: row.discovered,
    refusesUnderScope: row.refusesUnderScope,
    gate: row.gate,
  };
}

/** Every native action a surface binds. */
const NATIVE_ACTIONS: ActionDefinition[] = [NOTE_READ_V1, NOTE_WRITE_V1];

/** The action for every declared MCP surface: derived, unless the row names a native one. */
export function mcpCompatibilityActions(): ActionDefinition[] {
  const derived = [...MCP_SURFACE_INVENTORY, EXTERNAL_PUBLISHER_ROW]
    .filter((row) => !row.nativeAction)
    .map((row) => compatibilityAction(specOf(row)));
  return [...NATIVE_ACTIONS, ...derived];
}

/** How many surfaces still run on a derived contract — the migration debt in one number, so it can be watched rather than estimated. */
export function migrationDebt(): { native: number; derived: number } {
  const native = MCP_SURFACE_INVENTORY.filter((r) => r.nativeAction).length;
  return { native, derived: MCP_SURFACE_INVENTORY.length - native };
}

/** The MCP binding for every declared surface. */
export function mcpSurfaceBindings(): SurfaceBinding[] {
  return [...MCP_SURFACE_INVENTORY, EXTERNAL_PUBLISHER_ROW].map((row) => ({
    kind: "mcp" as const,
    id: row.tool,
    action: row.nativeAction ? row.nativeAction.id : `compat.${row.tool}`,
    actionVersion: row.nativeAction ? row.nativeAction.version : 1,
    ...(row.unguardedRegistration ? { note: row.unguardedRegistration } : {}),
  }));
}
