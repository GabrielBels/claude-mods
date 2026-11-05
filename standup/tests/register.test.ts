import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { defaultDays, factLine, factTag, fallbackSections, formatAiSessions, formatSections, lastStandup, momentLabel, neighboursOf, oneLinePerTicket, parseAiSessions, parseMeeting, parseSections, parseSvnLog, prFacts, reviewedLine, oneReviewLine, oneTicketPerBullet, reviewedPrs, settleTickets, ticketLines, ticketsOf, unseenCommits, workedTickets } from '../hooks/standup'
import type { AiSession } from '../hooks/standup'
import { fakeHub } from './hub'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const ROOT = '/work/shop'
const WEDNESDAY = Date.UTC(2026, 9, 7, 9)
const MONDAY = Date.UTC(2026, 9, 5, 9)
const LOG = [
  '2026-10-06\ta1b2c3d\tfeat(api): add pagination to /orders',
  '2026-10-06\tb2c3d4e\tfix: rounding of cart totals',
].join('\n')
const REPLY = 'UPDATE:\n- Added pagination to the orders API\n- Fixed cart total rounding\nBLOCKERS:\n- None'
const PANE_PROPS = {
  title: 'Standup',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}
const run = (args = '') => ({
  command: 'standup',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})
/** git's `--since` for midnight `days` before `now`, in the runtime's zone. */
const sinceMidnight = (now: number, days: number): string => {
  const midnight = new Date(now - days * 86_400_000)
  midnight.setHours(0, 0, 0, 0)
  return `--since=${midnight.toISOString()}`
}
const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type World = { gitCalls: string[][]; prompts: string[]; copies: string[]; sessionRequests: unknown[]; jiraRequests: unknown[] }
type Setup = { prs?: unknown[]; jira?: Record<string, unknown>; aiSessions?: AiSession[]; sessions?: unknown; now?: number; log?: string; status?: string; repo?: boolean; reply?: string | 'fails'; journal?: boolean }

const world = (on: On, setup: Setup = {}): World => {
  const state: World = { gitCalls: [], prompts: [], copies: [], sessionRequests: [], jiraRequests: [] }
  startClock = mock.clock(on, { now: setup.now ?? WEDNESDAY })
  on('process.run', ($, e) => {
    const args = e.argv.slice(1)
    state.gitCalls.push(args)
    const answer = (exitCode: number, stdout: string) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'gh') return setup.prs === undefined ? answer(1, '') : answer(0, JSON.stringify(setup.prs))
    if (e.argv[0] === 'python3' && (args[1] ?? '').endsWith('/jira.py')) {
      state.jiraRequests.push(JSON.parse(args[2] ?? 'null'))
      return setup.jira === undefined ? answer(2, '') : answer(0, JSON.stringify(setup.jira))
    }
    if (e.argv[0] === 'python3') {
      state.sessionRequests.push(JSON.parse(args[2] ?? 'null'))
      return setup.aiSessions === undefined ? answer(2, '') : answer(0, JSON.stringify(setup.aiSessions))
    }
    if (setup.repo === false) return answer(128, '')
    if (args[0] === 'rev-parse') return answer(0, `${ROOT}\n`)
    if (args[0] === 'remote') return answer(0, 'git@github-work:Acme/shop.git\n')
    if (args[0] === 'config') return answer(0, args[1] === 'user.email' ? 'dev@shop.io\n' : 'Dev\n')
    if (args[0] === 'log') return answer(0, setup.log ?? LOG)
    if (args[0] === 'status') return answer(0, setup.status ?? '## feature/orders...origin/feature/orders\n M src/orders.ts\n?? notes.txt\n')
    return answer(1, '')
  })
  on('fs.list', ($, e) =>
    setup.journal === true && e.path === `${ROOT}/.claude/journal`
      ? { value: ['2026-10-06.md', '2026-09-01.md'].map(name => ({ name, kind: 'file' as const, size: 10, mtimeMs: 0, isLink: false })) }
      : { deny: 'ENOENT' },
  )
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'me' }))
  on('fs.read', ($, e) =>
    e.path.endsWith('/hub/sessions.json') ? (setup.sessions === undefined ? { deny: 'ENOENT' } : { value: JSON.stringify(setup.sessions) }) : e.path.endsWith('2026-10-06.md') ? { value: 'Paired with Sam on the checkout bug.' } : { value: 'old notes' },
  )
  on('model.complete', ($, e) => {
    state.prompts.push(e.prompt)
    if (setup.reply === 'fails') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: NO_USAGE } }
    return { value: { isAnswered: true, text: setup.reply ?? REPLY, usage: NO_USAGE } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', ($, e) => {
    state.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  return state
}

