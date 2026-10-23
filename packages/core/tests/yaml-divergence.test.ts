/**
 * yaml-divergence.test.ts — the accept guard reads every key, and every value
 * under a guarded key, as YAML does, or it refuses.
 *
 * The hole: the guard's reader read a double-quoted `\X` as a plain `X`, while
 * YAML (the `yaml` library Obsidian's parseYaml uses) decodes it as an escape.
 * So `"\x76erified"` was the key `x76erified` to the guard and `verified` to
 * YAML, and a write could forge a verification. The same held for a quoted
 * acceptance key, an accepted value, a protected property, a root flow mapping,
 * and a quoted value folded over lines (single-quoted included).
 *
 * The rule (YamlDivergenceError): the reader does not decode escapes or folds;
 * it refuses them where the guard depends on the reading. Each case below is
 * checked against the `yaml` library's own parse of the same text, and on the
 * filesystem write roads (writeNote, replaceText). The notes are made up.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  AcceptForbiddenError,
  YamlDivergenceError,
  acceptTransitionReason,
  parseGuardFrontmatter,
  guardedKey,
  yamlDivergenceReason,
} from "../src/accept-guard.js";
import { scanForAcceptFence } from "../src/accept-scan.js";
import { FilesystemBackend } from "../src/fs-backend/filesystem-backend.js";

const blockOf = (text: string) => text.split("---\n")[1];
const yamlOf = (text: string) => YAML.parse(blockOf(text)) as Record<string, unknown>;
const DIVERGES = /cannot read as YAML does/;

/** "refused", or the guard's reading of the guarded keys. */
function guardedReading(text: string): "refused" | Record<string, unknown> {
  let g: Record<string, unknown> | null;
  try {
    g = parseGuardFrontmatter(text);
  } catch (e) {
    if (e instanceof AcceptForbiddenError) return "refused";
    throw e;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(g ?? {})) if (guardedKey(k)) out[k] = v;
  return out;
}
function yamlGuarded(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(yamlOf(text) ?? {})) if (guardedKey(k)) out[k] = v;
  return out;
}

/**
 * The required cases: [name, seed on disk, the write, what YAML reads in the write].
 * `seed` is the note before the write; for the carry-forward cases the old reader
 * read the write as equal to the seed while YAML reads it differently.
 */
const PLAIN = "---\ntitle: A\n---\nbody\n";
const CASES: Array<{ name: string; seed: string; write: string; yaml: (y: Record<string, unknown>) => void }> = [
  {
    name: 'an escaped key "\\x76erified" (YAML: `verified`)',
    seed: PLAIN,
    write: '---\ntitle: A\n"\\x76erified":\n  - by: human:owner\n    at: x\n---\nbody\n',
    yaml: (y) => assert.deepEqual(y.verified, [{ by: "human:owner", at: "x" }]),
  },
  {
    name: 'an escaped key "\\x61ccepted-by" (YAML: `accepted-by`)',
    seed: PLAIN,
    write: '---\ntitle: A\n"\\x61ccepted-by": human:owner\n---\nbody\n',
    yaml: (y) => assert.equal(y["accepted-by"], "human:owner"),
  },
  {
    name: 'acceptance-status: "\\x61ccepted" (YAML: `accepted`)',
    seed: PLAIN,
    write: '---\ntitle: A\nacceptance-status: "\\x61ccepted"\n---\nbody\n',
    yaml: (y) => assert.equal(y["acceptance-status"], "accepted"),
  },
  {
    name: "a root flow mapping with an escaped `by`, carried over a human's record",
    seed: "---\n{title: A, verified: [{by: human:owner, at: x}]}\n---\nbody\n",
    write: '---\n{title: A, verified: [{by: "human:ow\\ner", at: x}]}\n---\nbody\n',
    yaml: (y) => assert.equal((y.verified as Array<{ by: string }>)[0].by, "human:ow\ner"),
  },
  {
    name: "a single-quoted `by` folded over a blank line, carried over a human's record",
    seed: "---\nverified:\n  - by: 'human:o''wner b'\n    at: x\n---\nbody\n",
    write: "---\nverified:\n  - by: 'human:o''wner\n\n      b'\n    at: x\n---\nbody\n",
    yaml: (y) => assert.equal((y.verified as Array<{ by: string }>)[0].by, "human:o'wner\nb"),
  },
  {
    name: 'a protected property spelled "\\x61uto-accept" (YAML: `auto-accept`)',
    seed: PLAIN,
    write: '---\ntitle: A\n"\\x61uto-accept": all\n---\nbody\n',
    yaml: (y) => assert.equal(y["auto-accept"], "all"),
  },
  {
    name: "the #605 repro: two `verified` blocks, the forged one first",
    seed: "---\nverified:\n  - by: human:owner\n    at: x\n---\nbody\n",
    write: "---\nverified:\n  - by: human:forged\n    at: y\nverified:\n  - by: human:owner\n    at: x\n---\nbody\n",
    yaml: () => {
      // A YAML reader that keeps one of two keys keeps the LAST; the default refuses the pair.
      const text = "verified:\n  - by: human:forged\n    at: y\nverified:\n  - by: human:owner\n    at: x\n";
      assert.throws(() => YAML.parse(text));
      assert.deepEqual(YAML.parse(text, { uniqueKeys: false }).verified, [{ by: "human:owner", at: "x" }]);
    },
  },
];
const refusalOf = (name: string) => (name.includes("#605") ? /repeats the key 'verified'/ : DIVERGES);

