// The secret scanner (secret-scan.ts): what it blanks, what it must leave alone, and that it is
// linear and fails closed. Every key here is made up and obviously fake.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactToolResult, redactingHandler, SCAN_FAILED_TEXT } from "../src/secret-scan.ts";
import { resolveProfile } from "../src/profile.ts";

const A = (n) => "A".repeat(n);
// Every key-shaped placeholder is built at run time from parts, so no literal that a secret
// scanner (gitleaks, push protection) flags is committed. Every one is made up.
const cat = (...p) => p.join("");
const FAKE = (n) => "FAKE".repeat(n);
const K = {
  sk: cat("sk", "-test-", A(24)),
  skProj: cat("sk", "-proj-", "FAKEfakeFAKEfake0000FAKE"),
  ant: cat("sk", "-ant-", "api00-FAKE", A(30)),
  ghp: cat("gh", "p_", FAKE(9)),
  gho: cat("gh", "o_", FAKE(9)),
  ghPat: cat("github", "_pat_", "11FAKE_", A(40)),
  xoxb: cat("xo", "xb-", "0000000000-", FAKE(3)),
  xoxp: cat("xo", "xp-", "1111-2222-", FAKE(2)),
  akia: cat("AK", "IA", FAKE(4)),
  aiza: cat("AI", "za", "F".repeat(35)),
  jwt: [cat("ey", "JhbGciOiJIUzI1NiJ9"), cat("ey", "JzdWIiOiJmYWtlIn0"), "ZmFrZXNpZ25hdHVyZQ"].join("."),
};
const BEGIN = (t) => cat("-----", "BEGIN ", t, "PRIVATE KEY", "-----");
const END = (t) => cat("-----", "END ", t, "PRIVATE KEY", "-----");
const BODY = cat("MIIEv", "QIBADANBgkqhkiG9w0BAQEFAASC", "FAKE");
const blanked = (input, kind) => {
  const out = redactSecrets(input);
  assert.ok(out.includes(`[redacted:${kind}]`), `expected [redacted:${kind}] in ${JSON.stringify(out)}`);
  return out;
};

