// conventions-policy.ts — the rules for the `vaultConventions` setting (#403,
// ruled 2026-09-26: "GOVERNOR_VAULT_CONVENTIONS should be renamed and its keys
// exposed via settings for the user"). Moved from the host to the
// vaultmcp-conformance satellite with the rest of the rail on 2026-10-14; the
// setting is the satellite's now, adopted once from the host's data.json.
// Three pure pieces, headless-tested:
//
//  1. `conventionsOnLoad` — the reader of `LEGACY_CONVENTIONS_SEED` for a
//     record that predates the setting. The plugin ships the four keys EMPTY
//     (every scalar convention dead, the legacy packs registered and not
//     measured until the operator points them; no baseline note). An install
//     whose data.json predates the setting is seeded ONCE with what it used to
//     measure, so an upgrade changes nothing for it (the baseline: the
//     GOVERNOR_BASELINE_REL override when set, else the old constant's path;
//     see `withBaselineSeed` for a record that lacks only the baseline key); a
//     fresh install starts empty; an install that has the key keeps exactly
//     what it has. The key is then always persisted, so the branch cannot run
//     twice — the same shape as `territoriesOnLoad` (#397), for the same reason.
//  2. `conventionsFromHostData` — what the satellite adopts from the HOST's
//     settings (and what the CLI reads from the host's data.json when the
//     satellite has none yet). The host stopped declaring the key when the rail
//     left it, so a host record WITHOUT the key no longer means "predates
//     #403": it is as likely a fresh install. The legacy seed is therefore
//     taken only when the legacy baseline note exists in this vault.
//  3. `CONVENTION_FIELDS` — the settings-tab fields as data (key, label,
//     help, kind), so the tab renders a list rather than hand-written
//     blocks, and a test can pin that every key of the record has a field.

import { envAliased } from "@vault-mcp/core";
import {
  EMPTY_VAULT_CONVENTIONS,
  LEGACY_CONVENTIONS_SEED,
  resolveConventions,
  type VaultConventions,
} from "./vault-conventions.js";

export interface ConventionsOnLoad {
  conventions: VaultConventions;
  /** True when the key was absent (seeded or fresh): write it now so this branch never runs again. */
  persist: boolean;
}

/**
 * #493: the baseline path joined the conventions after they shipped. Before
 * #493 EVERY install read a baseline — the process-environment override
 * (GOVERNOR_BASELINE_REL / ASSENT_BASELINE_REL) when one was set, else the path
 * the old constant held — so a stored record that LACKS the key takes, once,
 * the path that install was reading:
 *  - the override, when one is set;
 *  - else the old constant's path, when the record belongs to an upgraded
 *    install (some other key set) OR that note exists in this vault (an
 *    operator who blanked every folder still measured against it);
 *  - else nothing: a fresh install (#403 shipped it empty) in a vault without
 *    that note stays without a baseline, so no operator's folder name lands in
 *    a stranger's settings.
 * A record that HAS the key keeps it, even blank. This file is the seed's one
 * reader. `exists` answers "is this vault-relative note on disk"; without it
 * the all-blank case takes only the override.
 */
export function withBaselineSeed(
  stored: unknown,
  env: Record<string, string | undefined> = process.env,
  exists?: (rel: string) => boolean,
): VaultConventions {
  const resolved = resolveConventions(stored);
  const o = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : null;
  if (!o || Object.prototype.hasOwnProperty.call(o, "baselineRel")) return resolved;
  const override = (envAliased(env, "BASELINE_REL") ?? "").trim();
  if (override) return { ...resolved, baselineRel: override };
  const legacy = LEGACY_CONVENTIONS_SEED.baselineRel;
  const upgraded = resolved.registriesRoot !== "" || resolved.systemRoot !== "" || resolved.ungovernedRoots.length > 0;
  if (upgraded || exists?.(legacy)) return { ...resolved, baselineRel: legacy };
  return resolved;
}

export function conventionsOnLoad(
  own: unknown,
  adopted?: unknown,
  env: Record<string, string | undefined> = process.env,
  exists?: (rel: string) => boolean,
): ConventionsOnLoad {
  const asObject = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
  // The plugin's own data.json first; failing that, the settings adopted from
  // the pre-split provider on this first load. An adopted install is an
  // EXISTING install — it measured with the old built-in paths — so it takes
  // the seed, not empty.
  const stored = asObject(own) ?? asObject(adopted);
  if (!stored) return { conventions: resolveConventions(EMPTY_VAULT_CONVENTIONS), persist: true };
  if (!Object.prototype.hasOwnProperty.call(stored, "vaultConventions")) {
    // The pre-#403 seed, with the baseline that install was reading: the env override wins over the old constant (#494 review).
    const override = (envAliased(env, "BASELINE_REL") ?? "").trim();
    const seeded = resolveConventions(LEGACY_CONVENTIONS_SEED);
    return { conventions: override ? { ...seeded, baselineRel: override } : seeded, persist: true };
  }
  // #493: stored conventions that lack the baseline key take, once, the path that
  // install was reading (the rule is `withBaselineSeed`'s, above); the key is then
  // persisted. A stored key, even blank, is kept.
  const sc = asObject(stored.vaultConventions);
  if (sc && !Object.prototype.hasOwnProperty.call(sc, "baselineRel")) {
    // Persist either way, so the key is written and this branch runs once.
    return { conventions: withBaselineSeed(sc, env, exists), persist: true };
  }
  return { conventions: resolveConventions(stored.vaultConventions), persist: false };
}

