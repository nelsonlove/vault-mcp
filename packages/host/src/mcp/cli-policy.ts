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
// Deny and Never re-enable entries are exact command names, or prefix globs
// written `prefix*`. Re-enable entries are exact only at call time: a wildcard
// is expanded into exact ids when the human saves (expandOpaqueWildcards). Matching is case-sensitive on purpose,
// like the danger gate: the CLI's commands are lowercase, and a
// case-insensitive match here could diverge from the case-sensitive gates
// downstream.
//
// Obsidian-free: unit-tested directly; the tool handlers call the
// refusal functions with the settings-supplied policy. The one exception to
// "pure" is the script hash check, which reads through an injected reader.

import { createHash } from "node:crypto";

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
  /** Opaque-accept entries the human re-enabled: exact CLI command names and exact run_command ids only.
   * A wildcard is not honoured here at call time (Nelson's pick A on 01.41 "Should a wildcard open only the
   * QuickAdd choices it opened when it was saved", verified 2026-10-17, with his change: "it should
   * enumerate the choices opened rather than just list the wildcard"). The settings page expands each
   * wildcard into the exact `quickadd:choice:<id>` ids it opens when the human saves (`expandOpaqueWildcards`),
   * and stores those ids here. A trailing-`*` entry found here at call time (a hand-edited data.json) opens
   * nothing: fail closed until the human saves the setting. Deny wins over every entry. */
  allowOpaque?: string[];
  /** Command ids a wildcard expansion skips (Nelson's pick "A" on 01.41 "Which QuickAdd choices a wildcard in
   * Re-enabled opaque commands may open", 2026-10-14): the human lists here any choice only he should run.
   * Exact ids, or `prefix*`. It binds the ids a wildcard added (they keep the wildcard's limits at call time)
   * and the next expansion; an exact entry the human typed for the same id still opens it, and "Denied
   * commands" wins over both. */
  neverOpaque?: string[];
  /** The wildcards the human saved (`quickadd:choice:*`), kept so the settings page can show which wildcard
   * produced the list and expand it again on the next human save. The gate does not read this field. */
  opaqueWildcards?: string[];
  /** For each id a wildcard expansion added to `allowOpaque`: a sha256 of each script the choice runs, taken
   * at save. The id opens only while every script hashes the same and the choice runs the same scripts
   * (`runCommandSnapshotRefusal`). An id the human typed by hand has no entry here. */
  opaqueSnapshot?: Record<string, OpaqueSnapshotEntry>;
}

