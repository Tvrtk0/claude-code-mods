import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, Timer } from 'claude-code'

import type { LogEntry, LogGroup } from '../types'

const PANE = 'tool-log'
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 120

// The log's own background, a dark plum in place of the engine's grey.
const PANE_BG = '#2a2133'

const groups = atom({ plugin: 'tool-log', key: 'groups' } as const, [])
const MAX_GROUPS = 50
const expanded = atom({ plugin: 'tool-log', key: 'expanded' } as const, [])
const isRepo = atom({ plugin: 'tool-log', key: 'isRepo' } as const, false)

// The most patch text kept per call; whole hunks only, so the diff still parses.
const PATCH_LIMIT = 20_000
const tick = atom({ plugin: 'tool-log', key: 'tick' } as const, {
  frame: 0,
  elapsedMs: 0,
})

const pad = (n: number) => String(n).padStart(2, '0')

const clockTime = (ms: number) => {
  const d = new Date(ms)

  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const elapsed = (ms: number) => {
  const s = Math.floor(ms / 1000)

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${pad(s % 60)}s`
}

const countLabel = (n: number) => `${n} ${n === 1 ? 'tool' : 'tools'}`

const basename = (path: string) => path.split('/').pop() ?? path

const home = (text: string) => text.replace(/\/Users\/[^/\s]+/g, '~')

const firstLine = (text: string) => text.split('\n')[0] ?? ''

const quoted = (text: string) => `"${text}"`

const hostOf = (url: string) => url.replace(/^\w+:\/\//, '').split('/')[0] ?? url

// What a call did, in words: a Bash call's own description, else the file,
// pattern or task it worked on. The raw command rides along for failures,
// and `activity` is the verb-and-object line the spinner shows while it runs.
function describe(
  tool: string,
  input: unknown,
): { label: string; command?: string; activity: string } {
  const fields = (input ?? {}) as Record<string, unknown>
  const pick = (key: string) =>
    typeof fields[key] === 'string' ? (fields[key] as string) : undefined

  const command = pick('command')
  if (command !== undefined) {
    const description = pick('description')
    const first = home(firstLine(command))

    return {
      label: description ?? first,
      command: home(command),
      activity: description ?? `Running ${first.split(' ')[0] ?? first}`,
    }
  }

  const path = pick('file_path') ?? pick('notebook_path') ?? pick('path')
  const pattern = pick('pattern')
  const url = pick('url')
  const task = pick('description') ?? pick('prompt')

  const activity =
    tool === 'Read' && path !== undefined
      ? `Reading ${basename(path)}`
      : (tool === 'Edit' || tool === 'NotebookEdit') && path !== undefined
        ? `Editing ${basename(path)}`
        : tool === 'Write' && path !== undefined
          ? `Writing ${basename(path)}`
          : tool === 'Grep' && pattern !== undefined
            ? `Searching ${quoted(pattern)}`
            : tool === 'Glob' && pattern !== undefined
              ? `Finding ${pattern}`
              : tool === 'WebFetch' && url !== undefined
                ? `Fetching ${hostOf(url)}`
                : tool === 'WebSearch'
                  ? 'Searching the web'
                  : (tool === 'Agent' || tool === 'Task') && task !== undefined
                    ? `Delegating ${firstLine(task)}`
                    : `Running ${tool}`

  if (path !== undefined) return { label: basename(path), activity }

  return {
    label: home(firstLine(task ?? pattern ?? url ?? pick('query') ?? '')),
    activity,
  }
}

type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

// An Edit or Write result's hunks as unified-diff text, with the lines each
// side gained and lost; undefined for any other result.
function patchOf(
  result: unknown,
): { path?: string; patch: string; added: number; removed: number } | undefined {
  const fields = (result ?? {}) as Record<string, unknown>
  const hunks = fields.structuredPatch

  if (!Array.isArray(hunks) || hunks.length === 0) return undefined

  let patch = ''
  let added = 0
  let removed = 0

  for (const hunk of hunks as Hunk[]) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }

    const text = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`
    if (patch.length + text.length <= PATCH_LIMIT) patch += text
  }

  const path = typeof fields.filePath === 'string' ? fields.filePath : undefined

  return { path, patch, added, removed }
}

// `2 files changed +14 −3` for the calls of one chat row, from the log.
function changesOf(all: LogGroup[], ids: readonly (string | undefined)[]) {
  const wanted = new Set(ids)
  const files = new Set<string>()
  let added = 0
  let removed = 0

  for (const g of all) {
    for (const x of g.entries) {
      if (!wanted.has(x.id) || x.patch === undefined) continue
      files.add(x.path ?? x.id)
      added += x.added ?? 0
      removed += x.removed ?? 0
    }
  }

  if (files.size === 0) return ''

  return ` · ${files.size} ${files.size === 1 ? 'file' : 'files'} changed +${added} −${removed}`
}

// What the turn is doing when no tool runs, by the spinner's own mode.
const MODE_ACTIVITY: Record<string, string> = {
  requesting: 'Waiting for model',
  thinking: 'Thinking',
  responding: 'Writing reply',
  'tool-input': 'Preparing a tool call',
  'tool-use': 'Using tools',
}

