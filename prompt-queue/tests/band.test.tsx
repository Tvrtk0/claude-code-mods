import { expect, test } from 'claude-code/testing'

const BAND = { plugin: 'prompt-queue', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false } } as const

test('the band shows the queue button beside what is beneath', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect((await ui.find({ type: 'Text', text: /queue/ }))?.text).toBe('queue')
  await ui.unmount()
})

test('a queued prompt shows as next beside the button', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('command.register', () => ({ value: { command: 'next' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', () => ({ turnId: 't' }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('env.get', () => ({ value: null }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({})
  await $.command.run({ command: 'next', args: 'write the tests' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /next:/ }))?.text).toBe('next: write the tests')
  await ui.unmount()
})