/** What a wildcard expansion recorded for one id: the scripts its choice runs, path to sha256 hex. */
export interface OpaqueSnapshotEntry {
  scripts: Record<string, string>;
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

/** Is this a trailing-`*` entry? */
function isGlob(entry: string): boolean {
  return entry.trim().endsWith("*");
}

/** How the allowOpaque list treats `name`: "open" (an exact entry the human typed, or an id a wildcard added
 *  that still passes the wildcard's checks), "stale-glob" (only a trailing-`*` entry matches; it opens nothing
 *  at call time), "snapshot-fails" (a wildcard added it, but it no longer passes those checks) or "closed". */
function opaqueStatus(name: string, policy: CliCommandPolicy | undefined, surface: "cli" | "command-id", choices?: QuickAddChoices | null): "open" | "stale-glob" | "snapshot-fails" | "closed" {
  const entries = (policy?.allowOpaque ?? []).map((e) => e.trim()).filter(Boolean);
  if (entries.some((e) => !isGlob(e) && e === name)) {
    if (surface !== "command-id" || !hasSnapshot(name, policy)) return "open";
    // An id a wildcard added keeps the wildcard's limits: it must still resolve, not be or run an accept
    // verb, and not be on Never re-enable.
    return wildcardMayOpen(name, policy, choices) ? "open" : "snapshot-fails";
  }
  if (entries.some((e) => isGlob(e) && matchesCommandPattern(name, e))) return "stale-glob";
  return "closed";
}

function hasSnapshot(name: string, policy: CliCommandPolicy | undefined): boolean {
  const snap = policy?.opaqueSnapshot;
  return !!snap && Object.prototype.hasOwnProperty.call(snap, name);
}

/** The prefix QuickAdd gives a choice's command id. */
export const QUICKADD_CHOICE_PREFIX = "quickadd:choice:";

/** What a QuickAdd choice is and runs, read from QuickAdd's own settings (`choices`). */
export interface QuickAddChoiceInfo {
  id: string;
  name: string;
  /** QuickAdd's choice type: Macro, Template, Capture or Multi. */
  type: string;
  /** Vault paths of the UserScript steps, at any depth (Conditional branches included). */
  scripts: string[];
  /** Choice ids this choice runs (a Choice step, a NestedChoice, or an Obsidian step naming `quickadd:choice:<id>`). */
  choiceRefs: string[];
  /** True when a step runs an Obsidian command that is opaque but not a choice (a `js-engine:` id,
   *  `quickadd:runQuickAdd`…), or any text in the choice calls a macro or inline code through QuickAdd's
   *  format engine (`{{MACRO:…}}`, a ```js quickadd block). */
  runsOtherOpaque: boolean;
}

/** A lookup over the QuickAdd choices that are registered now. */
export interface QuickAddChoices {
  get(choiceId: string): QuickAddChoiceInfo | null;
  all(): QuickAddChoiceInfo[];
}

/**
 * May a wildcard expansion add this run_command id, and may an id it added still open? (#552 review 1.) Only a `quickadd:choice:<id>`
 * id (with QuickAdd's `:pick-day` variant) that resolves to a registered choice which is not an accept
 * verb, does not run one, and is not on the "Never re-enable" list. Fail closed in every other case:
 * a `js-engine:` id or any other `quickadd:` command (exact entries only), an id that does not resolve,
 * or no choice lookup at all.
 */
export function wildcardMayOpen(name: string, policy: CliCommandPolicy | undefined, choices: QuickAddChoices | null | undefined): boolean {
  if (!name.startsWith(QUICKADD_CHOICE_PREFIX)) return false;
  const base = name.endsWith(":pick-day") ? name.slice(0, -":pick-day".length) : name;
  if (isAcceptVerbCommandId(base)) return false;
  if (matchesAny(name, policy?.neverOpaque) || matchesAny(base, policy?.neverOpaque)) return false;
  if (!choices) return false;
  return !choiceIsOrRunsVerb(base.slice(QUICKADD_CHOICE_PREFIX.length), choices);
}

function normPath(p: string): string {
  return p.trim().replace(/^\/+/, "").replace(/\.md$/i, "").toLowerCase();
}

/** Is this choice an accept verb, or does it run one (by name, by a verb's script, or through another
 *  choice)? An id that does not resolve counts as a verb: fail closed. */
export function choiceIsOrRunsVerb(choiceId: string, choices: QuickAddChoices): boolean {
  const verbNames = new Set<string>(ACCEPT_VERB_CHOICES.map((n) => n.toLowerCase()));
  const verbScripts = new Set<string>();
  for (const c of choices.all()) {
    if (verbNames.has(c.name.trim().toLowerCase())) for (const sc of c.scripts) verbScripts.add(normPath(sc));
  }
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const c = choices.get(id);
    if (!c) return true;
    // Only a Macro choice is read step by step. A Template or Capture choice can run code from a template
    // note or a format string the gate cannot read here (#552 review 2), so it counts as unsafe.
    if (c.type !== "Macro") return true;
    if (verbNames.has(c.name.trim().toLowerCase())) return true;
    // QuickAdd runs a choice BY NAME (the first match in its tree), so a shared name could run another
    // choice than the one checked (#552 review 2): a name used twice is unsafe.
    const nm = c.name.trim().toLowerCase();
    if (choices.all().filter((o) => o.name.trim().toLowerCase() === nm).length > 1) return true;
    if (c.runsOtherOpaque) return true;
    if (c.scripts.some((sc) => verbScripts.has(normPath(sc)))) return true;
    return c.choiceRefs.some(visit);
  };
  return visit(choiceId);
}

