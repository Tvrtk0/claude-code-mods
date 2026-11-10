import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, Timer } from 'claude-code'

import type { Group, Note, Pr, PeekFile, Snapshot, Tab } from '../types'

const PANE = 'pr-inbox'
// Behind a comment's text, so it reads as what someone said and not as one
// more line under their name. A raw color: no theme key fills a block.
const BUBBLE_BG = '#33333f'
// The cards' frames, the same grey as usage-meters' and tool-log's.
const FRAME = '#5a5a5a'
// What a card's frame and padding take from the width inside it.
const CARD_INSET = 4
const DAY_MS = 86_400_000

const isOn = atom({ plugin: 'pr-inbox', key: 'isOn' } as const, false)
const tabAtom = atom({ plugin: 'pr-inbox', key: 'tab' } as const, 'queue')
const peekAtom = atom({ plugin: 'pr-inbox', key: 'peek' } as const, null)
const peekFileAtom = atom({ plugin: 'pr-inbox', key: 'peekFile' } as const, null)
const peekOffsetAtom = atom({ plugin: 'pr-inbox', key: 'peekOffset' } as const, null)
const showResolvedAtom = atom({ plugin: 'pr-inbox', key: 'showResolved' } as const, false)

// Where the thread view's window stood when last drawn, so a wheel tick or
// j/k moves it from there; the drawing is the one that knows the heights.
let peekLayout = { offset: 0, max: 0, view: 1 }
const cwdAtom = atom({ plugin: 'pr-inbox', key: 'cwd' } as const, '')
const snapshot = atom({ plugin: 'pr-inbox', key: 'snapshot' } as const, null)
const selected = atom({ plugin: 'pr-inbox', key: 'selected' } as const, null)
const error = atom({ plugin: 'pr-inbox', key: 'error' } as const, null)
const isLoading = atom({ plugin: 'pr-inbox', key: 'isLoading' } as const, false)
const seen = atom({ plugin: 'pr-inbox', key: 'seen' } as const, [])

const TABS: { tab: Tab; label: string; groups: Group[] }[] = [
  { tab: 'queue', label: 'Queue', groups: ['new', 'changed'] },
  { tab: 'mine', label: 'Mine', groups: ['mine'] },
  { tab: 'done', label: 'Reviewed', groups: ['done'] },
  { tab: 'help', label: 'Help', groups: [] },
]

// What the Help tab explains, in the order classify() picks an emoji.
const LEGEND: [string, string][] = [
  ['🔁', 'you reviewed it, then the head moved'],
  ['❌', 'a CI check failed'],
  ['⛔', 'merge conflict'],
  ['🔄', 'someone requested changes'],
  ['✅', 'yours, and someone approved it'],
  ['⚪', 'no CI checks at all'],
  ['🕓', 'waiting 3 days or more'],
  ['🟢', 'CI green, nothing else to say'],
  ['⏳', 'CI still running'],
]

const KEYS: [string, string][] = [
  ['1–4', 'switch tab'],
  ['h / l', 'previous / next tab (the ‹ › after the tabs)'],
  ['j / k', 'next / previous PR (the ↓ ↑ in the header)'],
  ['o', 'open the PR in the browser'],
  ['r', 'type the review command into the prompt; on a 🔁 PR, only what arrived after your review (not on your own PRs)'],
  ['e', 'type the explain command into the prompt (not on your own PRs)'],
  ['f', 'fetch now (the age in the header)'],
  ['click ›', 'open a thread over the list: its code, the suggestion as a diff, the replies'],
  ['b', 'back to the list from a thread'],
  ['o', 'in a thread: open that comment on GitHub, to commit the suggestion there'],
  ['ctrl+x tab', 'move the keyboard into the pane; Esc gives it back'],
]

const COMMANDS: [string, string][] = [
  ['/prs', 'turn on, or open and close the pane'],
  ['/prs <absolute path>', 'read another checkout'],
  ['/prs refresh', 'fetch now'],
  ['/prs off', 'stop polling and close'],
]

const GROUPS: { group: Group; title: string }[] = [
  { group: 'new', title: 'Not reviewed yet' },
  { group: 'changed', title: 'Changed since your review' },
  { group: 'mine', title: 'Yours' },
  { group: 'done', title: 'Reviewed at head' },
]

const QUERY = `
query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft createdAt headRefOid additions deletions mergeable
        author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        reviews(last: 50) { nodes { author { login } state submittedAt commit { oid } } }
        reviewThreads(first: 50) {
          nodes {
            isResolved isOutdated path line originalLine startLine originalStartLine
            first: comments(first: 1) { nodes { author { __typename login } body createdAt url diffHunk originalCommit { oid } } }
            last: comments(last: 1) { nodes { author { __typename login } body createdAt url } }
          }
        }
        comments(last: 20) { nodes { author { __typename login } body createdAt url } }
      }
    }
  }
}`

type Raw = {
  number: number
  title: string
  url: string
  isDraft: boolean
  createdAt: string
  headRefOid: string
  additions: number
  deletions: number
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  author: { login: string } | null
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
  reviews: {
    nodes: { author: { login: string } | null; state: string; submittedAt: string | null; commit: { oid: string } | null }[]
  }
  reviewThreads: {
    nodes: {
      isResolved: boolean
      isOutdated: boolean
      path: string
      line: number | null
      originalLine: number | null
      startLine: number | null
      originalStartLine: number | null
      first: { nodes: (RawComment & { diffHunk: string; originalCommit: { oid: string } | null })[] }
      last: { nodes: RawComment[] }
    }[]
  }
  comments: { nodes: RawComment[] }
}

