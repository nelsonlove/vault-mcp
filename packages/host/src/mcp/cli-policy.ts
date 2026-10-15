// cli-policy.ts — the settings-driven command allow/deny policy for the two
// arbitrary-execution surfaces, closing the accept-scar's last residual.
//
// The accept-forbidden guard (write-notes-compose.ts, cliAcceptRefusal) covers
// every INSPECTABLE write: MCP primitives, CLI property sets, CLI content
// writes. What it cannot cover is opaque execution — `quickadd` macros, `eval`,
// `command`, and `obsidian_run_command` ids — where acceptance could be set
// inside code the guard never sees. Until now that was a documented residual;
// this module closes it by FAILING CLOSED: the opaque-accept set is DENIED by
// default, and re-enabling a specific command is a HUMAN-ONLY act (a plugin
// setting, reachable through the Obsidian settings tab / data.json). The
// human-only property is enforced, not assumed: the MCP write primitives
// refuse non-`.md` paths structurally; the opaque surfaces that could write
// settings from inside (`eval`/`command`/quickadd macros) are what this
// policy denies by default; and the CLI proxy's own param values are barred
// from `.obsidian` territory by `configPathRefusal` below, so the inspectable
// CLI write commands cannot target data.json either — whatever the external
// binary's path handling turns out to be.
//
// Policy semantics, in evaluation order:
//   1. `deny` (settings) — always refused. Deny BEATS allow: a command both
//      denied and re-enabled is refused, so a hand-edited data.json cannot be
//      talked into a contradictory state that fails open.
//   2. The built-in opaque-accept set — refused unless the human re-enabled
//      that specific entry via `allowOpaque`.
//   3. Everything else — allowed by this policy (the existing danger gate and
//      accept guard still apply downstream; this policy COMPOSES with them,
//      it replaces nothing. `eval`/`command` re-enabled here still need the
//      "Allow dangerous CLI commands" toggle — two locks, both human).
//
// Entries are exact command names, or prefix globs written `prefix*` (used as
// `quickadd:*` for run_command ids). Matching is case-sensitive on purpose,
// like the danger gate: the CLI's commands are lowercase, and a
// case-insensitive match here could diverge from the case-sensitive gates
// downstream.
//
// Pure and obsidian-free: unit-tested directly; the tool handlers call the
// two refusal functions with the settings-supplied policy.

/** The opaque-accept set for `obsidian_cli`: commands that execute arbitrary
 * macros/JS/commands and could set acceptance where no guard can inspect.
 * DENIED by default. (Also the tool-description list — one source.) */
export const OPAQUE_ACCEPT_CLI_COMMANDS = [
  "quickadd",
  "quickadd:run",
  "quickadd:run-template",
  "eval",
  "command",
] as const;

/** The opaque-accept set for `obsidian_run_command` ids: QuickAdd's commands
 * run macros (arbitrary user-defined JS), and js-engine's commands execute
 * arbitrary vault JS — both `js-engine:execute-js-file` and the
 * `js-engine:cmd-*` ids that a vault's register-commands startup script mints
 * from files in its commands folder. An agent can WRITE such a file through
 * the ordinary guarded path (a JS body carries no acceptance frontmatter, so
 * the accept-guard rightly passes it) and would then have an arbitrary-JS
 * springboard the guard cannot inspect — the same laundering class the
 * `quickadd:*` deny closed (#105). Everything else a command id can do is
 * bounded by the plugin that registered it and stays allowed. */
export const OPAQUE_ACCEPT_COMMAND_IDS = ["quickadd:*", "js-engine:*"] as const;

/** Commands that WRITE note content the acceptance guard cannot inspect before
 * it lands. `history:restore` reinstates a prior version of a note, which can
 * reintroduce an `accepted` value a human deliberately revoked — and the CLI
 * cannot surface the to-be-restored bytes pre-exec, so the accept guard (which
 * scans `property:set` and content-write payloads) has nothing to look at here.
 * Same "uninspectable ⇒ refuse" discipline as the opaque-accept set: DENIED by
 * default, re-enabled only per-command through the human-only `allowOpaque`
 * setting. (#110) */
export const UNINSPECTABLE_WRITE_CLI_COMMANDS = ["history:restore"] as const;

/** The `cliPolicy` settings row. Absent/empty ⇒ the defaults: opaque-accept
 * set denied, everything else allowed. */
