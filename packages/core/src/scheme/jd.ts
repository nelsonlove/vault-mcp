// jd.ts — the Johnny Decimal ScopeProvider.
//
// The grammar core below (parseJdId, areaOfCategory, categoryOf,
// isExpandedCategory, isExpandedAreaItem, isStandardZero, idTokenFromName,
// nextContentDecimal) is ported VERBATIM from obsidian-johnny-decimal's
// src/core/jdId.ts — same regexes, same branch order, same edge cases.
// (Amendment, #93: nextContentDecimal's starting decimal is no longer
// hardwired — it takes a `floor` parameter fed by JdConfig.contentDecimalFloor,
// defaulting to 10 when absent. The DEFAULT behavior — and every other edge
// case — is still the verbatim port; only that one bound became config-driven
// rather than a literal in the function body. See nextContentDecimal's own
// doc comment, below, for the detail.) Only names that the ScopeProvider
// interface forces have changed (CoreConfig -> JdConfig, DEFAULT_CONFIG ->
// DEFAULT_JD_CONFIG). See that file's header for the full shape catalogue and
// the three predecessors it reconciles:
//
//   - area          XX-YY            e.g. 00-09, 90-99   (hyphen, not en-dash)
//   - category      XX               e.g. 06, 72
//   - id            XX.YY / XX.YYY   e.g. 06.11, 06.110
//   - expanded-item NNNNN            e.g. 92021 (expanded area) or 27001 (expanded category)
//   - fractal-id    NNNNN.YY         e.g. 92021.10 (inside an expanded area)
//
// Everything else (e.g. "26 2.18") is malformed.
//
// Task 1 implemented parse/format/addressOf/validateName plus capabilities.
// Task 2 (below, in jdProvider's returned object) implements the five
// vault-aware methods — scopeOf/chainOf/membersOf/expectedFolder/nextFree —
// all pure over a supplied `notes: string[]` vault listing, same as
// everything else in this file: no I/O, no "obsidian" import.

import type { Address, Capabilities, Member, Scope, SchemeFinding, ScopeProvider } from "./provider.js";

export interface JdConfig {
  /** Areas whose whole band uses 5-digit sequential IDs, e.g. ["90-99"]. */
  expandedAreas: string[];
  /** Single categories that use 5-digit flat IDs, e.g. ["27"]. */
  expandedCategories: string[];
  /**
   * Scheme semantics are configuration, not hardwired (Nelson's ruling): the
   * lowest two-digit decimal (0-99) that nextFree's plain-category branch
   * allocates as content — decimals below the floor are reserved (standard
   * zeros in the stock scheme). Optional, defaulting to 10 (today's hardwired
   * behavior) when absent, so an unconfigured instance is byte-identical to
   * before this field existed. Not added to DEFAULT_JD_CONFIG itself — the
   * `?? 10` fallback at the one call site (nextFree) is the default, so a
   * config merge that never mentions this key behaves exactly as if it were
   * required-with-a-default, without forcing every config literal to spell it
   * out.
   */
  contentDecimalFloor?: number;
}

export const DEFAULT_JD_CONFIG: JdConfig = {
  expandedAreas: ["90-99"],
  expandedCategories: ["27"],
};

// ── grammar core (ported verbatim from obsidian-johnny-decimal/src/core/jdId.ts) ──

type JdKind = "area" | "category" | "id" | "expanded-item" | "fractal-id";

interface ParsedId {
  raw: string;
  kind: JdKind;
  /** Area band, e.g. "00-09". */
  area: string;
  /** Category code, e.g. "06" (empty for a bare area); the full 5-digit
   * token for a fractal-id, matching the source's field reuse. */
  category: string;
  /** Decimal part for id/fractal-id (e.g. "11", "110", "10"); null otherwise. */
  decimal: string | null;
}

/** The area band (e.g. "90-99") that a 2-digit category (e.g. "92") belongs to. */
function areaOfCategory(cat: string): string {
  const d = cat[0];
  return `${d}0-${d}9`;
}

const RE_AREA = /^([0-9])0-([0-9])9$/; // 00-09, 10-19, ... 90-99 (digits must match)
const RE_CATEGORY = /^[0-9]{2}$/;
const RE_ID = /^([0-9]{2})\.([0-9]{2,3})$/; // widened to 2–3 digit decimal (survey)
const RE_FRACTAL = /^([0-9]{5})\.([0-9]{2})$/;
const RE_FIVE = /^([0-9]{5})$/;