describe("token shapes are blanked, with no part of the secret kept", () => {
  const cases = [
    ["api-key", K.sk],
    ["api-key", K.skProj],
    ["anthropic-key", K.ant],
    ["github-token", K.ghp],
    ["github-token", K.gho],
    ["github-token", K.ghPat],
    ["slack-token", K.xoxb],
    ["slack-token", K.xoxp],
    ["aws-key-id", K.akia],
    ["google-api-key", K.aiza],
    ["stripe-key", ["sk", "live", "FAKE".repeat(6)].join("_")],
    ["stripe-key", ["rk", "live", "FAKE".repeat(6)].join("_")],
    ["slack-token", ["xoxe", "1", "FAKEFAKEFAKE"].join("-")],
    ["slack-token", ["xapp", "1", "AFAKE", "FAKEFAKEFAKE"].join("-")],
    ["gitlab-token", "glpat" + "-" + "FAKE".repeat(5)],
    ["huggingface-token", "hf" + "_" + "FAKE".repeat(9)],
    ["npm-token", "npm" + "_" + "FAKE".repeat(10)],
    ["tailscale-key", ["tskey", "auth", "FAKE", "FAKEFAKE"].join("-")],
    ["sendgrid-key", ["SG", "FAKE".repeat(5), "FAKE".repeat(10)].join(".")],
    ["jwt", K.jwt],
  ];
  for (const [kind, secret] of cases) {
    test(`${kind}: ${secret.slice(0, 12)}…`, () => {
      const out = blanked(`before ${secret} after`, kind);
      assert.equal(out, `before [redacted:${kind}] after`);
      assert.ok(!out.includes(secret.slice(-8)));
    });
  }

  test("a PEM private key block, whole", () => {
    const pem = `${BEGIN("RSA ")}\n${BODY}\nFAKEFAKEFAKE==\n${END("RSA ")}`;
    const out = blanked(`key:\n${pem}\nnext line`, "private-key");
    assert.equal(out, "key:\n[redacted:private-key]\nnext line");
  });

  test("a PEM block inside a JSON string (escaped line breaks), and a header cut off with no END", () => {
    const json = JSON.stringify({ content: `${BEGIN("")}\n${BODY}\n${END("")}\nok` });
    const out = blanked(json, "private-key");
    assert.ok(!out.includes(BODY));
    assert.ok(out.includes("ok"));
    assert.doesNotThrow(() => JSON.parse(out));
    const cut = blanked(`${BEGIN("OPENSSH ")}\nb3BlbnNzaFAKEFAKE`, "private-key");
    assert.ok(!cut.includes("b3BlbnNzaFAKEFAKE"));
  });

  test("a token right after a JSON-escaped line break", () => {
    const json = JSON.stringify({ text: `line\n${K.ghp}` });
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
      "pass: true",
      "passed: 3",
      "passing: yes",
      "password_hint_count: 2",
      "bypass: on",
      "compass = north",
      "This note is about passwords and tokens.",
      "pin: 1234",
      "password-protected: yes",
      "The password-protected file opened.",
      "pwm: x",
    ]) assert.equal(redactSecrets(s), s, s);
  });

  test("markdown tables, bold keys, arrows and XML", () => {
    assert.equal(redactSecrets("| password | fake-pass |"), "| password | [redacted:secret] |");
    assert.equal(redactSecrets("| **DB password** | fake |\n| user | u |"), "| **DB password** | [redacted:secret] |\n| user | u |");
    assert.equal(redactSecrets("**password**: fake words"), "**password**: [redacted:secret]");
    assert.equal(redactSecrets("`api_key`: fake"), "`api_key`: [redacted:secret]");
    assert.equal(redactSecrets("'token' => 'fake'"), "'token' => '[redacted:secret]'");
    assert.equal(redactSecrets("pass => fake"), "pass => [redacted:secret]");
    assert.equal(redactSecrets("db_pass: fake"), "db_pass: [redacted:secret]");
    assert.equal(redactSecrets("<password>fake</password>"), "<password>[redacted:secret]</password>");
    assert.equal(redactSecrets('<db_secret type="x">fake</db_secret>'), '<db_secret type="x">[redacted:secret]</db_secret>');
  });

  test("a YAML block scalar or list under a secret key becomes one marker", () => {
    assert.equal(redactSecrets("a: 1\npassword: |\n  line one fake\n  line two fake\nb: 2\n"), "a: 1\npassword: [redacted:secret]\nb: 2\n");
    assert.equal(redactSecrets("password: >-\n    folded fake\n"), "password: [redacted:secret]\n");
    assert.equal(redactSecrets("password:\n  - fake1\n  - fake2\nother: x"), "password: [redacted:secret]\nother: x");
    assert.equal(redactSecrets("secret:\n- fake\nnext: y"), "secret: [redacted:secret]\nnext: y");
    assert.equal(redactSecrets("  token:\n    nested: fake\n  sibling: z"), "  token: [redacted:secret]\n  sibling: z");
  });

  test("a PGP private key block", () => {
    const pgp = `${BEGIN("PGP ")}`.replace(/-----$/, " BLOCK-----") + "\n\nlQOYBFAKEFAKE\n=FAKE\n" + `${END("PGP ")}`.replace(/-----$/, " BLOCK-----");
    assert.equal(redactSecrets(`a\n${pgp}\nb`), "a\n[redacted:private-key]\nb");
  });

  test("an escaped quote inside a quoted value does not leak its tail", () => {
    assert.equal(redactSecrets('password: "fa\\"ke"'), 'password: "[redacted:secret]"');
    const json = JSON.stringify({ note: 'password: "fa\\"ke" end' }).slice(0, -1); // cut, so it is not JSON
    assert.ok(!redactSecrets(json).includes("ke"), redactSecrets(json));
  });

  test("an unclosed single quote does not eat the end of a JSON string", () => {
    const cut = `{"a": "password: 'fake", "b": "keep"`; // not valid JSON: the regex rules run
    const out = redactSecrets(cut);
    assert.ok(!out.includes("fake"), out);
    assert.ok(out.includes('"b": "keep"'), out);
  });

  test("a value already blanked is not blanked twice", () => {
    assert.equal(redactSecrets(`token: ${K.ghp}`), "token: [redacted:github-token]");
  });
});

