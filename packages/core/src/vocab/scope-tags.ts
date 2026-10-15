// scope-tags.ts — the scope-tags VocabularyProvider: the vault's tags as the
// `## Tags` tables on its scope notes declare them, with chain inheritance.
//
// The model is the vault spec's (01.13 Tags & vocabulary, rules 2, 5a, 6 and
// 6a; 01.21 Scopes & scope notes, rule 3 as amended 2026-10-14). It replaced the
// #251 model this file first served (`Meta/Tag` registry notes plus an
// `allowedTags` frontmatter key on each scope note, under a vault-root
// `The system.md`), which the vault retired: measured 2026-10-14, zero
// `Meta/Tag` notes, zero live `allowedTags` keys, no `The system.md` (#551).
//
//   1. DECLARATION — each scope or slot note (a folder note, `A/B/B.md`)
//      declares the tags it owns in a `## Tags` section holding a two-column
//      table: tag and description. The tables are the ONLY place a tag is
//      declared (rule 6a: a hand-kept allowed set is a second authority and
//      loses). A row is EXACT: `person` declares `person`, nothing below it. A
//      row written `head/*` declares the family: every token under `head/`,
//      but not the bare head (rule 5c: a head is never assigned on its own).
//   2. EXISTENCE — a tag exists iff some row anywhere in the listing declares
//      it, exactly or through a family row.
//   3. PLACEMENT — a note's allowed set is the UNION of the tables met walking
//      its folder chain to the root (its own folder's note, each ancestor's,
//      then the root scope note). The root scope note is the folder note of
//      category 00 (`00 System management`), which claims the whole vault by
//      declaration rather than by folder (01.21 rule 3, the one exception to
//      "a scope note claims its folder"), so its table — the families every
//      note may carry — joins every chain.
//
// THE ROOT IS THE SWITCH (01.21 rule 3): a vault with no root scope note has
// no scoping. So with `rootNote` configured and absent from the listing, no
// per-note finding fires — and `registryFindings` reports `scope_root_missing`
// instead, so a dead root path is LOUD (the glossary `termsRoot` went dead
// silently three times; this must not).
//
// Every vault-semantic value is CONFIG (ScopeTagsConfig) with today's live
// shapes as defaults. Kernel-module rules: pure, no `obsidian` imports, no
// I/O; the tool layer feeds the listing (visible-filtered before anything is
// read, scope-note BODIES included — see `isScopeTagsSource`) and the provider
// never reads the vault itself. Report-first: findings are data; curation
// stays human.

import {
  VocabAmbiguousError,
  asStrings,
  type VocabCapabilities,
  type VocabEntry,
  type VocabFinding,
  type VocabKind,
  type VocabularyProvider,
} from "./provider.js";
import type { VocabNote } from "./blueprint.js";
import { stripLeadingFrontmatter } from "../accept-guard.js";

export interface ScopeTagsConfig {
  /** Vault-relative path of the root scope note, whose table joins every
   * chain; "" = no root scope note (scoping is then on whenever any table is
   * declared, and no table is vault-wide). */
  rootNote: string;
  /** The H2 heading text whose first table declares a scope's tags. */
  tagsHeading: string;
}

/** Today's live shapes (read from the vault 2026-10-14, #551): the root scope
 * note is the folder note of category 00; the tables sit under `## Tags`. */
export const DEFAULT_SCOPE_TAGS_CONFIG: ScopeTagsConfig = {
  rootNote: "00-09 System/00 System management/00 System management.md",
  tagsHeading: "Tags",
};

/** Settings hygiene, the scheme registry's pattern (`validateJdConfig`): a
 * problems list, empty when the config is usable. Unknown keys are ignored —
 * partial overrides merge over the defaults. The retired #251 keys
 * (`registryClass`, `tagKey`, `allowedTagsKey`) are unknown keys now: ignored,
 * not refused, so an old row keeps working on the new model. */
export function validateScopeTagsConfig(config: unknown): string[] {
  if (config === undefined) return [];
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return ["config must be an object"];
  }
  const problems: string[] = [];
  const c = config as Record<string, unknown>;
  if ("tagsHeading" in c && c.tagsHeading !== undefined && (typeof c.tagsHeading !== "string" || c.tagsHeading.trim() === "")) {
    problems.push("tagsHeading must be a non-empty string");
  }
  if ("rootNote" in c && c.rootNote !== undefined && typeof c.rootNote !== "string") {
    problems.push(`rootNote must be a string ("" for no root scope note)`);
  }
  return problems;
}

/** The effective config of one instance: its `config` over the defaults. The
 * tool layer uses it too, to decide which bodies to read. */
