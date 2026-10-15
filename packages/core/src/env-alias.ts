// env-alias.ts — the 0.12.0 naming unification's env-var contract.
//
// Every environment knob that used to be spelled `ASSENT_<X>` is now
// `GOVERNOR_<X>` first, with the old `ASSENT_<X>` spelling accepted as a
// legacy fallback alias so existing shells, Tickle jobs, and CI configs keep
// working. Precedence is pinned by tests/env-alias.test.mjs:
//
//   - `GOVERNOR_<X>` set (even to "")  ⇒ it wins; `ASSENT_<X>` is ignored.
//     (A set-but-empty value behaves exactly as a set-but-empty value always
//     did at each call site — usually "use the default" — it does NOT fall
//     through to the legacy spelling.)
//   - `GOVERNOR_<X>` unset             ⇒ `ASSENT_<X>` is read.
//
// One helper, no per-site re-implementations, so a new env knob gets the
// alias behavior by construction.

export function envAliased(
  env: Record<string, string | undefined>,
  suffix: string,
): string | undefined {
  const primary = env[`GOVERNOR_${suffix}`];
  return primary !== undefined ? primary : env[`ASSENT_${suffix}`];
}

/** Both spellings of an env knob, for messages that must name the setting
 * ("set GOVERNOR_CONTENT_ROOT (or legacy ASSENT_CONTENT_ROOT)"). */
export function envAliasNames(suffix: string): { primary: string; legacy: string } {
  return { primary: `GOVERNOR_${suffix}`, legacy: `ASSENT_${suffix}` };
}