describe("JSON text and structured content are scanned key-aware and stay valid", () => {
  const samples = [
    { token: 123456, secret: true, has_secret: false, name: "n" },
    { password: ["fake1", "fake2"], api_key: { id: "fake" }, list: [1, 2] },
    { frontmatter: { password: "fake", api_key: "fake-key", tags: ["x"], passed: 3 }, content: "---\npassword: fake\n---\nbody" },
    [{ secret: "fake", count: 2 }, { token: null }],
    { nested: { deeper: { client_secret: "fake", "x,y": "a, b" } }, text: K.sk },
  ];
  for (const [i, sample] of samples.entries()) {
    for (const indent of [undefined, 2]) {
      test(`sample ${i}, indent ${indent ?? 0}: it parses and holds no fake value`, () => {
        const out = redactSecrets(JSON.stringify(sample, null, indent));
        const parsed = JSON.parse(out);
        assert.ok(!/fake|AAAAAAAA/.test(out), out);
        assert.equal(out, JSON.stringify(parsed, null, indent));
      });
    }
  }

  test("the value under a secret key is blanked whatever its type; booleans and null survive", () => {
    const out = JSON.parse(redactSecrets(JSON.stringify(samples[0], null, 2)));
    assert.deepEqual(out, { token: "[redacted:secret]", secret: true, has_secret: false, name: "n" });
    const two = JSON.parse(redactSecrets(JSON.stringify(samples[1])));
    assert.deepEqual(two, { password: "[redacted:secret]", api_key: "[redacted:secret]", list: [1, 2] });
  });

  test("JSON with nothing to blank comes back byte for byte", () => {
    const t = '{ "a" :1,\n"b":[ 2 ] }';
    assert.equal(redactSecrets(t), t);
  });

  test("structured content: secret keys blanked; Date, Map and class values kept as they are", () => {
    class Thing { constructor() { this.secret = "kept-as-is"; } }
    const when = new Date(0);
    const map = new Map([["a", 1]]);
    const thing = new Thing();
    const r = redactToolResult({ content: [], structuredContent: { frontmatter: { password: "fake", apiKey: 42, dbPass: "fake", uid: "0192f0a1-7b3c-7d4e-8f5a-6b7c8d9e0f1a" }, when, map, thing } });
    const sc = r.structuredContent;
    assert.deepEqual(sc.frontmatter, { password: "[redacted:secret]", apiKey: "[redacted:secret]", dbPass: "[redacted:secret]", uid: "0192f0a1-7b3c-7d4e-8f5a-6b7c8d9e0f1a" });
    assert.equal(sc.when, when);
    assert.equal(sc.map, map);
    assert.equal(sc.thing, thing);
  });
});

