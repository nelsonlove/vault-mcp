// Ported from Forge (github.com/nelsonlove/forge, commit d9f6704, src/shapes/identity.ts).
// MIT licence, copyright (c) 2026 Joshua Walls: the notice is in ./LICENSE and travels with this code.
// Changes for the conformance rail: only the two heading-matching functions are kept; the
// shape-note naming helpers (and their `normalisePath` import) belong to Forge's own shape
// notes, which the rail does not read.

const HEADING_PLACEHOLDER_SOURCE = "\\{\\{[^{}\\r\\n]+\\}\\}";

export function headingTextMatches(templateText: string, candidateText: string): boolean {
  if (templateText.localeCompare(candidateText, undefined, { sensitivity: "accent" }) === 0) {
    return true;
  }

  const placeholderPattern = new RegExp(HEADING_PLACEHOLDER_SOURCE, "g");
  let pattern = "^";
  let cursor = 0;
  let match = placeholderPattern.exec(templateText);
  if (match === null) return false;

  while (match !== null) {
    const index = match.index;
    pattern += escapeRegex(templateText.slice(cursor, index));
    pattern += ".+?";
    cursor = index + match[0].length;
    match = placeholderPattern.exec(templateText);
  }
  pattern += `${escapeRegex(templateText.slice(cursor))}$`;

  return new RegExp(pattern, "i").test(candidateText);
}

export function hasHeadingPlaceholder(text: string): boolean {
  return new RegExp(HEADING_PLACEHOLDER_SOURCE).test(text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