export function resolveScopeTagsConfig(config: Record<string, unknown> | undefined): ScopeTagsConfig {
  const c = config ?? {};
  return {
    rootNote: typeof c.rootNote === "string" ? c.rootNote : DEFAULT_SCOPE_TAGS_CONFIG.rootNote,
    tagsHeading:
      typeof c.tagsHeading === "string" && c.tagsHeading.trim() !== ""
        ? c.tagsHeading.trim()
        : DEFAULT_SCOPE_TAGS_CONFIG.tagsHeading,
  };
}

/** The provider plus the declaration-level findings the whole-vault rule pack
 * needs (per-note findings ride the optional `noteFindings` seam every
 * provider may implement). */
export interface ScopeTagsProvider extends VocabularyProvider {
  /** `scope_root_missing`, `tag_declared_twice_on_chain`,
   * `tag_declared_on_two_branches` — findings about the tables themselves,
   * independent of any note's use. */
  registryFindings(): VocabFinding[];
}

/** One table row as declared. */
interface Declaration {
  /** The token as written, `#` and backticks stripped: `note/task`, `note/*`. */
  token: string;
  /** For a family row (`head/*`), the head (`head`); null for an exact row. */
  family: string | null;
  description: string;
  /** The scope note declaring it. */
  path: string;
  /** The folder it speaks for ("" for the root scope note). */
  folder: string;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function underRoot(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(root + "/");
}

/** `` `#note/task` `` → `note/task`. */
function cleanTag(cell: string): string {
  return cell.trim().replace(/^`+|`+$/g, "").trim().replace(/^#/, "").trim();
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The rows of the first table under the `## <heading>` H2: `[{ tag,
 * description }]`. The same reading as the vault's own `scope-tags.js`
 * (00.13 Scripts), so the satellite and the vault's renderer cannot disagree
 * about a table: the section ends at the next H1/H2, the table at its first
 * non-table line; the header row and the `---` separator are skipped; fenced
 * code is ignored; an empty tag cell is no row. A leading frontmatter block is
 * stripped first, so a raw file and a bare body parse alike.
 */
export function parseTagsTable(body: string, heading: string = DEFAULT_SCOPE_TAGS_CONFIG.tagsHeading): Array<{ tag: string; description: string }> {
  const lines = stripLeadingFrontmatter(String(body)).split(/\r?\n/);
  const head = new RegExp(`^##[ \\t]+${escapeRegExp(heading)}[ \\t]*$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return [];
  const rows: Array<{ tag: string; description: string }> = [];
  let inFence = false;
  let inTable = false;
  let header = true;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (inTable) break;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,2}[ \t]/.test(line)) break;
    if (!/^\s*\|/.test(line)) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (header) {
      header = false;
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const tag = cleanTag(cells[0] ?? "");
    if (!tag) continue;
    rows.push({ tag, description: (cells[1] ?? "").trim() });
  }
  return rows;
}

/** The folder a note is the scope note OF: the configured root note speaks
 * for "" (the whole vault), a folder note (`A/B/B.md`) for its folder. Null
 * for every other note — a `## Tags` table on a non-folder-note declares
 * nothing. */
function scopeFolderOf(path: string, rootNote: string): string | null {
  if (rootNote !== "" && path === rootNote) return "";
  const i = path.lastIndexOf("/");
  if (i === -1) return null;
  const folder = path.slice(0, i);
  return path.slice(i + 1) === basename(folder) + ".md" ? folder : null;
}

/** Is `path` a note whose BODY the scope-tags provider reads — the root scope
 * note or a folder note? The tool layer reads exactly these bodies, never the
 * whole vault. */
export function isScopeTagsSource(path: string, rootNote: string): boolean {
  return scopeFolderOf(path, rootNote) !== null;
}

/** Every folder above `path`, nearest first, ending with "" (the vault root,
 * which the root scope note speaks for): `a/b/c.md` → ["a/b", "a", ""]. */
function chainFolders(path: string): string[] {
  const segs = path.split("/");
  segs.pop();
  const out: string[] = [];
  for (let n = segs.length; n >= 1; n--) out.push(segs.slice(0, n).join("/"));
  out.push("");
  return out;
}

/** `a` is `b` or an ancestor of it ("" is everyone's ancestor). */
function onChain(a: string, b: string): boolean {
  return a === "" || a === b || b.startsWith(a + "/");
}

/** Folder depth: "" (the root's) is 0. */
const depth = (folder: string): number => (folder === "" ? 0 : folder.split("/").length);

/** Does the declaration admit `tag`? Exact rows admit themselves; a family
 * row admits every token under its head, not the head itself. */
function admits(d: Declaration, tag: string): boolean {
  return d.family === null ? d.token === tag : tag.startsWith(d.family + "/");
}

export function scopeTagsProvider(cfg: ScopeTagsConfig, listing: VocabNote[]): ScopeTagsProvider {
  const config = resolveScopeTagsConfig(cfg as unknown as Record<string, unknown>);
  const capabilities: VocabCapabilities = {
    validate: true,
    resolveDefinition: true,
    hierarchical: true,
    deprecations: false,
  };

  const normalize = (raw: string): string => {
    const s = raw.trim();
    return s.startsWith("#") ? s.slice(1) : s;
  };

  // ── build: every table row, one pass ───────────────────────────────────────
  const decls: Declaration[] = [];
  let rootPresent = false;
  for (const note of listing) {
    if (config.rootNote !== "" && note.path === config.rootNote) rootPresent = true;
    const folder = scopeFolderOf(note.path, config.rootNote);
    if (folder === null || !note.body) continue;
    for (const { tag, description } of parseTagsTable(note.body, config.tagsHeading)) {
      const token = normalize(tag);
      if (token === "") continue;
      const family = token.endsWith("/*") ? token.slice(0, -2) : null;
      if (family === "") continue; // a bare `/*` names no head
      decls.push({ token, family, description, path: note.path, folder });
    }
  }
  /** The switch: with a root configured, its presence; without one, any table. */
  const engaged = config.rootNote !== "" ? rootPresent : decls.length > 0;

  const byFolder = new Map<string, Declaration[]>();
  const byToken = new Map<string, Declaration[]>();
  for (const d of decls) {
    byFolder.set(d.folder, [...(byFolder.get(d.folder) ?? []), d]);
    byToken.set(d.token, [...(byToken.get(d.token) ?? []), d]);
  }

  const entryOf = (d: Declaration): VocabEntry => {
    const name = d.family ?? d.token;
    return {
      canonical: d.token,
      kind: "tag",
      path: d.path,
      aliases: [],
      definition: d.description !== "" ? d.description : null,
      parent: d.family !== null ? d.family : name.includes("/") ? name.split("/").slice(0, -1).join("/") : null,
      deprecated: false,
    };
  };
  const entries = decls
    .map(entryOf)
    .sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : (a.path ?? "") < (b.path ?? "") ? -1 : 1));

  /** The rows declaring `tag`: its exact rows if any, else the rows of its
   * most specific family. */
  function declaring(tag: string): Declaration[] {
    const exact = (byToken.get(tag) ?? []).filter((d) => d.family === null);
    if (exact.length > 0) return exact;
    const families = decls.filter((d) => d.family !== null && admits(d, tag));
    if (families.length === 0) return [];
    const longest = Math.max(...families.map((d) => (d.family as string).length));
    return families.filter((d) => (d.family as string).length === longest);
  }

  /** The tables met walking `notePath`'s chain, nearest first. */
  function chain(notePath: string): Declaration[] {
    return chainFolders(notePath).flatMap((f) => byFolder.get(f) ?? []);
  }

  // ── the VocabularyProvider surface ─────────────────────────────────────────

  function validateToken(rawToken: string, kind: VocabKind): VocabFinding[] {
    if (kind !== "tag") return [];
    if (!engaged) return []; // no root scope note ⇒ no scoping (01.21 rule 3)
    const token = normalize(rawToken);
    if (declaring(token).length > 0) return [];
    return [
      {
        code: "tag_unregistered",
        token,
        path: null,
        detail: `'${token}' is not a declared tag — no \`## ${config.tagsHeading}\` table row declares it, exactly or as a \`head/*\` family`,
      },
    ];
  }

  /** The declaring row's entry. A token declared only through a family row
   * resolves to an entry for the TOKEN, carrying the family row's path and
   * description. Several rows with one description are one sense (the
   * duplicate is `registryFindings`' report); differing descriptions refuse. */
  function resolve(rawToken: string, kind: VocabKind): VocabEntry | null {
    if (kind !== "tag") return null;
    const token = normalize(rawToken);
    const found = declaring(token);
    if (found.length === 0) return null;
    const senses = new Set(found.map((d) => d.description));
    if (senses.size > 1) {
      throw new VocabAmbiguousError(token, "tag", found.map((d) => d.path));
    }
    const d = found[0];
    if (d.family === null) return entryOf(d);
    return {
      canonical: token,
      kind: "tag",
      path: d.path,
      aliases: [],
      definition: d.description !== "" ? d.description : null,
      parent: token.split("/").slice(0, -1).join("/"),
      deprecated: false,
    };
  }

  function list(kind: VocabKind, scope?: string): VocabEntry[] {
    if (kind !== "tag") return [];
    if (scope === undefined || scope === "") return entries;
    return entries.filter((e) => e.path !== null && underRoot(e.path, scope));
  }

  /** `tag_out_of_scope` — a declared tag that no table on the note's own
   * chain admits. `tag_unregistered` arrives through the ordinary token path
   * (validateToken via findings.ts's check). */
  function noteFindings(note: { path: string; frontmatter: Record<string, unknown> | null }): VocabFinding[] {
    if (!engaged) return [];
    const fm = note.frontmatter;
    if (!fm) return [];
    const rows = chain(note.path);
    const findings: VocabFinding[] = [];
    for (const raw of asStrings(fm.tags)) {
      const tag = normalize(raw);
      if (tag === "") continue;
      const where = declaring(tag);
      if (where.length === 0) continue; // unregistered is the other finding
      if (rows.some((d) => admits(d, tag))) continue;
      const scopes = [...new Set(rows.map((d) => d.path))];
      findings.push({
        code: "tag_out_of_scope",
        token: tag,
        path: note.path,
        detail:
          `'${tag}' is declared at ${[...new Set(where.map((d) => d.path))].join(", ")}, but no table on this note's scope chain admits it — ` +
          (scopes.length > 0 ? `the chain's tables are on: ${scopes.join(", ")}` : "no scope note on the chain declares a table"),
      });
    }
    return findings;
  }

  /** Findings about the tables (01.13 rule 6's lint): a token declared twice
   * on one chain is refused — reported at the LOWER row, which is the one to
   * drop or hoist; a token declared on two unrelated branches with different
   * descriptions is reported once. Plus the switch, when the root is missing. */
  function registryFindings(): VocabFinding[] {
    const findings: VocabFinding[] = [];
    if (config.rootNote !== "" && !rootPresent) {
      findings.push({
        code: "scope_root_missing",
        token: config.rootNote,
        path: null,
        detail:
          `the root scope note '${config.rootNote}' is not in this vocabulary's listing — scoping is off, so no tag finding fires; ` +
          "set this vocabulary's `rootNote` to the vault's root scope note",
      });
    }
    for (const [token, rows] of byToken) {
      if (rows.length < 2) continue;
      // shallowest first, so the row reported is always the lower one
      const ordered = [...rows].sort((a, b) => depth(a.folder) - depth(b.folder));
      for (let i = 1; i < ordered.length; i++) {
        const upper = ordered.slice(0, i).find((u) => onChain(u.folder, ordered[i].folder));
        if (!upper) continue;
        findings.push({
          code: "tag_declared_twice_on_chain",
          token,
          path: ordered[i].path,
          detail:
            upper.path === ordered[i].path
              ? `'${token}' is declared twice in this note's table — keep one row`
              : `'${token}' is declared here and again up the chain at ${upper.path} — keep the lower row or hoist it to the common ancestor`,
        });
      }
      const unrelated = ordered.some((a, i) =>
        ordered.slice(i + 1).some((b) => !onChain(a.folder, b.folder) && !onChain(b.folder, a.folder) && a.description !== b.description)
      );
      if (unrelated) {
        findings.push({
          code: "tag_declared_on_two_branches",
          token,
          path: ordered[0].path,
          detail: `'${token}' is declared on unrelated branches with different descriptions: ${[...new Set(ordered.map((d) => d.path))].join(", ")} — keep one row or hoist it to the common ancestor`,
        });
      }
    }
    return findings;
  }

  return {
    capabilities,
    kinds: ["tag"],
    normalize,
    validateToken,
    resolve,
    list,
    noteFindings,
    registryFindings,
  };
}

/**
 * The whole-vault rule pack — deliberately NOT a tool (the conformance
 * convention: capabilities arrive as rule packs, never as new surface;
 * per-note lookups go through the validate tool). Exactly these codes:
 *
 *   tag_unregistered · tag_out_of_scope · tag_declared_twice_on_chain ·
 *   tag_declared_on_two_branches · scope_root_missing
 */
export function scopeTagsFindings(
  notes: Array<{ path: string; frontmatter: Record<string, unknown> | null }>,
  provider: ScopeTagsProvider
): VocabFinding[] {
  const out: VocabFinding[] = [...provider.registryFindings()];
  for (const note of notes) {
    for (const raw of asStrings(note.frontmatter?.tags)) {
      const token = provider.normalize(raw);
      if (token === "") continue;
      out.push(
        ...provider
          .validateToken(token, "tag")
          .filter((f) => f.code === "tag_unregistered")
          .map((f) => ({ ...f, path: note.path }))
      );
    }
    out.push(...(provider.noteFindings?.(note) ?? []));
  }
  return out;
}
