// secret-scan.ts — blank key- and token-shaped strings in what a connection is sent.
//
// A connection profile may ask for it (`redactSecrets` on ConnProfile, profile.ts). Every tool
// reply on such a connection passes through `redactToolResult` before it leaves the server: the
// text of each content item, and every string in any structured content. Nothing else changes:
// not the tool's arguments, not what a tool writes to disk.
//
// WHAT IT BLANKS. Known key and token shapes (provider prefixes, AWS key ids, JWTs, PEM and PGP
// private key blocks), bearer and Authorization header values, the credentials in a URL
// (`scheme://user:pass@host` keeps scheme and host), and the value under a key that names a
// secret (password, pass, token, api_key, client_secret and the like; any case). In text such a
// value is found after `:`, `=` or `=>` (quoted or not, the key bold or in backticks), in a
// markdown table row, in a YAML block or list below the key, and in an XML element. Each one
// becomes a fixed marker, `[redacted:<kind>]`; no part of the secret is kept.
//
// JSON AND STRUCTURED CONTENT. Text that parses as JSON (most tool replies) is parsed, scanned
// key-aware and written back in the same layout, so it still parses: the whole value under a
// secret-named key is blanked whatever its type, and every other string is scanned as text.
// Structured content is scanned the same way. Booleans, null and empty values are kept.
//
// WHAT IT NEVER BLANKS ON ITS OWN. A long or random-looking string is not enough: uids, uuids,
// hashes and commit shas pass unchanged. Only a shape or a key name triggers a blank.
//
// SAFETY. Every pattern is bounded or anchored so the scan is linear in its input (no nested
// unbounded quantifiers). The scanner never throws: on any internal error it blanks the whole
// text (fail closed) rather than return it raw.
//
// LIMITS. This is a best-effort filter. A secret in a form it does not know (a bare password in
// prose, a key split over lines, an encoding) passes through.

/** The marker a blanked string becomes. */
export function redactionMarker(kind: string): string {
  return `[redacted:${kind}]`;
}

/** The text that replaces a whole text when the scan itself failed (fail closed). */
export const SCAN_FAILED_TEXT = redactionMarker("scan-failed");

// A token starts at the start of a run of token characters, or right after a JSON-escaped line
// break (`\n` as two characters, as it appears inside a JSON string). Anchoring every prefix
// pattern at a run start keeps the scan linear: matches cannot start inside one run over and over.
const START = String.raw`(?:(?<![A-Za-z0-9_\-])|(?<=\\[nrt]))`;

interface Rule {
  kind: string;
  re: RegExp;
  /** Build the replacement from the match groups; default: the marker for the whole match. */
  replace?: (m: string, ...groups: string[]) => string;
}

const tokenRule = (kind: string, body: string, flags = "g"): Rule => ({ kind, re: new RegExp(`${START}${body}`, flags) });

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
    re: /(authorization\\?["']?[ \t]{0,16}[:=][ \t]{0,16}\\?["']?)((?:bearer|basic|token|digest)[ \t]+)?(?!\[redacted:)(?:\\[^nrt"]|[^\s"'\\]){4,4096}/gi,
    replace: (_m, head: string, scheme: string | undefined) => `${head}${scheme ?? ""}${redactionMarker("authorization")}`,
  },
  // A bearer token anywhere else. It must hold a digit, so prose ("Bearer authentication") passes.
  {
    kind: "bearer-token",
    re: /((?:(?<![A-Za-z0-9])|(?<=\\[nrt]))bearer[ \t]+)(?!\[redacted:)(?=[A-Za-z._~+/=-]{0,512}[0-9])[A-Za-z0-9._~+/=-]{12,4096}/gi,
    replace: (_m, head: string) => `${head}${redactionMarker("bearer-token")}`,
  },
  // Credentials in a URL: keep the scheme and the host, blank `user:pass`.
  {
    kind: "url-credentials",
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:"'\\]{1,256}:[^\s/"'\\]{1,256}@/gi,
    replace: (_m, scheme: string) => `${scheme}${redactionMarker("url-credentials")}@`,
  },
];

