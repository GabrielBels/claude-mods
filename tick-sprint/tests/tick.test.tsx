import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { activeMs, allocate, buildReport, formatDay, parseArgs, resolveSprint } from '../hooks/tick'
import type { Issue, Settings, Sprint } from '../hooks/tick'

const SETTINGS: Settings = {
  anchor: '2026-10-28',
  sprintDays: 14,
  utcOffsetHours: -3,
  activeStatuses: ['In Development', 'Code Review'],
}
// Monday 2026-11-02, 20:00 in São Paulo (UTC-3).
const NOW = Date.parse('2026-11-02T20:00:00-03:00')
const at = (iso: string) => Date.parse(`${iso}-03:00`)
const status = (created: string, from: string, to: string) => ({
  created: at(created),
  items: [{ field: 'status', from: null, to: null, fromString: from, toString: to }],
})

// Active time while mine, weekdays only: A 15+24+12 = 51h, B 20h, D 24+12 = 36h.
const ISSUES: Issue[] = [
  {
    key: 'A-1', summary: 'Story A', status: 'Done', assigneeId: 'me', epic: 'E-1', epicName: 'Geo',
    isChangelogPartial: false,
    histories: [
      status('2026-10-28T09:00:00', 'Ready for Development', 'In Development'),
      status('2026-10-30T09:00:00', 'In Development', 'Code Review'),
      status('2026-10-30T12:00:00', 'Code Review', 'Done'),
    ],
  },
  {
    key: 'B-1', summary: 'Bug B', status: 'In Development', assigneeId: 'me', epic: 'E-2', epicName: 'Support',
    isChangelogPartial: false,
    histories: [status('2026-11-02T00:00:00', 'Open', 'In Development')],
  },
  {
    key: 'C-1', summary: 'Cancelled C', status: 'Cancelled', assigneeId: 'me', epic: 'E-3', epicName: 'Gone',
    isChangelogPartial: false,
    histories: [status('2026-10-28T00:00:00', 'Open', 'In Development')],
  },
  {
    key: 'D-1', summary: 'Handed over D', status: 'In Development', assigneeId: 'other', epic: '', epicName: '(no epic)',
    isChangelogPartial: false,
    histories: [
      status('2026-10-27T00:00:00', 'Open', 'In Development'),
      {
        created: at('2026-10-29T12:00:00'),
        items: [{ field: 'assignee', from: 'me', to: 'other', fromString: 'Me', toString: 'Other' }],
      },
    ],
  },
]

test('the hours come first, then the sprint', async () => {
  expect(parseArgs('72')).toEqual({ hours: 72, sprint: '' })
  expect(parseArgs('75,5 -1')).toEqual({ hours: 75.5, sprint: '-1' })
  expect(parseArgs('80h 15/10')).toEqual({ hours: 80, sprint: '15/10' })
  expect('error' in parseArgs('')).toBe(true)
  expect('error' in parseArgs('-1')).toBe(true)
})

test('a sprint is found from the anchor, relative or by date', async () => {
  const days = (r: ReturnType<typeof resolveSprint>) => ('error' in r ? r.error : `${formatDay(r.start)}..${formatDay(r.end)}`)
  expect(days(resolveSprint('', NOW, SETTINGS))).toBe('2026-10-28..2026-11-11')
  expect(days(resolveSprint('-1', NOW, SETTINGS))).toBe('2026-10-14..2026-10-28')
  expect(days(resolveSprint('+1', NOW, SETTINGS))).toBe('2026-11-11..2026-11-25')
  expect(days(resolveSprint('15/10', NOW, SETTINGS))).toBe('2026-10-14..2026-10-28')
  expect(days(resolveSprint('2026-11-11', NOW, SETTINGS))).toBe('2026-11-11..2026-11-25')
  expect(days(resolveSprint('ontem', NOW, SETTINGS))).toMatch(/Unknown sprint/)
})

test('only active time while assigned to me counts, weekends left out', async () => {
  const hours = (issue: Issue) => activeMs(issue, 'me', SETTINGS, at('2026-10-28T00:00:00'), NOW) / 3_600_000
  expect(hours(ISSUES[0] as Issue)).toBe(51)
  expect(hours(ISSUES[1] as Issue)).toBe(20)
  expect(hours(ISSUES[3] as Issue)).toBe(36)
})

test('time in Blocked does not count', async () => {
  const blocked: Issue = {
    key: 'F-1', summary: 'Blocked F', status: 'Blocked', assigneeId: 'me', epic: 'E-4', epicName: 'Waiting',
    isChangelogPartial: false,
    histories: [status('2026-10-28T00:00:00', 'In Development', 'Blocked')],
  }
  expect(activeMs(blocked, 'me', SETTINGS, at('2026-10-28T00:00:00'), NOW)).toBe(0)
})

test('In Development then Blocked on the same day counts only the time in between', async () => {
  const sameDay: Issue = {
    key: 'G-1', summary: 'Same day G', status: 'Blocked', assigneeId: 'me', epic: 'E-4', epicName: 'Waiting',
    isChangelogPartial: false,
    histories: [
      status('2026-10-29T09:30:00', 'Ready for Development', 'In Development'),
      status('2026-10-29T11:45:00', 'In Development', 'Blocked'),
    ],
  }
  expect(activeMs(sameDay, 'me', SETTINGS, at('2026-10-28T00:00:00'), NOW) / 3_600_000).toBe(2.25)
})

