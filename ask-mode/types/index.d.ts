export type Level = 'off' | 'quick' | 'ask' | 'deep'

declare module 'claude-code' {
  interface PluginState {
    'ask-mode': {
      level: Level
    }
  }
}
