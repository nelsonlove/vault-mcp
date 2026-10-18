// send-message.ts — `vaultmcp_send_message`: post a short text to an ntfy server.
//
// A general, configured message tool: a connected client sends a short text to a person or an
// agent who reads an ntfy topic (https://docs.ntfy.sh/publish/). It is not a vault write: it
// touches no note, so it takes no `if_rev`. It is OFF unless the operator sets a server URL and a
// topic; with either missing, the tool is not registered at all.
//
// Configuration comes from the operator's own environment (`messageConfigFromEnv`). Nothing here
// names a real server, topic or user: the operator supplies them.
//
// Safety:
//   - The text is 1 to 2,000 characters and at most 4,096 bytes in UTF-8 (ntfy's message limit).
//     A longer text is refused, never cut.
//   - A per-process sliding one-hour window caps sends (default 10 an hour). Over the cap the call
//     is refused with `rate_limited` and the reset time; nothing is sent.
//   - A password or token is read from a file at call time, never logged and never returned. A
//     file that its group or other users can access, a symlink, and a non-ASCII token are refused.
//   - `idempotency_key`: a retry with the same key and the same text returns the first send's
//     result and posts nothing. After a network failure the outcome is unknown, so a retry with the
//     key is refused (`idempotency_unknown`) and posts nothing. The memory is per process and lasts
//     one hour.