// A key that names a secret. It may sit at the end of a longer name (`db_password`,
// `GITHUB_TOKEN`, `clientSecret`); in text it may not be followed by more letters (`tokens`,
// `secretary`) or by `_x` (`token_count`), because a separator must come next. `pass` alone needs
// a boundary before it too, so `bypass` and `compass` are not keys.
const SECRET_KEY = String.raw`(?:password|passwd|passphrase|(?<![A-Za-z0-9])pass|pwd|secret|token|credentials?|api[_-]?key|apikey|(?:access|private|secret|encryption|signing|master)[_-]?key)`;
// Markup that may wrap a key: `**password**:`, `__password__:`, `` `password`: ``.
const WRAP = String.raw`(?:\*\*|__|\x60)?`;
// The separators: `:`, `=` and `=>`.
const SEP = String.raw`(?:=>|[:=])`;
// The value: double-quoted (with escapes), JSON-escaped-quoted (`\"…\"` inside a JSON string, its
// inner escapes included), single-quoted (never past a `"`, so it cannot eat a JSON string's
// end), or bare to the end of the line (a literal or a JSON-escaped line break). Each is bounded.
const VALUE = String.raw`("(?:[^"\\\r\n]|\\.){0,4096}"?|\\"(?:[^"\\]|\\\\\\"|\\\\|\\[^"\\]){0,4096}(?:\\")?|'[^'"\\\r\n]{0,4096}'?|(?:\\[^nrt]|[^"\\\r\n]){1,4096})`;
const KEY_VALUE = new RegExp(String.raw`(${SECRET_KEY}(?![A-Za-z0-9])${WRAP}\\?["']?[ \t]{0,16}${SEP}(?![ \t]{0,16}\[redacted:)[ \t]{0,16})${VALUE}`, "gi");
// A markdown table row whose key cell names a secret: `| password | x |` blanks the next cell.
const TABLE_ROW = new RegExp(String.raw`(\|[ \t]*${WRAP}[^|\r\n]{0,64}?${SECRET_KEY}(?![A-Za-z0-9])${WRAP}[ \t]*\|)([^|\r\n]{1,4096})(?=\||[\r\n]|$)`, "gi");
// A YAML key that names a secret with its value on the lines below: a block scalar (`password: |`)
// or a list or map. The indented lines (or `- ` items at the same indent) become one marker.
const YAML_BLOCK = new RegExp(
  String.raw`^([ \t]*)([^\r\n:]{0,64}?${SECRET_KEY}(?![A-Za-z0-9])["']?[ \t]*:)[ \t]*(?:[|>][+-]?[0-9]?[ \t]*)?(?:#[^\r\n]*)?\r?\n((?:\1(?:[ \t]+|- )[^\r\n]*(?:\r?\n|$))+)`,
  "gim"
);
// An XML element that names a secret: `<password>x</password>`.
const XML_ELEMENT = new RegExp(String.raw`(<[A-Za-z0-9_.:-]{0,64}?${SECRET_KEY}(?![A-Za-z0-9])(?:\s[^<>]{0,256})?>)([^<]{1,4096})`, "gi");

// An object key that names a secret (in parsed JSON or structured content): the same names,
// ending the key. `authorization` too, since a header object carries it.
const SECRET_KEY_NAME = new RegExp(String.raw`(?:${SECRET_KEY}|authorization)$`, "i");
const CAMEL_PASS = /[a-z0-9]Pass$/;

// Values that carry no secret: booleans, null, and an empty or blank value.
const NOT_A_SECRET = /^(?:true|false|null|none|yes|no|~|\s*)$/i;

const isRedacted = (s: string): boolean => s.startsWith("[redacted:");

function blankValue(head: string, value: string): string {
  // Leading blanks belong to the head, so a quote right after them is still seen as a quote.
  const lead = value.length - value.trimStart().length;
  if (lead > 0) {
    head += value.slice(0, lead);
    value = value.slice(lead);
  }
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
  if (NOT_A_SECRET.test(trimmed) || isRedacted(trimmed)) return head + value;
  const trail = inner.slice(trimmed.length);
  return `${head}${open}${redactionMarker("secret")}${trail}${close}`;
}

function blankCell(head: string, cell: string): string {
  const t = cell.trim();
  if (NOT_A_SECRET.test(t) || isRedacted(t)) return head + cell;
  const lead = cell.slice(0, cell.length - cell.trimStart().length);
  const trail = cell.slice(cell.trimEnd().length);
  return `${head}${lead}${redactionMarker("secret")}${trail}`;
}

