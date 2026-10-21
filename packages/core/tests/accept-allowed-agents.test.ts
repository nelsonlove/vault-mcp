/**
 * accept-allowed-agents.test.ts — the allowed-agent append: the one
 * configurable exception to the `verified` floor (accept-guard.ts).
 *
 * Every name here is made up: `agent:example-decider` and `human:owner`. The
 * operator's own value lives only in local settings, never in code.
 *
 * Covered: the empty default refuses exactly as before; a listed agent's exact
 * entry is admitted with the verify's status move; every variant the ruling
 * names is refused; the status machine is the Verify verb's step 7; and the
 * filesystem road (FilesystemBackend, which the fs server serves) runs the
 * same predicate.
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptTransitionReason,
  acceptForbiddenReason,
  hasHumanVerification,
  parseGuardFrontmatter,
  setAcceptAllowedAgents,
  acceptAllowedAgents,
  setAcceptStatusTableLookup,
  verifyStatusMove,
  resolveStatusTransitions,
  normalizeAcceptAllowedAgents,
  normalizeAcceptOnBehalfOf,
  ALLOWED_AGENT_ENTRY_REQUIRED_KEYS,
  ALLOWED_AGENT_ENTRY_BINDING_KEYS,
  type StatusTableLookupResult,
} from "../src/accept-guard.js";
import { FilesystemBackend } from "../src/fs-backend/filesystem-backend.js";

const silent = () => {};
const AGENT = "agent:example-decider";
const HUMAN = "human:owner";
const TABLE = { "draft/proposed": ["stable/open", "archived/cancelled"], "stable/open": ["stable/done"] };

function allow() {
  setAcceptAllowedAgents({ agents: [AGENT], onBehalfOf: HUMAN }, silent);
}
function tableLookup(result: StatusTableLookupResult = { state: "table", table: TABLE }) {
  setAcceptStatusTableLookup(() => result);
}
function reset() {
  setAcceptAllowedAgents(null, silent);
  setAcceptStatusTableLookup(null);
}

const entry = (extra: Record<string, unknown> = {}) => ({
  by: AGENT,
  "on-behalf-of": HUMAN,
  at: "2026-01-02T03:04:05-05:00",
  experiment: "example-experiment",
  ...extra,
});
const humanEntry = { by: "human:owner", at: "2026-01-01T09:00:00-05:00" };
const draft = (extra: Record<string, unknown> = {}) => ({ title: "Q", type: "Task/Example", status: "draft/proposed", ...extra });

beforeEach(reset);
after(reset);

describe("the empty default refuses exactly as before", () => {
  test("no agents listed: an agent's entry is refused with today's text, byte for byte", () => {
    tableLookup();
    const before = draft();
    const afterFm = draft({ status: "stable/open", verified: [entry()] });
    assert.equal(acceptTransitionReason(before, afterFm), "write would introduce the verification field 'verified'");
    const withPrior = { ...before, verified: [humanEntry] };
    assert.equal(
      acceptTransitionReason(withPrior, { ...afterFm, verified: [humanEntry, entry()] }),
      "write would change the verification field 'verified'",
    );
  });

  test("agents listed but no human named: nothing is admitted", () => {
    tableLookup();
    setAcceptAllowedAgents({ agents: [AGENT], onBehalfOf: "" }, silent);
    assert.equal(acceptAllowedAgents().onBehalfOf, null);
    assert.equal(acceptTransitionReason(draft(), draft({ status: "stable/open", verified: [entry()] })), "write would introduce the verification field 'verified'");
  });

  test("the shipped default is empty, and setting null restores it", () => {
    allow();
    setAcceptAllowedAgents(null, silent);
    assert.deepEqual(acceptAllowedAgents(), { agents: [], onBehalfOf: null });
  });
});

describe("a listed agent's exact entry is appended and moves the status", () => {
  test("first entry on a draft note, with the class's draft → stable move", () => {
    allow();
    tableLookup();
    assert.equal(acceptTransitionReason(draft(), draft({ status: "stable/open", verified: [entry()] })), null);
  });

  test("appended after a human's existing entry, which is carried forward unchanged", () => {
    allow();
    tableLookup();
    // A stable note: a verify moves nothing.
    const before = draft({ status: "stable/open", verified: [humanEntry] });
    assert.equal(acceptTransitionReason(before, { ...before, verified: [humanEntry, entry()] }), null);
  });

  test("a single entry stored as a bare mapping reads as a one-item list", () => {
    allow();
    tableLookup();
    const before = draft({ status: "stable/open", verified: humanEntry });
    assert.equal(acceptTransitionReason(before, { ...before, verified: [humanEntry, entry()] }), null);
  });

  test("every binding key the ruling adopted is admitted", () => {
    allow();
    tableLookup();
    const bound = entry({
      rev: 41,
      sha: "0123456789abcdef0123456789abcdef01234567",
      paths: ["Notes/a.md", "Notes/b.md"],
      "option-digest": "0123456789ab",
      created: "2026-01-02T03:04:05-05:00",
      expires: "2026-01-09T03:04:05-05:00",
      consumed: false,
    });
    assert.equal(acceptTransitionReason(draft(), draft({ status: "stable/open", verified: [bound] })), null);
    assert.deepEqual([...ALLOWED_AGENT_ENTRY_REQUIRED_KEYS], ["by", "on-behalf-of", "at", "experiment"]);
    assert.deepEqual([...ALLOWED_AGENT_ENTRY_BINDING_KEYS], ["rev", "sha", "paths", "option-digest", "created", "expires", "consumed"]);
  });

  test("a bare `draft` with no table moves to `stable`, as the verb does", () => {
    allow();
    tableLookup({ state: "none" });
    assert.equal(acceptTransitionReason({ status: "draft" }, { status: "stable", verified: [entry()] }), null);
  });

  test("the entry does not count as a human verification (rule 8 stays human)", () => {
    assert.equal(hasHumanVerification({ verified: [entry()] }), false);
  });

  test("other edits in the same write still pass through the rest of the guard", () => {
    allow();
    tableLookup();
    assert.match(
      acceptTransitionReason(draft(), draft({ status: "stable/open", verified: [entry()], "accepted-by": "x" })) ?? "",
      /introduce the acceptance field 'accepted-by'/,
    );
  });
});

describe("every other change to `verified` stays refused", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, RegExp]> = [
    ["a human actor in `by`", draft(), draft({ status: "stable/open", verified: [entry({ by: "human:owner" })] }), /^write would introduce the verification field 'verified'$/],
    ["an unlisted agent", draft(), draft({ status: "stable/open", verified: [entry({ by: "agent:someone-else" })] }), /^write would introduce the verification field 'verified'$/],
    ["a `by` that only looks like the listed one", draft(), draft({ status: "stable/open", verified: [entry({ by: " agent:example-decider" })] }), /^write would introduce the verification field 'verified'$/],
    ["two entries in one write", draft(), draft({ status: "stable/open", verified: [entry(), entry()] }), /append exactly one entry/],
    ["an existing entry changed", draft({ status: "stable/open", verified: [humanEntry] }), draft({ status: "stable/open", verified: [{ ...humanEntry, at: "2026-01-01T10:00:00-05:00" }, entry()] }), /existing entry 1 would change/],
    ["an existing entry replaced", draft({ status: "stable/open", verified: [humanEntry] }), draft({ status: "stable/open", verified: [entry()] }), /append exactly one entry/],
    ["an existing entry removed while two are added", draft({ status: "stable/open", verified: [humanEntry] }), draft({ status: "stable/open", verified: [entry(), entry({ experiment: "b" })] }), /existing entry 1 would change/],
    ["the entry moved ahead of the existing one", draft({ status: "stable/open", verified: [humanEntry] }), draft({ status: "stable/open", verified: [entry(), humanEntry] }), /^write would change the verification field 'verified'$/],
    ["a key outside the allowed set", draft(), draft({ status: "stable/open", verified: [entry({ note: "x" })] }), /outside the allowed keys/],
    ["a case variant of an allowed key", draft(), draft({ status: "stable/open", verified: [entry({ Experiment: "x" })] }), /outside the allowed keys/],
    ["`experiment` missing", draft(), draft({ status: "stable/open", verified: [{ by: AGENT, "on-behalf-of": HUMAN, at: "2026-01-02T03:04:05-05:00" }] }), /lacks 'experiment'/],
    ["`on-behalf-of` not the configured human", draft(), draft({ status: "stable/open", verified: [entry({ "on-behalf-of": "human:someone" })] }), /on-behalf-of/],
    ["`at` without an offset", draft(), draft({ status: "stable/open", verified: [entry({ at: "2026-01-02 03:04" })] }), /'at' must be a stamp/],
    ["`consumed: true`", draft(), draft({ status: "stable/open", verified: [entry({ consumed: true })] }), /'consumed' may only be false/],
    ["a short `sha`", draft(), draft({ status: "stable/open", verified: [entry({ sha: "abc1234" })] }), /'sha' must be a full/],
    ["an `option-digest` of the wrong length", draft(), draft({ status: "stable/open", verified: [entry({ "option-digest": "abc" })] }), /'option-digest'/],
    ["empty `paths`", draft(), draft({ status: "stable/open", verified: [entry({ paths: [] })] }), /'paths'/],
    ["a nested value in an allowed key", draft(), draft({ status: "stable/open", verified: [entry({ rev: { n: 1 } })] }), /'rev'/],
    ["the status not moved", draft(), draft({ verified: [entry()] }), /move status from 'draft\/proposed' to 'stable\/open'/],
    ["the status moved somewhere else", draft(), draft({ status: "archived/cancelled", verified: [entry()] }), /move status from 'draft\/proposed' to 'stable\/open'/],
    ["the status moved on a stable note", draft({ status: "stable/open", verified: [humanEntry] }), draft({ status: "stable/done", verified: [humanEntry, entry()] }), /leave status at 'stable\/open'/],
    ["a captured note", { status: "captured" }, { status: "captured", verified: [entry()] }, /file it before/],
    ["an archived note", { status: "archived/done" }, { status: "archived/done", verified: [entry()] }, /archived note/],
    ["a note with no status", { title: "Q" }, { title: "Q", verified: [entry()] }, /no status/],
    ["a case variant of the key", draft(), draft({ status: "stable/open", Verified: [entry()] }), /^write would introduce the verification field 'Verified'$/],
    ["two `verified` keys in the result", draft(), draft({ status: "stable/open", verified: [entry()], Verified: [entry()] }), /more than one 'verified' key/],
    ["a blank existing record", draft({ verified: [] }), draft({ status: "stable/open", verified: [entry()] }), /blank/],
    ["a bare mapping as the result", draft(), draft({ status: "stable/open", verified: entry() }), /^write would introduce the verification field 'verified'$/],
  ];
  for (const [name, before, afterFm, want] of cases) {
    test(name, () => {
      allow();
      tableLookup();
      assert.match(acceptTransitionReason(before, afterFm) ?? "(admitted)", want);
    });
  }

  test("a new note (no before at all) is refused", () => {
    allow();
    tableLookup();
    assert.match(acceptTransitionReason(null, draft({ status: "stable/open", verified: [entry()] })) ?? "(admitted)", /must already exist/);
  });

  test("the payload-only roads (acceptForbiddenReason) refuse the entry by presence, listed or not", () => {
    allow();
    assert.match(acceptForbiddenReason({ verified: [entry()] }) ?? "", /verification field 'verified'/);
  });

  test("a separator variant key stays refused beside an admitted entry", () => {
    allow();
    tableLookup();
    assert.match(
      acceptTransitionReason(draft(), draft({ status: "stable/open", verified: [entry()], "verified-by": AGENT })) ?? "",
      /introduce the verification field 'verified-by'/,
    );
  });

  test("removing an existing record stays refused", () => {
    allow();
    tableLookup();
    assert.match(acceptTransitionReason(draft({ verified: [humanEntry] }), draft()) ?? "", /remove the verification field/);
  });

  test("with no status machine wired, a draft that needs the class table is refused (fail closed)", () => {
    allow();
    assert.match(acceptTransitionReason(draft(), draft({ status: "stable/open", verified: [entry()] })) ?? "", /cannot be read on this road/);
    // A stable note needs no table: its verify moves nothing.
    const st = draft({ status: "stable/open", verified: [humanEntry] });
    assert.equal(acceptTransitionReason(st, { ...st, verified: [humanEntry, entry()] }), null);
  });

  test("a lookup that throws reads as unavailable, never as admitted", () => {
    allow();
    setAcceptStatusTableLookup(() => {
      throw new Error("boom");
    });
    assert.match(acceptTransitionReason(draft(), draft({ status: "stable/open", verified: [entry()] })) ?? "", /reading the class failed: boom/);
  });
});

describe("the status machine is the Verify verb's step 7", () => {
  const T = (table: Record<string, unknown>): StatusTableLookupResult => ({ state: "table", table });
  test("draft moves to the first listed stable target", () => {
    assert.deepEqual(verifyStatusMove("draft/proposed", T({ "draft/proposed": ["archived/cancelled", "stable/open"] })), { next: "stable/open" });
  });
  test("a table entry with no stable target is refused", () => {
    assert.ok("refused" in verifyStatusMove("draft/proposed", T({ "draft/proposed": ["archived/cancelled"] })));
  });
  test("bare draft with no entry moves to stable; refined draft with no table is refused; an unknown value is refused", () => {
    assert.deepEqual(verifyStatusMove("draft", { state: "none" }), { next: "stable" });
    assert.deepEqual(verifyStatusMove("draft", T({ "stable/open": [] })), { next: "stable" });
    assert.ok("refused" in verifyStatusMove("draft/proposed", { state: "none" }));
    assert.ok("refused" in verifyStatusMove("draft/odd", T({ "draft/proposed": ["stable/open"] })));
  });
  test("a non-draft status stays; captured and archived are refused", () => {
    assert.deepEqual(verifyStatusMove("stable/open", { state: "unavailable", why: "x" }), { next: "stable/open" });
    assert.ok("refused" in verifyStatusMove("captured", { state: "none" }));
    assert.ok("refused" in verifyStatusMove("archived/done", { state: "none" }));
  });
  test("the class chain: nearest declaration wins, a pointer is followed, a dangling pointer is none", () => {
    const classes: Record<string, Record<string, unknown>> = {
      "Task/Example": { extends: "Task" },
      Task: { "status-transitions": "[[Global]]" },
      Global: { "status-transitions": TABLE },
      Odd: { "status-transitions": "Missing" },
      Child: { extends: "[[Odd]]" },
    };
    const read = (n: string) => classes[n] ?? null;
    assert.deepEqual(resolveStatusTransitions("Task/Example", read), { state: "table", table: TABLE });
    assert.deepEqual(resolveStatusTransitions("Child", read), { state: "none" });
    assert.deepEqual(resolveStatusTransitions(null, read), { state: "none" });
    assert.deepEqual(resolveStatusTransitions("Nope", read), { state: "none" });
  });
});

describe("the settings normalizers", () => {
  test("names are kept as agent:<name>; anything else is dropped loudly", () => {
    const warned: string[] = [];
    const out = normalizeAcceptAllowedAgents(["agent:example-decider", "other.agent", "human:owner", "has space", 7, "", "agent:example-decider"], (m) => warned.push(m));
    assert.deepEqual(out, ["agent:example-decider", "agent:other.agent"]);
    assert.equal(warned.length, 3);
    assert.deepEqual(normalizeAcceptAllowedAgents("agent:x", silent), [], "a non-list is the empty list");
  });
  test("the human must be human:<name>", () => {
    assert.equal(normalizeAcceptOnBehalfOf("human:owner", silent), "human:owner");
    assert.equal(normalizeAcceptOnBehalfOf("owner", silent), null);
    assert.equal(normalizeAcceptOnBehalfOf("human:", silent), null);
    assert.equal(normalizeAcceptOnBehalfOf(undefined, silent), null);
  });
});

describe("the filesystem road (FilesystemBackend, served by the fs server) runs the same predicate", () => {
  const BEFORE = "---\ntitle: Q\ntype: Task/Example\nstatus: draft/proposed\n---\n\n# Q\n";
  const AFTER =
    "---\ntitle: Q\ntype: Task/Example\nstatus: stable/open\nverified:\n  - by: agent:example-decider\n    on-behalf-of: human:owner\n    at: 2026-01-02T03:04:05-05:00\n    experiment: example-experiment\n---\n\n# Q\n";

  async function seeded(): Promise<{ backend: FilesystemBackend; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "accept-allowed-agents-"));
    await writeFile(join(root, "q.md"), BEFORE, "utf8");
    return { backend: new FilesystemBackend(root), root };
  }

  test("with the default (what the fs server always runs), the write is refused and nothing lands", async () => {
    const { backend, root } = await seeded();
    await assert.rejects(() => backend.writeNote("q.md", AFTER, true), /accept_forbidden|verification field 'verified'/);
    assert.equal(await readFile(join(root, "q.md"), "utf8"), BEFORE);
  });

  test("with the exception configured in-process, the same write lands; the parsed entry is exactly what was written", async () => {
    allow();
    tableLookup();
    const { backend, root } = await seeded();
    await backend.writeNote("q.md", AFTER, true);
    const fm = parseGuardFrontmatter(await readFile(join(root, "q.md"), "utf8"));
    assert.deepEqual(fm?.verified, [entry()]);
    assert.equal(fm?.status, "stable/open");
  });

  test("manage_frontmatter set on the fs road cannot express an entry (scalars only), so it stays refused with the exception on", async () => {
    allow();
    tableLookup();
    const root = await mkdtemp(join(tmpdir(), "accept-allowed-agents-"));
    const STABLE = "---\nstatus: stable/open\n---\nbody\n";
    await writeFile(join(root, "s.md"), STABLE, "utf8");
    const backend = new FilesystemBackend(root);
    await assert.rejects(() => backend.manageFrontmatter("s.md", "verified", "set", [AGENT]), /verification field 'verified'/);
    await assert.rejects(() => backend.manageFrontmatter("s.md", "verified", "set", AGENT), /verification field 'verified'/);
    assert.equal(await readFile(join(root, "s.md"), "utf8"), STABLE);
  });
});
