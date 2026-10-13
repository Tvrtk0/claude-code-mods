import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, Timer } from 'claude-code'

import type { AgentRow, LogEntry, LogGroup, Tab, TodoItem } from '../types'

const PANE = 'tool-log'
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 120

// The log's own background, a dark plum in place of the engine's grey.
const PANE_BG = '#2a2133'

const groups = atom({ plugin: 'tool-log', key: 'groups' } as const, [])
const MAX_GROUPS = 50
const expanded = atom({ plugin: 'tool-log', key: 'expanded' } as const, [])
const isRepo = atom({ plugin: 'tool-log', key: 'isRepo' } as const, false)
// The prompt group a chat line opened the log on; null follows the newest.
const focus = atom({ plugin: 'tool-log', key: 'focus' } as const, null)

// The most patch text kept per call; whole hunks only, so the diff still parses.
const PATCH_LIMIT = 20_000
const tick = atom({ plugin: 'tool-log', key: 'tick' } as const, {
  frame: 0,
  elapsedMs: 0,
  now: 0,
})
const tabAtom = atom({ plugin: 'tool-log', key: 'tab' } as const, 'log')
const todos = atom({ plugin: 'tool-log', key: 'todos' } as const, [])
const agents = atom({ plugin: 'tool-log', key: 'agents' } as const, [])
// Each tab's content signature when it was last in view: a tab whose
// signature has moved on since shows as unread.
const seen = atom({ plugin: 'tool-log', key: 'seen' } as const, {})

const TABS: Tab[] = ['log', 'files', 'agents', 'todo']
const TAB_TITLES: Record<Tab, string> = {
  log: 'Log',
  todo: 'Todo',
  files: 'Files',
  agents: 'Agents',
}
const ENDED = new Set<AgentRow['status']>(['completed', 'failed', 'killed'])

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

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'

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

type FileChange = {
  path: string
  added: number
  removed: number
  edits: number
  patch: string
}

// Every file the session's calls changed, newest first, its hunks joined.
function filesOf(all: LogGroup[]): FileChange[] {
  const byPath = new Map<string, FileChange>()

  for (const g of all) {
    for (const x of g.entries) {
      if (x.patch === undefined || x.path === undefined) continue
      const prev = byPath.get(x.path)
      byPath.delete(x.path)
      const patch = (prev?.patch ?? '') + x.patch
      byPath.set(x.path, {
        path: x.path,
        added: (prev?.added ?? 0) + (x.added ?? 0),
        removed: (prev?.removed ?? 0) + (x.removed ?? 0),
        edits: (prev?.edits ?? 0) + 1,
        patch: patch.length > PATCH_LIMIT * 3 ? (prev?.patch ?? x.patch) : patch,
      })
    }
  }

  return [...byPath.values()].reverse()
}

// The plan Claude keeps with TodoWrite, or with TaskCreate and TaskUpdate.
async function trackTodos($: EngineInterface, tool: string, input: unknown, result: unknown) {
  const fields = (input ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string) : undefined)
  const isStatus = (v: unknown): v is TodoItem['status'] =>
    v === 'pending' || v === 'in_progress' || v === 'completed'

  if (tool === 'TodoWrite' && Array.isArray(fields.todos)) {
    const items: TodoItem[] = (fields.todos as Record<string, unknown>[]).map((t, i) => ({
      id: `t${i}`,
      content: typeof t.content === 'string' ? t.content : '',
      activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
      status: isStatus(t.status) ? t.status : 'pending',
    }))
    await update($, todos, () => items)
    return
  }

  if (tool === 'TaskCreate') {
    const id = ((result ?? {}) as { task?: { id?: unknown } }).task?.id
    const subject = text('subject')
    if (typeof id !== 'string' || subject === undefined) return
    const item: TodoItem = { id, content: subject, activeForm: text('activeForm'), status: 'pending' }
    await update($, todos, list => [...(list ?? []).filter(x => x.id !== id), item])
    return
  }

  const id = text('taskId')
  if (tool !== 'TaskUpdate' || id === undefined) return

  if (fields.status === 'deleted') {
    await update($, todos, list => (list ?? []).filter(x => x.id !== id))
    return
  }

  await update($, todos, list =>
    (list ?? []).map(x =>
      x.id !== id
        ? x
        : {
            ...x,
            content: text('subject') ?? x.content,
            activeForm: text('activeForm') ?? x.activeForm,
            status: isStatus(fields.status) ? fields.status : x.status,
          },
    ),
  )
}

