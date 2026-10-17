// finding.ts — the canonical conformance Finding and its stable 4-tuple key.
//
// Every rule pack (the module findings adapters + the ported legacy checks)
// emits this shape. The key is `(script, check, target, kind)` — deliberately
// free of line numbers, positional ordinals, counts, and timestamps, so a
// finding has the SAME identity across runs regardless of output ordering. This
// is the identity the ratchet diffs against the accepted-debt baseline.
//
// The serialized form is `script|check|target|kind` (pipe-joined). A component
// that contains a literal `|` (or the `\` escape char) is ESCAPED so the pipe
// can never be confused with the field separator — see `encodeComponent`. This
// matters because a real vault note IS named with a pipe (e.g.
// `--dangerously-skip-reading-code | olano.dev.md`); its path becomes a finding
// `target`, and an un-escaped key would either mis-field or (as the old guard
// did) THROW and crash the whole run (issue #136 item 3).
//
// BASELINE COMPATIBILITY: the encoding is a byte-for-byte NO-OP for any
// component that contains neither `|` nor `\`. Every key in the existing
// accepted-debt baseline predates this change and contains no `|` in any
// component (a note whose path held a pipe used to crash the run, so none could
// ever have been blessed), so every baseline line serializes byte-identically
// and the accepted debt carries over with zero re-blessing.
//
// `detail` is human-facing text (the "message" a reviewer reads); it is NOT
// part of the key — two findings that differ only in wording are the same
// finding.

export interface Finding {
  /** The rule pack that produced it, e.g. "vocab_findings", "conformance_check". */
  script: string;
  /** The check/code within the pack, e.g. "unregistered_tag", "DROPPED". */
  check: string;
  /** What the finding is about — a note path, or a token when the finding is
   * not note-scoped. */
  target: string;
  /** A secondary discriminant (a blueprint name, an offending token, "" when
   * the check needs none). */
  kind: string;
  /** Human-readable message; excluded from the key. */
  detail: string;
}

const SEP = "|";
const ESC = "\\";

/**
 * Encode ONE key component so a literal `|` (the field separator) or a literal
 * `\` (the escape char) inside it cannot be confused with a real separator:
 * `\` → `\\`, then `|` → `\|`. The joined key is split back apart on UNescaped
 * `|` and each component decoded (`decodeComponent`), so key build ↔ parse
 * round-trip exactly and two findings differing only in WHERE a `|`/`\` sits
 * get distinct keys.
 *
 * BASELINE-COMPAT NO-OP: a component containing NEITHER `|` NOR `\` is returned
 * byte-for-byte unchanged (the early return is the guarantee, not merely a fast
 * path). Every existing baseline key is such a component in all four fields, so
 * the accepted-debt baseline carries over untouched.
 */
function encodeComponent(s: string): string {
  if (!s.includes(ESC) && !s.includes(SEP)) return s; // no-op guarantee (and fast path)
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * Inverse of {@link encodeComponent}: `\\` → `\` and `\|` → `|`. Every
 * backslash in an encoded component introduces a two-char escape, so a single
 * left-to-right pass that consumes the escaped char is exact.
 */
function decodeComponent(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/**
 * Split a serialized key on its UNescaped `|` separators — a `\|` is a literal
 * pipe inside a component, not a field boundary — walking char by char so an
 * escaped separator is preserved intact.
 */
function splitEncoded(line: string): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ESC && i + 1 < line.length) {
      cur += ch + line[i + 1];
      i++;
    } else if (ch === SEP) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * The stable key line for a finding: the four fields, each escaped, joined on
 * the raw `|`. TOTAL — it never throws (the old guard threw on a `|` in the
 * first three fields, which crashed the run for real pipe-in-path notes; the
 * escape makes any component safe to carry).
 */
export function findingKey(f: Pick<Finding, "script" | "check" | "target" | "kind">): string {
  return [f.script, f.check, f.target, f.kind].map(encodeComponent).join(SEP);
}

/**
 * Parse a baseline/key line back into its four fields, the exact inverse of
 * `findingKey`: split on UNescaped separators and decode each component.
 *
 * Under this encoding a well-formed key has EXACTLY four fields (every
 * component's pipes are escaped), so `kind` is the fourth field. A LEGACY key
 * written before escaping — `kind` carrying a raw, unescaped `|` — parses into
 * more than four fields; rejoin the remainder on the raw separator so those old
 * lines still round-trip. (Real baseline keys never hit this branch: they carry
 * no `|` at all.)
 */
export function parseKey(line: string): Pick<Finding, "script" | "check" | "target" | "kind"> {
  const parts = splitEncoded(line);
  const [script = "", check = "", target = ""] = parts;
  const kind = parts.length > 4 ? parts.slice(3).join(SEP) : (parts[3] ?? "");
  return {
    script: decodeComponent(script),
    check: decodeComponent(check),
    target: decodeComponent(target),
    kind: decodeComponent(kind),
  };
}