import { open, type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { z } from "zod";
import { ok, fail } from "./responses.js";
import { strictInput } from "./strict-input.js";
import { profileAllows, profileCallRefusal, type ConnProfile } from "./profile.js";

export const SEND_MESSAGE_TOOL = "vaultmcp_send_message";

/** The longest text the tool sends, in characters (Unicode code points). */
export const MESSAGE_MAX_CHARS = 2000;
/** The longest text in UTF-8 bytes: ntfy's default message limit (a longer body becomes an attachment or is refused). */
export const MESSAGE_MAX_BYTES = 4096;
/** The longest title, in characters. */
export const MESSAGE_TITLE_MAX_CHARS = 200;
/** Sends per hour when `VAULT_MCP_MESSAGE_RATE` is not set. */
export const MESSAGE_DEFAULT_RATE = 10;

const HOUR_MS = 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 10_000;

/** The environment variables the file-system server reads. */
export const MESSAGE_ENV = Object.freeze({
  url: "VAULT_MCP_MESSAGE_URL",
  topic: "VAULT_MCP_MESSAGE_TOPIC",
  user: "VAULT_MCP_MESSAGE_USER",
  passwordFile: "VAULT_MCP_MESSAGE_PASSWORD_FILE",
  tokenFile: "VAULT_MCP_MESSAGE_TOKEN_FILE",
  tags: "VAULT_MCP_MESSAGE_TAGS",
  rate: "VAULT_MCP_MESSAGE_RATE",
});

export interface MessageConfig {
  /** The ntfy server's base URL, such as `https://ntfy.example.test`. https, or http on localhost only. */
  url: string;
  /** The topic to post to. */
  topic: string;
  /** Basic-auth user; needs `passwordFile`. */
  user?: string;
  /** A file that holds the Basic-auth password. Read at call time. */
  passwordFile?: string;
  /** A file that holds a bearer token. Read at call time. The alternative to user + password. */
  tokenFile?: string;
  /** ntfy tags sent with every message. */
  tags?: string[];
  /** The most sends in any one hour, per process. */
  rate?: number;
}

/**
 * The message config from the environment, or undefined when the URL or the topic is not set
 * (then the tool is not registered). Values are taken as given; `checkMessageConfig` judges them
 * at call time, so a bad value is reported to the caller as `message_config`.
 */
export function messageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MessageConfig | undefined {
  const get = (k: string): string | undefined => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  const url = get(MESSAGE_ENV.url);
  const topic = get(MESSAGE_ENV.topic);
  if (!url || !topic) return undefined;
  const cfg: MessageConfig = { url, topic };
  const user = get(MESSAGE_ENV.user);
  const passwordFile = get(MESSAGE_ENV.passwordFile);
  const tokenFile = get(MESSAGE_ENV.tokenFile);
  const tags = get(MESSAGE_ENV.tags);
  const rate = get(MESSAGE_ENV.rate);
  if (user) cfg.user = user;
  if (passwordFile) cfg.passwordFile = passwordFile;
  if (tokenFile) cfg.tokenFile = tokenFile;
  if (tags) cfg.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
  // A rate that is not a whole number is kept as NaN, so the call reports it rather than using a default.
  if (rate !== undefined) cfg.rate = /^\d+$/.test(rate) ? Number(rate) : Number.NaN;
  return cfg;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
// Header values: printable ASCII only. A non-Latin-1 value would make fetch throw before anything is sent.
const TAG_RE = /^[\x21-\x2b\x2d-\x7e]{1,64}$/;
const TOKEN_RE = /^[\x21-\x7e]+$/;

/** The reason the config cannot be used, or null. Names no secret. */
export function checkMessageConfig(cfg: MessageConfig): string | null {
  let u: URL;
  try {
    u = new URL(cfg.url);
  } catch {
    return `${MESSAGE_ENV.url} is not a URL.`;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return `${MESSAGE_ENV.url} must be https (http is allowed only for localhost).`;
  }
  if (u.username || u.password) return `${MESSAGE_ENV.url} must not carry a user or password; use ${MESSAGE_ENV.user} and ${MESSAGE_ENV.passwordFile}.`;
  if (u.search || u.hash) return `${MESSAGE_ENV.url} must not carry a query or a fragment.`;
  if (!TOPIC_RE.test(cfg.topic)) return `${MESSAGE_ENV.topic} must be 1 to 64 letters, digits, '-' or '_'.`;
  if (cfg.tokenFile && (cfg.user || cfg.passwordFile)) return `Set either ${MESSAGE_ENV.tokenFile} or ${MESSAGE_ENV.user} with ${MESSAGE_ENV.passwordFile}, not both.`;
  if (!!cfg.user !== !!cfg.passwordFile) return `${MESSAGE_ENV.user} and ${MESSAGE_ENV.passwordFile} go together.`;
  if (cfg.user && cfg.user.includes(":")) return `${MESSAGE_ENV.user} must not contain ':'.`;
  for (const t of cfg.tags ?? []) if (!TAG_RE.test(t)) return `${MESSAGE_ENV.tags} holds a tag that is not 1 to 64 printable ASCII characters (no space or comma).`;
  if (cfg.rate !== undefined && !(Number.isInteger(cfg.rate) && cfg.rate >= 1)) return `${MESSAGE_ENV.rate} must be a whole number of 1 or more.`;
  return null;
}

/**
 * Read a secret file: one open with O_NOFOLLOW (a symlink is refused), then stat and read on that
 * one handle, so the file checked is the file read. Refused when its group or other users have any
 * access, or when it is not a regular file. The value is never logged.
 */
async function readSecretFile(path: string, envName: string): Promise<string> {
  const unreadable = () => codedError("message_config", `The file named by ${envName} cannot be read (a symlink is refused). Nothing was sent.`);
  let fh: FileHandle;
  try {
    fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw unreadable();
  }
  let value: string;
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw unreadable();
    if (st.mode & 0o077) {
      throw codedError("message_config", `The file named by ${envName} is open to its group or to other users; set its mode to 600. Nothing was sent.`);
    }
    value = (await fh.readFile("utf8")).replace(/\r?\n$/, "");
  } catch (e) {
    throw (e as { code?: unknown })?.code === "message_config" ? e : unreadable();
  } finally {
    await fh.close().catch(() => {});
  }
  if (!value || /[\r\n\x00]/.test(value)) {
    throw codedError("message_config", `The file named by ${envName} must hold one non-empty line. Nothing was sent.`);
  }
  return value;
}

/** A header-safe title: plain ASCII as is, anything else as an RFC 2047 encoded word (ntfy decodes it). */
function headerTitle(title: string): string {
  return /^[\x20-\x7e]*$/.test(title) ? title : `=?UTF-8?B?${Buffer.from(title, "utf8").toString("base64")}?=`;
}

/** A per-process sliding one-hour window of send times. */
export class SlidingHourLimiter {
  private readonly times: number[] = [];
  /** Take a slot, or return the time (ms) the next slot opens. */
  take(limit: number, now: number): { ok: true } | { ok: false; resetAt: number } {
    while (this.times.length && this.times[0] <= now - HOUR_MS) this.times.shift();
    if (this.times.length >= limit) return { ok: false, resetAt: this.times[0] + HOUR_MS };
    this.times.push(now);
    return { ok: true };
  }
}

export interface SendResult {
  sent: true;
  id?: string;
}

export interface MessageSenderDeps {
  fetch?: typeof fetch;
  now?: () => number;
  limiter?: SlidingHourLimiter;
}

export interface SendArgs {
  text: string;
  title?: string;
  idempotency_key?: string;
}

/** One sender per config and process: its limiter and its key memory are shared by every connection. */
export class MessageSender {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly limiter: SlidingHourLimiter;
  /** Keys of the last hour. `unknown`: the send timed out or lost its connection, so ntfy may have it. */
  private readonly keys = new Map<string, { at: number; text: string; title?: string; result: Promise<SendResult>; unknown?: boolean }>();

  constructor(private readonly cfg: MessageConfig, deps: MessageSenderDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.limiter = deps.limiter ?? new SlidingHourLimiter();
  }

  async send(args: SendArgs): Promise<SendResult> {
    const { text, title, idempotency_key: key } = args;
    this.checkArgs(text, title);
    const now = this.now();
    for (const [k, v] of this.keys) if (v.at <= now - HOUR_MS) this.keys.delete(k);
    if (key === undefined) return this.post(text, title, now);
    const seen = this.keys.get(key);
    if (seen) {
      if (seen.text !== text || seen.title !== title) {
        throw codedError("idempotency_conflict", "This idempotency_key was used for a different message in the last hour. Nothing was sent.");
      }
      if (seen.unknown) {
        throw codedError("idempotency_unknown", "The first send with this idempotency_key may or may not have reached the message server (it was not reached or did not answer in time). Nothing was re-sent. To send again, use a new idempotency_key.");
      }
      // The same send, finished or still in flight: share its result, post nothing.
      return seen.result;
    }
    const result = this.post(text, title, now);
    const entry: { at: number; text: string; title?: string; result: Promise<SendResult>; unknown?: boolean } = { at: now, text, title, result };
    this.keys.set(key, entry);
    result.catch((e: unknown) => {
      if (this.keys.get(key) !== entry) return;
      // After a network failure ntfy may already have the message: keep the key for its hour, marked
      // unknown, so a retry with it never posts twice. Any other failure sent nothing: forget the key.
      if ((e as { code?: unknown })?.code === "message_network") entry.unknown = true;
      else this.keys.delete(key);
    });
    return result;
  }

  private checkArgs(text: unknown, title: unknown): void {
    if (typeof text !== "string" || text.trim() === "") throw codedError("invalid_argument", "text must not be empty. Nothing was sent.");
    const chars = [...text].length;
    if (chars > MESSAGE_MAX_CHARS) {
      throw codedError("text_too_long", `text is ${chars} characters; the most is ${MESSAGE_MAX_CHARS}. It was not cut and nothing was sent.`);
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MESSAGE_MAX_BYTES) {
      throw codedError("text_too_long", `text is ${bytes} bytes in UTF-8; the most is ${MESSAGE_MAX_BYTES}. It was not cut and nothing was sent.`);
    }
    if (title !== undefined) {
      if (typeof title !== "string") throw codedError("invalid_argument", "title must be a string. Nothing was sent.");
      if ([...title].length > MESSAGE_TITLE_MAX_CHARS) throw codedError("title_too_long", `title is longer than ${MESSAGE_TITLE_MAX_CHARS} characters. Nothing was sent.`);
      if (/[\x00-\x1f\x7f]/.test(title)) throw codedError("invalid_argument", "title must be one line with no control characters. Nothing was sent.");
    }
  }

  private async post(text: string, title: string | undefined, now: number): Promise<SendResult> {
    const bad = checkMessageConfig(this.cfg);
    if (bad) throw codedError("message_config", `${bad} Nothing was sent.`);

    // Read the secret before taking a rate slot, so a config fault does not use up the hour.
    const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
    if (this.cfg.tokenFile) {
      const token = await readSecretFile(this.cfg.tokenFile, MESSAGE_ENV.tokenFile);
      if (!TOKEN_RE.test(token)) throw codedError("message_config", `The token in the file named by ${MESSAGE_ENV.tokenFile} must be printable ASCII with no spaces. Nothing was sent.`);
      headers.Authorization = `Bearer ${token}`;
    } else if (this.cfg.user && this.cfg.passwordFile) {
      const pw = await readSecretFile(this.cfg.passwordFile, MESSAGE_ENV.passwordFile);
      headers.Authorization = `Basic ${Buffer.from(`${this.cfg.user}:${pw}`, "utf8").toString("base64")}`;
    }
    if (title !== undefined && title !== "") headers.Title = headerTitle(title);
    if (this.cfg.tags?.length) headers.Tags = this.cfg.tags.join(",");

    const slot = this.limiter.take(this.cfg.rate ?? MESSAGE_DEFAULT_RATE, now);
    if (!slot.ok) {
      throw codedError("rate_limited", `The send limit of ${this.cfg.rate ?? MESSAGE_DEFAULT_RATE} an hour is reached; the next send is allowed at ${new Date(slot.resetAt).toISOString()}. Nothing was sent.`);
    }

    const target = `${this.cfg.url.replace(/\/+$/, "")}/${this.cfg.topic}`;
    let res: Response;
    try {
      res = await this.fetchImpl(target, { method: "POST", headers, body: text, signal: AbortSignal.timeout(SEND_TIMEOUT_MS), redirect: "error" });
    } catch (e) {
      const why = e instanceof Error && e.name === "TimeoutError" ? "it did not answer in time" : "it could not be reached";
      throw codedError("message_network", `The message server was not reached: ${why}. The message may not have been sent.`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw codedError("message_http", `The message server refused the message with HTTP ${res.status}. Nothing was sent.`);
    }
    let id: string | undefined;
    try {
      const body = (await res.json()) as { id?: unknown };
      if (typeof body?.id === "string") id = body.id;
    } catch {
      // A 2xx reply without a JSON id is still a send.
    }
    return id === undefined ? { sent: true } : { sent: true, id };
  }
}

/** The process-wide senders, one per server + topic, so every per-request MCP server shares one limit. */
const SENDERS = new Map<string, MessageSender>();

/** The process's sender for this config (created on first use). */
export function processMessageSender(cfg: MessageConfig): MessageSender {
  const k = JSON.stringify([cfg.url, cfg.topic, cfg.user ?? "", cfg.passwordFile ?? "", cfg.tokenFile ?? "", cfg.tags ?? [], cfg.rate ?? null]);
  let s = SENDERS.get(k);
  if (!s) {
    s = new MessageSender(cfg);
    SENDERS.set(k, s);
  }
  return s;
}

export const SEND_MESSAGE_INPUT = {
  text: z.string().describe(`The message text, 1 to ${MESSAGE_MAX_CHARS} characters and at most ${MESSAGE_MAX_BYTES} bytes in UTF-8. A longer text is refused, never cut.`),
  title: z.string().optional().describe(`An optional title, at most ${MESSAGE_TITLE_MAX_CHARS} characters, one line.`),
  idempotency_key: z.string().min(1).max(200).optional().describe("A retry-safety key. A retry with the same key and text within an hour returns the first result and sends nothing. If the first send's outcome is unknown (a network failure), a retry with the key is refused (idempotency_unknown); use a new key to send again."),
};

// A flat literal (no Object.freeze) so the host's surface scanner can read its readOnlyHint.
export const SEND_MESSAGE_ANNOTATIONS = {
  title: "Send a message",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolRegistrar = { registerTool(name: string, meta: any, handler: (args: any) => any): any };

/**
 * Register `vaultmcp_send_message` when `cfg` is set and the profile (if any) offers it. Returns
 * whether it was registered. `sender` is for tests; the default is the process-wide one.
 */
export function registerSendMessageTool(
  server: ToolRegistrar,
  cfg: MessageConfig | undefined,
  opts: { profile?: ConnProfile; sender?: MessageSender } = {},
): boolean {
  if (!cfg) return false;
  if (opts.profile && !profileAllows(opts.profile, SEND_MESSAGE_TOOL)) return false;
  const sender = opts.sender ?? processMessageSender(cfg);
  const profile = opts.profile;
  server.registerTool(
    SEND_MESSAGE_TOOL,
    {
      title: SEND_MESSAGE_ANNOTATIONS.title,
      description:
        `Send a short text message to the operator's configured ntfy topic. Not a vault write: no note changes. ` +
        `text is 1 to ${MESSAGE_MAX_CHARS} characters and at most ${MESSAGE_MAX_BYTES} UTF-8 bytes (longer is refused, never cut); title is optional. ` +
        `Sends are limited per hour (Error [rate_limited] names the reset time). Returns {sent: true, id}.`,
      inputSchema: strictInput(SEND_MESSAGE_INPUT),
      annotations: SEND_MESSAGE_ANNOTATIONS,
    },
    async (args: SendArgs) => {
      if (profile) {
        // Not a vault write: no profile write scope applies, only the profile's tool list.
        const refused = profileCallRefusal(profile, SEND_MESSAGE_TOOL, false, {}, () => true);
        if (refused) return fail(codedError(refused.code, refused.message));
      }
      try {
        return ok(await sender.send(args));
      } catch (e) {
        return fail(e);
      }
    },
  );
  return true;
}
