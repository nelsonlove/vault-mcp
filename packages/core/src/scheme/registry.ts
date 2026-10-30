// registry.ts — the SchemeRegistry: multiple named scheme instances (each a
// provider name + a merged config) plus address-string resolution
// ("jd:06.11" -> a vault path). Kernel-module rules apply: nothing here
// imports from "obsidian".
//
// Scheme semantics are configuration, not hardwired (Nelson's ruling): each
// instance's config is a PARTIAL provider config, deep-merged at the key
// level over that provider's own default config — {expandedCategories:
// ["34","41"]} overrides only that key and leaves expandedAreas at the
// provider default. The registry itself introduces no new semantic
// constants; it only wires a provider name + merged config to a live
// ScopeProvider.

import type { Address, ScopeProvider } from "./provider.js";
import { jdProvider, DEFAULT_JD_CONFIG, validateJdConfig, type JdConfig } from "./jd.js";
import { mapPaths, visiblePaths } from "../guard-paths.js";
import type { GuardSettings } from "../visibility.js";

export interface SchemeInstanceConfig {
  id: string;
  provider: "johnny-decimal";
  config?: Partial<JdConfig>;
  /**
   * Vault-relative folder prefixes whose contents are invisible to THIS
   * scheme instance — instance-level and provider-agnostic (a sibling of
   * `config`, not a key inside it: exclusion is about which territory this
   * instance speaks for, not about the provider's own grammar). Motivating
   * case: an archive tree that reuses live-spine addresses (two notes both
   * claiming `jd:02.10`) — excluding the archive root lets the instance
   * resolve cleanly to the live one without renaming anything.
   *
   * Applied uniformly at the listing layer (`excludeRoots`, below) wherever a
   * listing reaches this instance's provider: tools-scheme.ts's per-call
   * visible listing, `resolveSchemeArgs`'s `jd:<address>` addressing, and
   * `schemeFindings`. It bounds SCHEME resolution and scheme tool output
   * ONLY — an excluded note's own path still works as an ordinary path
   * argument (read, write, uid resolution, …); this is not a second
   * allowlist.
   */
  excludedRoots?: string[];
}

/**
 * No scheme on a fresh install (01.33, pick A step b): addressing is opt-in.
 * With no instance there is no `<id>:` addressing, no scheme tool and no
 * scheme check; `uid:` and paths work as before. A vault turns Johnny Decimal
 * on by adding `JD_SCHEME_INSTANCE` (below) to its `schemes` setting, with any
 * expansions in its `config`.
 */
export const DEFAULT_SCHEMES: SchemeInstanceConfig[] = [];

/**
 * The Johnny Decimal instance as it shipped by default until step (b): id
 * `jd`, the JD provider, no config (so the provider defaults, which expand
 * nothing). The opt-in row for a vault that wants JD, and the seed an
 * install that predates the `schemes` key keeps (`schemesOnLoad`).
 */
export const JD_SCHEME_INSTANCE: Readonly<SchemeInstanceConfig> = Object.freeze({ id: "jd", provider: "johnny-decimal" as const });

export interface SchemesOnLoad {
  schemes: SchemeInstanceConfig[];
  /** Set when the stored `schemes` is not a list: what the caller should warn about. The stored value is left as it is (persist is false), so a hand-edited file is never rewritten by the load. */
  warning?: string;
  /** True when the stored settings did not hold the key (or came from the adoption source): save now, so the decision runs at most once per install. */
  persist: boolean;
}

/**
 * The `schemes` setting at load, by the rule the guarded territories, the
 * record folders and `autoRegisterClaude` use. The plugin's own data.json
 * first; failing that, settings adopted from the pre-split plugin (an adopted
 * install is an EXISTING install). No stored settings at all (a fresh
 * install): no scheme. Stored settings without the key (an install that
 * predates step b, which got the one jd instance by default): that instance,
 * saved once. Otherwise the stored list as it is. A stored value that is not
 * a list reads as no scheme, with a `warning`, and is not written back.
 */
