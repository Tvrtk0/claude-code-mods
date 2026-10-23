// What ask mode lets through: tools that only read, Bash commands on a
// read-only list, and MCP tools whose name reads. Everything else is refused,
// an unknown tool or command included.

import type { Level } from '../types'


const READ_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
  'Agent',
  'Task',
  'TaskOutput',
  'TaskStop',
  'AskUserQuestion',
  'Skill',
  'SendMessage',
  'ListAgents',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
  'CronList',
  'EnterPlanMode',
  'ExitPlanMode',
  'ReportFindings',
])

// Tools that read with some actions and write with others.
const READ_ACTIONS: Record<string, Set<string>> = {
  Artifact: new Set(['read', 'list', 'quickstart']),
  ArtifactData: new Set(['get', 'list', 'query']),
  ArtifactComments: new Set(['list', 'read', 'get']),
}

const MCP_READ = new Set([
  'get', 'list', 'search', 'read', 'query', 'fetch', 'find', 'view', 'describe',
  'whoami', 'guide', 'lookup', 'check', 'show', 'inspect', 'count', 'preview',
])

const MCP_WRITE = new Set([
  'send', 'create', 'update', 'delete', 'remove', 'post', 'reply', 'forward',
  'trash', 'untrash', 'label', 'unlabel', 'mark', 'unmark', 'apply', 'upload',
  'share', 'add', 'set', 'schedule', 'respond', 'use', 'generate', 'export',
  'copy', 'move', 'rename', 'edit', 'write', 'run', 'cancel', 'complete',
  'authenticate', 'download', 'batch', 'submit', 'publish', 'merge', 'close',
])

// The first verb in an MCP tool's own name decides: `slack_read_channel`
// reads, `slack_send_message` writes, a name with no known verb is refused.
function mcpVerdict(tool: string): string | undefined {
  const name = tool.split('__').pop() ?? tool
  const words = name.split(/[_\-]|(?<=[a-z])(?=[A-Z])/).map(w => w.toLowerCase())
  const verb = words.find(w => MCP_READ.has(w) || MCP_WRITE.has(w))

  return verb !== undefined && MCP_READ.has(verb) ? undefined : `${name} may change something`
}

// Commands that only read, whatever their arguments.
const READ_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'fd',
  'tree', 'pwd', 'echo', 'printf', 'which', 'type', 'whereis', 'file', 'stat',
  'du', 'df', 'date', 'whoami', 'id', 'uname', 'hostname', 'printenv', 'diff',
  'cmp', 'comm', 'uniq', 'cut', 'tr', 'column', 'nl', 'basename', 'dirname',
  'realpath', 'readlink', 'jq', 'yq', 'cd', 'true', 'false', 'test', '[', 'bat',
  'strings', 'hexdump', 'xxd', 'od', 'md5', 'shasum', 'sha256sum', 'lsof', 'ps',
  'sleep', 'tldr', 'cal',
])

const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree',
  'ls-remote', 'grep', 'shortlog', 'describe', 'cat-file', 'merge-base',
  'for-each-ref', 'name-rev', 'rev-list', 'count-objects', 'whatchanged',
  'show-ref', 'show-branch', 'cherry', 'range-diff', 'check-ignore', 'var',
  'help', 'version',
])

const GH_READ: Record<string, Set<string>> = {
  pr: new Set(['view', 'list', 'diff', 'checks', 'status']),
  issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view', 'list']),
  run: new Set(['view', 'list']),
  release: new Set(['view', 'list']),
  workflow: new Set(['view', 'list']),
  label: new Set(['list']),
  auth: new Set(['status']),
  search: new Set(['code', 'commits', 'issues', 'prs', 'repos']),
}

const PACKAGE_READ: Record<string, Set<string>> = {
  npm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'why', 'explain', 'search', 'help']),
  pnpm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'why']),
  yarn: new Set(['list', 'info', 'why', 'outdated']),
}

// Splits a command line into its simple commands, quotes respected: on
// `&&`, `||`, `;`, `|`, `&` and newlines. Each comes back as its words, the
// quotes taken off.
function commandsOf(line: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null

  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }

  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (quote !== null) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      hasWord = true
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      hasWord = true
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      endCommand()
    } else {
      word += c
      hasWord = true
    }
  }
  endCommand()

  return commands
}

const flags = (args: string[]) => args.filter(a => a.startsWith('-'))