test('allocation keeps quarter hours and the exact total', async () => {
  const parts = allocate(new Map([['a', 1], ['b', 1], ['c', 1]]), 8)
  expect([...parts.values()].reduce((a, b) => a + b, 0)).toBe(8)
  for (const h of parts.values()) expect((h * 4) % 1).toBe(0)
})

test('the hours given are split by each epic\'s active time', async () => {
  const r = buildReport(ISSUES, 'me', SETTINGS, resolveSprint('', NOW, SETTINGS) as Sprint, NOW, 32)
  expect(r.sprintStart).toBe('2026-10-28')
  expect(r.totalHours).toBe(32)
  expect(r.totals.map(t => `${t.epic || '-'}:${t.hours}`)).toEqual(['E-1:15.25', '-:10.75', 'E-2:6'])
  expect(r.notes.some(n => n.includes('C-1'))).toBe(true)
  expect(r.notes.some(n => n.includes('Sprint in progress'))).toBe(true)
})

// The Jira REST API as the mod sees it through $.http.fetch, configured by ~/.config/jira.json.
const CONFIG = JSON.stringify({ apiBase: 'https://jira.example/rest/api/3/', email: 'alice@acme.test', token: 't0ken' })
const ok = (data: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(data) } })
const searchPage = {
  issues: ISSUES.map(i => ({
    key: i.key,
    fields: {
      summary: i.summary,
      status: { name: i.status },
      assignee: { accountId: i.assigneeId },
      parent: i.epic ? { key: i.epic, fields: { summary: i.epicName, issuetype: { name: 'Epic' } } } : undefined,
    },
  })),
  isLast: true,
}
// A-1's changelog comes in two pages, to show that paging is followed.
const changelogPage = (issue: Issue, startAt: number) => {
  const all = issue.histories.map(h => ({ created: new Date(h.created).toISOString(), items: h.items }))
  const size = issue.key === 'A-1' ? 2 : 100
  const values = all.slice(startAt, startAt + size)
  return { startAt, maxResults: size, total: all.length, isLast: startAt + values.length >= all.length, values }
}

type Request = { url: string; method: string; body?: unknown; auth?: string }

function fakeJira(on: Parameters<TestBody>[1], config: string | undefined, requests: Request[]) {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/alice' : undefined }))
  on('fs.read', (_, e) => {
    if (e.path !== '/home/alice/.config/jira.json' || config === undefined) throw new Error('ENOENT')
    return { value: config }
  })
  on('http.fetch', (_, e) => {
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body === undefined ? undefined : JSON.parse(e.init.body)
    requests.push({ url: e.url, method, body, auth: e.init?.headers?.Authorization })
    const path = e.url.replace('https://jira.example/rest/api/3', '')
    if (path === '/myself') return ok({ accountId: 'me' })
    if (path === '/search/jql') return ok(searchPage)
    const m = /^\/issue\/([^/]+)\/changelog\?startAt=(\d+)/.exec(path)
    if (m) return ok(changelogPage(ISSUES.find(i => i.key === m[1]) as Issue, Number(m[2])))
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
}

const PANE_PROPS = {
  title: 'Tick · sprint', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {},
} as const
const TICK = (args: string) => ({ command: 'tick', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

test('/tick 32 reads Jira with ~/.config/jira.json, follows changelog pages and fills the pane', async ($, on) => {
  const requests: Request[] = []
  on('command.register', () => ({ value: { command: 'tick' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  fakeJira(on, CONFIG, requests)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run(TICK('32'))

  const search = requests.find(r => r.url.endsWith('/search/jql'))
  expect(search?.method).toBe('POST')
  expect((search?.body as { jql: string }).jql).toBe(
    'assignee was currentUser() DURING ("2026/10/28", "2026/11/11") AND (status changed DURING ("2026/10/28", "2026/11/11") OR statusCategory = "In Progress") ORDER BY key',
  )
  expect(search?.auth).toBe(`Basic ${btoa('alice@acme.test:t0ken')}`)
  expect(requests.filter(r => r.url.includes('/issue/A-1/changelog')).map(r => r.url.split('?')[1])).toEqual([
    'startAt=0&maxResults=100',
    'startAt=2&maxResults=100',
  ])
  expect(out.text).toContain('15.25h  Geo (E-1)')
  expect(out.text).toContain('10.75h  (no epic)')
  expect(out.text).toContain('6h  Support (E-2)')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'tick-sprint', surface, component: 'Pane', requestId: 'tick-sprint', props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: /Geo \(E-1\)/ }))?.text).toBe(' 15.25h  Geo (E-1)')
    expect(await ui.find({ type: 'Button', key: 'copy' })).toBeTruthy()
    await ui.unmount()
  }
})

test('/tick without ~/.config/jira.json says how to configure Jira and calls nothing', async ($, on) => {
  const requests: Request[] = []
  on('command.register', () => ({ value: { command: 'tick' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  fakeJira(on, undefined, requests)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run(TICK('32'))

  expect(out.text).toContain('Jira is not configured: create ~/.config/jira.json')
  expect(requests).toEqual([])
})

test('/tick without hours says how to call it and reads nothing', async ($, on) => {
  const requests: Request[] = []
  on('command.register', () => ({ value: { command: 'tick' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  fakeJira(on, CONFIG, requests)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const out = await $.command.run(TICK('-1'))

  expect(out.text).toContain('Give the hours you worked')
  expect(requests).toEqual([])
})
