// settings.ts — the satellite's own settings shape, its field definitions, and
// the ONE-SHOT adoption of what the host used to hold for the conformance rail.
//
// ── Why adoption exists ──────────────────────────────────────────────────────
//
// Before this extraction the rail lived in the Vault MCP host, and two of its
// settings lived in the host's data.json:
//
//   * `vaultConventions` — the folders the legacy packs measure and the
//     accepted-debt baseline note (#403, #493). A top-level host setting,
//     rendered on the host's fixed "Conformance" tab.
//   * `modules["conformance-debt"].config` — the debt tools' teeth and the
//     register's placement: `staleAfterDays`, `debtBudget`, `strictBudget`,
//     `registerDir`, `registerMaxRows`. The debt tools were registered by hand
//     in the host's server.ts, not through a module manifest, so this config
//     had no settings field anywhere: it was a hand edit of data.json.
//
// A user who upgrades gets a brand-new plugin with a brand-new, EMPTY data.json.
// For the conventions that is not a lost preference: a blank baseline makes the
// debt tools and the Drift pane REFUSE, and blank folders make the legacy packs
// unmeasured. So the satellite adopts both once, on first load.
//
// Three rules, identical to the other satellites':
//
//   1. IT NEVER WRITES THE HOST'S SETTINGS. The host's copy stays where it is
//      and simply stops being read (the host declares neither key any more).
//   2. IT RUNS ONCE. `adoptedFromHost` latches, so a later host edit does not
//      reach back in and overwrite what the user has since set here.
//   3. THE SATELLITE'S OWN VALUES WIN. Config keys the satellite already has are
//      kept; a `vaultConventions` the satellite already has is kept whole.
//
// If the host is ABSENT, or present with `settings` still UNDEFINED (the host
// declares that field without an initializer and assigns it mid-onload), the
// latch is NOT set and adoption retries next load — main.ts checks
// `!== undefined`, never a truthiness test. A `saveData` that throws also holds
// the latch open (`runAdoption`).
//
// The conventions are adopted through `conventionsFromHostData` (kernel/
// conventions-policy.ts), which also carries the #493 baseline seed. There is
// no second adoption: the rail keeps no operator state outside data.json — the
// baseline note, its sidecar and the trend log are vault files that stay where
// they are.

import {
  conventionsFromHostData,
  conventionsOnLoad,
} from "./kernel/conventions-policy.js";
import { EMPTY_VAULT_CONVENTIONS, resolveConventions, type VaultConventions } from "./kernel/vault-conventions.js";
import { DEFAULT_STALE_AFTER_DAYS } from "./kernel/debt.js";
import { DEFAULT_REGISTER_MAX_ROWS } from "./kernel/debt-register.js";

/** The satellite's persisted settings (its own data.json). */
export interface ConformancePluginSettings {
  /** The vault conventions (#403). ABSENT until known: set by the user here, by
   *  the one-shot adoption, or by a data.json that already holds it. While absent
   *  the rail reads EMPTY (every folder convention dead, no baseline), and the
   *  absence is what lets the adoption still fill it later. */
  vaultConventions?: VaultConventions;
  /** The debt config, keyed exactly as the host's
   *  `modules["conformance-debt"].config` was, so adoption is a straight copy. */
  config: Record<string, unknown>;
  /** The one-shot adoption latch (rule 2 above). */
  adoptedFromHost: boolean;
}

export const DEFAULT_PLUGIN_SETTINGS: ConformancePluginSettings = {
  config: {},
  adoptedFromHost: false,
};

/** The config keys adoption carries across — exactly the keys the host's debt
 *  tools read. An unknown key in the host's record is NOT copied. */
export const ADOPTABLE_CONFIG_KEYS: readonly string[] = [
  "staleAfterDays", "debtBudget", "strictBudget", "registerDir", "registerMaxRows",
];

/** Coerce whatever `loadData()` returned into a settings object, plus whether
 *  the conventions need persisting now (a stored record that lacked the #493
 *  baseline key takes its seed once, then is written). A hand-edited or corrupt
 *  data.json degrades to the defaults rather than throwing during onload. */
export function settingsOf(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
  exists?: (rel: string) => boolean,
): { settings: ConformancePluginSettings; persist: boolean } {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const config = r.config && typeof r.config === "object" && !Array.isArray(r.config)
    ? { ...(r.config as Record<string, unknown>) }
    : {};
  const settings: ConformancePluginSettings = { config, adoptedFromHost: r.adoptedFromHost === true };
  let persist = false;
  if (Object.prototype.hasOwnProperty.call(r, "vaultConventions")) {
    const loaded = conventionsOnLoad(r, undefined, env, exists);
    settings.vaultConventions = loaded.conventions;
    persist = loaded.persist;
  }
  return { settings, persist };
}

