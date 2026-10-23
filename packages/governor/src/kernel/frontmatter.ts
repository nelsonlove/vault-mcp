// Lightweight frontmatter split + top-level key extraction for the diff view and
// the acceptance-lifecycle READS (status lookup + the conformance gate). This is
// deliberately NOT a full YAML parser: for the key-by-key diff we only need each
// top-level key's raw text block, and the lifecycle reads only need scalar values.
// Anything we don't understand is preserved verbatim.
//
// Ported from obsidian-stewardship/src/frontmatter.ts as part of the governance
// (Acceptance) module fold (#83). The acceptance convergence (#221/#164) removed the
// string-rewriting `stampAcceptance` helper this file used to carry, and #599 removed its
// replacement, the in-app stamp of the accepted family: nothing in the governor writes
// `acceptance-status: accepted`, `accepted-by` or `accepted-on` now.
// Everything left in this file is READ-ONLY over note content — it can
// decide, but never write.

export interface ParsedNote {
  hasFrontmatter: boolean;
  frontmatterText: string; // raw text between the --- fences (no fences), "" if none
  body: string;
}

const FENCE = "---";

export function parseNote(content: string): ParsedNote {
  // Frontmatter must start at byte 0 with a `---` line.
  if (!content.startsWith(FENCE)) {
    return { hasFrontmatter: false, frontmatterText: "", body: content };
  }
  // Find the closing fence line.
  const lines = content.split("\n");
  if (lines[0].trim() !== FENCE) {
    return { hasFrontmatter: false, frontmatterText: "", body: content };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) { close = i; break; }
  }
  if (close === -1) {
    return { hasFrontmatter: false, frontmatterText: "", body: content };
  }
  const frontmatterText = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  return { hasFrontmatter: true, frontmatterText, body };
}

// Extract top-level keys → raw value block (value may span multiple indented lines,
// e.g. a YAML list). Order preserved. Used only for display-diffing frontmatter.
export function frontmatterKeys(frontmatterText: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!frontmatterText.trim()) return out;
  const lines = frontmatterText.split("\n");
  let curKey: string | null = null;
  let curVal: string[] = [];
  const flush = () => {
    if (curKey !== null) out.set(curKey, curVal.join("\n").trim());
    curKey = null;
    curVal = [];
  };
  for (const line of lines) {
    const topLevel = /^([A-Za-z0-9_.\- ]+):(.*)$/.exec(line);
    const indented = /^\s/.test(line);
    if (topLevel && !indented) {
      flush();
      curKey = topLevel[1].trim();
      curVal = [topLevel[2].trim()];
    } else {
      // continuation (indented list item, block scalar, etc.)
      curVal.push(line);
    }
  }
  flush();
  return out;
}

// The note's `acceptance-status` scalar value (trimmed, unquoted), or null when the note
// has no frontmatter or no `acceptance-status` key. READ-ONLY: this is what makes Accept
// context-aware (the convergence, #221/#164) — `proposed` ⇒ stamp + baseline, anything
// else (absent / `revising` / already `accepted`) ⇒ baseline advance only.
export function acceptanceStatusOf(content: string): string | null {
  const { hasFrontmatter, frontmatterText } = parseNote(content);
  if (!hasFrontmatter) return null;
  const raw = frontmatterKeys(frontmatterText).get("acceptance-status");
  if (raw === undefined) return null;
  return unquote(raw.trim());
}

// Raw scalar values that count as EMPTY for the conformance gate below.
const EMPTY_SCALARS = new Set(["", "null", "~", "[]", "{}"]);

// The conformance gate's check (#221/#164): which of `keys` are missing from — or empty
// in — the note's frontmatter. Pure and READ-ONLY; the caller (acceptNote) refuses the
// whole accept when this is non-empty for a `proposed` note. A key present with any
// substantive value passes; absent, blank, quoted-empty, or an explicit YAML null/empty
// collection counts as missing. An empty `keys` list gates nothing (the default).
export function missingRequiredKeys(content: string, keys: string[]): string[] {
  if (keys.length === 0) return [];
  const { hasFrontmatter, frontmatterText } = parseNote(content);
  const fm = hasFrontmatter ? frontmatterKeys(frontmatterText) : new Map<string, string>();
  return keys.filter((k) => {
    const raw = fm.get(k);
    if (raw === undefined) return true;
    return EMPTY_SCALARS.has(unquote(raw.trim()));
  });
}

// Strip one layer of matching quotes ("x" / 'x' → x). Local YAML-scalar convenience for
// the reads above — never used to write anything.
function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}