/** Build the lookup from QuickAdd's settings object (`app.plugins.plugins.quickadd.settings`). Null when
 *  QuickAdd is absent or its settings are not the expected shape, which makes every glob refuse. */
export function quickAddChoicesFrom(settings: unknown): QuickAddChoices | null {
  const roots = (settings as { choices?: unknown } | null | undefined)?.choices;
  if (!Array.isArray(roots)) return null;
  const byId = new Map<string, QuickAddChoiceInfo>();
  // QuickAdd resolves a shared id to the first match; the gate cannot know it checked that one, so an id
  // seen twice resolves to nothing (#552 review 3), which fails closed.
  const dupIds = new Set<string>();
  const walkChoices = (list: unknown[]): void => {
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      if (typeof c.id === "string" && typeof c.name === "string") {
        const info: QuickAddChoiceInfo = { id: c.id, name: c.name, type: typeof c.type === "string" ? c.type : "", scripts: [], choiceRefs: [], runsOtherOpaque: false };
        collectSteps(c.macro, info, 0);
        if (mentionsFormatCode(c)) info.runsOtherOpaque = true;
        if (byId.has(c.id)) dupIds.add(c.id);
        byId.set(c.id, info);
      }
      if (Array.isArray(c.choices)) walkChoices(c.choices);
    }
  };
  const collectSteps = (node: unknown, info: QuickAddChoiceInfo, depth: number): void => {
    if (depth > 50 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) collectSteps(n, info, depth + 1); return; }
    const o = node as Record<string, unknown>;
    // Fail closed on a step type the gate does not know (#552 review 3): an AIAssistant step formats a
    // prompt-template note through QuickAdd's formatter, which runs macros and inline code the gate cannot
    // read, and a future step type may do the same.
    if (depth > 0 && typeof o.type === "string" && !KNOWN_STEP_TYPES.has(o.type)) info.runsOtherOpaque = true;
    if (o.type === "UserScript" && typeof o.path === "string") info.scripts.push(o.path);
    // A Conditional step's condition may be a script (`{ mode: "script", scriptPath }`): it runs too.
    if (typeof o.scriptPath === "string") info.scripts.push(o.scriptPath);
    if (o.type === "Choice" && typeof o.choiceId === "string") info.choiceRefs.push(o.choiceId);
    if (o.type === "NestedChoice" && o.choice && typeof o.choice === "object") {
      const nested = o.choice as Record<string, unknown>;
      if (typeof nested.id === "string") info.choiceRefs.push(nested.id);
      walkChoices([nested]);
    }
    if (typeof o.commandId === "string") {
      const cmd = o.commandId.trim();
      if (cmd.startsWith(QUICKADD_CHOICE_PREFIX)) info.choiceRefs.push(cmd.slice(QUICKADD_CHOICE_PREFIX.length).replace(/:pick-day$/, ""));
      else if (matchesAny(cmd, OPAQUE_ACCEPT_COMMAND_IDS)) info.runsOtherOpaque = true;
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === "choice" && o.type === "NestedChoice") continue;
      if (v && typeof v === "object") collectSteps(v, info, depth + 1);
    }
  };
  walkChoices(roots);
  return { get: (id) => (dupIds.has(id) ? null : byId.get(id) ?? null), all: () => [...byId.values()] };
}

/** Macro step types the gate reads (#552 review 3). Any other type marks its choice as unsafe. */
const KNOWN_STEP_TYPES = new Set(["UserScript", "Obsidian", "Choice", "NestedChoice", "Wait", "EditorCommand", "Conditional", "OpenFile"]);

/** Does any string in this choice (its own settings, not nested choices) call a macro or inline code
 *  through QuickAdd's format engine? */
