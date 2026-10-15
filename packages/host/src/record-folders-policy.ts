// record-folders-policy.ts — the folder indicator's on-load decision (#482),
// pure and obsidian-free, the same shape as territory-policy.ts and
// conventions-policy.ts (the latter in packages/conformance since 2026-10-14).
//
// The ruling (Nelson, 2026-10-02 and 2026-10-03): which folders hold records is
// the operator's setting, and "No folder names are ever in the live code". So
// the plugin ships an EMPTY folder indicator: no record folders and no archive
// pattern. The folders and the pattern this vault used while they were
// hard-coded (#455) survive only as `LEGACY_RECORD_FOLDERS_SEED`, written ONCE
// into an upgrading install's own settings by `recordFoldersOnLoad`, so that the
// upgrade does not silently stop protecting its records.

import { normalizeRecordFolders, type RecordFolders } from "./kernel/record-guard.js";

/** What #455 hard-coded. Read by recordFoldersOnLoad only (pinned by test). */
export const LEGACY_RECORD_FOLDERS_SEED: Readonly<RecordFolders> = Object.freeze({
  enabled: true,
  folders: Object.freeze([
    "00-09 System/03 Agents/03.04 Records",
    "00-09 System/03 Agents/03.20 Imported chats",
    "00-09 System/03 Agents/03.16 Cross-session log",
  ]) as unknown as string[],
  archivePattern: "^\\d\\d(?:\\.\\d\\d)*\\.09 Archive(?: |$)",
});

export interface RecordFoldersOnLoad {
  recordFolders: RecordFolders;
  /** True when the key was absent: save now, so the seeding runs at most once per install. */
  persist: boolean;
}

/**
 * The plugin's own data.json first; failing that, settings adopted from the
 * pre-split plugin (an adopted install is an EXISTING install). No stored
 * settings at all (a fresh install): EMPTY. Stored settings without the key (an
 * install that predates it): the seed. Otherwise: the stored value, coerced.
 */
export function recordFoldersOnLoad(own: unknown, adopted?: unknown): RecordFoldersOnLoad {
  const asObject = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
  const stored = asObject(own) ?? asObject(adopted);
  if (!stored) return { recordFolders: normalizeRecordFolders(undefined), persist: true };
  if (!Object.prototype.hasOwnProperty.call(stored, "recordFolders")) {
    return { recordFolders: { ...LEGACY_RECORD_FOLDERS_SEED, folders: [...LEGACY_RECORD_FOLDERS_SEED.folders] }, persist: true };
  }
  return { recordFolders: normalizeRecordFolders(stored.recordFolders), persist: false };
}
