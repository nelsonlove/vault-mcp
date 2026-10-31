// tools.ts — the vaultmcp-skills satellite's tool surface. Six tools, published to
// the Vault MCP host through `vault-mcp-api` (see main.ts):
//
//   vaultmcp_skills_validate — collect + transform, report errors/warnings/counts (read-only)
//   vaultmcp_skills_tree     — the agent/skill hierarchy (read-only)
//   vaultmcp_skills_preview  — the compiled output diffed against the export dir (read-only)
//   vaultmcp_skills_export   — materialize the Claude Code plugin to disk (mutating)
//   vaultmcp_skills_release  — export into a repo dir + stamp a version (mutating)
//   vaultmcp_skills_mark     — mark a note skill/agent/policy/command in its frontmatter (mutating)
//
// THE PUBLISHED NAMES ARE UNCHANGED. Each spec's `name` here is the bare half
// (`validate`, `tree`, …); the host publishes it as `<sanitized plugin id>_<name>`,
// and this plugin's id is `vaultmcp-skills`, which sanitizes to `vaultmcp_skills`. So
// the wire names stay exactly `vaultmcp_skills_validate` … `vaultmcp_skills_mark`.
// That is deliberate and load-bearing: renaming shipped tool names breaks agent
// sessions for zero semantic gain (the host's own locked-decision precedent for
// `governance_revisions` / `governance_submit_revision`).
//
// The three read tools compile the vault through the pure exporter core
// (./kernel/*, Obsidian-free over an injected SkillsSource). The export
// product stays MATERIALIZE-TO-DISK — the tool triggers a write to the
// configured output dir; Claude Code loads the skills off disk. That contract
// is unchanged from the standalone plugin and from the folded-into-the-host era.
//
// ── Envelope convention (the satellite contract) ─────────────────────────────
//
// A handler returns PLAIN DATA and THROWS on refusal. The host wraps the return
// value in `ok()` and a thrown error in `fail()`, so the envelopes agents see
// are byte-compatible with the folded era's — but the `ok`/`fail` helpers
// themselves are host-internal and no longer imported here.
//
// ── The one load-bearing security requirement (accept guard) ─────────────────
//
// `vaultmcp_skills_mark` writes note frontmatter, so it MUST route through the
// accept-forbidden guard like every other vault write: a skills-mark can NOT
// introduce or change an `accepted` / `accepted-by` / `accepted-on` field, or
// set `acceptance-status` to an accepted value. Acceptance is a human gesture
// only, in no API. This plugin contributes NO accept/approve tool, and the mark
// path runs the SAME `acceptTransitionReason` predicate the fs / Obsidian write
// primitives use (@vault-mcp/core), in `guardSkillsMark` below — pinned by
// tests/skills-module.test.mjs. Extraction did not weaken it: the predicate is
// a published core contract, not a host-private one.
//
// Obsidian-free by construction: vault state arrives through the injected
// SkillsBackend (structurally typed), so every handler and the mark guard are
// unit-testable headlessly. The Obsidian adapter is `obsidianSkillsBackend(app)`
// — the only vault coupling for skills.

import { z } from "zod";
import type { SdkToolSpec } from "vault-mcp-api";
import { AcceptForbiddenError, acceptTransitionReason, isVisible, type GuardSettings } from "@vault-mcp/core";
import {
  analyzeVault,
  previewVault,
  runExport,
  readPluginVersion,
  markFrontmatter,
  applyMark,
  skillsConfigOf,
  fieldsOf,
  expandTilde,
  type DetectConfig,
  type EmbedLookup,
  type MarkInput,
  type MarkResult,
  type SkillsSource,
  type SourceNote,
} from "./kernel/index.js";

/** The read tools' SDK flags. `readOnly: true` is a CLAIM the host distrusts by
 * default (an external tool's read-only hint is believed only when the raw
 * publisher id is listed in the host's `trustedReadOnlyPlugins`), which is why
 * the allowlist posture below is what it is. */