type RawComment = { author: { __typename?: string; login: string } | null; body: string; createdAt: string; url: string }

// Review state comes from the reviews array alone: reviewDecision is empty on
// repos with no required reviewers and stuck on REVIEW_REQUIRED on others.
export function classify(raw: Raw, login: string, now: number): Pr {
  const author = raw.author?.login ?? 'ghost'
  const submitted = raw.reviews.nodes.filter(r => r.state !== 'PENDING' && r.submittedAt)
  const mine = submitted.filter(r => r.author?.login === login)
  const latest = mine[mine.length - 1]
  const since = latest?.submittedAt ?? ''

  let group: Group
  if (author === login) group = 'mine'
  else if (!latest) group = 'new'
  else if (latest.commit?.oid === raw.headRefOid) group = 'done'
  else group = 'changed'

  const ci = raw.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null
  const others = submitted.filter(r => r.author?.login !== author)
  const lastBy = new Map(others.map(r => [r.author?.login, r.state]))
  const states = [...lastBy.values()]
  const age = now - Date.parse(raw.createdAt)

  let emoji: string
  if (group === 'changed') emoji = '🔁'
  else if (ci === 'FAILURE' || ci === 'ERROR') emoji = '❌'
  else if (raw.mergeable === 'CONFLICTING') emoji = '⛔'
  else if (states.includes('CHANGES_REQUESTED')) emoji = '🔄'
  else if (group === 'mine' && states.includes('APPROVED')) emoji = '✅'
  else if (ci === null) emoji = '⚪'
  else if (group !== 'done' && age >= 3 * DAY_MS) emoji = '🕓'
  else if (ci === 'SUCCESS') emoji = '🟢'
  else emoji = '⏳'

  const isBot = (c: RawComment) => c.author?.__typename === 'Bot' || (c.author?.login ?? '').endsWith('[bot]')
  // On your own PR a thread is new while its last word is someone else's; on
  // anyone else's, when it was written after your latest review.
  const isNew = (c: RawComment) =>
    !isBot(c) && c.author?.login !== login && (group === 'mine' || !since || c.createdAt > since)
  const note = (c: RawComment, extra: Partial<Note> = {}): Note => ({
    author: c.author?.login ?? 'ghost',
    body: c.body,
    url: c.url,
    at: c.createdAt,
    isNew: isNew(c),
    ...extra,
  })

  const thread = threadNote(note)

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author,
    isDraft: raw.isDraft,
    createdAt: raw.createdAt,
    head: raw.headRefOid,
    additions: raw.additions,
    deletions: raw.deletions,
    group,
    emoji,
    ...(group === 'changed' && latest?.commit ? { reviewedSha: latest.commit.oid } : {}),
    threads: raw.reviewThreads.nodes.filter(t => !t.isResolved).flatMap(thread),
    resolved: raw.reviewThreads.nodes
      .filter(t => t.isResolved)
      .flatMap(thread)
      .map(one => ({ ...one, isNew: false })),
    comments: raw.comments.nodes.filter(isNew).map(c => note(c)),
  }
}

type RawThread = Raw['reviewThreads']['nodes'][number]

// One review thread as a Note: its last word, where it sits, its opener.
function threadNote(note: (c: RawComment, extra?: Partial<Note>) => Note) {
  return (t: RawThread): Note[] => {
        const last = t.last.nodes[0]
        const first = t.first.nodes[0]
        if (!last) return []
        const isOutdated = t.isOutdated || t.line === null
        const line = isOutdated ? t.originalLine : t.line
        const startLine = isOutdated ? t.originalStartLine : t.startLine

        return [
          note(last, {
            path: t.path,
            ...(line ? { line } : {}),
            ...(startLine && startLine !== line ? { startLine } : {}),
            isOutdated,
            ...(first
              ? {
                  opener: {
                    author: first.author?.login ?? 'ghost',
                    body: first.body,
                    url: first.url,
                    ...(first.originalCommit ? { commit: first.originalCommit.oid } : {}),
                  },
                  hunk: first.diffHunk,
                }
              : {}),
          }),
        ]
  }
}

async function gh($: EngineInterface, cwd: string, args: string[]) {
  const run = await $.process.run(['gh', ...args], { ...(cwd ? { cwd } : {}), timeoutMs: 30_000 })
  if (run.exitCode !== 0) throw new Error(run.stderr.trim() || `gh ${args[0]} exited ${run.exitCode}`)

  return run.stdout
}

// Whether the head still contains the reviewed commit tells a fixup from a rewrite.
async function tailOf($: EngineInterface, cwd: string, repo: string, pr: Pr) {
  try {
    const out = await gh($, cwd, [
      'api',
      `repos/${repo}/compare/${pr.reviewedSha}...${pr.head}`,
      '--jq',
      '[.status, .ahead_by] | @tsv',
    ])
    const [status, ahead] = out.trim().split('\t')
    if (status !== 'ahead') return 'force-push'

    return `+${ahead} commit${ahead === '1' ? '' : 's'}`
  } catch {
    return 'force-push'
  }
}

