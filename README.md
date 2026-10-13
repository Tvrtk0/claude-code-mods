# local-mods

Personal Claude Code mods for a calmer, more readable terminal.

| Mod | What it does |
| --- | --- |
| `readable-width` | Wraps replies and prompts at 80 columns; tables and code blocks that name a language keep the full width; an unlabelled or `text` block wraps like prose. Your prompts are bold and accent-colored, with a blank line above each message. |
| `usage-meters` | One band above the prompt: `ctx`, `5h` and `7d` meters, green under 50%, yellow under 80%, red above. |
| `tool-log` | Folds tool calls and their results in the chat into a dim `› N tools` line and keeps them in a side log grouped by prompt. Toggle it with `[ panel ]` or `/panel`; a click on a chat line opens it on that prompt's steps, until the next prompt or `✕` returns it to live. The chat line also sums file changes (`› 6 tools · 2 files changed +14 −3`). Successful Bash rows expand to show their command, and Edit/Write rows to show their diff. Inside a git repo a `[ diff ]` button opens the built-in `/diff` panel. The panel has four tabs: **Log**, **Files** (every file changed this session with its diff), **Agents** (subagents with status, time, tool count and their latest step) and **Todo** (Claude's plan); `[ panel ]` reopens it on the tab last in view. The active tab is orange, a tab with something new since you last looked is bright, the rest are dim. Replaces the spinner with a minimal one that names the current step, e.g. `⠋ 12s · Reading register.tsx` or `⠙ 3s · Thinking`. |
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
