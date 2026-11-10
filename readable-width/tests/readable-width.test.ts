import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const REPLY = { text: 'Hi, this is a reply.', isFirstOfReply: true }
const ENGINE: RenderElement = { type: 'Box', props: {}, children: [] }

test('draws a reply unframed, at the left edge', async ($, on) => {
  on('ui.render', () => ENGINE)

  const ui = await $.ui.mount({
    plugin: 'readable-width',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: REPLY,
    viewport: { columns: 200, rows: 50 },
  })

  const drawn = await ui.drawn()
  expect(drawn).toMatchObject({ type: 'Box', props: { marginLeft: 0, marginTop: 1 } })
  expect(JSON.stringify(drawn)).not.toContain('borderStyle')
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

  expect(await ui.drawn()).toMatchObject(ENGINE)
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
  expect(drawn.match(/"width":80/g)).toHaveLength(2)
  expect(drawn.match(/"width":200/g)).toHaveLength(3)
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

  expect(await ui.drawn()).toMatchObject({
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
    props: { marginLeft: 0, marginTop: 1, borderStyle: 'round', borderColor: 'claude', width: 21 },
  })
  expect(await ui.find({ type: 'Text', text: 'show an example' })).toMatchObject({
    props: { bold: true, color: 'claude' },
  })
})

test('gives a pasted image a chip that opens its picture', async ($, on) => {
  on('ui.render', () => ENGINE)
  on('session.start', () => ({ cwd: '/Users/me/dev' }) as never)
  on('session.id', () => ({ value: 'abc' }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('process.run', (_, e) =>
    ({
      value: {
        exitCode: 0,
        stdout: (e as { argv: string[] }).argv[0] === 'id' ? '501\n' : 'PNG image data, 1600 x 1000, 8-bit/color RGBA',
        stderr: '',
      },
    }) as never,
  )

  await $.session.start({ cwd: '/Users/me/dev' } as never)
  const ui = await $.ui.mount({
    plugin: 'readable-width',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: '[Image #4] what is this?', origin: { kind: 'composer' }, isExpanded: true } as never,
    viewport: { columns: 200, rows: 50 },
  })

  expect(await ui.find({ text: '▣ Image #4 ▸' })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.press({ key: 'image-chip-4' })
  expect(await ui.find({ type: 'Image' })).toMatchObject({
    props: { source: { file: '/private/tmp/claude-501/-Users-me-dev/abc/images/4.png', format: 'png' }, columns: 64, rows: 20 },
  })
})

test('remembers the images sent with a prompt for its row', async ($, on) => {
  on('ui.render', () => ENGINE)
  on('session.start', () => ({ cwd: '/Users/me/dev' }) as never)
  on('session.id', () => ({ value: 'abc' }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.list', () => ({ value: [{ name: '2.png', kind: 'file', size: 1 }, { name: '10.png', kind: 'file', size: 1 }, { name: '9.png', kind: 'file', size: 1 }] }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('process.run', (_, e) =>
    ({ value: { exitCode: 0, stdout: (e as { argv: string[] }).argv[0] === 'id' ? '501\n' : 'PNG image data, 800 x 800', stderr: '' } }) as never,
  )

  await $.session.start({ cwd: '/Users/me/dev' } as never)
  await $.prompt.submit({ text: 'look', attachments: [{ type: 'image' }], origin: { kind: 'composer' }, wait: false } as never)
  const ui = await $.ui.mount({
    plugin: 'readable-width',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'look', origin: { kind: 'composer' }, isExpanded: true } as never,
    viewport: { columns: 200, rows: 50 },
  })

  expect(await ui.find({ text: '▣ Image #10 ▸' })).toBeDefined()
  expect(await ui.find({ text: /Image #9/ })).toBeUndefined()
})

// A 48 × 30 top-down 32-bit BMP of one color, #6e7cf6, as sips writes it.
const BMP = 'Qk0KFwAAAAAAAIoAAAB8AAAAMAAAAOL///8BACAAAwAAAIAWAAATCwAAEwsAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/9nxu//Z8bv/2fG7/'

test('draws an opened picture as half-block cells', async ($, on) => {
  on('ui.render', () => ENGINE)
  on('session.start', (_, e) => e as never)
  on('session.id', () => ({ value: 'abc' }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    const stdout = argv[0] === 'id' ? '501\n' : argv[0] === 'file' ? 'PNG image data, 1600 x 1000' : argv[0] === 'base64' ? BMP : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })

  await $.session.start({ cwd: '/Users/me/dev' } as never)
  const ui = await $.ui.mount({
    plugin: 'readable-width',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: '[Image #4] look', origin: { kind: 'composer' }, isExpanded: true } as never,
    viewport: { columns: 200, rows: 50 },
  })
  await ui.press({ key: 'image-chip-4' })

  const raster = await ui.find({ type: 'Raster' })
  expect(raster).toMatchObject({ props: { columns: 64, rows: 20 } })
  // The first cell: an upper half block, both halves the picture's color.
  const cells = (raster?.props as { cells: string }).cells
  expect(cells.slice(0, 16)).toBe('gCUAAPZ8bgD2fG4A')
})
