// The secret scanner (secret-scan.ts): what it blanks, what it must leave alone, and that it is
// linear and fails closed. Every key here is made up and obviously fake.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactToolResult, redactingHandler, SCAN_FAILED_TEXT } from "../src/secret-scan.ts";
import { resolveProfile } from "../src/profile.ts";

const A = (n) => "A".repeat(n);
const blanked = (input, kind) => {
  const out = redactSecrets(input);
  assert.ok(out.includes(`[redacted:${kind}]`), `expected [redacted:${kind}] in ${JSON.stringify(out)}`);
  return out;
};

describe("token shapes are blanked, with no part of the secret kept", () => {
  const cases = [
    ["api-key", `sk-test-${A(24)}`],
    ["api-key", `sk-proj-FAKEfakeFAKEfake0000FAKE`],
    ["anthropic-key", `sk-ant-api00-FAKE${A(30)}`],
    ["github-token", `ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE`],
    ["github-token", `gho_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE`],
    ["github-token", `github_pat_11FAKE_${A(40)}`],
    ["slack-token", `xoxb-0000000000-FAKEFAKEFAKE`],
    ["slack-token", `xoxp-1111-2222-FAKEFAKE`],
    ["aws-key-id", `AKIA${"FAKE".repeat(4)}`],
    ["google-api-key", `AIza${"F".repeat(35)}`],
    ["stripe-key", `sk_live_${"FAKE".repeat(6)}`],
    ["stripe-key", `rk_live_${"FAKE".repeat(6)}`],
    ["jwt", `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZQ`],
  ];
  for (const [kind, secret] of cases) {
    test(`${kind}: ${secret.slice(0, 12)}…`, () => {
      const out = blanked(`before ${secret} after`, kind);
      assert.equal(out, `before [redacted:${kind}] after`);
      assert.ok(!out.includes(secret.slice(-8)));
    });
  }

  test("a PEM private key block, whole", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEFAKEFAKE\nFAKEFAKEFAKE==\n-----END RSA PRIVATE KEY-----`;
    const out = blanked(`key:\n${pem}\nnext line`, "private-key");
    assert.equal(out, "key:\n[redacted:private-key]\nnext line");
  });

  test("a PEM block inside a JSON string (escaped line breaks), and a header cut off with no END", () => {
    const json = JSON.stringify({ content: "-----BEGIN PRIVATE KEY-----\nMIIFAKEFAKE\n-----END PRIVATE KEY-----\nok" });
    const out = blanked(json, "private-key");
    assert.ok(!out.includes("MIIFAKEFAKE"));
    assert.ok(out.includes("ok"));
    assert.doesNotThrow(() => JSON.parse(out));
    const cut = blanked("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaFAKEFAKE", "private-key");
    assert.ok(!cut.includes("b3BlbnNzaFAKEFAKE"));
  });

  test("a token right after a JSON-escaped line break", () => {
    const json = JSON.stringify({ text: `line\nghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE` });
    const out = blanked(json, "github-token");
    assert.doesNotThrow(() => JSON.parse(out));
  });
});

describe("headers and URLs", () => {
  test("Authorization: Bearer keeps the scheme word", () => {
    assert.equal(redactSecrets("Authorization: Bearer fake.token.value123"), "Authorization: Bearer [redacted:authorization]");
    assert.equal(redactSecrets("authorization=Basic ZmFrZTpmYWtl"), "authorization=Basic [redacted:authorization]");
  });
  test("a bearer token elsewhere; prose about bearer tokens passes", () => {
    assert.equal(redactSecrets("curl -H 'Bearer abcFAKE1234567890'"), "curl -H 'Bearer [redacted:bearer-token]'");
    const prose = "Bearer authentication sends a Bearer token.";
    assert.equal(redactSecrets(prose), prose);
  });
  test("credentials in a URL: scheme and host kept", () => {
    assert.equal(redactSecrets("db at postgres://admin:FakePass123@db.example.test:5432/app"), "db at postgres://[redacted:url-credentials]@db.example.test:5432/app");
    assert.equal(redactSecrets("https://user:p@ss@example.test/x"), "https://[redacted:url-credentials]@example.test/x");
  });
  test("a URL with only a user, or none, passes", () => {
    for (const s of ["ssh://git@example.test/repo.git", "https://example.test/a:b", "mailto:someone@example.test"]) assert.equal(redactSecrets(s), s);
  });
});

describe("key=value and key: value pairs whose key names a secret", () => {
  const cases = [
    ["password: hunter2-fake", "password: [redacted:secret]"],
    ["Password = fake-pass", "Password = [redacted:secret]"],
    ["PASSWD=fake", "PASSWD=[redacted:secret]"],
    ["pwd: fake", "pwd: [redacted:secret]"],
    ["db_password: 'fake value'", "db_password: '[redacted:secret]'"],
    ['client_secret: "fake value"', 'client_secret: "[redacted:secret]"'],
    ["GITHUB_TOKEN=fakefakefake", "GITHUB_TOKEN=[redacted:secret]"],
    ["export API_KEY=fake123", "export API_KEY=[redacted:secret]"],
    ["apiKey: fake", "apiKey: [redacted:secret]"],
    ["access_key=fake", "access_key=[redacted:secret]"],
    ["aws_secret_access_key = fakefake", "aws_secret_access_key = [redacted:secret]"],
    ["private_key: fake", "private_key: [redacted:secret]"],
    ["passphrase: two fake words", "passphrase: [redacted:secret]"],
    ["X-Api-Key: fakefake", "X-Api-Key: [redacted:secret]"],
    ["The secret: fake words here", "The secret: [redacted:secret]"],
    ["https://example.test/cb?token=fake123&x=1", "https://example.test/cb?token=[redacted:secret]"],
  ];
  for (const [input, want] of cases) test(input, () => assert.equal(redactSecrets(input), want));

  test("in YAML frontmatter, only the secret line changes", () => {
    const note = "---\ntitle: A note\napi_key: fake-key-value\ntags: [x]\n---\nBody\n";
    assert.equal(redactSecrets(note), "---\ntitle: A note\napi_key: [redacted:secret]\ntags: [x]\n---\nBody\n");
  });

  test("inside JSON text the JSON stays valid", () => {
    const reply = JSON.stringify({ path: "a.md", frontmatter: { password: "fake", user: "u" }, content: "---\ntoken: fake\npassword: \"fake two\"\n---\nbody" });
    const out = redactSecrets(reply);
    const parsed = JSON.parse(out);
    assert.equal(parsed.frontmatter.password, "[redacted:secret]");
    assert.equal(parsed.frontmatter.user, "u");
    assert.equal(parsed.content, '---\ntoken: [redacted:secret]\npassword: "[redacted:secret]"\n---\nbody');
  });

  test("keys that only contain the word, and values that hold no secret, pass", () => {
    for (const s of [
      "tokens: 4096",
      "max_tokens: 4096",
      "token_count: 12",
      "secretary: Jane Doe",
      "passwordless: true",
      "password: true",
      "secret: false",
      "token: null",
      "password:",
      "password:\n  - nested",
      "This note is about passwords and tokens.",
    ]) assert.equal(redactSecrets(s), s, s);
  });

  test("a value already blanked is not blanked twice", () => {
    assert.equal(redactSecrets(`token: ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE`), "token: [redacted:github-token]");
  });
});

describe("what must survive: ids, hashes and shas", () => {
  const keep = [
    ["a uuid v4", "3f2b8c1e-9a4d-4e6b-8f1a-2c3d4e5f6a7b"],
    ["a uuid v7", "0192f0a1-7b3c-7d4e-8f5a-6b7c8d9e0f1a"],
    ["a git sha", "b0a088f3c9d2e1f4a5b6c7d8e9f0a1b2c3d4e5f6"],
    ["a short sha", "b0a088f"],
    ["a sha256 hex", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["a base64 hash", "sha256-n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg="],
    ["a uid key", "uid: 0192f0a1-7b3c-7d4e-8f5a-6b7c8d9e0f1a"],
    ["a long random-looking word", "Zx9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890qwertyuiop"],
    ["a note path", "00-09 System/03 Agents/a note.md"],
    ["a wikilink", "[[Some note#Heading|alias]]"],
  ];
  for (const [what, s] of keep) test(what, () => assert.equal(redactSecrets(s), s));
});

describe("speed and failure", () => {
  test("1 MB of mixed text scans in well under a second", () => {
    const chunk = "plain text with a uid 3f2b8c1e-9a4d-4e6b-8f1a-2c3d4e5f6a7b and token: fake and sk-test-AAAAAAAAAAAAAAAAAAAAAAAA\n";
    const big = chunk.repeat(Math.ceil(1_000_000 / chunk.length));
    const t0 = performance.now();
    const out = redactSecrets(big);
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
    assert.ok(!out.includes("sk-test-"));
  });

  test("1 MB adversarial inputs stay linear", () => {
    const inputs = [
      "eyJ" + "a".repeat(1_000_000),
      "eyJa.".repeat(200_000),
      "-----BEGIN PRIVATE KEY-----".repeat(40_000),
      "password: ".repeat(100_000),
      "a://b:".repeat(170_000),
      "Bearer ".repeat(150_000),
      "\\n".repeat(500_000),
      "sk-".repeat(330_000),
      '\\"'.repeat(500_000),
      "token=\\\"" + "x".repeat(1_000_000),
    ];
    for (const s of inputs) {
      const t0 = performance.now();
      redactSecrets(s);
      const ms = performance.now() - t0;
      assert.ok(ms < 2000, `${JSON.stringify(s.slice(0, 20))}… took ${ms} ms`);
    }
  });

  test("never throws; a non-string fails closed", () => {
    assert.equal(redactSecrets(undefined), SCAN_FAILED_TEXT);
    assert.equal(redactSecrets(42), SCAN_FAILED_TEXT);
  });

  test("a result the scanner cannot walk fails closed, with no input text", () => {
    const evil = { content: [{ type: "text", get text() { throw new Error("sk-test-" + A(24)); } }] };
    const out = redactToolResult(evil);
    assert.equal(out.isError, true);
    assert.equal(out.content[0].text, SCAN_FAILED_TEXT);
  });
});

describe("tool results and handlers", () => {
  const secret = `ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE`;

  test("every text item and every structured string is blanked; the input is not changed; images are left alone", () => {
    const input = {
      content: [
        { type: "text", text: `a ${secret}` },
        { type: "image", data: "AKIAFAKEFAKEFAKEFAKE", mimeType: "image/png" },
        { type: "resource", resource: { uri: "https://u:FakePass1@example.test/x", text: `token: fake` } },
      ],
      structuredContent: { notes: [{ body: `password: fake` }], n: 3 },
    };
    const copy = structuredClone(input);
    const out = redactToolResult(input);
    assert.deepEqual(input, copy);
    assert.equal(out.content[0].text, "a [redacted:github-token]");
    assert.equal(out.content[1].data, "AKIAFAKEFAKEFAKEFAKE");
    assert.equal(out.content[2].resource.uri, "https://[redacted:url-credentials]@example.test/x");
    assert.equal(out.content[2].resource.text, "token: [redacted:secret]");
    assert.equal(out.structuredContent.notes[0].body, "password: [redacted:secret]");
    assert.equal(out.structuredContent.n, 3);
  });

  test("a wrapped handler gets its arguments unchanged; its reply and a thrown message are blanked", async () => {
    let seen;
    const h = redactingHandler(async (args) => {
      seen = args;
      return { content: [{ type: "text", text: `echo ${args.q}` }] };
    });
    const r = await h({ q: secret });
    assert.equal(seen.q, secret);
    assert.equal(r.content[0].text, "echo [redacted:github-token]");
    const t = redactingHandler(() => { throw new Error(`bad ${secret}`); });
    await assert.rejects(t({}), (e) => e.message === "bad [redacted:github-token]");
  });

  test("only read+message turns the scanner on", () => {
    assert.equal(resolveProfile("read+message").redactSecrets, true);
    for (const n of [undefined, "full", "read", "read+inbox", "nonsense"]) assert.ok(!resolveProfile(n).redactSecrets, String(n));
  });
});
