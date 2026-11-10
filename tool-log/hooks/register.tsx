import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, RenderNode, Timer } from 'claude-code'

import type { AgentRow, LogEntry, LogGroup, Tab } from '../types'

const PANE = 'tool-log'
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 120
const NOTIFY_AFTER_MS = 30_000


// The spinner card's frame sweeps along the meters' gradient, teal to red and
// back, once every SWEEP_MS.
const SWEEP_MS = 4_000
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

// The band's framed buttons and the chat's tool cards: the meters' grey frame, lighter under the
// pointer, a grey label and a dimmer key hint.
const FRAME = '#5a5a5a'
const FRAME_HOVER = '#9a9a9a'
const LABEL = '#c8c8c8'
const KEY = '#8a8a8a'
// A log row under the pointer, and the one j and k are on.
const HOVER_BG = '#3a3a3a'
const SELECTED_BG = '#2e2e2e'

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
const agents = atom({ plugin: 'tool-log', key: 'agents' } as const, [])
// Each tab's content signature when it was last in view: a tab whose
// signature has moved on since shows as unread.
const seen = atom({ plugin: 'tool-log', key: 'seen' } as const, {})
// The panel scrolls itself so its tabs stay put: rows scrolled off the top,
// per tab; null keeps the log pinned to its newest line.
const scrollTop = atom({ plugin: 'tool-log', key: 'scrollTop' } as const, {})

const TABS: Tab[] = ['log', 'files', 'agents']
const TAB_TITLES: Record<Tab, string> = {
  log: 'Log',
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

// How long a call took: `0.3s`, `4.2s`, `12s`, `1m 05s`.
const timeTaken = (ms: number) =>
  ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : elapsed(ms)

// A tool's name in the log, colored by what it does: reading blue, writing
// yellow, the shell grey, subagents purple, the web teal.
function toolColor(tool: string) {
  if (['Read', 'Grep', 'Glob', 'LS', 'ToolSearch'].includes(tool)) return '#81a1c1'
  if (['Edit', 'Write', 'NotebookEdit'].includes(tool)) return '#e5c07b'
  if (tool === 'Bash') return '#9a9a9a'
  if (tool === 'Agent' || tool === 'Task') return '#b48ead'
  if (tool.startsWith('Web')) return '#4fd1c5'
  return '#c8c8c8'
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
  // A Write that creates a file reports no hunks: its content is one hunk of
  // added lines.
  const created =
    fields.type === 'create' && typeof fields.content === 'string'
      ? fields.content.replace(/\n$/, '').split('\n')
      : undefined
  const hunks =
    created !== undefined && (!Array.isArray(fields.structuredPatch) || fields.structuredPatch.length === 0)
      ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: created.length, lines: created.map(l => `+${l}`) }]
      : fields.structuredPatch

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

function signatures(all: LogGroup[], crew: AgentRow[]): Record<Tab, string> {
  return {
    log: String(all.reduce((n, g) => n + g.entries.length, 0)),
    files: filesOf(all).map(f => f.path + f.edits).join(','),
    agents: crew.map(a => a.id + a.status).join(','),
  }
}

async function markSeen($: EngineInterface, tabs: readonly Tab[]) {
  const now = signatures(await read($, groups), await read($, agents))
  await update($, seen, prev => {
    const next = { ...(prev ?? {}) }
    for (const t of tabs) next[t] = now[t]
    return next
  })
}

// The pane's pressable rows in drawing order, as the last drawing laid them
// out, and the one j and k last moved to; a reload starts both over.
let rowKeys: string[] = []
let cursorKey: string | null = null

// Keeps the focus ring on a row and that row in view.
// What the last drawing laid out: each pressable row's first line, the
// content's height, the window's height and how far it was scrolled.
let layout = { tab: 'log' as Tab, rowLine: new Map<string, number>(), content: 0, view: 1, offset: 0 }

const maxOffset = () => Math.max(0, layout.content - layout.view)