export function schemesOnLoad(own: unknown, adopted?: unknown): SchemesOnLoad {
  const asObject = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const stored = asObject(own) ?? asObject(adopted);
  if (!stored) return { schemes: [], persist: true };
  if (!Object.prototype.hasOwnProperty.call(stored, "schemes")) return { schemes: [{ ...JD_SCHEME_INSTANCE }], persist: true };
  const list = stored.schemes;
  if (!Array.isArray(list)) {
    return { schemes: [], persist: false, warning: `the saved "schemes" setting is not a list (it is ${list === null ? "null" : typeof list}), so no scheme is on; the saved value is left as it is — fix it to a list of scheme rows` };
  }
  return { schemes: structuredClone(list as SchemeInstanceConfig[]), persist: asObject(own) === null };
}

export interface SchemeInstance {
  id: string;
  providerName: string;
  provider: ScopeProvider;
  /** Validated, normalized (trailing slash stripped) excluded-root prefixes.
   * Absent (not empty array) when the instance configured none — matches
   * `excludeRoots`'s "absent/empty ⇒ same array back" identity convention,
   * and keeps the JSON `obsidian_schemes` reports free of a noisy `[]`. */
  excludedRoots?: string[];
}

/**
 * One entry per known provider name: how to deep-merge a partial config over
 * that provider's own defaults (key-level — each key either takes the
 * override wholesale or falls back to the default, never merged deeper),
 * validate a raw config before trusting it, and build the live ScopeProvider.
 * `config` arrives as `unknown` because `SchemeInstanceConfig.provider` is a
 * compile-time literal, but a config loaded from JSON can name any string at
 * runtime — the registry must validate it defensively, not trust the type.
 *
 * Flexible user config schema (Nelson's ruling): `config` is a per-provider
 * namespace validated BY THE PROVIDER, not by the registry — `validate` is
 * the provider's own hook (validateJdConfig for "johnny-decimal"), and
 * makeRegistry below calls it before `make`, same skip-and-report path as an
 * unknown provider name.
 */
const PROVIDER_FACTORIES: Record<string, { make: (config: unknown) => ScopeProvider; validate: (config: unknown) => string[] }> = {
  "johnny-decimal": {
    make: (config) => jdProvider({ ...DEFAULT_JD_CONFIG, ...(config as Partial<JdConfig> | undefined) }),
    validate: validateJdConfig,
  },
};

/** "jd:06.11", "uid:abc" — a scheme id (lowercase, digits/hyphens) and an
 * address, colon-separated. Matched by parseRef against the registry's own
 * instance ids; `uid:` is reserved and never a scheme ref. */
const REF_RE = /^([a-z][a-z0-9-]*):(.+)$/;

/** `parseRefDetailed`'s result: the three ways a ref can turn out, each
 * carrying exactly what its caller needs and nothing else. */
export type ParsedRef =
  | { kind: "resolved"; instance: SchemeInstance; addr: Address }
  | { kind: "skipped"; id: string; problems: string[] }
  | { kind: "none" };

export class SchemeRegistry {
  private readonly byId: Map<string, SchemeInstance>;
  /**
   * id -> the problem strings that skipped it (unknown provider, invalid
   * config, invalid excludedRoots, or a duplicate-id row), as recorded by
   * `makeRegistry`. RAW: a row skipped as a duplicate is recorded here even
   * when an EARLIER row for the same id registered successfully (first
   * wins) — `skipped()` below is the public, refusal-purpose view that
   * excludes those. A registry built directly (bypassing `makeRegistry`,
   * e.g. in tests) gets an empty map here, same as having skipped nothing.
   */
  private readonly rawSkipped: Map<string, string[]>;

  constructor(instances: SchemeInstance[], skipped: Map<string, string[]> = new Map()) {
    this.byId = new Map(instances.map((inst) => [inst.id, inst]));
    this.rawSkipped = skipped;
  }

  instances(): SchemeInstance[] {
    return [...this.byId.values()];
  }

