// settings.ts — the satellite's own settings shape, the PURE half of the
// per-instance settings form, and the ONE-SHOT adoption of the host's
// `vocabularies` setting.
//
// ── WHY ADOPTION LOOKS DIFFERENT HERE ───────────────────────────────────────
//
// The skills, triage and crosssession satellites all adopted from
// `modules.<id>.config` — a flat record of scalars the host's generic,
// manifest-driven config tab rendered. VOCAB HAS NO `modules.vocab.config`.
// The host's `VOCAB_MANIFEST` (mcp/modules-mount.ts) carries no `config:` block
// at all, and its comment says why: the vocab settings are a LIST of structured
// instances, which the scalar manifest-field renderer cannot express.
//
// The real setting is `settings.vocabularies`, a TOP-LEVEL host setting of type
// `VocabInstanceSettings[]` — declared in the host's `main.ts`, defaulted to
// `DEFAULT_VOCABULARIES.map(v => ({...v}))`, and edited by a BESPOKE
// per-instance form in the host's `connection-ui.ts` (`renderVocabInstances`).
// So `adoptHostConfig` below reads `hostSettings.vocabularies`, an ARRAY, and
// the three adoption rules are re-stated for an array-valued setting:
//
//   1. IT NEVER WRITES THE HOST'S SETTINGS. Not to delete the adopted rows, not
//      to mark them migrated, not at all.
//   2. IT RUNS ONCE. `adoptedFromHost` latches, so a later host edit does not
//      reach back in and overwrite what the user has since set here.
//   3. THE SATELLITE'S OWN VALUES WIN. "Fills only the gaps" means something
//      specific for a list: adoption happens only when this plugin has NO rows
//      of its own. Merging row-by-row would need an identity to merge ON, and
//      the only candidate (`id`) is exactly what a user renames — a merge would
//      silently resurrect a row they deleted here. All-or-nothing is the honest
//      version of rule 3 for a list.
//
// If the host is ABSENT at first load, nothing is adopted and the latch is NOT
// set — the satellite keeps the shipped defaults, and if the host shows up
// later the adoption still gets its one chance. The same is true when the host
// is present but its `settings` is still UNDEFINED: the host declares that
// field without an initializer and assigns it mid-onload, so an instance
// visible in the plugins map before that assignment is HOST NOT READY, not
// "host with empty settings". Treating it as the latter burns the one-shot
// latch on nothing and the user's config never adopts — found by the review of
// the skills extraction, and the reason the check in main.ts is `!== undefined`
// rather than a truthiness test.
//
// Incoming rows are coerced and screened with the SAME skip-and-report
// discipline the registry itself uses: a row that is not a plausible
// `{id, provider, root, config?}` object is DROPPED rather than imported. An
// unknown provider NAME is kept, not dropped — the registry reports it as a
// problem and the settings tab flags it, and dropping it would hide a
// misconfiguration the user needs to see. What gets dropped is structural
// garbage (a non-object, a row with no usable id), not a user's mistake.
//
// ── THE HOST'S COPY: STOPS BEING READ, BUT IS DELIBERATELY KEPT ─────────────
//
// The ordinary skills / triage / crosssession story holds here after all: the
// host's `settings.vocabularies` stops being read once the module leaves.
// Nothing in the host reads it — `getVocabularies` is gone from the server
// context, and the host's own bespoke settings form for it was REMOVED at this
// extraction (it became unreachable the moment the vocab module left
// `builtinModules`). There is no second live reader and no drift between two
// live copies.
//
// (An earlier draft of this file claimed there was, on the grounds that the
// host's conformance rail reads the setting. That was wrong, and the correction
// is worth recording so nobody re-derives the error: `runConformance` does take
// an `opts.vocabularies`, but all three of its call sites —
// `obsidian-drift-source.ts`, `obsidian-debt-source.ts` and `kernel/cli.ts`'s
// CLI entry point (all in packages/conformance since 2026-10-14) — pass `DEFAULT_VOCABULARIES`
// unconditionally. The rail has never read the user's configured list.)
//
// The field is nonetheless STILL DECLARED and STILL DEFAULTED in the host's
// main.ts, on purpose: it is the ADOPTION SOURCE. This plugin copies it once on
// its first load and never writes back, so deleting it there would destroy a
// user's configuration before the plugin that inherits it had a chance to read
// it. Removing it is a separate, dated decision for after the adoption window
// closes — see the `vocabularies` doc comment in the host's main.ts, which is
// the canonical statement of this.
//
// There is NO live operator state to migrate here — unlike crosssession's
// receipt file, this surface writes nothing outside its own data.json and reads
// nothing outside the vault. A checked fact, not an omission: the module's
// entire state was the `vocabularies` array plus the per-call listing.
//
// ── ONE REAL DISAGREEMENT REMAINS, AND IT IS THE HOST'S, NOT THE SPLIT'S ────
//
// Worth keeping, because the investigation above surfaced it: the host's
// conformance rail still depends on the vocabulary KERNEL — that is exactly why
// the kernel went to `@vault-mcp/core` rather than into this package — but it
// depends on it with the SHIPPED DEFAULTS. So conformance findings and this
// plugin's tools can still disagree about what is registered, in a vault whose
// user configured a non-default vocabulary. That is a PRE-EXISTING host gap
// (true before this extraction, unchanged by it), which the split merely makes
// easy to see. It is not a consequence of the split and there is nothing to fix
// here; it is flagged as a host observation in CLAUDE.md.

