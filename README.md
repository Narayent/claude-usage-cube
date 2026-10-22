# Claude Usage Cube

A GNOME Shell extension that puts a small rounded square in the top bar. Its color shows how much of your
**Claude 5-hour session limit** you've used: green → yellow → orange → red (smoothly blended).
Click it for the exact percentage, when the window resets, your 7-day usage, and a "Refresh now" button.

Works with a Claude Pro/Max subscription. **No API key needed**: it reuses the login Claude Code already stores.

Tested on Fedora 44, GNOME Shell 50 (Wayland). `metadata.json` declares GNOME 49 and 50.

## Install

```sh
make install          # copies to ~/.local/share/gnome-shell/extensions/claude-usage-cube@local
```

On Wayland the running shell can't load new extension code: **log out and back in**, then

```sh
gnome-extensions enable claude-usage-cube@local
```

After later changes, `make install` again and log out/in. `make uninstall` removes it.

You need to have logged in to Claude Code once (`claude`, then `/login`) so that
`~/.claude/.credentials.json` exists.

## Settings

`gnome-extensions prefs claude-usage-cube@local`, or *Settings* in the cube's menu.

| Setting | Default | |
|---|---|---|
| Check every | 180 s | 60–3600 s. Backs off automatically (up to 15 min) if the server rate-limits. |
| Data source | Automatic | Automatic = OAuth API, falling back to the status-line file. Or force one of them. |
| Position | Right | Left (after Activities), Center (after the clock) or Right. |
| Show percentage | off | Shows "42 %" next to the cube. |

Cube states: colored = current usage; grey = no data (menu says why, with "!" if you're not logged in).
"(stale)" in the menu means the last update failed or the data is old; the cube keeps the last known color.

## Where the data comes from

### 1. OAuth usage endpoint (default)

`GET https://api.anthropic.com/api/oauth/usage` with the access token from `~/.claude/.credentials.json`.
It counts all your usage (claude.ai chats included, not just Claude Code).

> ⚠️ **This endpoint is unofficial and undocumented.** It can change or disappear without notice.
> The extension parses it defensively and shows grey instead of breaking, but it may stop working.

- The token is read fresh on every check (Claude Code refreshes it). The extension never refreshes tokens,
  never writes to `~/.claude/`, and never logs or stores the token.
- The last good result is cached in `~/.cache/claude-usage-cube/oauth.json` so turning the extension off and
  on (e.g. the lock screen) doesn't cost a request. The endpoint rate-limits eagerly.

### 2. Status-line fallback (opt-in)

Claude Code passes `rate_limits` to its status line command (Pro/Max only, after the first reply of a session).
`scripts/statusline-mirror.sh` copies that into `~/.cache/claude-usage-cube/usage.json`, which the
extension watches. Data older than 5 h is shown as stale. Needs `jq`.

Wire it up in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/full/path/to/scripts/statusline-mirror.sh"
  }
}
```

It prints a short status line (`Opus · 5h 42%`). **Already have a status line?** Don't replace it, wrap it:
pass your existing command as the single argument and it receives the same input:

```json
"command": "/full/path/to/scripts/statusline-mirror.sh '~/.claude/my-statusline.sh --flag'"
```

## Development

```sh
make test         # unit tests (gjs): colors, response parsing
make install
make nested       # nested GNOME Shell in a window (GNOME 49+: needs `sudo dnf install mutter-devkit`)
make enable       # enable/disable inside the nested shell (not your real session)
make cycle        # disable/enable 5x to check teardown
make nested-logs  # errors from the nested shell
make logs         # follow the real session's journal
make pack         # zip for manual install
```

The nested shell shares your settings (dconf) with the real session, so enabling the extension or changing
its settings there also applies to your real session. Each start of the nested shell does one API check
unless a fresh cached result exists.

## Files

```
claude-usage-cube@local/
  extension.js   panel button, cube drawing, menu, polling/backoff, file watching
  usage.js       data sources: fetch + parse (never throws), cache
  color.js       percent → color
  prefs.js       settings window
  stylesheet.css, metadata.json, schemas/
scripts/statusline-mirror.sh
tests/           gjs -m tests/*.test.js, fixtures/
```
