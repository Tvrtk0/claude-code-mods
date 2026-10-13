import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TurnRecord } from '../types'

const turns = atom({ plugin: 'turn-details', key: 'turns' } as const, {})
const expanded = atom({ plugin: 'turn-details', key: 'expanded' } as const, [])

const pad = (n: number) => String(n).padStart(2, '0')

const clockTime = (ms: number) => {
  const d = new Date(ms)

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const duration = (ms: number) => {
  const s = Math.round(ms / 1000)

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// TurnDuration carries no turn id, only the duration it formats, which is the
// one turn.complete reported: that is the key a row finds its turn by.
const keyOf = (durationMs: number) => String(durationMs)

export const register: Register = on => {
  let tools: Record<string, number> = {}

  on('turn.start', ($, e, next) => {
    tools = {}

    return next(e)
  })

  on('tool.call', ($, e, next) => {
    tools = { ...tools, [e.tool]: (tools[e.tool] ?? 0) + 1 }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const turn: TurnRecord = {
      durationMs: e.durationMs,
      endedAt: await $.clock.now(),
      model: e.usage?.model,
      tools,
    }
    await update($, turns, all => {
      const kept = Object.entries(all ?? {}).slice(-199)

      return { ...Object.fromEntries(kept), [keyOf(e.durationMs)]: turn }
    })

    return done
  })

  // The duration line becomes one pressable '📋 details' that folds the
  // turn's details open right beneath it, in the chat.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const key = keyOf(e.props.durationMs)
    const turn = (await read($, turns))[key]

    if (turn === undefined) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isOpen = (await read($, expanded)).includes(key)

    const used = Object.entries(turn.tools).sort((a, b) => b[1] - a[1])
    const total = used.reduce((sum, [, n]) => sum + n, 0)
    const row = (label: string, value: string) => (
      <Box>
        <Box width={14} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text>{value}</Text>
      </Box>
    )

    return (
      <Box marginY={1} flexDirection="column">
        <Button
          key="details"
          plain
          dimColor
          onPress={() =>
            update($, expanded, keys =>
              (keys ?? []).includes(key)
                ? (keys ?? []).filter(k => k !== key)
                : [...(keys ?? []), key].slice(-100),
            )
          }
        >
          📋 details {isOpen ? '▾' : '▸'}
        </Button>
        {isOpen && (
          <Box flexDirection="column" marginLeft={2}>
            {row('duration', duration(turn.durationMs))}
            {row('finished', clockTime(turn.endedAt))}
            {row(
              'tool calls',
              total === 0
                ? 'none'
                : `${total} (${used.map(([tool, n]) => `${tool} ${n}`).join(', ')})`,
            )}
            {turn.model !== undefined && row('model', turn.model)}
          </Box>
        )}
      </Box>
    )
  })
}