function mentionsFormatCode(choice: Record<string, unknown>): boolean {
  const seen = new Set<unknown>();
  const scan = (v: unknown, depth: number): boolean => {
    if (depth > 50 || v === null || v === undefined) return false;
    if (typeof v === "string") return /\{\{\s*macro\s*:/i.test(v) || /```\s*js\s+quickadd/i.test(v);
    if (typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.some((x) => scan(x, depth + 1));
    return Object.entries(v as Record<string, unknown>).some(([k, x]) => k !== "choices" && scan(x, depth + 1));
  };
  return scan(choice, 0);
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
  choices?: QuickAddChoices | null,
): string | null {
  if (matchesAny(name, policy?.deny)) {
    return `${surface} '${name}' is denied by the Vault MCP command policy (settings › Security › "Denied commands").`;
  }
  for (const set of denySets) {
    if (!matchesAny(name, set.patterns)) continue;
    const status = opaqueStatus(name, policy, kind, choices);
    if (status === "open") continue;
    if (status === "stale-glob" && kind === "command-id") {
      return (
        `${surface} '${name}' matches a wildcard in the stored re-enable list, and a wildcard opens nothing when ` +
        `an agent calls (fail closed). A human can save Security › "Re-enabled opaque commands" in the Vault MCP ` +
        `settings again: the save lists the exact choices the wildcard opens.`
      );
    }
    if (status === "snapshot-fails") {
      return (
        `${surface} '${name}' was opened by a wildcard, but it no longer passes the wildcard's checks (it does not ` +
        `resolve, it is or runs an accept verb, or it is on "Never re-enable"). It stays closed (fail closed).`
      );
    }
    return (
      `${surface} '${name}' ${set.reason}, and is denied by default (fail closed). A human can re-enable ` +
      `this command in the Vault MCP settings (Security › "Re-enabled opaque commands"; an exact entry, or a ` +
      `trailing * for QuickAdd choices, which the save expands into the choices it opens) — there ` +
      `is no agent-writable path to that setting.`
    );
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
export function runCommandRefusal(commandId: string, policy?: CliCommandPolicy, choices?: QuickAddChoices | null): string | null {
  return refusal(commandId.trim(), policy, [{ patterns: OPAQUE_ACCEPT_COMMAND_IDS, reason: "executes opaque macros/code that the acceptance guard cannot inspect" }], "command id", "command-id", choices);
}

/** The registered command ids that pass the sync gate today out of the opaque run_command families
 *  (`quickadd:*`, `js-engine:*`), sorted. The settings tab shows the count and the list on each save (01.41,
 *  pick A); it also drops the ids whose scripts changed (`runCommandSnapshotRefusal`), which this sync
 *  function cannot see. */
export function reenabledOpaqueCommandIds(commandIds: Iterable<string>, policy: CliCommandPolicy | undefined, choices?: QuickAddChoices | null): string[] {
  const out: string[] = [];
  for (const id of commandIds) {
    if (!matchesAny(id, OPAQUE_ACCEPT_COMMAND_IDS)) continue;
    if (runCommandRefusal(id, policy, choices) === null) out.push(id);
  }
  return out.sort();
}

// ── Wildcard expansion at save, and the script snapshot (01.41, pick A, 2026-10-17) ────────────────
//
// Nelson's ruling: at save, the settings record each choice a wildcard opens and a hash of each script it
// runs; a choice added later, or a choice whose script changed since, stays closed until the human saves the
// setting again, and the count then shows it. His change: "it should enumerate the choices opened rather than
// just list the wildcard." So a wildcard is expanded HERE, on a human save, into exact ids; the call-time
// gate reads exact ids only.

/** Reads a vault file's text, or null when it is absent or unreadable. */
export type ReadText = (path: string) => Promise<string | null>;

/** A ReadText over Obsidian's vault (duck-typed, so this module stays obsidian-free). */
export function vaultTextReader(app: unknown): ReadText {
  const vault = (app as { vault?: { getAbstractFileByPath?: (p: string) => unknown; read?: (f: unknown) => Promise<string> } } | null | undefined)?.vault;
  return async (path) => {
    try {
      const f = vault?.getAbstractFileByPath?.(path) as { extension?: unknown } | null | undefined;
      // A folder has no extension; only a file is read.
      if (!f || typeof f.extension !== "string" || !vault?.read) return null;
      return await vault.read(f);
    } catch {
      return null;
    }
  };
}

/** sha256 of a text, hex. */
export function hashScript(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The scripts a choice runs, its own and those of every choice it runs, sorted and unique. Null when the
 *  choice or a choice it runs does not resolve. */
export function scriptsRunBy(choiceId: string, choices: QuickAddChoices): string[] | null {
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    const c = choices.get(id);
    if (!c) return false;
    for (const sc of c.scripts) out.add(sc);
    return c.choiceRefs.every(visit);
  };
  return visit(choiceId) ? [...out].sort() : null;
}

function choiceIdOf(commandId: string): string | null {
  if (!commandId.startsWith(QUICKADD_CHOICE_PREFIX)) return null;
  const base = commandId.endsWith(":pick-day") ? commandId.slice(0, -":pick-day".length) : commandId;
  return base.slice(QUICKADD_CHOICE_PREFIX.length);
}

/** Hash each script; null when one cannot be read. */
async function hashScripts(paths: string[], readText: ReadText): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    let text: string | null;
    try {
      text = await readText(p);
    } catch {
      text = null;
    }
    if (text === null) return null;
    out[p] = hashScript(text);
  }
  return out;
}

