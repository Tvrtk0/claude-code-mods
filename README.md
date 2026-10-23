# local-mods

Personal Claude Code mods for a calmer, more readable terminal.

| Mod | What it does |
| --- | --- |
| `readable-width` | Draws each piece of a reply in a grey rounded card, as wide as its longest line and wrapped at 80 columns; tables and code blocks that name a language keep the full width; an unlabelled or `text` block wraps like prose. Your prompts are bold and accent-colored, in a rounded accent-colored bubble as wide as their longest line, with a blank line above each message. |
| `usage-meters` | The bottom of the band above the prompt, under the other mods' buttons: `ctx`, `5h` and `7d` meters in one rounded frame. Each bar runs teal to green to yellow to red along its length, so a fuller bar reaches warmer colors; `5h` and `7d` also show the time left until they reset (`2h 16m`, `3d 4h`). The pointer on a meter shows a card over the buttons: the context's tokens and the session's cost, or when a limit resets (`today 18:00`, `Fri 16:00`). |
| `tool-log` | Folds tool calls and their results in the chat into a `◆ N tools` line, one per run of calls with no text between them, and keeps them in a side log grouped by prompt. Toggle it with the framed `☰ panel` button, `/panel` or a key bound to `app:toggleDiffPreSession` (`ctrl+t` in `~/.claude/keybindings.json`, see below; this replaces the built-in todo list toggle); a click on a chat line opens it on that prompt's steps, until the next prompt or `✕` returns it to live. The chat line also sums file changes and failures (`◆ 6 tools · 2 files changed +14 −3 · 1 failed`). A turn longer than 30 s ends with a desktop notification. Successful Bash rows expand to show their command, and Edit/Write rows to show their diff. Inside a git repo a framed `± diff` button opens the built-in `/diff` panel. The panel has three tabs: **Log**, **Files** (every file changed this session with its diff, new files included) and **Agents** (subagents with status, time, tool count and their latest step); `☰ panel` reopens it on the tab last in view. The active tab is orange, a tab with something new since you last looked is bright, the rest are dim. Replaces the spinner with a minimal one that names the current step, e.g. `⠋ 12s · Reading register.tsx` or `⠙ 3s · Thinking`. |
| `turn-details` | Replaces the `Brewed for 34s · done 1:09 PM` line with `◆ details ▸`, which folds the turn's duration, finish time, tool calls and model open in place. |
| `ask-mode` | A read-only mode for when you want an answer, not changes. Beside the panel button, a framed `quick │ ask │ deep` switch: a click picks a level, a click on the active one turns it off; `/quick`, `/ask` and `/deep` do the same, `/ask off` leaves any. While on, the frame and the level are yellow beside a 🔒, every prompt carries a brief to answer and report, and every call that may change something is refused, in subagents too: Edit, Write, Bash commands off a read-only list (`ls`, `cat`, `rg`, `git log/diff/status/show`, `gh pr view`…; redirects and command substitution included), MCP tools whose name does not read (`send`, `create`, `update`…). **quick** answers briefly on Haiku 5.5 at low effort, **ask** investigates on your model, **deep** analyzes at max effort on Opus. It stays on until you turn it off; a new session starts with it off. |

## Install

From GitHub:

```sh
claude plugin marketplace add Tvrtk0/claude-code-mods
claude plugin install readable-width@local-mods
claude plugin install usage-meters@local-mods
claude plugin install tool-log@local-mods
claude plugin install turn-details@local-mods
claude plugin install ask-mode@local-mods
```

From a local clone (edits apply after `/reload-plugins`, no reinstall):

```sh
claude plugin marketplace add ~/.claude/mods
claude plugin install readable-width@local-mods
claude plugin install usage-meters@local-mods
claude plugin install tool-log@local-mods
claude plugin install turn-details@local-mods
claude plugin install ask-mode@local-mods
```

Installed from a local clone, plugins are read straight from the folder.

## Develop

```sh
claude plugin validate ~/.claude/mods/<mod>
claude plugin test ~/.claude/mods/<mod>
```

## Keyboard shortcut for the panel

A mod cannot add a key of its own, so the `⌃T` hint beside `☰ panel` borrows an engine action that only the `/diff` panel handles. Bind any key to it:

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "bindings": [
    { "context": "Global", "bindings": { "ctrl+t": "app:toggleDiffPreSession" } }
  ]
}
```

`ctrl+t` hands the panel the keyboard (opening it if needed) and closes it when it already has it. Inside: `h`/`l` or `1`–`3` switch tabs, `j`/`k` move between rows (starting from the newest), `enter` opens one, `d`/`u` scroll half a window, `g`/`b` jump to the first or last row, `esc` returns to the prompt and leaves the panel open. The panel scrolls itself, so its tabs and keys stay at the top; Bottom is `b`, not `G`: a button hotkey cannot tell `shift+g` from `g`.
