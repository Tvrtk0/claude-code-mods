import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const ENGINE: RenderElement = { type: 'Box', props: {}, children: [] }

test('logs tool calls and folds them in the chat', async ($, on) => {
  let clock = 1_000
  on('ui.render', () => ENGINE)
  on('clock.now', () => ({ value: (clock += 10) }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  on('tool.call', (_, e) =>
    (e.tool_use_id === 'c' ? { result: 'nope', isError: true } : { result: 'ok' }) as never,
  )

  on('prompt.submit', (_, e) => ({ text: e.text }) as never)

  await $.prompt.submit({ text: 'show an example', origin: { kind: 'composer' }, wait: false } as never)
  await $.tool.call({
    tool: 'Bash',
    command: 'ls -la /Users/me/dev',
    description: 'List the mods',
    tool_use_id: 'a',
  } as never)
  await $.tool.call({ tool: 'Read', file_path: '/x/y/register.tsx', tool_use_id: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'cat /Users/me/nope', tool_use_id: 'c' } as never)

  const pane = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tool-log',
    props: { title: 'Log', isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { bodyRows: 30 } } as never,
    viewport: { columns: 200, rows: 40 },
  })
  expect(await pane.find({ text: 'show an example' })).toBeDefined()
  expect(await pane.find({ text: 'List the mods' })).toBeDefined()
  expect(await pane.find({ text: 'ls -la' })).toBeUndefined()
  expect(await pane.find({ text: /Read register\.tsx/ })).toBeDefined()
  expect(await pane.find({ text: '✗' })).toBeDefined()
  expect(await pane.find({ text: 'cat ~/nope' })).toBeDefined()

  await pane.press({ key: 'a' })
  expect(await pane.find({ text: 'ls -la ~/dev' })).toBeDefined()
  await pane.press({ key: 'a' })
  expect(await pane.find({ text: 'ls -la ~/dev' })).toBeUndefined()

  const group = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [
        { tool: 'Bash', input: {}, isRunning: false, isErrored: false },
        { tool: 'Read', input: {}, isRunning: false, isErrored: false },
      ],
      isActive: false,
      isExpanded: false,
    } as never,
  })
  expect(await group.find({ type: 'Button', text: '› 2 tools' })).toBeDefined()
})

test('draws a small spinner with the elapsed time', async ($, on) => {
  on('ui.render', () => ENGINE)

  const spinner = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'Spinner',
    props: { word: 'Kerfuffling', message: null, suffix: '…', mode: 'thinking' },
  })
  expect(await spinner.find({ text: '⠋' })).toBeDefined()
  expect(await spinner.find({ text: '0s' })).toBeDefined()
  expect(await spinner.find({ text: /Kerfuffling/ })).toBeUndefined()
  expect(await spinner.find({ text: /Thinking/ })).toBeDefined()
})

test('sums file changes in the chat and shows the diff on click', async ($, on) => {
  on('ui.render', () => ENGINE)
  on('clock.now', () => ({ value: 1_000 }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  on('tool.call', () =>
    ({
      result: {
        filePath: '/x/register.tsx',
        structuredPatch: [
          { oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: ['-const A = 4', '+const A = 0', '+const B = 1'] },
        ],
      },
    }) as never,
  )

  await $.tool.call({
    tool: 'Edit',
    file_path: '/x/register.tsx',
    old_string: 'const A = 4',
    new_string: 'const A = 0\nconst B = 1',
    tool_use_id: 'e1',
  } as never)

  const row = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'ToolUse',
    props: { tool_use_id: 'e1', tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false } as never,
  })
  expect(await row.find({ type: 'Button', text: '› 1 tool · 1 file changed +2 −1' })).toBeDefined()

  const pane = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tool-log',
    props: { title: 'Log', isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { bodyRows: 30 } } as never,
  })
  expect(await pane.find({ type: 'Code' })).toBeUndefined()
  await pane.press({ key: 'e1' })
  expect(await pane.find({ type: 'Code' })).toBeDefined()
})

test('a chat line focuses its prompt until the next prompt', async ($, on) => {
  on('ui.render', () => ENGINE)
  let clock = 1_000
  on('clock.now', () => ({ value: clock }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)

  await $.prompt.submit({ text: 'first prompt', origin: { kind: 'composer' }, wait: false } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List', tool_use_id: 'a' } as never)
  clock = 2_000
  await $.prompt.submit({ text: 'second prompt', origin: { kind: 'composer' }, wait: false } as never)
  await $.tool.call({ tool: 'Bash', command: 'pwd', description: 'Where', tool_use_id: 'b' } as never)

  const row = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'ToolUse',
    props: { tool_use_id: 'a', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false } as never,
  })
  await row.press({ key: 'log' })

  const pane = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tool-log',
    props: { title: 'Log', isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { bodyRows: 30 } } as never,
  })
  expect(await pane.find({ text: /viewing: first prompt/ })).toBeDefined()
  expect(await pane.find({ text: 'second prompt' })).toBeUndefined()

  await $.prompt.submit({ text: 'third prompt', origin: { kind: 'composer' }, wait: false } as never)
  expect(await pane.find({ text: /viewing:/ })).toBeUndefined()
})