// Brings each subagent's status up to date from the engine's roster.
async function refreshAgents($: EngineInterface) {
  if ((await read($, agents)).length === 0) return

  const live = new Map((await $.agent.list()).map(a => [a.id, a.status]))
  const now = await $.clock.now()

  await update($, agents, list =>
    (list ?? []).map(row => {
      const status = live.get(row.id) ?? row.status

      return { ...row, status, endedAt: ENDED.has(status) ? (row.endedAt ?? now) : undefined }
    }),
  )
  await update($, tick, prev => ({ frame: prev?.frame ?? 0, elapsedMs: prev?.elapsedMs ?? 0, now }))
}

function signatures(
  all: LogGroup[],
  plan: TodoItem[],
  crew: AgentRow[],
): Record<Tab, string> {
  return {
    log: String(all.reduce((n, g) => n + g.entries.length, 0)),
    todo: plan.map(t => t.id + t.status).join(','),
    files: filesOf(all).map(f => f.path + f.edits).join(','),
    agents: crew.map(a => a.id + a.status).join(','),
  }
}

async function markSeen($: EngineInterface, tabs: readonly Tab[]) {
  const now = signatures(await read($, groups), await read($, todos), await read($, agents))
  await update($, seen, prev => {
    const next = { ...(prev ?? {}) }
    for (const t of tabs) next[t] = now[t]
    return next
  })
}