const RO = { readOnly: true, destructive: false, idempotent: true } as const;
/** The write tools' SDK flags. Omitting `readOnly` would mean the same thing —
 * spelling it out keeps the three-read / three-write split legible. */
const RW = { readOnly: false, destructive: false, idempotent: false } as const;

/** The write half of the skills backend — what `vaultmcp_skills_mark` needs on
 * top of the read-only SkillsSource. Kept structural (no `obsidian` import) so
 * the handler stays headless-testable against a fake. */
export interface SkillsWriter {
  /** The note's current frontmatter (metadata cache), or null when it has none
   * / is absent — the BEFORE the accept-transition guard compares against. */
  frontmatterOf(path: string): Record<string, unknown> | null;
  /** True when a file exists at this vault-relative path. */
  exists(path: string): boolean;
  /** Apply a mutator to the note's frontmatter (Obsidian processFrontMatter). */
  applyFrontmatter(path: string, mutate: (fm: Record<string, unknown>) => void): Promise<void>;
}

/** The full backend the skills tools drive: the exporter's read seam plus the
 * mark write primitive. */
export type SkillsBackend = SkillsSource & SkillsWriter;

export interface SkillsToolsCtx {
  /** This plugin's own config record (defaults ∪ the user's settings tab
   * values). Read per CALL, not captured, so a settings change lands on the
   * next tool call rather than on the next Obsidian reload. */
  config: () => Record<string, unknown>;
  /**
   * The HOST's guard settings, if a caller can supply them.
   *
   * NOTHING SUPPLIES THEM IN THE SATELLITE, deliberately, and that is not an
   * oversight — see the allowlist-posture note at the bottom of this file and
   * the README. A satellite cannot reach the host's settings, so this is left
   * as the defence-in-depth seam it always was: absent ⇒ the filter degrades
   * through the SAME `!settings ||` branch the folded code already had, and the
   * host's external-tool gate is the enforced boundary. Tests supply it, and a
   * future `vault-mcp-api` that carries scope to publishers will supply it for
   * real without any change to the filter below.
   */
  getSettings?: () => GuardSettings;
}

/** The Obsidian adapter — the ONLY vault coupling for skills in vault-mcp.
 * Duck-typed against `app` (no `obsidian` import), like `obsidianVocabSource`
 * / `obsidianLinkSource`, so this file stays headless-testable. */
export function obsidianSkillsBackend(app: {
  vault: {
    getMarkdownFiles(): Array<{ path: string; extension?: string }>;
    getAbstractFileByPath(path: string): unknown;
    cachedRead(file: unknown): Promise<string>;
    // `unknown` (narrowed in basePath) rather than a structural shape: an
    // all-optional `{ getBasePath?: () => string }` is a WEAK type TS refuses
    // to match against Obsidian's DataAdapter (no shared properties).
    adapter?: unknown;
  };
  metadataCache: {
    getFirstLinkpathDest(linkpath: string, from: string): { path: string; extension: string } | null;
    getFileCache(file: unknown): { frontmatter?: Record<string, unknown> } | null;
    getCache(path: string): { frontmatter?: Record<string, unknown> } | null;
  };
  fileManager: { processFrontMatter(file: unknown, fn: (fm: Record<string, unknown>) => void): Promise<void> };
}): SkillsBackend {
  const embed: EmbedLookup = async (linkpath, fromPath) => {
    const dest = app.metadataCache.getFirstLinkpathDest(linkpath, fromPath);
    if (!dest || dest.extension !== "md") return null;
    // The cache's frontmatter rides along (null when the cache holds none), so
    // the acceptance gate judges an embed target by the same reader `notes()`
    // uses for a compile unit — one note, one answer, whichever way it enters.
    return { path: dest.path, content: await app.vault.cachedRead(dest), frontmatter: app.metadataCache.getFileCache(dest)?.frontmatter ?? null };
  };
  return {
    async notes(): Promise<SourceNote[]> {
      const out: SourceNote[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
        const body = frontmatter ? await app.vault.cachedRead(file) : "";
        out.push({ path: file.path, frontmatter, body });
      }
      return out;
    },
    resolveLink(linkpath, fromPath) {
      const dest = app.metadataCache.getFirstLinkpathDest(linkpath, fromPath);
      return dest ? dest.path : null;
    },
    embed,
    basePath() {
      const adapter = app.vault.adapter as { getBasePath?: () => string } | undefined;
      return typeof adapter?.getBasePath === "function" ? adapter.getBasePath() : null;
    },
    frontmatterOf(path) {
      return app.metadataCache.getCache(path)?.frontmatter ?? null;
    },
    exists(path) {
      const f = app.vault.getAbstractFileByPath(path);
      return !!f && typeof f === "object" && "extension" in (f as object);
    },
    async applyFrontmatter(path, mutate) {
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error(`not found: ${path}`);
      await app.fileManager.processFrontMatter(file, mutate);
    },
  };
}