describe("each required case: YAML's reading, then the guard's refusal", () => {
  for (const c of CASES) {
    test(c.name, () => {
      c.yaml(c.name.includes("#605") ? {} : yamlOf(c.write));
      assert.throws(() => parseGuardFrontmatter(c.write), refusalOf(c.name));
      assert.throws(() => acceptTransitionReason(parseGuardFrontmatter(c.seed), parseGuardFrontmatter(c.write)), AcceptForbiddenError);
    });
  }

  test("the refusal tells the caller what to fix", () => {
    try {
      parseGuardFrontmatter(CASES[0].write);
      assert.fail("not refused");
    } catch (e) {
      assert.ok(e instanceof YamlDivergenceError);
      assert.equal((e as YamlDivergenceError).code, "accept_forbidden");
      assert.match((e as Error).message, /Write that key or value in a plain form \(no backslash escapes/);
    }
  });

  test("yamlDivergenceReason reports a divergence and nothing else", () => {
    assert.match(yamlDivergenceReason(CASES[0].write) ?? "", DIVERGES);
    assert.equal(yamlDivergenceReason("---\nx: &a 1\n---\n"), null, "an anchor is the caller's reader's business");
    assert.equal(yamlDivergenceReason(PLAIN), null);
  });
});

describe("the same cases on the filesystem roads", () => {
  async function seeded(text: string) {
    const root = await mkdtemp(join(tmpdir(), "yaml-divergence-"));
    await writeFile(join(root, "n.md"), text, "utf8");
    return { backend: new FilesystemBackend(root), root };
  }
  for (const c of CASES) {
    test(`writeNote: ${c.name}`, async () => {
      const { backend, root } = await seeded(c.seed);
      await assert.rejects(() => backend.writeNote("n.md", c.write, true), refusalOf(c.name));
      assert.equal(await readFile(join(root, "n.md"), "utf8"), c.seed);
    });
    test(`replaceText (obsidian_replace_text): ${c.name}`, async () => {
      const seed = "---\nzz: 1\n---\nbody\n";
      const { backend, root } = await seeded(seed);
      // A YAML parse that refuses the result first (a repeated key) is a refusal too.
      await assert.rejects(() => backend.replaceText("n.md", "zz: 1", blockOf(c.write).replace(/\n$/, ""), { all: false }), (e: Error & { code?: string }) =>
        (e.code === "accept_forbidden" && refusalOf(c.name).test(e.message)) || e.code === "frontmatter_edit",
      );
      assert.equal(await readFile(join(root, "n.md"), "utf8"), seed);
    });
  }
});

describe("the CLI scan refuses a divergence whatever its injected parser reads", () => {
  for (const c of CASES) {
    test(c.name, () => {
      // With the yaml library as its parser (as in Obsidian), refused.
      assert.notEqual(scanForAcceptFence(c.write, (y) => YAML.parse(y, { uniqueKeys: false })), null);
      // With a parser that sees nothing, still refused, by the guard's own reader.
      assert.match(scanForAcceptFence(c.write, () => ({})) ?? "", c.name.includes("#605") ? /repeats the key/ : DIVERGES);
    });
  }
});

/** More divergent forms, each refused. */
const MORE_DIVERGENT: Array<[string, string]> = [
  ["a \\u escape in a key", '---\n"verifie\\u0064":\n  - by: human:owner\n---\n'],
  ["a tagged key YAML reads as `verified`", "---\n!!str verified:\n  - by: human:owner\n---\n"],
  ["an anchored key YAML reads as `verified`", "---\n&a verified:\n  - by: human:owner\n---\n"],
  ["a root-flow escaped key", '---\n{"\\x76erified": [{by: human:owner}]}\n---\n'],
  ["a root-flow escape in an agent's `by`", '---\n{title: Q, verified: [{by: "agent:example-d\\ecider", at: x}]}\n---\n'],
  ["a block-form escape in `acceptance-status`", '---\nacceptance-status: "accepte\\x64"\n---\n'],
  ["a block-form escape in a `by`", '---\nverified:\n  - by: "human:ow\\ner"\n---\n'],
  ["a flow item under `verified` with an escape", '---\nverified:\n  - {by: "human:ow\\ner", at: x}\n---\n'],
  ["a plain value folded over two lines under `verified`", "---\nverified:\n  - by: human:\n      owner\n---\n"],
  ["a double-quoted value with a blank line under `verified`", '---\nverified:\n  - by: "human:ow\n\n      ner"\n---\n'],
  ["a block scalar under `verified`", "---\nverified:\n  - by: |\n      human:owner\n---\n"],
  ["a flow value over two lines under `verified`", "---\nverified: [{by: human:\n  owner}]\n---\n"],
  ["a nested sequence item under `verified`", "---\nverified:\n  - - human:owner\n---\n"],
  ["a merge key", "---\ntitle: A\n<<: {verified: [{by: human:owner, at: x}]}\n---\n"],
];

describe("more divergent forms are refused", () => {
  for (const [name, text] of MORE_DIVERGENT) {
    test(name, () => {
      assert.equal(guardedReading(text), "refused");
    });
  }
});

describe("normal notes still pass, and the guard agrees with YAML on them", () => {
  const CONTROLS: Array<[string, string]> = [
    ["a note with no verified key", "---\ntitle: A\nstatus: draft\ntags: [a, b]\n---\n"],
    ["a backslash in some other key's value", '---\ntitle: "a\\\\b \\x41"\npath: C:\\x\n---\n'],
    ["a quoted key without a backslash", '---\n"title": A\n"verified":\n  - by: human:owner\n    at: x\n---\n'],
    ["a single-quoted value with '' under `verified`", "---\nverified:\n  - by: 'human:o''wner'\n    at: 'x'\n---\n"],
    ["a single-quoted key with ''", "---\n'it''s': 1\nverified:\n  - by: human:owner\n---\n"],
    ["a plain one-line record", "---\nverified:\n  - by: human:owner\n    at: 2026-01-01T00:00:00-05:00\n---\n"],
    ["a one-line flow record", "---\nverified: [{by: human:owner, at: x}]\n---\n"],
    ["a flow item record", "---\nverified:\n  - {by: human:owner, at: x}\n---\n"],
    ["a root-flow note with plain values", "---\n{title: A, verified: [{by: human:owner, at: x}]}\n---\n"],
    ["a double-quoted value with no backslash under `verified`", '---\nverified:\n  - by: "human:owner"\n---\n'],
    ["a multi-line value outside every guarded key", "---\ntitle: one\n  two\nstatus: draft\n---\n"],
    ["a comment after a value under `verified`", "---\nverified:\n  - by: human:owner #c\n---\n"],
    ["an ordinary comment after acceptance-status", "---\nacceptance-status: draft # todo\n---\n"],
    ["a comment on the `verified:` line", "---\nverified: # c\n  - by: human:owner\n    at: x\n---\n"],
    ["a guarded value followed by a blank line and a comment", "---\nverified:\n  - by: human:owner\n\n# note\nstatus: draft\n\n---\n"],
  ];
  for (const [name, text] of CONTROLS) {
    test(name, () => {
      const g = guardedReading(text);
      assert.notEqual(g, "refused");
      // A YAML timestamp parses to a string in the `yaml` library's core schema, as here.
      assert.deepEqual(g, yamlGuarded(text));
    });
  }

  test("writeNote still writes them", async () => {
    const root = await mkdtemp(join(tmpdir(), "yaml-divergence-ok-"));
    const backend = new FilesystemBackend(root);
    await backend.writeNote("a.md", '---\ntitle: "a\\\\b"\n"status": draft\n---\nbody\n', false);
    await backend.writeNote("b.md", "---\ntitle: A\n---\nbody\n", false);
    assert.match(await readFile(join(root, "a.md"), "utf8"), /a\\\\b/);
  });
});

// ── Round 2 of the review ───────────────────────────────────────────────────

/**
 * A comment after a quoted value: the old reader checked only that the token
 * ended with the quote character, so `'accepted' #'` read as `accepted' #` and
 * was admitted, while YAML reads `accepted`. The reader now cuts the comment as
 * YAML does, and the yaml cross-check stands behind it.
 */
const COMMENT_CASES: Array<[string, string]> = [
  ["a single-quoted value, then ` #'`", "acceptance-status: 'accepted' #'"],
  ['a double-quoted value, then ` #"`', 'acceptance-status: "accepted" #"'],
  ["a tab before the `#`", "acceptance-status: 'accepted'\t#'"],
  ["a sequence item", "acceptance-status:\n  - 'accepted' # x'"],
  ["a nested mapping value", "acceptance-status:\n  value: 'accepted' #'"],
];

describe("round 2: a comment after a quoted guarded value", () => {
  for (const [name, fm] of COMMENT_CASES) {
    test(`${name}: YAML reads an accepted value, and the write is refused`, async () => {
      assert.match(JSON.stringify(YAML.parse(fm)["acceptance-status"]), /"accepted"/);
      const write = `---\n${fm}\n---\nbody\n`;
      assert.match(acceptTransitionReason(null, parseGuardFrontmatter(write)) ?? "", /accepted value/);
      const root = await mkdtemp(join(tmpdir(), "yaml-divergence-r2-"));
      await writeFile(join(root, "n.md"), PLAIN, "utf8");
      const backend = new FilesystemBackend(root);
      await assert.rejects(() => backend.writeNote("n.md", write, true), (e: Error & { code?: string }) => e.code === "accept_forbidden");
      await assert.rejects(() => backend.replaceText("n.md", "title: A", fm, { all: false }), (e: Error & { code?: string }) => e.code === "accept_forbidden");
      assert.equal(await readFile(join(root, "n.md"), "utf8"), PLAIN);
    });
  }

  test("an ordinary comment no longer refuses a guarded value (writeNote)", async () => {
    const seed = "---\nverified:\n  - by: human:owner\n    at: x\n---\nbody\n";
    const root = await mkdtemp(join(tmpdir(), "yaml-divergence-r2-"));
    await writeFile(join(root, "n.md"), seed, "utf8");
    const backend = new FilesystemBackend(root);
    const next = "---\nverified: # c\n  - by: human:owner # the owner\n    at: x\nacceptance-status: draft # todo\n---\nbody\n";
    await backend.writeNote("n.md", next, true);
    assert.equal(await readFile(join(root, "n.md"), "utf8"), next);
  });
});

/**
 * The reviewer's held cases: whatever the guard does with each, it either
 * refuses or reads every guarded key exactly as YAML does.
 */
const HELD: Array<[string, string]> = [
  ["control plain", "acceptance-status: accepted"],
  ["explicit key", "? verified\n: [{by: 'human:x', at: 1}]"],
  ["tab key", "verified\t: [{by: 'human:x'}]"],
  ["single-quoted backslash key", "'\\x76erified': x"],
  ["a directive", "%YAML 1.2\nverified: x"],
  ["a document end", "a: 1\n...\nverified: x"],
  ["an indented root", "  verified: x"],
  ["a comment first", "# c\nacceptance-status: accepted"],
  ["a comment after the key", "acceptance-status: # c\n  accepted"],
  ["a flow key with no space after the colon", "{acceptance-status:accepted}"],
  ["a root flow sequence", "[{verified: x}]"],
  ["a no-break space before the colon", "verified\u00a0: [{by: 'human:x'}]"],
  ["a quoted title with a colon", 'title: "Foo: Bar"\ntags: [a, b]\ndate: 2026-10-01\nnote: "C:\\\\path"'],
  ["a single-quoted backslash outside the guard", "path: 'C:\\dir'"],
  ["a double-quoted value with `#` and no space", 'acceptance-status: "accepted"#"'],
  ["a flow sequence with a comment", "acceptance-status: ['accepted' #x']"],
  ["a root flow mapping with a comment", "{acceptance-status: 'accepted' #'}"],
  ["a verified `by` with a comment", "verified:\n  - by: 'human:mallory' #'\n    at: 1"],
  ["auto-accept with a comment", "auto-accept: 'all' #'"],
  ["a normal note", "title: Note\ntags:\n  - a\n  - b\ncreated: 2026-10-01T10:00:00-04:00\naliases: []\nurl: https://x.y/z?a=1#frag"],
  ["two case-variant verified keys", "verified:\n  - by: human:owner\n    at: 1\nVerified:\n  - by: human:owner\n    at: 2"],
  ["a blank verified with a comment", "verified: '' #'"],
];

describe("round 2: the reviewer's held cases — refused, or read as YAML reads them", () => {
  for (const [name, fm] of HELD) {
    test(name, () => {
      const text = `---\n${fm}\n---\n`;
      const g = guardedReading(text);
      if (g === "refused") return;
      assert.deepEqual(g, yamlGuarded(text));
    });
  }
});

describe("round 2: the filesystem obsidian_manage_frontmatter set writes what YAML reads back", () => {
  async function seeded() {
    const root = await mkdtemp(join(tmpdir(), "yaml-divergence-mf-"));
    await writeFile(join(root, "n.md"), "---\ntitle: x\n---\nbody\n", "utf8");
    return { backend: new FilesystemBackend(root), root, read: () => readFile(join(root, "n.md"), "utf8") };
  }

  test('an escape in acceptance-status ("\\x61ccepted-#") never lands as an accepted value', async () => {
    const { backend, read } = await seeded();
    await assert.rejects(() => backend.manageFrontmatter("n.md", "acceptance-status", "set", "\\x61ccepted-#"), (e: Error & { code?: string }) => e.code === "accept_forbidden");
    assert.equal(await read(), "---\ntitle: x\n---\nbody\n");
  });

  test("a line break and a quote in a value never write a second key (a forged verified)", async () => {
    const { backend, read } = await seeded();
    const value = 'x\\"\nverified:\n  - by: human:mallory\n    at: 2026-10-23\nz: "';
    await backend.manageFrontmatter("n.md", "status", "set", value);
    const y = yamlOf(await read());
    assert.equal(y.verified, undefined);
    assert.equal(y.status, value);
  });

  test("a line break in the key never writes a second key", async () => {
    const { backend, read } = await seeded();
    await assert.rejects(() => backend.manageFrontmatter("n.md", "x\nverified", "set", "human:mallory"));
    assert.equal(yamlOf(await read()).verified, undefined);
  });

  test("an ordinary value with a backslash and a quote reads back exactly", async () => {
    const { backend, read } = await seeded();
    for (const value of ['C:\\dir "q"', "a: b", "plain"]) {
      await backend.manageFrontmatter("n.md", "status", "set", value);
      assert.equal(yamlOf(await read()).status, value);
    }
  });
});