async function setOffset($: EngineInterface, offset: number) {
  const tab = layout.tab
  const clamped = Math.max(0, Math.min(maxOffset(), Math.round(offset)))
  // Remembered at once, so the next key counts from here, not from the
  // last drawing.
  layout = { ...layout, offset: clamped }
  // The log at its bottom stays pinned there as new rows arrive.
  const value = tab === 'log' && clamped >= maxOffset() ? null : clamped
  await update($, scrollTop, prev => ({ ...(prev ?? {}), [tab]: value }))
}

async function scrollBy($: EngineInterface, rows: number) {
  await setOffset($, layout.offset + rows)
}

// Keeps the focus ring on a row and scrolls the window to show it.
async function focusRow($: EngineInterface, key: string) {
  cursorKey = key
  try {
    await $.ui.focus({ requestId: PANE, key })
  } catch {}
  const line = layout.rowLine.get(key)
  if (line === undefined) return
  // Like vim's scrolloff: keep a margin of rows around the selected one, so a
  // row height the layout guessed a little wrong still leaves it in view.
  const margin = Math.max(1, Math.min(5, Math.floor(layout.view / 4)))
  if (line < layout.offset + margin) await setOffset($, line - margin)
  else if (line > layout.offset + layout.view - 1 - margin) await setOffset($, line - layout.view + 1 + margin)
}

// j and k: the first press lands on the newest row, at the bottom.
async function moveCursor($: EngineInterface, by: number) {
  if (rowKeys.length === 0) return
  const at = cursorKey === null ? -1 : rowKeys.indexOf(cursorKey)
  const next = at === -1 ? rowKeys.length - 1 : Math.min(rowKeys.length - 1, Math.max(0, at + by))
  const key = rowKeys[next]
  if (key !== undefined) await focusRow($, key)
}

// g and b: the top or the bottom, with the focus on the first or last row.
async function jumpTo($: EngineInterface, end: 'first' | 'last') {
  const key = end === 'first' ? rowKeys[0] : rowKeys[rowKeys.length - 1]
  await setOffset($, end === 'first' ? 0 : Number.MAX_SAFE_INTEGER)
  if (key === undefined) return
  cursorKey = key
  try {
    await $.ui.focus({ requestId: PANE, key })
  } catch {}
}

