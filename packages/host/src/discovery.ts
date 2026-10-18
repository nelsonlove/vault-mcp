import * as fs from "node:fs";
import {
  stateDir,
  discoveryPath,
  bridgeDestPath,
  legacyStateDir,
  legacyDiscoveryPath,
  legacyBridgeDestPath,
  legacyWrites,
} from "./paths.js";
import { BRIDGE_SOURCE } from "./bridge-asset.js";

export interface Discovery {
  socket_path: string;
  vault_path: string;
  vault_name: string;
  plugin_version: string;
  obsidian_version: string;
  started_at: string;
  /** Protocol features this plugin build supports (e.g. "preamble"). The
   * bridge gates optional wire features on this list instead of guessing from
   * plugin_version, so an older plugin never receives bytes it can't parse. */
  capabilities?: string[];
  /** Present (true) only on the compat copy written into the 0.12.0-era
   * `~/.claude/governor/` dir during the id-migration grace period. Its
   * `socket_path` points at the NEW socket, so old bridges keep connecting;
   * new bridges skip `legacy` entries when merging the two dirs (the
   * canonical twin is already in `~/.claude/vault-mcp/`).
   *
   * The dirs read the other way round before S3c, when `governor` was the
   * host's own id: `paths.ts` is authoritative — `stateDir()` is
   * `~/.claude/vault-mcp/` and `legacyStateDir()` is `~/.claude/governor/`. */
  legacy?: boolean;
}

/**
 * Whether a parsed JSON file is a vault discovery entry: an object with a
 * string `socket_path`. Every reader of the state dir asks this, so a stray
 * JSON file there (an operator's notes, another tool's file) is never read as
 * a vault (#582 review 1).
 */
export function isDiscoveryEntry(d: unknown): d is Discovery {
  return !!d && typeof d === "object" && !Array.isArray(d) && typeof (d as { socket_path?: unknown }).socket_path === "string";
}

/** How many discovery entries the folder holds: `*.json` files that parse to an entry. Unreadable ⇒ 0. */
export function countDiscoveries(dir: string): number {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of files) {
    try {
      if (isDiscoveryEntry(JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")))) n++;
    } catch {
      /* not an entry */
    }
  }
  return n;
}

export function writeDiscovery(slug: string, d: Discovery): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(discoveryPath(slug), JSON.stringify(d, null, 2), { mode: 0o600 });
  // Grace-period compat: ALSO write a `legacy: true` copy at the 0.12.0-era
  // `~/.claude/governor/` path, pointing at the NEW socket, so existing
  // registrations (old bridge bytes reading that dir) keep working until the
  // fleet re-registers. Best-effort — a failure here must never take down the
  // canonical discovery.
  //
  // The canonical dir is `~/.claude/vault-mcp/` since S3c gave the host its id
  // back; between 0.12.0 and S3c the two were the other way round, which is
  // what this comment used to describe.
  //
  // TODO (grace-period removal, tracked with #266): this MKDIRS the legacy dir
  // unconditionally — so it is created even on a machine that never ran the
  // old id, and it reappears after a human cleans it up. Delete this block,
  // the legacy bridge copy in `writeBridge`, the legacy unlink in
  // `removeDiscovery`, the bridge's + health probe's second-dir read, and the
  // `vault-mcp:ready` event together, once both Macs are re-registered under
  // the `vault-mcp` server name (the S3c wire rename, 2026-09-09) and no
  // `claude mcp` entry named `governor` survives. NOTE the provider's
  // `history/` repository lives in the same directory and is NOT part of this
  // cleanup — the dir stays, only the host's files in it go.
  if (!legacyWrites()) return; // a set state dir keeps the plugin out of ~/.claude/governor/ too
  try {
    fs.mkdirSync(legacyStateDir(), { recursive: true });
    fs.writeFileSync(
      legacyDiscoveryPath(slug),
      JSON.stringify({ ...d, legacy: true }, null, 2),
      { mode: 0o600 },
    );
  } catch (e) {
    console.error("[vault-mcp] legacy discovery write failed (compat copy only)", e);
  }
}

export function removeDiscovery(slug: string): void {
  try { fs.unlinkSync(discoveryPath(slug)); } catch { /* gone */ }
  if (legacyWrites()) {
    try { fs.unlinkSync(legacyDiscoveryPath(slug)); } catch { /* gone */ }
  }
}

// Writes the build-time-embedded bridge text to ~/.claude/vault-mcp/bridge.mjs
// (the canonical dir since S3c) and — grace-period compat — to the 0.12.0-era
// ~/.claude/governor/bridge.mjs, which existing Claude Code registrations still
// point `node` at. (The two dirs swapped roles at S3c; this comment named them
// the pre-split way round until 2026-09-08.) Both copies are
// the same bytes; the bridge itself reads discoveries from BOTH dirs (skipping
// `legacy` duplicates), so either entry point reaches the live socket.
export function writeBridge(): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(bridgeDestPath(), BRIDGE_SOURCE, { mode: 0o755 });
  if (!legacyWrites()) return;
  try {
    fs.mkdirSync(legacyStateDir(), { recursive: true });
    fs.writeFileSync(legacyBridgeDestPath(), BRIDGE_SOURCE, { mode: 0o755 });
  } catch (e) {
    console.error("[vault-mcp] legacy bridge write failed (compat copy only)", e);
  }
}