/** What the human saved in the four settings boxes. */
export interface OpaqueSaveInput {
  /** The "Re-enabled opaque commands" lines. A trailing-`*` line is a wildcard; it moves to `wildcards`. */
  allowOpaque: string[];
  /** The saved wildcards. */
  wildcards: string[];
  neverOpaque: string[];
  deny: string[];
}

/** The policy a human save stores, and the ids an expansion left out because a script could not be read. */
export interface OpaqueSaveResult {
  policy: Required<Pick<CliCommandPolicy, "deny" | "allowOpaque" | "neverOpaque" | "opaqueWildcards" | "opaqueSnapshot">>;
  /** Ids a wildcard matched and would open, left closed because a script they run could not be read. */
  unreadable: string[];
}

/**
 * Expand the wildcards on a human save (01.41, pick A). Each wildcard becomes the exact
 * `quickadd:choice:<id>` ids among `commandIds` that it opens now: a choice that resolves, is a Macro, is
 * not and does not run an accept verb, is not on Never re-enable and is not denied (`wildcardMayOpen`). Each
 * such id gets a snapshot of the scripts it runs. An exact line the human typed keeps no snapshot. A line
 * that a previous expansion added (it has an entry in `prevSnapshot`) is dropped and found again by this
 * expansion, so removing a wildcard removes the ids it opened. The result's `allowOpaque` holds exact ids
 * only. Only a human save calls this; nothing calls it on a timer or at load.
 */
