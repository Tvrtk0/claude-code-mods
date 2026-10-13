import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const ENGINE: RenderElement = { type: 'Box', props: {}, children: [] }

test('replaces the duration line with a button that opens the turn', async ($, on) => {
  on('ui.render', () => ENGINE)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('clock.now', () => ({ value: 0 }) as never)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'a' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pwd', tool_use_id: 'b' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/x', tool_use_id: 'c' } as never)
  await $.turn.complete({
    answer: 'ok',
    durationMs: 34_000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })

  const row = await $.ui.mount({
    plugin: 'turn-details',
    surface: 'terminal',
    component: 'TurnDuration',
    props: { word: 'Brewed', durationMs: 34_000 },
  })
  expect(await row.find({ type: 'Button', text: /details/ })).toBeDefined()
  expect(await row.find({ text: '34s' })).toBeUndefined()

  await row.press({ key: 'details' })
  expect(await row.find({ text: '34s' })).toBeDefined()
  expect(await row.find({ text: '3 (Bash 2, Read 1)' })).toBeDefined()

  await row.press({ key: 'details' })
  expect(await row.find({ text: '34s' })).toBeUndefined()
})

test('leaves an unknown turn to the engine', async ($, on) => {
  on('ui.render', () => ENGINE)

  const row = await $.ui.mount({
    plugin: 'turn-details',
    surface: 'terminal',
    component: 'TurnDuration',
    props: { word: 'Brewed', durationMs: 1234 },
  })
  expect(await row.drawn()).toEqual(ENGINE)
})
