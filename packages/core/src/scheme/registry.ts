// registry.ts — the SchemeRegistry: multiple named scheme instances (each a
// provider name + a merged config) plus the refusal of the retired
// `<scheme-id>:<address>` path syntax (`refuseSchemeRefs`). Kernel-module rules
// apply: nothing here imports from "obsidian".
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
import { collectPaths } from "../guard-paths.js";

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
   * visible listing and `schemeFindings`. It bounds SCHEME resolution and scheme tool output
   * ONLY — an excluded note's own path still works as an ordinary path
   * argument (read, write, uid resolution, …); this is not a second
   * allowlist.
   */
  excludedRoots?: string[];
}

/**
 * No scheme on a fresh install (01.33, pick A step b): schemes are opt-in.
 * With no instance there is no scheme tool and no scheme check; `uid:` and paths work as before. A vault turns Johnny Decimal
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
 * saved once. Otherwise the stored list as it is (a value that is not a list
 * reads as none).
 */
export function schemesOnLoad(own: unknown, adopted?: unknown): SchemesOnLoad {
  const asObject = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const stored = asObject(own) ?? asObject(adopted);
  if (!stored) return { schemes: [], persist: true };
  if (!Object.prototype.hasOwnProperty.call(stored, "schemes")) return { schemes: [{ ...JD_SCHEME_INSTANCE }], persist: true };
  const list = stored.schemes;
  return { schemes: Array.isArray(list) ? structuredClone(list as SchemeInstanceConfig[]) : [], persist: asObject(own) === null };
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

  /** The configured scheme id (live or skipped) that `value` starts with,
   * followed by a colon, or null. `uid` is reserved and never matches. The
   * test `refuseSchemeRefs` uses to refuse the retired path syntax. */
  refId(value: string): string | null {
    const m = value.match(/^([a-z][a-z0-9-]*):/);
    if (!m || m[1] === "uid") return null;
    return this.byId.has(m[1]) || this.rawSkipped.has(m[1]) ? m[1] : null;
  }

  /** "jd:06.11" -> resolved / skipped / none. The full-detail form of
   * `parseRef` (below): distinguishes a ref naming a SKIPPED id (no live
   * instance — a typed `scheme_unavailable` refusal is warranted) from every
   * other reason a ref isn't a resolvable scheme address (not scheme-shaped
   * at all, the reserved "uid:" prefix, an unregistered id, or an id-shaped
   * address the provider itself can't parse) — all of those are `"none"`,
   * meaning "not a resolvable scheme ref" (the address tools' input; a path
   * argument is checked by `refId` instead). A
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
   * "not a resolvable scheme ref". A caller that must distinguish
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
 * (`mapPaths`'s no-op sharing) relies on to treat "unchanged" as `===`, and the byte-identical
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
  // constructor is also used directly (in tests) and must keep its own simpler last-wins-by-Map semantics for a caller
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

// ── the retired scheme-address path syntax ──────────────────────────────────
//
// A path argument of the form `<scheme-id>:<address>` (`jd:06.11`) used to
// resolve to the note at that address, at the same interception point as
// `uid:`. That syntax is retired (Nelson, 2026-10-30: "retire em", after a
// finding that nothing used it). A path argument that starts with a
// CONFIGURED scheme id and a colon is now refused, never read as a plain path
// that happens to start with that text: a caller who still writes the old
// form learns why, instead of reading or writing a note named "jd:06.11".
// Reading or allocating an address stays with the scheme tools
// (`obsidian_resolve_address`, `obsidian_next_address`, ...); only the path
// syntax is gone. `uid:` is reserved and untouched.

/** A path argument used the retired `<scheme-id>:<address>` syntax. */
export class SchemeRefRetiredError extends Error {
  readonly code = "scheme_ref_retired";

  constructor(
    readonly ref: string,
    readonly id: string,
    alternatives = "a vault-relative path or a uid:<value> ref",
  ) {
    super(`"${ref}" uses the scheme-address path syntax ("${id}:<address>"), which is retired; name the note by ${alternatives}`);
    this.name = "SchemeRefRetiredError";
  }
}

/**
 * Throw `SchemeRefRetiredError` for the first path argument (by the guard's own
 * walk, `collectPaths`, so the same keys the allowlist scopes) that starts
 * with `<id>:` for an id the registry was configured with, live or skipped.
 * `reg` absent or an id that is not configured ⇒ nothing is refused: a
 * filename that merely contains a colon is an ordinary path.
 */
export function refuseSchemeRefs(args: Record<string, unknown>, reg: SchemeRegistry | null, alternatives?: string): void {
  if (!reg) return;
  for (const value of collectPaths(args ?? {})) {
    const id = reg.refId(value);
    if (id !== null) throw new SchemeRefRetiredError(value, id, alternatives);
  }
}
