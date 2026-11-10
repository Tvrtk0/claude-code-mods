import type { EngineInterface, Register } from 'claude-code'

// Holds a Bash call that breaks one of the person's standing rules, with the reason as the
// tool's answer, so Claude stops and asks instead:
// - posting to GitHub (comments, reviews, PR create/edit/merge, API writes) or pushing,
//   unless his last typed message says to (or names comment numbers to post);
// - an em dash in what would be posted or committed;
// - a commit in a repo with i18n catalogs that changes en.json without all nine catalogs.
// It reads the command's text, so an alias or a script can slip past: a net, not a lock.

let lastAsk = ''

const POSTS = [
  /\bgh\s+(pr|issue)\s+(comment|review|create|edit|merge|close|reopen|ready)\b/,
  /\bgh\s+api\b(?=[^\n]*(\s-X\s*|\s--method[\s=]*)(POST|PATCH|PUT|DELETE))/i,
  /\bgh\s+api\b(?=[^\n]*\s(-f|-F|--field|--raw-field|--input)\s)/,
  /\bgh\s+release\s+(create|edit|delete)\b/,
  /\bgit\s+push\b/,
]
// His words for "go ahead and post / push", Croatian and English.
const SAID_SO = /\b(objavi\w*|po[sš]alji\w*|postaj\w*|posta\w*|post|komentiraj\w*|approv\w*|odobri\w*|pushaj\w*|push\w*|merg\w*|request changes|otvori pr|napravi pr|create (the )?pr|open (the )?pr|send it|go ahead)\b/i
// Picking drafted comments by number ("1 3 5", "2, 4 i 6") is his say-so for those.
const NUMBERS = /^\s*(\d+\s*(,|i|and)?\s*)+(sve|all)?\s*$/i

const CATALOGS = ['en', 'el', 'es', 'fr', 'hr', 'it', 'pt', 'pt-BR', 'tr']

async function stagedFiles($: EngineInterface, cmd: string): Promise<string[] | null> {
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(cmd)?.[1]?.replace(/^["']|["']$/g, '')
  const base = await $.session.cwd()
  const cwd = cd ? (cd.startsWith('/') ? cd : cd.startsWith('~') ? cd : `${base}/${cd}`) : base
  try {
    const all = /\bcommit\b[^\n]*\s-[a-zA-Z]*a/.test(cmd)
    const r = await $.process.run(['git', 'diff', '--name-only', ...(all ? ['HEAD'] : ['--cached'])], { cwd, timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : null
  } catch {
    return null
  }
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') lastAsk = e.text ?? ''
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = String((e as unknown as { command?: string }).command ?? '')
    // GraphQL goes through `gh api graphql -f query=…` for reads too: only a mutation posts.
    const graphql = /\bgh\s+api\s+graphql\b/.test(cmd)
    const posts = graphql ? /\bmutation\b/.test(cmd) : POSTS.some(re => re.test(cmd))

    if (posts && !(SAID_SO.test(lastAsk) || NUMBERS.test(lastAsk))) {
      return { deny: `Held by rule-guard: this posts to GitHub or pushes, and the person's last message does not say to. Show them what it would send and ask first. (${cmd.slice(0, 120)})` }
    }

    // What would be posted or committed: the command, and a --body-file / -F file it names.
    if (posts || /\bgit\s+commit\b/.test(cmd)) {
      let text = cmd
      const file = /(--body-file|--message-file|-F)\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd)?.[2]?.replace(/^["']|["']$/g, '')
      if (file && file !== '-') {
        try { text += String(await $.fs.read(file)) } catch {}
      }
      if (text.includes('—')) {
        return { deny: 'Held by rule-guard: the text has an em dash (—). The person bans them everywhere; rewrite it with a comma, colon, parentheses or a new sentence.' }
      }
    }

    // A commit touching the English catalog takes all nine with it.
    if (/\bgit\s+commit\b/.test(cmd)) {
      const files = await stagedFiles($, cmd)
      const msgs = (files ?? []).filter(f => /packages\/i18n\/src\/messages\/[\w-]+\.json$/.test(f))
      if (msgs.some(f => f.endsWith('/en.json'))) {
        const have = new Set(msgs.map(f => f.split('/').pop()!.replace('.json', '')))
        const missing = CATALOGS.filter(c => !have.has(c))
        if (missing.length) {
          return { deny: `Held by rule-guard: en.json changed without ${missing.map(c => `${c}.json`).join(', ')}. This repo has no translation pipeline: write those translations in this same commit.` }
        }
      }
    }
    return next(e)
  })
}
