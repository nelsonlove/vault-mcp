// profiles.ts — which connection profile a credential gets on the front (#521).
//
// The mapping is one environment variable, VAULT_MCP_PROFILES, holding a JSON object from a
// CREDENTIAL ID to a profile name (core's profile.ts: "full", "read", "read+inbox"):
//
//   VAULT_MCP_PROFILES='{"token":"full","sub:user_2abc":"read+inbox"}'
//
// A credential id names a credential without carrying it, so no secret is ever in the mapping:
//   "token"       — the static owner bearer (VAULT_MCP_TOKEN);
//   "sub:<sub>"   — an OAuth subject (the token's `sub` claim).
//
// Unset (or empty): every authenticated request gets `full`, which is the front's behaviour before
// profiles. Set: a credential with no entry is REFUSED (403), so a new subject someone adds to the
// OAuth allowlist does not get the whole vault by default. A value that does not parse, or names a
// profile that does not exist, stops the front at start-up rather than guessing.

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { isProfileName, PROFILE_NAMES } from "@vault-mcp/core";

export const PROFILES_ENV_VAR = "VAULT_MCP_PROFILES";

/** Where the auth gate leaves the authenticated credential's id, and the profile gate the profile. */
export const CREDENTIAL_LOCAL = "vaultMcpCredential";
export const PROFILE_LOCAL = "vaultMcpProfile";

export interface ProfileMap {
  /** False when VAULT_MCP_PROFILES is unset or empty: every credential gets `full`. */
  configured: boolean;
  entries: ReadonlyMap<string, string>;
}

/** Parse the mapping. Throws on a value that is not a JSON object of known profile names. */
export function loadProfileMap(env: NodeJS.ProcessEnv = process.env): ProfileMap {
  const raw = env[PROFILES_ENV_VAR]?.trim();
  if (!raw) return { configured: false, entries: new Map() };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error(`${PROFILES_ENV_VAR} is not valid JSON`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${PROFILES_ENV_VAR} must be a JSON object of credential id → profile name`);
  const entries = new Map<string, string>();
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    if (k !== "token" && !/^sub:.+$/.test(k)) throw new Error(`${PROFILES_ENV_VAR}: '${k}' is not a credential id ("token" or "sub:<subject>")`);
    if (!isProfileName(p)) throw new Error(`${PROFILES_ENV_VAR}: '${k}' names an unknown profile; known: ${PROFILE_NAMES.join(", ")}`);
    entries.set(k, p);
  }
  return { configured: true, entries };
}

/** The profile for a credential id, or null when it must be refused. */
export function profileFor(map: ProfileMap, credentialId: string | undefined): string | null {
  if (!map.configured) return "full";
  if (!credentialId) return null;
  return map.entries.get(credentialId) ?? null;
}

/** The credential id the auth gate recorded for this request, if any. */
export function credentialOf(res: Response): string | undefined {
  const c = res.locals?.[CREDENTIAL_LOCAL];
  return typeof c === "string" ? c : undefined;
}

/** The profile the profile gate chose for this request, if any. */
export function profileOf(res: Response): string | undefined {
  const p = res.locals?.[PROFILE_LOCAL];
  return typeof p === "string" ? p : undefined;
}

/** Express middleware, after the auth gate: picks the profile, or answers 403. */
export function createProfileGate(map: ProfileMap): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const profile = profileFor(map, credentialOf(res));
    if (!profile) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32003, message: "forbidden: no profile for this credential" }, id: null });
      return;
    }
    res.locals[PROFILE_LOCAL] = profile;
    next();
  };
}