  get(id: string): SchemeInstance | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Ids that were configured but have NO live instance — every skip path in
   * `makeRegistry` (unknown provider, invalid config, invalid
   * excludedRoots), plus a duplicate-id row whose id ALSO has no live
   * instance (its first row was itself skipped). This is the set a typed
   * `scheme_unavailable` refusal (below) is meaningful for.
   *
   * Deliberately EXCLUDES an id that has a live instance even though some
   * later row sharing that id was also skipped as a duplicate: the live
   * instance already serves the id, so there is nothing to refuse — a
   * refusal here would be reporting a problem the caller can never actually
   * hit (every call naming that id resolves against the live instance,
   * never the skipped duplicate).
   */
  skipped(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [id, problems] of this.rawSkipped) {
      if (this.byId.has(id)) continue;
      out.set(id, problems);
    }
    return out;
  }

  /** "jd:06.11" -> resolved / skipped / none. The full-detail form of
   * `parseRef` (below): distinguishes a ref naming a SKIPPED id (no live
   * instance — a typed `scheme_unavailable` refusal is warranted) from every
   * other reason a ref isn't a resolvable scheme address (not scheme-shaped
   * at all, the reserved "uid:" prefix, an unregistered id, or an id-shaped
   * address the provider itself can't parse) — all of those are `"none"`,
   * meaning "not a scheme ref at all, treat it as an ordinary path". A
   * skipped id's address portion is never parsed against a provider (there
   * is none to parse it) — matching the id alone is enough to report
   * `"skipped"`. */
  parseRefDetailed(ref: string): ParsedRef {
    const m = ref.match(REF_RE);
    if (!m) return { kind: "none" };
    const [, id, rest] = m;
    if (id === "uid") return { kind: "none" };
    const instance = this.get(id);
    if (instance) {
      const addr = instance.provider.parse(rest);
      return addr ? { kind: "resolved", instance, addr } : { kind: "none" };
    }
    const problems = this.skipped().get(id);
    if (problems) return { kind: "skipped", id, problems };
    return { kind: "none" };
  }

  /** "jd:06.11" -> { instance, addr } | null. Null covers every reason the
   * ref isn't a resolvable scheme address: not scheme-shaped at all, the
   * reserved "uid:" prefix, an unregistered scheme id, a SKIPPED scheme id
   * (see `parseRefDetailed` for that distinction), or an id-shaped address
   * the provider itself can't parse. Callers treat null uniformly as
   * "not a scheme ref — treat it as an ordinary path", so a filename that
   * happens to contain a colon never breaks. A caller that must distinguish
   * a skipped id (to issue a typed refusal instead) uses `parseRefDetailed`
   * directly. */
  parseRef(ref: string): { instance: SchemeInstance; addr: Address } | null {
    const detailed = this.parseRefDetailed(ref);
    return detailed.kind === "resolved" ? { instance: detailed.instance, addr: detailed.addr } : null;
  }

  /** Paths in `notes` whose own address canonicalizes to the same string as
   * `addr`, in listing order. Compares via provider.format on both sides —
   * canonical-form equality, not raw-string equality (#93: this is
   * architectural headroom for a FUTURE provider whose format() legitimately
   * differs from its raw parse, e.g. normalizing decimal widths; the
   * johnny-decimal provider's own format() is a raw pass-through — `addr.raw`,
   * see jd.ts — it does not itself normalize anything today, so for "jd" this
   * comparison is currently equivalent to comparing raw strings). */
  resolve(instance: SchemeInstance, addr: Address, notes: string[]): string[] {
    const target = instance.provider.format(addr);
    const matches: string[] = [];
    for (const path of notes) {
      const a = instance.provider.addressOf(path);
      if (a && instance.provider.format(a) === target) matches.push(path);
    }
    return matches;
  }
}

