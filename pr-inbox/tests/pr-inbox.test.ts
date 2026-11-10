import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const ENGINE: RenderElement = { type: 'Box', props: {}, children: [] }
const ME = 'me'
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const NOW = Date.parse('2026-10-13T12:00:00Z')

const review = (login: string, state: string, oid: string) => ({
  author: { login },
  state,
  submittedAt: '2026-10-10T09:00:00Z',
  commit: { oid },
})

const pr = (number: number, author: string, reviews: object[], extra: object = {}) => ({
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  isDraft: false,
  createdAt: '2026-10-12T09:00:00Z',
  headRefOid: HEAD,
  additions: 10,
  deletions: 2,
  mergeable: 'MERGEABLE',
  author: { login: author },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  reviews: { nodes: reviews },
  reviewThreads: { nodes: [] },
  comments: { nodes: [] },
  ...extra,
})

const GRAPHQL = {
  data: {
    viewer: { login: ME },
    repository: {
      pullRequests: {
        nodes: [
          pr(1, 'ana', []),
          pr(2, 'ana', [review(ME, 'APPROVED', OLD)], {
            comments: {
              nodes: [{ author: { __typename: 'Bot', login: 'github-actions' }, body: '<h2>Coverage</h2>', createdAt: '2026-10-11T10:00:00Z', url: 'u' }],
            },
            reviewThreads: {
              nodes: [
                {
                  isResolved: false,
                  isOutdated: false,
                  path: 'src/a.ts',
                  line: 4,
                  originalLine: 4,
                  startLine: null,
                  originalStartLine: null,
                  first: {
                    nodes: [
                      {
                        author: { login: 'bo' },
                        body: 'Off by one?\n```suggestion\n  return n + 1\n```',
                        createdAt: '2026-10-09T09:00:00Z',
                        url: 'thread-1',
                        diffHunk: '@@ -1,4 +1,4 @@\n a\n b\n c\n-  return n\n+  return n',
                      },
                    ],
                  },
                  last: { nodes: [{ author: { login: 'ana' }, body: 'Fixed, moved it to the hook', createdAt: '2026-10-11T09:00:00Z', url: 'reply-1' }] },
                },
                {
                  isResolved: true,
                  isOutdated: false,
                  path: 'src/b.ts',
                  line: 9,
                  originalLine: 9,
                  startLine: null,
                  originalStartLine: null,
                  first: { nodes: [{ author: { login: 'bo' }, body: 'Rename this?', createdAt: '2026-10-11T09:00:00Z', url: 'thread-2', diffHunk: '' }] },
                  last: { nodes: [{ author: { login: 'bo' }, body: 'Rename this?', createdAt: '2026-10-11T09:00:00Z', url: 'thread-2' }] },
                },
              ],
            },
          }),
          pr(3, 'ana', [review(ME, 'APPROVED', HEAD)]),
          pr(4, ME, [review('ana', 'APPROVED', HEAD)]),
          pr(5, 'ana', [], { createdAt: '2026-10-12T10:00:00Z', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }),
        ],
      },
    },
  },
}