export interface CliCommandPolicy {
  /** Additional denied entries, checked first — deny beats allow. Exact
   * names or `prefix*` globs. */
  deny?: string[];
  /** Opaque-accept entries the human re-enabled. An exact entry re-enables one
   * CLI command or one run_command id. A trailing `*` (`quickadd:choice:*`)
   * re-enables a family of RUN_COMMAND IDS only (Nelson, 2026-10-14: "can we get
   * a PR to permit wildcards in the 'Re-enabled opaque commands' setting?"),
   * with two limits that keep a glob from reaching further than meant:
   *   - it never re-enables a CLI command (`quickadd:*` meant for command ids
   *     must not re-enable the CLI's `quickadd:run`, which runs any choice by
   *     name) — a CLI command is re-enabled only by its exact name;
   *   - it never re-enables an accept verb's QuickAdd choice
   *     (`isAcceptVerbCommandId`) — the accept perimeter (01.41) keeps those
   *     off every agent road, and a family entry must not open them by accident.
   * Deny always wins, globs included. */
  allowOpaque?: string[];
  /** Command ids a trailing-`*` re-enable never reaches (Nelson's pick "A" on 01.41 "Which QuickAdd
   * choices a wildcard in Re-enabled opaque commands may open", 2026-10-14): the human lists here any
   * choice only he should run, so `quickadd:*` opens every other one. Exact ids, or `prefix*`. It binds
   * glob re-enables only: an exact re-enable of the same id is a deliberate act and still opens it, and
   * "Denied commands" still wins over both. */
  neverOpaque?: string[];
}

/** Does `name` match `pattern` — exact, or prefix glob `foo*` (any trailing
 * `*` makes everything before it a prefix)? No other glob syntax. */
export function matchesCommandPattern(name: string, pattern: string): boolean {
  const p = pattern.trim();
  if (p.length === 0) return false;
  if (p.endsWith("*")) return name.startsWith(p.slice(0, -1));
  return name === p;
}

function matchesAny(name: string, patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some((p) => matchesCommandPattern(name, p));
}

/** The QuickAdd choices that are accept verbs (01.41): a run_command id for one
 *  of them is never re-enabled by a glob. QuickAdd registers a choice's command as
 *  `quickadd:choice:<choice id>`, and in this vault the id ends `/<name>.md#choice`. */
export const ACCEPT_VERB_CHOICES = [
  "Verify current note",
  "Reopen current note",
  "Request revision",
  "Answer current note",
  "Reject current note",
] as const;

/** Is `commandId` an accept verb's QuickAdd command? Matched on the choice's name. */
export function isAcceptVerbCommandId(commandId: string): boolean {
  const id = commandId.trim();
  return ACCEPT_VERB_CHOICES.some((n) => id.endsWith(`/${n}.md#choice`) || id.endsWith(`:${n}`) || id === `quickadd:choice:${n}`);
}

/** Does the allowOpaque list re-enable `name` on this surface? An exact entry on
 *  either surface; a trailing-`*` entry for a run_command id only, and never for
 *  an accept verb (see CliCommandPolicy). */
function allowedOpaque(name: string, policy: CliCommandPolicy | undefined, surface: "cli" | "command-id"): boolean {
  return (policy?.allowOpaque ?? []).some((raw) => {
    const p = raw.trim();
    if (!p) return false;
    if (p === name) return true;
    if (!p.endsWith("*") || surface !== "command-id") return false;
    if (isAcceptVerbCommandId(name)) return false;
    if (matchesAny(name, policy?.neverOpaque)) return false;
    return matchesCommandPattern(name, p);
  });
}

/** A built-in default-deny set plus the phrasing for WHY its members are denied
 * (they share the human-only `allowOpaque` re-enable path). */
interface DefaultDenySet {
  patterns: readonly string[];
  /** The clause after "…is " — the reason this family is uninspectable. */
  reason: string;
}

const OPAQUE_ACCEPT_DENY: DefaultDenySet = {
  patterns: OPAQUE_ACCEPT_CLI_COMMANDS,
  reason: "executes opaque macros/code that the acceptance guard cannot inspect",
};
const UNINSPECTABLE_WRITE_DENY: DefaultDenySet = {
  patterns: UNINSPECTABLE_WRITE_CLI_COMMANDS,
  reason:
    "restores note content the acceptance guard cannot inspect before it lands (a restored version can " +
    "reintroduce an accepted value a human revoked)",
};

