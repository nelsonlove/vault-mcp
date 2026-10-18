// The Claude Code plugin's record write guard (cc-plugin/hooks/scripts/block-record-writes.sh):
// a note is a record when its frontmatter carries `record: true`. The hook is run as Claude Code
// runs it — the PreToolUse JSON on stdin, exit 2 to refuse — against a scratch vault found through
// a scratch discovery dir (VAULT_MCP_DISCOVERY_DIR), never the real one.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "cc-plugin", "hooks", "scripts", "block-record-writes.sh");

let tmp, vault, disc;
const REC = "Notes/A record.md";
const PLAIN = "Notes/Plain.md";
const LOCKED = "Notes/Locked.md";
const MENTIONS = "Notes/Machinery record notes.md";
const CRLF = "Notes/Crlf.md";
const CAPS = "Notes/Caps.md";
const DASH = "Notes/A - record.md";
const BIN = "Notes/picture.png";

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "record-hook-"));
  vault = join(tmp, "vault");
  disc = join(tmp, "disc");
  mkdirSync(join(vault, "Notes"), { recursive: true });
  mkdirSync(disc);
  writeFileSync(join(vault, REC), "---\ntitle: A record\nrecord: true\n---\n\nbody\n");
  writeFileSync(join(vault, PLAIN), "---\ntitle: Plain\n---\n\nrecord: true is only body text here\n");
  writeFileSync(join(vault, MENTIONS), "---\ntitle: x\n---\n\nThe Machinery record folder is gone.\n");
  writeFileSync(join(vault, LOCKED), "---\nrecord: true\n---\n");
  writeFileSync(join(vault, CRLF), "\ufeff---\r\ntitle: c\r\nrecord: true\r\n---\r\nbody\r\n");
  writeFileSync(join(vault, CAPS), '---\nrecord: "TRUE"\n---\n');
  writeFileSync(join(vault, DASH), "---\nrecord: true\n---\n");
  writeFileSync(join(vault, BIN), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x0a]));
  chmodSync(join(vault, LOCKED), 0o000);
  writeFileSync(join(disc, "scratch.json"), JSON.stringify({ vault_path: vault, vault_name: "scratch" }));
});
after(() => {
  try { chmodSync(join(vault, LOCKED), 0o644); } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

function run(payload) {
  const r = spawnSync("bash", [HOOK], { input: JSON.stringify(payload), env: { ...process.env, VAULT_MCP_DISCOVERY_DIR: disc }, encoding: "utf8" });
  return { code: r.status, err: r.stderr };
}
const bash = (command, cwd = vault) => run({ tool_name: "Bash", tool_input: { command }, cwd });
const mcp = (tool, args) => run({ tool_name: `mcp__vault-mcp__${tool}`, tool_input: args, cwd: tmp });

describe("Bash: a write to a record: true file is refused, an append passes", () => {
  test("truncating redirect, tee, sed -i, mv, rm and trash on a record refuse", () => {
    for (const cmd of [
      `echo x > '${REC}'`,
      `echo x &> "${REC}"`,
      `echo x | tee '${REC}'`,
      `sed -i.bak 's/a/b/' '${REC}'`,
      `mv '${REC}' Notes/Other.md`,
      `cp Notes/Plain.md '${REC}'`,
      `rm '${REC}'`,
      `/usr/bin/trash '${join(vault, REC)}'`,
    ]) {
      const r = bash(cmd);
      assert.equal(r.code, 2, cmd);
      assert.match(r.err, /record: true/, cmd);
    }
  });
  test("#560 review 1: CRLF and BOM, capital spellings, escaped and $'' paths, every sed in-place form, other overwrites", () => {
    for (const cmd of [
      `echo x > ${CRLF}`,
      `echo x > ${CAPS}`,
      `echo x > Notes/A\\ record.md`,
      `echo x > $'Notes/A record.md'`,
      `echo x >| '${REC}'`,
      `sed -Ei 's/a/b/' '${REC}'`,
      `sed -e 's/a/b/' -i '${REC}'`,
      `sed --in-place 's/a/b/' '${REC}'`,
      `truncate -s0 '${REC}'`,
      `dd if=/dev/null of='${REC}'`,
      `rsync Notes/Plain.md '${REC}'`,
      `ln -sf Notes/Plain.md '${REC}'`,
    ]) assert.equal(bash(cmd).code, 2, cmd);
  });
  test("#560 review 1: copying OUT of a record is a read, and passes; &>> is an append", () => {
    assert.equal(bash(`cp '${REC}' /tmp/backup-of-record.md`).code, 0);
    assert.equal(bash(`rsync '${REC}' /tmp/x.md`).code, 0);
    assert.equal(bash(`echo x &>> '${REC}'`).code, 0);
  });
  test("#560 review 2: trailing redirects and options, command paths and g-prefixes, dd of= bare, REC.bak is not REC", () => {
    for (const cmd of [
      `cp /tmp/x '${REC}' 2>/dev/null`,
      `cp /tmp/x '${REC}' >/dev/null 2>&1`,
      `cp /tmp/x '${REC}' -f`,
      `cp /tmp/x '${REC}' # overwrite`,
      `/usr/bin/sed -i '' s/a/b/ '${REC}'`,
      `gsed -i s/a/b/ '${REC}'`,
      `/bin/mv '${REC}' /tmp/x`,
      `/bin/rm '${REC}'`,
      `dd if=/dev/null of=${CRLF}`,
    ]) assert.equal(bash(cmd).code, 2, cmd);
    assert.equal(bash(`cp '${REC}' '${REC}.bak'; rm '${REC}.bak'`).code, 0, "REC.bak is another file");
    const r = bash(`echo x > '${REC}'`);
    assert.doesNotMatch(r.err, /stray/, "no grep warning noise");
  });
  test("#560 review 3: a cp inside ( ), a quoted path with ' - ', and a binary file is not 'unreadable'", () => {
    assert.equal(bash(`(cp /tmp/x '${REC}')`).code, 2);
    assert.equal(bash(`echo $(cp /tmp/x '${REC}')`).code, 2);
    assert.equal(bash(`cp /tmp/x "${DASH}"`).code, 2);
    assert.equal(bash(`cp /tmp/x '${DASH}' -f`).code, 2);
    assert.equal(bash(`rm '${BIN}'`).code, 0, "a binary attachment reads as a plain file");
    assert.equal(bash(`/usr/bin/sed -i.bak s/a/b/ '${PLAIN}'`).code, 0, "the sed binary itself is not an unreadable record");
  });
  test("a long command with no record in it stays fast", () => {
    const words = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    const t0 = Date.now();
    assert.equal(bash(`echo ${words} > Notes/New.md`).code, 0);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  });
  test("an append to a record passes, and a heredoc body may name it", () => {
    assert.equal(bash(`echo entry >> '${REC}'`).code, 0);
    assert.equal(bash(`echo entry | tee -a '${REC}'`).code, 0);
    assert.equal(bash(`cat <<'EOF' >> '${REC}'\n> quoting ${REC} > here\nEOF`).code, 0);
  });
  test("the same writes on a plain note pass, and a mention of the old folder name no longer refuses", () => {
    assert.equal(bash(`echo x > '${PLAIN}'`).code, 0);
    assert.equal(bash(`rm '${MENTIONS}'`).code, 0);
    assert.equal(bash(`echo "see Machinery record/x.md" > '${PLAIN}'`).code, 0);
    assert.equal(bash(`echo x > 'Notes/New file.md'`).code, 0, "a file that does not exist is not a record");
  });
  test("an existing target that cannot be read fails closed", { skip: process.getuid?.() === 0 }, () => {
    const r = bash(`echo x > '${LOCKED}'`);
    assert.equal(r.code, 2);
    assert.match(r.err, /cannot be read/);
  });
});

describe("vault-mcp tools: a mutation naming a record note is refused", () => {
  test("write, patch, frontmatter, move (either end) and trash on a record refuse", () => {
    for (const [tool, args] of [
      ["obsidian_write_note", { path: REC, content: "x" }],
      ["obsidian_patch_note", { path: REC, old: "a", new: "b" }],
      ["obsidian_manage_frontmatter", { path: "Notes/A record", key: "k", value: "v" }],
      ["obsidian_move_note", { from: REC, to: "Notes/B.md" }],
      ["obsidian_move_notes", { moves: [{ from: PLAIN, to: "x.md" }, { from: REC, to: "y.md" }] }],
      ["obsidian_trash", { path: `/${REC}` }],
    ]) {
      const r = mcp(tool, args);
      assert.equal(r.code, 2, tool);
      assert.match(r.err, /record: true/, tool);
    }
  });
  test("Code Mode is checked by its inner tool name", () => {
    assert.equal(run({ tool_name: "mcp__vault-mcp__obsidian_call_tool", tool_input: { name: "obsidian_write_note", arguments: { path: REC } } }).code, 2);
    assert.equal(run({ tool_name: "mcp__vault-mcp__obsidian_call_tool", tool_input: { name: "obsidian_append_note", arguments: { path: REC } } }).code, 0);
  });
  test("append, reads, plain notes and a text that only names the old folder pass", () => {
    assert.equal(mcp("obsidian_append_note", { path: REC, content: "x" }).code, 0);
    assert.equal(mcp("obsidian_read_note", { path: REC }).code, 0);
    assert.equal(mcp("obsidian_write_note", { path: PLAIN, content: "x" }).code, 0);
    assert.equal(mcp("obsidian_write_note", { path: "Notes/Entry.md", content: "the Machinery record folder" }).code, 0);
    assert.equal(mcp("obsidian_patch_note", { path: PLAIN, new: REC }).code, 2, "a record path in any short string refuses: over-refusing is the safe direction");
  });
  test("an unreadable existing target fails closed; no discovered vault leaves it to the host", { skip: process.getuid?.() === 0 }, () => {
    assert.equal(mcp("obsidian_write_note", { path: LOCKED, content: "x" }).code, 2);
    const r = spawnSync("bash", [HOOK], { input: JSON.stringify({ tool_name: "mcp__vault-mcp__obsidian_write_note", tool_input: { path: REC } }), env: { ...process.env, VAULT_MCP_DISCOVERY_DIR: join(tmp, "none") }, encoding: "utf8" });
    assert.equal(r.status, 0);
  });
});
