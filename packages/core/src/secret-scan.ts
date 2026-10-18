// secret-scan.ts — blank key- and token-shaped strings in what a connection is sent.
//
// OFF BY DEFAULT: a deployment names the connection profiles to scan (redaction.ts), and may
// extend or replace the key names and token patterns (`SecretScanConfig`, `createSecretScanner`).
// Every tool reply on such a connection passes through the scanner before it leaves the server:
// the text of each content item, and every key and string in any structured content. Nothing
// else changes: not the tool's arguments, not what a tool writes to disk.
//
// WHAT IT BLANKS. Known key and token shapes (provider prefixes, AWS key ids, JWTs, PEM and PGP
// private key blocks), bearer and Authorization header values, the credentials in a URL
// (`scheme://user:pass@host` keeps scheme and host), and the value under a key that names a
// secret (password, pass, pw, passcode, token, cookie, API key, client secret and the like; any
// case; words joined by a space, `_` or `-`). In text such a value is found after `:`, `：`, `=`,
// `=>`, ` - ` or a tab (quoted or not, the key bold, italic or in backticks; a value that opens
// with `[` or `{` is blanked to its matching close), in a markdown table (a key cell, or a header
// cell that names a secret column), in a YAML block or list below the key, in an XML element and
// in an HTML `name=… value=…` pair. Each one becomes a fixed marker, `[redacted:<kind>]`; no part
// of the secret is kept.
//
// JSON AND STRUCTURED CONTENT. Text that parses as JSON (most tool replies) is parsed, scanned
// key-aware and written back in the same layout, so it still parses: the whole value under a
// secret-named key is blanked whatever its type, every other string is scanned as text, and a key
// that is itself a token is blanked. Structured content is scanned the same way. Booleans, null
// and empty values are kept.
//
// SEARCH SNIPPETS. A search hit carries one trimmed line, often without its key. Under `snippets`
// (the wrapper of obsidian_search_notes) a snippet that looks like a secret body is blanked as
// well: a line of only base64 or hex (a PEM or PGP body line), a one-token line or list item, and
// the secret-looking cells of a table row.
//
// WHAT IT NEVER BLANKS ON ITS OWN. A long or random-looking string is not enough: uids, uuids,
// hashes and commit shas pass unchanged (outside search snippets). Only a shape or a key name
// triggers a blank.
//
// SAFETY. Every pattern is anchored or has no backtracking path, so the scan is linear in its
// input. The scanner never throws: on any internal error it blanks the whole text (fail closed)
// rather than return it raw.
//
// LIMITS. This is a best-effort filter. A secret in a form it does not know (a bare password in
// prose, a key split from its value, an encoding) passes through.

/** The marker a blanked string becomes. */
export function redactionMarker(kind: string): string {
  return `[redacted:${kind}]`;
}

/** The text that replaces a whole text when the scan itself failed (fail closed). */
export const SCAN_FAILED_TEXT = redactionMarker("scan-failed");

const SECRET_MARK = redactionMarker("secret");

/** Options for one scan. */
export interface ScanOpts {
  /** The reply is search hits: a `snippet` that looks like a secret body is blanked too. */
  snippets?: boolean;
}

// ── token shapes ────────────────────────────────────────────────────────────

// A token starts at the start of a run of token characters, or right after a JSON-escaped line
// break (`\n` as two characters). Anchoring every prefix pattern at a run start keeps the scan
// linear: matches cannot start inside one run over and over.
const START = String.raw`(?:(?<![A-Za-z0-9_\-])|(?<=\\[nrt]))`;

interface Rule {
  kind: string;
  re: RegExp;
  /** Build the replacement from the match groups; default: the marker for the whole match. */
  replace?: (m: string, ...groups: string[]) => string;
}

const tokenRule = (kind: string, body: string): Rule => ({ kind, re: new RegExp(`${START}${body}`, "g") });

// Structural rules that always run first: private key blocks and JWTs.
const RULES_BEFORE: Rule[] = [
  // PEM and PGP private key blocks: a whole block, then any BEGIN header left without an END (a cut read).
  {
    kind: "private-key",
    // The body holds no '-' (base64 and line breaks), so `[^-]` stops at the END line: one split, no backtracking.
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[^-]{0,65536}-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:\\[nrt]|[A-Za-z0-9+/=\s:,-])*/g,
  },
  // JSON Web Tokens: three base64url segments, the first a JSON header (`eyJ`).
  tokenRule("jwt", String.raw`eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*`),
];