/**
 * Parse a raw jd-id string. Returns null when the string is not a valid JD
 * identifier under the given config (i.e. it is malformed / not a JD id).
 */
function parseJdId(raw: string, cfg: JdConfig): ParsedId | null {
  const s = raw.trim();

  const am = s.match(RE_AREA);
  if (am && am[1] === am[2]) {
    return { raw: s, kind: "area", area: s, category: "", decimal: null };
  }
  if (RE_CATEGORY.test(s)) {
    return { raw: s, kind: "category", area: areaOfCategory(s), category: s, decimal: null };
  }
  let m = s.match(RE_ID);
  if (m) {
    return { raw: s, kind: "id", area: areaOfCategory(m[1]), category: m[1], decimal: m[2] };
  }
  m = s.match(RE_FRACTAL);
  if (m) {
    const cat = m[1].slice(0, 2);
    if (cfg.expandedAreas.includes(areaOfCategory(cat))) {
      return { raw: s, kind: "fractal-id", area: areaOfCategory(cat), category: cat, decimal: m[2] };
    }
    return null;
  }
  m = s.match(RE_FIVE);
  if (m) {
    const cat = s.slice(0, 2);
    if (cfg.expandedAreas.includes(areaOfCategory(cat)) || cfg.expandedCategories.includes(cat)) {
      return { raw: s, kind: "expanded-item", area: areaOfCategory(cat), category: cat, decimal: null };
    }
    return null;
  }
  return null;
}

/**
 * The 2-digit category of any JD id form, config-agnostic (dashboard semantics):
 *   06.12 -> 06, 06.110 -> 06, 92001 -> 92, 92021.10 -> 92, 00-09 -> 00, 06 -> 06.
 * A leading `+SUFFIX` (Extend-the-End) and any trailing title are stripped first.
 * Returns null when the token is not a recognizable JD id shape.
 * NOTE: a non-null result does NOT imply parseJdId accepts the token — categoryOf
 * is deliberately loose (e.g. malformed area "05-19" -> "05" here, but null from
 * parseJdId). Use parseJdId when you need validity, not just the category.
 */
function categoryOf(id: string): string | null {
  const token = id.trim().split(" ")[0].split("+")[0];
  // Every JD id form begins with a 2-digit category.
  if (/^\d{2}(-\d{2}|\.\d{2,3}|\d{3}(\.\d{2})?)?$/.test(token)) {
    return token.slice(0, 2);
  }
  return null;
}

/** True when the category uses 5-digit IDs (expanded area or expanded category). */
function isExpandedCategory(cat: string, cfg: JdConfig): boolean {
  return cfg.expandedCategories.includes(cat) || cfg.expandedAreas.includes(areaOfCategory(cat));
}

/**
 * True when `id` is a 5-digit item (or fractal) belonging to an EXPANDED AREA
 * (as opposed to an expanded category).
 */
function isExpandedAreaItem(id: string, cfg: JdConfig): boolean {
  const p = parseJdId(id, cfg);
  return !!p && (p.kind === "expanded-item" || p.kind === "fractal-id") && cfg.expandedAreas.includes(p.area);
}

/** Standard-zero slots .00–.09 are reserved for infrastructure, not content. */
function isStandardZero(id: ParsedId): boolean {
  if (id.kind !== "id" || id.decimal === null) return false;
  // Standard zeros are the 2-digit slots .00–.09; a 3-digit decimal is never one.
  return id.decimal.length === 2 && parseInt(id.decimal, 10) <= 9;
}

/**
 * The full leading "decorated token" of a filename — everything up to the
 * first space, e.g. "43.11+2024" out of "43.11+2024 Foo.md", or "06.11" out
 * of "06.11 Foo.md" (no Extend-the-End suffix to carry). This is the span
 * idTokenFromName further strips a `+YYYY` suffix FROM, and it is ALSO the
 * span titleOf must strip in full — the address token plus any Extend-the-End
 * decoration immediately following it, not just the bare address token — to
 * avoid leaving a dangling "+2024" glued onto the returned title.
 */
function leadingDecoratedToken(name: string): string {
  return name.split(" ")[0];
}

