// redaction.ts — which connection profiles get the secret scanner (secret-scan.ts), from settings.
//
// OFF BY DEFAULT. No profile turns the scanner on in code. A deployment names the profiles to scan
// (`profiles`, a list of profile names; empty ⇒ off) and may give a scanner config (`config`, see
// `SecretScanConfig`). The file-system server reads both from the environment
// (packages/server, VAULT_MCP_REDACT_PROFILES and VAULT_MCP_REDACT_CONFIG); the plugin reads them
// from its settings.
//
// FAIL CLOSED. A profile name nobody knows, or a config the scanner refuses, throws
// `RedactionSettingsError`. The caller must then not serve the profiles the setting covers
// unscanned: the file-system front refuses to start, and the plugin builds no tools for a
// connection whose profile is not `full` (or is `full` and listed). It never scans nothing while
// the setting says on.

import { isProfileName, PROFILE_NAMES } from "./profile.js";
import { createSecretScanner, SecretScanConfigError, type SecretScanner } from "./secret-scan.js";

export class RedactionSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedactionSettingsError";
  }
}

/** The checked redaction settings: the profiles to scan and the scanner they get. */
export interface Redaction {
  profiles: ReadonlySet<string>;
  scanner: SecretScanner;
}

/**
 * A profile list from text: a JSON array of names, or names separated by commas or line breaks.
 * Empty or blank ⇒ []. Throws on JSON that is not an array of strings.
 */
export function parseProfileList(raw: string | undefined): string[] {
  const t = raw?.trim() ?? "";
  if (!t) return [];
  if (t.startsWith("[")) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      throw new RedactionSettingsError("the redaction profile list is not valid JSON");
    }
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new RedactionSettingsError("the redaction profile list must be a JSON array of profile names");
    return (v as string[]).map((s) => s.trim()).filter(Boolean);
  }
  return t.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Check the settings and build the scanner. `profiles` is a list of profile names (each must be
 * known); `config` is the parsed scanner config (undefined ⇒ the shipped defaults). Throws
 * `RedactionSettingsError` on anything it refuses. The config is checked even when no profile is
 * named, so a bad one is found before someone turns the scanner on.
 */
export function buildRedaction(profiles: readonly string[], config?: unknown): Redaction {
  for (const p of profiles) {
    if (!isProfileName(p)) throw new RedactionSettingsError(`the redaction profile list names an unknown profile '${p}'; known: ${PROFILE_NAMES.join(", ")}`);
  }
  let scanner: SecretScanner;
  try {
    scanner = createSecretScanner(config);
  } catch (e) {
    if (e instanceof SecretScanConfigError) throw new RedactionSettingsError(`the secret scanner config is refused: ${e.message}`);
    throw e;
  }
  return { profiles: new Set(profiles), scanner };
}

/** The scanner for a connection's profile, or undefined when that profile is not scanned. */
export function scannerFor(redaction: Redaction | undefined, profileName: string): SecretScanner | undefined {
  return redaction && redaction.profiles.has(profileName) ? redaction.scanner : undefined;
}
