import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const REPLY = { text: 'Hi, this is a reply.', isFirstOfReply: true }
const ENGINE: RenderElement = { type: 'Box', props: {}, children: [] }

test('pads a reply and caps its prose at 80', async ($, on) => {
  on('ui.render', () => ENGINE)

  const ui = await $.ui.mount({
    plugin: 'readable-width',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: REPLY,
    viewport: { columns: 200, rows: 50 },
  })

  expect(await ui.drawn()).toMatchObject({
    type: 'Box',
    props: { marginLeft: 0, width: 200 },
  })
  expect(await ui.find({ text: 'Hi, this is a reply.' })).toBeDefined()
})

test('leaves a narrow terminal to the engine', async ($, on) => {
  on('ui.render', () => ENGINE)

  const ui = await $.ui.mount({
    plugin: 'readable-width',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: REPLY,
    viewport: { columns: 30, rows: 50 },
  })

  expect(await ui.drawn()).toEqual(ENGINE)
})

test('gives code and tables the room to the right edge', async ($, on) => {
  on('ui.render', () => ENGINE)

  const text = [
    'A short intro.',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const x = 1',
    '```',
    '',
    'The end.',
  ].join('\n')

  const ui = await $.ui.mount({
    plugin: 'readable-width',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
    viewport: { columns: 200, rows: 50 },
  })

  const markdowns = await ui.findAll({ type: 'Markdown' })
  expect(markdowns.map(m => m.text)).toEqual([
    'A short intro.',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '```ts\nconst x = 1\n```',
    'The end.',
  ])

  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.match(/"width":78/g)).toHaveLength(2)
  expect(drawn.match(/"width":198/g)).toHaveLength(2)
})

test('moves tool rows to the same left edge', async ($, on) => {
  on('ui.render', () => ENGINE)

  const ui = await $.ui.mount({
    plugin: 'readable-width',
    surface: 'terminal',
    component: 'TurnDuration',
    props: { durationMs: 3000, verb: 'Baked' } as never,
    viewport: { columns: 200, rows: 50 },
  })

  expect(await ui.drawn()).toEqual({
    type: 'Box',
    props: { marginLeft: 0 },
    children: [ENGINE],
  })
})

test('marks a typed prompt and spaces it from the row above', async ($, on) => {
  on('ui.render', () => ENGINE)

  const ui = await $.ui.mount({
    plugin: 'readable-width',
    surface: 'terminal',
    component: 'UserMessage',
    props: {
      text: 'show an example',
      origin: { kind: 'composer' },
      isExpanded: true,
    } as never,
    viewport: { columns: 200, rows: 50 },
  })

  expect(await ui.drawn()).toMatchObject({
    type: 'Box',
    props: { marginLeft: 0, marginTop: 1 },
  })
  expect(await ui.find({ type: 'Text', text: 'show an example' })).toMatchObject({
    props: { bold: true, color: 'claude' },
  })
})
