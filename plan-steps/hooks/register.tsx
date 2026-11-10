import type { EngineInterface, Register } from 'claude-code'

// Claude keeps the request's plan in plain words (steps) and closes finished work with a
// wrap-up; both go to ~/.claude/state/plan/<Herdr terminal>.json, which Herdr's steps pane
// draws. Outside Herdr (no HC_TERMINAL_ID) nothing is registered.

let terminal: string | null = null
let home: string | null = null
let state: Record<string, unknown> = {}

const BRIEF = `Herdr shows the person a progress panel for this request.
- If the request needs more than about three tool calls, call mcp__plan-steps__steps before the first other tool with 2 to 8 short steps in the language the person writes in. Name outcomes, not tools ("Find where the header is drawn", not "Run grep"). Exactly one step is "active".
- Call it again whenever a step ends: mark it "done" (or "failed") with "result", one short line of what it found or changed, and mark the next one "active". Rewrite the list if the plan changes.
- When work that had steps is finished, mark the last step done, then call mcp__plan-steps__wrap_up once, just before your final reply: 1 to 5 short lines of what was done (in the person's language), whether it was tested, and anything the person must do or decide.
- A plain answer that leaves the person something to decide or do (a choice, a check, a step only they can take): call mcp__plan-steps__wrap_up anyway, just before the reply, with "done" as one line of the answer, "tested" "n/a", and "for_you" saying what is theirs. No steps needed.
- In wrap_up, "next" holds 1 to 3 likely next steps the person may want, most likely first: short, imperative, in their language and words ("Commit and push", "Test it in the app"). Never start one on your own. An option is text the person will send as their next prompt: something you can do for them, or, for a step only they can take in the prompt, the exact command itself ("/reload-plugins"), never a sentence asking you to do what you cannot.
- A reply of just a number (or "2", "ajd 2", "nastavi s 2") picks that option from your last wrap_up's "next".
- For a plain answer with nothing left for the person, call neither.`

async function save($: EngineInterface, patch: Record<string, unknown>) {
  state = { ...state, ...patch }
  await $.fs.write(`${home}/.claude/state/plan/${terminal}.json`, JSON.stringify(state))
}

const STEP = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'The step as an outcome, a few words' },
    status: { type: 'string', enum: ['pending', 'active', 'done', 'failed'] },
    result: { type: 'string', description: 'For a done or failed step: one short line of what it found or changed' },
  },
  required: ['title', 'status'],
}

const ours = (tool: unknown) => typeof tool === 'string' && tool.startsWith('mcp__plan-steps__')

export const register: Register = on => {
  // The plan and the wrap-up are for Herdr's pane: the terminal draws neither the call nor
  // its result, nor a group made only of them.
  for (const component of ['ToolUse', 'ToolResult'] as const) {
    on('ui.render', { component }, ($, e, next) => {
      if (!ours((e.props as { tool?: unknown }).tool)) return next(e)
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
  }
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const calls = (e.props as { calls?: ReadonlyArray<{ tool?: unknown }> }).calls ?? []
    if (!calls.length || !calls.every(c => ours(c.tool))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      terminal = (await $.env.get('HC_TERMINAL_ID')) ?? null
      home = (await $.env.get('HOME')) ?? null
    } catch {}
    if (!terminal || !home) return started
    // A reload keeps what Herdr shows: the plan file is where the state lives between loads.
    try { state = JSON.parse(await $.fs.read(`${home}/.claude/state/plan/${terminal}.json`) as unknown as string) ?? {} } catch { state = {} }
    await $.tool.register({
      name: 'steps',
      description: 'Shows the person the plan of the current request and where you are in it. Send the whole list every time.',
      inputSchema: { type: 'object', properties: { steps: { type: 'array', items: STEP, minItems: 1, maxItems: 10 } }, required: ['steps'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'wrap_up',
      description: 'Shows the person a summary card of the finished work. Call once, just before the final reply.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: 'What was done, one short line each' },
          tested: { type: 'string', enum: ['yes', 'no', 'failed', 'n/a'], description: 'Whether the result was verified (tests, a screenshot, a run)' },
          tested_how: { type: 'string', description: 'How it was verified, a few words' },
          for_you: { type: 'string', description: 'What the person must do or decide next, if anything' },
          next: { type: 'array', items: { type: 'string' }, maxItems: 3, description: '1 to 3 likely next steps, most likely first: short, imperative, in the person\'s language' },
        },
        required: ['done', 'tested'],
      },
      isDeferred: false,
    })
    return started
  })

  // The "next:" list is drawn by ask-mode, which owns the band above the prompt, from the plan
  // file this mod writes (wrap.next): one mod laying out the band keeps its buttons in place.

  on('prompt.submit', async ($, e, next) => {
    if (!terminal) return next(e)
    // A new request: the last plan with its wrap-up becomes the previous one, which Herdr
    // shows folded to a line; a request without a plan keeps the one before it.
    // A message sent mid-turn submits too: only a finished plan (wrapped up) moves aside.
    // A wrap-up without a plan (a plain answer that left you a decision) does not become the
    // previous request: it shows for its own answer and goes when the next one starts.
    const hadSteps = Array.isArray(state.steps) && (state.steps as unknown[]).length > 0
    if (state.wrap && hadSteps) state = { prev: { steps: state.steps, wrap: state.wrap, at: state.wrapAt ?? state.stepsAt } }
    else if (state.wrap) state = state.prev ? { prev: state.prev } : {}
    state = { ...state, askedAt: Date.now() }
    try { await $.fs.write(`${home}/.claude/state/plan/${terminal}.json`, JSON.stringify(state)) } catch {}
    return next({ ...e, context: [...(e.context ?? []), BRIEF] })
  })

  on('tool.call', { tool: 'mcp__plan-steps__steps' }, async ($, e) => {
    const input = e as unknown as { steps?: unknown[] }
    await save($, { steps: input.steps ?? [], stepsAt: Date.now() })
    return { result: 'Shown.' }
  })

  on('tool.call', { tool: 'mcp__plan-steps__wrap_up' }, async ($, e) => {
    const { done, tested, tested_how, for_you, next } = e as unknown as Record<string, unknown>
    // Finished work leaves no step hanging: an active or pending one counts as done.
    // Only this request's plan: a wrap-up for a plain answer has none.
    const current = (state.stepsAt as number ?? 0) >= (state.askedAt as number ?? 0)
    const steps = ((current ? state.steps as Array<Record<string, unknown>> | undefined : undefined) ?? []).map(s =>
      s.status === 'active' || s.status === 'pending' ? { ...s, status: 'done' } : s)
    const options = Array.isArray(next) ? (next as unknown[]).map(String).map(x => x.trim()).filter(Boolean).slice(0, 3) : []
    await save($, { steps, wrap: { done, tested, testedHow: tested_how, forYou: for_you, next: options }, wrapAt: Date.now(), nextHidden: false })
    return { result: 'Shown.' }
  })
}
