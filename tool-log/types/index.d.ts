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
  // The run of tool calls it belongs to: calls with no text between them.
  run?: string
}

export type LogGroup = {
  id: string
  prompt: string
  startedAt: number
  entries: LogEntry[]
}

export type Tick = { frame: number; elapsedMs: number; now: number }

export type Tab = 'log' | 'files' | 'agents'

export type AgentRow = {
  id: string
  description: string
  type: string
  startedAt: number
  endedAt?: number
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  lastStep: string
  tools: number
}

declare module 'claude-code' {
  interface PluginState {
    'tool-log': {
      groups: LogGroup[]
      tick: Tick
      expanded: string[]
      isRepo: boolean
      focus: string | null
      tab: Tab
      agents: AgentRow[]
      seen: Partial<Record<Tab, string>>
      scrollTop: Partial<Record<Tab, number | null>>
    }
  }
}