function gitVerdict(args: string[]): string | undefined {
  let i = 0
  // Global options before the subcommand.
  while (i < args.length && (args[i] as string).startsWith('-')) {
    const a = args[i] as string
    i += a === '-C' || a === '-c' ? 2 : 1
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  const no = `git ${sub ?? ''} may change the repository`

  if (sub === undefined) return undefined
  if (GIT_READ.has(sub)) return sub === 'diff' && rest.includes('--output') ? no : undefined

  switch (sub) {
    case 'branch': {
      const isList = rest.some(a => ['-l', '--list', '-a', '-r', '-v', '-vv', '--all', '--remotes', '--contains', '--merged', '--no-merged', '--show-current'].includes(a))
      const isChange = rest.some(a => /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/.test(a))
      const names = rest.filter(a => !a.startsWith('-'))

      return !isChange && (names.length === 0 || isList) ? undefined : no
    }
    case 'tag': {
      const isChange = rest.some(a => /^-(d|a|s|f|m|u)$|^--(delete|annotate|sign|force)/.test(a))
      const names = rest.filter(a => !a.startsWith('-'))
      const isList = rest.some(a => a === '-l' || a === '--list')

      return !isChange && (names.length === 0 || isList) ? undefined : no
    }
    case 'remote':
      return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url' ? undefined : no
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show' ? undefined : no
    case 'worktree':
      return rest[0] === 'list' ? undefined : no
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show' || flags(rest).length === rest.length ? undefined : no
    case 'config':
      return rest.some(a => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a)) ? undefined : no
    default:
      return no
  }
}

function ghVerdict(args: string[]): string | undefined {
  const [group, action] = args
  const no = `gh ${group ?? ''} ${action ?? ''} may change something`.replace(/\s+/g, ' ').trim()

  if (group === 'api') {
    const rest = args.slice(1)
    const method = rest.findIndex(a => a === '-X' || a === '--method')
    const isGet = method === -1 || (rest[method + 1] ?? '').toUpperCase() === 'GET'
    const hasBody = rest.some(a => /^(-f|-F|--field|--raw-field|--input)$/.test(a) || /^--(field|raw-field|input)=/.test(a))

    return isGet && !hasBody ? undefined : no
  }

  return group !== undefined && action !== undefined && GH_READ[group]?.has(action) ? undefined : no
}

function commandVerdict(words: string[]): string | undefined {
  let i = 0
  // Environment assignments and wrappers that only run what follows.
  while (i < words.length) {
    const w = words[i] as string
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i += 1
    else if (w === 'rtk' && words[i + 1] === 'proxy') i += 2
    else if (w === 'rtk' || w === 'time' || w === 'command') i += 1
    else break
  }
  const rest = words.slice(i)
  const name = (rest[0] ?? '').split('/').pop() ?? ''
  const args = rest.slice(1)

  if (name === '') return undefined
  if (args.length === 1 && args[0] === '--version') return undefined
  if (READ_COMMANDS.has(name)) return undefined

  switch (name) {
    case 'find':
      return args.some(a => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))
        ? 'find with -delete or -exec may change files'
        : undefined
    case 'sort':
      return args.some(a => a === '-o' || a.startsWith('--output')) ? 'sort -o writes a file' : undefined
    case 'sed':
      return args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) ? 'sed -i edits files in place' : undefined
    case 'awk':
      return args.some(a => /system\s*\(|print\s*>|\|\s*"/.test(a)) ? 'awk may run commands or write files' : undefined
    case 'git':
      return gitVerdict(args)
    case 'gh':
      return ghVerdict(args)
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return args[0] !== undefined && PACKAGE_READ[name]?.has(args[0]) ? undefined : `${name} ${args[0] ?? ''} may change the project`.trim()
    case 'defaults':
      return args[0] === 'read' ? undefined : 'defaults may change settings'
    case 'env': {
      let j = 0
      while (j < args.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[j] as string) || (args[j] as string).startsWith('-'))) j += 1
      return commandVerdict(args.slice(j))
    }
    case 'xargs': {
      let j = 0
      while (j < args.length && (args[j] as string).startsWith('-')) {
        j += /^-[nILPdEs]$/.test(args[j] as string) ? 2 : 1
      }
      return commandVerdict(args.slice(j))
    }
    default:
      return `${name} is not on the read-only list`
  }
}

// Undefined when the command line only reads; else why it may not run.
export function bashVerdict(command: string): string | undefined {
  if (/\$\(|`|<\(|>\(/.test(command)) return 'a command substitution may run anything'

  // Redirects that write no file go first, so their `&` splits nothing.
  const cleaned = command
    .replace(/\d?>&\d/g, '')
    .replace(/(&|\d)?>>?\s*\/dev\/null/g, '')
  if (cleaned.includes('>')) return 'a redirect writes a file'

  for (const words of commandsOf(cleaned)) {
    const why = commandVerdict(words)
    if (why !== undefined) return why
  }

  return undefined
}

// Undefined when the call only reads; else why ask mode refuses it.
export function verdict(tool: string, input: Record<string, unknown>): string | undefined {
  if (READ_TOOLS.has(tool)) return undefined
  if (tool === 'Bash') return bashVerdict(typeof input.command === 'string' ? input.command : '')
  if (tool.startsWith('mcp__')) return mcpVerdict(tool)

  const actions = READ_ACTIONS[tool]
  if (actions !== undefined) {
    const action = typeof input.action === 'string' ? input.action : tool === 'Artifact' ? 'publish' : ''
    return actions.has(action) ? undefined : `${tool} ${action} may change something`.trim()
  }

  return `${tool} may change something`
}
