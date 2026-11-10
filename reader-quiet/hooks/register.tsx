import type { EngineInterface, Register, RenderInput } from 'claude-code'

// While Herdr's Claude reader shows this session, the conversation is read there: the
// terminal keeps the prompt, dialogs, the spinner and slash commands, and draws no replies,
// prompts (beyond one quiet line) or tool rows. Herdr marks its terminals with
// HC_TERMINAL_ID; the reader touches ~/.claude/state/reader/<that id> while it is open, so
// with no reader (or outside Herdr) the terminal shows everything as usual.

// How fresh the reader's mark must be, and how often it is looked at.
const FRESH_MS = 45_000
const LOOK_MS = 3_000

let terminal: string | null = null
let home: string | null = null
// "auto": quiet while a reader is open; "show": never quiet; "hide": always quiet in Herdr.
let mode: 'auto' | 'show' | 'hide' = 'auto'
let seen = { quiet: false, at: 0 }
const lastNote = { text: '' }
const lastCommand = { key: '', at: 0 }

// Looks at the reader's mark; the answer is kept for every drawing until the next look.
async function look($: EngineInterface) {
  if (!terminal || !home) return
  seen.at = Date.now()
  try {
    const r = await $.process.run(['stat', '-f', '%m', `${home}/.claude/state/reader/${terminal}`], { timeoutMs: 2000 })
    seen.quiet = r.exitCode === 0 && Date.now() - Number(r.stdout.trim()) * 1000 < FRESH_MS
  } catch {
    // A look cut short says nothing: keep the last answer.
  }
}

// Answers at once from what the timer last saw, never waiting on a look: a drawing that
// waited would show the engine's own row first, then hide it, a flash while text streams in.
function quiet(_$: EngineInterface, e: RenderInput) {
  if (e.surface !== 'terminal' || !terminal || mode === 'show') return false
  if (mode === 'hide') return true
  return seen.quiet
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      terminal = await $.env.get('HC_TERMINAL_ID')
      home = await $.env.get('HOME')
      // Known before the first reply is drawn, then looked at again on a timer of its own.
      await look($)
      if (terminal) $.clock.every(LOOK_MS, () => { void look($) })
    } catch {}
    await $.command.register({
      name: 'terminal-output',
      description: 'Replies in the terminal while Herdr\'s reader is open: auto, show or hide',
      argumentHint: 'auto | show | hide',
    })
    return started
  })

  on('command.run', { command: 'terminal-output' }, async ($, e) => {
    const want = e.args.trim()
    if (want === 'auto' || want === 'show' || want === 'hide') mode = want
    seen.at = 0
    const what = { auto: 'hidden while the reader is open', show: 'always shown', hide: 'always hidden in Herdr' }[mode]
    return { text: `Replies in the terminal: ${mode} (${what}).` }
  })

  // Replies, tool rows and their progress, and the spinner: nothing in the terminal while the
  // reader shows the conversation and the pane's header shows the turn's clock.
  for (const component of ['AssistantMessage', 'ToolUse', 'ToolGroup', 'ToolResult', 'ToolProgress', 'TurnDuration', 'Spinner'] as const) {
    on('ui.render', { component }, ($, e, next) => {
      if (!quiet($, e)) return next(e)
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
  }

  // Slash commands' output (`Reloaded: 4 plugins…`): appended to a file the reader shows
  // under the command, and not drawn here.
  on('ui.render', { component: 'CommandOutput' }, ($, e, next) => {
    if (!quiet($, e)) return next(e)
    const key = `${e.props.command}\u0000${e.props.args}\u0000${e.props.text}`
    if (key !== lastCommand.key || Date.now() - lastCommand.at > 600_000) {
      lastCommand.key = key
      lastCommand.at = Date.now()
      const row = JSON.stringify({ command: e.props.command, args: e.props.args, text: e.props.text, errored: e.props.isErrored, at: Date.now() })
      $.process.run(['sh', '-c', 'mkdir -p "$1" && printf "%s\n" "$2" >> "$1/$3.commands.jsonl"', 'sh', `${home}/.claude/state/reader`, row, terminal ?? 'none'], { timeoutMs: 2000 }).catch(() => {})
    }
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // Notices ("Update installed", hints after a command): to a file the pane's header shows.
  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) => {
    if (!quiet($, e)) return next(e)
    const key = `${e.props.text}\u0000${e.props.command ?? ''}`
    if (key !== lastNote.text) {
      lastNote.text = key
      const note = JSON.stringify({ text: e.props.text, command: e.props.command, at: Date.now() })
      $.process.run(['sh', '-c', 'mkdir -p "$1" && printf %s "$2" > "$1/$3.notice.json"', 'sh', `${home}/.claude/state/reader`, note, terminal ?? 'none'], { timeoutMs: 2000 }).catch(() => {})
    }
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // Your prompts: the reader shows them as bubbles, so the terminal keeps only the prompt.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // Every row you sent (typed prompts and slash commands alike); the reader shows them.
    if (!quiet($, e)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

}