export async function fetchSnapshot($: EngineInterface, cwd: string): Promise<Snapshot> {
  const repo = (await gh($, cwd, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim()
  const [owner, name] = repo.split('/')
  const out = await gh($, cwd, [
    'api',
    'graphql',
    '-f',
    `query=${QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
  ])
  const data = JSON.parse(out).data
  const login: string = data.viewer.login
  const now = await $.clock.now()
  const prs: Pr[] = data.repository.pullRequests.nodes.map((raw: Raw) => classify(raw, login, now))
  await Promise.all(
    prs.filter(pr => pr.group === 'changed').map(async pr => (pr.tail = await tailOf($, cwd, repo, pr))),
  )

  return { repo, login, prs, fetchedAt: now }
}

const groupsOf = (tab: Tab) => TABS.find(one => one.tab === tab)?.groups ?? []

// A group's PRs as drawn: not-reviewed-yet newest opened first, the rest as
// fetched (last updated first).
const inGroup = (snap: Snapshot, group: Group) => {
  const prs = snap.prs.filter(pr => pr.group === group)

  return group === 'new' ? prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : prs
}

// The tab's PRs in the order the pane draws them, so j/k walk what the eye sees.
const ordered = (snap: Snapshot, tab: Tab) =>
  GROUPS.filter(({ group }) => groupsOf(tab).includes(group)).flatMap(({ group }) => inGroup(snap, group))

const fill = (template: string, pr: Pr) =>
  template.replaceAll('{n}', String(pr.number)).replaceAll('{sha}', (pr.reviewedSha ?? '').slice(0, 7))

function ago(ms: number) {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`

  return `${Math.round(m / 60)}h ago`
}

// A comment as one readable line: a suggestion block as a marker, other code
// fences and HTML (bot reports, <details>) dropped.
const oneLine = (text: string, max: number) => {
  const flat = text
    .replace(/```suggestion[\s\S]*?(```|$)/g, ' [suggestion] ')
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

type Config = { pollMinutes: number; reviewCommand: string; reReviewCommand: string; explainCommand: string }

let config: Config = {
  pollMinutes: 5,
  reviewCommand: '/comment-pr {n}',
  reReviewCommand: '/comment-pr {n} (review only what arrived after {sha})',
  explainCommand: '/read-pr {n}',
}

let timer: Timer | null = null

export async function refresh($: EngineInterface) {
  if (await read($, isLoading)) return
  await update($, isLoading, () => true)
  try {
    const snap = await fetchSnapshot($, await read($, cwdAtom))
    const before = await read($, snapshot)
    const known = new Set(await read($, seen))
    const waiting = snap.prs.filter(pr => pr.group === 'new' || pr.group === 'changed')
    const fresh = waiting.filter(pr => !known.has(`${pr.number}@${pr.head}`))

    // The first fetch is the baseline; only what arrives after it is news.
    if (before && fresh.length > 0) {
      $.ui.toast(`PR inbox: ${fresh.map(pr => `#${pr.number} ${pr.group === 'new' ? 'new' : 'changed'}`).join(', ')}`)
    }
    await update($, seen, list => [...new Set([...list, ...waiting.map(pr => `${pr.number}@${pr.head}`)])].slice(-500))
    await update($, snapshot, () => snap)
    const list = ordered(snap, await read($, tabAtom))
    await update($, selected, n => (n !== null && list.some(pr => pr.number === n) ? n : (list[0]?.number ?? null)))
    await update($, error, () => null)
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
  } finally {
    await update($, isLoading, () => false)
  }
}

function startPolling($: EngineInterface) {
  timer?.cancel()
  timer = $.clock.every(Math.max(1, config.pollMinutes) * 60_000, () => void refresh($))
}

async function turnOn($: EngineInterface) {
  await update($, isOn, () => true)
  startPolling($)
  await $.ui.open({ id: PANE, title: 'PR inbox', focus: true })
  await refresh($)
}

async function turnOff($: EngineInterface) {
  timer?.cancel()
  timer = null
  await update($, isOn, () => false)
  await $.ui.close({ id: PANE })
}

async function move($: EngineInterface, step: number) {
  const snap = await read($, snapshot)
  if (!snap) return
  const list = ordered(snap, await read($, tabAtom))
  const n = await read($, selected)
  const at = list.findIndex(pr => pr.number === n)
  const next = list[Math.min(list.length - 1, Math.max(0, at + step))]
  if (next) await update($, selected, () => next.number)
}

async function setTab($: EngineInterface, tab: Tab) {
  await update($, tabAtom, () => tab)
  await closePeek($)
  const snap = await read($, snapshot)
  const list = snap ? ordered(snap, tab) : []
  await update($, selected, n => (n !== null && list.some(pr => pr.number === n) ? n : (list[0]?.number ?? null)))
}

const noteId = (note: Note) => note.opener?.url ?? note.url

async function openPeek($: EngineInterface, pr: Pr, note: Note) {
  await update($, peekAtom, () => ({ number: pr.number, id: noteId(note) }))
  await update($, peekOffsetAtom, () => null)
  const snap = await read($, snapshot)
  const ref = refOf(pr, note)
  if (!snap || !note.path || !ref) return
  const key = `${ref}:${note.path}`
  if ((await read($, peekFileAtom))?.key === key) return

  await update($, peekFileAtom, () => ({ key }))
  try {
    const cwd = await read($, cwdAtom)
    const path = note.path.split('/').map(encodeURIComponent).join('/')
    const run = await $.process.run(
      ['gh', 'api', `repos/${snap.repo}/contents/${path}?ref=${ref}`, '-H', 'Accept: application/vnd.github.raw'],
      { ...(cwd ? { cwd } : {}), timeoutMs: 30_000 },
    )
    const file: PeekFile =
      run.exitCode === 0 && !run.isStdoutTruncated
        ? { key, text: run.stdout }
        : { key, error: run.isStdoutTruncated ? 'file too large to show' : run.stderr.trim() || 'could not fetch the file' }
    await update($, peekFileAtom, () => file)
  } catch (err) {
    await update($, peekFileAtom, () => ({ key, error: err instanceof Error ? err.message : String(err) }))
  }
}

// The file a thread is shown in: the head, or for an outdated thread the
// commit the comment was left on, where its line numbers still hold.
const refOf = (pr: Pr, note: Note) => (note.isOutdated ? note.opener?.commit : pr.head)

// The thread view scrolls its own window under a header that stays put.
async function scrollPeek($: EngineInterface, by: number) {
  const offset = Math.max(0, Math.min(peekLayout.max, peekLayout.offset + by))
  peekLayout = { ...peekLayout, offset }
  await update($, peekOffsetAtom, () => offset)
}

// Rows a text takes at a width, each line wrapping on its own.
const rowsOf = (text: string, width: number) =>
  text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(1, width))), 0)

// Past this the Code element stops drawing, so a huge file shows a window.
const WHOLE_FILE_LIMIT = 90_000

const closePeek = ($: EngineInterface) => update($, peekAtom, () => null)

// The lines a ```suggestion block proposes, or null when the comment has none.
export function suggestionOf(body: string) {
  const match = /```suggestion[^\n]*\n([\s\S]*?)```/.exec(body)
  if (!match) return null
  const text = (match[1] ?? '').replace(/\r/g, '').replace(/\n$/, '')

  return text === '' ? [] : text.split('\n')
}

// A thread's code as GitHub draws it: what comes before, the commented lines
// (as a diff when there is a suggestion), then what comes after.
export function peekParts(file: string, note: Note, context: number) {
  const lines = file.replace(/\r/g, '').replace(/\n$/, '').split('\n')
  const end = Math.max(1, Math.min(lines.length, note.line ?? 1))
  const start = Math.max(1, Math.min(end, note.startLine ?? end))
  const from = Math.max(1, start - context)
  const to = Math.min(lines.length, end + context)
  const proposed = note.opener ? suggestionOf(note.opener.body) : null
  const slice = (a: number, b: number) => lines.slice(a - 1, b).join('\n')
  const commented = lines.slice(start - 1, end)

  return {
    before: from < start ? { source: slice(from, start - 1), startLine: from } : null,
    target: { source: commented.join('\n'), startLine: start },
    diff: proposed
      ? [
          `@@ -${start},${commented.length} +${start},${proposed.length} @@`,
          ...commented.map(l => `-${l}`),
          ...proposed.map(l => `+${l}`),
        ].join('\n')
      : null,
    after: end < to ? { source: slice(end + 1, to), startLine: end + 1 } : null,
  }
}

async function cycleTab($: EngineInterface, step: number) {
  const tab = await read($, tabAtom)
  const i = TABS.findIndex(one => one.tab === tab)
  const next = TABS[(i + step + TABS.length) % TABS.length]
  if (next) await setTab($, next.tab)
}

async function current($: EngineInterface) {
  const snap = await read($, snapshot)
  const n = await read($, selected)

  return snap?.prs.find(pr => pr.number === n) ?? null
}

// The template's command when this session can run it, else null: a repo's
// /comment-pr only loads where its .claude/skills is (a worktree, or the
// container through its link to master/).
export function runnable(template: string, names: string[]) {
  const name = /^\/([\w-]+)/.exec(template)?.[1]

  return !name || names.includes(name) ? template : null
}

async function type($: EngineInterface, template: string) {
  const pr = await current($)
  if (!pr) return
  const text = runnable(template, (await $.command.list()).map(c => c.name))
  if (!text) {
    $.ui.toast(`PR inbox: ${template.split(' ')[0]} is not a command in this session`)

    return
  }
  await $.prompt.fill({ text: fill(text, pr), mode: 'replace' })
  $.ui.toast('In the prompt: Esc, then Enter to run it')
}

export const register: Register = (on, options) => {
  config = {
    pollMinutes: Number(options.pollMinutes ?? config.pollMinutes),
    reviewCommand: String(options.reviewCommand ?? config.reviewCommand),
    reReviewCommand: String(options.reReviewCommand ?? config.reReviewCommand),
    explainCommand: String(options.explainCommand ?? config.explainCommand),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prs',
      description: 'PR review inbox: /prs toggles it, /prs <absolute path> reads another checkout, /prs off stops polling',
    })
    const started = await next(e)
    await update($, cwdAtom, () => started.cwd)
    // A reload runs this again; an inbox that was on keeps polling.
    if (await read($, isOn)) startPolling($)

    return started
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'off') {
      await turnOff($)

      return { text: 'PR inbox off.' }
    }
    // An absolute path points the inbox at that checkout instead of the session's.
    if (arg.startsWith('/')) {
      await update($, cwdAtom, () => arg)
      await update($, snapshot, () => null)
      await update($, seen, () => [])
      if (await read($, isOn)) {
        await refresh($)

        return { text: `PR inbox now reads ${arg}.` }
      }
      await turnOn($)

      return { text: `PR inbox on, reading ${arg}.` }
    }
    if (!(await read($, isOn))) {
      await turnOn($)

      return { text: 'PR inbox on.' }
    }
    if (arg === 'refresh') {
      await refresh($)

      return { text: 'PR inbox refreshed.' }
    }
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: 'PR inbox', focus: true })

    return { text: isOpen ? 'PR inbox pane closed; still polling.' : 'PR inbox pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || !(await read($, isOn)) || !snap) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const count = (group: Group) => snap.prs.filter(pr => pr.group === group).length
    const threads = snap.prs
      .filter(pr => pr.group !== 'mine')
      .reduce((sum, pr) => sum + pr.threads.filter(t => t.isNew).length + pr.comments.length, 0)

    return (
      <Box>
        <Button
          key="inbox-open"
          plain
          dimColor
          onPress={() => $.ui.open({ id: PANE, title: 'PR inbox', focus: true })}
        >
          {`PR inbox · 🔍 ${count('new')} new · 🔁 ${count('changed')} changed · 💬 ${threads}`}
        </Button>
      </Box>
    )
  })

  // The wheel over an open thread moves its window, not the pane: the header
  // above the code stays where it is.
  on('ui.scroll', async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE || !(await read($, peekAtom))) return next(e)
    await scrollPeek($, e.by)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Link, Markdown, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const err = await read($, error)
    const loading = await read($, isLoading)
    const pick = await read($, selected)
    const tab = await read($, tabAtom)
    const columns = e.viewport?.columns ?? 64
    const now = await $.clock.now()

    // Not over an open thread: there o, j and k mean that thread's own keys.
    const isPeeking = (await read($, peekAtom)) !== null
    const picked = snap && tab !== 'help' && !isPeeking ? ordered(snap, tab).find(one => one.number === pick) : undefined

    const header = (
      <Box flexDirection="column">
        <Box columnGap={1}>
          <Text bold wrap="truncate">{snap ? snap.repo : ''}</Text>
          <Text dimColor>{snap ? '·' : ''}</Text>
          <Button key="key-f" hotkey="f" label={loading ? 'fetching…' : snap ? ago(now - snap.fetchedAt) : 'fetch'} plain dimColor onPress={() => void refresh($)} />
          {/* The keys for the selected PR, beside fetch rather than under it. */}
          {picked && (
            <Box columnGap={2} marginLeft={2}>
              <Button key="key-o" hotkey="o" label="open" plain onPress={() => void $.process.run(['open', picked.url])} />
              {/* You wrote it: nothing to explain to you, nothing to review. */}
              {picked.group !== 'mine' && (
                <Button key="key-e" hotkey="e" label="explain" plain onPress={() => void type($, config.explainCommand)} />
              )}
              <Button key="key-j" hotkey="j" label="↓" plain dimColor onPress={() => void move($, 1)} />
              <Button key="key-k" hotkey="k" label="↑" plain dimColor onPress={() => void move($, -1)} />
            </Box>
          )}
        </Box>
        {err && <Text color="error">{oneLine(err, columns * 3)}</Text>}
      </Box>
    )

    if (!snap) return header

    // A thread opened over the list: its code, the suggestion and the comments.
    const peek = await read($, peekAtom)
    const peekPr = peek ? snap.prs.find(one => one.number === peek.number) : undefined
    const peekNote = peek && peekPr ? [...peekPr.threads, ...peekPr.resolved].find(one => noteId(one) === peek.id) : undefined
    if (peekPr && peekNote) {
      const file = await read($, peekFileAtom)
      const range = peekNote.line ? `:${peekNote.startLine ? `${peekNote.startLine}-` : ''}${peekNote.line}` : ''
      const opener = peekNote.opener ?? { author: peekNote.author, body: peekNote.body, url: peekNote.url }
      const hasSuggestion = suggestionOf(opener.body) !== null
      const shown = (body: string) => body.replace(/```suggestion[\s\S]*?(```|$)/g, '_(suggestion above)_')
      const said = (key: string, author: string, body: string, isNew: boolean) => (
        <Box key={key} flexDirection="column" marginLeft={2} marginTop={1}>
          <Text>
            <Text color="claude">{isNew ? '● ' : '  '}</Text>
            <Text bold>{author}</Text>
          </Text>
          <Box backgroundColor={BUBBLE_BG} paddingX={1}>
            <Markdown text={shown(body)} />
          </Box>
        </Box>
      )
      const comments = [
        said('opener', opener.author, opener.body, peekNote.isNew && opener.url === peekNote.url),
        ...(opener.url !== peekNote.url ? [said('reply', peekNote.author, peekNote.body, peekNote.isNew)] : []),
      ]
      const commentRows = [opener.body, ...(opener.url !== peekNote.url ? [peekNote.body] : [])].reduce(
        (n, body) => n + 2 + rowsOf(shown(body), columns - 6),
        0,
      )
      const lineCount = (text: string) => text.split('\n').length
      const fileKey = `${refOf(peekPr, peekNote)}:${peekNote.path}`
      const fileText = file?.key === fileKey ? file.text : undefined
      const fileError = file?.key === fileKey ? file.error : undefined
      const context = (fileText?.length ?? 0) > WHOLE_FILE_LIMIT ? 30 : Number.MAX_SAFE_INTEGER
      const parts = fileText !== undefined ? peekParts(fileText, peekNote, context) : null

      let code: RenderNode
      // Rows above the thread and the thread's own, for centering and the end.
      let aboveRows = 0
      let threadRows = commentRows
      let totalRows = 0
      if (parts) {
        const notices = (peekNote.isOutdated ? 1 : 0) + (context !== Number.MAX_SAFE_INTEGER ? 1 : 0)
        aboveRows = notices + (parts.before ? lineCount(parts.before.source) : 0)
        threadRows += parts.diff ? lineCount(parts.diff) - 1 : lineCount(parts.target.source)
        totalRows = aboveRows + threadRows + (parts.after ? 1 + lineCount(parts.after.source) : 0)
        code = (
          <Box flexDirection="column">
            {peekNote.isOutdated && <Text color="warning">outdated: the file as it was when the comment was left</Text>}
            {context !== Number.MAX_SAFE_INTEGER && <Text dimColor>file too large to draw whole: 30 lines either side</Text>}
            {parts.before && <Code source={parts.before.source} startLine={parts.before.startLine} path={peekNote.path} wrap="truncate-end" />}
            <Box key="peek-thread" flexDirection="column">
              {parts.diff ? (
                <Code source={parts.diff} format="diff" path={peekNote.path} wrap="truncate-end" />
              ) : (
                <Code source={parts.target.source} startLine={parts.target.startLine} path={peekNote.path} wrap="truncate-end" />
              )}
              {comments}
            </Box>
            {parts.after && (
              <Box marginTop={1}>
                <Code source={parts.after.source} startLine={parts.after.startLine} path={peekNote.path} wrap="truncate-end" />
              </Box>
            )}
          </Box>
        )
      } else {
        // Outdated, or the file is not here yet: the hunk the reviewer saw.
        const proposed = suggestionOf(opener.body)
        totalRows = 1 + (peekNote.hunk ? lineCount(peekNote.hunk) - 1 : 0) + (proposed ? proposed.length : 0) + commentRows
        threadRows = totalRows
        code = (
          <Box flexDirection="column">
            {!fileError && <Text dimColor>fetching the file…</Text>}
            {fileError && <Text color="error">{oneLine(fileError, columns * 2)}</Text>}
            {peekNote.hunk && <Code source={peekNote.hunk} format="diff" path={peekNote.path} wrap="truncate-end" />}
            {hasSuggestion && (
              <Code
                source={(suggestionOf(opener.body) ?? []).join('\n')}
                path={peekNote.path}
                wrap="truncate-end"
              />
            )}
            {comments}
          </Box>
        )
      }

      // Four header rows and the position line stay; the rest is the window.
      const bodyRows = e.props.scroll.bodyRows
      const view = Math.max(3, bodyRows - 5)
      const max = Math.max(0, totalRows - view)
      const centered = threadRows >= view ? aboveRows - 2 : aboveRows - Math.floor((view - threadRows) / 2)
      const stored = await read($, peekOffsetAtom)
      const offset = Math.max(0, Math.min(max, stored ?? centered))
      peekLayout = { offset, max, view }
      const step = Math.max(1, Math.floor(view / 3))

      return (
        <Box flexDirection="column" height={e.props.placement === 'dock' ? bodyRows : undefined}>
          <Box columnGap={2}>
            <Button key="key-b" hotkey="b" label="← back" plain onPress={() => void closePeek($)} />
            <Button key="key-o" hotkey="o" label="open on GitHub" plain onPress={() => void $.process.run(['open', opener.url])} />
            <Button key="key-j" hotkey="j" label="↓" plain dimColor onPress={() => void scrollPeek($, step)} />
            <Button key="key-k" hotkey="k" label="↑" plain dimColor onPress={() => void scrollPeek($, -step)} />
          </Box>
          <Text wrap="truncate-start" bold>
            {`${peekNote.path}${range}`}
          </Text>
          <Text dimColor wrap="truncate">{`#${peekPr.number} ${peekPr.title}`}</Text>
          <Text dimColor>{'─'.repeat(Math.max(10, columns - 2))}</Text>
          <Box height={1}>
            {max > 0 && (
              <Text dimColor>
                {`${offset > 0 ? '↑ ' : '  '}rows ${offset + 1}–${Math.min(totalRows, offset + view)} of ${totalRows}${offset < max ? ' ↓' : ''}`}
              </Text>
            )}
          </Box>
          <Box height={view} overflow="hidden" flexDirection="column">
            <Box marginTop={-offset} flexDirection="column" flexShrink={0}>
              {code}
            </Box>
          </Box>
        </Box>
      )
    }

    // A rounded card, framed in the accent while it holds the selected PR.
    const card = (key: string, children: (RenderNode | false)[], isAccent = false) => (
      <Box
        key={key}
        flexDirection="column"
        marginTop={1}
        borderStyle="round"
        borderColor={isAccent ? 'claude' : FRAME}
        paddingX={1}
      >
        {children.filter(child => child !== false)}
      </Box>
    )

    // The tabs: a segmented switch in a rounded frame, as tool-log's.
    const tabs = (
      <Box columnGap={1} marginTop={1} alignItems="center">
        <Box alignSelf="flex-start" borderStyle="round" borderColor={FRAME} paddingX={1}>
          {TABS.map((one, i) => {
            const count = snap.prs.filter(pr => one.groups.includes(pr.group)).length
            const isActive = one.tab === tab

            return (
              <Box key={`tabbox-${one.tab}`}>
                {i > 0 && <Text color={FRAME}>{'  │  '}</Text>}
                <Button key={`tab-${one.tab}`} hotkey={String(i + 1)} plain onPress={() => setTab($, one.tab)}>
                  <Text bold={isActive} color={isActive ? 'claude' : undefined} dimColor={!isActive}>
                    {one.tab === 'help' ? one.label : `${one.label} (${count})`}
                  </Text>
                </Button>
              </Box>
            )
          })}
        </Box>
        <Box columnGap={1}>
          <Button key="key-h" hotkey="h" label="‹" plain dimColor onPress={() => void cycleTab($, -1)} />
          <Button key="key-l" hotkey="l" label="›" plain dimColor onPress={() => void cycleTab($, 1)} />
        </Box>
      </Box>
    )

    // Fixed-width columns for the comment count and the number, so every title
    // in the tab starts at the same column. 💬 is two cells wide.
    const freshOf = (pr: Pr) => pr.threads.filter(t => t.isNew).length + pr.comments.length
    const inView = ordered(snap, tab)
    const countWidth = Math.max(0, ...inView.map(pr => (freshOf(pr) ? String(freshOf(pr)).length : 0)))
    const numberWidth = Math.max(0, ...inView.map(pr => String(pr.number).length))
    const bubble = (n: number) => (countWidth === 0 ? '' : n ? `💬${String(n).padEnd(countWidth)} ` : ' '.repeat(countWidth + 3))

    // The author sits in a column of its own on the right, and
    // the title is cut to what is left: a Button wraps its text, whatever the
    // Text inside asks, so a wrapped title would run under the emoji column.
    const bodyColumns = (e.props.bodyColumns ?? columns) - CARD_INSET
    const authorWidth = Math.max(0, ...inView.map(pr => (pr.group === 'mine' ? 0 : pr.author.length + 2)))
    const fit = (text: string, width: number) => {
      const chars = [...text]

      return (chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join('')}…` : text).padEnd(width)
    }

    const row = (pr: Pr): RenderNode => {
      const isPicked = pr.number === pick
      const fresh = freshOf(pr)
      const isQuiet = pr.group === 'done'
      // Marker, emoji, bubble, number and draft before the title; its own tail
      // after it (a row without one gives the title that room), then two cells
      // to spare so the author stays off the edge.
      const lead = 2 + 3 + bubble(fresh).length + numberWidth + 2 + (pr.isDraft ? 6 : 0)
      const tail = pr.tail ? `  ${pr.tail}` : ''
      const titleWidth = Math.max(10, bodyColumns - lead - tail.length - authorWidth - 2)

      return (
        <Button key={`pr-${pr.number}`} plain onPress={() => update($, selected, () => pr.number)}>
          <Text wrap="truncate" dimColor={isQuiet}>
            <Text color="claude" bold>{isPicked ? '▸ ' : '  '}</Text>
            {`${pr.emoji} `}
            <Text>{bubble(fresh)}</Text>
            <Text dimColor>{`#${String(pr.number).padEnd(numberWidth)} `}</Text>
            {pr.isDraft && <Text dimColor italic>{'draft '}</Text>}
            <Text bold={isPicked} color={isPicked ? 'claude' : undefined}>{fit(pr.title, titleWidth)}</Text>
            {tail && <Text color={pr.tail === 'force-push' ? 'error' : 'warning'}>{tail}</Text>}
            {authorWidth > 0 && <Text dimColor>{pr.group === 'mine' ? '' : `  ${pr.author}`}</Text>}
          </Text>
        </Button>
      )
    }

    const inTab = GROUPS.filter(({ group }) => groupsOf(tab).includes(group))
    const sections = inTab.map(({ group, title }) => {
      const prs = inGroup(snap, group)
      if (prs.length === 0) return null

      return card(`group-${group}`, [
        inTab.length > 1 && <Text key="title" bold color="suggestion">{`${title.toUpperCase()} (${prs.length})`}</Text>,
        ...prs.map(row),
      ])
    })
    const isEmpty = ordered(snap, tab).length === 0

    const pr = ordered(snap, tab).find(one => one.number === pick)
    const notes = pr ? [...pr.threads, ...pr.comments] : []
    const resolved = pr?.resolved ?? []
    const showResolved = await read($, showResolvedAtom)

    // One heading per file, its threads under it by line: the path is read
    // once, not once per comment. Resolved threads draw quiet: no bubble.
    const byFile = (list: Note[], prefix: string, isResolved: boolean, owner: Pr): RenderNode[] =>
      [...new Set(list.map(note => note.path ?? ''))].map(path => (
        <Box
          key={`${prefix}file-${path}`}
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={FRAME}
          borderDimColor={isResolved}
          paddingX={1}
        >
          <Text wrap="truncate-end" dimColor={isResolved}>
            {path ? (
              <Text>
                <Text bold>{path.slice(path.lastIndexOf('/') + 1)}</Text>
                <Text dimColor>{`  ${path.slice(0, Math.max(0, path.lastIndexOf('/')))}`}</Text>
              </Text>
            ) : (
              <Text bold>Conversation</Text>
            )}
          </Text>
          {list.map((note, i) => {
            if ((note.path ?? '') !== path) return null
            // A thread opens over the list; a conversation comment has no code.
            const open = note.path ? () => void openPeek($, owner, note) : () => {}
            const hasSuggestion = note.opener ? suggestionOf(note.opener.body) !== null : false

            return (
              <Box key={`${prefix}note-${i}`} flexDirection="column" marginTop={1}>
                <Button key={`${prefix}note-${i}-head`} plain onPress={open}>
                  <Text wrap="truncate" dimColor={isResolved}>
                    {isResolved ? <Text color="success">{'✓ '}</Text> : <Text color="claude">{note.isNew ? '● ' : '  '}</Text>}
                    <Text bold={note.isNew} dimColor={!note.isNew}>{note.author}</Text>
                    {note.line && <Text dimColor>{`  :${note.line}`}</Text>}
                    {isResolved && <Text dimColor>{'  resolved'}</Text>}
                    {hasSuggestion && <Text color={isResolved ? undefined : 'success'} dimColor={isResolved}>{'  suggestion'}</Text>}
                    {note.path && <Text color="suggestion">{'  ›'}</Text>}
                  </Text>
                </Button>
                <Box
                  backgroundColor={isResolved ? undefined : BUBBLE_BG}
                  marginLeft={2}
                  marginRight={4}
                  paddingX={1}
                  alignSelf="flex-start"
                >
                  <Button key={`${prefix}note-${i}-body`} plain onPress={open}>
                    <Text dimColor={!note.isNew}>{oneLine(note.body, columns * 2)}</Text>
                  </Button>
                </Box>
              </Box>
            )
          })}
        </Box>
      ))
    // The selected PR's card, framed in the accent, then its threads by file.
    const detail = pr && (
      <Box flexDirection="column">
        {card(
          'detail',
          [
            <Text key="title" bold wrap="truncate">
              <Text dimColor>{`#${pr.number} `}</Text>
              {pr.title}
            </Text>,
            <Text key="stats">
              <Text dimColor>{`${pr.author} · `}</Text>
              <Text color="success">{`+${pr.additions}`}</Text>
              {' '}
              <Text color="error">{`−${pr.deletions}`}</Text>
              {pr.reviewedSha && <Text color="warning">{` · your review on ${pr.reviewedSha.slice(0, 7)}`}</Text>}
            </Text>,
            <Link key="url" href={pr.url} label={pr.url} />,
            // Reviewing your own PR would draft comments on it: no r there.
            pr.group !== 'mine' && (
              <Box key="actions" columnGap={2}>
                <Button
                  key="key-r"
                  hotkey="r"
                  label={pr.group === 'changed' ? 'review what changed' : 'review'}
                  plain
                  onPress={() => void type($, pr.group === 'changed' ? config.reReviewCommand : config.reviewCommand)}
                />
              </Box>
            ),
          ],
          true,
        )}
        <Box marginTop={1} columnGap={1}>
          <Text bold color="suggestion">{`THREADS (${notes.length} open`}</Text>
          {resolved.length > 0 && (
            <Button
              key="toggle-resolved"
              plain
              onPress={() => void update($, showResolvedAtom, isShown => !isShown)}
            >
              <Text color="suggestion" bold>{`· ${resolved.length} resolved ${showResolved ? '▾' : '▸'}`}</Text>
            </Button>
          )}
          <Text bold color="suggestion">)</Text>
        </Box>
        {notes.length === 0 ? <Text dimColor>No unresolved threads.</Text> : byFile(notes, '', false, pr)}
        {showResolved && resolved.length > 0 && (
          <Box flexDirection="column" marginTop={2}>
            <Text bold dimColor>{`RESOLVED (${resolved.length})`}</Text>
            {byFile(resolved, 'resolved-', true, pr)}
          </Box>
        )}
      </Box>
    )

    // The Help tab: each table a card of its own.
    const table = (title: string, rows: [string, string][], width: number) =>
      card(`help-${title}`, [
        <Text key="title" bold color="suggestion">{title.toUpperCase()}</Text>,
        ...rows.map(([k, what]) => (
          <Text key={`${title}-${k}`}>
            <Text color="claude">{k.padEnd(width)}</Text>
            {` ${what}`}
          </Text>
        )),
      ])

    if (tab === 'help') {
      return (
        <Box flexDirection="column">
          {header}
          {tabs}
          {table('Emoji', LEGEND, 2)}
          {card('help-comments', [
            <Text key="title" bold color="suggestion">COMMENTS</Text>,
            <Text key="bubble">{'💬N  unresolved threads and comments that need you'}</Text>,
            <Text key="dot">{'●    on someone else\'s PR: written after your latest review'}</Text>,
            <Text key="dot-mine">{'     on yours: the last word in the thread is not yours'}</Text>,
            <Text key="bots" dimColor>{'     bots are left out'}</Text>,
          ])}
          {table('Keys', KEYS, 11)}
          {table('Commands', COMMANDS, 21)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {tabs}
        {isEmpty && <Text dimColor>{tab === 'queue' ? 'Nothing waiting on you.' : 'Nothing here.'}</Text>}
        {sections}
        {detail}
      </Box>
    )
  })
}
