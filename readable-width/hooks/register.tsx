import { atom, read, update } from 'claude-code'
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
// A pasted image's chip in a prompt.
const CHIP = '#9a9a9a'
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

// The pictures pasted into this session: the engine keeps each as
// `<tmp>/claude-<uid>/<project>/<session>/images/<n>.png`, which no API
// names, so the folder is looked for once; none found, prompts show no chips.
let cwd: string | undefined
const pasted = atom({ plugin: 'readable-width', key: 'pasted' } as const, {})
// The pictures opened in their bubbles, by path.
const openImages = atom({ plugin: 'readable-width', key: 'openImages' } as const, [])
// Each picture's size in cells and its half-block cells, made once.
const prepared = atom({ plugin: 'readable-width', key: 'prepared' } as const, {})
let imageDir: string | null | undefined
// Whether Claude Code is told to draw pictures in this terminal.
let realPictures = false

// The preview's width in columns; its height keeps the picture's shape, a
// cell being about twice as tall as wide.
const PREVIEW_COLUMNS = 64

async function findImageDir($: EngineInterface) {
  if (imageDir !== undefined) return imageDir
  // A lookup cut short (a drawing it ran in moved on) leaves it unknown, so
  // the next one tries again; only a finished one that found nothing is null.
  const session = await $.session.id()
  const uid = (await $.process.run(['id', '-u'], { timeoutMs: 2000 })).stdout.trim()
  const project = (cwd ?? '').replace(/[^A-Za-z0-9]/g, '-')
  for (const tmp of ['/private/tmp', '/tmp']) {
    const dir = `${tmp}/claude-${uid}/${project}/${session}/images`
    if (await $.fs.exists(dir)) {
      imageDir = dir
      return dir
    }
  }
  imageDir = null
  return null
}

type Pasted = { n: string; path: string; columns: number; rows: number; cells?: string }
type PreparedImage = { columns: number; rows: number; cells?: string }

// Standard padded base64, both ways; written out, as the library this
// module is typed against has neither.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

function fromBase64(text: string) {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let at = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i] ?? 'A') << 18) | (B64.indexOf(clean[i + 1] ?? 'A') << 12) |
      ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]!) : 0) << 6) | (i + 3 < clean.length ? B64.indexOf(clean[i + 3]!) : 0)
    if (at < bytes.length) bytes[at++] = (n >> 16) & 255
    if (at < bytes.length) bytes[at++] = (n >> 8) & 255
    if (at < bytes.length) bytes[at++] = n & 255
  }
  return bytes
}

// A picture as Raster cells: macOS's sips scales it to two pixels a cell,
// as an uncompressed BMP the module can read; each cell is a `▀` whose
// foreground is the upper pixel and background the lower. The terminal's
// own pictures are not drawn here, so this is what the preview shows.


async function previewCells($: EngineInterface, path: string, columns: number, rows: number) {
  try {
    const out = `${path.replace(/\.png$/, '')}.preview-${columns}x${rows}.bmp`
    const made = await $.process.run(
      ['sips', '-s', 'format', 'bmp', '-z', String(rows * 2), String(columns), path, '--out', out],
      { timeoutMs: 10_000 },
    )
    if (made.exitCode !== 0) {
      return undefined
    }
    // Read through `base64`: the module's own file reads reach only some
    // folders, and the session's temp folder is not among them.
    const read = await $.process.run(['base64', '-i', out], { timeoutMs: 5_000 })
    if (read.exitCode !== 0) {
      return undefined
    }
    const bytes = fromBase64(read.stdout)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const start = view.getUint32(10, true)
    const width = view.getInt32(18, true)
    const height = view.getInt32(22, true)
    const depth = view.getUint16(28, true) / 8
    const stride = Math.ceil((width * depth) / 4) * 4
    const pixel = (x: number, y: number) => {
      const row = height > 0 ? Math.abs(height) - 1 - y : y
      const at = start + row * stride + x * depth
      return ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at] ?? 0)
    }
    const words = new Uint32Array(columns * rows * 3)
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const i = (y * columns + x) * 3
        words[i] = 0x2580
        words[i + 1] = pixel(Math.min(x, width - 1), Math.min(y * 2, Math.abs(height) - 1))
        words[i + 2] = pixel(Math.min(x, width - 1), Math.min(y * 2 + 1, Math.abs(height) - 1))
      }
    }
    const cells = toBase64(new Uint8Array(words.buffer))
    return cells
  } catch (error) {
    return undefined
  }
}