/**
 * The accept-forbidden guard for `vaultmcp_skills_mark`, pure and headless.
 *
 * Computes the frontmatter the mark WOULD land (BEFORE with the mark applied)
 * and runs the shared `acceptTransitionReason` predicate: a mark that
 * introduces or changes an `accepted`-family key, or sets `acceptance-status`
 * to an accepted value the note did not already hold, throws
 * `AcceptForbiddenError` — nothing is written. Carrying an existing
 * human-granted accepted value forward UNCHANGED is allowed (the same
 * transition rule ObsidianBackend's write primitive applies). Returns the
 * MarkResult to apply when the transition is clean.
 */
export function guardSkillsMark(
  before: Record<string, unknown>,
  input: MarkInput,
  fields: DetectConfig,
): MarkResult {
  const result = markFrontmatter(input, fields);
  // Clone BEFORE so computing the after-image never mutates the caller's
  // frontmatter (applyMark reassigns `tags` and Object.assigns `set`).
  const after: Record<string, unknown> = {
    ...before,
    ...(Array.isArray(before.tags) ? { tags: [...(before.tags as unknown[])] } : {}),
  };
  applyMark(after, result);
  const reason = acceptTransitionReason(before, after);
  if (reason) throw new AcceptForbiddenError(reason);
  return result;
}

/**
 * The six tool specs, ready for `publishTools`. Config is read PER CALL through
 * `ctx.config()` — the host holds a spec snapshot per connection, so capturing
 * the config here would freeze the settings tab's values at plugin load.
 */