/**
 * Strip an Extend-the-End suffix (e.g. "43.11+2024 Foo" -> "43.11") and a
 * trailing title, returning just the leading id token of a filename.
 * Returns the raw token (still needs parseJdId to validate).
 */
function idTokenFromName(name: string): string {
  const token = leadingDecoratedToken(name);
  const plus = token.indexOf("+");
  return plus === -1 ? token : token.slice(0, plus);
}

/**
 * Given a set of used decimal parts in a normal category, return the next free
 * two-digit content decimal (floor..99), or null if the category is full.
 * Content IDs start at `floor` (default 10 — .00-.09 are the reserved
 * standard zeros in the stock scheme); a configured floor reserves a
 * different-sized band instead, per JdConfig.contentDecimalFloor.
 */
function nextContentDecimal(used: Set<number>, floor: number): string | null {
  for (let n = floor; n <= 99; n++) {
    if (!used.has(n)) return String(n).padStart(2, "0");
  }
  return null;
}

// categoryOf / isExpandedAreaItem / isStandardZero are ported and available
// but not called below — Task 2's methods work directly off ParsedId's own
// area/category/decimal fields (already validated by parseJdId), which makes
// the looser categoryOf and the boolean isExpandedAreaItem/isStandardZero
// checks redundant for this file's purposes. isExpandedCategory is likewise
// not reused for the Scope-kind "category" dispatch in nextFree: its OR
// branch also matches a category folded into an expanded AREA, which cannot
// arise as a "category" Scope in the first place (an expanded area collapses
// the category level entirely — see levelsOf's expanded-item branch), so a
// direct `cfg.expandedCategories.includes(token)` check is both sufficient
// and avoids implying a case that can't occur. nextContentDecimal IS used,
// verbatim, by nextFree's plain-category branch.

// ── Address <-> ParsedId ─────────────────────────────────────────────────────

/** See the `Address.levels` doc in provider.ts for the folder-path convention
 * this builds — the folder-name token an address carries at each nesting
 * level, not the grammar's own structural fields. */
