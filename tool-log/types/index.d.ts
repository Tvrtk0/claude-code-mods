export type LogEntry = {
  id: string
  tool: string
  label: string
  command?: string
  activity: string
  path?: string
  patch?: string
  added?: number
  removed?: number
  status: 'running' | 'ok' | 'error'
}

export type LogGroup = {
  id: string
  prompt: string
  startedAt: number
  entries: LogEntry[]
}

export type Tick = { frame: number; elapsedMs: number }

declare module 'claude-code' {
  interface PluginState {
    'tool-log': { groups: LogGroup[]; tick: Tick; expanded: string[]; isRepo: boolean }
  }
}
