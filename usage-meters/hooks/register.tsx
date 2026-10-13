import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const snapshot = atom({ plugin: 'usage-meters', key: 'snapshot' } as const, null)

const BAR = 10

const heat = (percent: number) =>
  percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success'

async function refresh($: EngineInterface) {
  const usage = await $.session.usage()
  const limit = (kind: string) =>
    usage.rateLimits.find(r => r.kind === kind)?.percentUsed

  await update($, snapshot, () => ({
    context: usage.context.percent,
    fiveHour: limit('five_hour'),
    sevenDay: limit('seven_day'),
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)

    if (e.props.hasSurvey || s === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    // One labelled meter: a bar of BAR cells and its percentage, both colored
    // by how full it is.
    const meter = (label: string, percent: number | undefined, isFirst = false) => {
      if (percent === undefined) return null

      const filled = Math.min(BAR, Math.round((percent / 100) * BAR))

      return (
        <Text>
          {!isFirst && <Text dimColor>  ·  </Text>}
          <Text dimColor>{label} </Text>
          <Text color={heat(percent)}>{'▰'.repeat(filled)}</Text>
          <Text dimColor>{'▱'.repeat(BAR - filled)}</Text>
          <Text bold color={heat(percent)}> {Math.round(percent)}%</Text>
        </Text>
      )
    }

    // Other mods' band content (the log toggle) is drawn beside this line.
    const below = await next(e)

    // A blank line above keeps the band off whatever the transcript ends with.
    return (
      <Box marginTop={1}>
        <Box>
          {meter('ctx', s.context ?? 0, true)}
          {meter('5h', s.fiveHour)}
          {meter('7d', s.sevenDay)}
        </Box>
        <Text>   </Text>
        {below}
      </Box>
    )
  })
}
