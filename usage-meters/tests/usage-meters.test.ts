import { expect, test } from 'claude-code/testing'

const USAGE = {
  startedAt: 0,
  context: { tokens: 84_000, window: 200_000, percent: 42 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 31, resetsAt: '2026-10-13T14:10:00Z' },
    { kind: 'seven_day', percentUsed: 64 },
  ],
  cost: { usd: 0.84 },
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band shows context, 5h and 7d meters on ${surface}`, async ($, on) => {
    on('session.usage', () => ({ value: USAGE }))
    on('clock.now', () => ({ value: Date.parse('2026-10-13T12:00:00Z') }) as never)
    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
    on('turn.complete', (_, e) => ({ text: e.answer }))

    await $.turn.complete({
      answer: 'ok',
      durationMs: 1000,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
    })

    const ui = await $.ui.mount({
      plugin: 'usage-meters',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3 } as never,
    })

    expect(await ui.find({ text: ' 42%' })).toBeDefined()
    expect(await ui.find({ text: ' 31%' })).toBeDefined()
    expect(await ui.find({ text: ' 64%' })).toBeDefined()
    expect(await ui.find({ text: '7d ' })).toBeDefined()
    expect(await ui.find({ text: ' 2h 10m' })).toBeDefined()
    expect(await ui.find({ text: /\$/ })).toBeUndefined()
    expect(await ui.find({ text: /84k/ })).toBeUndefined()
  })
}

test('band stays hidden before any usage is known', async ($, on) => {
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))

  const ui = await $.ui.mount({
    plugin: 'usage-meters',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3 } as never,
  })

  expect(await ui.find({ text: '%' })).toBeUndefined()
})
