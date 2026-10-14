// packs/drift.ts — the drift rule pack: what remains of the TypeScript port of
// drift_audit.py, the config-vs-registry drift audit, after #412 retired the
// checks that measured a vault shape the rebuilt vault no longer has.
//
// drift_audit.py ran a lettered battery of checks A–J; only SOME appended to
// its `findings` list (the rest merely `print`ed), and the conformance ratchet
// keys ONLY the `findings` entries. The port carried the finding-producing
// checks; #412 (ruled 2026-09-27: "retire the four drift_audit checks — the
// fileclass system is their replacement") then retired every check whose
// subject was one of the four vault conventions that named a shape which is
// gone (the `.action`/`.property`/`.type`/`.tag` registry families, the
// plugin-stack table note, the artifacts root the surfaces resolved under, and
// the uid-exempt template). What each letter was, and where it stands:
//
//   A  QuickAdd command-enabled choices  <->  `.action` `quickadd-choice` surfaces   RETIRED (#412: read the registry family)
//   B  live plugin enablement            <->  the plugin-stack table note             RETIRED (#412: read `pluginStackPath`)
//   C  RETIRED before the port (print-only)
//   D  `.action` script/module/template surfaces  <->  filesystem existence          RETIRED (#412: read the registry family and `artifactsRoot`)
//   E  duplicate note `uid` values                                                    [findings] — kept
//   F  notes without a usable `uid` (one aggregated finding)                          RETIRED (#412: its only convention was the uid-exempt carve-out; uid coverage is reported by `obsidian_check_links` (`uid_coverage`) and enforced at accept by Governor's required-frontmatter-keys gate)
//   G  registry naming self-consistency (title / filename / H1 agree)                 RETIRED (#412: read the registry family)
//   H  tag registration — dropped before the port (print-only)
//   I  band filing — dropped before the port (print-only)
//   J  category-number collisions on the System spine                                [findings] — kept
//
// So the pack reads ONE convention, `systemRoot` (J's scan root), and E reads
// none: it runs over the whole governed walk with no exemption, since a note
// with a blank uid cannot be a duplicate claimant. The retired checks' accepted
// keys (`drift_audit|A|…`, `|B|`, `|D|`, `|G|`) in a live baseline are no
// longer produced, and the coverage refusal works at PACK granularity, so they
// read CLEARED on the next run (the report names them as RETIRED CHECK
// clears). Pruning them is a human act — `--rebaseline --baseline=<copy>`
// over a reviewed copy, then the human applies it to the vault's acceptance
// record, which `--rebaseline` refuses to touch directly — not something
// this file does.
//
// Finding key (the ratchet's `parse_drift` normalization, frozen by the live
// `Conformance baseline.md`): each Python finding string was `"{LETTER}: {rest}"`,
// keyed as ("drift_audit", <LETTER>, <rest>, "") — the letter is the `check`,
// the message body is the `target`, and `kind` is EMPTY (so the serialized key
// carries a trailing pipe, e.g. `drift_audit|J|category number 00 …|`). The
// pack id IS the `script` field: "drift_audit".
//
// E IS SPECIAL-CASED because its message embeds volatile data — `parse_drift`'s
// frozen contract (its docstring, verbatim): one finding per uid whose message
// carries the homes list, ORDER-DEPENDENT. Keyed on the uid itself, not the
// homes list: target <uid>, kind "dup-uid". J's message is deterministic
// run-to-run and IS the target (kind stays ""). Keying E on its message text
// (as the message-level TS<->Python parity check verified) is a DIFFERENT and
// weaker property than key parity -- see issue #136. Do not "simplify" this
// back to `target: rest` for E without re-reading that issue.

import { leadingFrontmatterBlock } from "@vault-mcp/core";
import type { VaultConventions } from "../vault-conventions.js";
import type { Finding } from "../finding.js";
import type { RulePack, SourceFile, VaultSnapshot } from "../rule-pack.js";
import { requireSources, requireListing_ } from "../rule-pack.js";
import { firstSegment, hasDotOrTrashSegment, isUnderscoreRoot } from "./legacy-scope.js";

export const DRIFT_PACK_ID = "drift_audit";