async function toggleExpanded($: EngineInterface, key: string) {
  await update($, expanded, ids =>
    (ids ?? []).includes(key)
      ? (ids ?? []).filter(x => x !== key)
      : [...(ids ?? []), key].slice(-100),
  )
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

const isLogOpen = async ($: EngineInterface) =>
  (await $.ui.panes()).some(pane => pane.id === PANE)

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Panel', columns: 56 })

// [ panel ] and /panel: open the panel on the tab last in view, or close it.
async function toggle($: EngineInterface) {
  await update($, focus, () => null)

  const tab = await read($, tabAtom)
  await markSeen($, [tab])

  if (await isLogOpen($)) {
    await $.ui.close({ id: PANE })
  } else {
    if (tab === 'agents') await refreshAgents($)
    await openPane($)
  }
}

// A chat line: open the log on its own prompt's group; pressed again while
// that group is in view, close the log.
async function focusOn($: EngineInterface, ids: readonly (string | undefined)[]) {
  const wanted = new Set(ids)
  const group = (await read($, groups)).find(g => g.entries.some(x => wanted.has(x.id)))
  const isOpen = await isLogOpen($)
  const prevTab = await read($, tabAtom)
  const isOnLog = prevTab === 'log'
  await markSeen($, [prevTab, 'log'])
  await update($, tabAtom, () => 'log')

  if (group === undefined) {
    if (!isOpen) await openPane($)
    return
  }

  if (isOpen && isOnLog && (await read($, focus)) === group.id) {
    await update($, focus, () => null)
    await $.ui.close({ id: PANE })
    return
  }

  await update($, focus, () => group.id)
  if (!isOpen) await openPane($)
}

// The running turn's start and its animation timer; a reload starts over.
let startedAt: number | null = null
let timer: Timer | null = null

async function start($: EngineInterface) {
  if (timer !== null) return

  startedAt = await $.clock.now()
  timer = $.clock.every(FRAME_MS, async () => {
    const now = await $.clock.now()
    let frame = 0
    await update($, tick, prev => {
      frame = ((prev?.frame ?? 0) + 1) % FRAMES.length

      return { frame, elapsedMs: now - (startedAt ?? now), now }
    })

    // About once a second, the subagents' status too.
    if (frame === 0) {
      try {
        await refreshAgents($)
      } catch {}
    }
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
      name: 'panel',
      description: 'Toggle the side panel: log, todo, files, agents',
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

  on('command.run', { command: 'panel' }, async $ => {
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
        // A new prompt takes the log back to what is happening now.
        await update($, focus, () => null)
      }

      // A task notification often means a background subagent ended.
      await refreshAgents($)
    } catch {}

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await start($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    stop()

    try {
      await refreshAgents($)
    } catch {}

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    try {
      if (spawned.deny === undefined && spawned.agentId !== undefined) {
        const row: AgentRow = {
          id: spawned.agentId,
          description: e.description,
          type: e.subagentType,
          startedAt: await $.clock.now(),
          status: 'running',
          lastStep: '',
          tools: 0,
        }
        await update($, agents, list => [...(list ?? []).filter(a => a.id !== row.id), row].slice(-30))
      }
    } catch {}

    return spawned
  })

  // The log must never stand in a call's way: its own failures are swallowed
  // and next(e) runs exactly once either way.
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id

    // A subagent's calls count toward its row in Agents, not the log.
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      try {
        const step = describe(e.tool, e).activity
        await update($, agents, list =>
          (list ?? []).map(a => (a.id === agentId ? { ...a, tools: a.tools + 1, lastStep: step } : a)),
        )
      } catch {}

      return next(e)
    }

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
      if (status === 'ok') await trackTodos($, e.tool, e, ran.result)
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
          onPress={() => focusOn($, e.props.calls.map(call => call.tool_use_id))}
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
          onPress={() => focusOn($, [e.props.tool_use_id])}
        />
      </Box>
    )
  })

  // A standalone call's result block draws apart from its row: it lives in
  // the log too, so the chat drops it.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box />
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
        <Button key="log-toggle" label="panel" dimColor onPress={() => toggle($)} />
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

    const tab = await read($, tabAtom)
    const frame = FRAMES[now.frame] ?? FRAMES[0]
    const lastSeen = await read($, seen)
    const current = signatures(list, await read($, todos), await read($, agents))
    // Active: orange. Something new since last viewed: bright. Else dim.
    const isNew = (t: Tab) => t !== tab && current[t] !== '' && current[t] !== (lastSeen[t] ?? '')
    const tabRow = (
      <Box>
        {TABS.map(t => (
          <Box key={`tab-${t}`} marginRight={2}>
            <Button
              key={`tab-${t}`}
              plain
              dimColor={t !== tab && !isNew(t)}
              onPress={async () => {
                await markSeen($, [tab, t])
                await update($, tabAtom, () => t)
              }}
            >
              {t === tab ? (
                <Text bold color="claude">{TAB_TITLES[t]}</Text>
              ) : isNew(t) ? (
                <Text bold>{TAB_TITLES[t]}</Text>
              ) : (
                TAB_TITLES[t]
              )}
            </Button>
          </Box>
        ))}
      </Box>
    )
    const framed = (child: RenderNode) =>
      painted(
        <Box flexDirection="column" gap={1}>
          {tabRow}
          {child}
        </Box>,
      )

    if (tab === 'todo') {
      const plan = await read($, todos)

      if (plan.length === 0) {
        return framed(<Text dimColor>No plan yet. Claude writes one for longer tasks.</Text>)
      }

      const done = plan.filter(t => t.status === 'completed').length

      return framed(
        <Box flexDirection="column">
          <Text dimColor>
            {done}/{plan.length} done
          </Text>
          <Text> </Text>
          {plan.map(t => (
            <Box key={t.id}>
              <Box width={2} flexShrink={0}>
                {t.status === 'completed' ? (
                  <Text color="success">✓</Text>
                ) : t.status === 'in_progress' ? (
                  <Text color="claude">{frame}</Text>
                ) : (
                  <Text dimColor>○</Text>
                )}
              </Box>
              <Box width={columns - 2}>
                <Text
                  dimColor={t.status === 'completed'}
                  bold={t.status === 'in_progress'}
                  wrap="wrap"
                >
                  {t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>,
      )
    }

    if (tab === 'files') {
      const files = filesOf(list)

      if (files.length === 0) {
        return framed(<Text dimColor>No files changed yet.</Text>)
      }

      return framed(
        <Box flexDirection="column">
          {files.map(f => {
            const key = `f:${f.path}`

            return (
              <Box key={key} flexDirection="column" marginBottom={1}>
                <Button key={key} plain onPress={() => toggleExpanded($, key)}>
                  <Text bold>{clip(basename(f.path), columns - 24)}</Text>{' '}
                  <Text color="success">+{f.added}</Text>{' '}
                  <Text color="error">−{f.removed}</Text>
                  <Text dimColor> {open.has(key) ? '▾' : '▸'}</Text>
                </Button>
                <Box marginLeft={2}>
                  <Text dimColor wrap="truncate-start">
                    {home(dirOf(f.path))} · {f.edits} {f.edits === 1 ? 'edit' : 'edits'}
                  </Text>
                </Box>
                {open.has(key) && (
                  <Box marginLeft={2} width={columns - 2}>
                    <Code source={f.patch} format="diff" path={f.path} wrap="truncate-end" />
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>,
      )
    }

    if (tab === 'agents') {
      const crew = await read($, agents)

      if (crew.length === 0) {
        return framed(<Text dimColor>No subagents in this session.</Text>)
      }

      return framed(
        <Box flexDirection="column">
          {[...crew].reverse().map(a => {
            const isLive = !ENDED.has(a.status)
            const end = a.endedAt ?? Math.max(now.now, a.startedAt)

            return (
              <Box key={a.id} flexDirection="column" marginBottom={1}>
                <Box>
                  <Box width={2} flexShrink={0}>
                    {a.status === 'running' || a.status === 'pending' ? (
                      <Text color="claude">{frame}</Text>
                    ) : a.status === 'completed' ? (
                      <Text color="success">✓</Text>
                    ) : a.status === 'failed' ? (
                      <Text color="error">✗</Text>
                    ) : a.status === 'killed' ? (
                      <Text color="warning">■</Text>
                    ) : (
                      <Text dimColor>◌</Text>
                    )}
                  </Box>
                  <Text bold={isLive} dimColor={!isLive} wrap="truncate-end">
                    {clip(a.description, columns - 4)}
                  </Text>
                </Box>
                <Box marginLeft={2}>
                  <Text dimColor wrap="truncate-end">
                    {a.type} · {elapsed(end - a.startedAt)} · {countLabel(a.tools)}
                    {a.status === 'idle' || a.status === 'waiting' ? ` · ${a.status}` : ''}
                  </Text>
                </Box>
                {isLive && a.lastStep !== '' && (
                  <Box marginLeft={2}>
                    <Text dimColor wrap="truncate-end">
                      › {clip(a.lastStep, columns - 6)}
                    </Text>
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>,
      )
    }

    const focused = await read($, focus)
    const all = list.filter(g => g.entries.length > 0 || g === list[list.length - 1])
    const at = focused === null ? -1 : all.findIndex(g => g.id === focused)
    // Focused, the log ends at that group: it sits at the bottom, older above.
    const shown = at === -1 ? all : all.slice(0, at + 1)
    const target = at === -1 ? undefined : all[at]

    if (shown.length === 0) {
      return framed(<Text dimColor>No tool calls yet.</Text>)
    }

    // Newest groups that fit: a header, a line per call, a command line under
    // each failure, and a blank line between groups.
    const fitted: LogGroup[] = []
    let used = target === undefined ? 2 : 4
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

    return framed(
      <Box flexDirection="column" gap={1}>
        {target !== undefined && (
          <Box>
            <Text dimColor wrap="truncate-end">
              viewing: {clip(target.prompt === '' ? '(no prompt)' : target.prompt, columns - 16)}
            </Text>
            <Text dimColor> · </Text>
            <Button
              key="unfocus"
              label="✕"
              plain
              dimColor
              onPress={() => update($, focus, () => null)}
            />
          </Box>
        )}
        {fitted.map(g => {
          const isOld = target === undefined ? g !== latest : g !== target
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
