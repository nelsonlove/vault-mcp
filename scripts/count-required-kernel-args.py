# count-required-kernel-args.py: Nelson's 01.43 "a" (2026-09-29). Counts the host write journal's governed writes that would be
# refused under the 01.33 Step 5 table as ruled 2026-09-29, i.e. by this branch's `protection` values (inventory-mcp.ts).
# Run: python3 scripts/count-required-kernel-args.py  (reads ~/obsidian/.obsidian/plugins/vault-mcp/journal)
import json, glob, collections, datetime, os

JOURNAL = os.path.expanduser("~/obsidian/.obsidian/plugins/vault-mcp/journal/*.jsonl")
recs = [json.loads(l) for f in sorted(glob.glob(JOURNAL)) for l in open(f) if l.strip()]
# The operation's own records only (deduped replays and late corrections are not calls).
calls = [r for r in recs if r.get("outcome") in ("ok", "error", "conflict") and "corrects" not in r]
now = datetime.datetime.now(datetime.timezone.utc)
def ts(r): return datetime.datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))

NEEDS_IDEMPOTENCY = {"obsidian_append_note", "obsidian_append_at_heading", "obsidian_run_command", "obsidian_move_note", "obsidian_move_notes",
       "obsidian_assign_address", "obsidian_refile_address", "obsidian_renumber_address", "obsidian_cli", "obsidian_base_create",
       "obsidian_import_apple_notes", "obsidian_create_note_from_template", "crosssession_post", "vaultmcp_crosssession_post"}
# crosssession_post / vaultmcp_crosssession_post: the vaultmcp-crosssession satellite was retired on 2026-10-15; the names stay for older journal records.
NEEDS_REVISION = {"obsidian_fileclass_insert_fields", "obsidian_survey_slot", "obsidian_rename_heading"}
BOTH = {"obsidian_trash", "obsidian_delete_note"}
# The three temporary exemptions (Nelson's "a", 2026-09-29; back to token with #427). The render is a satellite tool since 2026-10-14
# (vaultmcp_conformance_debt_render, unenforced like every external tool); the old name stays for older journal records.
EXEMPT = {"obsidian_periodic_note", "obsidian_quickadd_compile", "obsidian_repoint_link", "obsidian_snippet_write", "obsidian_conformance_debt_render",
          "vaultmcp_conformance_debt_render"}

def need(r):
    """The class this call's operation requires, or None (not a vault write, or not a host write)."""
    op, a = r["op"], r.get("argsDigest")
    a = a if isinstance(a, dict) else {}
    if op == "obsidian_write_note": return "token" if a.get("overwrite") is True else "exempt"
    if op == "obsidian_write_notes":  # batch items are journaled one by one under the batch's name
        return "token" if r.get("revBefore") is not None else "exempt"
    if op == "obsidian_manage_frontmatter": return "token" if a.get("op") in ("set", "delete") else "exempt"
    if op == "obsidian_patch_note": return "key" if a.get("op") in ("append", "prepend") else "token"
    if op in NEEDS_IDEMPOTENCY: return "key"
    if op in NEEDS_REVISION: return "token"
    if op in BOTH: return "both"
    if op in EXEMPT: return "exempt"
    return None

def who(r):
    a = r.get("actor") or {}
    return a.get("session") or (a.get("client", "?") + "#" + a.get("connection", "?"))

for label, sel in (("LAST 7 DAYS", [r for r in calls if ts(r) > now - datetime.timedelta(days=7)]), ("WHOLE JOURNAL", calls)):
    print(f"\n==== {label}: {len(sel)} calls ({sel[0]['ts'][:10] if sel else '-'} .. {sel[-1]['ts'][:10] if sel else '-'})")
    refused, by_who, missing = collections.Counter(), collections.Counter(), collections.Counter()
    governed = 0
    for r in sel:
        n = need(r)
        if n is None: continue
        governed += 1
        miss = []
        if n in ("token", "both") and r.get("ifRev") is None: miss.append("if_rev")
        if n in ("key", "both") and not r.get("idempotencyKey"): miss.append("idempotency_key")
        if miss:
            refused[r["op"]] += 1; by_who[who(r)] += 1; missing["+".join(miss)] += 1
    print(f"governed writes: {governed}; would be REFUSED: {sum(refused.values())}")
    print(" by op:", dict(refused.most_common()))
    print(" by missing argument:", dict(missing))
    print(f" by caller ({len(by_who)} distinct; top 8):")
    for w, c in by_who.most_common(8): print(f"   {c:5}  {w}")