const PANE_PROPS = { title: 'Log', isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { bodyRows: 30 } } as never

test('keeps the plan from TodoWrite in the Todo tab', async ($, on) => {
  on('ui.render', () => ENGINE)
  on('clock.now', () => ({ value: 1_000 }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Write the tabs', status: 'in_progress', activeForm: 'Writing the tabs' },
      { content: 'Push', status: 'pending', activeForm: 'Pushing' },
    ],
    tool_use_id: 't',
  } as never)

  const band = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3 } as never,
  })
  await band.press({ key: 'log-toggle' })

  const pane = await $.ui.mount({ plugin: 'tool-log', surface: 'terminal', component: 'Pane', requestId: 'tool-log', props: PANE_PROPS })
  await pane.press({ key: 'tab-todo' })
  expect(await pane.find({ text: '1/3 done' })).toBeDefined()
  expect(await pane.find({ text: 'Writing the tabs' })).toBeDefined()
  expect(await pane.find({ text: 'Push' })).toBeDefined()
})

test('tracks a subagent and keeps its calls out of the log', async ($, on) => {
  on('ui.render', () => ENGINE)
  on('clock.now', () => ({ value: 1_000 }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag1' }) as never)
  on('agent.list', () => ({ value: [{ id: 'ag1', description: 'Review PR 12', type: 'Explore', status: 'running' }] }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)

  await $.agent.spawn({ tool_use_id: 'x', prompt: 'p', description: 'Review PR 12', subagentType: 'Explore' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/a/b.ts', tool_use_id: 's1', agentId: 'ag1' } as never)

  const band = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3 } as never,
  })
  await band.press({ key: 'log-toggle' })

  const pane = await $.ui.mount({ plugin: 'tool-log', surface: 'terminal', component: 'Pane', requestId: 'tool-log', props: PANE_PROPS })
  await pane.press({ key: 'tab-agents' })
  expect(await pane.find({ text: 'Review PR 12' })).toBeDefined()
  expect(await pane.find({ text: /1 tool/ })).toBeDefined()
  expect(await pane.find({ text: '› Reading b.ts' })).toBeDefined()
})

test('counts failed calls on the chat line', async ($, on) => {
  on('ui.render', () => ENGINE)

  const group = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [
        { tool: 'Bash', input: {}, isRunning: false, isErrored: true },
        { tool: 'Read', input: {}, isRunning: false, isErrored: false },
      ],
      isActive: false,
      isExpanded: false,
    } as never,
  })
  expect(await group.find({ text: ' · 1 failed' })).toBeDefined()
})

test('notifies when a long turn ends', async ($, on) => {
  const sent: string[] = []
  on('clock.now', () => ({ value: 1_000 }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.notify', (_, e) => {
    sent.push((e as { text: string }).text)
    return { value: { isSent: true, channel: 'terminal' } } as never
  })

  await $.turn.complete({ answer: 'ok', durationMs: 5_000, isAborted: false, turnId: 'a', reason: 'answer' })
  await $.turn.complete({ answer: 'ok', durationMs: 45_000, isAborted: false, turnId: 'b', reason: 'answer' })
  expect(sent).toEqual(['Done'])
})

test('scrolls under a fixed header and starts at the newest row', async ($, on) => {
  on('ui.render', () => ENGINE)
  on('clock.now', () => ({ value: 1_000 }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)

  for (let i = 0; i < 30; i++) {
    await $.tool.call({ tool: 'Bash', command: `echo ${i}`, description: `Step ${i}`, tool_use_id: `s${i}` } as never)
  }

  const pane = await $.ui.mount({
    plugin: 'tool-log',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'tool-log',
    props: { title: 'Panel', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { bodyRows: 20 } } as never,
  })
  expect(await pane.find({ text: /Log/ })).toBeDefined()
  expect(await pane.find({ text: /↑ \d+–31 of 31/ })).toBeDefined()

  await pane.press({ key: 'hint-g' })
  expect(await pane.find({ text: /^1–\d+ of 31 ↓$/ })).toBeDefined()
})
