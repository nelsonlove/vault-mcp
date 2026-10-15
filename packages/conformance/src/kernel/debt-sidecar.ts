// debt-sidecar.ts — per-key metadata for accepted conformance debt (issue #211,
// Part A1). Enriches each accepted-debt key with WHEN/WHO accepted it plus
// human-editable why/priority/fix-by, WITHOUT touching the baseline note.
//
// ── Why a SIDECAR and not inline in the key list ─────────────────────────────
//
// The ratchet key format (`script|check|target|kind`, finding.ts) is
// LOAD-BEARING and byte-stable: a key in the baseline's fenced block is an
// accepted-debt line, and the encoding is a proven byte-for-byte no-op for
// every real key (#136/#209). Adding metadata inline would change how those
// lines serialize/parse and re-bless nothing — so the metadata lives in a
// SEPARATE JSON file next to the baseline. The baseline note is never touched
// by this module; `parseBaseline`/`renderBaseline` (ratchet.ts) keep reading
// and writing exactly the same bytes. A baseline with no sidecar behaves
// identically to today — the sidecar is optional enrichment, never a gate.
//
// ── The acceptance principle ─────────────────────────────────────────────────
//
// Accepting a finding as debt is a HUMAN act. `acceptedOn`/`acceptedBy` are
// stamped in ONE place only — the human-run `--rebaseline` (see
// `reconcileSidecar`, wired in cli.ts). Nothing agent-reachable writes this
// file: the report tool (src/tools.ts) READS it and never writes.
// So an agent can never mint debt-acceptance metadata.

import { dirname, join } from "node:path";

/** Metadata for ONE accepted-debt key. All fields optional: a missing sidecar
 * or a missing entry is a fine, expected state — never a run failure. */
export interface DebtEntry {
  /** ISO date (YYYY-MM-DD) the key first gained a sidecar entry (≈ when it was
   * accepted). Auto-stamped at `--rebaseline` for keys newly entering the
   * baseline; carried forward verbatim thereafter. */
  acceptedOn?: string;
  /** Who accepted it — a human identity or the literal "human". Auto-stamped at
   * `--rebaseline`. Never an agent identity: nothing agent-reachable writes it. */
  acceptedBy?: string;
  /** One-line human note on WHY this is accepted debt. Human-editable in the
   * sidecar; PRESERVED across rebaselines. */
  reason?: string;
  /** Human priority label (free text, e.g. "high"/"low"). Human-editable;
   * PRESERVED across rebaselines. */
  priority?: string;
  /** Target date/marker to fix by. Human-editable; PRESERVED across rebaselines. */
  fixBy?: string;
}

/** The whole sidecar: a version tag plus `findingKey → DebtEntry`. */
export interface DebtSidecar {
  version: 1;
  entries: Record<string, DebtEntry>;
}

export const SIDECAR_VERSION = 1 as const;
export const DEFAULT_SIDECAR_BASENAME = "Conformance debt.json";

export function emptySidecar(): DebtSidecar {
  return { version: SIDECAR_VERSION, entries: {} };
}

/** Where the sidecar lives: next to the baseline note, so the two travel
 * together and a baseline move carries its metadata. */
export function sidecarPathFor(baselinePath: string): string {
  return join(dirname(baselinePath), DEFAULT_SIDECAR_BASENAME);
}

// ── the known, string-typed entry fields, in stable emit order ───────────────
const ENTRY_FIELDS: (keyof DebtEntry)[] = ["acceptedOn", "acceptedBy", "reason", "priority", "fixBy"];

/** One entry, coerced to the known string fields in a FIXED order, dropping
 * unknown keys and non-string/empty values. Deterministic output — a function
 * of the entry, not of insertion order. */
function normalizeEntry(raw: unknown): DebtEntry {
  const out: DebtEntry = {};
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    for (const f of ENTRY_FIELDS) {
      const v = r[f];
      if (typeof v === "string" && v.length) out[f] = v;
    }
  }
  return out;
}

/**
 * Parse sidecar text, TOLERANT: a missing/blank/malformed file reads as an
 * empty sidecar rather than throwing. Used by the read-only report tool, which
 * must never fail a run over optional metadata. For the WRITE path
 * (`--rebaseline`) use {@link parseSidecarStrict}, which refuses a corrupt file
 * rather than silently clobbering human annotations it could not read.
 */
export function parseSidecar(text: string | null | undefined): DebtSidecar {
  try {
    return parseSidecarStrict(text);
  } catch {
    return emptySidecar();
  }
}

/**
 * Parse sidecar text, STRICT: throws on a present-but-corrupt file. A blank or
 * absent file is still a valid empty sidecar (absence is not corruption). This
 * is the rebaseline path's parser — overwriting a sidecar we could not read
 * would destroy human `reason`/`priority`/`fixBy`, so we refuse instead, the
 * same discipline `writeFence` applies to a corrupt baseline.
 */
export function parseSidecarStrict(text: string | null | undefined): DebtSidecar {
  const s = (text ?? "").trim();
  if (!s) return emptySidecar();
  const parsed = JSON.parse(s) as unknown; // throws on malformed JSON
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("debt sidecar is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const rawEntries = obj.entries;
  if (rawEntries != null && (typeof rawEntries !== "object" || Array.isArray(rawEntries))) {
    throw new Error("debt sidecar 'entries' is not an object");
  }
  const entries: Record<string, DebtEntry> = {};
  if (rawEntries) {
    for (const [k, v] of Object.entries(rawEntries as Record<string, unknown>)) {
      entries[k] = normalizeEntry(v);
    }
  }
  return { version: SIDECAR_VERSION, entries };
}

/** Serialize a sidecar to canonical JSON: keys sorted, entry fields in fixed
 * order, 2-space indent, trailing newline — so a rebaseline that changes
 * nothing writes byte-identical output and the file diffs cleanly. */
export function serializeSidecar(s: DebtSidecar): string {
  const entries: Record<string, DebtEntry> = {};
  for (const k of Object.keys(s.entries).sort()) {
    entries[k] = normalizeEntry(s.entries[k]);
  }
  return JSON.stringify({ version: SIDECAR_VERSION, entries }, null, 2) + "\n";
}

/**
 * Reconcile the sidecar against the keyset a `--rebaseline` is about to write
 * (the live findings' keys — the new baseline). A HUMAN act only:
 *
 *   - key NEWLY entering the baseline (no prior entry)  → stamp `{acceptedOn,
 *     acceptedBy}` from this run's clock/identity.
 *   - key that PERSISTS (had an entry)                  → carry the entry
 *     forward verbatim, preserving `acceptedOn`/`acceptedBy` AND the
 *     human-editable `reason`/`priority`/`fixBy`.
 *   - key that LEAVES the baseline (entry, no live key) → drop the entry.
 *
 * `acceptedOn` is a passed-in date string, not `Date.now()` — the CLI samples
 * its clock at entry and formats it, because a shared bundle can't assume a
 * live clock (and to keep this function pure/testable).
 */
export function reconcileSidecar(
  prev: DebtSidecar,
  baselineKeys: Iterable<string>,
  opts: { acceptedOn: string; acceptedBy: string },
): DebtSidecar {
  const entries: Record<string, DebtEntry> = {};
  for (const key of baselineKeys) {
    const existing = prev.entries[key];
    if (existing) {
      entries[key] = normalizeEntry(existing); // persists: carry forward, human fields intact
    } else {
      entries[key] = { acceptedOn: opts.acceptedOn, acceptedBy: opts.acceptedBy }; // newly accepted
    }
  }
  return { version: SIDECAR_VERSION, entries };
}