function gh(on: Parameters<TestBody>[1], runs: string[][]) {
  on('clock.now', () => ({ value: NOW }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const [, cmd, path] = e.argv
    let stdout = ''
    if (cmd === 'repo') stdout = 'acme/app\n'
    else if (path === 'graphql') stdout = JSON.stringify(GRAPHQL)
    else if (path?.startsWith('repos/acme/app/compare/')) stdout = 'ahead\t3\n'
    else if (path?.startsWith('repos/acme/app/contents/src/a.ts')) stdout = FILE

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
}

const FILE = ['function f(n) {', '  const a = 1', '  const b = 2', '  return n', '}', ''].join('\n')

const PANE = { title: 'PR inbox', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } } as never

test('/prs groups the queue by what it asks of you', async ($, on) => {
  const runs: string[][] = []
  on('ui.render', () => ENGINE)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  gh(on, runs)

  await $.command.run({ command: 'prs', args: '' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'pr-inbox',
      surface,
      component: 'Pane',
      requestId: 'pr-inbox',
      props: PANE,
      viewport: { columns: 70, rows: 60 },
    } as never)

    expect(await ui.find({ text: /^Queue \(3\)$/ })).toBeDefined()
    expect(await ui.find({ text: /^Mine \(1\)$/ })).toBeDefined()
    expect(await ui.find({ text: /^Reviewed \(1\)$/ })).toBeDefined()
    expect(await ui.find({ text: /NOT REVIEWED YET \(2\)/ })).toBeDefined()
    expect(await ui.find({ text: /CHANGED SINCE YOUR REVIEW \(1\)/ })).toBeDefined()
        expect(await ui.find({ text: /\+3 commits/ })).toBeDefined()
    // The thread counts, the bot's coverage report does not.
    expect(await ui.find({ text: /🔁 💬1 #2 Change 2/ })).toBeDefined()
    expect(await ui.find({ text: /❌ +#5/ })).toBeDefined()
    expect(await ui.find({ text: /✅ +#4/ })).toBeUndefined()

    await ui.press({ key: 'tab-mine' })
    expect(await ui.find({ text: /✅ +#4/ })).toBeDefined()
    expect(await ui.find({ text: /#1 Change 1/ })).toBeUndefined()
    await ui.press({ key: 'tab-help' })
    expect(await ui.find({ text: /merge conflict/ })).toBeDefined()
    expect(await ui.find({ text: /#1 Change 1/ })).toBeUndefined()
    expect(await ui.find({ key: 'key-j' })).toBeUndefined()
    await ui.press({ key: 'tab-queue' })
    expect(await ui.find({ key: 'key-j' })).toBeDefined()
    await ui.unmount()
  }

  // The compare call ran for the moved PR alone (the mocked timer refreshes more than once).
  const compares = new Set(runs.filter(argv => argv[2]?.includes('/compare/')).map(argv => argv[2]))
  expect([...compares]).toEqual([`repos/acme/app/compare/${OLD}...${HEAD}`])
})

test('r types the re-review command for a PR that moved', async ($, on) => {
  const filled: string[] = []
  on('ui.render', () => ENGINE)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true } as never
  })
  on('command.list', () =>
    ({ value: ['comment-pr', 'read-pr'].map(name => ({ name, description: '', source: 'user' })) }) as never,
  )
  gh(on, [])

  await $.command.run({ command: 'prs', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'pr-inbox',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pr-inbox',
    props: PANE,
    viewport: { columns: 70, rows: 60 },
  } as never)

  // Not reviewed yet goes newest opened first: #5, though fetched after #1,
  // is selected first; j moves to #1, then to #2.
  await ui.press({ key: 'key-j' })
  await ui.press({ key: 'key-j' })
  await ui.press({ key: 'key-r' })
  expect(filled).toEqual(['/comment-pr 2 (review only what arrived after bbbbbbb)'])

  await ui.press({ key: 'key-k' })
  await ui.press({ key: 'key-r' })
  expect(filled[1]).toBe('/comment-pr 1')
})

test('stays silent until /prs', async ($, on) => {
  on('ui.render', () => ENGINE)
  const ui = await $.ui.mount({
    plugin: 'pr-inbox',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {} as never,
    viewport: { columns: 100, rows: 40 },
  })

  expect(await ui.drawn()).toMatchObject(ENGINE)
})

test('a thread opens its code over the list, with the suggestion as a diff', async ($, on) => {
  const runs: string[][] = []
  on('ui.render', () => ENGINE)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  gh(on, runs)

  await $.command.run({ command: 'prs', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'pr-inbox',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pr-inbox',
    props: PANE,
    viewport: { columns: 90, rows: 60 },
  } as never)

  // #1, #5, then the moved #2, whose thread carries the suggestion.
  await ui.press({ key: 'pr-2' })
  expect(await ui.find({ text: /suggestion/ })).toBeDefined()

  // The resolved thread is counted nowhere and drawn only on request.
  expect(await ui.find({ text: /Rename this\?/ })).toBeUndefined()
  expect(await ui.find({ text: /1 resolved ▸/ })).toBeDefined()
  await ui.press({ key: 'toggle-resolved' })
  expect(await ui.find({ text: /Rename this\?/ })).toBeDefined()
  expect(await ui.find({ text: /RESOLVED \(1\)/ })).toBeDefined()
  await ui.press({ key: 'toggle-resolved' })
  await ui.press({ key: 'note-0-head' })

  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('src/a.ts:4')
  expect(drawn).toContain('@@ -4,1 +4,1 @@\\n-  return n\\n+  return n + 1')
  expect(drawn).toContain('"startLine":1')
  expect(drawn).toContain('Off by one?')
  expect(drawn).toContain('Fixed, moved it to the hook')
  expect(runs.some(argv => argv[2] === `repos/acme/app/contents/src/a.ts?ref=${HEAD}`)).toBe(true)

  await ui.press({ key: 'key-b' })
  expect(await ui.find({ text: /Change 2/ })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain('@@ -4,1')
})