// ── Python-parity string helpers (verbatim regex ports) ───────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** drift_audit.py `fm`: the leading frontmatter block, or "" when the note has
 * none. Bound to the shared recognizer in @vault-mcp/core (#189) rather than a
 * local `/^---\n/` copy, so a BOM- or CRLF-authored note reads as HAVING its
 * frontmatter instead of silently reading as bare (the #150 class). The
 * block's line endings are then folded to LF because the line-anchored
 * `fmValue` scan below embeds a literal `\n` — the same LF text Python's
 * universal-newline `read_text` handed drift_audit.py. For an ordinary
 * LF-authored fence both steps are byte no-ops, so such notes' findings (and
 * therefore their ratchet keys) are unchanged; the exotic shapes where the
 * shared recognizer differs on LF input too (`--- ` opener, `---x`-prefixed
 * closer line, closer at EOF) now match what the vault itself honors — the
 * same tradeoff #187 made. */
function fmBlock(text: string): string {
  const block = leadingFrontmatterBlock(text);
  return block === null ? "" : block.replace(/\r\n?/g, "\n");
}

/** drift_audit.py `fm_value`: `^key: (.+)$` over the block, whitespace- then
 * quote-stripped (Python `.strip().strip('"')`), else null. */
function fmValue(block: string, key: string): string | null {
  const m = block.match(new RegExp("^" + escapeRe(key) + ": (.+)$", "m"));
  if (!m) return null;
  // .strip() then .strip('"'): trim whitespace, then remove leading/trailing
  // double-quotes (all consecutive ones, as Python's str.strip(chars) does).
  return m[1].trim().replace(/^"+/, "").replace(/"+$/, "");
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function driftPack(conv: VaultConventions): RulePack {
  // The ONE convention this pack reads (#412). The former readers of
  // `registriesRoot`, `artifactsRoot`, `pluginStackPath` and `uidExemptPaths`
  // were the retired checks; the last three keys no longer exist.
  const SYS_ROOT = conv.systemRoot;
  return {
    id: DRIFT_PACK_ID,
    run(snapshot: VaultSnapshot): Finding[] {
      const out: Finding[] = [];
      // A drift finding is `"{LETTER}: {rest}"` → ("drift_audit", LETTER, rest, "")
      // for every check EXCEPT E, whose message embeds volatile data (an
      // order-dependent homes list) — it passes an explicit `key` override so
      // the FINDING KEY stays stable while `detail` still carries the full
      // human-readable message. See the top-of-file comment and issue #136.
      const push = (letter: string, rest: string, key?: { target: string; kind: string }): void => {
        out.push({
          script: DRIFT_PACK_ID,
          check: letter,
          target: key ? key.target : rest,
          kind: key ? key.kind : "",
          detail: `${letter}: ${rest}`,
        });
      };

      const sources: SourceFile[] = requireSources(snapshot, DRIFT_PACK_ID);
      const sourceText = new Map(sources.map((s) => [s.path, s.text]));
      // ABSENT listings are refused, not read as empty (#142): `dirs` is J's
      // universe, `walkOrder` is E's.
      const dirs = requireListing_(snapshot.dirs, DRIFT_PACK_ID, "dirs");
      const walkOrder = requireListing_(snapshot.walkOrder, DRIFT_PACK_ID, "walkOrder");

      // ── E. duplicate uid, over drift_audit.py's `iter_notes` scope in raw
      // TRAVERSAL ORDER. That order governs `detail` only — it is deliberately
      // NOT part of the finding key (#136): keying on the message made the key
      // move whenever an unrelated note changed the order, producing permanent
      // false-NEW churn against the accepted baseline. No exemption (#412): a
      // blank-uid template is not a claimant of anything. ────────────────────
      const governed = walkOrder.filter(
        (p) => !hasDotOrTrashSegment(p) && !isUnderscoreRoot(p) && firstSegment(p) !== "Assent",
      );
      const uidHomes = new Map<string, string[]>();
      for (const rel of governed) {
        const text = sourceText.get(rel);
        if (text === undefined) continue; // Python: `try: block = fm(note) except: continue`
        const uid = fmValue(fmBlock(text), "uid");
        if (uid && UUID_RE.test(uid)) {
          const homes = uidHomes.get(uid);
          if (homes) homes.push(rel);
          else uidHomes.set(uid, [rel]);
        }
      }
      // E — sorted by uid; homes stay in traversal order. The homes list is
      // order-dependent (and grows with every additional claimant), so the KEY
      // is the uid alone — `parse_drift`'s frozen contract (issue #136).
      for (const uid of [...uidHomes.keys()].sort()) {
        const homes = uidHomes.get(uid)!;
        if (homes.length > 1)
          push("E", `uid ${uid} is claimed by ${homes.length} notes: ` + homes.join("; "), {
            target: uid,
            kind: "dup-uid",
          });
      }

      // ── J. category-number collisions on the System spine ─────────────────────
      // drift_audit.py iterates `SYS.iterdir()` (direct children); a two-digit
      // number claimed by more than one folder is a Johnny-Decimal collision.
      const seenCodes = new Map<string, string[]>();
      for (const d of dirs) {
        if (!d.startsWith(SYS_ROOT + "/")) continue;
        const rest = d.slice(SYS_ROOT.length + 1);
        if (rest.includes("/")) continue; // direct children only
        const m = rest.match(/^(\d{2}) /);
        if (!m) continue;
        const list = seenCodes.get(m[1]);
        if (list) list.push(rest);
        else seenCodes.set(m[1], [rest]);
      }
      for (const code of [...seenCodes.keys()].sort()) {
        const names = seenCodes.get(code)!;
        if (names.length > 1)
          push("J", `category number ${code} is claimed by ${names.length} folders: ` + [...names].sort().join("; "));
      }

      return out;
    },
  };
}
