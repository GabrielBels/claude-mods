// Pure standup helpers: dates, the model's sections, and the paste-ready text. No `$` here.

export type Style = 'plain' | 'markdown' | 'slack'

/** The standup update: one list of what was done since the last standup, and the blockers. */
export type Sections = { update: string[]; blockers: string[] }

/** `repo` names the repository when the standup covers several. */
export type Commit = { date: string; hash: string; subject: string; repo?: string }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000
const MONDAY = 1
const MAX_FALLBACK_ITEMS = 8

/** One day back, or back to Friday on a Monday. */
export const defaultDays = (now: number): number => (new Date(now).getDay() === MONDAY ? 3 : 1)

/** "Mon 6 Oct": the first day the standup covers. */
export const sinceLabel = (now: number, days: number): string => {
  const since = new Date(now - days * DAY_MS)
  return `${WEEKDAYS[since.getDay()]} ${since.getDate()} ${MONTHS[since.getMonth()]}`
}

/** The daily standup meeting: its wall-clock time in `timeZone` (an IANA zone; '' for the runtime's own). */
export type Meeting = { hour: number; minute: number; timeZone: string }

/** Minutes `timeZone` is ahead of UTC at `ms` (-180 for America/Sao_Paulo); the runtime's own zone for ''. */
export const zoneOffset = (ms: number, timeZone: string): number => {
  if (timeZone === '') return -new Date(ms).getTimezoneOffset()
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(ms)
  const part = (type: string): number => Number(parts.find(item => item.type === type)?.value)
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'))
  return Math.round((wall - (ms - (ms % 60_000))) / 60_000)
}

/** `HH:MM` and an IANA zone as a Meeting; undefined when the time is empty or either is not valid. */
export const parseMeeting = (time: string, timeZone: string): Meeting | undefined => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim())
  if (match === null) return undefined
  try {
    zoneOffset(0, timeZone)
  } catch {
    return undefined
  }
  return { hour: Number(match[1]), minute: Number(match[2]), timeZone }
}

/** The moment of the `count`-th latest standup held on a weekday (Monday to Friday) at or before `now`; 1 is the latest. */
export const lastStandup = (now: number, meeting: Meeting, count: number): number => {
  const today = now + zoneOffset(now, meeting.timeZone) * 60_000
  let held = 0
  for (let back = 0; back < count * 2 + 7; back += 1) {
    const day = new Date(today - back * DAY_MS)
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue
    const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), meeting.hour, meeting.minute)
    const at = wall - zoneOffset(wall - zoneOffset(wall, meeting.timeZone) * 60_000, meeting.timeZone) * 60_000
    if (at > now) continue
    held += 1
    if (held === count) return at
  }
  return now - count * DAY_MS
}