import { isVocabProvider, VOCAB_PROVIDERS, type VocabInstanceSettings } from "@vault-mcp/core";

/** The satellite's persisted settings (its own data.json). */
export interface VocabPluginSettings {
  /** The configured vocabulary sources, keyed exactly as the host's top-level
   *  `vocabularies` setting — same shape, same meanings — so adoption is a
   *  straight copy and a hand-migrated file works too. EMPTY means "use the
   *  shipped defaults" (`DEFAULT_VOCABULARIES`), which is also what the host
   *  does; it is not "no vocabulary". */
  vocabularies: VocabInstanceSettings[];
  /** The one-shot adoption latch (rule 2 above). */
  adoptedFromHost: boolean;
}

export const DEFAULT_PLUGIN_SETTINGS: VocabPluginSettings = {
  vocabularies: [],
  adoptedFromHost: false,
};

/** Coerce whatever `loadData()` returned into a settings object. A hand-edited
 *  or corrupt data.json degrades to the defaults rather than throwing during
 *  onload — the same skip-and-report discipline the registry uses. */
export function settingsOf(raw: unknown): VocabPluginSettings {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return {
    vocabularies: coerceVocabInstances(r.vocabularies),
    adoptedFromHost: r.adoptedFromHost === true,
  };
}

/**
 * The pure half of adoption. Returns the settings to persist, or `null` when
 * there is nothing to do (already adopted, or the host is absent / not ready).
 *
 * `hostSettings` is the host plugin's own settings object, READ and never
 * written. A host that is present with no `vocabularies` — or with an empty or
 * unusable one — still LATCHES: the question was asked and answered, and
 * re-asking every load would let a much later host edit reach in.
 */
export function adoptHostConfig(
  current: VocabPluginSettings,
  hostSettings: unknown,
): VocabPluginSettings | null {
  if (current.adoptedFromHost) return null;
  if (!hostSettings || typeof hostSettings !== "object") return null; // host absent / not ready — try again next load
  // Rule 3, for a list: the satellite's own rows win outright. Adoption only
  // fills a genuinely empty configuration.
  if (current.vocabularies.length > 0) return { ...current, adoptedFromHost: true };
  const incoming = coerceVocabInstances((hostSettings as { vocabularies?: unknown }).vocabularies);
  return { ...current, vocabularies: incoming, adoptedFromHost: true };
}

// ── the per-instance settings form's PURE half ──────────────────────────────
//
// Ported from the host's connection-ui.ts (`parseVocabConfig` /
// `stringifyVocabConfig` / `coerceVocabInstances` / `validateVocabInstances` /
// `add|remove|updateVocabInstanceAt`), so the tab in settings-tab.ts is only
// rendering and every rule here stays headless-testable.
//
// THIS IS A MOVE, NOT A FORK — and the question was asked properly rather than
// waved away. The `isVisible` case (S4) was a security decision the host and a
// satellite had to answer IDENTICALLY, so a second copy would have been drift
// by construction. The obvious worry here was that these helpers are the same
// class. They are not, and not because the duplication is benign: BECAUSE NO
// DUPLICATION EXISTS. The host's copies were deleted at this extraction along
// with the form that used them — they had become unreachable when the vocab
// module left `builtinModules` — so this package now holds the ONLY copy.
//
// What these helpers must still not drift from is the registry's own vocabulary
// of problems, which is why `validateVocabInstances` is written against core's
// published `isVocabProvider` / `VOCAB_PROVIDERS` rather than a hand-listed
// set: the form warns about exactly what the runtime will skip, by construction.