describe("review round 2: more key forms", () => {
  const cases = [
    ["API Key: fake1", "API Key: [redacted:secret]"],
    ["**API Key:** fake2", "**API Key:** [redacted:secret]"],
    ["1. API key: fake3", "1. API key: [redacted:secret]"],
    ["Secret Key: fake4", "Secret Key: [redacted:secret]"],
    ["Access Key = fake5", "Access Key = [redacted:secret]"],
    ["Private Key: fake6", "Private Key: [redacted:secret]"],
    ["Client  Secret: fake7", "Client  Secret: [redacted:secret]"],
    ["*password*: fake8", "*password*: [redacted:secret]"],
    ["_password_: fake9", "_password_: [redacted:secret]"],
    ["pw: fake10", "pw: [redacted:secret]"],
    ["passcode: fake11", "passcode: [redacted:secret]"],
    ["password\tfake12", "password\t[redacted:secret]"],
    ["password：fake13", "password：[redacted:secret]"],
    ["password - fake14", "password - [redacted:secret]"],
    ['<input name="password" value="fake15">', '<input name="password" value="[redacted:secret]">'],
    ["<input type=password name=db_pass value=fake16>", "<input type=password name=db_pass value=[redacted:secret]>"],
    ['password: ["fake17","fake18"]', "password: [redacted:secret]"],
    ["token: {a: fake19, b: [fake20]} tail", "token: [redacted:secret] tail"],
  ];
  for (const [input, want] of cases) test(input, () => assert.equal(redactSecrets(input), want));

  test("a JSON key with a space, and camelCase cookie and key names", () => {
    const out = JSON.parse(redactSecrets(JSON.stringify({ "API Key": "q1", sessionCookie: "q2", privateKeyPem: "q3", "Secret Key": "q4", keep: "k" })));
    assert.deepEqual(out, { "API Key": "[redacted:secret]", sessionCookie: "[redacted:secret]", privateKeyPem: "[redacted:secret]", "Secret Key": "[redacted:secret]", keep: "k" });
  });

  test("a fenced JSON block in a note: arrays and objects under a secret key, over several lines", () => {
    const note = 'Config:\n```json\n{\n  "api_key": ["fake-k1", "fake-k2"],\n  "client_secret": {\n    "prod": "fake-abc",\n    "dev": "fake-}def"\n  },\n  "name": "kept"\n}\n```\nafter';
    const out = redactSecrets(note);
    assert.ok(!/fake/.test(out), out);
    assert.match(out, /"name": "kept"/);
    assert.match(out, /after$/);
  });

  test("a bracket that never closes is blanked to the end of its block, and no further", () => {
    const out = redactSecrets('password: ["fake-a1", "fake-b2",\n "fake-c3"\n\nafter the block');
    assert.ok(!/fake/.test(out), out);
    assert.match(out, /after the block$/);
  });

  test("no value is capped: a long value leaks no tail", () => {
    const long = "f".repeat(10_000);
    for (const t of [`password: ${long}`, `password: "${long}"`, `password: '${long}'`, `| password | ${long} |`, `<password>${long}</password>`]) {
      assert.ok(!redactSecrets(t).includes("ffff"), t.slice(0, 20));
    }
  });

  test("a credentials table: the column under a secret header is blanked in every row", () => {
    const table = "| Service | User | Password |\n|---|---|---|\n| mail | bob | fake-1 |\n| bank | amy | fake-2 |\n\n| a | b |";
    assert.equal(redactSecrets(table), "| Service | User | Password |\n|---|---|---|\n| mail | bob | [redacted:secret] |\n| bank | amy | [redacted:secret] |\n\n| a | b |");
    const two = "| Name | API Key | Notes |\n| :-- | :-: | --: |\n| x | fake-3 | keep |";
    assert.equal(redactSecrets(two), "| Name | API Key | Notes |\n| :-- | :-: | --: |\n| x | [redacted:secret] | keep |");
  });

  test("an object key that is a token is blanked; __proto__ keys are kept", () => {
    const out = JSON.parse(redactSecrets(JSON.stringify({ [K.ghp]: 1, b: 2 })));
    assert.deepEqual(out, { "[redacted:github-token]": 1, b: 2 });
    const proto = '{"__proto__": {"note": "token: fake-p"}, "b": 1}';
    const r = redactSecrets(proto);
    assert.ok(r.includes('"__proto__"') && !r.includes("fake-p"), r);
    const sc = redactToolResult({ content: [], structuredContent: JSON.parse(proto) }).structuredContent;
    assert.ok(Object.prototype.hasOwnProperty.call(sc, "__proto__"));
    assert.equal(Object.getPrototypeOf(sc), Object.prototype);
  });
});