async function toggleExpanded($: EngineInterface, key: string) {
  // Hold the window where it is, so the row does not move under the eye.
  await setOffset($, layout.offset)
  if (layout.tab === 'log' && layout.offset >= maxOffset()) {
    const tab = layout.tab
    await update($, scrollTop, prev => ({ ...(prev ?? {}), [tab]: layout.offset }))
  }
  await update($, expanded, ids =>
    (ids ?? []).includes(key)
      ? (ids ?? []).filter(x => x !== key)
      : [...(ids ?? []), key].slice(-100),
  )
  // The row grew or shrank under the focus: put it back on the same row.
  await focusRow($, key)
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

const openPane = ($: EngineInterface, focus?: true) =>
  $.ui.open({ id: PANE, title: 'Panel', columns: 56, ...(focus ? { focus } : {}) })

// The panel chip and /panel: open the panel on the tab last in view, or close it.
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

// ctrl+t: hand the panel the keyboard, opening it if it is closed; when it
// already holds the keyboard, close it. Esc alone gives the keys back.
async function focusPanel($: EngineInterface) {
  const pane = (await $.ui.panes()).find(x => x.id === PANE)
  const tab = await read($, tabAtom)
  await markSeen($, [tab])

  if (pane?.isFocused) {
    await update($, focus, () => null)
    await $.ui.close({ id: PANE })
    return
  }

  if (pane === undefined && tab === 'agents') await refreshAgents($)
  await openPane($, true)
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

// The run the next tool calls join. A model response with text in it starts
// a new run; responses that only call tools keep adding to the current one,
// so the chat can show the whole run as one line.
// A reload starts the module over, so the ids carry a prefix of its own:
// a new run never takes the id of one the log kept from before.
const RUN_PREFIX = `r${Math.floor(Math.random() * 1e9).toString(36)}-`
let runSeq = 0
let currentRun = `${RUN_PREFIX}0`

function newRun() {
  runSeq += 1
  currentRun = `${RUN_PREFIX}${runSeq}`
}

// The calls sharing a run with any of `ids`, oldest first.
function runOf(all: LogGroup[], ids: readonly (string | undefined)[]): LogEntry[] {
  const wanted = new Set(ids)
  const entries = all.flatMap(g => g.entries)
  const run = entries.find(x => wanted.has(x.id))?.run
  if (run === undefined) return entries.filter(x => wanted.has(x.id))
  return entries.filter(x => x.run === run)
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

// One chat line for a run of tool calls, marked by an accent diamond: the
// run's last row carries the count, changes and failures of the whole run;
// earlier rows draw nothing.
async function runRow(
  $: EngineInterface,
  e: RenderInput,
  ids: readonly (string | undefined)[],
  own: number,
  ownFailed: number,
): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const all = await read($, groups)
  const run = runOf(all, ids)
  const mine = new Set(ids)
  const last = run.at(-1)

  if (run.length > 0 && last !== undefined && !mine.has(last.id)) {
    return <Box />
  }

  const count = Math.max(own, run.length)
  const runIds = run.length > 0 ? run.map(x => x.id) : ids
  const changes = changesOf(all, runIds)
  const failed = run.length > 0 ? run.filter(x => x.status === 'error').length : ownFailed

  return (
    <Box key="log-card" marginTop={1}>
      <Text color="claude">◆ </Text>
      <Button key="log" plain onPress={() => focusOn($, runIds)} hover={{ color: 'white' }}>
        <Text color={LABEL}>{`${countLabel(count)}${changes}`}</Text>
        {failed > 0 && <Text color="error">{` · ${failed} failed`}</Text>}
      </Button>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'panel',
      description: 'Toggle the side panel: log, files, agents',
    })
    const started = await next(e)

    // The diff chip opens the engine's git diff panel, so it shows only
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
        newRun()
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

  // Text in a response starts a new run; a subagent's steps are its own.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (e.agentId === undefined && response.answer.trim() !== '') newRun()
    return response
  })

  on('turn.start', async ($, e, next) => {
    newRun()
    await start($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    stop()

    try {
      await refreshAgents($)
    } catch {}

    // A long turn ends with a desktop notification, for when you looked away.
    try {
      if (!e.isAborted && e.durationMs >= NOTIFY_AFTER_MS) {
        const prompt = (await read($, groups)).at(-1)?.prompt ?? ''
        const gist = prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt
        await $.ui.notify(gist === '' ? 'Done' : `Done: ${gist}`, { title: 'Claude Code' })
      }
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
        run: currentRun,
        startedAt: await $.clock.now(),
      }
      const at = entry.startedAt ?? 0
      await update($, groups, list =>
        onLatest(list, at, g => ({ ...g, entries: [...g.entries, entry] })),
      )
    } catch {}

    const ran = await next(e)

    try {
      const status = ran.deny !== undefined || ran.isError === true ? 'error' : 'ok'
      const change = status === 'ok' ? patchOf(ran.result) : undefined
      const endedAt = await $.clock.now()
      // Why it failed, in a line: the refusal, or the error the model read.
      const reason =
        ran.deny !== undefined
          ? ran.deny
          : ran.isError === true
            ? (ran.text ?? (typeof ran.result === 'string' ? ran.result : ''))
            : ''
      const error = reason.trim() === '' ? undefined : firstLine(reason.trim())
      await update($, groups, list =>
        (list ?? []).map(g => ({
          ...g,
          entries: g.entries.map(one =>
            one.id === id ? { ...one, status, endedAt, error, ...(change ?? {}) } : one,
          ),
        })),
      )
    } catch {}

    return ran
  })

  // In the chat a run of tool calls is one dim, pressable line; the log holds
  // the rest. Rows the engine draws apart (one per response) fold into the
  // run's last row; the others draw nothing. An expanded group unfolds into
  // ToolUse rows of its own.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded) {
      return next(e)
    }

    return runRow(
      $,
      e,
      e.props.calls.map(call => call.tool_use_id),
      e.props.calls.length,
      e.props.calls.filter(call => call.isErrored).length,
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    return runRow($, e, [e.props.tool_use_id], 1, e.props.isErrored ? 1 : 0)
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
    const room = Math.max(10, (e.viewport?.columns ?? 80) - 18)

    // A card in a rounded frame, a blank line above it. A border takes one
    // color, so the gradient runs through time instead: the frame sweeps
    // teal to red and back every few seconds while the turn runs.
    const sweep = (now.elapsedMs % SWEEP_MS) / SWEEP_MS
    const border = gradient(sweep < 0.5 ? sweep * 2 : 2 - sweep * 2)

    return (
      <Box marginTop={1} alignSelf="flex-start" borderStyle="round" borderColor={border} paddingX={1}>
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

    // A framed button, in the meters' rounded frame; the frame and the label
    // light under the pointer. It never shrinks, so a narrow band wraps none.
    const framed = (key: string, children: RenderNode) => (
      <Box
        key={`${key}-box`}
        flexShrink={0}
        marginRight={1}
        borderStyle="round"
        borderColor={FRAME}
        paddingX={1}
        hover={{ borderColor: FRAME_HOVER }}
      >
        {children}
      </Box>
    )

    // No sizing props here: the engine refuses its own node under a sized Box.
    // The panel frame has two parts: a click on `panel` opens or closes it; ⌃T
    // is the key that hands it the keyboard. The engine cannot tell a click
    // from the key, so each part keeps its own press.
    return (
      <Box>
        {framed(
          'log-toggle',
          <Box>
            <Button key="log-toggle" plain onPress={() => toggle($)} hover={{ color: 'white' }}>
              <Text color={LABEL}>☰ panel</Text>
            </Button>
            <Text>  </Text>
            {/* ctrl+t in ~/.claude/keybindings.json is bound to an engine
                action only the diff panel handles, free at the prompt. */}
            <Button key="panel-key" plain action="app:toggleDiffPreSession" onPress={() => focusPanel($)}>
              <Text color={KEY}>⌃T</Text>
            </Button>
          </Box>,
        )}
        {hasDiff &&
          framed(
            'diff-open',
            <Button
              key="diff-open"
              plain
              hover={{ color: 'white' }}
              onPress={async () => {
                await $.command.run({ command: 'diff' })
              }}
            >
              <Text color={LABEL}>± diff</Text>
            </Button>,
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
    const clip = (text: string, width: number) =>
      text.length > width ? `${text.slice(0, width - 1)}…` : text
    const lines = (text: string, width: number) =>
      text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(1, width))), 0)
    const patchLines = (patch: string) => patch.replace(/\n$/, '').split('\n').length

    // A stored tab the panel no longer has (Todo) falls back to the log.
    const stored = await read($, tabAtom)
    const tab = TABS.includes(stored) ? stored : 'log'
    const frame = FRAMES[now.frame] ?? FRAMES[0]
    const lastSeen = await read($, seen)
    const current = signatures(list, await read($, agents))
    // Active: orange. Something new since last viewed: bright. Else dim.
    const isNew = (t: Tab) => t !== tab && current[t] !== '' && current[t] !== (lastSeen[t] ?? '')
    const step = (by: number) => async () => {
      const next = TABS[(TABS.indexOf(tab) + by + TABS.length) % TABS.length] ?? tab
      cursorKey = null
      await markSeen($, [tab, next])
      await update($, tabAtom, () => next)
    }
    const key = (k: string, label: string, onPress: () => unknown) => (
      <Box key={`hintbox-${k}`} marginRight={2}>
        <Button key={`hint-${k}`} hotkey={k} label={label} plain onPress={onPress} />
      </Box>
    )

    // The tabs and, while the panel holds the keyboard, its keys: drawn above
    // the scrolled window, so they never scroll away.
    const isFocused = e.props.isFocused
    const header = (
      <Box flexDirection="column">
        {/* The tabs: a segmented switch in a rounded frame, as the band's. */}
        <Box alignSelf="flex-start" borderStyle="round" borderColor={FRAME} paddingX={1}>
          {TABS.map((t, i) => (
            <Box key={`tabbox-${t}`}>
              {i > 0 && <Text color={FRAME}>{'  │  '}</Text>}
              <Button
                key={`tab-${t}`}
                hotkey={String(i + 1)}
                plain
                hover={t === tab ? undefined : { color: 'white' }}
                onPress={async () => {
                  cursorKey = null
                  await markSeen($, [tab, t])
                  await update($, tabAtom, () => t)
                }}
              >
                {t === tab ? (
                  <Text bold color="claude">{TAB_TITLES[t]}</Text>
                ) : isNew(t) ? (
                  <Text bold color="white">{TAB_TITLES[t]}</Text>
                ) : (
                  <Text color={KEY}>{TAB_TITLES[t]}</Text>
                )}
              </Button>
            </Box>
          ))}
        </Box>
        {isFocused && (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              {key('h', 'prev', step(-1))}
              {key('l', 'next', step(1))}
              {key('j', 'down', () => moveCursor($, 1))}
              {key('k', 'up', () => moveCursor($, -1))}
            </Box>
            <Box>
              {key('d', 'half down', () => scrollBy($, Math.max(1, Math.floor(layout.view / 2))))}
              {key('u', 'half up', () => scrollBy($, -Math.max(1, Math.floor(layout.view / 2))))}
              {key('g', 'top', () => jumpTo($, 'first'))}
              {/* b for the bottom: a hotkey cannot tell shift+g from g */}
              {key('b', 'bottom', () => jumpTo($, 'last'))}
            </Box>
          </Box>
        )}
      </Box>
    )
    // The tabs' frame is three rows; the keys add a gap and two rows.
    const headerRows = isFocused ? 6 : 3
    // Body rows less the padding, the header and the gap under it.
    const view = Math.max(3, bodyRows - 2 - headerRows - 1)

    // Lays the content out in a window of `view` rows, scrolled by this tab's
    // offset, and records where each pressable row sits for j, k and focus.
    const windowed = async (
      content: RenderNode,
      height: number,
      rowLine: Map<string, number>,
      keys: string[] = [],
    ) => {
      const stored = (await read($, scrollTop))[tab]
      const max = Math.max(0, height - view)
      const fallback = tab === 'log' ? max : 0
      const offset = Math.max(0, Math.min(max, stored === null || stored === undefined ? fallback : stored))
      // Both at once, after the last await: a key pressed mid-drawing never
      // sees one without the other.
      layout = { tab, rowLine, content: height, view, offset }
      rowKeys = keys
      return (
        <Box
          width={e.props.bodyColumns}
          height={e.props.placement === 'dock' ? bodyRows : undefined}
          paddingX={1}
          paddingY={1}
          flexDirection="column"
        >
          {header}
          {/* A blank row between the header and the scrolled window. */}
          <Box height={1} />
          <Box height={view} overflow="hidden" flexDirection="column">
            <Box marginTop={-offset} flexDirection="column" flexShrink={0}>
              {content}
            </Box>
          </Box>
        </Box>
      )
    }

    if (tab === 'files') {
      const files = filesOf(list)
      const fileKeys = files.map(f => `f:${f.path}`)

      if (files.length === 0) {
        return windowed(<Text dimColor>No files changed yet.</Text>, 1, new Map())
      }

      const rowLine = new Map<string, number>()
      let y = 0
      for (const f of files) {
        const k = `f:${f.path}`
        rowLine.set(k, y)
        y += 2 + (open.has(k) ? patchLines(f.patch) : 0) + 1
      }

      return windowed(
        <Box flexDirection="column">
          {files.map(f => {
            const k = `f:${f.path}`

            return (
              <Box key={`row-${k}`} flexDirection="column" marginBottom={1}>
                <Button key={k} plain onPress={() => toggleExpanded($, k)}>
                  <Text bold>{clip(basename(f.path), columns - 24)}</Text>{' '}
                  <Text color="success">+{f.added}</Text>{' '}
                  <Text color="error">−{f.removed}</Text>
                  <Text dimColor> {open.has(k) ? '▾' : '▸'}</Text>
                </Button>
                <Box marginLeft={2}>
                  <Text dimColor wrap="truncate-start">
                    {home(dirOf(f.path))} · {f.edits} {f.edits === 1 ? 'edit' : 'edits'}
                  </Text>
                </Box>
                {open.has(k) && (
                  <Box marginLeft={2} width={columns - 2}>
                    <Code source={f.patch} format="diff" path={f.path} wrap="truncate-end" />
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>,
        y,
        rowLine,
        fileKeys,
      )
    }

    if (tab === 'agents') {
      const crew = await read($, agents)

      if (crew.length === 0) {
        return windowed(<Text dimColor>No subagents in this session.</Text>, 1, new Map())
      }

      const height = crew.reduce((n, a) => n + 3 + (!ENDED.has(a.status) && a.lastStep !== '' ? 1 : 0), 0)

      return windowed(
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
        height,
        new Map(),
      )
    }

    const focused = await read($, focus)
    const all = list.filter(g => g.entries.length > 0 || g === list[list.length - 1])
    const at = focused === null ? -1 : all.findIndex(g => g.id === focused)
    // Focused, the log ends at that group: it sits at the bottom, older above.
    const shown = (at === -1 ? all : all.slice(0, at + 1)).slice(-40)
    const target = at === -1 ? undefined : all[at]

    if (shown.length === 0) {
      return windowed(<Text dimColor>No tool calls yet.</Text>, 1, new Map())
    }

    const pressable = (x: LogEntry) => (x.command !== undefined || x.patch !== undefined) && x.status === 'ok'
    const logKeys = shown.flatMap(g => g.entries.filter(pressable).map(x => x.id))

    // Inside a group's card: its frame and padding take four columns.
    const inner = columns - 4
    // A row: the status (2), the tool's name (7), the label, the diff counts
    // and the time at the right (7).
    const labelRoom = (x: LogEntry) =>
      Math.max(8, inner - 2 - 7 - 7 - (x.patch !== undefined ? ` +${x.added ?? 0} −${x.removed ?? 0}`.length : 0) - 2)

    // Where each row lands: a group is its card (a border row above and
    // below), its header, a line per call and what an open or failed call
    // unfolds; a blank line between cards.
    const rowLine = new Map<string, number>()
    let y = 0
    shown.forEach((g, gi) => {
      if (gi > 0) y += 1
      y += 2
      for (const x of g.entries) {
        rowLine.set(x.id, y)
        y += 1
        if (x.patch !== undefined && open.has(x.id)) y += patchLines(x.patch)
        if (x.status === 'error') {
          if (x.command !== undefined) y += 1
          if (x.error !== undefined) y += 1
        } else if (x.command !== undefined && open.has(x.id)) y += lines(x.command, inner - 9)
      }
      y += 1
    })

    const latest = list[list.length - 1]
    const isTarget = (g: LogGroup) => (target === undefined ? g === latest : g === target)

    return windowed(
      <Box flexDirection="column" gap={1}>
        {shown.map(g => {
          const isOld = !isTarget(g)
          const meta = `${clockTime(g.startedAt).slice(0, 5)} · ${g.entries.length}`
          const promptWidth = Math.max(8, inner - meta.length - 3 - (g === target ? 4 : 0))

          return (
            <Box
              key={g.id}
              flexDirection="column"
              borderStyle="round"
              borderColor={isOld ? FRAME : 'claude'}
              paddingX={1}
            >
              <Box>
                {/* Every prompt reads bold and bright, apart from the grey
                    calls under it; the live card's alone is in the accent. */}
                <Text bold color="claude" dimColor={isOld}>
                  ❯{' '}
                </Text>
                <Box width={promptWidth}>
                  <Text bold color={isOld ? LABEL : 'white'} wrap="truncate-end">
                    {g.prompt === '' ? '(no prompt)' : g.prompt}
                  </Text>
                </Box>
                <Text color={KEY}> {meta}</Text>
                {/* The card a chat line opened: ✕ takes the log back to live. */}
                {g === target && (
                  <Box marginLeft={2}>
                    <Button key="unfocus" label="✕" plain dimColor onPress={() => update($, focus, () => null)} />
                  </Box>
                )}
              </Box>
              {g.entries.map(entry => {
                const isOn = pressable(entry)
                const isSelected = cursorKey === entry.id
                const took = entry.startedAt === undefined
                  ? ''
                  : timeTaken((entry.endedAt ?? (entry.status === 'running' ? now.now : entry.startedAt)) - entry.startedAt)
                const label = (
                  <Text color={isOld ? KEY : LABEL}>
                    {clip(entry.label, labelRoom(entry))}
                    {entry.patch !== undefined && (
                      <Text>
                        {' '}
                        <Text color="success">+{entry.added ?? 0}</Text>{' '}
                        <Text color="error">−{entry.removed ?? 0}</Text>
                      </Text>
                    )}
                    {isOn && <Text color={KEY}> {open.has(entry.id) ? '▾' : '▸'}</Text>}
                  </Text>
                )

                return (
                  <Box key={`row-${entry.id}`} flexDirection="column">
                    {/* The row lights under the pointer; the one j and k are
                        on keeps a faint background. */}
                    <Box
                      key={`rowbox-${entry.id}`}
                      backgroundColor={isSelected ? SELECTED_BG : undefined}
                      hover={{ backgroundColor: HOVER_BG }}
                    >
                      <Box width={2} flexShrink={0}>
                        {entry.status === 'running' ? (
                          <Text color="claude">{frame}</Text>
                        ) : entry.status === 'ok' ? (
                          <Text color="success" dimColor={isOld}>✓</Text>
                        ) : (
                          <Text color="error">✗</Text>
                        )}
                      </Box>
                      <Box width={7} flexShrink={0}>
                        <Text color={toolColor(entry.tool)} dimColor={isOld}>
                          {clip(entry.tool, 6)}
                        </Text>
                      </Box>
                      <Box flexGrow={1}>
                        {isOn ? (
                          <Button key={entry.id} plain onPress={() => toggleExpanded($, entry.id)} hover={{ color: 'white' }}>
                            {label}
                          </Button>
                        ) : (
                          label
                        )}
                      </Box>
                      <Box width={7} flexShrink={0} justifyContent="flex-end">
                        <Text color={KEY}>{took}</Text>
                      </Box>
                    </Box>
                    {entry.patch !== undefined && open.has(entry.id) && (
                      <Box marginLeft={2} width={inner - 2}>
                        <Code source={entry.patch} format="diff" path={entry.path} wrap="truncate-end" />
                      </Box>
                    )}
                    {entry.command !== undefined && (entry.status === 'error' || open.has(entry.id)) && (
                      <Box marginLeft={9} width={inner - 9}>
                        <Text color={KEY} wrap="wrap">
                          {entry.status === 'error' ? clip(firstLine(entry.command), inner - 10) : entry.command}
                        </Text>
                      </Box>
                    )}
                    {/* Why it failed, in red, under the call. */}
                    {entry.status === 'error' && entry.error !== undefined && (
                      <Box marginLeft={9} width={inner - 9}>
                        <Text color="error" wrap="truncate-end">
                          {clip(home(entry.error), inner - 10)}
                        </Text>
                      </Box>
                    )}
                  </Box>
                )
              })}
            </Box>
          )
        })}
      </Box>,
      y,
      rowLine,
      logKeys,
    )
  })
}