/** The conventions the rail reads now: the setting, else EMPTY. */
export function conventionsNow(settings: ConformancePluginSettings): VaultConventions {
  return resolveConventions(settings.vaultConventions ?? EMPTY_VAULT_CONVENTIONS);
}

/**
 * The pure half of adoption. Returns the settings to persist, or `null` when
 * there is nothing to do (already adopted, or the host is absent / not ready).
 *
 * `hostSettings` is the host plugin's own settings object, read but never
 * written. A host that is present with neither key still LATCHES: the question
 * was asked and answered.
 */
export function adoptHostSettings(
  current: ConformancePluginSettings,
  hostSettings: unknown,
  env: Record<string, string | undefined> = process.env,
  exists?: (rel: string) => boolean,
): ConformancePluginSettings | null {
  if (current.adoptedFromHost) return null;
  if (!hostSettings || typeof hostSettings !== "object") return null; // host absent / not ready — try again next load
  const modules = (hostSettings as { modules?: unknown }).modules;
  const row = modules && typeof modules === "object"
    ? (modules as Record<string, unknown>)["conformance-debt"]
    : undefined;
  const hostConfig = row && typeof row === "object" ? (row as { config?: unknown }).config : undefined;
  const adopted: Record<string, unknown> = {};
  if (hostConfig && typeof hostConfig === "object" && !Array.isArray(hostConfig)) {
    for (const key of ADOPTABLE_CONFIG_KEYS) {
      const value = (hostConfig as Record<string, unknown>)[key];
      // Rule 3: the satellite's own value wins where it already has one.
      if (value !== undefined && !(key in current.config)) adopted[key] = value;
    }
  }
  const vaultConventions = current.vaultConventions ?? conventionsFromHostData(hostSettings, env, exists);
  return { ...current, config: { ...current.config, ...adopted }, vaultConventions, adoptedFromHost: true };
}

/**
 * Adoption with the persistence INJECTED, so the failure discipline is
 * headlessly provable: the adopted record replaces the current one only after
 * `save` resolves. A throwing save leaves `adoptedFromHost` false in memory and
 * on disk, and the next load retries. Returns the settings to use.
 */
export async function runAdoption(
  current: ConformancePluginSettings,
  hostSettings: unknown,
  save: (s: ConformancePluginSettings) => Promise<void>,
  env: Record<string, string | undefined> = process.env,
  exists?: (rel: string) => boolean,
): Promise<{ settings: ConformancePluginSettings; adopted: boolean }> {
  const next = adoptHostSettings(current, hostSettings, env, exists);
  if (!next) return { settings: current, adopted: false };
  try {
    await save(next);
  } catch (e) {
    console.error("[vaultmcp-conformance] adopted settings could not be persisted; will retry next load", e);
    return { settings: current, adopted: false };
  }
  return { settings: next, adopted: true };
}

// ── settings-tab field definitions for the debt config (pure data) ──────────
//
// The conventions' fields are `CONVENTION_FIELDS` (kernel/conventions-policy.ts),
// moved from the host's Conformance tab unchanged. The debt config had no field
// in the host (a hand edit of `modules["conformance-debt"].config`); these are
// its first, rendered by settings-tab.ts. Blank clears the override and the
// shipped default applies again.

export type DebtFieldType = "number" | "text" | "toggle";

export interface DebtField {
  key: string;
  label: string;
  type: DebtFieldType;
  help: string;
}

export const DEBT_FIELDS: DebtField[] = [
  {
    key: "staleAfterDays",
    label: "Stale after (days)",
    type: "number",
    help: `Carried debt older than this many days is listed as stale. 0 turns staleness off. Blank = the default (${DEFAULT_STALE_AFTER_DAYS}).`,
  },
  {
    key: "debtBudget",
    label: "Debt budget",
    type: "number",
    help: "The most carried items allowed before the report warns. Blank = no budget.",
  },
  {
    key: "strictBudget",
    label: "Strict budget",
    type: "toggle",
    help: "Report a budget overrun as a failure, not only a warning.",
  },
  {
    key: "registerDir",
    label: "Register folder",
    type: "text",
    help: "Vault-relative folder the debt register note is written to. Blank = the baseline note's folder.",
  },
  {
    key: "registerMaxRows",
    label: "Register row limit",
    type: "number",
    help: `The most carried-debt rows the register table shows. Blank = the default (${DEFAULT_REGISTER_MAX_ROWS}). A larger value is clamped to ${DEFAULT_REGISTER_MAX_ROWS}.`,
  },
];
