import { expect, test } from 'claude-code/testing'

test('/slim answers at once and asks for a compaction', async ($, on) => {
  let asked = ''
  on('command.register', () => ({ value: { command: 'slim' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.compact', (_, e) => { asked = String(e.instructions); return { skip: 'test' } })
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'slim', args: '' })
  expect(JSON.stringify(r)).toContain('Slimming')
  await new Promise(res => setTimeout(res, 50))
  expect(asked).toBe('__image_slim__')
})
