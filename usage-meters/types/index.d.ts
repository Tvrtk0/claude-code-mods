export type Snapshot = {
  context?: number
  fiveHour?: number
  sevenDay?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meters': { snapshot: Snapshot | null }
  }
}
