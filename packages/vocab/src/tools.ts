// tools.ts — the vaultmcp-vocab satellite's tool surface: the controlled
// vocabulary's READ surface, four tools published to the Vault MCP host through
// `vault-mcp-api` (see main.ts):
//
//   vocabularies    — enumerate the configured vocabulary sources
//   resolve_term    — token → entry; path → that note's own terms; parse mode
//   validate_terms  — one note's frontmatter → findings
//   list_vocabulary — the registered entries of one kind, optionally scoped
//
// The vocab counterpart of the host's scope tools: where the scope provider
// answers "where does this note live", this answers "is this tag / property /
// type / term a registered one, and what does it mean". Validation and
// resolution only — nothing here mutates a note, and the whole-vault rule pack
// (`noteVocabFindings`'s vault-wide sibling in core) is deliberately NOT
// published: capabilities arrive as rule packs, never as new surface.
//
// ── THE KERNEL IS IN CORE, AND THAT IS THE HEADLINE DECISION ────────────────
//
// Everything vocabulary — the providers, the registry, the findings, the
// entry/finding types — is imported from `@vault-mcp/core`. There is NO
// `src/kernel/` in this package, deliberately, and adding one would be a bug.
// The kernel has TWO consumers and always did: these four tools, and the HOST's
// conformance rail (`conformance/packs/vocab.ts` wraps `noteVocabFindings`,
// `conformance/cli.ts` builds a `VocabRegistry` per run, and `conformance/
// snapshot.ts` / `rule-pack.ts` are typed over `VocabNote`).
//
// Be precise about what that dependency is and is NOT. The rail needs the
// KERNEL, but it builds its registry from `DEFAULT_VOCABULARIES`: all three
// `runConformance` call sites — `mcp/obsidian-drift-source.ts`,
// `mcp/obsidian-debt-source.ts` and `conformance/cli.ts`'s CLI entry — pass the
// shipped defaults unconditionally, and none has ever read the user's
// configured list. So the kernel's second CONSUMER is real (which is why the
// kernel is in core), while a second reader of the SETTING is not (which is why
// this plugin owns `vocabularies` outright — see settings.ts).
//
// Two copies of a rule core is how one vault gets two
// vocabularies, so publishing into core was the only non-forking answer — the
// `isVisible` (S4) and `executeQuickAddChoice` (S5) precedent, and the same
// reasoning that keeps `visiblePaths` here a three-line local wrapper over
// core's published `isVisible` rather than a second copy of the predicate.
//
// ── The published names CHANGED, and the `obsidian_` prefix went with them ──
//
// The host publishes an external tool as `<sanitized publisher id>_<bare name>`
// (`sanitizeOwnerId`). This plugin's id is `vaultmcp-vocab`, which sanitizes to
// `vaultmcp_vocab`, so the four bare names below go on the wire as
// `vaultmcp_vocab_vocabularies` / `_resolve_term` / `_validate_terms` /
// `_list_vocabulary`. The shipped module spelled them `obsidian_vocabularies`
// and friends; the `obsidian_` prefix was the HOST's built-in namespace, not
// this module's name, so keeping it would have published
// `vaultmcp_vocab_obsidian_vocabularies` — a name that says the module twice and
// the namespace not at all. Stripping it is a CHOICE, not a forced move: the
// host's F1 check (`external-tools.ts`) tests the PUBLISHED name for an
// `obsidian_` prefix, and `vaultmcp_vocab_obsidian_vocabularies` does not start
// with `obsidian_`, so it would have registered. See CLAUDE.md for the rename
// table and the one-line reversal.
//
// ── Allowlist discipline, as a satellite ────────────────────────────────────
//
// The ENFORCED boundary is now the HOST's, and — unlike every prior satellite —
// this surface is NOT uniform. The host's F3 gate is evaluated at CALL TIME on
// the ACTUAL ARGUMENTS (`settings.allowlist.length > 0 && collectPaths(args)
// .length === 0`), not on the declared schema, so:
//
//   * `vocabularies` takes no arguments at all ⇒ BLOCKED outright under an
//     active allowlist.
//   * `list_vocabulary` takes `kind` / `scope` / `vocabulary`, none of them a
//     host path key ⇒ BLOCKED outright under an active allowlist.
//   * `validate_terms` REQUIRES `path`, which IS a host path key ⇒ never
//     blocked by F3; the host scopes it and refuses `out_of_allowlist` for a
//     hidden note.
//   * `resolve_term`'s `path` is OPTIONAL, so the SAME TOOL is blocked when
//     called as `{token: "note/task"}` and scoped when called as
//     `{path: "Notes/x.md"}`. That per-call asymmetry is the single most
//     surprising fact about this extraction and it is pinned by test.
//
// All four declare `readOnly: true`, which the host DISTRUSTS unless
// `vaultmcp-vocab` appears in the user's `trustedReadOnlyPlugins` setting.
// Untrusted ⇒ all four register as MUTATING ⇒ read-only mode blocks all four,
// and each takes a write-queue slot and a journal record. Trust restores
// read-only-mode availability but does NOT change F3 (trust answers read-only
// mode, never scoping — closed 2026-09-05 by the skills satellite's review).
//
// ── WHAT THE DORMANT SEAM COSTS, STATED HONESTLY ────────────────────────────
//
// `ctx.visible` / `ctx.getSettings` are kept as seams and are NOT supplied in
// the shipped configuration, exactly like the triage and crosssession
// satellites'. For those two packages that cost nothing enforceable, because
// the host blocks their whole surface under an allowlist. Here it costs
// something real and it must not be papered over:
//
//   * As a MODULE, `buildListing` ran `visible(source.paths())` before any body
//     was read, so a registry note outside the caller's allowlist never entered
//     the providers at all — no entry, no count, no example, no candidate.
//   * As a SATELLITE, nothing supplies `visible`, so the providers are built
//     from the WHOLE vault listing on every call. For the two tools the host
//     blocks outright that is unreachable and therefore harmless. For the two
//     it lets through it is reachable: the host scopes the `path` ARGUMENT, but
//     the vocabulary the answer is computed against is not the argument and is
//     named by no argument — the same "discovered target" shape as
//     `vaultmcp_crosssession_post`'s log file.
//
// What that discloses to a session under an allowlist, precisely (it is
// narrower than a body read, and wider than nothing):
//
//   * `validate_terms` on a VISIBLE note: for each token that note already
//     carries, whether a possibly-hidden registry declares it, whether it is
//     retired, and — through the `ambiguous` finding's detail, which names
//     `VocabAmbiguousError.candidates` — the PATHS of the registry notes that
//     claim a duplicated token. That last one is a genuine path oracle.
//   * `resolve_term` with `path` on a VISIBLE note: for each token that note
//     already carries, its canonical form, its declaring vocabulary id and its
//     `definition` gloss, which is frontmatter text lifted from a registry note
//     that may itself be hidden. Path-mode never emits candidate paths (it
//     catches `VocabAmbiguousError` and reports a bare `ambiguous: true`).
//
// Both are bounded by the tokens the caller's own visible note carries — a
// session cannot ask "what else is in the hidden registry", only "is this
// token, which I can already read, registered somewhere". It is still a
// LOOSENING relative to the folded module, and it is the one direction in which
// this extraction is not strictly stricter. The fix is not available from
// inside a satellite: a published tool cannot consult the host's allowlist, and
// that is precisely the boundary the split exists to draw. It becomes fixable
// the day `vault-mcp-api` can carry the caller's scope to a publisher
// (apiVersion 2) — at which point `ctx.visible` goes live with no code change
// here, which is exactly why the seam is kept and why the tests supply it.
//
// ── Envelope convention (the satellite contract) ────────────────────────────
//
// A handler returns PLAIN DATA and THROWS on refusal. The host wraps a return
// value in `ok()` and a thrown error in `fail()`; `fail()` reads a
// lowercase-snake `code` off the thrown error and renders `Error [code]:
// message`. `ok` / `fail` / `codedError` themselves are host-internal and are
// NOT imported here. `vocab_ambiguous` and `out_of_allowlist` keep their exact
// codes and messages; the two argument-shape errors in `resolve_term` GAINED a
// code (they used to render codeless as `Error: give \`token\` or \`path\`…`),
// which is a deliberate improvement recorded in CLAUDE.md's envelope table.
//
// ── Schema fidelity across the boundary ─────────────────────────────────────
//
// The SDK converts a zod shape to JSON Schema and the host converts it back
// through a deliberately small subset (`json-schema-to-zod.ts`): `type`,
// `description`, STRING `enum` and the object's `required` list survive;
// `default`, `min`, `max` and `pattern` DO NOT. So every `.min(1)` below is
// re-applied in the handler (`requireText`) — the `vaultmcp_skills_release` semver
// lesson. `kind`'s enum and `list_vocabulary`'s requirement of it do survive,
// and are re-checked anyway because both handlers branch on the value.
//
// Obsidian-free by construction: vault state arrives through the injected
// VocabSource (structurally typed, like LinkSource), so every handler is
// unit-testable headlessly. The live adapter is in obsidian-source.ts.

