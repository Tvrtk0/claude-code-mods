# local-mods

Personal Claude Code mods for a calmer, more readable terminal.

| Mod | What it does |
| --- | --- |
| `readable-width` | Wraps replies and prompts at 80 columns; tables and code blocks that name a language keep the full width; an unlabelled or `text` block wraps like prose. Your prompts are bold and accent-colored, with a blank line above each message. |
| `usage-meters` | One band above the prompt: `ctx`, `5h` and `7d` meters, green under 50%, yellow under 80%, red above; `5h` also shows the time left until it resets. |
| `tool-log` | Folds tool calls and their results in the chat into a dim `› N tools` line and keeps them in a side log grouped by prompt. Toggle it with `[ panel ]`, `/panel` or a key bound to `app:toggleDiffPreSession` (`ctrl+t` in `~/.claude/keybindings.json`, see below; this replaces the built-in todo list toggle, which the Todo tab covers); a click on a chat line opens it on that prompt's steps, until the next prompt or `✕` returns it to live. The chat line also sums file changes and failures (`› 6 tools · 2 files changed +14 −3 · 1 failed`). A turn longer than 30 s ends with a desktop notification. Successful Bash rows expand to show their command, and Edit/Write rows to show their diff. Inside a git repo a `[ diff ]` button opens the built-in `/diff` panel. The panel has four tabs: **Log**, **Files** (every file changed this session with its diff), **Agents** (subagents with status, time, tool count and their latest step) and **Todo** (Claude's plan); `[ panel ]` reopens it on the tab last in view. The active tab is orange, a tab with something new since you last looked is bright, the rest are dim. Replaces the spinner with a minimal one that names the current step and the plan's progress, e.g. `⠋ 12s · 3/7 · Reading register.tsx` or `⠙ 3s · Thinking`. |
| `turn-details` | Replaces the `Brewed for 34s · done 1:09 PM` line with `📋 details ▸`, which folds the turn's duration, finish time, tool calls and model open in place. |

## Install

From GitHub:

```sh
claude plugin marketplace add Tvrtk0/claude-code-mods
claude plugin install readable-width@local-mods
claude plugin install usage-meters@local-mods
claude plugin install tool-log@local-mods
claude plugin install turn-details@local-mods
```

From a local clone (edits apply after `/reload-plugins`, no reinstall):

```sh
claude plugin marketplace add ~/.claude/mods
claude plugin install readable-width@local-mods
claude plugin install usage-meters@local-mods
claude plugin install tool-log@local-mods
claude plugin install turn-details@local-mods
```

Installed from a local clone, plugins are read straight from the folder.

## Develop

```sh
claude plugin validate ~/.claude/mods/<mod>
claude plugin test ~/.claude/mods/<mod>
```

## Keyboard shortcut for the panel

A mod cannot add a key of its own, so the `[ panel ]` button borrows an engine action that only the `/diff` panel handles. Bind any key to it:

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "bindings": [
    { "context": "Global", "bindings": { "ctrl+t": "app:toggleDiffPreSession" } }
  ]
}
```

`ctrl+t` hands the panel the keyboard (opening it if needed) and closes it when it already has it. Inside: `h`/`l` or `1`–`4` switch tabs, `j`/`k` move between rows (starting from the newest), `enter` opens one, `d`/`u` scroll half a window, `g`/`b` jump to the first or last row, `esc` returns to the prompt and leaves the panel open. The panel scrolls itself, so its tabs and keys stay at the top; Bottom is `b`, not `G`: a button hotkey cannot tell `shift+g` from `g`.