test('standup text: sections parse, fall back, and format for each paste target', async () => {
  const sections = parseSections('**Update:**\n* Shipped X\n1. Y\nBlockers:\n- None')
  expect(sections).toEqual({ update: ['Shipped X', 'Y'], blockers: ['None'] })
  expect(parseSections('I could not do that.')).toBeUndefined()
  expect(formatSections({ update: ['A', 'B'], blockers: ['None'] }, 'plain')).toBe('- A\n- B')
  expect(formatSections({ update: ['A'], blockers: ['C'] }, 'slack')).toBe('• A\n\n*Blockers*\n• C')
  expect(formatSections({ update: ['A'], blockers: ['C'] }, 'markdown')).toBe('- A\n\n**Blockers**\n- C')
  const fallback = fallbackSections([{ date: '', hash: '', subject: 'feat(api): add pagination' }], 'main', 2)
  expect(fallback).toEqual({ update: ['Add pagination', '2 files in progress on main'], blockers: ['None'] })
  expect(defaultDays(MONDAY)).toBe(3)
  expect(defaultDays(WEDNESDAY)).toBe(1)
})

test('/standup reads your commits and journal, asks the model and shows a copyable standup', async ($, on) => {
  const state = world(on, { journal: true })
  const ran = await $.command.run(run())
  expect(ran.text).toContain('2 commits + journal since Tue 6 Oct · written by haiku')

  const log = state.gitCalls.find(args => args[0] === 'log') ?? []
  expect(log).toContain(sinceMidnight(WEDNESDAY, 1))
  expect(log).toContain('--author=dev@shop.io')
  expect(state.prompts[0]).toContain('2026-10-06  feat(api): add pagination to /orders')
  expect(state.prompts[0]).toContain('Paired with Sam on the checkout bug.')
  expect(state.prompts[0]).not.toContain('old notes')
  expect(state.prompts[0]).toContain('Branch: feature/orders · 2 files with uncommitted changes')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'standup', surface, component: 'Pane', requestId: 'standup', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: '- Added pagination to the orders API' })).toBeDefined()
    await ui.press({ key: 'copy' })
    await ui.unmount()
  }
  expect(state.copies[0]).toBe('- Added pagination to the orders API\n- Fixed cart total rounding')
})

test('on a Monday it looks back to Friday; a days argument wins and is validated', async ($, on) => {
  const state = world(on, { now: MONDAY })
  await $.command.run(run())
  expect(state.gitCalls.find(args => args[0] === 'log')).toContain(sinceMidnight(MONDAY, 3))
  await $.command.run(run('7'))
  expect(state.gitCalls.filter(args => args[0] === 'log').at(-1)).toContain(sinceMidnight(MONDAY, 7))
  const bad = await $.command.run(run('soon'))
  expect(bad.text).toContain('Days must be a whole number')
})

test('no commits, journal or open changes: no model call, a clear message', async ($, on) => {
  const quiet = world(on, { log: '', status: '## main\n', reply: 'fails' })
  const empty = await $.command.run(run())
  expect(empty.text).toContain('Nothing to report')
  expect(quiet.prompts).toHaveLength(0)
})

test('a model failure still gives a standup listed from git', async ($, on) => {
  const state = world(on, { reply: 'fails' })
  const ran = await $.command.run(run())
  expect(ran.text).toContain('listed from git and sessions (the model answered api-error)')
  const ui = await $.ui.mount({ plugin: 'standup', surface: 'terminal', component: 'Pane', requestId: 'standup', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: '- Add pagination to /orders' })).toBeDefined()
  await ui.press({ key: 'regenerate' })
  expect(state.prompts).toHaveLength(2)
})

test('outside a git repository, with none in the folder, it says so', async ($, on) => {
  world(on, { repo: false })
  const ran = await $.command.run(run())
  expect(ran.text).toBe('Not inside a git repository, and none in this folder.')
})

