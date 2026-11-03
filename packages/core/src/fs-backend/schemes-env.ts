// schemes-env.ts — the file-system server's scheme setting, `VAULT_MCP_SCHEMES`,
// parsed once per value: the JD model the index derives ids by (index-store.ts)
// and the registry whose ids the retired `<id>:<address>` path syntax is
// refused for (vault.ts). Its own module so vault.ts need not import the index.
import { makeRegistry, type SchemeInstanceConfig, type SchemeRegistry } from "../scheme/registry.js";
import { DEFAULT_JD_CONFIG } from "../scheme/jd.js";

/** The environment variable that gives the file-system server its schemes:
 * a JSON list of rows in the plugin's `schemes` shape. */
export const SCHEMES_ENV_VAR = "VAULT_MCP_SCHEMES";

/** The Johnny Decimal model the index derives ids by, or null for none. */
export interface FsJdModel {
  /** Areas that use 5-digit ("expanded") ids. */
  expandedAreas: ReadonlySet<string>;
  /** Single categories that use 5-digit flat ids. */
  expandedCategories: ReadonlySet<string>;
}

let cachedModel: { raw: string | undefined; model: FsJdModel | null; registry: SchemeRegistry | null } | null = null;

function fsSchemes(env: Record<string, string | undefined>): { model: FsJdModel | null; registry: SchemeRegistry | null } {
  const raw = env[SCHEMES_ENV_VAR]?.trim() || undefined;
  if (cachedModel && cachedModel.raw === raw) return cachedModel;
  let model: FsJdModel | null = null;
  let registry: SchemeRegistry | null = null;
  if (raw) {
    let rows: unknown;
    try {
      rows = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${SCHEMES_ENV_VAR} is not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(rows)) throw new Error(`${SCHEMES_ENV_VAR} must be a JSON list of scheme rows`);
    registry = makeRegistry(rows as SchemeInstanceConfig[]);
    if (registry.instances().length !== rows.length) {
      throw new Error(`${SCHEMES_ENV_VAR} holds a row the scheme registry does not take (an unknown provider, a config the provider refuses, a bad excludedRoots entry, or a repeated id)`);
    }
    const jd = (rows as SchemeInstanceConfig[]).find((r) => r.provider === "johnny-decimal");
    if (jd) {
      const config = { ...DEFAULT_JD_CONFIG, ...(jd.config ?? {}) };
      model = { expandedAreas: new Set(config.expandedAreas), expandedCategories: new Set(config.expandedCategories) };
    }
  }
  cachedModel = { raw, model, registry };
  return cachedModel;
}

/**
 * The JD model from `VAULT_MCP_SCHEMES` (01.33 pick A, step b): unset or empty,
 * no scheme, so no note gets a JD id, as on a fresh plugin install. A
 * `johnny-decimal` row turns JD ids on, with the expansions in
 * its `config` over the provider's defaults (which expand nothing), for
 * example `[{"id": "jd", "provider": "johnny-decimal", "config":
 * {"expandedAreas": ["50-59"], "expandedCategories": ["34"]}}]` (made-up
 * values). A value that is not JSON, not a list, or that holds a row the scheme
 * registry does not take is an error, so the server does not start on a
 * scheme the operator did not get. Read once per value (cached on the string).
 */
export function fsJdModel(env: Record<string, string | undefined> = process.env): FsJdModel | null {
  return fsSchemes(env).model;
}

/**
 * The scheme registry from `VAULT_MCP_SCHEMES`, or null when it is unset or
 * empty. The file-system server refuses the retired `<id>:<address>` path
 * syntax for every id it holds (`resolveInVault`), as the plugin's guard does.
 * Same parsing, errors and cache as `fsJdModel`.
 */
export function fsSchemeRegistry(env: Record<string, string | undefined> = process.env): SchemeRegistry | null {
  return fsSchemes(env).registry;
}