// Applies fn to the newest group, opening one first when there is none.
function onLatest(list: LogGroup[] | undefined, at: number, fn: (g: LogGroup) => LogGroup) {
  const all = list ?? []
  const last = all[all.length - 1]
  const latest = last ?? { id: `g${at}`, prompt: '', startedAt: at, entries: [] }

  return [...all.slice(0, last ? -1 : undefined), fn(latest)]
}

async function toggle($: EngineInterface) {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)

  if (isOpen) {
    await $.ui.close({ id: PANE })
  } else {
    await $.ui.open({ id: PANE, title: 'Log', columns: 56 })
  }
}

// The running turn's start and its animation timer; a reload starts over.
let startedAt: number | null = null
let timer: Timer | null = null

async function start($: EngineInterface) {
  if (timer !== null) return

  startedAt = await $.clock.now()
  timer = $.clock.every(FRAME_MS, async () => {
    const now = await $.clock.now()
    await update($, tick, prev => ({
      frame: ((prev?.frame ?? 0) + 1) % FRAMES.length,
      elapsedMs: now - (startedAt ?? now),
    }))
  })
}

function stop() {
  timer?.cancel()
  timer = null
  startedAt = null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'log',
      description: 'Toggle the tool log',
    })
    const started = await next(e)

    // The [ diff ] button opens the engine's git diff panel, so it shows only
    // inside a work tree.
    try {
      const git = await $.process.run(['git', 'rev-parse', '--is-inside-work-tree'], {
        cwd: started.cwd,
        timeoutMs: 5000,
      })
      await update($, isRepo, () => git.exitCode === 0 && git.stdout.trim() === 'true')
    } catch {
      await update($, isRepo, () => false)
    }

    return started
  })

  on('command.run', { command: 'log' }, async $ => {
    await toggle($)

    return { text: '' }
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      await start($)

      if (e.origin.kind === 'composer') {
        const at = await $.clock.now()
        const group: LogGroup = {
          id: `g${at}`,
          prompt: firstLine(e.text),
          startedAt: at,
          entries: [],
        }
        await update($, groups, list => [...(list ?? []), group].slice(-MAX_GROUPS))
      }
    } catch {}

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await start($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    stop()

    return next(e)
  })

  // The log must never stand in a call's way: its own failures are swallowed
  // and next(e) runs exactly once either way.
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id

    try {
      const entry: LogEntry = {
        id,
        tool: e.tool,
        ...describe(e.tool, e),
        status: 'running',
      }
      const at = await $.clock.now()
      await update($, groups, list =>
        onLatest(list, at, g => ({ ...g, entries: [...g.entries, entry] })),
      )
    } catch {}

    const ran = await next(e)

    try {
      const status = ran.deny !== undefined || ran.isError === true ? 'error' : 'ok'
      const change = status === 'ok' ? patchOf(ran.result) : undefined
      await update($, groups, list =>
        (list ?? []).map(g => ({
          ...g,
          entries: g.entries.map(one =>
            one.id === id ? { ...one, status, ...(change ?? {}) } : one,
          ),
        })),
      )
    } catch {}

    return ran
  })

  // In the chat a run of tool calls is one dim, pressable line; the log holds
  // the rest. An expanded group unfolds into ToolUse rows of its own.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) {
      return next(e)
    }

    const { Box, Button } = $.ui.resolve(e)
    const changes = changesOf(
      await read($, groups),
      e.props.calls.map(call => call.tool_use_id),
    )

    return (
      <Box marginTop={1}>
        <Button
          key="log"
          label={`› ${countLabel(e.props.calls.length)}${changes}`}
          plain
          dimColor
          onPress={() => toggle($)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const { Box, Button } = $.ui.resolve(e)
    const changes = changesOf(await read($, groups), [e.props.tool_use_id])

    return (
      <Box marginTop={1}>
        <Button
          key="log"
          label={`› ${countLabel(1)}${changes}`}
          plain
          dimColor
          onPress={() => toggle($)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const now = await read($, tick)
    const latest = (await read($, groups)).at(-1)
    const running = latest?.entries.filter(x => x.status === 'running').at(-1)
    const activity = running?.activity ?? MODE_ACTIVITY[e.props.mode] ?? ''
    const room = Math.max(10, (e.viewport?.columns ?? 80) - 14)

    // A blank line above keeps it off the tool line; the band spaces itself.
    return (
      <Box marginTop={1}>
        <Text color="claude">{FRAMES[now.frame] ?? FRAMES[0]}</Text>
        <Text dimColor> {elapsed(now.elapsedMs)}</Text>
        {activity !== '' && (
          <Text wrap="truncate-end">
            <Text dimColor> · </Text>
            {activity.length > room ? `${activity.slice(0, room - 1)}…` : activity}
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.surface !== 'terminal' || e.props.hasSurvey) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const hasDiff = await read($, isRepo)

    // No sizing props here: the engine refuses its own node under a sized Box.
    return (
      <Box>
        <Button key="log-toggle" label="log" dimColor onPress={() => toggle($)} />
        {hasDiff && <Text> </Text>}
        {hasDiff && (
          <Button
            key="diff-open"
            label="diff"
            dimColor
            onPress={async () => {
              await $.command.run({ command: 'diff' })
            }}
          />
        )}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const list = await read($, groups)
    const now = await read($, tick)
    const open = new Set(await read($, expanded))
    const bodyRows = e.props.scroll.bodyRows
    const columns = Math.max(20, e.props.bodyColumns - 2)
    const rows = Math.max(4, bodyRows - 2)

    // Paints the whole body, docked floor to ceiling; inline the frame fits.
    const painted = (child: RenderNode) => (
      <Box
        backgroundColor={PANE_BG}
        width={e.props.bodyColumns}
        height={e.props.placement === 'dock' ? bodyRows : undefined}
        paddingX={1}
        paddingY={1}
        flexDirection="column"
      >
        {child}
      </Box>
    )
    const clip = (text: string, width: number) =>
      text.length > width ? `${text.slice(0, width - 1)}…` : text

    const shown = list.filter(g => g.entries.length > 0 || g === list[list.length - 1])

    if (shown.length === 0) {
      return painted(<Text dimColor>No tool calls yet.</Text>)
    }

    // Newest groups that fit: a header, a line per call, a command line under
    // each failure, and a blank line between groups.
    const fitted: LogGroup[] = []
    let used = 0
    for (const g of [...shown].reverse()) {
      const height =
        2 +
        g.entries.length +
        g.entries.filter(x => x.status === 'error').length +
        g.entries
          .filter(x => open.has(x.id))
          .reduce((sum, x) => sum + (x.patch ?? x.command ?? '').split('\n').length, 0)
      if (fitted.length > 0 && used + height > rows) break
      fitted.unshift(g)
      used += height
    }

    const latest = list[list.length - 1]

    return painted(
      <Box flexDirection="column" gap={1}>
        {fitted.map(g => {
          const isOld = g !== latest
          const meta = `${clockTime(g.startedAt).slice(0, 5)} · ${g.entries.length}`
          const promptWidth = Math.max(8, columns - meta.length - 4)

          return (
            <Box key={g.id} flexDirection="column">
              <Box>
                <Text bold={!isOld} dimColor={isOld} color="claude">
                  ❯{' '}
                </Text>
                <Box width={promptWidth}>
                  <Text bold={!isOld} dimColor={isOld} wrap="truncate-end">
                    {g.prompt === '' ? '(no prompt)' : g.prompt}
                  </Text>
                </Box>
                <Text dimColor> {meta}</Text>
              </Box>
              {g.entries.map(entry => (
                <Box key={entry.id} flexDirection="column">
                  <Box>
                    <Box width={4} flexShrink={0}>
                      <Text>  </Text>
                      {entry.status === 'running' ? (
                        <Text color="claude">{FRAMES[now.frame] ?? FRAMES[0]}</Text>
                      ) : entry.status === 'ok' ? (
                        <Text color="success" dimColor={isOld}>✓</Text>
                      ) : (
                        <Text color="error">✗</Text>
                      )}
                    </Box>
                    {(entry.command !== undefined || entry.patch !== undefined) &&
                    entry.status === 'ok' ? (
                      <Button
                        key={entry.id}
                        plain
                        dimColor={isOld}
                        onPress={() =>
                          update($, expanded, ids =>
                            (ids ?? []).includes(entry.id)
                              ? (ids ?? []).filter(x => x !== entry.id)
                              : [...(ids ?? []), entry.id].slice(-100),
                          )
                        }
                      >
                        {entry.patch !== undefined && <Text bold>{entry.tool} </Text>}
                        {clip(entry.label, columns - 20)}
                        {entry.patch !== undefined && (
                          <Text>
                            {' '}
                            <Text color="success">+{entry.added ?? 0}</Text>{' '}
                            <Text color="error">−{entry.removed ?? 0}</Text>
                          </Text>
                        )}
                        <Text dimColor> {open.has(entry.id) ? '▾' : '▸'}</Text>
                      </Button>
                    ) : (
                      <Text dimColor={isOld} wrap="truncate-end">
                        {entry.command === undefined && (
                          <Text bold>{entry.tool} </Text>
                        )}
                        {clip(entry.label, columns - 6)}
                      </Text>
                    )}
                  </Box>
                  {entry.patch !== undefined && open.has(entry.id) && (
                    <Box marginLeft={4} width={columns - 4}>
                      <Code
                        source={entry.patch}
                        format="diff"
                        path={entry.path}
                        wrap="truncate-end"
                      />
                    </Box>
                  )}
                  {entry.command !== undefined &&
                    (entry.status === 'error' || open.has(entry.id)) && (
                      <Box marginLeft={6} width={columns - 6}>
                        <Text dimColor wrap="wrap">
                          {entry.status === 'error'
                            ? clip(firstLine(entry.command), columns - 8)
                            : entry.command}
                        </Text>
                      </Box>
                    )}
                </Box>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