// The pictures a prompt's row shows: what is drawn reads only what was
// prepared before, as calls made while drawing are cut short when the
// drawing moves on. Each image keeps a chip; its picture is made when the
// prompt is sent, or when the chip is pressed.
async function pastedImages($: EngineInterface, text: string): Promise<Pasted[]> {
  // The row may not carry `[Image #n]`: its images are the ones remembered
  // when it was sent, and any it names itself.
  const named = [...text.matchAll(/\[Image #(\d+)\]/g)].map(m => m[1] ?? '')
  const numbers = [...new Set([...((await read($, pasted))[text] ?? []), ...named])]
  if (numbers.length === 0 || imageDir === undefined || imageDir === null) return []

  const made = await read($, prepared)
  return numbers.map(n => {
    const path = `${imageDir}/${n}.png`
    return { n, path, columns: PREVIEW_COLUMNS, rows: 12, ...(made[path] ?? {}) }
  })
}

// Measures a picture and, unless the terminal draws pictures itself, makes
// its half-block cells; kept for every later drawing.
async function prepare($: EngineInterface, path: string) {
  if ((await read($, prepared))[path] !== undefined) return
  const info = await $.process.run(['file', '-b', path], { timeoutMs: 5_000 })
  const m = /(\d+) x (\d+)/.exec(info.stdout)
  if (!m) return
  const rows = Math.max(4, Math.min(24, Math.round((PREVIEW_COLUMNS * Number(m[2])) / Number(m[1]) / 2)))
  const cells = realPictures ? undefined : await previewCells($, path, PREVIEW_COLUMNS, rows)
  const entry: PreparedImage = { columns: PREVIEW_COLUMNS, rows, ...(cells !== undefined ? { cells } : {}) }
  await update($, prepared, all => ({ ...Object.fromEntries(Object.entries(all ?? {}).slice(-49)), [path]: entry }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = started.cwd
    try {
      realPictures = (await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) === '1'
    } catch {}
    try {
      await findImageDir($)
    } catch {}

    return started
  })

  // A prompt sent with images: they are the newest in the session's image
  // folder, one per attachment; remembered by the prompt's text for its row.
  on('prompt.submit', async ($, e, next) => {
    let numbers: string[] = []
    try {
      const count = (e.attachments ?? []).filter(a => a.type === 'image').length
      const dir = count > 0 && e.origin.kind === 'composer' ? await findImageDir($) : null
      if (dir !== null) {
        numbers = (await $.fs.list(dir))
          .map(entry => /^(\d+)\.png$/.exec(entry.name)?.[1])
          .filter((n): n is string => n !== undefined)
          .sort((a, b) => Number(a) - Number(b))
          .slice(-count)
        const text = e.text
        await update($, pasted, all => ({ ...Object.fromEntries(Object.entries(all ?? {}).slice(-99)), [text]: numbers }))
      }
    } catch {}

    const entered = await next(e)

    // The pictures are made once the prompt has entered, so sending it waits
    // on none of this.
    for (const n of numbers) {
      try {
        await prepare($, `${imageDir}/${n}.png`)
      } catch {}
    }

    return entered
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    const columns = e.viewport?.columns
    const margin = marginFor(columns)

    if (e.surface !== 'terminal' || margin === null || columns === undefined) {
      return next(e)
    }

    const { Box, Markdown } = $.ui.resolve(e)
    // The reply, unframed: prose wraps at WIDTH, and a wide block (code, a
    // table) keeps the whole column.
    const parts = segment(e.props.text)
    const room = columns - margin

    return (
      <Box marginLeft={margin} marginTop={1} width={room} flexDirection="column" gap={1}>
        {parts.map(part => (
          <Box width={part.isWide ? room : Math.min(WIDTH, room)}>
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

    const { Box, Button, Image, Raster, Text } = $.ui.resolve(e)
    const open = new Set(await read($, openImages))
    // A bubble: a rounded frame in the accent color, as wide as the prompt's
    // longest line and at most WIDTH, the frame and its padding included.
    const longest = Math.max(...e.props.text.split('\n').map(line => line.length))
    const images = await pastedImages($, e.props.text)
    // The chips' row counts too, so a prompt that is only an image does not
    // wrap its chip.
    const chips = images.reduce((n, image) => n + `▣ Image #${image.n} ▸`.length + 2, 0)
    // An open picture widens the bubble to hold it.
    const picture = images.some(image => open.has(image.path)) ? PREVIEW_COLUMNS : 0
    const width = Math.min(WIDTH, columns - margin, Math.max(longest, chips, picture) + GUTTER + BUBBLE)

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
        <Box width={width - GUTTER - BUBBLE} flexDirection="column">
          <Text bold color="claude">
            {e.props.text}
          </Text>
          {/* A chip per pasted image; a click opens the picture in the
              bubble, under the chips, and a second closes it. Shown in the
              flow: the rows after a prompt paint over anything floating. */}
          {images.length > 0 && (
            <Box>
              {images.map(image => (
                <Box key={`image-${image.n}`} marginRight={2} flexShrink={0}>
                  <Button
                    key={`image-chip-${image.n}`}
                    plain
                    hover={{ color: 'white' }}
                    onPress={async () => {
                      try {
                        await prepare($, image.path)
                      } catch {}
                      await update($, openImages, list =>
                        (list ?? []).includes(image.path)
                          ? (list ?? []).filter(p => p !== image.path)
                          : [...(list ?? []), image.path].slice(-50),
                      )
                    }}
                  >
                    <Text color={CHIP}>
                      ▣ Image #{image.n} {open.has(image.path) ? '▾' : '▸'}
                    </Text>
                  </Button>
                </Box>
              ))}
            </Box>
          )}
          {images
            .filter(image => open.has(image.path))
            .map(image => (
              <Box key={`preview-${image.n}`} marginTop={1}>
                {image.cells !== undefined ? (
                  <Raster key={`raster-${image.n}`} columns={image.columns} rows={image.rows} cells={image.cells} />
                ) : (
                  <Image source={{ file: image.path, format: 'png' }} columns={image.columns} rows={image.rows} alt={`Image #${image.n}`} />
                )}
              </Box>
            ))}
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
