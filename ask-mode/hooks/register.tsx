import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { verdict } from './policy'
import type { Level } from '../types'

// Stays on until it is turned off; a new session starts with it off.
const level = atom({ plugin: 'ask-mode', key: 'level' } as const, 'off')

// The switch: the band's grey rounded frame, yellow while on.
const FRAME = '#5a5a5a'
const FRAME_HOVER = '#9a9a9a'
const IDLE = '#9a9a9a'

const QUICK_MODEL = 'claude-haiku-5-5'
const DEEP_MODEL = 'claude-opus-5-5'

const LABELS: Record<Level, string> = {
  off: 'off',
  quick: 'quick',
  ask: 'ask',
  deep: 'deep',
}

// What the model reads beside each prompt while the mode is on.
const BRIEFS: Record<Exclude<Level, 'off'>, string> = {
  quick:
    'Ask mode, quick (read-only). The user wants a short, direct answer, not changes. Answer from what you know or a minimal look (a few reads at most). Do not edit files, run commands that change anything, commit, push, install or send anything. If the question needs a real investigation, say so in one line instead of doing it.',
  ask:
    'Ask mode (read-only). The user wants information, not changes. Investigate as much as the question needs with read-only tools, then report what you found: the answer first, then the evidence (files, lines, commands). Do not edit files, run commands that change anything, commit, push, install or send anything; where a change would help, describe it and stop.',
  deep:
    'Ask mode, deep (read-only). The user wants a thorough analysis, not changes. Read the relevant code widely, trace the flow end to end, check each assumption against the code, and use read-only subagents in parallel where they help. Report the answer, the evidence, the options with their trade-offs and risks, and a recommendation. Do not edit files, run commands that change anything, commit, push, install or send anything.',
}

const deny = (why: string) =>
  `Ask mode is on (read-only): ${why}. Do not work around it; answer from what you can read, and say what you would change. The user turns it off with /ask off.`

// The model and effort a step runs on at each level; ask keeps the session's.
// A model's context suffix (`[1m]`) carries over.
function stepModel(at: Level, model: string): { model: string; effort: 'low' | 'max' } | undefined {
  const suffix = /\[[^\]]+\]$/.exec(model)?.[0] ?? ''

  if (at === 'quick') return { model: QUICK_MODEL + suffix, effort: 'low' }
  if (at === 'deep') return { model: model.includes('opus') ? model : DEEP_MODEL + suffix, effort: 'max' }

  return undefined
}

// Herdr: the terminal this session runs in (HC_TERMINAL_ID), so its pane header can show the
// level, and the reader's open mark, while which the band is left to that header.
let herdrTerminal: string | null | undefined
let homeDir: string | null = null
// The wrap-up whose next list you dismissed (0): hidden until the next one.
let hiddenAt = 0
const readerSeen = { open: false, at: 0 }

async function herdr($: EngineInterface) {
  if (herdrTerminal === undefined) {
    try { herdrTerminal = await $.env.get('HC_TERMINAL_ID'); homeDir = await $.env.get('HOME') } catch { herdrTerminal = null }
  }
  return herdrTerminal
}

async function tellHerdr($: EngineInterface, to: Level) {
  const t = await herdr($)
  if (!t || !homeDir) return
  await $.process.run(['sh', '-c', 'mkdir -p "$1" && printf %s "$2" > "$1/$3.json"', 'sh', `${homeDir}/.claude/state/ask-mode`, JSON.stringify({ level: to, at: Date.now() }), t], { timeoutMs: 2000 }).catch(() => {})
}

async function readerOpen($: EngineInterface) {
  const t = await herdr($)
  if (!t || !homeDir) return false
  const now = Date.now()
  if (now - readerSeen.at < 3000) return readerSeen.open
  readerSeen.at = now
  try {
    const r = await $.process.run(['stat', '-f', '%m', `${homeDir}/.claude/state/reader/${t}`], { timeoutMs: 2000 })
    readerSeen.open = r.exitCode === 0 && now - Number(r.stdout.trim()) * 1000 < 45_000
  } catch { readerSeen.open = false }
  return readerSeen.open
}

async function setLevel($: EngineInterface, to: Level) {
  await update($, level, () => to)
  await tellHerdr($, to)
}