function refusal(
  name: string,
  policy: CliCommandPolicy | undefined,
  denySets: readonly DefaultDenySet[],
  surface: string,
  kind: "cli" | "command-id",
): string | null {
  if (matchesAny(name, policy?.deny)) {
    return `${surface} '${name}' is denied by the Vault MCP command policy (settings › Security › "Denied commands").`;
  }
  for (const set of denySets) {
    if (matchesAny(name, set.patterns) && !allowedOpaque(name, policy, kind)) {
      return (
        `${surface} '${name}' ${set.reason}, and is denied by default (fail closed). A human can re-enable ` +
        `this specific command in the Vault MCP settings (Security › "Re-enabled opaque commands") — there ` +
        `is no agent-writable path to that setting.`
      );
    }
  }
  return null;
}

/** The reason an `obsidian_cli` command is refused by policy, or null. */
export function cliCommandRefusal(command: string, policy?: CliCommandPolicy): string | null {
  return refusal(command.trim(), policy, [OPAQUE_ACCEPT_DENY, UNINSPECTABLE_WRITE_DENY], "CLI command", "cli");
}

/**
 * Config-territory guard for CLI param AND flag VALUES: the "human-only
 * settings" property assumes no MCP surface can write plugin settings. The MCP
 * write primitives enforce that structurally (they refuse non-`.md` paths), but
 * `obsidian_cli` forwards param values (and verbatim flags) to the external CLI
 * binary unvalidated — whether the binary's `create file=…`/`property:set`
 * would accept a path into `.obsidian/` is the binary's business, not something
 * we can verify from here. So the proxy refuses to forward ANY param value —
 * or any path-valued flag (`--file=.obsidian/…`) — that names `.obsidian`
 * territory or tries to traverse out of the vault (`..` segments), for every
 * command — reads included (the journal lives there too, and no legitimate CLI
 * use targets config through this proxy). Belt-and-suspenders: even if the
 * binary would refuse anyway, the policy's guarantee no longer rests on an
 * unverified assumption about it.
 */
export function configPathRefusal(
  params?: Record<string, string | number | boolean>,
  flags?: string[],
): string | null {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value !== "string") continue;
    const reason = pathValueRefusal(`param '${key}'`, value);
    if (reason) return reason;
  }
  // Flags ride verbatim into the argv (`--file=.obsidian/…/data.json`), so a
  // path-valued flag would escape the param scan entirely. A flag carries a
  // value only after its first `=`; boolean/format flags (`--json`) have none.
  for (const flag of flags ?? []) {
    if (typeof flag !== "string") continue;
    const eq = flag.indexOf("=");
    if (eq < 0) continue;
    const reason = pathValueRefusal(`flag '${flag.slice(0, eq)}'`, flag.slice(eq + 1));
    if (reason) return reason;
  }
  return null;
}

/** Refuse a single path-shaped value that names .obsidian territory or escapes
 * the vault. Segment-wise so "x.obsidian.md" stays clean while ".obsidian",
 * "./.obsidian/x", or "a\\.obsidian\\b" refuse. The `.obsidian` compare is
 * CASE-FOLDED: on case-insensitive filesystems (macOS APFS default, the primary
 * platform) ".Obsidian"/".OBSIDIAN" resolve to ".obsidian", so any casing must
 * be caught or the config-tamper backstop leaks. */
function pathValueRefusal(label: string, value: string): string | null {
  const segments = value.trim().replace(/\\/g, "/").split("/");
  if (segments.some((s) => s.toLowerCase() === ".obsidian")) {
    return `${label} names .obsidian territory — plugin config and state are not reachable through the CLI proxy.`;
  }
  if (segments.includes("..")) {
    return `${label} contains a '..' path segment — the CLI proxy stays inside the vault.`;
  }
  return null;
}

/** The reason an `obsidian_run_command` id is refused by policy, or null. */
export function runCommandRefusal(commandId: string, policy?: CliCommandPolicy): string | null {
  return refusal(commandId.trim(), policy, [{ patterns: OPAQUE_ACCEPT_COMMAND_IDS, reason: "executes opaque macros/code that the acceptance guard cannot inspect" }], "command id", "command-id");
}

/** The registered command ids that the policy re-enables today out of the opaque run_command families
 *  (`quickadd:*`, `js-engine:*`), sorted. The settings tab shows the count and the list when the human
 *  saves a re-enable, so a wildcard's reach is seen at save time (01.41, pick A). */
export function reenabledOpaqueCommandIds(commandIds: Iterable<string>, policy: CliCommandPolicy | undefined): string[] {
  const out: string[] = [];
  for (const id of commandIds) {
    if (!matchesAny(id, OPAQUE_ACCEPT_COMMAND_IDS)) continue;
    if (runCommandRefusal(id, policy) === null) out.push(id);
  }
  return out.sort();
}
