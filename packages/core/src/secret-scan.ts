// secret-scan.ts — blank key- and token-shaped strings in what a connection is sent.
//
// A connection profile may ask for it (`redactSecrets` on ConnProfile, profile.ts). Every tool
// reply on such a connection passes through `redactToolResult` before it leaves the server: the
// text of each content item, and every key and string in any structured content. Nothing else
// changes: not the tool's arguments, not what a tool writes to disk.
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
// SEARCH SNIPPETS. A search hit carries one line, often without its key. Under `snippets` (the
// wrapper of obsidian_search_notes) a snippet that looks like a secret body is blanked as well: a
// line of only base64 or hex (a PEM or PGP body line), or an indented one-token value.
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

const TOKEN_RULES: Rule[] = [
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
  // Provider key shapes.
  tokenRule("anthropic-key", String.raw`sk-ant-[A-Za-z0-9_-]{20,}`),
  tokenRule("stripe-key", String.raw`(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}`),
  tokenRule("api-key", String.raw`sk-[A-Za-z0-9_-]{20,}`),
  tokenRule("github-token", String.raw`(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`),
  tokenRule("gitlab-token", String.raw`glpat-[A-Za-z0-9_-]{20,}`),
  tokenRule("slack-token", String.raw`(?:xox[abposre]-[A-Za-z0-9-]{10,}|xapp-[0-9]+-[A-Za-z0-9-]{10,})`),
  tokenRule("huggingface-token", String.raw`hf_[A-Za-z0-9]{30,}`),
  tokenRule("npm-token", String.raw`npm_[A-Za-z0-9]{36,}`),
  tokenRule("tailscale-key", String.raw`tskey-[A-Za-z0-9-]{10,}`),
  tokenRule("sendgrid-key", String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`),
  tokenRule("aws-key-id", String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])`),
  tokenRule("google-api-key", String.raw`AIza[0-9A-Za-z_-]{35}`),
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

function scanTokens(text: string): string {
  let out = text;
  for (const rule of TOKEN_RULES) {
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
const SECRET_WORDS = String.raw`(?:password|passwd|passphrase|pass${J}code|(?<![A-Za-z0-9])pass|(?<![A-Za-z0-9])pw|pwd|secret|token|cookie|credentials?|api${J}key|apikey|(?:access|private|secret|encryption|signing|master|session|client)${J}key)`;
// A key may end in a form word: `privateKeyPem`, `api_key_value`.
const SECRET_KEY = String.raw`${SECRET_WORDS}(?:${J}(?:pem|value|b64|base64))?`;

// An object key (or a table header cell) that names a secret: the name ends the key.
// `authorization` too, since a header object carries it; camelCase `dbPass` and `dbPw` as well.
const SECRET_KEY_NAME = new RegExp(String.raw`(?:${SECRET_KEY}|authorization)$`, "i");
const CAMEL_PASS = /[a-z0-9](?:Pass|Pw)$/;

function isSecretKeyName(k: string): boolean {
  return k.length <= 256 && (SECRET_KEY_NAME.test(k) || CAMEL_PASS.test(k));
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
const HEAD = String.raw`(${SECRET_KEY}(?![A-Za-z0-9])${WRAP}\\?["']?${SEP}${WRAP}(?![ \t]*\[redacted:)[ \t]*)`;
// The value, in text with real line breaks: a bracket (blanked to its match, below),
// double-quoted (with escapes), single-quoted (never past a `"`), or bare to the end of the line.
// No value is capped, so no tail leaks; none has a backtracking path.
const KV_PLAIN = new RegExp(String.raw`${HEAD}(?:([\[{])|("(?:[^"\\\r\n]|\\.)*"?|'[^'"\\\r\n]*'?|[^\r\n]+))`, "gi");
// The same in JSON-escaped text (no real line breaks, `\n` as two characters): a value may be
// `\"…\"`, and a bare value stops at an escaped line break or a `"` (the end of the JSON string).
const KV_ESCAPED = new RegExp(
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
    if (!escaped && (c === '"' || c === "'")) {
      // Skip a quoted string; an unclosed one runs to the end of its line.
      j++;
      while (j < end && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
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
function replaceKeyValues(text: string, escaped: boolean): string {
  const re = escaped ? KV_ESCAPED : KV_PLAIN;
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
const XML_ELEMENT = new RegExp(String.raw`(<[A-Za-z0-9_.:-]{0,64}?${SECRET_KEY}(?![A-Za-z0-9])(?:\s[^<>]{0,256})?>)([^<]+)`, "gi");
// An HTML input that names a secret: `name="password" … value="x"`.
const HTML_PAIR = new RegExp(
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

const TABLE_ROW = /^[ \t]*\|/;
const TABLE_SEP = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*\r?$/;
// A YAML key that names a secret, with its value on the lines below (nothing after the colon but
// a block indicator or a comment). Run on one line at a time, anchored at its start.
const YAML_HEAD = new RegExp(String.raw`^([ \t]*)((?:- )?[^:\r\n]{0,64}?${SECRET_KEY}(?![A-Za-z0-9])${WRAP}["']?[ \t]*:)[ \t]*(?:[|>][+-]?[0-9]?[ \t]*)?(?:#.*)?\r?$`, "i");

const indentOf = (line: string): number => line.length - line.trimStart().length;
const cellText = (c: string): string => c.trim().replace(/^[*_`]+|[*_`]+$/g, "").trim();

/**
 * One pass over the lines. A YAML key that names a secret has its block or list below collapsed
 * into one marker. In a markdown table, a cell that names a secret blanks the cell after it, and a
 * header cell that names a secret blanks its column in every body row to the end of the table.
 */
function scanLines(text: string): string {
  if (!text.includes("\n") && !text.includes("|")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let secretCols: Set<number> | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A YAML block or list under a secret key. Only lines that hold a colon are tried, and only
    // up to a length, so the anchored pattern stays cheap.
    const y = line.length <= 512 && line.includes(":") ? YAML_HEAD.exec(line) : null;
    if (y) {
      const indent = y[1].length;
      const headIsItem = /^[ \t]*- /.test(line);
      let j = i + 1;
      let lastIn = -1;
      while (j < lines.length) {
        const l = lines[j];
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
        out.push(`${y[1]}${y[2]} ${SECRET_MARK}${line.endsWith("\r") ? "\r" : ""}`);
        i = lastIn;
        secretCols = null;
        continue;
      }
    }
    if (TABLE_ROW.test(line)) {
      if (TABLE_SEP.test(line) && line.includes("-")) {
        out.push(line);
        continue;
      }
      const parts = line.split("|");
      const first = 1; // the text before the first pipe is indentation
      const lastEx = parts.length > 2 && parts[parts.length - 1].trim() === "" ? parts.length - 1 : parts.length;
      const next = lines[i + 1];
      if (next !== undefined && TABLE_SEP.test(next) && next.includes("-")) {
        // A header row: remember the columns that name a secret.
        secretCols = new Set();
        for (let k = first; k < lastEx; k++) if (isSecretKeyName(cellText(parts[k]))) secretCols.add(k - first);
        out.push(line);
        continue;
      }
      let changed = false;
      for (let k = first; k < lastEx; k++) {
        const blankThis = (secretCols?.has(k - first) ?? false) || (k > first && isSecretKeyName(cellText(parts[k - 1])));
        if (blankThis) {
          const b = blankCell(parts[k]);
          if (b !== parts[k]) {
            parts[k] = b;
            changed = true;
          }
        }
      }
      out.push(changed ? parts.join("|") : line);
      continue;
    }
    secretCols = null;
    out.push(line);
  }
  return out.join("\n");
}

/** The text rules, for text that is not JSON. */
function scanPlain(text: string): string {
  // JSON-escaped text: no real line break, and `\n` or `\"` as two characters.
  const escaped = !/[\r\n]/.test(text) && /\\[nrt"]/.test(text);
  let out = scanTokens(text);
  out = out.replace(HTML_PAIR, (_m, head: string, value: string) => head + blankValue(value));
  out = out.replace(XML_ELEMENT, (_m, head: string, body: string) => head + blankCell(body));
  if (!escaped) out = scanLines(out);
  return replaceKeyValues(out, escaped);
}

// ── search snippets ─────────────────────────────────────────────────────────

const BASE64_LINE = /^[A-Za-z0-9+/]{24,}={0,2}$/;
const HEX_LINE = /^[0-9a-fA-F]{24,}$/;
// An indented one-token value (a YAML list item or scalar under a key out of view): six or more
// characters, holding a digit or a symbol, and not a link, tag, path or URL.
const ONE_TOKEN = /^[ \t]+(?:- )?(\S{6,})[ \t]*$/;

/** A search snippet with a secret body line blanked, even when its key is out of view. */
function scanSnippet(s: string): string {
  const t = s.trim();
  if (t.length <= 8192 && ((BASE64_LINE.test(t) && /[0-9+/=]/.test(t)) || HEX_LINE.test(t))) return s.slice(0, indentOf(s)) + SECRET_MARK;
  const one = s.length <= 512 ? ONE_TOKEN.exec(s) : null;
  if (one) {
    const tok = one[1];
    if (/[^A-Za-z]/.test(tok) && !/^(?:\[\[|#|!|`|https?:)/.test(tok) && !tok.includes("/") && !isRedacted(tok)) {
      return s.slice(0, s.indexOf(tok)) + SECRET_MARK;
    }
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
function scanValue(v: unknown, depth: number, ctx: Ctx): unknown {
  if (depth > 64) {
    ctx.changed = true;
    return SCAN_FAILED_TEXT;
  }
  if (typeof v === "string") {
    const s = scanText(v, depth + 1, ctx.snippets);
    if (s !== v) ctx.changed = true;
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => scanValue(x, depth + 1, ctx));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = Object.getPrototypeOf(v) === null ? Object.create(null) : {};
    for (const [k, x] of Object.entries(v)) {
      let key = scanTokens(k);
      if (key !== k) {
        ctx.changed = true;
        let n = 2;
        const base = key;
        while (Object.prototype.hasOwnProperty.call(out, key)) key = `${base}#${n++}`;
      }
      if (isSecretKeyName(k) && blankable(x)) {
        put(out, key, SECRET_MARK);
        ctx.changed = true;
      } else if (ctx.snippets && k === "snippet" && typeof x === "string") {
        const s = scanText(scanSnippet(x), depth + 1, true);
        if (s !== x) ctx.changed = true;
        put(out, key, s);
      } else put(out, key, scanValue(x, depth + 1, ctx));
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
function scanText(text: string, depth: number, snippets: boolean): string {
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
      const out = scanValue(parsed, depth + 1, ctx);
      if (!ctx.changed) return text;
      const body = text.trim();
      const indent = /^[{[]\r?\n([ \t]+)/.exec(body)?.[1];
      const lead = text.slice(0, text.length - text.trimStart().length);
      const trail = text.slice(text.trimEnd().length);
      return lead + JSON.stringify(out, null, indent) + trail;
    }
  }
  return scanPlain(text);
}

/**
 * Blank every secret-shaped string in a text. Pure; linear in the input; never throws (on an
 * internal error it returns `SCAN_FAILED_TEXT`, never the raw text). JSON text stays valid JSON.
 */
export function redactSecrets(text: string, opts: ScanOpts = {}): string {
  try {
    if (typeof text !== "string") return SCAN_FAILED_TEXT;
    return scanText(text, 0, opts.snippets === true);
  } catch {
    return SCAN_FAILED_TEXT;
  }
}

/** A content item with its text blanked. Binary items (image, audio data) are left as they are. */
function redactContentItem(item: unknown, opts: ScanOpts): unknown {
  if (!item || typeof item !== "object") return item;
  const it = item as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...it };
  if (typeof it.text === "string") copy.text = redactSecrets(it.text, opts);
  if (it.type === "resource" && it.resource && typeof it.resource === "object") {
    const res = { ...(it.resource as Record<string, unknown>) };
    if (typeof res.text === "string") res.text = redactSecrets(res.text, opts);
    if (typeof res.uri === "string") res.uri = redactSecrets(res.uri);
    copy.resource = res;
  }
  if (it.type === "resource_link") {
    for (const k of ["uri", "name", "title", "description"]) if (typeof it[k] === "string") copy[k] = redactSecrets(it[k] as string);
  }
  return copy;
}

/**
 * A tool result with every secret-shaped string blanked: the text of each content item, and
 * every key and string in `structuredContent`. Returns a new object; the input is not changed.
 * Never throws: on an internal error it returns an error result that carries no text from the input.
 */
export function redactToolResult<T>(result: T, opts: ScanOpts = {}): T {
  try {
    if (!result || typeof result !== "object") return (typeof result === "string" ? redactSecrets(result, opts) : result) as T;
    const r = result as Record<string, unknown>;
    const out: Record<string, unknown> = { ...r };
    if (Array.isArray(r.content)) out.content = r.content.map((c) => redactContentItem(c, opts));
    if (r.structuredContent !== undefined) out.structuredContent = scanValue(r.structuredContent, 0, { changed: false, snippets: opts.snippets === true });
    return out as T;
  } catch {
    return { content: [{ type: "text", text: SCAN_FAILED_TEXT }], isError: true } as unknown as T;
  }
}

/** A thrown error with its message blanked (the SDK turns a thrown error's message into the reply). */
function redactThrown(e: unknown): unknown {
  try {
    if (e instanceof Error) {
      e.message = redactSecrets(e.message);
      return e;
    }
    return typeof e === "string" ? redactSecrets(e) : e;
  } catch {
    return new Error(SCAN_FAILED_TEXT);
  }
}

/** The tools whose replies are search hits, scanned with `snippets`. */
export const SNIPPET_TOOLS: ReadonlySet<string> = new Set(["obsidian_search_notes"]);

/**
 * Wrap a tool handler so its reply passes through `redactToolResult`, and a thrown error's
 * message through `redactSecrets`. The arguments reach the handler unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function redactingHandler<H extends (...args: any[]) => any>(handler: H, opts: ScanOpts = {}): H {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (...args: any[]) => {
    try {
      return redactToolResult(await handler(...args), opts);
    } catch (e) {
      throw redactThrown(e);
    }
  }) as unknown as H;
}