test('outside a git repository it covers every repository in the folder in one standup, each commit tagged by repo', async ($, on) => {
  const prompts: string[] = []
  const logged: string[] = []
  mock.clock(on, { now: WEDNESDAY })
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/work/' }))
  on('fs.list', ($, e) =>
    e.path === '/work'
      ? { value: ['web', 'api', 'docs', 'idle', 'notes.md'].map(name => ({ name, kind: name.endsWith('.md') ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })) }
      : { deny: 'ENOENT' },
  )
  on('fs.exists', ($, e) => ({ value: ['/work/api/.git', '/work/web/.git', '/work/idle/.git'].includes(e.path) }))
  on('process.run', ($, e) => {
    const args = e.argv.slice(1)
    const cwd = e.init?.cwd
    const answer = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args[0] === 'rev-parse') return answer(128, '')
    if (args[0] === 'config') return answer(0, cwd === '/work/web' ? 'web@shop.io\n' : 'dev@shop.io\n')
    if (args[0] === 'log') {
      logged.push(`${cwd} ${args.find(arg => arg.startsWith('--author=')) ?? ''}`)
      if (cwd === '/work/api') return answer(0, '2026-10-06\ta1b2c3d\tfeat(api): add pagination')
      if (cwd === '/work/web') return answer(0, '2026-10-07\tb2c3d4e\tfix: focus ring')
      return answer(0, '')
    }
    if (args[0] === 'status') return answer(0, cwd === '/work/api' ? '## main\n M src/orders.ts\n' : '## feature/cart\n')
    return answer(1, '')
  })
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: REPLY, usage: NO_USAGE } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ran = await $.command.run(run())
  expect(ran.text).toContain('2 commits in 2 repos since Tue 6 Oct · written by haiku')
  expect(logged.sort()).toEqual(['/work/api --author=dev@shop.io', '/work/idle --author=dev@shop.io', '/work/web --author=web@shop.io'])
  const prompt = prompts[0] ?? ''
  expect(prompt).toContain('author dev@shop.io, web@shop.io')
  expect(prompt).toContain('Commits (newest first):\n2026-10-07  [web] fix: focus ring\n2026-10-06  [api] feat(api): add pagination')
  expect(prompt).toContain('Repositories (2); name the repository in a bullet when it helps the reader:\n- api: main · 1 file with uncommitted changes\n- web: feature/cart · 0 files with uncommitted changes')
  expect(prompt).not.toContain('idle')
  expect(prompt).not.toContain('Branch:')
})

const SVN_XML = (entries: [number, string, string, string][]) =>
  `<?xml version="1.0"?>\n<log>\n${entries.map(([rev, author, date, msg]) => `<logentry\n   revision="${rev}">\n<author>${author}</author>\n<date>${date}</date>\n<msg>${msg}</msg>\n</logentry>`).join('\n')}\n</log>\n`

test('parseSvnLog keeps your entries since the day, newest first, with the first line of the message', () => {
  const xml = SVN_XML([
    [812, 'Alice', '2026-10-06T14:00:00.000000Z', 'CORE-8061 fix &lt;null&gt; owner&#13;\nlong body'],
    [811, 'someone', '2026-10-06T13:00:00.000000Z', 'not mine'],
    [790, 'alice', '2026-10-01T10:00:00.000000Z', 'too old'],
    [789, 'alice', '2026-10-06T09:00:00.000000Z', ''],
  ])
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  expect(parseSvnLog(xml, 'alice', Date.UTC(2026, 9, 6, 9, 30), day)).toEqual([{ date: '2026-10-06', hash: 'r812', subject: 'CORE-8061 fix <null> owner' }])
  expect(parseSvnLog('svn: E170013: Unable to connect', 'alice', Date.UTC(2026, 9, 6), day)).toEqual([])
})