/** The regex rules, for text that is not JSON. */
function scanPlain(text: string): string {
  let out = text;
  for (const rule of TOKEN_RULES) {
    rule.re.lastIndex = 0;
    out = rule.replace
      ? out.replace(rule.re, rule.replace as (m: string, ...g: string[]) => string)
      : out.replace(rule.re, redactionMarker(rule.kind));
  }
  out = out.replace(YAML_BLOCK, (_m, indent: string, head: string, block: string) => `${indent}${head} ${redactionMarker("secret")}${/\r?\n$/.exec(block)?.[0] ?? ""}`);
  out = out.replace(TABLE_ROW, (_m, head: string, cell: string) => blankCell(head, cell));
  out = out.replace(XML_ELEMENT, (_m, head: string, body: string) => blankCell(head, body));
  out = out.replace(KEY_VALUE, (_m, head: string, value: string) => blankValue(head, value));
  return out;
}

interface Ctx {
  changed: boolean;
}

function isSecretKeyName(k: string): boolean {
  return SECRET_KEY_NAME.test(k) || CAMEL_PASS.test(k);
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

/**
 * A value with every secret blanked, key-aware: the whole value under a secret-named key becomes
 * the marker, whatever its type (booleans, null and empties are kept); every other string is
 * scanned as text. Plain objects and arrays are copied; other objects (Date, Map, class
 * instances) are kept as they are.
 */
function scanValue(v: unknown, depth: number, ctx: Ctx): unknown {
  if (depth > 64) {
    ctx.changed = true;
    return SCAN_FAILED_TEXT;
  }
  if (typeof v === "string") {
    const s = scanText(v, depth + 1);
    if (s !== v) ctx.changed = true;
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => scanValue(x, depth + 1, ctx));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = Object.getPrototypeOf(v) === null ? Object.create(null) : {};
    for (const [k, x] of Object.entries(v)) {
      if (isSecretKeyName(k) && blankable(x)) {
        out[k] = redactionMarker("secret");
        ctx.changed = true;
      } else out[k] = scanValue(x, depth + 1, ctx);
    }
    return out;
  }
  return v;
}

/**
 * Text that is JSON (an object or array, as most tool replies are) is parsed, scanned key-aware,
 * and written back in the same layout, so it still parses; when nothing changed the text is
 * returned as it was. Any other text gets the regex rules.
 */
function scanText(text: string, depth: number): string {
  if (depth <= 64 && /^\s*[{[]/.test(text)) {
    let parsed: unknown;
    let ok = false;
    try {
      parsed = JSON.parse(text);
      ok = true;
    } catch {
      /* not JSON: the regex rules below */
    }
    if (ok) {
      const ctx: Ctx = { changed: false };
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
export function redactSecrets(text: string): string {
  try {
    if (typeof text !== "string") return SCAN_FAILED_TEXT;
    return scanText(text, 0);
  } catch {
    return SCAN_FAILED_TEXT;
  }
}

/** A content item with its text blanked. Binary items (image, audio data) are left as they are. */
function redactContentItem(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const it = item as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...it };
  if (typeof it.text === "string") copy.text = redactSecrets(it.text);
  if (it.type === "resource" && it.resource && typeof it.resource === "object") {
    const res = { ...(it.resource as Record<string, unknown>) };
    if (typeof res.text === "string") res.text = redactSecrets(res.text);
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
 * every string in `structuredContent`. Returns a new object; the input is not changed. Never
 * throws: on an internal error it returns an error result that carries no text from the input.
 */
export function redactToolResult<T>(result: T): T {
  try {
    if (!result || typeof result !== "object") return (typeof result === "string" ? redactSecrets(result) : result) as T;
    const r = result as Record<string, unknown>;
    const out: Record<string, unknown> = { ...r };
    if (Array.isArray(r.content)) out.content = r.content.map(redactContentItem);
    if (r.structuredContent !== undefined) out.structuredContent = scanValue(r.structuredContent, 0, { changed: false });
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

/**
 * Wrap a tool handler so its reply passes through `redactToolResult`, and a thrown error's
 * message through `redactSecrets`. The arguments reach the handler unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function redactingHandler<H extends (...args: any[]) => any>(handler: H): H {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (...args: any[]) => {
    try {
      return redactToolResult(await handler(...args));
    } catch (e) {
      throw redactThrown(e);
    }
  }) as unknown as H;
}
