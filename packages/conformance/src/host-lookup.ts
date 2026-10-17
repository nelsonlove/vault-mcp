// host-lookup.ts — "which loaded plugin is the Vault MCP HOST, and what does it
// say?" Obsidian-free, so it is headlessly testable.
//
// The conformance rail reads three things that belong to the HOST and keeps no
// copy of them:
//
//   * the guarded territories (`api.guardedTerritories()`, the host's #397
//     setting) — the rail must not walk a territory the operator listed;
//   * the host's settings object, ONCE, for the one-shot adoption of
//     `vaultConventions` and `modules["conformance-debt"].config` (settings.ts);
//   * the host's `host.headless` setting, at load, so the Drift pane is not
//     mounted on a headless host (main.ts).
//
// The host is found the way `vault-mcp-api` finds it: ids `vault-mcp` then
// `governor`, CURRENT FIRST, and a plugin counts as the host only if it exposes
// the plugin-to-plugin `api` object (the governance provider under `governor`
// has none). The suite's one behavioural test of that lookup is
// `tests/host-lookup.test.mjs` in this package; the territories reader is
// the same function as `packages/governor/src/host-lookup.ts`'s
// `hostGuardedTerritories`, with the same fail-closed reading of null.

/** The host plugin's ids, CURRENT FIRST — the pair `vault-mcp-api` reads. */
export const HOST_PLUGIN_IDS = ["vault-mcp", "governor"] as const;

/** The shape of a loaded plugin this module reads. Structural — no `obsidian` import. */
export interface HostPluginLike {
  /** The plugin-to-plugin api object. Its PRESENCE is what makes a plugin the host. */
  api?: unknown;
  /** Declared without an initializer on the host and assigned mid-onload:
   *  `undefined` means HOST NOT READY, never "host with empty settings". */
  settings?: unknown;
}

export type PluginsMap = Record<string, HostPluginLike | undefined> | undefined;

/** The loaded Vault MCP host, or null when none is loaded. */
export function findHostPlugin(plugins: PluginsMap): HostPluginLike | null {
  for (const id of HOST_PLUGIN_IDS) {
    const plugin = plugins?.[id];
    if (!plugin || !plugin.api) continue;
    return plugin;
  }
  return null;
}

/**
 * The host's configured guarded territories, or null when they cannot be read.
 *
 * NULL means "cannot tell" — no host, or a host too old to publish this. It
 * must NOT be read as an empty list (`[]` guards nothing, and "cannot ask" must
 * never mean "nothing is guarded"): the conformance sources refuse to run on
 * null (`territoriesOrRefuse`, below). Anything but a function returning an
 * array of strings reads as null.
 */
export function hostGuardedTerritories(plugins: PluginsMap): readonly string[] | null {
  const host = findHostPlugin(plugins);
  if (!host) return null;
  const api = host.api as { guardedTerritories?: unknown } | undefined;
  if (typeof api?.guardedTerritories !== "function") return null;
  try {
    const list = (api.guardedTerritories as () => unknown)();
    if (!Array.isArray(list)) return null;
    const clean = list.filter((p): p is string => typeof p === "string");
    return clean.length === list.length ? clean : null;
  } catch {
    return null;
  }
}

/** The refusal the rail gives when the host cannot say what is guarded. */
export const TERRITORIES_UNKNOWN =
  "the Vault MCP host's guarded territories cannot be read (the host is not loaded, or is too old to publish them) — " +
  "the conformance rail does not walk the vault without them";

/** The host's territories, or a thrown refusal when it cannot answer. The
 *  conformance sources call this per run, inside the run, so the pane shows the
 *  refusal and a tool call returns it as `Error: …`. */
export function territoriesOrRefuse(plugins: PluginsMap): readonly string[] {
  const list = hostGuardedTerritories(plugins);
  if (list === null) throw new Error(TERRITORIES_UNKNOWN);
  return list;
}

/** The host's settings object, or undefined when no host is loaded or it is
 *  not ready yet (`settings` still unassigned). The check is `!== undefined`,
 *  never a truthiness test. */
export function hostSettingsOf(plugins: PluginsMap): unknown {
  const host = findHostPlugin(plugins);
  return host && host.settings !== undefined ? host.settings : undefined;
}

/** Headless as DECLARED at load: the host's `host.headless` setting when it is
 *  "on" or "off", else the VAULT_MCP_HEADLESS variable. The same rule as the
 *  host's `declaredHeadless` (packages/host/src/headless.ts), read from the
 *  host's settings rather than kept here. No workspace probe: at load the
 *  layout is not ready. */
export function declaredHeadless(plugins: PluginsMap, env: Record<string, string | undefined> = process.env): boolean {
  const s = hostSettingsOf(plugins) as { host?: { headless?: unknown } } | undefined;
  const mode = s?.host?.headless;
  if (mode === "on") return true;
  if (mode === "off") return false;
  const v = env.VAULT_MCP_HEADLESS?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
