export type Snapshot = {
  context?: number
  contextTokens?: number
  contextWindow?: number
  costUsd?: number
  fiveHour?: number
  fiveHourResetsAt?: number
  sevenDayResetsAt?: number
  sevenDay?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meters': { snapshot: Snapshot | null }
  }
}