describe("search snippets", () => {
  const hits = (snippets) => ({ content: [{ type: "text", text: JSON.stringify({ hits: snippets.map((s, i) => ({ path: "a.md", line: i + 1, snippet: s })) }, null, 2) }], structuredContent: { hits: snippets.map((s, i) => ({ path: "a.md", line: i + 1, snippet: s })) } });

  test("a body line or an indented one-token value is blanked under snippets", () => {
    const secretLines = [BODY, "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822c", "  - fake-hunter2", "    s3cr3t!x"];
    const r = redactToolResult(hits(secretLines), { snippets: true });
    for (const h of r.structuredContent.hits) assert.match(h.snippet, /^\s*(- )?\[redacted:secret\]$/, h.snippet);
    const text = JSON.parse(r.content[0].text);
    assert.deepEqual(text.hits, r.structuredContent.hits);
  });

  test("ordinary snippets pass under snippets", () => {
    const keep = ["  - [[Some note]]", "- item123", "  - plain words here", "  - #tag/sub", "Body text with words", "  - https://example.test/x", "  ok", "  - Folder/Note"];
    const r = redactToolResult(hits(keep), { snippets: true });
    assert.deepEqual(r.structuredContent.hits.map((h) => h.snippet), keep);
  });

  test("without snippets, a body line passes (only search replies get the rule)", () => {
    const r = redactToolResult(hits([BODY]));
    assert.equal(r.structuredContent.hits[0].snippet, BODY);
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
    const chunk = `plain text with a uid 3f2b8c1e-9a4d-4e6b-8f1a-2c3d4e5f6a7b and token: fake and ${K.sk}\n`;
    const big = chunk.repeat(Math.ceil(1_000_000 / chunk.length));
    const t0 = performance.now();
    const out = redactSecrets(big);
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
    assert.ok(!out.includes(K.sk));
  });

  test("1 MB adversarial inputs stay linear", () => {
    const inputs = [
      cat("ey", "J") + "a".repeat(1_000_000),
      cat("ey", "Ja.").repeat(200_000),
      BEGIN("").repeat(40_000),
      "password: ".repeat(100_000),
      "a://b:".repeat(170_000),
      "Bearer ".repeat(150_000),
      "\\n".repeat(500_000),
      cat("s", "k-").repeat(330_000),
      '\\"'.repeat(500_000),
      "token=\\\"" + "x".repeat(1_000_000),
      "| password ".repeat(90_000),
      "|".repeat(1_000_000),
      "password:\n".repeat(100_000),
      "password: |\n" + "  x\n".repeat(250_000),
      "<password>".repeat(90_000),
      "<" + "a".repeat(1_000_000),
      "  ".repeat(500_000) + "x",
      "pass".repeat(250_000),
      "  ".repeat(2_500_000) + "x",
      "API Key ".repeat(120_000),
      "password: [" + "[".repeat(1_000_000),
      'password: ["' + "x".repeat(1_000_000),
      "| Password |\n|---|\n" + "| x |\n".repeat(150_000),
      '<x name="password" '.repeat(50_000),
      "password - ".repeat(90_000),
      JSON.stringify({ notes: Array.from({ length: 20_000 }, (_, i) => ({ path: `n${i}.md`, password: "fake", body: "token: fake" })) }, null, 2),
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
    const evil = { content: [{ type: "text", get text() { throw new Error(K.sk); } }] };
    const out = redactToolResult(evil);
    assert.equal(out.isError, true);
    assert.equal(out.content[0].text, SCAN_FAILED_TEXT);
  });
});

describe("tool results and handlers", () => {
  const secret = K.ghp;

  test("every text item and every structured string is blanked; the input is not changed; images are left alone", () => {
    const input = {
      content: [
        { type: "text", text: `a ${secret}` },
        { type: "image", data: K.akia, mimeType: "image/png" },
        { type: "resource", resource: { uri: "https://u:FakePass1@example.test/x", text: `token: fake` } },
      ],
      structuredContent: { notes: [{ body: `password: fake` }], n: 3 },
    };
    const copy = structuredClone(input);
    const out = redactToolResult(input);
    assert.deepEqual(input, copy);
    assert.equal(out.content[0].text, "a [redacted:github-token]");
    assert.equal(out.content[1].data, K.akia);
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
