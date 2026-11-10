import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { bashVerdict, verdict } from '../hooks/policy'

const ENGINE: RenderElement = { type: 'Box', props: {}, children: [] }
const BAND = { plugin: 'ask-mode', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3 } } as never

test('lets read-only Bash through and refuses the rest', async () => {
  for (const ok of [
    'ls -la ~/dev',
    'git log --oneline -5 && git status',
    'rg "foo|bar" src | head -20',
    'cat a.txt 2>/dev/null || echo none',
    'cd ~/dev/app && git diff main...HEAD --stat',
    'find . -name "*.ts" | xargs grep -n TODO',
    'gh pr view 12 --comments',
    'gh api repos/o/r/pulls',
    'git branch -a',
    'rtk proxy git show HEAD',
    'npm ls react',
    'node --version',
    'grep -rn "a && b" src 2>&1',
  ]) {
    expect([ok, bashVerdict(ok)]).toEqual([ok, undefined])
  }

  for (const bad of [
    'rm -rf build',
    'git commit -m x',
    'git push',
    'git checkout -b feat',
    'git branch new-thing',
    'echo hi > notes.md',
    'ls && rm x',
    'sed -i "" s/a/b/ f.txt',
    'find . -name "*.tmp" -delete',
    'npm install',
    'gh pr create --fill',
    'gh pr merge 12',
    'gh api -X POST repos/o/r/issues',
    'echo $(rm x)',
    'curl -X POST https://example.com',
    'python3 script.py',
  ]) {
    expect([bad, typeof bashVerdict(bad)]).toEqual([bad, 'string'])
  }
})

test('sorts tools and MCP tools by what they do', async () => {
  expect(verdict('Read', {})).toBeUndefined()
  expect(verdict('Agent', {})).toBeUndefined()
  expect(typeof verdict('Edit', {})).toBe('string')
  expect(typeof verdict('Write', {})).toBe('string')
  expect(typeof verdict('NotebookEdit', {})).toBe('string')
  expect(typeof verdict('Artifact', {})).toBe('string')
  expect(verdict('Artifact', { action: 'read' })).toBeUndefined()
  expect(verdict('mcp__claude_ai_Slack__slack_read_channel', {})).toBeUndefined()
  expect(verdict('mcp__claude_ai_Gmail__search_threads', {})).toBeUndefined()
  expect(typeof verdict('mcp__claude_ai_Slack__slack_send_message', {})).toBe('string')
  expect(typeof verdict('mcp__claude_ai_Gmail__create_draft', {})).toBe('string')
  expect(typeof verdict('mcp__x__frobnicate', {})).toBe('string')
})

test('refuses a write only while the mode is on', async ($, on) => {
  on('ui.render', () => ENGINE)
  on('tool.call', () => ({ result: 'ok' }) as never)

  const off = await $.tool.call({ tool: 'Write', file_path: '/x/a.md', content: 'a', tool_use_id: 'w0' } as never)
  expect(off.deny).toBeUndefined()

  const band = await $.ui.mount(BAND)
  await band.press({ key: 'level-quick' })
  expect(await band.find({ text: '🔒 ' })).toBeDefined()

  const on1 = await $.tool.call({ tool: 'Write', file_path: '/x/a.md', content: 'a', tool_use_id: 'w1' } as never)
  expect(on1.deny).toMatch(/Ask mode is on/)
  const read = await $.tool.call({ tool: 'Bash', command: 'git status', tool_use_id: 'b1' } as never)
  expect(read.deny).toBeUndefined()
  const sub = await $.tool.call({ tool: 'Edit', file_path: '/x/a.md', old_string: 'a', new_string: 'b', tool_use_id: 'e1', agentId: 'ag1' } as never)
  expect(sub.deny).toMatch(/Ask mode is on/)

  await band.press({ key: 'level-quick' })
  expect(await band.find({ text: '🔒 ' })).toBeUndefined()
  const after = await $.tool.call({ tool: 'Write', file_path: '/x/a.md', content: 'a', tool_use_id: 'w2' } as never)
  expect(after.deny).toBeUndefined()
})

test('commands toggle their level and /ask off leaves any', async ($, on) => {
  on('ui.render', () => ENGINE)

  const band = await $.ui.mount(BAND)
  await $.command.run({ command: 'deep', args: '' } as never)
  expect(await band.find({ text: '🔒 ' })).toBeDefined()
  await $.command.run({ command: 'ask', args: 'off' } as never)
  expect(await band.find({ text: '🔒 ' })).toBeUndefined()
  await $.command.run({ command: 'ask', args: '' } as never)
  expect(await band.find({ text: '🔒 ' })).toBeDefined()
  await $.command.run({ command: 'ask', args: '' } as never)
  expect(await band.find({ text: '🔒 ' })).toBeUndefined()
})

test('briefs each prompt and runs quick on Haiku at low effort', async ($, on) => {
  on('ui.render', () => ENGINE)
  let seen: { context?: readonly string[] } = {}
  on('prompt.submit', (_, e) => {
    seen = e
    return { text: e.text } as never
  })
  let step: { model?: string; effort?: unknown } = {}
  on('turn.step', async function* (_, e) {
    step = e
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })

  await $.command.run({ command: 'quick', args: '' } as never)
  await $.prompt.submit({ text: 'what does this do?', origin: { kind: 'composer' }, wait: false } as never)
  expect(seen.context?.at(-1)).toMatch(/Ask mode, quick/)

  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5[1m]', effort: 'high', messageCount: 1 } as never)) {
  }
  expect(step.model).toBe('claude-haiku-5-5[1m]')
  expect(step.effort).toBe('low')
})


test('plan-steps next options show above the switch, the switch keeps its row', async ($, on) => {
  on('ui.render', () => ENGINE as never)
  on('env.get', (_, e) => ({ value: (e as { name?: string }).name === 'HOME' ? '/h' : 't9' }))
  on('fs.read', () => ({ value: JSON.stringify({ wrap: { next: ['Commit and push', 'Test it'] }, wrapAt: 5 }) }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /next:/ }))?.text).toBe('next:')
  expect((await ui.find({ type: 'Text', text: /Commit and push/ }))?.text).toBe('Commit and push')
  expect((await ui.find({ type: 'Text', text: /deep/ }))?.text).toBeTruthy()
  await ui.unmount()
})
