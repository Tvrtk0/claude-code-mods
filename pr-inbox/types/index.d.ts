// new: someone else's, no review from you. changed: you reviewed it, then the
// head moved. done: your latest review sits on the head. mine: you wrote it.
export type Group = 'new' | 'changed' | 'done' | 'mine'

export type Tab = 'queue' | 'mine' | 'done' | 'help'

export type Note = {
  author: string
  body: string
  url: string
  at: string
  // A thread's path and line; a conversation comment has neither.
  path?: string
  line?: number
  // Written by someone else after your latest review on this PR.
  isNew: boolean
  // A thread only. The first comment, which holds the suggestion when there
  // is one; the hunk the reviewer saw; the first line of a multi-line range.
  // `commit` is where the comment was left: the file an outdated thread shows.
  opener?: { author: string; body: string; url: string; commit?: string }
  hunk?: string
  startLine?: number
  // The code under the thread changed since; line and startLine are then the
  // original ones and only the hunk shows what was commented on.
  isOutdated?: boolean
}

export type Peek = { number: number; id: string }

export type PeekFile = { key: string; text?: string; error?: string }

export type Pr = {
  number: number
  title: string
  url: string
  author: string
  isDraft: boolean
  createdAt: string
  head: string
  additions: number
  deletions: number
  group: Group
  emoji: string
  // What changed since your review: "+3 commits" or "force-push".
  tail?: string
  // The commit your latest review sits on.
  reviewedSha?: string
  threads: Note[]
  // Threads someone marked resolved: shown on request, dimmed, never counted.
  resolved: Note[]
  comments: Note[]
}

export type Snapshot = {
  repo: string
  login: string
  prs: Pr[]
  fetchedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'pr-inbox': {
      isOn: boolean
      tab: Tab
      // The thread opened over the list, and the file it sits in at the head.
      peek: Peek | null
      peekFile: PeekFile | null
      // The first row of the thread's code in view; null centers the thread.
      peekOffset: number | null
      // Whether a PR's resolved threads are listed under its open ones.
      showResolved: boolean
      cwd: string
      snapshot: Snapshot | null
      selected: number | null
      error: string | null
      isLoading: boolean
      // `<n>@<head>` of every PR already announced, so a toast fires once.
      seen: string[]
    }
  }
}