const confirmation = (to: Level) =>
  to === 'off'
    ? 'Ask mode off: Claude can change things again.'
    : `Ask mode: ${LABELS[to]} (read-only). Nothing gets changed until /ask off.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ask',
      description: 'Read-only mode: Claude only answers and investigates (/ask off to leave)',
      argumentHint: '[off]',
    })
    await $.command.register({ name: 'quick', description: 'Read-only mode with a short answer from a faster model' })
    await $.command.register({ name: 'deep', description: 'Read-only mode with a thorough analysis at max effort' })
    // A new session starts with the mode off; Herdr's header hears so too.
    await tellHerdr($, await read($, level))

    return next(e)
  })

  // /ask, /quick and /deep turn their level on, and off when it is on already;
  // `/ask off` turns any level off.
  for (const name of ['ask', 'quick', 'deep'] as const) {
    on('command.run', { command: name }, async ($, e) => {
      const now = await read($, level)
      const to: Level = e.args.trim() === 'off' || now === name ? 'off' : name
      await setLevel($, to)

      return { text: confirmation(to) }
    })
  }

  on('prompt.submit', async ($, e, next) => {
    const at = await read($, level)
    if (at === 'off') return next(e)

    return next({ ...e, context: [...(e.context ?? []), BRIEFS[at]] })
  })

  // The guard: a call that may change something is refused, in subagents too.
  on('tool.call', async ($, e, next) => {
    const at = await read($, level)
    if (at === 'off') return next(e)

    const why = verdict(String(e.tool), e as unknown as Record<string, unknown>)

    return why === undefined ? next(e) : { deny: deny(why) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: deny('its guard failed') }))

  // Quick and deep run the main loop's steps on their own model and effort; a
  // request the other model refuses before answering runs on the session's.
  on('turn.step', async function* ($, e, next) {
    const at = await read($, level)
    const want = e.agentId === undefined ? stepModel(at, e.model) : undefined
    if (want === undefined) return yield* next(e)

    let hasStreamed = false
    try {
      const stream = next({ ...e, ...want })
      while (true) {
        const step = await stream.next()
        if (step.done === true) return step.value
        hasStreamed = true
        yield step.value
      }
    } catch (error) {
      if (hasStreamed) throw error
      $.ui.toast(`Ask mode: ${want.model} failed, answering on ${e.model}`)
      return yield* next(e)
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    // In Herdr with the reader open, the pane's header shows the level instead.
    if (e.surface !== 'terminal' || e.props.hasSurvey || (await readerOpen($))) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const at = await read($, level)
    const isOn = at !== 'off'

    // plan-steps' next options (its plan file), above the row: a click fills the prompt, 0 hides.
    let options: string[] = [], wrapAt = 0
    if (herdrTerminal && homeDir && !e.props.isWorking) {
      try {
        const plan = JSON.parse(await $.fs.read(`${homeDir}/.claude/state/plan/${herdrTerminal}.json`) as unknown as string)
        options = Array.isArray(plan?.wrap?.next) ? plan.wrap.next.slice(0, 3) : []
        wrapAt = Number(plan?.wrapAt ?? 0)
      } catch {}
    }
    const showNext = options.length > 0 && hiddenAt !== wrapAt
    const nextList = showNext ? (
      <Box key="next" flexDirection="column" marginTop={1}>
        <Text dimColor>next:</Text>
        {options.map((o, i) => (
          <Box key={`next-${i}`} marginLeft={2}>
            <Button key={`next-btn-${i}`} plain hotkey={String(i + 1)} onPress={async () => { await $.prompt.fill({ text: o }) }}>
              <Text>{o}</Text>
            </Button>
          </Box>
        ))}
        <Box key="next-hide" marginLeft={2}>
          <Button key="next-btn-0" plain hotkey="0" onPress={() => { hiddenAt = wrapAt; $.ui.invalidate("ui.render") }}>
            <Text dimColor>dismiss</Text>
          </Button>
        </Box>
      </Box>
    ) : null

    // A segmented switch beside the panel's button, in the band's rounded
    // frame, starting on the prompt's own column: a click picks a level, a
    // click on the active one turns it off. While on, the frame and the level
    // are yellow and a lock follows the frame, so the switch never moves.
    return (
      <Box flexDirection="column">
      {nextList}
      <Box alignItems="center">
        {below}
        <Box flexShrink={0} alignItems="center">
          <Box
            key="levels"
            flexShrink={0}
            borderStyle="round"
            borderColor={isOn ? 'warning' : FRAME}
            paddingX={1}
            hover={isOn ? undefined : { borderColor: FRAME_HOVER }}
          >
            {(['quick', 'ask', 'deep'] as const).map((to, i) => {
              const isActive = at === to

              return (
                <Box key={`levelbox-${to}`}>
                  {i > 0 && <Text color={FRAME}>{'  │  '}</Text>}
                  <Button
                    key={`level-${to}`}
                    plain
                    onPress={() => setLevel($, isActive ? 'off' : to)}
                    hover={isActive ? undefined : { color: 'white' }}
                  >
                    <Text color={isActive ? 'warning' : IDLE} bold={isActive}>
                      {LABELS[to]}
                    </Text>
                  </Button>
                </Box>
              )
            })}
          </Box>
          <Box flexShrink={0}>
            <Text color="warning">{isOn ? '  🔒 read-only' : ' '}</Text>
          </Box>
        </Box>
      </Box>
      </Box>
    )
  })
}