function levelsOf(p: ParsedId, cfg: JdConfig): string[] {
  switch (p.kind) {
    case "area":
      return [p.area];
    case "category":
      return [p.area, p.category];
    case "id":
      return [p.area, p.category, p.decimal as string];
    case "fractal-id":
      // p.category here is only the 2-digit prefix (parseJdId's fractal
      // branch slices m[1] to 2 digits, verbatim) — the folder token is the
      // full 5-digit item, which is the part of `raw` before the dot.
      return [p.area, p.raw.split(".")[0], p.decimal as string];
    case "expanded-item":
      // An expanded AREA collapses the category folder entirely (items sit
      // directly under the area); an expanded CATEGORY keeps its folder and
      // only flattens the ids within it.
      return cfg.expandedAreas.includes(p.area) ? [p.area, p.raw] : [p.area, p.category, p.raw];
    default: {
      const _exhaustive: never = p.kind;
      throw new Error(`unreachable JdKind: ${String(_exhaustive)}`);
    }
  }
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** A leading token that at least LOOKS like a JD id (digits, dots, hyphens) —
 * used to distinguish "malformed address" from "simply not addressed". */
const LOOKS_NUMERIC = /^[0-9][0-9.\-]*$/;

/** Name-hygiene regexes, ported verbatim from obsidian-jd-numbering's
 * src/lint.ts. `JD_NAME_COLON` flags a colon anywhere in the filename;
 * `JD_NAME_TRAILING_SPACE` flags a space at the very end or right before the
 * `.md` extension. Filename-in-isolation checks, so validateName's home. */
const JD_NAME_COLON = /:/;
const JD_NAME_TRAILING_SPACE = / \.md$| $/;

/** A path's folder segments, top to bottom, with the filename dropped. */
function folderSegments(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  return parts;
}

/** A folder segment's leading token (same convention as idTokenFromName, but
 * folder names carry no Extend-the-End suffix — just "<token> <title>"). */
function folderToken(segment: string): string {
  return segment.split(" ")[0];
}

/** Parse the address a note's filename carries, as a ParsedId (not the
 * public Address shape) — for internal use where the structural fields
 * (area/category/decimal) are needed directly. Same extraction addressOf
 * uses. */
function parsedFromPath(path: string, cfg: JdConfig): ParsedId | null {
  return parseJdId(idTokenFromName(basename(path)), cfg);
}

/**
 * Walk `path`'s folder segments outermost-to-innermost, validating each
 * candidate scope token against the ancestor established so far — NOT just
 * testing tokens in isolation. A folder token that parses as area / category
 * / expanded-item only extends the chain when it is positionally consistent
 * with the current context:
 *   - area: only at the root (no scope established yet).
 *   - category: only directly under ITS OWN area (areaOfCategory(token) must
 *     equal the current area) — or at the root, for a bare category folder
 *     with no area wrapper.
 *   - expanded-item: only directly under its own area (expanded-AREA items)
 *     or its own category (expanded-CATEGORY items).
 * Anything else — an unparseable folder name, an id/fractal-id folder (an
 * id's own attachment-folder, not a new scope container), or a token that
 * parses but sits at the WRONG position (e.g. a bare "06" nested one level
 * too deep inside another category's folder, or an id's attachment folder
 * that happens to be named like a category, e.g. "06.11 Note/11 Attachments")
 * — does not extend the chain and is skipped without disturbing the current
 * context, so garbage nesting below a valid scope can never be mistaken for
 * a deeper (or a completely unrelated) one.
 *
 * Returns the ordered list of valid {scope, index} entries actually found
 * (index = the segment's position in `path.split("/")`, for slicing back to
 * a folder path). The LAST entry is the path's deepest valid scope
 * (`scopeOf`'s answer); ANY entry can be the container `expectedFolder`
 * needs, keyed by token.
 */
function scopesAlongPath(path: string, cfg: JdConfig): Array<{ scope: Scope; index: number }> {
  const segments = folderSegments(path);
  const chain: Array<{ scope: Scope; index: number }> = [];
  let current: Scope | null = null;
  for (let i = 0; i < segments.length; i++) {
    const p = parseJdId(folderToken(segments[i]), cfg);
    if (!p) continue;
    if (p.kind === "area") {
      if (current === null) {
        current = { kind: "area", token: p.raw };
        chain.push({ scope: current, index: i });
      }
      continue;
    }
    if (p.kind === "category") {
      const consistent = current === null || (current.kind === "area" && areaOfCategory(p.category) === current.token);
      if (consistent) {
        current = { kind: "category", token: p.raw };
        chain.push({ scope: current, index: i });
      }
      continue;
    }
    if (p.kind === "expanded-item") {
      const area = areaOfCategory(p.category);
      const inExpandedArea = cfg.expandedAreas.includes(area) && current !== null && current.kind === "area" && current.token === area;
      const inExpandedCategory =
        cfg.expandedCategories.includes(p.category) && current !== null && current.kind === "category" && current.token === p.category;
      if (inExpandedArea || inExpandedCategory) {
        current = { kind: "expanded-item", token: p.raw };
        chain.push({ scope: current, index: i });
      }
      continue;
    }
    // "id" / "fractal-id": not scope containers themselves (an id's own
    // folder holds its attachments, not deeper scopes) — skip, unchanged.
  }
  return chain;
}

/**
 * Whether `scope` is EVER capable of allocation, independent of vault
 * content (a purely structural, config-only judgment — no `notes` argument,
 * unlike `nextFree`). This is the piece the tools layer (obsidian_next_address
 * / obsidian_list_scope) needs to distinguish "this kind of scope can never
 * allocate" (`allocatable: false`, with a hint pointing at where allocation
 * IS possible) from "this scope is allocatable but genuinely full right now"
 * (`allocatable: true`, `exhausted: true` from `nextFree` returning null over
 * the actual notes listing) — both of which `nextFree` alone reports as an
 * indistinguishable null.
 *
 * Mirrors nextFree's own three-way dispatch (plain vs. expanded category,
 * plain vs. expanded area) structurally, rather than by probing
 * `nextFree(scope, [])` — that would give the same answer for every kind
 * here (an allocate-capable kind always has room when nothing is used yet),
 * but expresses the "which KIND is this" judgment implicitly instead of
 * naming it, and provides no hint text.
 */
function allocatabilityOf(scope: Scope, cfg: JdConfig): { allocatable: boolean; hint?: string } {
  if (scope.kind === "category") {
    if (cfg.expandedCategories.includes(scope.token)) return { allocatable: true };
    const area = areaOfCategory(scope.token);
    if (cfg.expandedAreas.includes(area)) {
      // Item 1's case: this category's band allocates instead.
      return { allocatable: false, hint: `allocate via scope "${area}"` };
    }
    return { allocatable: true };
  }
  if (scope.kind === "area") {
    if (cfg.expandedAreas.includes(scope.token)) return { allocatable: true };
    return { allocatable: false, hint: "a plain area has no address of its own — allocate within one of its categories" };
  }
  if (scope.kind === "expanded-item") {
    return { allocatable: false, hint: "fractal-id allocation within an expanded item is not part of this version's allocate surface" };
  }
  return { allocatable: false };
}

// ── the provider ─────────────────────────────────────────────────────────────

export function jdProvider(cfg: JdConfig): ScopeProvider {
  const capabilities: Capabilities = { validate: true, itemAddresses: true, allocate: true, ordered: true };

  function toAddress(p: ParsedId): Address {
    return { raw: p.raw, kind: p.kind, levels: levelsOf(p, cfg) };
  }

  function parse(raw: string): Address | null {
    const p = parseJdId(raw, cfg);
    return p ? toAddress(p) : null;
  }

  function format(addr: Address): string {
    return addr.raw;
  }

  function addressOf(path: string): Address | null {
    const token = idTokenFromName(basename(path));
    return parse(token);
  }

  // Name-hygiene regexes ported VERBATIM from obsidian-jd-numbering's
  // src/lint.ts (`RE_COLON` / `RE_TRAILING_SPACE`): a colon anywhere in the
  // filename, and a trailing space either at the very end or immediately
  // before the `.md` extension. These are the two of jd-numbering's checkNote
  // lint checks scheme's model previously lacked AND could express purely over
  // a filename (its remaining checks either duplicate scheme's own
  // malformed/duplicate/misfiled/unaddressed, or depend on frontmatter/tags
  // this path-canonical model deliberately does not read — see the fold PR).
  // The REGEXES are verbatim; their APPLICATION SCOPE is intentionally broader
  // — jd-numbering runs its hygiene checks only after a valid parsed
  // frontmatter id (`if (!note.parsed) return`), whereas this checks every
  // filename. That is the correct behavior for a filename-in-isolation check
  // and a direct consequence of the path-canonical (no-frontmatter) model.
  function validateName(filename: string): SchemeFinding[] {
    const findings: SchemeFinding[] = [];
    const token = idTokenFromName(filename);
    // malformed_name FIRST, so it keeps index 0 for every caller that already
    // relied on `validateName(...)[0]` being the address-token verdict.
    if (LOOKS_NUMERIC.test(token) && parseJdId(token, cfg) === null) {
      findings.push({
        code: "malformed_name",
        path: filename,
        detail: `'${token}' looks like a Johnny Decimal id but does not parse`,
      });
    }
    if (JD_NAME_COLON.test(filename)) {
      findings.push({ code: "name_colon", path: filename, detail: "filename must not contain a colon" });
    }
    if (JD_NAME_TRAILING_SPACE.test(filename)) {
      findings.push({ code: "name_trailing_space", path: filename, detail: "filename has a trailing space" });
    }
    return findings;
  }

  return {
    capabilities,
    parse,
    format,
    addressOf,
    validateName,
    // The path's DEEPEST validly-positioned scope (scopesAlongPath's last
    // entry) — independent of what the note's OWN filename says (a note
    // with no address, or a malformed one, still lives in a scope). Position
    // matters, not just token shape: a folder token that parses as a
    // category but sits somewhere a category token can't validly occur
    // (nested inside another category's folder, or inside an id's own
    // attachment folder — e.g. ".../06.11 Note/11 Attachments/photo.md",
    // where "11" is just a folder name, not category 11) is not a scope.
    scopeOf(path: string): Scope | null {
      const chain = scopesAlongPath(path, cfg);
      return chain.length === 0 ? null : chain[chain.length - 1].scope;
    },

    // Self first, root last. An expanded-item's parent depends on whether it
    // sits in an expanded AREA (collapses straight to the area, no category
    // level — levelsOf's expanded-item branch) or an expanded CATEGORY (the
    // category folder survives).
    chainOf(scope: Scope): Scope[] {
      switch (scope.kind) {
        case "area":
          return [scope];
        case "category":
          return [scope, { kind: "area", token: areaOfCategory(scope.token) }];
        case "expanded-item": {
          const cat = scope.token.slice(0, 2);
          const area = areaOfCategory(cat);
          if (cfg.expandedAreas.includes(area)) {
            return [scope, { kind: "area", token: area }];
          }
          return [scope, { kind: "category", token: cat }, { kind: "area", token: area }];
        }
        default:
          return [scope];
      }
    },

    // Membership is decided by ADDRESS, not physical folder location: a note
    // whose filename carries no address is excluded here even if it lives
    // inside the scope's folder (it's an `unaddressed` finding, Task 4's
    // business, not a member). A scope's own self-address (e.g. a bare "06"
    // note for the category scope {category, "06"}) is excluded too — it
    // names the container, not something inside it.
    membersOf(scope: Scope, notes: string[]): Member[] {
      const isMember = (p: ParsedId): boolean => {
        switch (scope.kind) {
          case "area":
            return p.area === scope.token && p.raw !== scope.token;
          case "category":
            return p.category === scope.token && p.raw !== scope.token;
          case "expanded-item":
            return p.kind === "fractal-id" && p.raw.split(".")[0] === scope.token;
          default:
            return false;
        }
      };
      // Numeric sort key: [primary, secondary], ascending. `primary` is
      // always the 2-digit CATEGORY — every kind here (bare category, id,
      // expanded-item, fractal-id) sits under one, and keying on it is what
      // lets an expanded category's members collate alongside their numeric
      // neighbors within the enclosing area — e.g. area 20-29 with category
      // 27 expanded: 27001/27002 must sort between 26.x and 28.x, not after
      // 28.x/29.x the way comparing a raw 5-digit value against a bare 28
      // would put them (item 2 bug fix).
      //
      // `secondary` is scaled by 1000 so an expanded-item's own fractal
      // children (kind "fractal-id", e.g. "92021.10" under item "92021")
      // sort immediately after their parent and before the next item, not
      // detached from it by comparing the fractal's full 5-digit-item value
      // against a DIFFERENT scale than its parent uses (a post-merge
      // regression this reintroduced when item 2 first fixed the collation
      // above: keying a fractal-id on its raw item number instead of
      // matching its parent's [category, item] scale reordered
      // ["92021","92021.10","92022"] to ["92021","92022","92021.10"]).
      // A bare item's secondary is itemNumber * 1000 (no remainder); a
      // fractal child's is itemNumber * 1000 + 1 + decimal (decimal is
      // 0-99, so the +1..+100 range never reaches the next item's bare
      // secondary 1000 further up) — parent, then its children in decimal
      // order, then the next item, with plenty of headroom to spare.
      const sortKey = (p: ParsedId): [number, number] => {
        switch (p.kind) {
          case "id":
            return [parseInt(p.category, 10), parseInt(p.decimal as string, 10)];
          case "category":
            return [parseInt(p.category, 10), -1];
          case "expanded-item":
            return [parseInt(p.category, 10), parseInt(p.raw, 10) * 1000];
          case "fractal-id":
            return [
              parseInt(p.category, 10),
              parseInt(p.raw.split(".")[0], 10) * 1000 + 1 + parseInt(p.decimal as string, 10),
            ];
          default:
            return [0, -1];
        }
      };
      const members: Array<{ path: string; p: ParsedId }> = [];
      for (const path of notes) {
        const p = parsedFromPath(path, cfg);
        if (p && isMember(p)) members.push({ path, p });
      }
      members.sort((a, b) => {
        const [ak0, ak1] = sortKey(a.p);
        const [bk0, bk1] = sortKey(b.p);
        return ak0 - bk0 || ak1 - bk1;
      });
      return members.map(({ path, p }) => ({ path, address: format(toAddress(p)) }));
    },

    // The folder an address's CONTAINER actually lives in, found by locating
    // a VALIDLY-POSITIONED folder segment among `notes` whose token matches
    // that container (scopesAlongPath, not bare token equality — see its
    // doc comment). `levels` (Address.levels) is the folder-path convention:
    // the second-to-last entry is always the container token — for "id"
    // that's the category; for a bare "category" it's the area (levels =
    // [area, category], so index length-2 = 0 = area); for an expanded-item
    // inside an expanded area (2 levels, no category folder) it's the area;
    // inside an expanded category (3 levels) it's the category; for a
    // fractal-id it's the expanded-item's own 5-digit folder. An address
    // with fewer than 2 levels (a bare area) has no container to find.
    //
    // Position-validating the match matters: without it, a stray folder
    // elsewhere in the vault sharing a category's 2-digit token — e.g.
    // "50-59 Something/52 Other/06 Rogue/…", where "06" is nested one level
    // too deep to be a real category folder — could be mistaken for id
    // "06.13"'s real container. scopesAlongPath rejects that "06" outright
    // (its immediate parent is a category, not an area), so it's never a
    // candidate. Deterministic tie-break, tested: when two notes genuinely
    // both carry a validly-positioned match for the same container (a
    // vault-consistency question this method can't resolve further), the
    // FIRST in `notes` listing order wins — not the shortest path, not any
    // other heuristic.
    expectedFolder(addr: Address, notes: string[]): string | null {
      if (addr.levels.length < 2) return null;
      const containerToken = addr.levels[addr.levels.length - 2];
      for (const note of notes) {
        const hit = scopesAlongPath(note, cfg).find((entry) => entry.scope.token === containerToken);
        if (hit) return folderSegments(note).slice(0, hit.index + 1).join("/");
      }
      return null;
    },

    // category scope: lowest unused two-digit content decimal (nextContentDecimal;
    //   .00-.09 reserved BY DEFAULT — the floor is config-driven,
    //   JdConfig.contentDecimalFloor, verbatim only in its default of 10 — and
    //   exhaustion at .99 always returns null), UNLESS the category is one of
    //   cfg.expandedCategories, in which case it
    //   allocates 5-digit ids like an expanded area does (see below).
    // area scope: null, UNLESS the area is one of cfg.expandedAreas.
    // expanded area / expanded category: next 5-digit sequential id.
    //   Convention (see JdConfig / task brief): the numeric space for an
    //   expanded AREA is <band-first-digit><4-digit sequence> (e.g. band
    //   "90-99" -> 90000..99999, starting at 90001 when empty); for an
    //   expanded CATEGORY it's <2-digit category><3-digit sequence> (e.g.
    //   category "27" -> 27000..27999, starting at 27001 when empty). Both
    //   allocate strictly max(used)+1, not lowest-unused — a used id is
    //   never reclaimed by a later gap.
    // expanded-item scope (e.g. "92021", allocating fractal sub-ids like
    //   "92021.11"): not part of v1's allocate surface, so null — same
    //   "allocate ids, not categories" boundary as the plain-area case.
    nextFree(scope: Scope, notes: string[]): Address | null {
      if (scope.kind === "category" && cfg.expandedCategories.includes(scope.token)) {
        const base = parseInt(scope.token, 10) * 1000;
        const used = new Set<number>();
        for (const note of notes) {
          const p = parsedFromPath(note, cfg);
          if (p && p.kind === "expanded-item" && p.category === scope.token) {
            used.add(parseInt(p.raw, 10));
          }
        }
        const next = used.size === 0 ? base + 1 : Math.max(...used) + 1;
        if (next > base + 999) return null;
        return parse(String(next).padStart(5, "0"));
      }
      if (scope.kind === "category" && cfg.expandedAreas.includes(areaOfCategory(scope.token))) {
        // Item 1 bug fix: a category folded into an expanded AREA's band
        // (e.g. "92" under band "90-99") has no per-category decimal space
        // of its own — the whole band uses 5-digit band-sequential ids
        // instead. Allocating "92.10" here would be an invalid id; the band
        // scope itself (kind "area", token "90-99") is where allocation
        // happens. See `allocatable` below for the structural (config-only)
        // version of this same judgment, which the tool layer uses to
        // report this as "never allocatable" rather than "exhausted".
        return null;
      }
      if (scope.kind === "category") {
        const used = new Set<number>();
        for (const note of notes) {
          const p = parsedFromPath(note, cfg);
          if (p && p.kind === "id" && p.category === scope.token) {
            used.add(parseInt(p.decimal as string, 10));
          }
        }
        const decimal = nextContentDecimal(used, cfg.contentDecimalFloor ?? 10);
        return decimal === null ? null : parse(`${scope.token}.${decimal}`);
      }
      if (scope.kind === "area" && cfg.expandedAreas.includes(scope.token)) {
        const bandDigit = scope.token[0];
        const base = parseInt(bandDigit, 10) * 10000;
        const used = new Set<number>();
        for (const note of notes) {
          const p = parsedFromPath(note, cfg);
          if (!p) continue;
          if (p.kind === "expanded-item" && p.area === scope.token) {
            used.add(parseInt(p.raw, 10));
          } else if (p.kind === "fractal-id" && p.area === scope.token) {
            used.add(parseInt(p.raw.split(".")[0], 10));
          }
        }
        const next = used.size === 0 ? base + 1 : Math.max(...used) + 1;
        if (next > base + 9999) return null;
        return parse(String(next).padStart(5, "0"));
      }
      // Plain (non-expanded) area, or an expanded-item scope: v1 does not
      // allocate here.
      return null;
    },

    allocatable(scope: Scope) {
      return allocatabilityOf(scope, cfg);
    },

    occupantOf(addr: Address, notes: string[]): Member | null {
      const target = format(addr);
      for (const path of notes) {
        const p = parsedFromPath(path, cfg);
        if (p && format(toAddress(p)) === target) return { path, address: target };
      }
      return null;
    },

    titleOf(path: string): string {
      const name = basename(path).replace(/\.md$/, "");
      const token = idTokenFromName(basename(path));
      if (token && parseJdId(token, cfg)) {
        // Strip the FULL leading decorated token (address + optional +YYYY
        // Extend-the-End suffix), not just the bare address `token` — a
        // "43.11+2024 Foo" name's decorated span is "43.11+2024" (10 chars),
        // longer than the 5-char address token alone, and slicing off only
        // the shorter span would leave "+2024" dangling in front of the
        // title (the bug this comment fixes).
        return name.slice(leadingDecoratedToken(name).length).trimStart();
      }
      return name;
    },
  };
}

// ── config validation ───────────────────────────────────────────────────────
//
// Flexible user config schema (Nelson's ruling): schemes[].config is a
// per-provider namespace validated by the provider, skip-and-report rather
// than thrown. This is that validation for the JD provider — the registry
// (registry.ts) calls it before constructing an instance and skips the
// instance (console.error) when the returned list is non-empty. A config that
// is `undefined` (no override at all) is always valid — there is nothing to
// check. Each check reuses the SAME token grammar parseJdId/nextContentDecimal
// rely on (RE_AREA with matching digits, RE_CATEGORY), so "valid area/category
// token" here can never drift from what the provider itself will accept.

function isValidAreaToken(token: string): boolean {
  const m = token.match(RE_AREA);
  return !!m && m[1] === m[2];
}

function isValidCategoryToken(token: string): boolean {
  return RE_CATEGORY.test(token);
}

/**
 * Validate a raw (untrusted, `unknown`) JdConfig override. Returns a list of
 * human-readable problems — empty means valid. Never throws: a malformed
 * config (e.g. loaded from hand-edited data.json) is data to report, not an
 * exception to propagate.
 */
export function validateJdConfig(config: unknown): string[] {
  if (config === undefined) return [];
  const problems: string[] = [];
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    problems.push("config must be an object");
    return problems;
  }
  const c = config as Record<string, unknown>;

  if ("expandedAreas" in c && c.expandedAreas !== undefined) {
    const v = c.expandedAreas;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      problems.push("expandedAreas must be an array of strings (e.g. [\"90-99\"])");
    } else {
      for (const token of v) {
        if (!isValidAreaToken(token)) problems.push(`expandedAreas: "${token}" is not a valid area token (expected e.g. "90-99")`);
      }
    }
  }

  if ("expandedCategories" in c && c.expandedCategories !== undefined) {
    const v = c.expandedCategories;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      problems.push("expandedCategories must be an array of strings (e.g. [\"27\"])");
    } else {
      for (const token of v) {
        if (!isValidCategoryToken(token)) problems.push(`expandedCategories: "${token}" is not a valid category token (expected e.g. "27")`);
      }
    }
  }

  if ("contentDecimalFloor" in c && c.contentDecimalFloor !== undefined) {
    const v = c.contentDecimalFloor;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 99) {
      problems.push("contentDecimalFloor must be an integer between 0 and 99");
    }
  }

  return problems;
}