test('with svnAuthor it adds svn working copies, one level into a folder that is no repository, and names an unreachable one', { options: { svnAuthor: 'alice' } }, async ($, on) => {
  const prompts: string[] = []
  const svnCalls: string[] = []
  mock.clock(on, { now: WEDNESDAY })
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/work' }))
  const dirs: Record<string, string[]> = { '/work': ['api', 'customer-branches', 'tmp'], '/work/customer-branches': ['GLOBEX', 'ACME', 'notes'], '/work/tmp': ['deep'] }
  on('fs.list', ($, e) => {
    const names = dirs[e.path]
    return names === undefined ? { deny: 'ENOENT' } : { value: names.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  const marks = ['/work/api/.git', '/work/customer-branches/GLOBEX/.svn', '/work/customer-branches/ACME/.svn', '/work/tmp/deep/.git']
  on('fs.exists', ($, e) => ({ value: marks.includes(e.path) }))
  on('process.run', ($, e) => {
    const [tool = '', ...args] = e.argv
    const cwd = e.init?.cwd ?? '/work'
    const answer = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (tool === 'svn') {
      svnCalls.push(`${cwd} ${args.join(' ')}`)
      if (args.includes('wc-root')) return answer(1, '')
      if (args.includes('relative-url')) return answer(0, `^/Phoenix/branches/Clients/${cwd.slice(cwd.lastIndexOf('/') + 1)}/Current\n`)
      if (args.includes('status')) return answer(0, cwd.endsWith('GLOBEX') ? 'M       Source/Owner.cs\n M      Source\n?       junk.txt\n' : '')
      if (args.includes('log')) return cwd.endsWith('ACME') ? answer(1, '') : answer(0, SVN_XML([[812, 'alice', '2026-10-06T14:00:00.000000Z', 'CORE-8061 fix null owner']]))
      return answer(1, '')
    }
    if (args[0] === 'rev-parse') return answer(128, '')
    if (args[0] === 'config') return answer(0, 'dev@shop.io\n')
    if (args[0] === 'log') return answer(0, '2026-10-07\ta1b2c3d\tfeat(api): add pagination')
    if (args[0] === 'status') return answer(0, '## main\n')
    return answer(1, '')
  })
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: REPLY, usage: NO_USAGE } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ran = await $.command.run(run())
  expect(ran.text).toContain('2 commits in 2 repos since Tue 6 Oct · written by haiku · could not read the log of customer-branches/ACME')
  expect(svnCalls.every(call => call.split(' ')[1] === '--non-interactive')).toBe(true)
  expect(svnCalls).toContain('/work/customer-branches/GLOBEX --non-interactive log --xml -r HEAD:{2026-10-06} --limit=500')
  const prompt = prompts[0] ?? ''
  expect(prompt).toContain('author dev@shop.io, alice')
  expect(prompt).toContain('2026-10-07  [api] feat(api): add pagination\n2026-10-06  [customer-branches/GLOBEX] CORE-8061 fix null owner')
  expect(prompt).toContain('- customer-branches/GLOBEX: Phoenix/branches/Clients/GLOBEX/Current · 2 files with uncommitted changes')
  expect(prompt).not.toContain('deep')
})

const SESSIONS = {
  me: { id: 'me', cwd: ROOT, turns: 4, usd: 1, events: [{ topic: 'git.commit', at: WEDNESDAY - 3_600_000, data: { sha: 'a1b2c3d4e5', message: 'feat(api): add pagination to /orders', branch: 'x', files: 2 } }] },
  other: {
    id: 'other',
    cwd: `${ROOT}/packages/web`,
    turns: 27,
    usd: 3.2,
    events: [
      { topic: 'git.commit', at: WEDNESDAY - 7_200_000, data: { sha: 'f9e8d7c6b5', message: 'fix(web): focus ring on the cart button\n\nlong body', branch: 'fix/focus', files: 1 } },
      { topic: 'git.commit', at: WEDNESDAY - 90 * 86_400_000, data: { sha: '0000000aaa', message: 'ancient', branch: 'x', files: 1 } },
      { topic: 'test.result', at: WEDNESDAY - 1000, data: {} },
    ],
  },
  elsewhere: { id: 'elsewhere', cwd: '/work/blog', turns: 9, usd: 9, events: [] },
}

test('with mods-hub: says hello, adds commits other sessions made on other branches, and tells the model about the other sessions', async ($, on) => {
  const state = world(on, { sessions: SESSIONS })
  const hub = fakeHub(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: ['git.commit', 'session.ended'] }])

  await $.command.run(run())
  const prompt = state.prompts[0] ?? ''
  expect(prompt).toContain('Commits (newest first):\n2026-10-07  fix(web): focus ring on the cart button\n2026-10-06  feat(api): add pagination to /orders')
  expect(prompt).not.toContain('ancient')
  expect(prompt.match(/pagination/g)).toHaveLength(1)
  expect(prompt).toContain('Other Claude sessions on this project right now: 1 (27 turns, $3.20 so far).')
})

test('without mods-hub the standup is built from git and the journal alone', async ($, on) => {
  const state = world(on, { sessions: SESSIONS })
  await $.command.run(run())
  expect(state.prompts[0]).not.toContain('Other Claude sessions')
  expect(state.prompts[0]).not.toContain('f9e8d7c')
})

test('neighboursOf and unseenCommits read the hub heartbeat defensively', () => {
  const day = (ms: number) => `d${ms}`
  expect(neighboursOf('nope', ROOT, 'me', 0, day)).toEqual({ commits: [], sessions: 0, turns: 0, usd: 0 })
  expect(neighboursOf({ a: { cwd: 5 }, b: null, c: { cwd: `${ROOT}-other`, turns: 1 } }, ROOT, 'me', 0, day).sessions).toBe(0)
  const found = neighboursOf(SESSIONS, ROOT, 'me', WEDNESDAY - 86_400_000, day)
  expect(found).toMatchObject({ sessions: 1, turns: 27, usd: 3.2 })
  expect(found.commits.map(commit => commit.hash)).toEqual(['a1b2c3d', 'f9e8d7c'])
  expect(unseenCommits([{ date: '', hash: 'a1b2c3d', subject: 'x' }], found.commits).map(commit => commit.hash)).toEqual(['f9e8d7c'])
})

