import type { EngineInterface, Register } from 'claude-code'

// A queue of prompts for later. The "queue" button in the band above the prompt (or
// `/next <text>`) takes the draft and keeps it instead of sending it into the turn that
// runs; when the turn ends, the first one goes as an ordinary prompt. A turn that ends on a
// question to you holds the queue until the next turn ends. `/queue` lists it, `/queue
// clear` empties it. Herdr's progress pane reads ~/.claude/state/queue/<terminal>.json.

let queue: string[] = []
let running = false
let paused = false
let terminal: string | null = null
let home: string | null = null

async function save($: EngineInterface) {
  if (!terminal || !home) return
  try { await $.fs.write(`${home}/.claude/state/queue/${terminal}.json`, JSON.stringify({ queue, paused, at: Date.now() })) } catch {}
}

async function push($: EngineInterface, text: string) {
  const t = text.trim()
  if (!t) return false
  if (!running && !queue.length) {
    await $.prompt.submit({ text: t })
    return true
  }
  queue.push(t)
  await save($)
  $.ui.toast(`Queued (${queue.length}): ${t.slice(0, 60)}`)
  return true
}

async function sendNext($: EngineInterface) {
  if (running || paused || !queue.length) return
  const t = queue.shift()!
  await save($)
  await $.prompt.submit({ text: t })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      terminal = (await $.env.get('HC_TERMINAL_ID')) ?? null
      home = (await $.env.get('HOME')) ?? null
    } catch {}
    await $.command.register({ name: 'next', description: 'Queue a prompt to send when this turn ends', argumentHint: '<prompt>' })
    await $.command.register({ name: 'queue', description: 'List the queued prompts, or empty the queue', argumentHint: '[clear]' })
    await save($)
    return started
  })

  on('command.run', { command: 'next' }, async ($, e) => {
    await push($, e.args)
    return { text: running ? `Queued: ${queue.length} waiting.` : 'Sent.' }
  })

  on('command.run', { command: 'queue' }, async ($, e) => {
    if (e.args.trim() === 'clear') { queue = []; paused = false; await save($); return { text: 'Queue emptied.' } }
    if (!queue.length) return { text: 'The queue is empty.' }
    return { text: `${paused ? 'Held (the last turn asked you something).\n' : ''}${queue.map((q, i) => `${i + 1}. ${q}`).join('\n')}` }
  })

  on('turn.start', async ($, e, next) => {
    if (!(e as unknown as { agentId?: string }).agentId) running = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    running = false
    // A turn that ends on a question waits for your answer; the queue holds until then.
    const asked = /\?\s*$/.test((e.answer ?? '').trim())
    if (queue.length && asked && !e.isAborted) {
      paused = true
      await save($)
      $.ui.toast(`Queue held: Claude asked you something (${queue.length} waiting)`)
      return done
    }
    paused = false
    if (!e.isAborted) void $.clock.sleep(600).then(() => sendNext($))
    else await save($)
    return done
  })

  // The button: beside whatever the band already holds (ask-mode's switch).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.surface !== 'terminal' || e.props.hasSurvey) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center">
        {below}
        <Box key="queue" flexShrink={0} marginRight={1} borderStyle="round" borderColor={queue.length ? 'warning' : '#5a5a5a'} paddingX={1}
          hover={{ borderColor: '#9a9a9a' }}>
          <Button key="queue-button" plain onPress={async () => {
            const { text } = await $.prompt.read()
            if (await push($, text)) await $.prompt.fill({ text: '' })
          }} hover={{ color: 'white' }}>
            <Text color={queue.length ? 'warning' : '#9a9a9a'}>{queue.length ? `queue ${queue.length}${paused ? ' ‖' : ''}` : 'queue'}</Text>
          </Button>
        </Box>
        {queue.length > 0 && (
          <Box flexShrink={0} marginLeft={1}>
            <Text color="warning">{`${paused ? 'held · ' : 'next: '}${queue[0].replace(/\s+/g, ' ').slice(0, 48)}${queue[0].length > 48 ? '…' : ''}${queue.length > 1 ? ` (+${queue.length - 1})` : ''}`}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
