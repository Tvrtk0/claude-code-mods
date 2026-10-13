export type TurnRecord = {
  durationMs: number
  endedAt: number
  model?: string
  tools: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'turn-details': {
      turns: Record<string, TurnRecord>
      expanded: string[]
    }
  }
}