const AI_SESSIONS: AiSession[] = [
  { source: 'claude', cwd: '/work/shop', branch: 'main', title: 'PR #1913', start: '2026-10-06T18:04:00Z', prompts: ['/dev-flow:pr-review 1913', 'review the answers in those comments'] },
  { source: 'codex', cwd: 'D:\\work\\triage', branch: 'PROJ-2279-sync', title: 'PR review #142', start: '2026-10-06T20:37:00Z', prompts: ['$dev-flow:pr-review #142'] },
  { source: 'claude', cwd: '/work/shop', branch: 'main', title: 'PROJ-2425 order.CreatedBy references spike', start: '2026-10-07T08:23:00Z', prompts: ['analyze the latest comment on PROJ-2425'] },
]

test('session helpers: parse defensively, list each session on one line, and fold reviewed PRs into one line', () => {
  expect(parseAiSessions('not json')).toBeUndefined()
  expect(parseAiSessions(JSON.stringify([{ source: 'claude' }, ...AI_SESSIONS]))).toEqual(AI_SESSIONS)
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  expect(formatAiSessions(AI_SESSIONS, day).split('\n')).toEqual([
    '- 2026-10-06 claude · work/shop · branch main · "PR #1913": /dev-flow:pr-review 1913 | review the answers in those comments',
    '- 2026-10-06 codex · work/triage · branch PROJ-2279-sync · "PR review #142": $dev-flow:pr-review #142',
    '- 2026-10-07 claude · work/shop · branch main · "PROJ-2425 order.CreatedBy references spike": analyze the latest comment on PROJ-2425',
  ])
  expect(reviewedPrs(AI_SESSIONS, [])).toEqual([142, 1913])
  expect(reviewedPrs(AI_SESSIONS, [{ date: '', hash: '', subject: 'PROJ-1: fix pager (#1913)' }])).toEqual([142])
  expect(reviewedPrs([{ ...AI_SESSIONS[0]!, title: 'PR #1913', prompts: ['open PR #1913 for PROJ-1'] }], [])).toEqual([])
  expect(reviewedLine([])).toBeUndefined()
  expect(reviewedLine([142])).toBe('PR #142 reviewed')
  expect(reviewedLine([142, 1913])).toBe('PRs #142 and #1913 reviewed')
  expect(reviewedLine([142, 1913, 1920])).toBe('PRs #142, #1913, and #1920 reviewed')
  expect(fallbackSections([], 'main', 0, ['PR #142 reviewed']).update).toEqual(['PR #142 reviewed'])
})

test('each ticket gets one line saying where it stands: merged, PR opened, in progress or started', () => {
  const session = (title: string, prompts: string[] = [], branch = 'main'): AiSession => ({ source: 'claude', cwd: '/work/shop', branch, title, start: '2026-10-06T10:00:00Z', prompts })
  const commits = [
    { date: '2026-10-06', hash: 'a', subject: 'PROJ-2458: Make the recycle bin pager stay in view (#1904)' },
    { date: '2026-10-06', hash: 'b', subject: 'PROJ-2458: fix lint' },
    { date: '2026-10-06', hash: 'c', subject: 'PROJ-2269: explain the duplicate username error' },
    { date: '2026-10-06', hash: 'd', subject: 'chore: bump tooling' },
  ]
  const sessions = [
    session('PROJ-2458 recycle bin: pager off screen'),
    session('Global Search: page size', ['abre o PR'], 'PROJ-2446-page-size'),
    session('PROJ-2425 order.CreatedBy references spike'),
    session('PR review #142 PROJ-9'),
  ]
  expect(ticketLines(commits, sessions)).toEqual([
    'PROJ-2458: Make the recycle bin pager stay in view (merged, PR #1904)',
    'PROJ-2269: Explain the duplicate username error (in progress)',
    'PROJ-2446: Global Search: page size (PR opened)',
    'PROJ-2425: Order.CreatedBy references spike (started)',
  ])
  expect(fallbackSections(commits, 'main', 0, ['PR #142 reviewed'], sessions).update).toEqual([
    ...ticketLines(commits, sessions),
    'Bump tooling',
    'PR #142 reviewed',
  ])
  expect(oneLinePerTicket(['PROJ-1: Opened the PR', 'Paired with Sam', 'PROJ-1: Merged it'])).toEqual(['PROJ-1: Opened the PR; Merged it', 'Paired with Sam'])
})

