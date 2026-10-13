# local-mods

Personal Claude Code mods for a calmer, more readable terminal.

| Mod | What it does |
| --- | --- |
| `readable-width` | Wraps replies and prompts at 80 columns; code blocks and tables keep the full width. Your prompts are bold and accent-colored, with a blank line above each message. |
| `usage-meters` | One band above the prompt: `ctx`, `5h` and `7d` meters, green under 50%, yellow under 80%, red above. |
| `tool-log` | Folds tool calls in the chat into a dim `› N tools` line and keeps them in a side log grouped by prompt. Toggle it with `[ log ]`, `/log` or a click on the line. The chat line also sums file changes (`› 6 tools · 2 files changed +14 −3`). Successful Bash rows expand to show their command, and Edit/Write rows to show their diff. Inside a git repo a `[ diff ]` button opens the built-in `/diff` panel. Replaces the spinner with a minimal one that names the current step, e.g. `⠋ 12s · Reading register.tsx` or `⠙ 3s · Thinking`. |
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