import { z } from "zod";
import type { SdkToolSpec } from "vault-mcp-api";
import {
  asStrings,
  VocabAmbiguousError,
  noteVocabFindings,
  vocabularyFindings,
  VocabRegistry,
  DEFAULT_VOCABULARIES,
  isVisible,
  isScopeTagsSource,
  resolveScopeTagsConfig,
  type VocabEntry,
  type VocabFinding,
  type VocabInstance,
  type VocabInstanceSettings,
  type VocabKind,
  type VocabNote,
  type GuardSettings,
} from "@vault-mcp/core";

/** All four tools' SDK flags. `readOnly: true` is a CLAIM the host distrusts by
 * default — see the allowlist note in the header for what that costs. */
const RO = { readOnly: true, destructive: false, idempotent: true } as const;

const KINDS = ["tag", "property", "type", "term"] as const;
const KindSchema = z.enum(KINDS);

/**
 * A TYPED refusal, thrown. `fail()` in the host reads a lowercase-snake `code`
 * off the error and renders `Error [code]: message` — the identical envelope
 * the module's `codedError` produced for the codes it had.
 */
export class VocabRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VocabRefusal";
    this.code = code;
  }
}

/** Declared as a FUNCTION, not a const arrow: TypeScript only narrows control
 * flow through a `never`-returning call when the callee is a function
 * declaration (or an explicitly annotated const). */