export async function expandOpaqueWildcards(
  input: OpaqueSaveInput,
  prevSnapshot: Record<string, OpaqueSnapshotEntry> | undefined,
  commandIds: Iterable<string>,
  choices: QuickAddChoices | null,
  readText: ReadText,
): Promise<OpaqueSaveResult> {
  const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const lines = clean(input.allowOpaque);
  const wildcards = clean([...input.wildcards, ...lines.filter(isGlob)]).filter(isGlob);
  const deny = clean(input.deny);
  const neverOpaque = clean(input.neverOpaque);
  const prev = prevSnapshot ?? {};
  const hand = lines.filter((l) => !isGlob(l) && !Object.prototype.hasOwnProperty.call(prev, l));
  const handSet = new Set(hand);
  const gatePolicy: CliCommandPolicy = { deny, neverOpaque };
  const added: string[] = [];
  const unreadable: string[] = [];
  const snapshot: Record<string, OpaqueSnapshotEntry> = {};
  for (const id of [...new Set(commandIds)].sort()) {
    if (handSet.has(id)) continue;
    if (!wildcards.some((w) => matchesCommandPattern(id, w))) continue;
    if (matchesAny(id, deny)) continue;
    if (!choices || !wildcardMayOpen(id, gatePolicy, choices)) continue;
    const choiceId = choiceIdOf(id);
    const paths = choiceId === null ? null : scriptsRunBy(choiceId, choices);
    if (!paths) continue;
    const scripts = await hashScripts(paths, readText);
    if (!scripts) {
      unreadable.push(id);
      continue;
    }
    snapshot[id] = { scripts };
    added.push(id);
  }
  return {
    policy: { deny, neverOpaque, allowOpaque: [...hand, ...added], opaqueWildcards: wildcards, opaqueSnapshot: snapshot },
    unreadable,
  };
}

/**
 * The second, async half of the run_command gate (01.41, pick A): call it after `runCommandRefusal` returns
 * null. An id with no snapshot (a CLI command, or an id the human typed by hand) passes. An id a wildcard
 * added opens only when its choice still resolves, runs the same scripts, and each script hashes the same as
 * at save. Otherwise the reason it stays closed.
 */
export async function runCommandSnapshotRefusal(
  commandId: string,
  policy: CliCommandPolicy | undefined,
  choices: QuickAddChoices | null | undefined,
  readText: ReadText,
): Promise<string | null> {
  const id = commandId.trim();
  if (!hasSnapshot(id, policy)) return null;
  const entry = policy!.opaqueSnapshot![id];
  const changed =
    `command id '${id}' was opened by a wildcard, and this choice's script changed since you saved the wildcard; ` +
    `save the setting again to open it (Vault MCP settings › Security › "Re-enabled opaque commands"). It stays closed (fail closed).`;
  const choiceId = choiceIdOf(id);
  if (!choices || choiceId === null || !entry || typeof entry.scripts !== "object" || entry.scripts === null) return changed;
  const now = scriptsRunBy(choiceId, choices);
  const saved = Object.keys(entry.scripts).sort();
  if (!now || now.length !== saved.length || now.some((p, i) => p !== saved[i])) return changed;
  const hashes = await hashScripts(now, readText);
  if (!hashes || now.some((p) => hashes[p] !== entry.scripts[p])) return changed;
  return null;
}

/** Normalise a loaded `cliPolicy` (a hand-edited data.json may hold anything): fresh string arrays, and a
 *  snapshot of well-formed entries only, kept for ids still in `allowOpaque`. A dropped value can only close
 *  more: a malformed snapshot entry is dropped with its id, never kept as an open hand-typed id. */
export function normalizeCliPolicy(raw: unknown): OpaqueSaveResult["policy"] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  const allow = list(r.allowOpaque);
  const snapshot: Record<string, OpaqueSnapshotEntry> = {};
  const bad = new Set<string>();
  const rawSnap = r.opaqueSnapshot;
  if (rawSnap && typeof rawSnap === "object" && !Array.isArray(rawSnap)) {
    for (const [id, v] of Object.entries(rawSnap as Record<string, unknown>)) {
      const scripts = (v as { scripts?: unknown } | null)?.scripts;
      const ok =
        !!scripts &&
        typeof scripts === "object" &&
        !Array.isArray(scripts) &&
        Object.values(scripts as Record<string, unknown>).every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h));
      if (!ok) {
        bad.add(id);
        continue;
      }
      if (allow.includes(id)) snapshot[id] = { scripts: { ...(scripts as Record<string, string>) } };
    }
  }
  return {
    deny: list(r.deny),
    allowOpaque: allow.filter((id) => !bad.has(id)),
    neverOpaque: list(r.neverOpaque),
    opaqueWildcards: list(r.opaqueWildcards).filter(isGlob),
    opaqueSnapshot: snapshot,
  };
}
