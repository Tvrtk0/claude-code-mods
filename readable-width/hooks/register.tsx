import type {
  EngineInterface,
  Register,
  RenderElement,
  RenderInput,
} from 'claude-code'

const WIDTH = 80
const GUTTER = 2
// A prompt bubble's frame and padding: a cell each side for both.
const BUBBLE = 4
// A reply card's frame: the band's grey.
const CARD = '#5a5a5a'
const PADDING = 0

type Segment = { text: string; isWide: boolean }

// A fixed left padding rather than centering: replies stream in at the left
// edge, so with none the finished block does not move at all. Null when the
// terminal is too narrow to spare it.
const marginFor = (columns: number | undefined) =>
  columns === undefined || columns < 40 ? null : PADDING

// Splits markdown into prose and wide blocks (code fences and tables), so
// prose wraps at WIDTH while wide blocks keep the room to the right edge.
function segment(markdown: string): Segment[] {
  const segments: Segment[] = []
  let lines: string[] = []
  let isWide = false
  let fence: string | null = null

  const flush = () => {
    const text = lines.join('\n').trim()
    if (text !== '') segments.push({ text, isWide })
    lines = []
  }

  for (const line of markdown.split('\n')) {
    const trimmed = line.trimStart()

    if (fence !== null) {
      lines.push(line)
      if (trimmed.startsWith(fence)) {
        flush()
        fence = null
        isWide = false
      }
      continue
    }

    // Only code keeps the full width: a fence that names a language other
    // than plain text. An unlabelled or text fence wraps like prose.
    const opens = /^(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(trimmed)
    if (opens) {
      flush()
      fence = opens[1] ?? '```'
      const lang = (opens[2] ?? '').toLowerCase()
      isWide = lang !== '' && !['text', 'txt', 'plain', 'plaintext', 'markdown', 'md'].includes(lang)
      lines.push(line)
      continue
    }

    const isTableRow = trimmed.startsWith('|')
    if (isTableRow !== isWide) {
      flush()
      isWide = isTableRow
    }
    lines.push(line)
  }

  flush()

  return segments
}

// Moves a row the engine drew to the column's left edge, so the whole
// transcript reads as one column instead of jumping between edge and center.
function shift(
  $: EngineInterface,
  e: RenderInput,
  drawn: RenderElement,
): RenderElement {
  const columns = e.viewport?.columns
  const margin = marginFor(columns)

  if (e.surface !== 'terminal' || margin === null || columns === undefined) {
    return drawn
  }

  const { Box } = $.ui.resolve(e)

  // The engine refuses its own row under a Box that sets a width, so the
  // margin alone shifts it.
  return <Box marginLeft={margin}>{drawn}</Box>
}

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    const columns = e.viewport?.columns
    const margin = marginFor(columns)

    if (e.surface !== 'terminal' || margin === null || columns === undefined) {
      return next(e)
    }

    const { Box, Markdown } = $.ui.resolve(e)
    // A card: a grey rounded frame around each piece of the reply. It is as
    // wide as its widest block: the whole column when a wide block (code, a
    // table) is in it, else the longest line, at most WIDTH, frame included.
    const parts = segment(e.props.text)
    const room = columns - margin
    const longest = Math.max(0, ...e.props.text.split('\n').map(line => line.length))
    const width = parts.some(part => part.isWide) ? room : Math.min(WIDTH, room, longest + BUBBLE)
    const inner = width - BUBBLE

    return (
      <Box
        marginLeft={margin}
        marginTop={1}
        width={width}
        flexDirection="column"
        gap={1}
        borderStyle="round"
        borderColor={CARD}
        paddingX={1}
      >
        {parts.map(part => (
          <Box width={part.isWide ? inner : Math.min(WIDTH - BUBBLE, inner)}>
            <Markdown text={part.text} />
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const columns = e.viewport?.columns
    const margin = marginFor(columns)

    if (
      e.surface !== 'terminal' ||
      margin === null ||
      columns === undefined
    ) {
      return next(e)
    }

    // Rows that are not a typed prompt (attachments, notifications) keep the
    // engine's drawing and only move to the same left edge.
    if (e.props.origin.kind !== 'composer') {
      return shift($, e, await next(e))
    }

    const { Box, Text } = $.ui.resolve(e)
    // A bubble: a rounded frame in the accent color, as wide as the prompt's
    // longest line and at most WIDTH, the frame and its padding included.
    const longest = Math.max(...e.props.text.split('\n').map(line => line.length))
    const width = Math.min(WIDTH, columns - margin, longest + GUTTER + BUBBLE)

    return (
      <Box
        marginLeft={margin}
        marginTop={1}
        width={width}
        borderStyle="round"
        borderColor="claude"
        paddingX={1}
      >
        <Box width={GUTTER} flexShrink={0}>
          <Text bold color="claude">
            ❯
          </Text>
        </Box>
        <Box width={width - GUTTER - BUBBLE}>
          <Text bold color="claude">
            {e.props.text}
          </Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) =>
    shift($, e, await next(e)),
  )

  // An expanded group unfolds into ToolUse rows, which shift themselves.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) =>
    e.props.isExpanded ? next(e) : shift($, e, await next(e)),
  )

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) =>
    shift($, e, await next(e)),
  )

  on('ui.render', { component: 'Spinner' }, async ($, e, next) =>
    shift($, e, await next(e)),
  )

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) =>
    shift($, e, await next(e)),
  )
}