// The provider key shapes shipped by default (generic, public prefixes). A config can extend
// them (`extraPatterns`) or replace them (`patterns`); the structural rules always run.
export const DEFAULT_TOKEN_PATTERNS: ReadonlyArray<TokenPattern> = Object.freeze([
  { kind: "anthropic-key", regex: String.raw`sk-ant-[A-Za-z0-9_-]{20,}` },
  { kind: "stripe-key", regex: String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}` },
  { kind: "api-key", regex: String.raw`sk-[A-Za-z0-9_-]{20,}` },
  { kind: "github-token", regex: String.raw`(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})` },
  { kind: "gitlab-token", regex: String.raw`glpat-[A-Za-z0-9_-]{20,}` },
  { kind: "slack-token", regex: String.raw`(?:xox[abposre]-[A-Za-z0-9-]{10,}|xapp-[0-9]+-[A-Za-z0-9-]{10,})` },
  { kind: "huggingface-token", regex: String.raw`hf_[A-Za-z0-9]{30,}` },
  { kind: "npm-token", regex: String.raw`npm_[A-Za-z0-9]{36,}` },
  { kind: "tailscale-key", regex: String.raw`tskey-[A-Za-z0-9-]{10,}` },
  { kind: "sendgrid-key", regex: String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}` },
  { kind: "aws-key-id", regex: String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])` },
  { kind: "google-api-key", regex: String.raw`AIza[0-9A-Za-z_-]{35}` },
]);

// Structural rules that always run last: Authorization and bearer values, URL credentials.
const RULES_AFTER: Rule[] = [
  // An Authorization header (or key) value; the scheme word is kept.
  {
    kind: "authorization",
    re: /(authorization\\?["']?[ \t]{0,16}[:=][ \t]{0,16}\\?["']?)((?:bearer|basic|token|digest)[ \t]+)?(?!\[redacted:)(?:\\[^nrt"]|[^\s"'\\]){4,}/gi,
    replace: (_m, head: string, scheme: string | undefined) => `${head}${scheme ?? ""}${redactionMarker("authorization")}`,
  },
  // A bearer token anywhere else. It must hold a digit, so prose ("Bearer authentication") passes.
  {
    kind: "bearer-token",
    re: /((?:(?<![A-Za-z0-9])|(?<=\\[nrt]))bearer[ \t]+)(?!\[redacted:)(?=[A-Za-z._~+/=-]{0,512}[0-9])[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (_m, head: string) => `${head}${redactionMarker("bearer-token")}`,
  },
  // Credentials in a URL: keep the scheme and the host, blank `user:pass`.
  {
    kind: "url-credentials",
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:"'\\]{1,256}:[^\s/"'\\]{1,256}@/gi,
    replace: (_m, scheme: string) => `${scheme}${redactionMarker("url-credentials")}@`,
  },
];

function scanTokens(R: Compiled, text: string): string {
  let out = text;
  for (const rule of R.tokenRules) {
    rule.re.lastIndex = 0;
    out = rule.replace
      ? out.replace(rule.re, rule.replace as (m: string, ...g: string[]) => string)
      : out.replace(rule.re, redactionMarker(rule.kind));
  }
  return out;
}

// ── secret key names ────────────────────────────────────────────────────────

// Words of one name may be joined by a space, `_` or `-` (`API Key`, `api_key`, `secret-key`), or
// by nothing (`apiKey`).
const J = String.raw`[ _-]{0,3}`;
// A key that names a secret. It may sit at the end of a longer name (`db_password`,
// `GITHUB_TOKEN`, `clientSecret`, `sessionCookie`); in text it may not be followed by more letters
// (`tokens`, `secretary`) or by `_x` (`token_count`), because a separator must come next. `pass`
// and `pw` need a boundary before them too, so `bypass` and `compass` are not keys. A bare `pin`
// is not a key: it blanks too much.
const DEFAULT_SECRET_WORDS = String.raw`(?:password|passwd|passphrase|pass${J}code|(?<![A-Za-z0-9])pass|(?<![A-Za-z0-9])pw|pwd|secret|token|cookie|credentials?|api${J}key|apikey|(?:access|private|secret|encryption|signing|master|session|client)${J}key)`;
// A key may end in a form word: `privateKeyPem`, `api_key_value`.
const keyFragment = (words: string): string => String.raw`${words}(?:${J}(?:pem|value|b64|base64))?`;

// An object key (or a table header cell) that names a secret: the name ends the key.
// `authorization` too, since a header object carries it; camelCase `dbPass` and `dbPw` as well.
const CAMEL_PASS = /[a-z0-9](?:Pass|Pw)$/;

function isSecretKeyName(R: Compiled, k: string): boolean {
  return k.length <= 256 && (R.keyName.test(k) || CAMEL_PASS.test(k));
}

// ── values ──────────────────────────────────────────────────────────────────

// Values that carry no secret: booleans, null, and an empty or blank value.
const NOT_A_SECRET = /^(?:true|false|null|none|yes|no|~|\s*)$/i;

const isRedacted = (s: string): boolean => s.startsWith("[redacted:");

// Markup that may wrap a key, before or after its separator: `**password**:`, `*password*:`,
// `__password__:`, `` `password`: ``, `**API Key:**`.
const WRAP = String.raw`(?:\*{1,2}|_{1,2}|\x60)?`;
// The separators: `:` (also full-width `：`), `=`, `=>`, ` - ` and a tab.
const SEP = String.raw`(?:[ \t]{0,16}(?:=>|[:=\uFF1A])|\t+|[ \t]{1,16}-(?=[ \t]))`;
const headOf = (SECRET_KEY: string): string => String.raw`(${SECRET_KEY}(?![A-Za-z0-9])${WRAP}\\?["']?${SEP}${WRAP}(?![ \t]*\[redacted:)[ \t]*)`;
// The value, in text with real line breaks: a bracket (blanked to its match, below),
// double-quoted (with escapes), single-quoted (never past a `"`), or bare to the end of the line.
// No value is capped, so no tail leaks; none has a backtracking path.
const kvPlainOf = (HEAD: string): RegExp => new RegExp(String.raw`${HEAD}(?:([\[{])|("(?:[^"\\\r\n]|\\.)*"?|'[^'"\\\r\n]*'?|[^\r\n]+))`, "gi");
// The same in JSON-escaped text (no real line breaks, `\n` as two characters): a value may be
// `\"…\"`, and a bare value stops at an escaped line break or a `"` (the end of the JSON string).
const kvEscapedOf = (HEAD: string): RegExp => new RegExp(
  String.raw`${HEAD}(?:([\[{])|("(?:[^"\\\r\n]|\\.)*"?|\\"(?:[^"\\]|\\\\\\"|\\\\|\\[^"\\])*(?:\\")?|'[^'"\\\r\n]*'?|(?:\\[^nrt]|[^"\\\r\n])+))`,
  "gi"
);

function blankValue(value: string): string {
  // Leading blanks stay, so a quote right after them is still seen as a quote.
  const lead = value.slice(0, value.length - value.trimStart().length);
  value = value.slice(lead.length);
  // Keep the quotes that wrap the value, blank what is inside.
  let open = "";
  let close = "";
  let inner = value;
  for (const q of ['\\"', '"', "'"]) {
    if (inner.startsWith(q)) {
      open = q;
      inner = inner.slice(q.length);
      if (inner.endsWith(q) && !(q === '"' && inner.endsWith('\\"') && !inner.endsWith('\\\\"'))) {
        close = q;
        inner = inner.slice(0, inner.length - q.length);
      }
      break;
    }
  }
  const trimmed = inner.trimEnd();
  if (NOT_A_SECRET.test(trimmed) || isRedacted(trimmed)) return lead + value;
  return `${lead}${open}${SECRET_MARK}${inner.slice(trimmed.length)}${close}`;
}

// The longest bracketed value matched; past it the value is blanked to the end of its block.
const BRACKET_CAP = 1 << 20;

/**
 * The end (exclusive) of the bracketed value that opens at `i`, or -1 when it does not close
 * within the cap. Brackets are counted, quoted strings (with escapes) skipped. One pass.
 */
function matchBracket(text: string, i: number, escaped: boolean): number {
  let depth = 0;
  const end = Math.min(text.length, i + BRACKET_CAP);
  for (let j = i; j < end; j++) {
    const c = text[j];
    if (!escaped && c === "\n") {
      // A blank line ends the block: the value did not close inside it. Stopping here (and not at
      // the cap) keeps the whole pass linear: the caller resumes after this point.
      let k = j + 1;
      while (k < end && (text[k] === " " || text[k] === "\t" || text[k] === "\r")) k++;
      if (k >= text.length || text[k] === "\n") return -1;
      continue;
    }
    if (!escaped && (c === '"' || c === "'")) {
      // Skip a quoted string; an unclosed one runs to the end of its line, which the loop then sees.
      let k = j + 1;
      while (k < end && text[k] !== c && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
      j = k < end && text[k] === "\n" ? k - 1 : k;
      continue;
    }
    if (escaped && c === "\\") {
      j++;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/** Where a value that did not close ends: the next blank line, or the end of the text. */
function endOfBlock(text: string, i: number, escaped: boolean): number {
  if (escaped) return text.length;
  const re = /\n[ \t]*\r?\n/g;
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? m.index : text.length;
}

/** Blank every value after a secret key, in one pass (a bracket jumps to its match). */
function replaceKeyValues(R: Compiled, text: string, escaped: boolean): string {
  const re = escaped ? R.kvEscaped : R.kvPlain;
  re.lastIndex = 0;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const valStart = m.index + m[1].length;
    if (m[2] !== undefined) {
      let end = matchBracket(text, valStart, escaped);
      if (end < 0) end = endOfBlock(text, valStart, escaped);
      out += text.slice(last, valStart) + SECRET_MARK;
      last = end;
      re.lastIndex = end;
    } else {
      const value = m[3];
      out += text.slice(last, valStart) + blankValue(value);
      last = valStart + value.length;
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + text.slice(last);
}

// An XML element that names a secret: `<password>x</password>`.
const xmlOf = (SECRET_KEY: string): RegExp => new RegExp(String.raw`(<[A-Za-z0-9_.:-]{0,64}?${SECRET_KEY}(?![A-Za-z0-9])(?:\s[^<>]{0,256})?>)([^<]+)`, "gi");
// An HTML input that names a secret: `name="password" … value="x"`.
const htmlOf = (SECRET_KEY: string): RegExp => new RegExp(
  String.raw`(\bname[ \t]*=[ \t]*["']?[^"'\s>]{0,64}?${SECRET_KEY}(?![A-Za-z0-9])[^"'\s>]{0,16}["']?[^<>]{0,512}?\bvalue[ \t]*=[ \t]*)("[^"]*"?|'[^']*'?|[^\s>"']+)`,
  "gi"
);

function blankCell(cell: string): string {
  const t = cell.trim();
  if (NOT_A_SECRET.test(t) || isRedacted(t)) return cell;
  const lead = cell.slice(0, cell.length - cell.trimStart().length);
  const trail = cell.slice(cell.trimEnd().length);
  return `${lead}${SECRET_MARK}${trail}`;
}

// ── the line pass: markdown tables and YAML blocks ──────────────────────────

const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*\r?$/;
// A YAML key that names a secret, with its value on the lines below (nothing after the colon but
// a block indicator or a comment). Run on one line at a time, anchored at its start.
const yamlHeadOf = (SECRET_KEY: string): RegExp => new RegExp(String.raw`^([ \t]*)((?:- )?[^:\r\n]{0,64}?${SECRET_KEY}(?![A-Za-z0-9])${WRAP}["']?[ \t]*:)[ \t]*(?:[|>][+-]?[0-9]?[ \t]*)?(?:#.*)?\r?$`, "i");
// A blockquote or callout prefix (`> `, `>> `, `> > `), nested quotes included.
const QUOTE_PREFIX = /^(?:[ \t]{0,3}>[ \t]?)+/;
// A table cell boundary: a pipe that is not escaped (`[[Note\|alias]]` keeps its pipe).
const PIPE = /(?<!\\)\|/;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const cellText = (c: string): string => c.trim().replace(/^[*_`]+|[*_`]+$/g, "").trim();
const isSep = (body: string | undefined): boolean => body !== undefined && body.includes("-") && PIPE.test(body) && TABLE_SEP.test(body);

interface QLine {
  prefix: string;
  depth: number;
  body: string;
}

function splitQuote(line: string): QLine {
  const m = line.length && (line[0] === ">" || line[0] === " " || line[0] === "\t") ? QUOTE_PREFIX.exec(line) : null;
  if (!m) return { prefix: "", depth: 0, body: line };
  let depth = 0;
  for (const c of m[0]) if (c === ">") depth++;
  return { prefix: m[0], depth, body: line.slice(m[0].length) };
}

/**
 * One pass over the lines, inside blockquotes and callouts too (each line's `>` prefix is set
 * aside, and the state resets when the quote depth changes). A YAML key that names a secret has
 * its block or list below collapsed into one marker. In a markdown table (with or without outer
 * pipes; an escaped `\|` is not a cell boundary), a cell that names a secret blanks the cell after
 * it, and a header cell that names a secret blanks its column in every body row to the end of the
 * table.
 */
function scanLines(R: Compiled, text: string): string {
  if (!text.includes("\n") && !text.includes("|")) return text;
  const lines = text.split("\n").map(splitQuote);
  const out: string[] = [];
  // The open table: its quote depth, its secret columns, and whether its rows have outer pipes.
  let table: { depth: number; cols: Set<number> } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const { prefix, depth, body } = lines[i];
    if (table && table.depth !== depth) table = null;
    // A YAML block or list under a secret key. Only lines that hold a colon are tried, and only
    // up to a length, so the anchored pattern stays cheap. The block stays at the same quote depth.
    const y = body.length <= 512 && body.includes(":") ? R.yamlHead.exec(body) : null;
    if (y) {
      const indent = y[1].length;
      const headIsItem = /^[ \t]*- /.test(body);
      let j = i + 1;
      let lastIn = -1;
      while (j < lines.length && lines[j].depth === depth) {
        const l = lines[j].body;
        if (l.trim() === "") {
          j++;
          continue;
        }
        const ind = indentOf(l);
        if (ind > indent || (ind === indent && !headIsItem && /^[ \t]*- /.test(l))) {
          lastIn = j;
          j++;
          continue;
        }
        break;
      }
      if (lastIn > i) {
        out.push(`${prefix}${y[1]}${y[2]} ${SECRET_MARK}${body.endsWith("\r") ? "\r" : ""}`);
        i = lastIn;
        table = null;
        continue;
      }
    }
    const hasPipe = PIPE.test(body);
    const next = lines[i + 1];
    const isHeader = hasPipe && !isSep(body) && next !== undefined && next.depth === depth && isSep(next.body);
    const inTable = hasPipe && (table !== null || /^[ \t]*\|/.test(body));
    if (!isHeader && !inTable) {
      table = null;
      out.push(prefix + body);
      continue;
    }
    if (isSep(body)) {
      out.push(prefix + body);
      continue;
    }
    const parts = body.split(PIPE);
    // With an outer pipe, the text before it is indentation; without one, the first cell starts the line.
    const first = parts[0].trim() === "" ? 1 : 0;
    const lastEx = parts.length > first + 1 && parts[parts.length - 1].trim() === "" ? parts.length - 1 : parts.length;
    if (isHeader) {
      const cols = new Set<number>();
      for (let k = first; k < lastEx; k++) if (isSecretKeyName(R, cellText(parts[k]))) cols.add(k - first);
      table = { depth, cols };
      out.push(prefix + body);
      continue;
    }
    let changed = false;
    for (let k = first; k < lastEx; k++) {
      const blankThis = (table?.cols.has(k - first) ?? false) || (k > first && isSecretKeyName(R, cellText(parts[k - 1])));
      if (blankThis) {
        const b = blankCell(parts[k]);
        if (b !== parts[k]) {
          parts[k] = b;
          changed = true;
        }
      }
    }
    if (!table) table = { depth, cols: new Set() };
    out.push(prefix + (changed ? parts.join("|") : body));
  }
  return out.join("\n");
}

/** The text rules, for text that is not JSON. */
function scanPlain(R: Compiled, text: string): string {
  // JSON-escaped text: no real line break, and `\n` or `\"` as two characters.
  const escaped = !/[\r\n]/.test(text) && /\\[nrt"]/.test(text);
  let out = scanTokens(R, text);
  out = out.replace(R.html, (_m, head: string, value: string) => head + blankValue(value));
  out = out.replace(R.xml, (_m, head: string, body: string) => head + blankCell(body));
  if (!escaped) out = scanLines(R, out);
  return replaceKeyValues(R, out, escaped);
}

// ── search snippets ─────────────────────────────────────────────────────────

// Both search backends trim each snippet, so these rules see a line with no indentation.
const BASE64_LINE = /^[A-Za-z0-9+/]{24,}={0,2}$/;
const HEX_LINE = /^[0-9a-fA-F]{24,}$/;
// The short last line of a PEM body (`Fq0b==`) and a PGP checksum line (`=AbCd`).
const BASE64_TAIL = /^(?:[A-Za-z0-9+/]{2,}={1,2}|=[A-Za-z0-9+/]{4})$/;
// A one-token line: a YAML list item or block line, its key out of view.
const ONE_TOKEN = /^(?:- )?(\S{6,})$/;

/**
 * Whether one token looks like a secret value: 6 or more characters, no spaces, a digit or an
 * inner symbol, and not an email, URL, path, link, tag, file name, plain word with hyphens, or a
 * pure number, date, time or version.
 */
function looksSecret(tok: string): boolean {
  if (tok.length < 6 || tok.length > 512 || /\s/.test(tok) || isRedacted(tok)) return false;
  if (!(/[0-9]/.test(tok) || /[A-Za-z0-9][^A-Za-z0-9\s][A-Za-z0-9]/.test(tok))) return false;
  if (/^(?:\[|#|!|`|<|>|\*\*?[A-Za-z]|[a-z][a-z0-9+.-]*:\/\/|mailto:|https?:)/i.test(tok)) return false;
  if (tok.includes("/") || tok.includes("](") || tok.includes("[[")) return false;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(tok)) return false;
  if (/^[A-Za-z]+(?:[-'][A-Za-z]+)+[.,;:!?]?$/.test(tok)) return false;
  if (/^[+$€£]?[0-9][0-9.,:\-+%()]*$/.test(tok)) return false;
  if (/^v?[0-9]+(?:\.[0-9]+)+(?:[-+][A-Za-z0-9.]+)?$/.test(tok)) return false;
  if (/\.(?:md|markdown|png|jpe?g|gif|svg|webp|pdf|txt|csv|json|ya?ml|base|canvas|html?|js|ts|py)$/i.test(tok)) return false;
  return true;
}

/** A search snippet (one trimmed line) with a secret body blanked, even when its key is out of view. */
function scanSnippet(s: string): string {
  // A snippet from a blockquote or callout keeps its `>` markers; every rule sees the line after them.
  const q = /^(?:[ \t]*>[ \t]?)+/.exec(s);
  const prefix = q ? q[0] : "";
  const t = s.slice(prefix.length).trim();
  if (t.length <= 8192 && ((BASE64_LINE.test(t) && /[0-9+/=]/.test(t)) || HEX_LINE.test(t) || BASE64_TAIL.test(t))) return prefix + SECRET_MARK;
  const one = t.length <= 512 ? ONE_TOKEN.exec(t) : null;
  if (one && looksSecret(one[1])) return prefix + t.slice(0, t.length - one[1].length) + SECRET_MARK;
  // A table row, with or without outer pipes: blank each cell that holds one secret-looking token.
  if (t.length <= 8192 && PIPE.test(t)) {
    const parts = t.split(PIPE);
    let changed = false;
    for (let k = 0; k < parts.length; k++) {
      const c = parts[k].trim();
      if (looksSecret(c)) {
        parts[k] = parts[k].replace(c, SECRET_MARK);
        changed = true;
      }
    }
    if (changed) return prefix + parts.join("|");
  }
  return s;
}

// ── the walk ────────────────────────────────────────────────────────────────

interface Ctx {
  changed: boolean;
  snippets: boolean;
}

/** Whether a value under a secret-named key holds something to blank (booleans, null and empties do not). */
function blankable(v: unknown): boolean {
  if (v === null || v === undefined || typeof v === "boolean") return false;
  if (typeof v === "string") return !(NOT_A_SECRET.test(v.trim()) || isRedacted(v.trim()));
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Set an own property, `__proto__` included, without touching the prototype. */
function put(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/**
 * A value with every secret blanked, key-aware: the whole value under a secret-named key becomes
 * the marker, whatever its type (booleans, null and empties are kept); a key that is itself a
 * token is blanked; every other string is scanned as text. Plain objects and arrays are copied;
 * other objects (Date, Map, class instances) are kept as they are.
 */
function scanValue(R: Compiled, v: unknown, depth: number, ctx: Ctx): unknown {
  if (depth > 64) {
    ctx.changed = true;
    return SCAN_FAILED_TEXT;
  }
  if (typeof v === "string") {
    const s = scanText(R, v, depth + 1, ctx.snippets);
    if (s !== v) ctx.changed = true;
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => scanValue(R, x, depth + 1, ctx));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = Object.getPrototypeOf(v) === null ? Object.create(null) : {};
    for (const [k, x] of Object.entries(v)) {
      let key = scanTokens(R, k);
      if (key !== k) {
        ctx.changed = true;
        let n = 2;
        const base = key;
        while (Object.prototype.hasOwnProperty.call(out, key)) key = `${base}#${n++}`;
      }
      if (isSecretKeyName(R, k) && blankable(x)) {
        put(out, key, SECRET_MARK);
        ctx.changed = true;
      } else if (ctx.snippets && k === "snippet" && typeof x === "string") {
        const s = scanText(R, scanSnippet(x), depth + 1, true);
        if (s !== x) ctx.changed = true;
        put(out, key, s);
      } else put(out, key, scanValue(R, x, depth + 1, ctx));
    }
    return out;
  }
  return v;
}

/**
 * Text that is JSON (an object or array, as most tool replies are) is parsed, scanned key-aware,
 * and written back in the same layout, so it still parses; when nothing changed the text is
 * returned as it was. Any other text gets the text rules.
 */
function scanText(R: Compiled, text: string, depth: number, snippets: boolean): string {
  if (depth <= 64 && /^\s*[{[]/.test(text)) {
    let parsed: unknown;
    let ok = false;
    try {
      parsed = JSON.parse(text);
      ok = true;
    } catch {
      /* not JSON: the text rules below */
    }
    if (ok) {
      const ctx: Ctx = { changed: false, snippets };
      const out = scanValue(R, parsed, depth + 1, ctx);
      if (!ctx.changed) return text;
      const body = text.trim();
      const indent = /^[{[]\r?\n([ \t]+)/.exec(body)?.[1];
      const lead = text.slice(0, text.length - text.trimStart().length);
      const trail = text.slice(text.trimEnd().length);
      return lead + JSON.stringify(out, null, indent) + trail;
    }
  }
  return scanPlain(R, text);
}

/** A content item with its text blanked. Binary items (image, audio data) are left as they are. */
function redactContentItem(R: Compiled, item: unknown, opts: ScanOpts): unknown {
  if (!item || typeof item !== "object") return item;
  const it = item as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...it };
  if (typeof it.text === "string") copy.text = scanString(R, it.text, opts);
  if (it.type === "resource" && it.resource && typeof it.resource === "object") {
    const res = { ...(it.resource as Record<string, unknown>) };
    if (typeof res.text === "string") res.text = scanString(R, res.text, opts);
    if (typeof res.uri === "string") res.uri = scanString(R, res.uri);
    copy.resource = res;
  }
  if (it.type === "resource_link") {
    for (const k of ["uri", "name", "title", "description"]) if (typeof it[k] === "string") copy[k] = scanString(R, it[k] as string);
  }
  return copy;
}

/** A tool result scanned with one compiled rule set. Never throws (see `SecretScanner`). */
function scanResult<T>(R: Compiled, result: T, opts: ScanOpts): T {
  try {
    if (!result || typeof result !== "object") return (typeof result === "string" ? scanString(R, result, opts) : result) as T;
    const r = result as Record<string, unknown>;
    const out: Record<string, unknown> = { ...r };
    if (Array.isArray(r.content)) out.content = r.content.map((c) => redactContentItem(R, c, opts));
    if (r.structuredContent !== undefined) out.structuredContent = scanValue(R, r.structuredContent, 0, { changed: false, snippets: opts.snippets === true });
    return out as T;
  } catch {
    return { content: [{ type: "text", text: SCAN_FAILED_TEXT }], isError: true } as unknown as T;
  }
}

function scanString(R: Compiled, text: string, opts: ScanOpts = {}): string {
  try {
    if (typeof text !== "string") return SCAN_FAILED_TEXT;
    return scanText(R, text, 0, opts.snippets === true);
  } catch {
    return SCAN_FAILED_TEXT;
  }
}

/** A thrown error with its message blanked (the SDK turns a thrown error's message into the reply). */
function redactThrown(R: Compiled, e: unknown): unknown {
  try {
    if (e instanceof Error) {
      e.message = scanString(R, e.message);
      return e;
    }
    return typeof e === "string" ? scanString(R, e) : e;
  } catch {
    return new Error(SCAN_FAILED_TEXT);
  }
}

/** The tools whose replies are search hits, scanned with `snippets`. */
export const SNIPPET_TOOLS: ReadonlySet<string> = new Set(["obsidian_search_notes"]);

// ── configuration ───────────────────────────────────────────────────────────

/** One token pattern: a kind for the marker and a regular expression (source text). */
export interface TokenPattern {
  kind: string;
  regex: string;
  ignoreCase?: boolean;
}

/**
 * What a deployment may change. Every field is optional; an empty config is the shipped defaults.
 * - `keyNames` replaces the shipped secret key names; `extraKeyNames` adds to them (or to `keyNames`).
 * - `patterns` replaces the shipped provider token shapes; `extraPatterns` adds to them. The
 *   structural rules (private key blocks, JWTs, Authorization and bearer values, URL credentials)
 *   always run.
 */
export interface SecretScanConfig {
  keyNames?: string[];
  extraKeyNames?: string[];
  patterns?: TokenPattern[];
  extraPatterns?: TokenPattern[];
}

/** A config the scanner refuses. The caller must not serve the profiles it covers unscanned. */
export class SecretScanConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretScanConfigError";
  }
}

const CONFIG_KEYS = new Set(["keyNames", "extraKeyNames", "patterns", "extraPatterns"]);
const KEY_NAME_RE = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
const KIND_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Strings a user pattern is tried on, to find one that can match an empty span.
const ZERO_WIDTH_SAMPLES = ["", " ", "a", "abc def", "A1_b-2.c", "token: x", "\n", "[]{}"];
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function keyNameList(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new SecretScanConfigError(`${field} must be a list of key names`);
  return v.map((n, i) => {
    if (typeof n !== "string" || n.length > 64 || !KEY_NAME_RE.test(n.trim())) {
      throw new SecretScanConfigError(`${field}[${i}] must be 1 to 64 letters or digits, words joined by a space, '_' or '-'`);
    }
    return n.trim();
  });
}

function patternList(v: unknown, field: string): TokenPattern[] {
  if (!Array.isArray(v)) throw new SecretScanConfigError(`${field} must be a list of { kind, regex } objects`);
  return v.map((p, i) => {
    const at = `${field}[${i}]`;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new SecretScanConfigError(`${at} must be a { kind, regex } object`);
    const o = p as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== "kind" && k !== "regex" && k !== "ignoreCase") throw new SecretScanConfigError(`${at} has an unknown field '${k}'`);
    if (typeof o.kind !== "string" || !KIND_RE.test(o.kind)) throw new SecretScanConfigError(`${at}.kind must be 1 to 40 lower-case letters, digits or '-'`);
    if (typeof o.regex !== "string" || o.regex.length === 0 || o.regex.length > 512) throw new SecretScanConfigError(`${at}.regex must be a regular expression of 1 to 512 characters`);
    if (o.ignoreCase !== undefined && typeof o.ignoreCase !== "boolean") throw new SecretScanConfigError(`${at}.ignoreCase must be true or false`);
    try {
      // A pattern that can match nothing (`\b`, `(?:)|a`, `a{0}`) would blank empty spans: refused.
      const re = new RegExp(`(?:${o.regex})`, o.ignoreCase === true ? "gi" : "g");
      for (const sample of ZERO_WIDTH_SAMPLES) {
        re.lastIndex = 0;
        for (let n = 0; n <= sample.length; n++) {
          const m = re.exec(sample);
          if (!m) break;
          if (m[0].length === 0) throw new SecretScanConfigError(`${at}.regex can match an empty string`);
        }
      }
    } catch (e) {
      if (e instanceof SecretScanConfigError) throw e;
      throw new SecretScanConfigError(`${at}.regex does not compile: ${(e as Error).message}`);
    }
    return { kind: o.kind, regex: o.regex, ...(o.ignoreCase === true ? { ignoreCase: true } : {}) };
  });
}

/** Check a config value (parsed JSON). Throws `SecretScanConfigError`; never returns a partial config. */
export function parseSecretScanConfig(v: unknown): SecretScanConfig {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new SecretScanConfigError("the scanner config must be a JSON object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!CONFIG_KEYS.has(k)) throw new SecretScanConfigError(`unknown scanner config field '${k}'; known: ${[...CONFIG_KEYS].join(", ")}`);
  const cfg: SecretScanConfig = {};
  if (o.keyNames !== undefined) {
    cfg.keyNames = keyNameList(o.keyNames, "keyNames");
    if (cfg.keyNames.length === 0) throw new SecretScanConfigError("keyNames, when given, must name at least one key (it replaces the shipped list)");
  }
  if (o.extraKeyNames !== undefined) cfg.extraKeyNames = keyNameList(o.extraKeyNames, "extraKeyNames");
  if (o.patterns !== undefined) {
    cfg.patterns = patternList(o.patterns, "patterns");
    if (cfg.patterns.length === 0) throw new SecretScanConfigError("patterns, when given, must hold at least one pattern (it replaces the shipped provider shapes)");
  }
  if (o.extraPatterns !== undefined) cfg.extraPatterns = patternList(o.extraPatterns, "extraPatterns");
  return cfg;
}

/** A key name as a regex fragment: its words joined like the shipped names; a short name needs a boundary before it. */
function keyNameFragment(name: string): string {
  const words = name.split(/[ _-]+/).map(escapeRe).join(J);
  return name.length <= 3 ? `(?<![A-Za-z0-9])${words}` : words;
}

interface Compiled {
  tokenRules: Rule[];
  keyName: RegExp;
  kvPlain: RegExp;
  kvEscaped: RegExp;
  xml: RegExp;
  html: RegExp;
  yamlHead: RegExp;
}

function compile(cfg: SecretScanConfig): Compiled {
  const words: string[] = [];
  if (cfg.keyNames) words.push(...cfg.keyNames.map(keyNameFragment));
  else words.push(DEFAULT_SECRET_WORDS);
  if (cfg.extraKeyNames) words.push(...cfg.extraKeyNames.map(keyNameFragment));
  const SECRET_KEY = keyFragment(`(?:${words.join("|")})`);
  const provider = [...(cfg.patterns ?? DEFAULT_TOKEN_PATTERNS), ...(cfg.extraPatterns ?? [])].map(
    (p): Rule => ({ kind: p.kind, re: new RegExp(`${START}(?:${p.regex})`, p.ignoreCase ? "gi" : "g") })
  );
  const HEAD = headOf(SECRET_KEY);
  return {
    tokenRules: [...RULES_BEFORE, ...provider, ...RULES_AFTER],
    keyName: new RegExp(String.raw`(?:${SECRET_KEY}|authorization)$`, "i"),
    kvPlain: kvPlainOf(HEAD),
    kvEscaped: kvEscapedOf(HEAD),
    xml: xmlOf(SECRET_KEY),
    html: htmlOf(SECRET_KEY),
    yamlHead: yamlHeadOf(SECRET_KEY),
  };
}

/** A compiled scanner. Its methods are pure, linear in the input for the shipped rules, and never throw. */
export interface SecretScanner {
  /** Blank every secret-shaped string in a text. On an internal error: `SCAN_FAILED_TEXT`. JSON text stays valid JSON. */
  redactSecrets(text: string, opts?: ScanOpts): string;
  /**
   * A tool result with every secret-shaped string blanked: the text of each content item, and
   * every key and string in `structuredContent`. Returns a new object; the input is not changed.
   * On an internal error: an error result that carries no text from the input.
   */
  redactToolResult<T>(result: T, opts?: ScanOpts): T;
  /** Wrap a tool handler: its reply, and a thrown error's message, are scanned. Arguments pass unchanged. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrap<H extends (...args: any[]) => any>(handler: H, opts?: ScanOpts): H;
}

/**
 * A scanner for a config (parsed JSON, or a checked `SecretScanConfig`); absent ⇒ the shipped
 * defaults. Throws `SecretScanConfigError` on a config it refuses, so a bad config can never turn
 * into a scanner that scans less than it says.
 */
export function createSecretScanner(config?: unknown): SecretScanner {
  const R = compile(parseSecretScanConfig(config));
  return {
    redactSecrets: (text, opts = {}) => scanString(R, text, opts),
    redactToolResult: (result, opts = {}) => scanResult(R, result, opts),
    wrap: (handler, opts = {}) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (...args: any[]) => {
        try {
          return scanResult(R, await handler(...args), opts);
        } catch (e) {
          throw redactThrown(R, e);
        }
      }) as unknown as typeof handler,
  };
}

/** The scanner with the shipped defaults. */
export const DEFAULT_SECRET_SCANNER: SecretScanner = createSecretScanner();

/** `DEFAULT_SECRET_SCANNER.redactSecrets`. */
export function redactSecrets(text: string, opts: ScanOpts = {}): string {
  return DEFAULT_SECRET_SCANNER.redactSecrets(text, opts);
}

/** `DEFAULT_SECRET_SCANNER.redactToolResult`. */
export function redactToolResult<T>(result: T, opts: ScanOpts = {}): T {
  return DEFAULT_SECRET_SCANNER.redactToolResult(result, opts);
}

/** `scanner.wrap(handler, opts)`, the shipped defaults when no scanner is given. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function redactingHandler<H extends (...args: any[]) => any>(handler: H, opts: ScanOpts = {}, scanner: SecretScanner = DEFAULT_SECRET_SCANNER): H {
  return scanner.wrap(handler, opts);
}
