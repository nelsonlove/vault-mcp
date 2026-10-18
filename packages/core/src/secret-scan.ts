// secret-scan.ts — blank key- and token-shaped strings in what a connection is sent.
//
// A connection profile may ask for it (`redactSecrets` on ConnProfile, profile.ts). Every tool
// reply on such a connection passes through `redactToolResult` before it leaves the server: the
// text of each content item, and every string in any structured content. Nothing else changes:
// not the tool's arguments, not what a tool writes to disk.
//
// WHAT IT BLANKS. Known key and token shapes (provider prefixes, AWS key ids, JWTs, PEM private
// key blocks), bearer and Authorization header values, the credentials in a URL
// (`scheme://user:pass@host` keeps scheme and host), and the value of a `key: value` or
// `key=value` pair whose key names a secret (password, token, api_key, client_secret and the like;
// any case, quoted or not, in frontmatter, prose, env files or JSON). Each one becomes a fixed
// marker, `[redacted:<kind>]`; no part of the secret is kept.
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
// break (`\n` as two characters, as it appears inside a JSON string in a tool reply). Anchoring
// every prefix pattern at a run start keeps the scan linear: matches cannot start inside one run
// over and over.
const START = String.raw`(?:(?<![A-Za-z0-9_\-])|(?<=\\[nrt]))`;

interface Rule {
  kind: string;
  re: RegExp;
  /** Build the replacement from the match groups; default: the marker for the whole match. */
  replace?: (m: string, ...groups: string[]) => string;
}

const TOKEN_RULES: Rule[] = [
  // PEM private key blocks: a whole block, then any BEGIN header left without an END (a cut read).
  {
    kind: "private-key",
    // The body holds no '-' (base64 and line breaks), so `[^-]` stops at the END line: one split, no backtracking.
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[^-]{0,65536}-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
  },
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:\\[nrt]|[A-Za-z0-9+/=\s:,-])*/g,
  },
  // JSON Web Tokens: three base64url segments, the first a JSON header (`eyJ`).
  { kind: "jwt", re: new RegExp(`${START}eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]*`, "g") },
  // Provider key shapes.
  { kind: "anthropic-key", re: new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{20,}`, "g") },
  { kind: "stripe-key", re: new RegExp(`${START}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}`, "g") },
  { kind: "api-key", re: new RegExp(`${START}sk-[A-Za-z0-9_-]{20,}`, "g") },
  { kind: "github-token", re: new RegExp(`${START}(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`, "g") },
  { kind: "slack-token", re: new RegExp(`${START}xox[abposr]-[A-Za-z0-9-]{10,}`, "g") },
  { kind: "aws-key-id", re: new RegExp(`${START}(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])`, "g") },
  { kind: "google-api-key", re: new RegExp(`${START}AIza[0-9A-Za-z_-]{35}`, "g") },
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
// `GITHUB_TOKEN`, `clientSecret`); it may not be followed by more letters (`tokens`, `secretary`)
// or by `_x` (`token_count`), because the separator must come next.
const SECRET_KEY = String.raw`(?:password|passwd|passphrase|pwd|secret|token|credentials?|api[_-]?key|apikey|(?:access|private|secret|encryption|signing|master)[_-]?key)`;
// The value: double-quoted, JSON-escaped-quoted (`\"…\"` inside a JSON string), single-quoted, or
// bare to the end of the line (a literal or a JSON-escaped line break). Each is bounded.
const VALUE = String.raw`("(?:[^"\\\r\n]|\\.){0,4096}"?|\\"(?:[^"\\]|\\[^"]){0,4096}(?:\\")?|'[^'\\\r\n]{0,4096}'?|(?:\\[^nrt]|[^"\\\r\n]){1,4096})`;
const KEY_VALUE = new RegExp(String.raw`(${SECRET_KEY}(?![A-Za-z0-9])\\?["']?[ \t]{0,16}[:=](?![ \t]{0,16}\[redacted:)[ \t]{0,16})${VALUE}`, "gi");

// Values that carry no secret: booleans, null, and an empty or blank value.
const NOT_A_SECRET = /^(?:true|false|null|none|yes|no|~|\s*)$/i;

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
      if (inner.endsWith(q) && inner.length >= q.length) {
        close = q;
        inner = inner.slice(0, inner.length - q.length);
      }
      break;
    }
  }
  const trimmed = inner.trimEnd();
  if (NOT_A_SECRET.test(trimmed) || trimmed.startsWith("[redacted:")) return head + value;
  const trail = inner.slice(trimmed.length);
  return `${head}${open}${redactionMarker("secret")}${trail}${close}`;
}

/**
 * Blank every secret-shaped string in a text. Pure; linear in the input; never throws (on an
 * internal error it returns `SCAN_FAILED_TEXT`, never the raw text).
 */
export function redactSecrets(text: string): string {
  try {
    if (typeof text !== "string") return SCAN_FAILED_TEXT;
    let out = text;
    for (const rule of TOKEN_RULES) {
      rule.re.lastIndex = 0;
      out = rule.replace
        ? out.replace(rule.re, rule.replace as (m: string, ...g: string[]) => string)
        : out.replace(rule.re, redactionMarker(rule.kind));
    }
    KEY_VALUE.lastIndex = 0;
    out = out.replace(KEY_VALUE, (_m, head: string, value: string) => blankValue(head, value));
    return out;
  } catch {
    return SCAN_FAILED_TEXT;
  }
}

/** Every string in a value, blanked; objects and arrays are copied, other values kept. */
function redactDeep(value: unknown, depth: number): unknown {
  if (depth > 64) return SCAN_FAILED_TEXT;
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, depth + 1);
    return out;
  }
  return value;
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
    if (r.structuredContent !== undefined) out.structuredContent = redactDeep(r.structuredContent, 0);
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
