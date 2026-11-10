import type { EngineInterface, Register } from 'claude-code'

// /slim: a compaction of our own that summarizes nothing. Messages older than the last few
// lose their pictures (a screenshot a tool read, an image you pasted) and say how many went;
// every word and tool call stays as it was. The files stay on disk, so Claude can read one
// again when it needs it. When the context fills past 75% with old pictures in it, a toast
// says /slim would help.

const SLIM = '__image_slim__'
const KEEP = 6
let hinted = 0

type Block = { type: string; [k: string]: unknown }
type ApiMsg = { role: string; content: Block[] }

// Which old messages carry pictures: tool results by their tool_use_id, your own messages
// by their text (the API form shows the images; the rows a compaction gets do not).
async function pictures($: EngineInterface) {
  const api = (await $.session.messages({ as: 'api' })) as unknown as ApiMsg[]
  const byTool = new Map<string, number>()
  const byText = new Map<string, number>()
  for (const m of api) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    let own = 0
    for (const b of m.content) {
      if (b.type === 'image') own++
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        const n = (b.content as Block[]).filter(x => x.type === 'image').length
        if (n) byTool.set(String(b.tool_use_id), n)
      }
    }
    if (own) {
      const text = m.content.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n').trim()
      byText.set(text, own)
    }
  }
  return { byTool, byText }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'slim', description: 'Drop the pictures from older messages, keep every word (wins back context)' })
    return started
  })

  // The command answers at once and compacts just after: a compaction asked for from inside
  // the command's own run is refused (it counts as a turn running), which left /slim
  // unanswered.
  on('command.run', { command: 'slim' }, async ($) => {
    void (async () => {
      await $.clock.sleep(400)
      try {
        const r = await $.session.compact({ instructions: SLIM })
        if ('skip' in r && r.skip) { $.ui.toast(`/slim: ${r.skip}`); return }
        $.ui.toast('/slim: older pictures removed, every message kept')
      } catch (err) {
        $.ui.toast(`/slim failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
      }
    })()
    return { text: 'Slimming: dropping the pictures from older messages…' }
  })

  on('session.compact', async ($, e, next) => {
    if (e.instructions !== SLIM || e.agentId) return next(e)
    const { byTool, byText } = await pictures($)
    const rows = e.messages
    let dropped = 0
    const out = rows.map((m, i) => {
      if (i >= rows.length - KEEP || m.role !== 'user') return m
      const fromTools = (m.toolResults ?? []).reduce((n, r) => n + (byTool.get(String(r.tool_use_id)) ?? 0), 0)
      const own = !(m.toolResults ?? []).length ? byText.get((m.text ?? '').trim()) ?? 0 : 0
      const n = fromTools + own
      if (!n) return m
      dropped += n
      // Without its handle the row is built from its role, text and tool blocks alone:
      // the pictures do not come with it.
      const { handle: _h, ...rest } = m as typeof m & { handle?: string }
      return { ...rest, text: `${m.text ? `${m.text}\n` : ''}[${n} picture${n > 1 ? 's' : ''} removed by /slim; the file is still on disk]` }
    })
    if (!dropped) return { skip: 'No pictures in the older messages: nothing to slim.' }
    return { messages: out }
  })

  // A hint when the context is filling and old pictures sit in it.
  on('session.measure', async ($, e, next) => {
    const done = await next(e)
    const ctx = e.context as unknown as { percent?: number; tokens?: number; window?: number }
    const pct = ctx?.percent ?? (ctx?.tokens && ctx?.window ? (100 * ctx.tokens) / ctx.window : 0)
    if (pct >= 75 && Date.now() - hinted > 15 * 60_000) {
      hinted = Date.now()
      try {
        const { byTool, byText } = await pictures($)
        const n = [...byTool.values(), ...byText.values()].reduce((a, b) => a + b, 0)
        if (n >= 3) $.ui.toast(`Context ${Math.round(pct)}% with ${n} pictures in it: /slim drops the old ones and keeps every word`)
      } catch {}
    }
    return done
  })
}