function refuse(code: string, message: string): never {
  throw new VocabRefusal(code, message);
}

export interface VocabToolsCtx {
  /** The configured `vocabularies` rows. A THUNK, read per call: a captured
   * array would freeze the settings tab's values at plugin load. Absent ⇒ the
   * shipped defaults. (The tool DESCRIPTIONS are necessarily build-time
   * snapshots, which is why main.ts re-publishes on every settings write.) */
  getVocabularies?: () => VocabInstanceSettings[];
  /** Guard settings accessor — a DORMANT seam, unsupplied in the shipped
   * configuration (a satellite cannot reach the host's guard settings). Kept
   * for the day `vault-mcp-api` can carry the caller's scope to a publisher. */
  getSettings?: () => GuardSettings;
  /** Allowlist filter over the LISTING — the same dormant seam. Absent ⇒
   * nothing filtered; see the header for exactly what that costs. */
  visible?: (paths: string[]) => string[];
}

/** Vault state, injected. Typed structurally (not against `App`) so this file
 * imports nothing from `obsidian` — the live adapter is `obsidianVocabSource`,
 * a test hands over a plain object. */
export interface VocabSource {
  /** Every file path in the vault — ALL files, not only markdown: type
   * entries are `.fileclass` files. Enumeration only. */
  paths(): string[];
  /** Frontmatter of a markdown note, from the host's metadata cache. */
  frontmatter(path: string): Record<string, unknown> | null;
  /** Raw content of any file (for `.fileclass` frontmatter, `## Terms`
   * sections and scope notes' `## Tags` tables — the shapes the metadata
   * cache cannot serve). A leading frontmatter block is fine: the parsers
   * strip it. */
  body(path: string): Promise<string | null>;
}