test('/standup adds your Claude Code and Codex sessions in the folder that holds the repository, one line per ticket and the PR reviews line', async ($, on) => {
  const state = world(on, { aiSessions: AI_SESSIONS, reply: 'UPDATE:\n- PROJ-2425: Mapped order.CreatedBy references\n- Reviewed PR #1913\n- PROJ-2425: for the spike\n- PRs #142 and #1913 reviewed\nBLOCKERS:\n- Waiting on the DBA for prod read access' })
  const ran = await $.command.run(run())
  expect(ran.text).toContain('2 commits + 3 sessions since Tue 6 Oct · written by haiku')
  const midnight = new Date(WEDNESDAY - 86_400_000)
  midnight.setHours(0, 0, 0, 0)
  expect(state.sessionRequests).toEqual([{ since: midnight.getTime(), dirs: ['/home/me/.claude/projects', '/home/me/.codex/sessions'], scopes: ['/work'] }])
  const prompt = state.prompts[0] ?? ''
  expect(prompt).toContain("AI sessions (Claude Code and Codex), oldest first, each with the engineer's own prompts:\n- ")
  expect(prompt).toContain('"PROJ-2425 order.CreatedBy references spike": analyze the latest comment on PROJ-2425')
  expect(prompt).not.toContain('PR reviews:')
  const ui = await $.ui.mount({ plugin: 'standup', surface: 'terminal', component: 'Pane', requestId: 'standup', props: PANE_PROPS })
  await ui.press({ key: 'copy' })
  expect(state.copies[0]).toBe('- PROJ-2425: Mapped order.CreatedBy references; for the spike\n- PRs #142 and #1913 reviewed\n\nBlockers:\n- Waiting on the DBA for prod read access')
})

test('sessions alone are something to report', async ($, on) => {
  world(on, { log: '', status: '## main\n', aiSessions: AI_SESSIONS.slice(2) })
  const ran = await $.command.run(run())
  expect(ran.text).toContain('0 commits + 1 session since Tue 6 Oct')
})

test('empty sessionDirs leaves sessions out', { options: { sessionDirs: '' } }, async ($, on) => {
  const state = world(on)
  const ran = await $.command.run(run())
  expect(state.sessionRequests).toHaveLength(0)
  expect(ran.text).not.toContain('sessions (python3)')
})

test('sessionScope replaces the default scope, and a failing reader is named in the detail line', { options: { sessionScope: '/mnt/d/work, D:\\other' } }, async ($, on) => {
  const state = world(on)
  const ran = await $.command.run(run())
  expect(state.sessionRequests).toEqual([expect.objectContaining({ scopes: ['/mnt/d/work', 'D:\\other'] })])
  expect(ran.text).toContain('could not read your Claude Code and Codex sessions (python3)')
})

const DSU = { standupTime: '10:45', standupTimeZone: 'America/New_York' }

test('the window starts at the latest weekday standup held, in the meeting zone across daylight saving', () => {
  const meeting = parseMeeting('10:45', 'America/New_York')
  if (meeting === undefined) throw new Error('meeting not parsed')
  // 10:45 New York is 12:45 in Sao Paulo under EST and 11:45 under EDT.
  expect(lastStandup(Date.UTC(2026, 10, 4, 21, 55), meeting, 1)).toBe(Date.UTC(2026, 10, 4, 15, 45))
  expect(lastStandup(Date.UTC(2026, 10, 4, 15, 0), meeting, 1)).toBe(Date.UTC(2026, 10, 3, 15, 45))
  expect(lastStandup(Date.UTC(2026, 9, 15, 20, 0), meeting, 1)).toBe(Date.UTC(2026, 9, 15, 14, 45))
  expect(lastStandup(Date.UTC(2026, 10, 9, 12, 0), meeting, 1)).toBe(Date.UTC(2026, 10, 6, 15, 45))
  expect(lastStandup(Date.UTC(2026, 10, 4, 21, 55), meeting, 2)).toBe(Date.UTC(2026, 10, 3, 15, 45))
  expect(parseMeeting('', 'America/New_York')).toBeUndefined()
  expect(parseMeeting('10:45', 'Not/AZone')).toBeUndefined()
  expect(parseMeeting('9:05', '')).toEqual({ hour: 9, minute: 5, timeZone: '' })
})

test('with standupTime the standup covers only what came after the last standup', { options: DSU }, async ($, on) => {
  const now = Date.UTC(2026, 10, 4, 21, 55)
  const state = world(on, { now, aiSessions: [] })
  const ran = await $.command.run(run())
  const since = Date.UTC(2026, 10, 4, 15, 45)
  expect(ran.text).toContain(`since the standup of ${momentLabel(since)}`)
  expect(state.gitCalls.find(args => args[0] === 'log')).toContain(`--since=${new Date(since).toISOString()}`)
  expect(state.sessionRequests).toEqual([expect.objectContaining({ since })])
  await $.command.run(run('2'))
  expect(state.gitCalls.filter(args => args[0] === 'log').at(-1)).toContain(`--since=${new Date(Date.UTC(2026, 10, 3, 15, 45)).toISOString()}`)
  expect((await $.command.run(run('soon'))).text).toContain('Standups back must be a whole number')
})

