import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const snapshot = atom({ plugin: 'usage-meters', key: 'snapshot' } as const, null)

const BAR = 10

// The meters' frame and its dividers, and the frame around the band.
const OUTER = '#4a4a4a'
const CARD_BORDER = '#5a5a5a'
const CARD_LABEL = '#9a9a9a'
// The bar's bare track, and the glyphs for one to seven eighths of a cell.
const TRACK = '#333333'
const PARTS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
// A meter's tooltip: a dark card that covers the buttons above it.
const TIP_BG = '#1e1e1e'
const TIP_BORDER = '#7a7a7a'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

// `46k`, `1M`: a token count at a glance.
const tokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n)

// The bars run teal to green to yellow to orange to red along their
// length: each cell takes the color of where it sits, so a fuller bar
// reaches warmer colors, and the percentage takes the color at its end.
const STOPS: [number, number, number][] = [
  [0x4f, 0xd1, 0xc5],
  [0x98, 0xc3, 0x79],
  [0xe5, 0xc0, 0x7b],
  [0xd1, 0x9a, 0x66],
  [0xe0, 0x6c, 0x75],
]

function gradient(at: number) {
  const x = Math.min(1, Math.max(0, at)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(x))
  const from = STOPS[i] ?? STOPS[0]!
  const to = STOPS[i + 1] ?? from
  const mix = (k: 0 | 1 | 2) => Math.round(from[k] + (to[k] - from[k]) * (x - i))
  const hex = (n: number) => n.toString(16).padStart(2, '0')

  return `#${hex(mix(0))}${hex(mix(1))}${hex(mix(2))}`
}

async function refresh($: EngineInterface) {
  const usage = await $.session.usage()
  const limit = (kind: string) =>
    usage.rateLimits.find(r => r.kind === kind)?.percentUsed
  const resetsAt = (kind: string) => {
    const at = usage.rateLimits.find(r => r.kind === kind)?.resetsAt
    return at === undefined ? undefined : Date.parse(at)
  }

  await update($, snapshot, () => ({
    context: usage.context.percent,
    contextTokens: usage.context.tokens,
    contextWindow: usage.context.window,
    costUsd: usage.cost?.usd,
    fiveHour: limit('five_hour'),
    fiveHourResetsAt: resetsAt('five_hour'),
    sevenDay: limit('seven_day'),
    sevenDayResetsAt: resetsAt('seven_day'),
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
    const now = await $.clock.now()
    // Time until a window resets, as of this drawing: `2h 16m`, or `3d 4h`
    // once it is a day or more away.
    const resetIn = (at: number | undefined) => {
      const left = at === undefined ? 0 : at - now
      if (left <= 0) return ''
      const hours = Math.floor(left / 3_600_000)

      return hours >= 24
        ? `${Math.floor(hours / 24)}d ${hours % 24}h`
        : `${hours}h ${Math.floor((left % 3_600_000) / 60_000)}m`
    }

    // One labelled meter: the label, a bar of BAR cells and its percentage,
    // both colored by how full it is; a divider before all but the first.
    // When a window resets, as a clock time: `18:00`, `tomorrow 09:00` or
    // `Fri 16:00`.
    const resetAt = (at: number | undefined) => {
      if (at === undefined) return ''
      const d = new Date(at)
      const today = new Date(now)
      const days = Math.round(
        (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
          new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
          86_400_000,
      )
      const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`

      return days <= 0 ? `today ${time}` : days === 1 ? `tomorrow ${time}` : `${DAYS[d.getDay()]} ${time}`
    }

    const meter = (label: string, percent: number | undefined, isFirst = false, note = '', tip = '') => {
      if (percent === undefined) return null

      // In eighths of a cell, so a small share still shows: full cells, one
      // partial cell, then the bare track.
      const eighths = Math.min(BAR * 8, Math.round((percent / 100) * BAR * 8))
      const full = Math.floor(eighths / 8)
      const part = eighths % 8

      return (
        <Box key={`meter-${label}`} flexShrink={0}>
          {!isFirst && <Text color={CARD_BORDER}>{'  │  '}</Text>}
          <Text color={CARD_LABEL}>{label} </Text>
          {Array.from({ length: BAR }, (_, i) => {
            const glyph = i < full ? '█' : i === full && part > 0 ? (PARTS[part] ?? ' ') : ' '

            return (
              <Text key={`${label}-cell-${i}`} color={gradient((i + 0.5) / BAR)} backgroundColor={TRACK}>
                {glyph}
              </Text>
            )
          })}
          <Text bold color={gradient(percent / 100)}> {Math.round(percent)}%</Text>
          {note !== '' && <Text color={CARD_LABEL}> · {note}</Text>}
          {/* Shown while the pointer is on the meter, over the buttons above:
              the band clips anything past its own rows. */}
          {tip !== '' && (
            <Box
              position="absolute"
              top={-4}
              left={isFirst ? -2 : 3}
              display="none"
              hover={{ display: 'flex' }}
              flexShrink={0}
              borderStyle="round"
              borderColor={TIP_BORDER}
              backgroundColor={TIP_BG}
              paddingX={1}
            >
              <Text backgroundColor={TIP_BG}>{tip}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const contextTip = [
      s.contextTokens !== undefined && s.contextWindow !== undefined
        ? `Context ${tokens(s.contextTokens)} / ${tokens(s.contextWindow)} tokens`
        : 'Context',
      s.costUsd !== undefined ? `$${s.costUsd.toFixed(2)} this session` : '',
    ]
      .filter(x => x !== '')
      .join(' · ')
    const limitTip = (name: string, at: number | undefined) =>
      at === undefined ? name : `${name} · resets ${resetAt(at)}`

    // Other mods' band content (the panel and ask buttons) is drawn above
    // the meters, frame on frame.
    const below = await next(e)

    // One frame around the whole band, a blank line above it, sets it off
    // from the chat scrolling above: it stays put, the chat moves. No width
    // of its own: the engine refuses its node under a sized Box.
    return (
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={OUTER} paddingX={1}>
        {below}
        {/* All three in one rounded frame, as wide as they are. */}
        <Box alignSelf="flex-start" borderStyle="round" borderColor={CARD_BORDER} paddingX={1}>
          {meter('ctx', s.context ?? 0, true, '', contextTip)}
          {meter('5h', s.fiveHour, false, resetIn(s.fiveHourResetsAt), limitTip('5-hour limit', s.fiveHourResetsAt))}
          {meter('7d', s.sevenDay, false, resetIn(s.sevenDayResetsAt), limitTip('Weekly limit', s.sevenDayResetsAt))}
        </Box>
      </Box>
    )
  })
}