/**
 * Validate + normalize one instance's `excludedRoots`. Same skip-and-report
 * convention as `validateJdConfig`: `problems` non-empty means the WHOLE
 * instance is skipped by `makeRegistry`, not just the bad entries silently
 * dropped — a typo'd root that got dropped would leave the exclusion the
 * user asked for simply not happening, with no on-screen sign why.
 *
 * Per-entry rules: non-empty string; relative (no leading "/"); no ".."
 * segment (would escape the vault root the same way `guardCall`'s traversal
 * check exists to catch); not "." (names nothing to exclude). Three things
 * are NORMALIZED away rather than refused — a user typo here should not
 * silently defeat the exclusion it's a typo IN (the #74 you-must-SEE-it
 * philosophy: a normalized entry is still reported truthfully in
 * `roots`, never left to quietly mismatch every real path): surrounding
 * whitespace (`" X "` -> `"X"`, interior whitespace is part of the name and
 * untouched), a leading "./" (`"./X"` -> `"X"` — otherwise `excludeRoots`'s
 * exact/prefix match against real vault paths, which never carry a "./",
 * would simply never fire, a SILENT no-op rather than a validation
 * problem), and a trailing slash (`"X/"` -> `"X"`, matching `guardCall`'s
 * own allowlist-prefix normalization `p.replace(/\/+$/, "")`).
 *
 * `raw` undefined (field absent) ⇒ `{roots: undefined, problems: []}`, never
 * `{roots: [], problems: []}` — keeps the "absent means no exclusion, same
 * array back" identity `excludeRoots` relies on working off `undefined`
 * rather than an incidental empty array.
 */
export function validateExcludedRoots(raw: string[] | undefined): { roots: string[] | undefined; problems: string[] } {
  if (raw === undefined) return { roots: undefined, problems: [] };
  const problems: string[] = [];
  const roots: string[] = [];
  for (const rawEntry of raw) {
    if (typeof rawEntry !== "string" || rawEntry.length === 0) {
      problems.push(`excludedRoots entry ${JSON.stringify(rawEntry)} must be a non-empty string`);
      continue;
    }
    const trimmed = rawEntry.trim();
    if (trimmed.length === 0) {
      problems.push(`excludedRoots entry ${JSON.stringify(rawEntry)} must be a non-empty string`);
      continue;
    }
    if (trimmed.startsWith("/")) {
      problems.push(`excludedRoots entry "${rawEntry}" must be relative (no leading "/")`);
      continue;
    }
    if (trimmed.split("/").includes("..")) {
      problems.push(`excludedRoots entry "${rawEntry}" must not contain ".." segments`);
      continue;
    }
    let normalized = trimmed;
    while (normalized.startsWith("./")) normalized = normalized.slice(2);
    normalized = normalized.replace(/\/+$/, "");
    if (normalized === "." || normalized.length === 0) {
      problems.push(`excludedRoots entry "${rawEntry}" does not name a folder`);
      continue;
    }
    roots.push(normalized);
  }
  return { roots: roots.length > 0 ? roots : undefined, problems };
}

/**
 * `paths` with every entry under one of `roots` removed — segment-boundary
 * prefix matching, same style as `guard.ts`'s `visiblePaths`/`isVisible`: a
 * root excludes its own exact path and everything one or more path segments
 * below it ("Vault archaeology" excludes "Vault archaeology/x.md" but NOT
 * "Vault archaeology2/x.md" — a bare string-prefix check would wrongly
 * exclude the latter).
 *
 * `roots` empty/absent, or nothing in `paths` matches, returns the SAME
 * ARRAY (`paths`, not a copy) — the identity convention every caller downstream
 * (the visible-listing memo in `resolveSchemeArgs`, `mapPaths`'s no-op
 * sharing) relies on to treat "unchanged" as `===`, and the byte-identical
 * behavior `excludedRoots` absent/`[]` must have.
 */
export function excludeRoots(paths: string[], roots: string[] | undefined): string[] {
  if (!roots || roots.length === 0) return paths;
  let changed = false;
  const out: string[] = [];
  for (const path of paths) {
    const excluded = roots.some((root) => path === root || path.startsWith(root + "/"));
    if (excluded) {
      changed = true;
      continue;
    }
    out.push(path);
  }
  return changed ? out : paths;
}