/** An inert source — a stand-in for tests and for a plugin instance with no
 * vault injected: no files, nothing to read. */
export function emptyVocabSource(): VocabSource {
  return {
    paths: () => [],
    frontmatter: () => null,
    body: async () => null,
  };
}

// ── argument hygiene ─────────────────────────────────────────────────────────

/**
 * Re-apply a `.min(1)` the boundary drops, and the string type with it.
 *
 * The host reconstructs `type: "string"` from the JSON Schema, so a non-string
 * would normally be rejected upstream — but the SDK also accepts a hand-written
 * JSON Schema, and a bare `{}` property degrades to `z.unknown()`. Checking
 * here means the bound holds however the spec reached the host.
 */
function requireText(value: unknown, argument: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    refuse("invalid_argument", `'${argument}' must be a non-empty string`);
  }
  return value;
}

/**
 * A path-shaped argument this tool validates BY HAND, refused for the class
 * rather than the instance.
 *
 * BACKSLASH IS REFUSED OUTRIGHT (the `resolveScope` / triage `target_path`
 * precedent, 2026-09-05). Every check downstream of this one splits on "/"
 * alone — the host guard's `collectPaths` + `normalizePosix`, `isVisible`'s
 * prefix match, and the providers' own `underRoot` segment walk — so
 * `Notes/x\..\..\Secrets.md` reads as ONE opaque segment here and as a
 * traversal to whatever normalizes it later. Obsidian paths never legitimately
 * contain a backslash; refusing is free and closes the class.
 *
 * `invalid_path` is a NEW code this extraction adds (documented in CLAUDE.md
 * and README.md). It is deliberately distinct from `out_of_allowlist`: a
 * malformed path is a caller mistake to fix, not a scoping answer, and
 * conflating them would tell a sandboxed caller their path exists.
 */
function requirePath(value: unknown, argument: string): string {
  const path = requireText(value, argument);
  if (path.includes("\\")) {
    refuse("invalid_path", `'${argument}' contains a backslash — give a vault-relative path using '/' separators`);
  }
  return path;
}

// ── listing construction ─────────────────────────────────────────────────────

const REGISTRY_SUFFIXES = [".tag.md", ".property.md", ".fileclass"];

function under(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(root + "/");
}

/**
 * The notes the configured vocabularies need, visible-filtered BEFORE any
 * content is touched. Body reads are confined to what actually needs one:
 * `.fileclass` files under a blueprint root, markdown under a glossary's
 * `termsRoot` (the `## Terms` chapters), and the scope notes a scope-tags
 * vocabulary reads its `## Tags` tables from — never the whole vault.
 *
 * The `visible` filter is the DORMANT seam. In the shipped configuration it is
 * the identity, so this reads the whole vault listing; see the header for the
 * precise disclosure that costs and why a satellite cannot close it.
 */
