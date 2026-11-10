// A pasted image's number in the session's image folder (`4` for 4.png).
export type ImageNumber = string

// A picture made ready to draw: its size in cells, and its half-block
// cells unless the terminal draws the picture itself.
export type PreparedImage = { columns: number; rows: number; cells?: string }

declare module 'claude-code' {
  interface PluginState {
    'readable-width': {
      // The images pasted with each prompt, by the prompt's text: their
      // numbers in the session's image folder.
      pasted: Record<string, ImageNumber[]>
      // The pictures opened in their bubbles, by path.
      openImages: string[]
      // Each picture made ready, by path.
      prepared: Record<string, PreparedImage>
    }
  }
}