export function makeRegistry(configs: SchemeInstanceConfig[]): SchemeRegistry {
  const instances: SchemeInstance[] = [];
  // id -> every skip reason recorded against it, feeding SchemeRegistry's own
  // `skipped()` (issue #88): the console.error lines below remain the
  // settings-surface record (#74), this map is the SAME information kept
  // in-process so a call naming a skipped id can get a typed refusal instead
  // of reading as an ordinary, never-registered scheme id. Appended to, not
  // overwritten — a duplicate-id row records ALONGSIDE whatever the first row
  // for that id already recorded (see the duplicate branch below), so an id
  // skipped twice for two different reasons keeps both.
  const skipped = new Map<string, string[]>();
  const recordSkip = (id: string, problems: string[]) => {
    skipped.set(id, [...(skipped.get(id) ?? []), ...problems]);
  };
  // FIRST wins on a duplicate id (item 5 fix): a later entry sharing an
  // already-registered id is skip-and-reported, same convention as an
  // unknown provider or an invalid config — not silently last-wins, which
  // let a later, possibly-unintended entry shadow an earlier one with no
  // trace in the log. Tracked by id alongside `instances` rather than
  // `byId.has(...)` inside the SchemeRegistry constructor, since that
  // constructor is also used directly (see e.g. requireOneAddress's tests)
  // and must keep its own simpler last-wins-by-Map semantics for a caller
  // that already deduplicated.
  const seenIds = new Set<string>();
  for (const cfg of configs) {
    if (seenIds.has(cfg.id)) {
      const msg = `duplicate scheme id "${cfg.id}" — first entry wins, this one is skipped`;
      console.error(`[scheme-registry] ${msg}`);
      recordSkip(cfg.id, [msg]);
      continue;
    }
    // Reserve the id BEFORE the provider/config checks below (worker-1's
    // review, post-merge — mirrors @vault-mcp/core's VocabRegistry
    // constructor, which fixed the identical gap): a row that fails those
    // checks is still SKIPPED, not absent — the id it named is spoken for
    // and must not be silently claimable by a later row of the same id. Add
    // here, not after `instances.push`, or a first row skipped for an
    // unknown provider/invalid config would leave the id unreserved and a
    // later same-id row would register as if it were the only one.
    seenIds.add(cfg.id);
    const factory = Object.prototype.hasOwnProperty.call(PROVIDER_FACTORIES, cfg.provider)
      ? PROVIDER_FACTORIES[cfg.provider]
      : undefined;
    if (!factory) {
      const msg = `unknown provider "${cfg.provider}" for scheme id "${cfg.id}" — instance skipped`;
      console.error(`[scheme-registry] ${msg}`);
      recordSkip(cfg.id, [msg]);
      continue;
    }
    const problems = factory.validate(cfg.config);
    if (problems.length > 0) {
      console.error(
        `[scheme-registry] invalid config for scheme id "${cfg.id}" (provider "${cfg.provider}") — instance skipped: ${problems.join("; ")}`,
      );
      recordSkip(cfg.id, problems);
      continue;
    }
    const { roots: excludedRoots, problems: rootProblems } = validateExcludedRoots(cfg.excludedRoots);
    if (rootProblems.length > 0) {
      console.error(
        `[scheme-registry] invalid excludedRoots for scheme id "${cfg.id}" — instance skipped: ${rootProblems.join("; ")}`,
      );
      recordSkip(cfg.id, rootProblems);
      continue;
    }
    instances.push({ id: cfg.id, providerName: cfg.provider, provider: factory.make(cfg.config), ...(excludedRoots ? { excludedRoots } : {}) });
  }
  return new SchemeRegistry(instances, skipped);
}

export class AddressUnresolvedError extends Error {
  readonly code = "address_unresolved";

  constructor(message: string) {
    super(message);
    this.name = "AddressUnresolvedError";
  }
}