export function buildSkillsTools(source: SkillsBackend, ctx: SkillsToolsCtx): SdkToolSpec[] {
  /** The typed config + derived detection config, resolved fresh for one call. */
  const resolve = () => {
    const cfg = skillsConfigOf(ctx.config());
    return { cfg, fields: fieldsOf(cfg) };
  };

  return [
  {
    name: "validate",
    description:
      "Collect skill/agent/policy/command notes and run the transform without writing. Returns errors, warnings, " +
      "counts, multi-parent attachments (first parent is primary, the rest are recorded attachments), and each " +
      "agent's preload set — the `skills:` frontmatter the export would emit, which preloads content rather than " +
      "restricting access. Read-only.",
    inputSchema: {},
    ...RO,
    handler: async () => {
      const { cfg, fields } = resolve();
      const a = await analyzeVault(source, fields, cfg.pluginName, cfg.preloadCap);
      return {
        ok: a.errors.length === 0, errors: a.errors, warnings: a.warnings, counts: a.counts, excluded: a.excluded,
        attachments: a.attachments, preloads: a.preloads, preloadCap: a.preloadCap,
      };
    },
  },

  {
    name: "tree",
    description:
      "Return the current agent/skill hierarchy (name, kind, primary parent, level, owned skills, children, plus " +
      "any extra-parent attachments and preload flags). Read-only.",
    inputSchema: {},
    ...RO,
    handler: async () => {
      const { cfg, fields } = resolve();
      const a = await analyzeVault(source, fields, cfg.pluginName, cfg.preloadCap);
      return { tree: a.tree, counts: a.counts, excluded: a.excluded, attachments: a.attachments, preloads: a.preloads };
    },
  },

  {
    name: "preview",
    description:
      "Run the transform without writing and diff it against the current export. No args: a manifest of every file " +
      "the export would write plus removed files, diff counts, and policy placements. `name`: return one entry " +
      "(matched by generated name, output path, or source note path) with its full compiled content. `content: " +
      "true`: include full compiled content for every entry (large). Read-only.",
    inputSchema: {
      name: z.string().optional().describe("Generated name, output path, or source note path of one entry to return in full."),
      content: z.boolean().optional().describe("Include full compiled content for every entry (large)."),
    },
    ...RO,
    handler: async (args: Record<string, unknown>) => {
      const name = args.name as string | undefined;
      const content = args.content as boolean | undefined;
      {
        const { cfg, fields } = resolve();
        const p = await previewVault(source, {
          outputDir: expandTilde(cfg.outputDir), pluginName: cfg.pluginName, fields, preloadCap: cfg.preloadCap,
        });
        // (the block scope above simply keeps `cfg`/`fields` local to the compile)
        const summary = {
          diff: p.diff, removed: p.removed, policies: p.policies,
          attachments: p.attachments, preloads: p.preloads, preloadCap: p.preloadCap,
          errors: p.errors, warnings: p.warnings, counts: p.counts, excluded: p.excluded,
          outputDir: p.outputDir, assetsNote: p.assetsNote,
        };
        // THE COMPILE is whole-vault and must stay that way (parent edges span
        // the tree, so a partial compile produces a broken plugin). What must
        // NOT be whole-vault is the CONTENT this hands back: an entry's
        // `content` is the compiled body of its SOURCE NOTE, so returning it
        // for a note outside the caller's allowlist is the same read-boundary
        // leak `obsidian_search_notes` once had. Manifest rows stay — they are
        // structure, and the counts have to add up — but bodies are filtered.
        //
        // ── ALLOWLIST POSTURE AFTER THE SATELLITE EXTRACTION (read this) ──────
        //
        // This filter is now DEFENCE IN DEPTH, not the enforced boundary, and
        // in the shipped configuration it does nothing at all — `ctx.getSettings`
        // is undefined, so `pathVisible` is unconditionally true, exactly the
        // `!settings ||` degradation the folded code already had.
        //
        // The enforced boundary moved to the HOST, and it is STRICTER than this
        // filter ever was. An external tool's `readOnlyHint: true` is a claim the
        // host distrusts unless the raw publisher id is in `trustedReadOnlyPlugins`,
        // so all six of these register as MUTATING; and an external tool —
        // TRUSTED OR NOT — whose arguments carry no recognized path key is
        // BLOCKED OUTRIGHT while a path allowlist is active. The trusted case
        // was a real hole this extraction's review found: trust used to exempt
        // a read-only pathless tool from that block, so trusting this publisher
        // would have reopened the hidden-body leak. The host now scopes by what
        // it can check, never by who is asking. `preview` takes `name`/`content`, neither a
        // path key — so under an allowlist it is refused wholesale rather than
        // body-filtered. Fail-closed, one owner, no partial answer.
        //
        // NOTHING BELOW WAS DELETED, deliberately. The assembled-body reasoning
        // (transclusions, injected policies, the "(static)" marker) is the
        // expensive part and it is correct; it becomes live again the moment
        // `vault-mcp-api` can carry the caller's scope to a publisher, which is
        // an apiVersion-2 item. A satellite cannot reach the host's settings
        // today, and faking them would be worse than having none.
        const settings = ctx.getSettings?.();

        // A compiled entry's `content` is ASSEMBLED, not copied — so checking
        // the entry's own `from` is not enough, and the first version of this
        // filter got that wrong. Three notes can contribute bytes to one body:
        //
        //   1. the entry's own source note (`from`);
        //   2. every note it TRANSCLUDES — `![[Other]]` inlines that note's
        //      stripped body verbatim, and those paths are collected in
        //      `sources`. A target the acceptance gate REFUSED is in `sources`
        //      too, though none of its bytes are (it stays a source so that
        //      accepting it later re-runs the export); this filter then hides
        //      the entry for a note that contributed nothing, which is the
        //      fail-closed direction and is left so on purpose;
        //   3. every `type: policy` note injected into an AGENT's definition —
        //      the policy's full body is appended, and the policy's path is
        //      NOT in `sources`. `p.policies` records which genNames each
        //      policy landed in, which is the only place that edge is visible.
        //
        // So a sandboxed session could author a visible note transcluding a
        // hidden one, or park a policy at a hidden path under a visible agent,
        // and read the hidden bytes straight back out of the compiled body.
        // All three contributors must be visible before a body is returned.
        //
        // `(static)` is the exporter's marker for its own compiled-in files
        // (exporter.ts) — not a vault path, so it can never be "visible", and
        // treating it as a real path silently made the plugin's own shipped
        // content unpreviewable under any allowlist.
        const pathVisible = (path: string | undefined): boolean =>
          !settings || !path || path === "(static)" || isVisible(path, settings);

        // genNames whose compiled body carries a policy from outside the allowlist.
        const tainted = new Set<string>();
        for (const pol of p.policies ?? []) {
          if (!pathVisible(pol.path)) for (const a of pol.agents ?? []) tainted.add(a);
        }

        const sourceVisible = (e: { from?: string; name?: string; sources?: string[] }): boolean =>
          pathVisible(e.from) &&
          (e.sources ?? []).every(pathVisible) &&
          !(e.name !== undefined && tainted.has(e.name));

        if (name) {
          const entry = p.entries.find((x) => x.name === name || x.relOut === name || x.from === name);
          // A hidden source reads as NOT FOUND rather than refused, matching how
          // uid addressing decides (0 visible candidates ⇒ unresolved):
          // a distinct "forbidden" answer would confirm the note exists.
          if (!entry || !sourceVisible(entry)) {
            throw new Error(`no preview entry matches "${name}" — try a generated name, output path, or source note path`);
          }
          return { entry, ...summary };
        }
        const entries = p.entries.map((e) => {
          const { cachedContent: _cached, content: full, ...rest } = e;
          return content && sourceVisible(e) ? { ...rest, content: full } : rest;
        });
        return { entries, ...summary };
      }
    },
  },

  {
    name: "export",
    description:
      "Write skills/agents to the configured output dir. Then run /reload-plugins in Claude Code to load. Mutating.",
    inputSchema: {},
    ...RW,
    handler: async () => {
      const { cfg, fields } = resolve();
      const summary = await runExport(source, {
        outputDir: expandTilde(cfg.outputDir), pluginName: cfg.pluginName, fields,
        assetsRoot: expandTilde(cfg.assetsRoot), preloadCap: cfg.preloadCap,
      });
      return {
        skills: summary.skills, agents: summary.agents, commands: summary.commands,
        assets: summary.assets, removed: summary.removed,
        errors: summary.errors, warnings: summary.warnings, excluded: summary.excluded, outputDir: summary.outputDir,
        note: "Run /reload-plugins in Claude Code to load the changes.",
      };
    },
  },

  {
    name: "release",
    description:
      "Export the full plugin into a git checkout (the configured release repo dir, or an explicit dir) and stamp " +
      "the given version into .claude-plugin/plugin.json. Does not commit, tag, or push. Mutating.",
    inputSchema: {
      version: z.string().regex(/^\d+\.\d+\.\d+$/).describe("Release version (semver, e.g. 1.2.0)."),
      dir: z.string().optional().describe("Target repo directory; defaults to the release repo dir from settings."),
    },
    ...RW,
    handler: async (args: Record<string, unknown>) => {
      const version = args.version as string;
      // Re-validated HERE, not only in the zod schema above: these specs cross
      // the host boundary as JSON Schema, and the host's json-schema-to-zod
      // subset drops `pattern`/`minLength` — so the schema's regex never runs
      // for an MCP caller. Without this line `{version: "garbage"}` stamped
      // "garbage" into plugin.json (found by the satellite extraction's review).
      if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
        throw new Error(`version must be semver (\d+.\d+.\d+), got: ${String(version)}`);
      }
      const dir = args.dir as string | undefined;
      const { cfg, fields } = resolve();
      const releaseDir = expandTilde(dir ?? cfg.releaseDir);
      if (!releaseDir) throw new Error("no release dir: pass `dir` or set the release repo directory in the Vault Skills settings");
      const previous = readPluginVersion(releaseDir) ?? null;
      const summary = await runExport(source, {
        outputDir: releaseDir, pluginName: cfg.pluginName, fields,
        assetsRoot: expandTilde(cfg.assetsRoot), version, preloadCap: cfg.preloadCap,
      });
      return {
        version, previous,
        skills: summary.skills, agents: summary.agents, commands: summary.commands,
        assets: summary.assets, removed: summary.removed,
        errors: summary.errors, warnings: summary.warnings, excluded: summary.excluded, outputDir: summary.outputDir,
        note: "Packaged only — commit & tag in the repo to publish.",
      };
    },
  },

  {
    name: "mark",
    description:
      "Mark an existing note as a skill/agent/policy/command, honoring the vault's detection mode: in frontmatter " +
      "mode it sets the `type` field; in tags mode it appends the configured kind tag. Parent/description are " +
      "written as frontmatter either way (commands are flat — any parent is ignored and a stale one is cleared). " +
      "Does not create the note. Mutating — and, like every write, it can never set an acceptance field.",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative path of the note to mark."),
      type: z.enum(["skill", "agent", "policy", "command"]),
      parent: z.string().optional().describe("Parent agent basename or [[wikilink]]; omit for root. Ignored for commands."),
      description: z.string().optional(),
    },
    ...RW,
    handler: async (args: Record<string, unknown>) => {
      const p = args.path as string;
      const type = args.type as MarkInput["type"];
      const parent = args.parent as string | undefined;
      const description = args.description as string | undefined;
      const { fields } = resolve();
      if (!source.exists(p)) throw new Error(`not found: ${p}`);
      const before = source.frontmatterOf(p) ?? {};
      // Accept-forbidden guard: refuses a mark whose resulting frontmatter
      // would introduce/change an acceptance assertion — nothing is written.
      const result = guardSkillsMark(before, { type, parent, description }, fields);
      await source.applyFrontmatter(p, (fm) => applyMark(fm, result));
      return { marked: p, type, parent: parent ?? null };
    },
  },
  ];

  // THE COMPILE is whole-vault and stays that way: parent edges span the tree,
  // so a partial compile produces a broken plugin. `validate` and `tree` return
  // structural summaries over that whole-vault compile and are unfiltered by
  // design — they name paths, they do not return note bodies.
  //
  // `preview` is the one that returns CONTENT, and since 2026-08-29 it filters
  // bodies by the source note's visibility. Before that it did not, and
  // `ctx.getSettings` sat on the context declared-but-never-called while
  // `{name: "<any source note path>"}` returned that note's full compiled body
  // regardless of the allowlist — the same shape as the `obsidian_search_notes`
  // leak that motivated the read-boundary sweep. Since the satellite extraction
  // that filter is defence in depth and the HOST's external-tool gate is the
  // enforced boundary (see the long note inside `preview`). If you add another
  // tool here that returns bodies, filter it the same way anyway; if it returns
  // only structure, it does not need to.
  //
  // The mutating surface is gated by the host at its external-tool registration:
  // read-only mode blocks all six (none of them is a TRUSTED read-only claim),
  // an active path allowlist blocks the five with no path argument outright, and
  // `mark` — the one that names a `path` — is scoped by the guard on that path
  // and accept-guarded here, before any write.
}
