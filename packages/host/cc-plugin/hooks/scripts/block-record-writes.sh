#!/usr/bin/env bash
# block-record-writes.sh — PreToolUse hook for Bash and mcp__(vault-mcp|governor)__* tools.
#
# BOTH server-name prefixes are matched, deliberately, and BOTH STAY. The
# Claude Code MCP server name was `vault-mcp` before 0.12.0, `governor` from
# 0.12.0 until the suite split's S3c wire rename (2026-09-09), and `vault-mcp`
# again after it — so a single-prefix match silently stops guarding on every
# rename. The `governor` spelling is NOT dropped: a pre-cutover `claude mcp`
# entry named `governor` can still resolve to the live socket through discovery.
#
# WHAT IS A RECORD. A note whose frontmatter carries `record: true` (Nelson's
# ruling on "Nothing stops an edit to a record today", 03.02: records are marked
# with `record: true`). Until 2026-10-15 this hook matched the folder name
# "Machinery record" anywhere in a tool's input; that folder no longer exists, so
# the old rule protected nothing and refused writes that only MENTIONED it (a
# worker's notebook entry, 2026-10-15). The hook now reads the target note.
#
# WHAT IT REFUSES (exit 2, corrective message on stderr):
#
#   1. Bash: a truncating redirect (`>`, `&>`), `tee` without -a/--append,
#      `sed -i`, or `mv`/`cp`/`rm`/`trash` whose argument is a file that exists
#      and carries `record: true`. Appends (`>>`, `&>>`, `tee -a`) pass: a dated
#      end-of-file entry is how a record grows. Heredoc bodies are stripped
#      first, so an appended entry may name a record path.
#   2. vault-mcp mutating tools (and Code Mode's obsidian_call_tool, by inner
#      name) whose input names, in any short one-line string value, a vault note
#      that carries `record: true`. obsidian_append_note passes, as in the host's
#      own guard.
#
# FAIL CLOSED where a target exists but cannot be read (permission, I/O): the
# hook cannot show it is not a record, so it refuses. A path that does not
# exist is a new file, not a record, and passes. When no vault root can be found
# for an MCP call (no discovery file), the hook passes and the host's own
# record guard (kernel/record-guard.ts, `Error [record_immutable]`) decides.
#
# THE SECOND LAYER. The vault-mcp host refuses every mutation but
# obsidian_append_note on a `record: true` note, server-side, for every client;
# it fails OPEN on an unreadable note. This hook is the client-side layer: it
# also covers Bash, which the host never sees, and it fails closed.
#
# HONEST LIMITS (threat model: fallible agents, not adversaries): a command that
# builds the path in a variable, cd's into the folder, globs it, or writes from
# an inline python/perl script is not caught; a folder move that carries a
# record inside it is not caught here (the host's own move checks decide); and
# only the default identifier (`record: true`) is read, not a host's configured
# property or tag.
#
# Vault discovery: $VAULT_MCP_DISCOVERY_DIR (default ~/.claude/vault-mcp), each
# `<vault>.json` with a `vault_path`. A vault-relative path counts as a record
# if it is one in any discovered vault (over-refusing is the safe direction).

input=$(cat)

command -v jq >/dev/null 2>&1 || {
    echo "[block-record-writes] jq not found on PATH — record write guard DISABLED for this call" >&2
    exit 0
}