async function buildListing(
  source: VocabSource,
  rows: VocabInstanceSettings[],
  visible: (paths: string[]) => string[]
): Promise<VocabNote[]> {
  const all = visible(source.paths());
  const wanted = new Map<string, { fm: boolean; body: boolean }>();
  const want = (path: string, part: "fm" | "body") => {
    const w = wanted.get(path) ?? { fm: false, body: false };
    w[part === "fm" ? "fm" : "body"] = true;
    wanted.set(path, w);
  };

  for (const row of rows) {
    if (row.provider === "blueprint") {
      for (const p of all) {
        if (!under(p, row.root)) continue;
        if (p.endsWith(".fileclass")) want(p, "body");
        else if (REGISTRY_SUFFIXES.some((s) => p.endsWith(s))) want(p, "fm");
      }
    } else if (row.provider === "glossary") {
      const termsRoot = typeof row.config?.termsRoot === "string" ? row.config.termsRoot : null;
      for (const p of all) {
        if (!p.endsWith(".md")) continue;
        if (under(p, row.root)) want(p, "fm");
        if (termsRoot !== null && under(p, termsRoot) && under(p, row.root)) want(p, "body");
      }
    } else if (row.provider === "scope-tags") {
      // The tags are declared in the `## Tags` tables in the BODIES of scope
      // notes (vault spec 01.13 rule 6), so this provider reads bodies — but
      // only of the notes that can declare: folder notes (`A/B/B.md`) and the
      // configured root scope note, recognized by PATH before anything is
      // opened. It needs no frontmatter from the listing.
      const { rootNote } = resolveScopeTagsConfig(row.config);
      for (const p of all) {
        if (p.endsWith(".md") && under(p, row.root) && isScopeTagsSource(p, rootNote)) want(p, "body");
      }
    }
  }

  const listing: VocabNote[] = [];
  for (const [path, w] of wanted) {
    listing.push({
      path,
      frontmatter: w.fm ? source.frontmatter(path) : null,
      body: w.body ? await source.body(path) : null,
    });
  }
  return listing;
}

// ── the tools ────────────────────────────────────────────────────────────────

type Resolved = { entry: VocabEntry; vocabulary: string };

