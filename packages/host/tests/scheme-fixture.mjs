// scheme-fixture.mjs — the scheme rows the scheme tests run against.
//
// Since step (b) of 01.33 pick A a fresh install has no scheme
// (DEFAULT_SCHEMES is empty) and the Johnny Decimal provider's own defaults
// expand nothing (DEFAULT_JD_CONFIG). A test that needs JD says so with these
// rows rather than leaning on a shipped default.
//
// FIXTURE_JD_CONFIG is test data, not a default: the note listings in the
// older scheme tests were written around one expanded area band and one
// expanded category (5-digit items such as `92021` and `27001`), so the
// fixture expands exactly those two for them. New tests pick their own
// made-up expansions.

/** The expansion the older scheme tests' listings are built around. */
export const FIXTURE_JD_CONFIG = Object.freeze({ expandedAreas: Object.freeze(["90-99"]), expandedCategories: Object.freeze(["27"]) });

/** One JD instance with the fixture's expansion. */
export const JD_SCHEMES = Object.freeze([Object.freeze({ id: "jd", provider: "johnny-decimal", config: FIXTURE_JD_CONFIG })]);