/** Result of parsing a config-textarea value. A blank textarea persists NO
 * config key (`config: undefined`); non-object or unparseable JSON is a LOUD
 * problem the form refuses to save — never a silent coerce. */
export type VocabConfigParse =
  | { ok: true; config: Record<string, unknown> | undefined }
  | { ok: false; error: string };

export function parseVocabConfig(text: string): VocabConfigParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, config: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `Config is not valid JSON: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: 'Config must be a JSON object, e.g. {"termsRoot": "00-09 System"}.' };
  }
  return { ok: true, config: parsed as Record<string, unknown> };
}

/** Render an instance's `config` object as pretty JSON for the textarea; an
 * absent or empty config is the empty string (the "no config" case). */
export function stringifyVocabConfig(config: Record<string, unknown> | undefined): string {
  if (!config || Object.keys(config).length === 0) return "";
  return JSON.stringify(config, null, 2);
}

/** Coerce a hand-edited (or adopted) `vocabularies` value into a safe array —
 * NEVER throws on malformed data.json. A non-array becomes `[]`; each entry is
 * coerced field-by-field with string fallbacks; a non-object `config` is
 * dropped. An unknown provider (or blank id/root) is PRESERVED verbatim so the
 * form shows it and `validateVocabInstances` flags it — coercion never hides a
 * problem by rewriting it, it only prevents a crash. Non-object entries are
 * dropped. */
export function coerceVocabInstances(raw: unknown): VocabInstanceSettings[] {
  if (!Array.isArray(raw)) return [];
  const out: VocabInstanceSettings[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const inst: VocabInstanceSettings = {
      id: typeof e.id === "string" ? e.id : "",
      provider: typeof e.provider === "string" ? e.provider : "",
      root: typeof e.root === "string" ? e.root : "",
    };
    if (e.config !== null && typeof e.config === "object" && !Array.isArray(e.config)) {
      inst.config = e.config as Record<string, unknown>;
    }
    out.push(inst);
  }
  return out;
}

/** Human-readable validation problems for the current instance list — empty ⇒
 * valid. Mirrors VocabRegistry's own skip-and-report rules (unknown provider,
 * duplicate id) so the form warns about exactly what the runtime would skip,
 * plus the ones the form can prevent (blank id; whitespace-only root). NOTE on
 * root: `""` is a FIRST-CLASS value meaning "whole vault" (the shipped glossary
 * default uses it), so root is NOT required non-empty — only a whitespace-ONLY
 * root (neither "" nor a real path) is flagged. */
export function validateVocabInstances(list: VocabInstanceSettings[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  list.forEach((inst, i) => {
    const label = `Instance ${i + 1}`;
    if (inst.id.trim() === "") {
      problems.push(`${label}: id is required.`);
    } else if (seen.has(inst.id)) {
      problems.push(`${label}: duplicate id '${inst.id}' — the first wins; later duplicates are skipped at runtime.`);
    } else {
      seen.add(inst.id);
    }
    if (!isVocabProvider(inst.provider)) {
      problems.push(
        `${label}: unknown provider '${inst.provider}' — must be one of ${VOCAB_PROVIDERS.join(", ")}; skipped at runtime.`,
      );
    }
    if (inst.root !== "" && inst.root.trim() === "") {
      problems.push(`${label}: root is whitespace-only — use blank for the whole vault, or a real vault-relative path.`);
    }
  });
  return problems;
}

/** Append a new, blank instance (first provider preselected). Pure. */
export function addVocabInstance(list: VocabInstanceSettings[]): VocabInstanceSettings[] {
  return [...list, { id: "", provider: VOCAB_PROVIDERS[0], root: "" }];
}

/** Remove the instance at `index`. Pure; out-of-range index is a no-op copy. */
export function removeVocabInstanceAt(list: VocabInstanceSettings[], index: number): VocabInstanceSettings[] {
  return list.filter((_, i) => i !== index);
}

/** Apply `patch` to the instance at `index`, returning a NEW array. A patch
 * value of `undefined` REMOVES that key (the "blank config means no config key"
 * convention). Pure. */
export function updateVocabInstanceAt(
  list: VocabInstanceSettings[],
  index: number,
  patch: Partial<VocabInstanceSettings>,
): VocabInstanceSettings[] {
  return list.map((inst, i) => {
    if (i !== index) return inst;
    const next: VocabInstanceSettings = { ...inst, ...patch };
    for (const k of Object.keys(patch) as Array<keyof VocabInstanceSettings>) {
      if (patch[k] === undefined) delete next[k];
    }
    return next;
  });
}