export class AddressAmbiguousError extends Error {
  readonly code = "address_ambiguous";

  constructor(
    message: string,
    readonly candidates: string[],
  ) {
    super(message);
    this.name = "AddressAmbiguousError";
  }
}

/**
 * A ref (or an explicit `scheme` argument) named a scheme id that IS
 * configured but has no live instance — `SchemeRegistry.skipped()` (issue
 * #88's typed refusal, the second half of #74's settings-tab surfacing).
 *
 * The message names ONLY the id — NEVER the problem strings `skipped()`
 * carries. Those problems can themselves be (or quote) config values a user
 * typed, which can name vault territory (a bad `excludedRoots` entry is the
 * clearest case: the very string that failed validation is a path), so
 * echoing them into a tool-call refusal would be a disclosure leak parallel
 * to the one `excludedRoots`'s own under-disclosure in `obsidian_schemes`
 * guards against — a refusal is not the settings surface, and must not do
 * that surface's job. A caller who wants the actual reason reads it in
 * settings (or, for a headless embed, straight off `skipped()`), not from a
 * tool error.
 */
export class SchemeUnavailableError extends Error {
  readonly code = "scheme_unavailable";

  constructor(readonly id: string) {
    super(`scheme "${id}" is configured but currently unavailable due to configuration problems — fix them in settings`);
    this.name = "SchemeUnavailableError";
  }
}

// A duplicate can in principle be large; an error message should not be — same
// convention (and same cap) as UidAmbiguousError's MAX_LISTED_PATHS in
// uid-index.ts. The candidates are already allowlist-VISIBLE-only by the time
// they get here, so this bounds the wire size, not disclosure.
const MAX_LISTED_CANDIDATES = 10;

/**
 * The post-parse half of `requireOneAddress`: given a ref ALREADY PARSED (or
 * `null`, meaning `ref` never parsed as a scheme reference at all), decide the
 * one matching path or throw. Factored out so a caller that must parse `ref`
 * itself anyway to decide whether it's scheme-shaped — resolveSchemeArgs,
 * below — never parses it a SECOND time just to resolve it.
 */
function resolveParsedAddress(
  reg: SchemeRegistry,
  parsed: { instance: SchemeInstance; addr: Address } | null,
  ref: string,
  notes: string[]
): string {
  if (!parsed) {
    throw new AddressUnresolvedError(`"${ref}" does not resolve to any address`);
  }
  const candidates = reg.resolve(parsed.instance, parsed.addr, notes);
  if (candidates.length === 0) {
    throw new AddressUnresolvedError(`no note found for "${ref}"`);
  }
  if (candidates.length > 1) {
    const listed = candidates.slice(0, MAX_LISTED_CANDIDATES);
    const more = candidates.length > listed.length ? `, +${candidates.length - listed.length} more` : "";
    throw new AddressAmbiguousError(`"${ref}" is ambiguous between: ${listed.join(", ")}${more}`, candidates);
  }
  return candidates[0];
}

/** Resolve `ref` (e.g. "jd:06.11") against `notes` to exactly one path, or
 * throw. A ref that isn't a resolvable scheme address at all (unregistered
 * id, unparseable address, "uid:", not scheme-shaped) is treated the same as
 * zero candidates — there is nothing for the caller to have meant. */
export function requireOneAddress(reg: SchemeRegistry, ref: string, notes: string[]): string {
  return resolveParsedAddress(reg, reg.parseRef(ref), ref, notes);
}