/**
 * The conventions the satellite adopts from the HOST's settings record (the
 * host's live `settings` object, or its data.json read by the CLI). The host
 * declared `vaultConventions` from #403 until the rail left it (2026-10-14) and
 * never deletes it from an existing data.json, so:
 *  - the host record HAS the key ⇒ `conventionsOnLoad`'s rule over it (a record
 *    lacking only `baselineRel` takes `withBaselineSeed`'s path);
 *  - the host record LACKS the key ⇒ either an install that predates #403 or a
 *    host that never had the rail. The legacy seed is taken only when the
 *    legacy baseline note exists in this vault (`exists`); otherwise the
 *    record is EMPTY, with the GOVERNOR_BASELINE_REL override as the baseline
 *    when one is set. No operator's folder names land in a stranger's settings.
 * Pure; `exists` answers "is this vault-relative note on disk".
 */
export function conventionsFromHostData(
  hostData: unknown,
  env: Record<string, string | undefined> = process.env,
  exists?: (rel: string) => boolean,
): VaultConventions {
  const o = hostData && typeof hostData === "object" && !Array.isArray(hostData) ? (hostData as Record<string, unknown>) : null;
  if (o && Object.prototype.hasOwnProperty.call(o, "vaultConventions")) {
    return conventionsOnLoad(o, undefined, env, exists).conventions;
  }
  if (exists?.(LEGACY_CONVENTIONS_SEED.baselineRel)) {
    return conventionsOnLoad(o ?? {}, undefined, env, exists).conventions;
  }
  const override = (envAliased(env, "BASELINE_REL") ?? "").trim();
  const empty = resolveConventions(EMPTY_VAULT_CONVENTIONS);
  return override ? { ...empty, baselineRel: override } : empty;
}

export type ConventionFieldKind = "path" | "paths";

export interface ConventionField {
  key: keyof VaultConventions;
  label: string;
  help: string;
  kind: ConventionFieldKind;
}

/** One field per key of `VaultConventions`, in the order the tab shows them.
 *  A `path` field is one folder path (blank = that convention is
 *  DEAD, its packs not measured); a `paths` field is one path per line (empty
 *  = none). The help names the packs each key feeds, from `CONVENTION_PACKS`. */
export const CONVENTION_FIELDS: readonly ConventionField[] = [
  { key: "registriesRoot", label: "Registries root", kind: "path", help: "Folder under which the structure check's blueprint registry lives. Feeds conformance_check. Blank = not measured." },
  { key: "systemRoot", label: "System root", kind: "path", help: "The governed system spine's root folder (the drift check's category-number scan). Feeds drift_audit. Blank = not measured." },
  { key: "ungovernedRoots", label: "Ungoverned roots", kind: "paths", help: "One folder per line the structure check never treats as governed content. Empty = everything under the root is governed." },
  { key: "baselineRel", label: "Conformance baseline note", kind: "path", help: "The accepted-debt baseline note (vault-relative path, ending in .md), read by the conformance debt tools and the Drift pane on every run. Blank = no baseline configured (unless the GOVERNOR_BASELINE_REL environment variable names one): the debt tools and the drift pane refuse until it is set." },
];

/** The value a settings-tab field commits for `key`, from the raw text the
 *  operator typed: a `path` field's text trimmed, a `paths` field's lines
 *  trimmed and blanks dropped. Pure, so the tab's commit rule is pinned. */
export function conventionFieldValue(field: ConventionField, raw: string): string | string[] {
  return field.kind === "path" ? raw.trim() : raw.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** The record the settings tab STORES after one field loses focus: the
 *  current setting (whatever shape it has) coerced, that one key replaced by
 *  what the operator typed, coerced again — so what the tab writes is exactly
 *  what `resolveConventions` reads back on the next debt or drift run. Pure:
 *  the tab is Obsidian-bound, this rule is not, and a blank committed here is
 *  a dead convention on the next run (pinned in conventions-policy.test.mjs). */
export function commitConvention(current: unknown, field: ConventionField, raw: string): VaultConventions {
  const next = resolveConventions(current) as unknown as Record<string, unknown>;
  next[field.key] = conventionFieldValue(field, raw);
  return resolveConventions(next);
}
