#!/usr/bin/env bash
# Claude Code statusLine command that mirrors rate_limits for the Claude Usage Cube extension.
#
# Reads the statusLine JSON on stdin, writes
#   {"updated_at": <epoch>, "rate_limits": {...}}
# atomically to ~/.cache/claude-usage-cube/usage.json, then prints a status line.
# Claude Code runs this often, so it uses one jq call and only rewrites the file when
# the numbers change or the last write is a minute old (keeps it from looking stale).
#
# Usage in ~/.claude/settings.json:
#   "statusLine": {"type": "command", "command": "/path/to/statusline-mirror.sh"}
# To keep an existing status line, pass its command as the only argument; it gets the same stdin:
#   "command": "/path/to/statusline-mirror.sh '~/.claude/my-statusline.sh --flag'"
set -u

input=$(cat)
dir="${XDG_CACHE_HOME:-$HOME/.cache}/claude-usage-cube"
out="$dir/usage.json"
refresh=60

# Line 1: rate_limits as compact JSON (empty if absent: non-Pro/Max, or before the first reply).
# Line 2: our status text.
{ IFS= read -r limits; IFS= read -r text; } < <(printf '%s' "$input" | jq -r '
    (.rate_limits | if type == "object" then tojson else "" end),
    ([.model.display_name?, (.rate_limits?.five_hour?.used_percentage? // empty | "5h \(round)%")]
        | map(select(type == "string" and . != "")) | join(" · "))
' 2>/dev/null)

if [ -n "${limits:-}" ]; then
    prev=
    [ -r "$out" ] && IFS= read -r prev < "$out"
    prev_at=0
    [[ $prev =~ \"updated_at\":([0-9]+) ]] && prev_at=${BASH_REMATCH[1]}
    if (( EPOCHSECONDS - prev_at >= refresh )) || [[ $prev != *"\"rate_limits\":$limits}" ]]; then
        mkdir -p "$dir"
        tmp=$(mktemp "$dir/.usage.XXXXXX") &&
            printf '{"updated_at":%s,"rate_limits":%s}\n' "$EPOCHSECONDS" "$limits" > "$tmp" &&
            mv -f "$tmp" "$out" ||
            rm -f "$tmp"
    fi
fi

if [ $# -gt 0 ]; then
    printf '%s' "$input" | sh -c "$1"
else
    printf '%s\n' "${text:-}"
fi