// ── scheme addressing (`jd:<address>`) ──────────────────────────────────────
//
// The uid-addressing analog (see kernel/uid-index.ts's resolveUidArgs, applied
// at the same interception point in mcp/guarded.ts): `path: "jd:06.11"`
// resolves to the real path before anything else sees the call. Defined over
// the guard's own path walker (mapPaths), so the arguments scheme addressing
// reaches and the arguments the allowlist scopes are the same set by
// construction, exactly as uid addressing is.
//
// Resolution runs over the allowlist-VISIBLE notes only (`visiblePaths`, the
// same helper `obsidian_resolve_address` uses) — 0 visible candidates ⇒
// address_unresolved even when a hidden note claims the address, 2+ visible ⇒
// address_ambiguous naming ONLY the visible ones. A duplicated address with
// one hidden claimant must not read as more resolvable, and disambiguous, to
// an allowlisted session than to obsidian_resolve_address — the same
// no-existence-oracle property uid addressing's D-A fix established.

/** What a call's scheme addressing resolved to — the `jd:<address>` analog of
 * `UidAddressing`. */
export interface SchemeAddressing {
  /**
   * The arguments with every scheme reference replaced by its resolved path.
   * The SAME object when the call used no scheme addressing at all —
   * behavior for ordinary path arguments (including ones merely containing a
   * colon) is unchanged, byte for byte.
   */
  args: Record<string, unknown>;
  /** Each reference resolved, in walk order. Empty ⇒ no scheme addressing was used. */
  resolved: Array<{ ref: string; path: string }>;
}

/**
 * Rewrite every `<scheme-id>:<address>` path argument (e.g. `jd:06.11`) to the
 * path it names.
 *
 * Throws AddressUnresolvedError / AddressAmbiguousError — the caller (makeGuarded)
 * renders them as typed tool errors and nothing runs. `reg` absent (no scheme
 * registry configured for this call) ⇒ every value is left untouched, same as
 * a value whose `parseRef` is null: a filename that happens to contain a colon,
 * or an unregistered scheme id, is never mistaken for an address.
 *
 * `notes()` — and the allowlist filter over it — is computed LAZILY and AT MOST
 * ONCE per call: nothing runs until a scheme-shaped value is actually met, and
 * from then on every further value in the SAME call reuses the one listing.
 * Before this memoization a K-address batch enumerated and allowlist-filtered
 * the whole vault K times (O(K x N) against a single mapPaths walk) — a real
 * cost on a large vault, and one a read-only sandboxed session could trigger
 * synchronously, unserialized, since reads never take the write queue.
 *
 * Exclusion (`SchemeInstanceConfig.excludedRoots`) is applied AFTER the
 * shared `visible` memo, per ref, keyed on THAT ref's own instance
 * (`excludeRoots(visible, parsed.instance.excludedRoots)`) — exclusion is
 * per-instance while the visible listing is call-wide, so a batch mixing
 * refs across two instances with different excluded roots still shares the
 * one `visiblePaths` computation and only refilters (a cheap array scan) per
 * instance actually used.
 */
export function resolveSchemeArgs(
  args: Record<string, unknown>,
  reg: SchemeRegistry | null,
  notes: () => string[],
  settings?: GuardSettings | null
): SchemeAddressing {
  const resolved: Array<{ ref: string; path: string }> = [];
  // undefined ⇒ not yet computed for this call; set once, on the FIRST
  // scheme-shaped value, then reused for every subsequent one.
  let visible: string[] | undefined;
  const rewritten = mapPaths(args ?? {}, (value) => {
    if (!reg) return value;
    const detailed = reg.parseRefDetailed(value);
    // A ref naming a SKIPPED id (#88): refuse before the handler ever runs,
    // same as an unresolved or ambiguous address below — the id it names is
    // configured but has no live instance, so there is nothing to resolve
    // against, and silently falling through as "not a scheme ref" would let
    // an ordinary-path branch of the handler run against a literal string
    // like "jd:06.11" instead of telling the caller why addressing failed.
    if (detailed.kind === "skipped") throw new SchemeUnavailableError(detailed.id);
    if (detailed.kind === "none") return value;
    if (visible === undefined) visible = visiblePaths(notes(), settings);
    const candidates = excludeRoots(visible, detailed.instance.excludedRoots);
    const path = resolveParsedAddress(reg, detailed, value, candidates);
    resolved.push({ ref: value, path });
    return path;
  });
  return { args: rewritten, resolved };
}