export function buildVocabTools(source: VocabSource, ctx: VocabToolsCtx): SdkToolSpec[] {
  const vis = ctx.visible ?? ((p: string[]) => p);
  /**
   * The effective rows, resolved PER CALL so a settings edit lands live.
   *
   * AN EMPTY LIST MEANS THE SHIPPED DEFAULTS, and that is a deliberate (small)
   * change from the folded module, where `getVocabularies` was always supplied
   * and an empty array meant "no vocabulary at all". Two reasons: a fresh
   * satellite install starts with an empty list and no host to adopt from, and
   * doing nothing out of the box is not what a user installing a vocabulary
   * plugin asked for; and the host's own settings tab already TOLD users that
   * an empty list falls back to the defaults, which was untrue there and is
   * true here. Configuring "no vocabulary at all" is what disabling the plugin
   * is for.
   */
  const rows = (): VocabInstanceSettings[] => {
    const configured = ctx.getVocabularies?.();
    return configured && configured.length > 0 ? configured : DEFAULT_VOCABULARIES;
  };

  async function instances(): Promise<{ registry: VocabRegistry; instances: VocabInstance[] }> {
    const current = rows();
    const registry = new VocabRegistry(current);
    const listing = await buildListing(source, current, vis);
    return { registry, instances: registry.build(listing) };
  }

  /** Every sense of `token` across instances and kinds. Throws the FIRST
   * VocabAmbiguousError — an instance that already refuses to pick is an
   * answer, not an input. */
  function sensesOf(all: VocabInstance[], token: string, kinds: readonly VocabKind[]): Resolved[] {
    const out: Resolved[] = [];
    for (const inst of all) {
      for (const kind of kinds) {
        if (!inst.provider.kinds.includes(kind)) continue;
        const entry = inst.provider.resolve(token, kind);
        if (entry) out.push({ entry, vocabulary: inst.id });
      }
    }
    return out;
  }

  /** The one-path allowlist check, over the DORMANT settings seam. Unsupplied
   * ⇒ `isVisible(path, undefined)` is unrestricted, and the enforced check is
   * the host's own scoping of the `path` argument (which IS a host path key on
   * both tools that take one). */
  function requireVisible(path: string): void {
    if (!isVisible(path, ctx.getSettings?.())) {
      refuse("out_of_allowlist", `'${path}' is outside this session's allowlist`);
    }
  }

  /** `kind`, re-checked in the handler. The string enum DOES survive the
   * JSON-Schema round trip and so does `required`, but both handlers branch on
   * the value, and a hand-written publisher schema could reach the host as a
   * bare `{}` that degrades to `z.unknown()`. Constrain it twice. */
  function requireKind(value: unknown, argument: string): VocabKind {
    const kind = requireText(value, argument);
    if (!(KINDS as readonly string[]).includes(kind)) {
      refuse("invalid_argument", `'${argument}' must be one of ${KINDS.join(", ")}`);
    }
    return kind as VocabKind;
  }

  return [
    {
      name: "vocabularies",
      description:
        "Enumerate the configured controlled-vocabulary sources: id, provider, root, capabilities, per-kind entry " +
        "counts and a few example tokens. The discoverability entry point for the vocabulary tools — call this first " +
        "to learn what kinds (tag / property / type / term) this vault's vocabulary actually serves. Read-only in " +
        "intent; the Vault MCP host registers it as mutating unless this plugin is trusted, and blocks it outright " +
        "while a path allowlist is active (it takes no arguments, so there is no path to scope by).",
      inputSchema: {},
      ...RO,
      handler: async () => {
        const { registry, instances: all } = await instances();
        return {
          vocabularies: all.map((inst) => ({
            id: inst.id,
            provider: inst.providerName,
            root: inst.root,
            capabilities: inst.provider.capabilities,
            kinds: inst.provider.kinds,
            counts: Object.fromEntries(inst.provider.kinds.map((k) => [k, inst.provider.list(k).length])),
            examples: Object.fromEntries(
              inst.provider.kinds.map((k) => [k, inst.provider.list(k).slice(0, 3).map((e) => e.canonical)])
            ),
          })),
          // settings problems, plus each instance's switch report: a dead
          // root scope note is a configuration problem, not drift (#551 review)
          problems: [
            ...registry.problems,
            ...all.flatMap((inst) =>
              vocabularyFindings([inst.provider])
                .filter((f) => f.code === "scope_root_missing")
                .map((f) => `vocabulary '${inst.id}': ${f.detail}`)
            ),
          ],
        };
      },
    },

    {
      name: "resolve_term",
      description:
        "Look up the controlled vocabulary. Give `token` (with optional `kind`) to resolve it to its canonical entry — " +
        "definition, aliases, hierarchy, deprecation. Give `path` to report a note's own vocabulary (its tags, " +
        "properties and types), each resolved. Give `token` with `parse: true` to validate only. A token with more " +
        "than one sense refuses to pick, naming every candidate — like uid resolution. Note the per-call asymmetry " +
        "under a Vault MCP path allowlist: called with `path` this tool is SCOPED by the host (a hidden note refuses " +
        "`out_of_allowlist`), but called with `token` it carries no path argument and the host blocks it outright.",
      inputSchema: {
        token: z.string().min(1).optional().describe("A vocabulary token: a tag, property key, type name, or term."),
        kind: KindSchema.optional().describe("Narrow the lookup to one kind; omitted, every kind is searched."),
        path: z.string().min(1).optional().describe("A vault-relative note path to report the vocabulary OF."),
        parse: z.boolean().optional().describe("With `token`: validate only, resolve nothing."),
        vocabulary: z.string().min(1).optional().describe("Narrow to one configured vocabulary id."),
      },
      ...RO,
      handler: async (args: Record<string, unknown>) => {
        // The two argument-shape errors. As a module these returned
        // `fail(new Error(...))`, which rendered CODELESS as `Error: …`; as a
        // satellite they are thrown refusals and carry `invalid_argument`, so
        // an agent can branch on the code instead of the prose. A deliberate
        // envelope change, recorded in CLAUDE.md.
        if (args.token !== undefined && args.path !== undefined) {
          refuse("invalid_argument", "give `token` or `path`, not both — they are two directions of one lookup");
        }
        if (args.token === undefined && args.path === undefined) {
          refuse("invalid_argument", "give `token` (with optional `kind`) or `path`");
        }
        const kind = args.kind === undefined ? undefined : requireKind(args.kind, "kind");
        const kinds: readonly VocabKind[] = kind ? [kind] : KINDS;
        const vocabulary = args.vocabulary === undefined ? undefined : requireText(args.vocabulary, "vocabulary");

        if (args.path !== undefined) {
          const path = requirePath(args.path, "path");
          requireVisible(path);
          const { instances: allInstances } = await instances();
          const all = vocabulary ? allInstances.filter((i) => i.id === vocabulary) : allInstances;
          const fm = source.frontmatter(path);
          const terms: Array<Record<string, unknown>> = [];
          const report = (token: string, k: VocabKind) => {
            try {
              const senses = sensesOf(all, token, [k]);
              terms.push({
                token,
                kind: k,
                found: senses.length > 0,
                ...(senses.length === 1
                  ? {
                      canonical: senses[0].entry.canonical,
                      vocabulary: senses[0].vocabulary,
                      definition: senses[0].entry.definition,
                      deprecated: senses[0].entry.deprecated,
                    }
                  : {}),
                ...(senses.length > 1 ? { ambiguous: true } : {}),
              });
            } catch (e) {
              if (!(e instanceof VocabAmbiguousError)) throw e;
              // Path mode reports the AMBIGUITY, never its candidates: the
              // candidate list is registry-note PATHS, and this is the one
              // branch a session under an allowlist can reach.
              terms.push({ token, kind: k, found: true, ambiguous: true });
            }
          };
          for (const t of asStrings(fm?.tags)) report(t.trim(), "tag");
          for (const key of Object.keys(fm ?? {})) if (key !== "fileClass") report(key, "property");
          const classes = asStrings(fm?.fileClass);
          for (const c of classes) {
            const inner = c.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
            report((inner.split("/").pop() ?? inner).replace(/\.fileclass$/, ""), "type");
          }
          return { path, terms };
        }

        const token = requireText(args.token, "token");
        const { instances: allInstances } = await instances();
        const all = vocabulary ? allInstances.filter((i) => i.id === vocabulary) : allInstances;

        if (args.parse) {
          // No configured vocabulary serving the kind ⇒ vacuously valid, the
          // same convention findings.ts pins ("no providers serving a kind
          // means no findings") — never `valid: false` with zero findings.
          let findings: VocabFinding[] | null = null;
          for (const k of kinds) {
            for (const inst of all) {
              if (!inst.provider.kinds.includes(k)) continue;
              const f = inst.provider.validateToken(token, k);
              if (f.length === 0) return { token, valid: true, findings: [] };
              findings = findings ?? f;
            }
          }
          return { token, valid: findings === null, findings: findings ?? [] };
        }

        let senses: Resolved[];
        try {
          senses = sensesOf(all, token, kinds);
        } catch (e) {
          if (!(e instanceof VocabAmbiguousError)) throw e;
          refuse("vocab_ambiguous", e.message);
        }
        if (senses.length === 0) return { token, found: false };
        if (senses.length > 1) {
          const named = senses.map((s) => `${s.entry.canonical} (${s.entry.kind}, ${s.vocabulary}: ${s.entry.path ?? "<pathless>"})`);
          refuse(
            "vocab_ambiguous",
            `'${token}' has ${senses.length} senses — refusing to pick: ${named.join(", ")}`
          );
        }
        return { token, found: true, vocabulary: senses[0].vocabulary, entry: senses[0].entry };
      },
    },

    {
      name: "validate_terms",
      description:
        "Check one note's frontmatter against the controlled vocabulary, per the configured providers: unregistered " +
        "tags (exact-match under the default scope-tags model; namespace-permissive under the legacy blueprint " +
        "grammar), tags no `## Tags` table on the note's scope chain admits, a missing root scope note " +
        "(scope_root_missing: scoping is off), undefined properties, unknown or retired types, ambiguous senses. " +
        "Report-only — findings are returned, " +
        "never fixed, and nothing is written. `path` is a recognized Vault MCP path argument, so under an active path " +
        "allowlist this tool stays available and the host scopes the note you may name.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative note path to validate."),
      },
      ...RO,
      handler: async (args: Record<string, unknown>) => {
        const path = requirePath(args.path, "path");
        requireVisible(path);
        const { instances: all } = await instances();
        const providers = all.map((i) => i.provider);
        // A dead root switches scoping off, so the per-note checks go quiet;
        // say so here, once per call (#551 review). Only that code: the table
        // lint is about OTHER notes and belongs to the whole-vault rail.
        const findings = [
          ...vocabularyFindings(providers).filter((f) => f.code === "scope_root_missing"),
          ...noteVocabFindings({ path, frontmatter: source.frontmatter(path) }, providers),
        ];
        return { path, findings, clean: findings.length === 0 };
      },
    },

    {
      name: "list_vocabulary",
      description:
        "Enumerate the registered vocabulary of one kind (tag / property / type / term), sorted, each entry naming " +
        "the vocabulary that declares it. `scope` confines the listing to entries declared under a path prefix; " +
        "`vocabulary` narrows to one configured source. Read-only in intent; blocked outright while a Vault MCP path " +
        "allowlist is active — `scope` is a path PREFIX, not a recognized path argument, so the call cannot be scoped.",
      inputSchema: {
        kind: KindSchema.describe("Which vocabulary kind to list."),
        scope: z.string().optional().describe("Only entries declared under this vault-relative path prefix."),
        vocabulary: z.string().min(1).optional().describe("Narrow to one configured vocabulary id."),
      },
      ...RO,
      handler: async (args: Record<string, unknown>) => {
        const kind = requireKind(args.kind, "kind");
        // `scope` gets the SAME backslash refusal the hand-validated `path`
        // arguments get, and for the same reason: it is a path-shaped string
        // this tool checks itself, the providers' `underRoot` splits on "/"
        // alone, and a backslash reads as one opaque segment here and as a
        // traversal to whatever normalizes it later.
        //
        // It is deliberately NOT routed through core's `resolveScope`, even
        // though that is where the repo's one copy of scope validation lives.
        // `resolveScope` answers "may this session READ under this prefix",
        // normalizing the prefix and refusing `""`; this `scope` is a filter
        // over the DECLARING PATHS of entries already in the listing, where
        // `""` is a first-class value meaning "everything" (the providers'
        // `list(kind, "")` returns all). Routing it there would change shipped
        // behaviour well beyond the class this refusal closes, and would add an
        // allowlist branch this satellite cannot evaluate anyway. The code is
        // still `invalid_scope`, so a bad scope answers the same everywhere.
        let scope: string | undefined;
        if (args.scope !== undefined) {
          if (typeof args.scope !== "string") refuse("invalid_argument", "'scope' must be a string");
          if (args.scope.includes("\\")) {
            refuse("invalid_scope", "scope contains a backslash — give a vault-relative prefix using '/' separators");
          }
          scope = args.scope;
        }
        const vocabulary = args.vocabulary === undefined ? undefined : requireText(args.vocabulary, "vocabulary");
        const { instances: allInstances } = await instances();
        const all = vocabulary ? allInstances.filter((i) => i.id === vocabulary) : allInstances;
        const entries = all
          .flatMap((inst) => inst.provider.list(kind, scope).map((e) => ({ ...e, vocabulary: inst.id })))
          .sort((a, b) => a.canonical.toLowerCase().localeCompare(b.canonical.toLowerCase()));
        return { kind, count: entries.length, entries };
      },
    },
  ];
}