test('ticket facts: PRs by title or branch, Jira status as each bullet\'s ending, and tickets only named in prompts get no bullet', () => {
  const prs = [
    { number: 1890, title: 'PROJ-2219: Fix totals', state: 'MERGED', mergedAt: '2026-11-04T13:00:00Z', headRefName: 'PROJ-2219-fix' },
    { number: 1870, title: 'Older try', state: 'CLOSED', mergedAt: null, headRefName: 'PROJ-2219-old' },
    { number: 1911, title: 'Spike notes', state: 'OPEN', mergedAt: null, headRefName: 'PROJ-2425-spike' },
  ]
  expect(prFacts(prs, ['PROJ-2219', 'PROJ-2425', 'PROJ-1'])).toEqual({
    'PROJ-2219': { number: 1890, state: 'MERGED', mergedAt: '2026-11-04T13:00:00Z' },
    'PROJ-2425': { number: 1911, state: 'OPEN', mergedAt: '' },
  })
  expect(prFacts('nope', ['PROJ-1'])).toEqual({})
  const facts = {
    'PROJ-2440': { jira: { status: 'In Progress', isDone: false, assignee: 'Jane Doe', isMine: false } },
    'PROJ-2408': { jira: { status: 'Done', isDone: true, assignee: 'Gabriel', isMine: true } },
    'PROJ-2219': { pr: { number: 1890, state: 'MERGED' as const, mergedAt: '2026-11-04T13:00:00Z' } },
    'PROJ-2425': { jira: { status: 'In Progress', isDone: false, assignee: 'Gabriel', isMine: true } },
  }
  expect(factLine('PROJ-2440', facts['PROJ-2440'])).toBe('PROJ-2440: Jira "In Progress", assigned to Jane Doe (not you)')
  expect(factLine('PROJ-2219', facts['PROJ-2219'])).toBe('PROJ-2219: PR #1890 merged 2026-11-04')
  expect(factTag(facts['PROJ-2440'])).toBe('In Progress, assigned to Jane Doe')
  expect(factTag({})).toBeUndefined()
  const worked = new Set(['PROJ-2425', 'PROJ-2219'])
  expect(settleTickets(['PROJ-2425: Mapped the references and opened PROJ-2479 (started).', 'PROJ-2479: Opened the ticket (started)', 'PROJ-2219: Fixed totals (in progress)', 'Plan the sprint'], facts, worked))
    .toEqual(['PROJ-2425: Mapped the references and opened PROJ-2479 (In Progress)', 'PROJ-2219: Fixed totals (PR #1890 merged)', 'Plan the sprint'])
  const commits = [{ date: '2026-11-04', hash: 'a', subject: 'PROJ-2219: fix totals' }]
  expect(ticketLines(commits, [], facts)).toEqual(['PROJ-2219: Fix totals (PR #1890 merged)'])
  const review: AiSession = { source: 'claude', cwd: '/w', branch: 'PROJ-2279-sync', title: 'PR review #142', start: '', prompts: [] }
  const spike: AiSession = { source: 'claude', cwd: '/w', branch: 'main', title: 'PROJ-2425 spike', start: '', prompts: ['opened PROJ-2479'] }
  const tooling: AiSession = { source: 'claude', cwd: '/w', branch: 'main', title: 'Data de corte do /standup', start: '', prompts: ['PROJ-2219 was already merged'] }
  expect([...workedTickets(commits, [review, spike, tooling])]).toEqual(['PROJ-2219', 'PROJ-2425', 'PROJ-2479'])
  expect(oneReviewLine(['PROJ-2425: Mapped references', 'Reviewed PR #142 for PROJ-2279', 'PR #142 reviewed'], 'PR #142 reviewed'))
    .toEqual(['PROJ-2425: Mapped references', 'PR #142 reviewed'])
  expect(oneReviewLine(['Reviewed the plan'], undefined)).toEqual(['Reviewed the plan'])
  expect(ticketsOf(commits, [{ source: 'claude', cwd: '/w', branch: 'PROJ-2425-spike', title: 'x', start: '', prompts: ['see PROJ-2440 and PROJ-2219'] }]))
    .toEqual(['PROJ-2219', 'PROJ-2425', 'PROJ-2440'])
})

