// vaultmcp_send_message (send-message.ts): a fake ntfy server on localhost; no network.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MessageSender,
  SlidingHourLimiter,
  messageConfigFromEnv,
  checkMessageConfig,
  registerSendMessageTool,
  SEND_MESSAGE_TOOL,
} from "../src/send-message.ts";
import { registerFsTools } from "../src/register-fs-tools.ts";
import { resolveProfile } from "../src/profile.ts";

// ── fake ntfy ──────────────────────────────────────────────────────────────────
const seen = [];
let reply = { status: 200, body: JSON.stringify({ id: "msg123", event: "message" }) };
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(reply.body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const dir = mkdtempSync(join(tmpdir(), "send-message-test-"));
function secret(name, value, mode) {
  const p = join(dir, name);
  writeFileSync(p, value);
  chmodSync(p, mode);
  return p;
}
function reset(status = 200, body = JSON.stringify({ id: "msg123" })) {
  seen.length = 0;
  reply = { status, body };
}
const cfg = (extra = {}) => ({ url: base, topic: "inbox", ...extra });
const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return "no error";
};

// ── sending ────────────────────────────────────────────────────────────────────
describe("MessageSender", () => {
  test("posts the text to <url>/<topic> and returns the ntfy id", async () => {
    reset();
    const s = new MessageSender(cfg());
    const r = await s.send({ text: "hello there" });
    assert.deepEqual(r, { sent: true, id: "msg123" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/inbox");
    assert.equal(seen[0].body, "hello there");
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(seen[0].headers.title, undefined);
    assert.equal(seen[0].headers.tags, undefined);
  });

  test("a 2xx reply without an id is still a send", async () => {
    reset(200, "not json");
    assert.deepEqual(await new MessageSender(cfg()).send({ text: "x" }), { sent: true });
  });

  test("Basic auth: user + password file, the header is base64(user:password)", async () => {
    reset();
    const pw = secret("pw-basic", "s3cret-test\n", 0o600);
    await new MessageSender(cfg({ user: "assistant", passwordFile: pw })).send({ text: "hi" });
    assert.equal(seen[0].headers.authorization, `Basic ${Buffer.from("assistant:s3cret-test").toString("base64")}`);
  });

  test("Bearer auth from a token file", async () => {
    reset();
    const tk = secret("tk-bearer", "tk_testtoken\n", 0o600);
    await new MessageSender(cfg({ tokenFile: tk })).send({ text: "hi" });
    assert.equal(seen[0].headers.authorization, "Bearer tk_testtoken");
  });

  test("title and tags become the Title and Tags headers; a non-ASCII title is RFC 2047 encoded", async () => {
    reset();
    const s = new MessageSender(cfg({ tags: ["robot", "inbox"] }));
    await s.send({ text: "body", title: "A plain title" });
    assert.equal(seen[0].headers.title, "A plain title");
    assert.equal(seen[0].headers.tags, "robot,inbox");
    await s.send({ text: "body", title: "Café" });
    assert.equal(seen[1].headers.title, `=?UTF-8?B?${Buffer.from("Café").toString("base64")}?=`);
  });

  test("a text over 2,000 characters is refused, not cut, and nothing is sent", async () => {
    reset();
    const s = new MessageSender(cfg());
    assert.equal(await codeOf(s.send({ text: "a".repeat(2001) })), "text_too_long");
    // Characters are code points, and the UTF-8 body is capped at 4,096 bytes (ntfy's limit).
    assert.equal(await codeOf(s.send({ text: "😀".repeat(2000) })), "text_too_long", "2,000 emoji are 8,000 bytes");
    assert.equal(await codeOf(s.send({ text: "漢".repeat(1400) })), "text_too_long", "1,400 CJK are 4,200 bytes");
    assert.deepEqual(await s.send({ text: "😀".repeat(1024) }), { sent: true, id: "msg123" }, "4,096 bytes pass");
    assert.equal(Buffer.byteLength(seen[0].body), 4096);
    assert.equal(seen.length, 1);
    assert.equal(await codeOf(s.send({ text: "x", title: "t".repeat(201) })), "title_too_long");
    assert.equal(await codeOf(s.send({ text: "x", title: "two\nlines" })), "invalid_argument");
    assert.equal(await codeOf(s.send({ text: "   " })), "invalid_argument");
    assert.equal(seen.length, 1);
  });

  test("a non-2xx reply is message_http with the status and no credentials", async () => {
    reset(401, JSON.stringify({ error: "unauthorized" }));
    const pw = secret("pw-401", "do-not-leak", 0o600);
    const s = new MessageSender(cfg({ user: "assistant", passwordFile: pw }));
    await assert.rejects(s.send({ text: "x" }), (e) => {
      assert.equal(e.code, "message_http");
      assert.match(e.message, /401/);
      assert.doesNotMatch(e.message, /do-not-leak|assistant/);
      return true;
    });
  });

  test("a network failure is message_network", async () => {
    const s = new MessageSender(cfg(), { fetch: async () => { throw new TypeError("fetch failed"); } });
    assert.equal(await codeOf(s.send({ text: "x" })), "message_network");
  });

  test("a password or token file open to group or others is refused and nothing is sent", async () => {
    reset();
    for (const mode of [0o640, 0o604, 0o660]) {
      const pw = secret(`pw-${mode.toString(8)}`, "pw", mode);
      const e = await new MessageSender(cfg({ user: "assistant", passwordFile: pw })).send({ text: "x" }).catch((x) => x);
      assert.equal(e.code, "message_config");
      assert.doesNotMatch(e.message, /pw-6/, "the message names the env var, not the path");
    }
    const tk = secret("tk-644", "tk", 0o644);
    assert.equal(await codeOf(new MessageSender(cfg({ tokenFile: tk })).send({ text: "x" })), "message_config");
    assert.equal(await codeOf(new MessageSender(cfg({ tokenFile: join(dir, "missing") })).send({ text: "x" })), "message_config");
    assert.equal(seen.length, 0);
  });

  test("a symlinked secret file is refused, even to a 600 file", async () => {
    reset();
    const real = secret("pw-real", "pw", 0o600);
    const link = join(dir, "pw-link");
    symlinkSync(real, link);
    assert.equal(await codeOf(new MessageSender(cfg({ user: "assistant", passwordFile: link })).send({ text: "x" })), "message_config");
    assert.equal(seen.length, 0);
  });

  test("a non-ASCII tag or token is message_config before a rate slot is taken", async () => {
    reset();
    const limiter = new SlidingHourLimiter();
    const deps = { limiter, now: () => 5_000 };
    assert.equal(await codeOf(new MessageSender(cfg({ tags: ["café"], rate: 1 }), deps).send({ text: "x" })), "message_config");
    assert.equal(await codeOf(new MessageSender(cfg({ tags: ["标签"], rate: 1 }), deps).send({ text: "x" })), "message_config");
    const tk = secret("tk-nonascii", "tök€n\n", 0o600);
    assert.equal(await codeOf(new MessageSender(cfg({ tokenFile: tk, rate: 1 }), deps).send({ text: "x" })), "message_config");
    assert.equal(seen.length, 0);
    // The shared limiter still has its one slot.
    assert.deepEqual(await new MessageSender(cfg({ rate: 1 }), deps).send({ text: "x" }), { sent: true, id: "msg123" });
  });

  test("a bad config is message_config at call time and nothing is sent", async () => {
    reset();
    assert.equal(await codeOf(new MessageSender({ url: "http://ntfy.example.test", topic: "inbox" }).send({ text: "x" })), "message_config");
    assert.equal(await codeOf(new MessageSender(cfg({ topic: "in box" })).send({ text: "x" })), "message_config");
    assert.equal(await codeOf(new MessageSender(cfg({ user: "assistant" })).send({ text: "x" })), "message_config");
    assert.equal(await codeOf(new MessageSender(cfg({ rate: Number.NaN })).send({ text: "x" })), "message_config");
    assert.equal(seen.length, 0);
  });

  test("rate limit: a sliding hour window; over it is rate_limited with the reset time and nothing is sent", async () => {
    reset();
    let now = Date.parse("2030-01-01T00:00:00Z");
    const s = new MessageSender(cfg({ rate: 2 }), { now: () => now });
    await s.send({ text: "1" });
    now += 10 * 60 * 1000;
    await s.send({ text: "2" });
    now += 10 * 60 * 1000;
    const e = await s.send({ text: "3" }).catch((x) => x);
    assert.equal(e.code, "rate_limited");
    assert.match(e.message, /2030-01-01T01:00:00\.000Z/);
    assert.equal(seen.length, 2);
    now = Date.parse("2030-01-01T01:00:00Z"); // the first send leaves the window
    await s.send({ text: "4" });
    assert.equal(seen.length, 3);
    assert.equal(await codeOf(s.send({ text: "5" })), "rate_limited");
  });

  test("the default rate is 10 an hour", async () => {
    reset();
    const s = new MessageSender(cfg(), { now: () => 1_000 });
    for (let i = 0; i < 10; i++) await s.send({ text: String(i) });
    assert.equal(await codeOf(s.send({ text: "11" })), "rate_limited");
    assert.equal(seen.length, 10);
  });

  test("idempotency_key: a retry posts nothing; a reused key with other text is refused", async () => {
    reset();
    const s = new MessageSender(cfg());
    const [a, b] = await Promise.all([s.send({ text: "once", idempotency_key: "k1" }), s.send({ text: "once", idempotency_key: "k1" })]);
    assert.deepEqual(a, b);
    assert.equal(seen.length, 1);
    assert.equal(await codeOf(s.send({ text: "other", idempotency_key: "k1" })), "idempotency_conflict");
    await s.send({ text: "once", idempotency_key: "k2" });
    assert.equal(seen.length, 2);
  });

  test("after a network failure the key's outcome is unknown: a retry posts nothing and is told to use a new key", async () => {
    let calls = 0;
    const s = new MessageSender(cfg(), { fetch: async () => { calls++; throw new TypeError("fetch failed"); } });
    assert.equal(await codeOf(s.send({ text: "x", idempotency_key: "k" })), "message_network");
    const e = await s.send({ text: "x", idempotency_key: "k" }).catch((x) => x);
    assert.equal(e.code, "idempotency_unknown");
    assert.match(e.message, /Nothing was re-sent/);
    assert.match(e.message, /new idempotency_key/);
    assert.equal(calls, 1);
  });

  test("rate_limited through the key path: refused, nothing sent, the key not kept", async () => {
    reset();
    let now = 0;
    const s = new MessageSender(cfg({ rate: 1 }), { now: () => now });
    await s.send({ text: "a", idempotency_key: "ka" });
    assert.equal(await codeOf(s.send({ text: "b", idempotency_key: "kb" })), "rate_limited");
    assert.equal(seen.length, 1);
    // The retry with the same key is the original send's result, not a new post.
    assert.deepEqual(await s.send({ text: "a", idempotency_key: "ka" }), { sent: true, id: "msg123" });
    now = 60 * 60 * 1000;
    assert.deepEqual(await s.send({ text: "b", idempotency_key: "kb" }), { sent: true, id: "msg123" }, "a refused key can send later");
    assert.equal(seen.length, 2);
  });

  test("a failed send is not remembered under its key, so a retry can send", async () => {
    reset(500, "{}");
    const s = new MessageSender(cfg());
    assert.equal(await codeOf(s.send({ text: "x", idempotency_key: "k" })), "message_http");
    reset();
    assert.deepEqual(await s.send({ text: "x", idempotency_key: "k" }), { sent: true, id: "msg123" });
  });
});

describe("SlidingHourLimiter", () => {
  test("opens a slot one hour after the oldest send", () => {
    const l = new SlidingHourLimiter();
    assert.deepEqual(l.take(1, 0), { ok: true });
    assert.deepEqual(l.take(1, 1000), { ok: false, resetAt: 3_600_000 });
    assert.deepEqual(l.take(1, 3_600_000), { ok: true });
  });
});

// ── config ─────────────────────────────────────────────────────────────────────
describe("messageConfigFromEnv / checkMessageConfig", () => {
  test("undefined unless both URL and topic are set", () => {
    assert.equal(messageConfigFromEnv({}), undefined);
    assert.equal(messageConfigFromEnv({ VAULT_MCP_MESSAGE_URL: "https://ntfy.example.test" }), undefined);
    assert.equal(messageConfigFromEnv({ VAULT_MCP_MESSAGE_TOPIC: "inbox" }), undefined);
  });

  test("reads every variable", () => {
    assert.deepEqual(
      messageConfigFromEnv({
        VAULT_MCP_MESSAGE_URL: "https://ntfy.example.test",
        VAULT_MCP_MESSAGE_TOPIC: "inbox",
        VAULT_MCP_MESSAGE_USER: "assistant",
        VAULT_MCP_MESSAGE_PASSWORD_FILE: "/etc/example/pw",
        VAULT_MCP_MESSAGE_TAGS: "robot, inbox ,",
        VAULT_MCP_MESSAGE_RATE: "5",
      }),
      { url: "https://ntfy.example.test", topic: "inbox", user: "assistant", passwordFile: "/etc/example/pw", tags: ["robot", "inbox"], rate: 5 },
    );
  });

  test("https only, except localhost", () => {
    assert.equal(checkMessageConfig({ url: "https://ntfy.example.test", topic: "inbox" }), null);
    assert.equal(checkMessageConfig({ url: "http://localhost:8080", topic: "inbox" }), null);
    assert.equal(checkMessageConfig({ url: "http://127.0.0.1:8080", topic: "inbox" }), null);
    assert.equal(checkMessageConfig({ url: "http://[::1]:8080", topic: "inbox" }), null);
    assert.match(checkMessageConfig({ url: "http://ntfy.example.test", topic: "inbox" }), /https/);
    assert.match(checkMessageConfig({ url: "https://u:p@ntfy.example.test", topic: "inbox" }), /user or password/);
    assert.match(checkMessageConfig({ url: "https://ntfy.example.test", topic: "inbox", tokenFile: "/t", user: "a", passwordFile: "/p" }), /not both/);
  });
});

// ── registration ───────────────────────────────────────────────────────────────
function recorder() {
  const tools = new Map();
  return { tools, registerTool: (name, meta, handler) => tools.set(name, { meta, handler }) };
}
const noBackend = {};

describe("registration", () => {
  test("not registered when unconfigured", () => {
    const r = recorder();
    registerFsTools(r, noBackend, {});
    assert.equal(r.tools.has(SEND_MESSAGE_TOOL), false);
    assert.equal(registerSendMessageTool(recorder(), undefined), false);
  });

  test("registered when configured, with open-world, non-destructive, not-read-only annotations", () => {
    const r = recorder();
    registerFsTools(r, noBackend, { message: { url: "https://ntfy.example.test", topic: "inbox" } });
    const t = r.tools.get(SEND_MESSAGE_TOOL);
    assert.ok(t);
    assert.equal(t.meta.annotations.readOnlyHint, false);
    assert.equal(t.meta.annotations.destructiveHint, false);
    assert.equal(t.meta.annotations.openWorldHint, true);
    // Strict: an unknown argument is refused.
    assert.equal(t.meta.inputSchema.safeParse({ text: "x", path: "a.md" }).success, false);
    assert.equal(t.meta.inputSchema.safeParse({ text: "x", title: "t", idempotency_key: "k" }).success, true);
  });

  test("not registered under a profile that does not offer it: read, read+inbox, none", () => {
    for (const name of ["read", "read+inbox", "none"]) {
      const r = recorder();
      registerFsTools(r, noBackend, { message: { url: "https://ntfy.example.test", topic: "inbox" }, profile: resolveProfile(name) });
      assert.equal(r.tools.has(SEND_MESSAGE_TOOL), false, name);
    }
    const full = recorder();
    registerFsTools(full, noBackend, { message: { url: "https://ntfy.example.test", topic: "inbox" }, profile: resolveProfile("full") });
    assert.equal(full.tools.has(SEND_MESSAGE_TOOL), true, "full");
  });

  test("the handler returns {sent, id} and a coded error as `Error [code]`", async () => {
    reset();
    const r = recorder();
    const sender = new MessageSender(cfg());
    registerSendMessageTool(r, cfg(), { sender });
    const { handler } = r.tools.get(SEND_MESSAGE_TOOL);
    const good = await handler({ text: "via handler" });
    assert.deepEqual(good.structuredContent, { sent: true, id: "msg123" });
    const bad = await handler({ text: "a".repeat(2001) });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /^Error \[text_too_long\]/);
  });
});
