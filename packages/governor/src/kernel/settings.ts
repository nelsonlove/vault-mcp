// Plain, non-capability governance display settings — badge display toggles only. These
// booleans confer no accept/revert/adopt capability; they only control whether a pending-count
// badge is painted. Ported from obsidian-stewardship/src/settings.ts (#83, cycle 2). Kept in a
// dedicated module (no obsidian import) so DEFAULT_GOVERNANCE_SETTINGS is headless-testable.
//
// These live in the acceptance module's config (module id `acceptance` since 0.12.0)
// (`settings.modules.acceptance.config`), read at pane-wire time; the pane defaults them ON
// when the config is absent. They are deliberately NOT part of the accept surface.
export interface GovernanceDisplaySettings {
  showRibbonBadge: boolean;
  showViewTabBadge: boolean;
}

export const DEFAULT_GOVERNANCE_SETTINGS: GovernanceDisplaySettings = {
  showRibbonBadge: true,
  showViewTabBadge: true,
};

// Coerce an untrusted config record (from data.json) into display settings, defaulting each
// toggle ON. Never throws — a malformed value falls back to the default.
export function governanceDisplaySettings(config: unknown): GovernanceDisplaySettings {
  const c = (config ?? {}) as Record<string, unknown>;
  return {
    showRibbonBadge: typeof c.showRibbonBadge === "boolean" ? c.showRibbonBadge : DEFAULT_GOVERNANCE_SETTINGS.showRibbonBadge,
    showViewTabBadge: typeof c.showViewTabBadge === "boolean" ? c.showViewTabBadge : DEFAULT_GOVERNANCE_SETTINGS.showViewTabBadge,
  };
}

// ── acceptance-convergence settings (#221/#164) ──────────────────────────────
// Two more plain-data config fields on `modules.acceptance.config`, rendered in the
// governance settings tab exactly like the badge fields (the generic manifest renderer).
// Human-only by construction — the settings tab is not agent-reachable, and reading these
// confers no accept capability: `acceptedBy` is the identity the human's OWN gesture stamps,
// and `requiredFrontmatterKeys` can only make Accept REFUSE more, never accept more.
export interface GovernanceAcceptanceSettings {
  /** Identity recorded on the baseline and as the accept log's `by` (never written into a note). */
  acceptedBy: string;
  /** The conformance gate: keys that must be present + non-empty before a `proposed`
   * note can be accepted. Empty (default) ⇒ no gate. Per-vault CONFIG — the plugin
   * hardcodes no vault convention (the legacy QuickAdd macro's uid/title/description
   * gate maps onto this field). */
  requiredFrontmatterKeys: string[];
  /** How the conformance gate responds: "soft" = modal choice (default), "hard" = refuse with notice, "off" = gate disabled. */
  gateMode: "soft" | "hard" | "off";
}

export const DEFAULT_ACCEPTANCE_SETTINGS: GovernanceAcceptanceSettings = {
  acceptedBy: "local-human",
  requiredFrontmatterKeys: [],
  gateMode: "soft",
};

// Coerce an untrusted config record into acceptance settings. Never throws. `acceptedBy`
// must be a non-blank string (else the default); `requiredFrontmatterKeys` accepts the
// renderer's string[] shape OR a raw CSV string (hand-edited data.json), normalized to a
// trimmed, non-empty list.
export function governanceAcceptanceSettings(config: unknown): GovernanceAcceptanceSettings {
  const c = (config ?? {}) as Record<string, unknown>;
  const by =
    typeof c.acceptedBy === "string" && c.acceptedBy.trim() !== ""
      ? c.acceptedBy.trim()
      : DEFAULT_ACCEPTANCE_SETTINGS.acceptedBy;
  const mode = c.gateMode === "hard" || c.gateMode === "off" ? c.gateMode : "soft";
  return { acceptedBy: by, requiredFrontmatterKeys: coerceKeyList(c.requiredFrontmatterKeys), gateMode: mode };
}

function coerceKeyList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter((s) => s !== "");
  }
  if (typeof v === "string") {
    return v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  }
  return [];
}

// ── guarded territories (#321/#397) ─────────────────────────────────────────
// NOT A SETTING OF THIS PLUGIN, deliberately. #396 first put the list here;
// #397 moved it to the HOST, because the consumer that writes note bodies
// outside the vault (observation capture) lives there and runs whether or not
// this plugin is installed — a guard that only exists on the optional plugin is
// not a guard. This plugin now READS the host's list live through its api; see
// `hostGuardedTerritories` in ../host-lookup.ts and `territoriesOf` in
// ../wiring/wiring.ts. Nothing here holds a copy, so the two cannot disagree.