/** "Wed 4 Nov 12:45", in the runtime's own zone. */
export const momentLabel = (ms: number): string => {
  const at = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** Reads `YYYY-MM-DD<TAB>hash<TAB>subject` lines from git log. */
export const parseLog = (stdout: string): Commit[] =>
  stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter((parts): parts is [string, string, string] => parts.length >= 3 && parts[2] !== '')
    .map(([date, hash, ...subject]) => ({ date, hash, subject: subject.join('\t').trim() }))

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const unescapeXml = (text: string): string =>
  text.replace(/&(?:#(\d+)|(\w+));/g, (entity, code: string | undefined, name: string | undefined) =>
    code !== undefined ? String.fromCharCode(Number(code)) : (XML_ENTITIES[name ?? ''] ?? entity))

/**
 * Reads `svn log --xml`: the entries by `author` (any case) at or after `sinceMs`, newest first as svn lists them for
 * `-r HEAD:{since}`, each as `r<revision>` with the message's first line. `day` formats a time as `YYYY-MM-DD`.
 */
export const parseSvnLog = (xml: string, author: string, sinceMs: number, day: (ms: number) => string): Commit[] => {
  const commits: Commit[] = []
  for (const [, revision = '', body = ''] of xml.matchAll(/<logentry\s+revision="(\d+)"\s*>([\s\S]*?)<\/logentry>/g)) {
    const field = (name: string): string => unescapeXml(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1] ?? '')
    const ms = Date.parse(field('date'))
    const subject = (field('msg').trim().split(/\r?\n/)[0] ?? '').trim()
    if (field('author').toLowerCase() !== author.toLowerCase() || !Number.isFinite(ms) || ms < sinceMs || subject === '') continue
    commits.push({ date: day(ms), hash: `r${revision}`, subject })
  }
  return commits
}

const HEADINGS: Record<keyof Sections, RegExp> = {
  update: /^\W*updates?\W*$/i,
  blockers: /^\W*blockers?\W*$/i,
}

/** Splits the model's `UPDATE: / BLOCKERS:` answer; undefined when it is not in that shape. */
export const parseSections = (text: string): Sections | undefined => {
  const sections: Sections = { update: [], blockers: [] }
  let current: keyof Sections | undefined
  let headings = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const heading = (Object.keys(HEADINGS) as (keyof Sections)[]).find(key => HEADINGS[key].test(line.replace(/[:*_#]/g, ' ').trim()))
    if (heading !== undefined) {
      current = heading
      headings += 1
      continue
    }
    if (current === undefined) continue
    const item = line.replace(/^([-*•]|\d+[.)])\s*/, '').trim()
    if (item !== '') sections[current].push(item)
  }
  return headings >= 1 && sections.update.length > 0 ? sections : undefined
}

/** A Jira key (PROJ-2458, CORE-8061) or requirement (REQ-012). */
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/
const MERGED_PR = /\(#(\d+)\)/
const OPENED_PR = /gh pr create|\b(?:open(?:ed)?|create[ds]?|abr\w*|cri\w*)\s+(?:a\s+|the\s+|o\s+|um\s+)?(?:PR|pull request)\b/i
/** Session titles that are reviews of someone else's PR; the PR reviews line covers them. */
export const REVIEW_TITLE = /^PR\b|review/i

export const ticketOf = (text: string): string | undefined => TICKET.exec(text)?.[0]

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** A commit subject or session title without its ticket key, conventional-commit prefix and `(#1904)`. */
const describe = (text: string): string =>
  capitalise(
    text
      .replace(MERGED_PR, '')
      .replace(TICKET, '')
      .replace(/^\W+/, '')
      .replace(/^\w+(\([^)]*\))?!?:\s*/, '')
      .trim(),
  )

/**
 * One line per ticket from its commits and sessions: `KEY: <summary> (<where it stands>)`, where it stands being merged
 * (a commit carries the squash-merge `(#1904)`), PR opened (a session asked to open one), in progress (commits) or started (sessions only).
 */
export const ticketLines = (commits: readonly Commit[], sessions: readonly AiSession[], facts: TicketFacts = {}): string[] => {
  const tickets = new Map<string, { commits: Commit[]; sessions: AiSession[] }>()
  const entry = (key: string): { commits: Commit[]; sessions: AiSession[] } => {
    const found = tickets.get(key) ?? { commits: [], sessions: [] }
    tickets.set(key, found)
    return found
  }
  for (const commit of commits) {
    const key = ticketOf(commit.subject)
    if (key !== undefined) entry(key).commits.push(commit)
  }
  for (const session of sessions) {
    const key = ticketOf(session.title) ?? ticketOf(session.branch)
    if (key !== undefined && !REVIEW_TITLE.test(session.title)) entry(key).sessions.push(session)
  }
  return [...tickets].map(([key, work]) => {
    const merged = work.commits.map(commit => MERGED_PR.exec(commit.subject)).find(match => match !== null)
    const isOpened = work.sessions.some(session => [session.title, ...session.prompts].some(text => OPENED_PR.test(text)))
    const fact = facts[key]
    const status = fact !== undefined && factTag(fact) !== undefined ? factTag(fact)
      : merged !== undefined ? `merged, PR #${merged[1]}`
      : isOpened ? 'PR opened'
        : work.commits.length > 0 ? 'in progress'
          : 'started'
    const summary = [merged?.input ?? '', ...work.commits.map(commit => commit.subject), ...work.sessions.map(session => session.title)]
      .map(describe)
      .find(text => text !== '') ?? 'Worked on it'
    return `${key}: ${summary} (${status})`
  })
}

/** Bullets that name the same ticket (`KEY: …`) joined into the first one's line, so each ticket is listed once. */
export const oneLinePerTicket = (items: readonly string[]): string[] => {
  const lines: string[] = []
  const byKey = new Map<string, number>()
  for (const item of items) {
    const match = /^([A-Z][A-Z0-9]+-\d+)\s*:\s*(.*)$/.exec(item)
    const key = match?.[1]
    const at = key === undefined ? undefined : byKey.get(key)
    if (match !== null && at !== undefined) {
      lines[at] = `${lines[at]}; ${match[2]}`
      continue
    }
    if (key !== undefined) byKey.set(key, lines.length)
    lines.push(item)
  }
  return lines
}

/**
 * A standup built from the facts alone, for when the model cannot write one: one line per ticket from the commits and
 * `sessions`, then the commits tied to no ticket, then `extra` (session titles with no ticket, the PR reviews line),
 * then the uncommitted changes.
 */
export const fallbackSections = (commits: readonly Commit[], branch: string, dirtyFiles: number, extra: readonly string[] = [], sessions: readonly AiSession[] = [], facts: TicketFacts = {}): Sections => {
  const subjects = [...new Set(commits.filter(commit => ticketOf(commit.subject) === undefined).map(commit => describe(commit.subject)))]
  const update = [...ticketLines(commits, sessions, facts), ...subjects]
  if (update.length > MAX_FALLBACK_ITEMS) update.splice(MAX_FALLBACK_ITEMS, Infinity, `…and ${update.length - MAX_FALLBACK_ITEMS} more`)
  update.push(...extra.filter(item => !update.includes(item)))
  if (dirtyFiles > 0) update.push(`${dirtyFiles} files in progress on ${branch}`)
  return { update: update.length > 0 ? update : ['No commits'], blockers: ['None'] }
}

/** What Jira and GitHub say about one ticket; each part is absent when that source is off or does not know the ticket. */
export type TicketFact = {
  jira?: { status: string; isDone: boolean; assignee: string; isMine: boolean }
  pr?: { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergedAt: string }
}
export type TicketFacts = Record<string, TicketFact>

const TICKETS = /\b[A-Z][A-Z0-9]+-\d+\b/g
const MAX_TICKETS = 25

/** Every ticket key the activity names (commit subjects, session titles, branches and prompts), each once, at most 25. */
export const ticketsOf = (commits: readonly Commit[], sessions: readonly AiSession[]): string[] => {
  const texts = [...commits.map(commit => commit.subject), ...sessions.flatMap(session => [session.title, session.branch, ...session.prompts])]
  return [...new Set(texts.flatMap(text => text.match(TICKETS) ?? []))].slice(0, MAX_TICKETS)
}

/** From `gh pr list --json number,title,state,mergedAt,headRefName`: per ticket of `keys`, the newest PR whose title or branch names it. */
export const prFacts = (raw: unknown, keys: readonly string[]): Record<string, NonNullable<TicketFact['pr']>> => {
  const found: Record<string, NonNullable<TicketFact['pr']>> = {}
  if (!Array.isArray(raw)) return found
  const prs = raw.filter(isRecord).sort((a, b) => number(b.number) - number(a.number))
  for (const key of keys) {
    const named = new RegExp(`\\b${key}\\b`, 'i')
    const pr = prs.find(item => named.test(`${String(item.title ?? '')} ${String(item.headRefName ?? '')}`))
    const state = pr?.state
    if (pr !== undefined && (state === 'OPEN' || state === 'MERGED' || state === 'CLOSED')) {
      found[key] = { number: number(pr.number), state, mergedAt: typeof pr.mergedAt === 'string' ? pr.mergedAt : '' }
    }
  }
  return found
}

/** Where a ticket stands by Jira and GitHub alone: `To Do`, `Dev Testing, PR #1890 merged`, `Blocked, assigned to Jane Doe`; undefined when neither knows. */
export const factTag = (fact: TicketFact): string | undefined => {
  const jira = fact.jira === undefined ? [] : [fact.jira.isMine ? fact.jira.status : `${fact.jira.status}, assigned to ${fact.jira.assignee !== '' ? fact.jira.assignee : 'nobody'}`]
  const pr = fact.pr === undefined ? [] : [`PR #${fact.pr.number} ${fact.pr.state.toLowerCase()}`]
  const tag = [...jira, ...pr].join(', ')
  return tag !== '' ? tag : undefined
}

/** One line for the model: `PROJ-2440: Jira "In Progress", assigned to Jane Doe (not you); PR #1901 merged 2026-11-03`. */
export const factLine = (key: string, fact: TicketFact): string => {
  const jira = fact.jira === undefined ? []
    : [`Jira "${fact.jira.status}"${fact.jira.isDone ? ' (done)' : ''}, ${fact.jira.isMine ? 'assigned to you' : `assigned to ${fact.jira.assignee !== '' ? fact.jira.assignee : 'nobody'} (not you)`}`]
  const pr = fact.pr === undefined ? [] : [`PR #${fact.pr.number} ${fact.pr.state.toLowerCase()}${fact.pr.mergedAt !== '' ? ` ${fact.pr.mergedAt.slice(0, 10)}` : ''}`]
  return `${key}: ${[...jira, ...pr].join('; ')}`
}

/**
 * The tickets the work was on: those in commit subjects, in the titles and branches of sessions that are no reviews, and
 * in the prompts of those sessions when the session is itself on a ticket (PROJ-2479 created during PROJ-2425's
 * spike). A session on no ticket (tooling, this standup) adds none from its prompts.
 */
export const workedTickets = (commits: readonly Commit[], sessions: readonly AiSession[]): Set<string> => {
  const onTickets = sessions.filter(session => !REVIEW_TITLE.test(session.title) && TICKET.test(`${session.title} ${session.branch}`))
  return new Set([
    ...commits.flatMap(commit => commit.subject.match(TICKETS) ?? []),
    ...onTickets.flatMap(session => [session.title, session.branch, ...session.prompts].join(' ').match(TICKETS) ?? []),
  ])
}

const STATUS_END = /\s*\((?:started|in progress|PR opened|merged[^)]*)\)\s*\.?$/i

/**
 * Each bullet on one ticket: a sentence of `KEY: …` that names another ticket moves to that ticket's bullet (made when it
 * has none and it is in `worked`, its key read as "the ticket"); elsewhere the other key is cut. A bullet on no ticket
 * loses the status the model tacked on.
 */
export const oneTicketPerBullet = (items: readonly string[], worked: ReadonlySet<string>): string[] => {
  const moved: string[] = []
  const kept = items.map(item => {
    const match = /^([A-Z][A-Z0-9]+-\d+)\s*:\s*(.*)$/.exec(item)
    if (match === null) return item.replace(STATUS_END, '')
    const [, key = '', text = ''] = match
    const sentences = text.split(/(?<=[.;])\s+/)
    const own = sentences.filter(sentence => {
      const other = (sentence.match(TICKETS) ?? []).find(found => found !== key)
      if (other === undefined) return true
      if (!worked.has(other)) return true
      moved.push(`${other}: ${capitalise(sentence.replace(new RegExp(`\\b${other}\\b`, 'g'), 'the ticket').replace(/\s*\([^()]*\)\s*\.?$/, '').replace(/[.;]$/, '').trim())}`)
      return false
    })
    const rest = (own.length > 0 ? own : sentences).join(' ').replace(TICKETS, found => (found === key || worked.has(found) ? found : 'a ticket'))
    return `${key}: ${rest}`
  })
  return oneLinePerTicket([...kept, ...moved])
}

const REVIEW_BULLET = /review|revis/i

/** The update with every bullet about PR reviews replaced by `prLine`, once, at the end; unchanged without a line. */
export const oneReviewLine = (items: readonly string[], prLine: string | undefined): string[] =>
  prLine === undefined ? [...items]
    : [...items.filter(item => !(REVIEW_BULLET.test(item) && /#\d+|\bPRs?\b|pull request/i.test(item))), prLine]

/**
 * The model's bullets held to the facts: a bullet whose ticket is not in `worked` (one only named inside prompts) is
 * dropped, and a ticket Jira or GitHub knows ends with where it stands by them in place of the model's guess.
 */
export const settleTickets = (items: readonly string[], facts: TicketFacts, worked: ReadonlySet<string>): string[] =>
  items.flatMap(item => {
    const match = /^([A-Z][A-Z0-9]+-\d+)\s*:\s*(.*)$/.exec(item)
    if (match === null) return [item]
    const [, key = '', text = ''] = match
    if (!worked.has(key)) return []
    const fact = facts[key]
    const tag = fact === undefined ? undefined : factTag(fact)
    return [tag === undefined ? item : `${key}: ${text.replace(/\s*\([^()]*\)\s*\.?$/, '').replace(/[.;]$/, '')} (${tag})`]
  })

/** The paste-ready text: plain (works anywhere), markdown, or Slack's own bold and bullets. */
export const formatSections = (sections: Sections, style: Style): string => {
  const heading = (title: string): string =>
    style === 'markdown' ? `**${title}**` : style === 'slack' ? `*${title}*` : `${title}:`
  const bullet = style === 'slack' ? '•' : '-'
  const block = (title: string, items: readonly string[]): string =>
    [heading(title), ...(items.length > 0 ? items : ['None']).map(item => `${bullet} ${item}`)].join('\n')
  const blockers = sections.blockers.filter(item => !/^none\.?$/i.test(item))
  return [
    sections.update.map(item => `${bullet} ${item}`).join('\n'),
    ...(blockers.length > 0 ? [block('Blockers', blockers)] : []),
  ].join('\n\n')
}

/** What mods-hub's sessions.json says about the other Claude sessions on this project: how many, their turns and cost, and the commits their heartbeats carry. */
export type Neighbours = { commits: Commit[]; sessions: number; turns: number; usd: number }

const NONE: Neighbours = { commits: [], sessions: 0, turns: 0, usd: 0 }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const isInside = (cwd: unknown, root: string): boolean => typeof cwd === 'string' && (cwd === root || cwd.startsWith(`${root.replace(/[\\/]+$/, '')}/`))

/**
 * Reads the hub's `sessions.json` (session id → heartbeat): the sessions that work inside `root` other than `own`, and the
 * `git.commit` events any of them (this one included) published with scope `global` since `sinceMs`. `day` formats a time as `YYYY-MM-DD`.
 */
export const neighboursOf = (raw: unknown, root: string, own: string, sinceMs: number, day: (ms: number) => string): Neighbours => {
  if (!isRecord(raw)) return NONE
  const result: Neighbours = { commits: [], sessions: 0, turns: 0, usd: 0 }
  for (const [id, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || !isInside(entry.cwd, root)) continue
    if (id !== own) {
      result.sessions += 1
      result.turns += number(entry.turns)
      result.usd += number(entry.usd)
    }
    for (const event of Array.isArray(entry.events) ? entry.events : []) {
      if (!isRecord(event) || event.topic !== 'git.commit' || number(event.at) < sinceMs || !isRecord(event.data)) continue
      const { sha, message } = event.data
      if (typeof sha === 'string' && typeof message === 'string' && message.trim() !== '') {
        result.commits.push({ date: day(number(event.at)), hash: sha.slice(0, 7), subject: (message.split('\n')[0] ?? '').trim() })
      }
    }
  }
  return result
}

/** The commits of `extra` that `known` (from git log) does not list, by hash, each once. */
export const unseenCommits = (known: readonly Commit[], extra: readonly Commit[]): Commit[] => {
  const seen = new Set(known.map(commit => commit.hash))
  return extra.filter(commit => !seen.has(commit.hash) && (seen.add(commit.hash), true))
}

/** One Claude Code or Codex session with your prompts in the window, as scripts/sessions.py prints it. */
export type AiSession = { source: 'claude' | 'codex'; cwd: string; branch: string; title: string; start: string; prompts: string[] }

const isText = (value: unknown): value is string => typeof value === 'string'

/** Reads scripts/sessions.py's JSON; undefined when it is not that shape. */
export const parseAiSessions = (stdout: string): AiSession[] | undefined => {
  try {
    const raw: unknown = JSON.parse(stdout)
    if (!Array.isArray(raw)) return undefined
    return raw.filter(
      (item): item is AiSession =>
        isRecord(item) && (item.source === 'claude' || item.source === 'codex') && isText(item.cwd) && isText(item.branch) && isText(item.title) && isText(item.start) && Array.isArray(item.prompts) && item.prompts.every(isText),
    )
  } catch {
    return undefined
  }
}

const SESSIONS_TOTAL = 9_000

/** The sessions for the model, oldest first, one line each: day, tool, folder, branch, title and your prompts. `day` formats a time as `YYYY-MM-DD`. */
export const formatAiSessions = (sessions: readonly AiSession[], day: (ms: number) => string): string =>
  sessions
    .map(session => {
      const folder = session.cwd.split(/[\\/]/).filter(part => part !== '').slice(-2).join('/')
      const title = session.title !== '' ? ` · "${session.title}"` : ''
      const branch = session.branch !== '' && session.branch !== 'HEAD' ? ` · branch ${session.branch}` : ''
      return `- ${day(Date.parse(session.start))} ${session.source} · ${folder}${branch}${title}: ${session.prompts.join(' | ')}`
    })
    .join('\n')
    .slice(0, SESSIONS_TOTAL)

const REVIEW = /review|revis|sherlock/i
const PR_NUMBER = /(?:\bPRs?\s*#?\s*|pull\/|pr-review\s+#?|review\s+#)(\d{2,6})\b/gi
const OWN_PR = /\(#(\d+)\)/g

/**
 * The pull requests the sessions reviewed: a session whose title or prompts speak of a review, and the PR numbers they
 * name (`PR #1913`, `/dev-flow:pr-review 1913`, `review #142`, `pull/1913`). Your own merged PRs (`(#1904)` in a commit) are left out.
 */
export const reviewedPrs = (sessions: readonly AiSession[], commits: readonly Commit[]): number[] => {
  const own = new Set(commits.flatMap(commit => [...commit.subject.matchAll(OWN_PR)].map(match => Number(match[1]))))
  const found = new Set<number>()
  for (const session of sessions) {
    const text = [session.title, ...session.prompts].join('\n')
    if (!REVIEW.test(text)) continue
    for (const match of text.matchAll(PR_NUMBER)) {
      const number = Number(match[1])
      if (!own.has(number)) found.add(number)
    }
  }
  return [...found].sort((a, b) => a - b)
}

/** "PR #1 reviewed", "PRs #1 and #2 reviewed", "PRs #1, #2, and #3 reviewed"; undefined for none. */
export const reviewedLine = (prs: readonly number[]): string | undefined => {
  const tags = prs.map(pr => `#${pr}`)
  if (tags.length === 0) return undefined
  if (tags.length === 1) return `PR ${tags[0]} reviewed`
  if (tags.length === 2) return `PRs ${tags[0]} and ${tags[1]} reviewed`
  return `PRs ${tags.slice(0, -1).join(', ')}, and ${tags.at(-1)} reviewed`
}