test('with Jira configured, Jira and your PRs tell the model where each ticket stands and end each bullet', { options: { ...DSU } }, async ($, on) => {
  const now = Date.UTC(2026, 10, 4, 21, 55)
  const state = world(on, {
    now,
    aiSessions: [{ source: 'claude', cwd: '/work/shop', branch: 'PROJ-2425-spike', title: 'PROJ-2425 spike', start: '2026-11-04T18:00:00Z', prompts: ['PROJ-2440 was handed over; check PROJ-2408'] }],
    log: '2026-11-04\ta1b2c3d\tPROJ-2219: fix totals',
    prs: [{ number: 1890, title: 'PROJ-2219: Fix totals', state: 'MERGED', mergedAt: '2026-11-04T19:00:00Z', headRefName: 'PROJ-2219-fix' }],
    jira: {
      'PROJ-2440': { status: 'In Progress', isDone: false, assignee: 'Jane Doe', isMine: false },
      'PROJ-2408': { status: 'Done', isDone: true, assignee: 'Dev', isMine: true },
      'PROJ-2425': { status: 'In Progress', isDone: false, assignee: 'Dev', isMine: true },
    },
    reply: 'UPDATE:\n- PROJ-2425: Mapped references (started)\n- PROJ-2440: Handed over (started)\n- PROJ-2219: Fixed totals (in progress)\nBLOCKERS:\n- None',
  })
  await $.command.run(run())
  expect(state.gitCalls.find(args => args[0] === 'pr')).toEqual(expect.arrayContaining(['--repo', 'Acme/shop']))
  expect(state.jiraRequests).toEqual([{ keys: ['PROJ-2219', 'PROJ-2425', 'PROJ-2440', 'PROJ-2408'], name: 'Dev' }])
  const prompt = state.prompts[0] ?? ''
  expect(prompt).toContain('Ticket status from Jira and GitHub:\n- PROJ-2219: PR #1890 merged 2026-11-04\n- PROJ-2425: Jira "In Progress", assigned to you')
  expect(prompt).toContain('PROJ-2440: Jira "In Progress", assigned to Jane Doe (not you)')
  const ui = await $.ui.mount({ plugin: 'standup', surface: 'terminal', component: 'Pane', requestId: 'standup', props: PANE_PROPS })
  await ui.press({ key: 'copy' })
  expect(state.copies[0]).toBe('- PROJ-2425: Mapped references (In Progress)\n- PROJ-2440: Handed over (In Progress, assigned to Jane Doe)\n- PROJ-2219: Fixed totals (PR #1890 merged)')
})

test('without Jira configured, Jira is left out quietly, and a failing gh is named in the detail line', async ($, on) => {
  const state = world(on, { log: '2026-10-06\ta1b2c3d\tPROJ-2219: fix totals' })
  const ran = await $.command.run(run())
  expect(state.jiraRequests).toHaveLength(1)
  expect(ran.text).toContain('could not read PRs (gh)')
  expect(ran.text).not.toMatch(/could not read[^\n]*Jira/)
})

test('the update generated on 4 Nov is held to one ticket per bullet and one reviews line', () => {
  const reply = [
    'PROJ-2425: Investigated order.CreatedBy references and quick-create behaviour when a role is missing; drafted a summary and architect/manager TL;DR. Opened PROJ-2479 (Database change, ready for development) for the OData column change (In Development)',
    'Reworked the standup tool to output one Jira-formatted line per ticket, search Claude and Codex sessions, and use a 12:45 GMT-3 cutoff. (in progress)',
    'PR reviews: PR #142 reviewed',
    'PR #142 reviewed',
  ]
  const worked = new Set(['PROJ-2425', 'PROJ-2479'])
  const facts = {
    'PROJ-2425': { jira: { status: 'In Development', isDone: false, assignee: 'Dev', isMine: true } },
    'PROJ-2479': { jira: { status: 'To Do', isDone: false, assignee: 'Dev', isMine: true } },
  }
  expect(oneReviewLine(settleTickets(oneTicketPerBullet(reply, worked), facts, worked), 'PR #142 reviewed')).toEqual([
    'PROJ-2425: Investigated order.CreatedBy references and quick-create behaviour when a role is missing; drafted a summary and architect/manager TL;DR (In Development)',
    'Reworked the standup tool to output one Jira-formatted line per ticket, search Claude and Codex sessions, and use a 12:45 GMT-3 cutoff.',
    'PROJ-2479: Opened the ticket (Database change, ready for development) for the OData column change (To Do)',
    'PR #142 reviewed',
  ])
  expect(oneTicketPerBullet(['PROJ-1: Fixed it while reading PROJ-9'], new Set(['PROJ-1']))).toEqual(['PROJ-1: Fixed it while reading a ticket'])
})