tool=$(jq -r '.tool_name // empty' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")
[ -n "$cwd" ] || cwd=$PWD

corrective() {
    cat >&2 <<EOF
BLOCKED: this $1 would change a record note: $2
Its frontmatter carries record: true. A record is historical and append-only;
the only permitted change is APPENDING a dated entry at the end of the file:

cat <<'EOF_ENTRY' >> '<record file path>'

## $(date '+%Y-%m-%d') — <title>

<your entry>
EOF_ENTRY

(vault-mcp obsidian_append_note is equally fine.) Or write a NEW note. If you
believe this block is wrong, say so to the human rather than working around it.
EOF
    exit 2
}

unreadable() {
    cat >&2 <<EOF
BLOCKED: this $1 names '$2', which exists but cannot be read, so the record
guard cannot show it is not a record (record: true). Nothing ran. Check the
file's permissions, then retry.
EOF
    exit 2
}

# record_state FILE → prints "record", "plain", "absent" or "unreadable".
# A record is a note whose first frontmatter block has a `record: true` line.
record_state() {
    local f=$1
    [ -e "$f" ] || { echo absent; return; }
    [ -f "$f" ] || { echo plain; return; }   # a folder or device is not a note
    [ -r "$f" ] || { echo unreadable; return; }
    local fm
    # CRLF and a leading BOM are read as Obsidian reads them (#560 review 1).
    if ! fm=$(awk '{ sub(/\r$/, "") } NR==1 { sub(/^\xef\xbb\xbf/, ""); if ($0 != "---") exit; next } $0 == "---" { exit } { print }' "$f" 2>/dev/null); then
        echo unreadable; return
    fi
    # Any case (`True`, `"TRUE"`): YAML and the host's record guard read those as true too.
    if grep -Eiq '^record:[[:space:]]*("true"|'"'"'true'"'"'|true)[[:space:]]*(#.*)?$' <<<"$fm"; then
        echo record
    else
        echo plain
    fi
}

# Remove heredoc bodies: from a line containing <<[-]['"]DELIM to the line that
# is exactly DELIM (optionally indented, for <<-). Heredoc bodies are data fed
# to a command, not commands. The introducing line, which carries any real
# redirect, is kept.
strip_heredocs() {
    awk '
        skip != "" {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            if (line == skip) { skip = "" }
            next
        }
        {
            print
            probe = $0
            gsub(/\$\(\([^)]*\)\)/, "ARITH", probe)
            gsub(/<<</, "HSTR", probe)
            if (match(probe, /<<-?[[:space:]]*['\''"]?[A-Za-z_][A-Za-z_0-9]*/)) {
                d = substr(probe, RSTART, RLENGTH)
                sub(/^<<-?[[:space:]]*['\''"]?/, "", d)
                skip = d
            }
        }
    '
}

# ERE-escape a literal for use inside the op patterns.
ere_escape() { sed -e 's/[][\.*^$+?(){}|/]/\\&/g' <<<"$1"; }

# Candidates in a shell command: every '…' and "…" string, and every bare word.
# Over-collecting is harmless: a candidate counts only if it names an existing
# record file (or an existing file that cannot be read).
# A candidate is printed as two tab-separated fields: the literal as written in
# the command (what the op patterns must reach) and the path it names (backslash
# escapes and quotes removed, so `Notes/A\ record.md` and $'Notes/A record.md'
# are seen; #560 review 1).
bash_candidates() {
    grep -oE "\\$'[^']*'|'[^']+'|\"[^\"]+\"|(\\\\.|[^[:space:]'\"|;&<>()\\\\])+" <<<"$1" |
        while IFS= read -r lit; do
            path=$lit
            case "$path" in
                "\$'"*"'") path=${path#\$\'}; path=${path%\'} ;;
                "'"*"'") path=${path#\'}; path=${path%\'} ;;
                '"'*'"') path=${path#\"}; path=${path%\"} ;;
                *) path=${path//\\/} ;;   # drop backslash escapes, in this shell (no fork per word)
            esac
            printf '%s\t%s\n' "$lit" "$path"
        done
}

case "$tool" in
    Bash)
        cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
        [ -n "$cmd" ] || exit 0
        stripped=$(strip_heredocs <<<"$cmd")
        while IFS=$'\t' read -r rawlit cand; do
            [ -n "$cand" ] || continue
            case "$cand" in
                "~/"*) abs="$HOME/${cand#\~/}" ;;
                /*) abs=$cand ;;
                *) abs="$cwd/$cand" ;;
            esac
            # Most words name no file: test that in this shell before any fork (#560 review 1).
            [ -e "$abs" ] || continue
            state=$(record_state "$abs")
            [ "$state" = record ] || [ "$state" = unreadable ] || continue
            # The op patterns must reach the literal as it is written in the command.
            lit=$(ere_escape "$rawlit")
            hit=""
            # Truncating stdout redirect (not >>, not a 2>&1 dup).
            grep -Eq "(^|[^>&])>\|?[[:space:]]*['\"]?$lit" <<<"$stripped" && hit="shell redirect (truncating '>')"
            # Truncating stdout+stderr redirect: &> but not &>>.
            [ -z "$hit" ] && grep -Eq "(^|[[:space:]])&>[[:space:]]*['\"]?$lit" <<<"$stripped" && hit="shell redirect (truncating '&>')"
            if [ -z "$hit" ]; then
                noappend=$(sed -E 's/(^|[[:space:]|;&(])tee[[:space:]]+((-[[:alnum:]]*a[[:alnum:]]*|--append)([[:space:]]+|$))+/\1TEE_APPEND /g' <<<"$stripped")
                grep -Eq "\btee([[:space:]]+-[^[:space:]]+)*[[:space:]]+[^|;&]*$lit" <<<"$noappend" && hit="tee without -a/--append"
            fi
            # In-place sed in any form (-i, -i.bak, -Ei, -e … -i, --in-place), anywhere in a sed call.
            if [ -z "$hit" ]; then
                while IFS= read -r seg; do
                    if grep -Eq "[[:space:]](-[[:alnum:]]*i[^[:space:]]*|--in-place[^[:space:]]*)([[:space:]]|$)" <<<"$seg" && grep -Eq "$lit" <<<"$seg"; then
                        hit="in-place sed"; break
                    fi
                done < <(grep -oE "(^|[|;&()[:space:]])sed[[:space:]][^|;&]*" <<<"$stripped")
            fi
            # Moved or deleted: the record anywhere in the argument list.
            [ -z "$hit" ] && grep -Eq "(^|[|;&()[:space:]])(mv|rm|trash|/usr/bin/trash|truncate)[[:space:]]+[^|;&]*$lit" <<<"$stripped" && hit="destructive file operation (mv/rm/trash/truncate)"
            # Overwritten: the record as the LAST argument of a copy-like command, so copying
            # OUT of a record (a read, a backup) passes (#560 review 1).
            [ -z "$hit" ] && grep -Eq "(^|[|;&()[:space:]])(cp|rsync|install|ditto|ln)[[:space:]][^|;&]*['\"]?$lit['\"]?[[:space:]]*($|[|;&)])" <<<"$stripped" && hit="overwriting copy (cp/rsync/install/ditto/ln)"
            [ -z "$hit" ] && grep -Eq "(^|[|;&()[:space:]])dd[[:space:]][^|;&]*of=['\"]?$lit" <<<"$stripped" && hit="dd of="
            if [ -n "$hit" ]; then
                [ "$state" = unreadable ] && unreadable "$hit" "$cand"
                corrective "$hit" "$cand"
            fi
        done < <(bash_candidates "$stripped")
        exit 0
        ;;
esac

# vault-mcp tools from here on.
case "$tool" in
    mcp__vault-mcp__obsidian_append_note|mcp__governor__obsidian_append_note) exit 0 ;;
    mcp__vault-mcp__obsidian_call_tool|mcp__governor__obsidian_call_tool)
        check_name=$(jq -r '.tool_input.name // empty' <<<"$input")
        label="vault-mcp mutation via Code Mode ($check_name)"
        ;;
    mcp__vault-mcp__*|mcp__governor__*)
        check_name=$tool
        label="vault-mcp mutation ($tool)"
        ;;
    *) exit 0 ;;
esac
case "$check_name" in
    obsidian_append_note) exit 0 ;;
    *read*|*search*|*list*|*get_*|*find_*|*check_links*|*resolve*|*note_history*|*note_diff*|*jump_to*|*open_*|*doctor*|*info*|*tags_list*|*conformance*|*pending_review*)
        exit 0 ;;
esac

ddir=${VAULT_MCP_DISCOVERY_DIR:-$HOME/.claude/vault-mcp}
roots=()
for j in "$ddir"/*.json; do
    [ -f "$j" ] || continue
    r=$(jq -r '.vault_path // empty' "$j" 2>/dev/null)
    [ -n "$r" ] && [ -d "$r" ] && roots+=("$r")
done
[ ${#roots[@]} -gt 0 ] || exit 0   # no vault known here: the host's own guard decides

# Every short one-line string in the input may be a path (path, paths[], from, to,
# moves[].from …); note bodies and long values are skipped.
while IFS= read -r val; do
    [ -n "$val" ] || continue
    rel=${val#/}
    case "$rel" in *..*) continue ;; esac   # the host refuses '..' itself
    for root in "${roots[@]}"; do
        for cand in "$root/$rel" "$root/$rel.md"; do
            state=$(record_state "$cand")
            [ "$state" = record ] && corrective "$label" "$rel"
            [ "$state" = unreadable ] && unreadable "$label" "$rel"
        done
    done
done < <(jq -r '.tool_input | .. | strings | select(length < 1024 and (contains("\n") | not))' <<<"$input")
exit 0
