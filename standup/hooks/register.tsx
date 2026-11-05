import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StandupView } from '../types'
import { defaultDays, factLine, fallbackSections, formatAiSessions, formatSections, lastStandup, momentLabel, neighboursOf, oneLinePerTicket, parseAiSessions, parseLog, parseMeeting, parseSections, oneReviewLine, oneTicketPerBullet, parseSvnLog, prFacts, REVIEW_TITLE, reviewedLine, reviewedPrs, settleTickets, sinceLabel, ticketOf, ticketsOf, unseenCommits, workedTickets } from './standup'
import type { AiSession, Commit, Meeting, Neighbours, Style, TicketFact, TicketFacts } from './standup'
import { paneFailure } from './shared/render-safe'

const PANE = 'standup'
const GIT_TIMEOUT_MS = 15_000
/** `svn log` asks the server, so it gets longer than git's local reads. */
const SVN_TIMEOUT_MS = 30_000
/** The svn entries read before keeping only yours: a branch others commit to has more than MAX_COMMITS of theirs. */
const SVN_LOG_LIMIT = 500
const MODEL_TIMEOUT_MS = 60_000
const MODEL_MAX_TOKENS = 2_000
/** `gh pr list` and the Jira lookups go over the network. */
const FACTS_TIMEOUT_MS = 45_000
const PR_LIMIT = 100
/** scripts/sessions.py reads every transcript touched in the window; a resumed session can be tens of MB. */
const SESSIONS_TIMEOUT_MS = 90_000
const MAX_COMMITS = 80
const MAX_DAYS = 30
const DAY_MS = 86_400_000
/** mods-hub's heartbeat file: one entry per live session, with its last global events. */
const HUB_SESSIONS = '.claude/claude-mods/hub/sessions.json'
const JOURNAL_DIR = '.claude/journal'
const JOURNAL_FILE = /^(\d{4}-\d{2}-\d{2}).*\.md$/
const JOURNAL_CHARS = 2_500
const JOURNAL_TOTAL = 6_000
const STYLES: readonly Style[] = ['plain', 'markdown', 'slack']
/** How many repositories are read at once when the standup covers several. */
const REPO_BATCH = 8

const SYSTEM = [
  'You write the update a software engineer gives at their daily standup from their real activity since the last standup: commits, AI coding sessions (Claude Code, Codex) and notes.',
  'Sessions are work too: investigation, brainstorming, spikes, testing, ticket refinement and reviews.',
  'Write one list, each bullet "<TICKET>: <what was done>", where <TICKET> is the Jira key (PROJ-2458, CORE-8061) or requirement (REQ-012) in upper case:',
  'exactly one bullet per ticket and one ticket per bullet (never name a second ticket key in a bullet), merging all its commits and sessions into one summary under 25 words, with the next step when the activity shows one,',
  'ending with where the ticket stands: (started), (in progress), (PR opened) or (merged, PR #1904).',
  'A ticket the prompts show the engineer created or refined while on another ticket gets its own bullet (PROJ-2479: Opened the ticket for the column change), and the other ticket\'s bullet does not name it.',
  'A session title names the whole session, which may have begun before the last standup: summarise only what the prompts given show (all of them came after it), never work the title implies but the prompts do not show.',
  'When "Ticket status" lines are given, they are facts from Jira and GitHub and win over what the activity suggests; never call a ticket in To Do started.',
  'A commit subject ending in "(#1904)" is a merged pull request; a session that asked to open a PR means PR opened.',
  'Take ticket keys only from the activity; never invent one or any work.',
  'Work tied to no ticket gets a plain bullet with no prefix and no status at the end.',
  'Leave pull request reviews out entirely: the reviews line is added for you.',
  'Use plain English a teammate understands (no hashes, no conventional-commit prefixes), even when the prompts are in another language.',
  'Under BLOCKERS list only what the activity shows blocking the engineer; when nothing does, answer None.',
].join(' ')

const viewAtom = atom({ plugin: 'standup', key: 'view' } as const, null)

/** `svnAuthor` is your svn user name; empty leaves svn working copies out. */
/**
 * `sessionDirs`: Claude Code projects and Codex sessions folders (`~` is your home), none to leave sessions out;
 * `sessionScope`: the folders a session must work in, none for the folder that holds the repository.
 */
/**
 * `meeting`: the daily standup, whose latest occurrence starts the window (undefined: midnight of the last workday);
 * `jiraApi`: the Jira REST API v3 base whose tickets' status and assignee are read ('' leaves Jira out).
 */
type Settings = { model: string; style: Style; allBranches: boolean; svnAuthor: string; sessionDirs: string[]; sessionScope: string[]; meeting: Meeting | undefined; jiraApi: string; isHubbed: boolean }
type RepoRoot = { root: string; name: string; vcs: 'git' | 'svn' }
/** One repository's activity; `author` is empty when git knows no user there (every author counts then). */
type RepoActivity = { name: string; author: string; commits: Commit[]; branch: string; dirtyFiles: number; journal: string; isLogFailed: boolean }
type Activity = {
  author: string
  commits: Commit[]
  branch: string
  dirtyFiles: number
  journal: string
  /** The repositories with activity when the standup covers several (run outside a repository); empty for one. */
  repos: RepoActivity[]
  /** The repositories whose log could not be read (svn offline, git failing). */
  failedLogs: string[]
  /** Other sessions of this project and their commits, from the hub; none without it. */
  neighbours: Neighbours
  /** Your Claude Code and Codex sessions with prompts in the window, oldest first. */
  sessions: AiSession[]
  /** Whether the session transcripts could not be read (no python3, a failing script). */
  isSessionsFailed: boolean
  /** What Jira and GitHub say about the tickets the activity names. */
  facts: TicketFacts
  /** The sources of `facts` that could not be read (`PRs (gh)`, `Jira`). */
  failedFacts: string[]
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Local midnight of the day `ms` falls on, the start git's `N days ago midnight` means. */
const startOfDay = (ms: number): number => {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const isoDay = (ms: number): string => {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

async function git($: EngineInterface, args: readonly string[], cwd?: string): Promise<string | undefined> {
  try {
    const run = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout : undefined
  } catch {
    return undefined
  }
}

async function svn($: EngineInterface, args: readonly string[], cwd?: string): Promise<string | undefined> {
  try {
    const run = await $.process.run(['svn', '--non-interactive', ...args], { cwd, timeoutMs: SVN_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout : undefined
  } catch {
    return undefined
  }
}

async function readJournal($: EngineInterface, root: string, since: string): Promise<string> {
  try {
    const entries = await $.fs.list(`${root}/${JOURNAL_DIR}`)
    const days = entries
      .filter(entry => entry.kind === 'file' && (JOURNAL_FILE.exec(entry.name)?.[1] ?? '') >= since)
      .map(entry => entry.name)
      .sort()
    let journal = ''
    for (const name of days) {
      if (journal.length >= JOURNAL_TOTAL) break
      const text = await $.fs.read(`${root}/${JOURNAL_DIR}/${name}`)
      journal += `### ${name}\n${text.trim().slice(0, JOURNAL_CHARS)}\n\n`
    }
    return journal.slice(0, JOURNAL_TOTAL).trim()
  } catch {
    return '' // No journal: git history alone.
  }
}

/** The other Claude sessions on this project, from the hub's sessions.json (their commits may be on branches this log does not reach); nothing without the hub. */
async function readNeighbours($: EngineInterface, root: string, sinceMs: number): Promise<Neighbours> {
  const none: Neighbours = { commits: [], sessions: 0, turns: 0, usd: 0 }
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') return none
    const raw: unknown = JSON.parse(await $.fs.read(`${home}/${HUB_SESSIONS}`))
    return neighboursOf(raw, root, await $.session.id(), sinceMs, isoDay)
  } catch {
    return none
  }
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello (this mod reads `git.commit` and the other sessions' heartbeats in sessions.json). */
async function greetHub($: EngineInterface, settings: Settings): Promise<void> {
  if ((await hubMode($)) === undefined) return
  settings.isHubbed = await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['git.commit', 'session.ended'] })
}

const list = (text: string): string[] => text.split(',').map(item => item.trim()).filter(item => item !== '')

/** Your Claude Code and Codex sessions with prompts since `sinceMs`, read by scripts/sessions.py (transcripts outgrow `$.fs.read`). */
async function readSessions($: EngineInterface, settings: Settings, base: string, sinceMs: number): Promise<{ sessions: AiSession[]; isFailed: boolean }> {
  if (settings.sessionDirs.length === 0) return { sessions: [], isFailed: false }
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const dirs = settings.sessionDirs.map(dir => dir.replace(/^~(?=$|\/)/, home))
  const scopes = settings.sessionScope.length > 0 ? settings.sessionScope : [base.slice(0, base.lastIndexOf('/'))].filter(scope => scope !== '')
  if (scopes.length === 0) return { sessions: [], isFailed: false }
  try {
    const request = JSON.stringify({ since: sinceMs, dirs, scopes })
    const run = await $.process.run(['python3', '-I', `${$.plugin.root}/scripts/sessions.py`, request], { timeoutMs: SESSIONS_TIMEOUT_MS })
    const sessions = run.exitCode === 0 ? parseAiSessions(run.stdout) : undefined
    return sessions === undefined ? { sessions: [], isFailed: true } : { sessions, isFailed: false }
  } catch {
    return { sessions: [], isFailed: true }
  }
}

const subdirs = async ($: EngineInterface, dir: string): Promise<string[]> =>
  (await $.fs.list(dir).catch(() => [])).filter(entry => entry.kind === 'dir').map(entry => entry.name).sort()
const exists = ($: EngineInterface, path: string): Promise<boolean> => $.fs.exists(path).catch(() => false)

/**
 * The repository you are in; outside one, every repository directly inside the current folder. With `svnAuthor` set, svn
 * working copies count too, and a folder that is no repository is looked into one level down for svn working copies only
 * (`customer-branches/GLOBEX`), never deeper.
 */
async function findRepos($: EngineInterface, settings: Settings): Promise<{ base: string; repos: RepoRoot[] }> {
  const named = (root: string, vcs: RepoRoot['vcs']): RepoRoot => ({ root, name: root.slice(root.lastIndexOf('/') + 1), vcs })
  const root = (await git($, ['rev-parse', '--show-toplevel']))?.trim()
  if (root !== undefined && root !== '') return { base: root, repos: [named(root, 'git')] }
  const isSvnOn = settings.svnAuthor !== ''
  const wcRoot = isSvnOn ? (await svn($, ['info', '--show-item', 'wc-root']))?.trim() : undefined
  if (wcRoot !== undefined && wcRoot !== '') return { base: wcRoot, repos: [named(wcRoot, 'svn')] }
  const cwd = (await $.session.cwd().catch(() => '')).replace(/\/+$/, '')
  if (cwd === '') return { base: '', repos: [] }
  const found = await Promise.all(
    (await subdirs($, cwd)).map(async (name): Promise<RepoRoot[]> => {
      const dir = `${cwd}/${name}`
      if (await exists($, `${dir}/.git`)) return [{ root: dir, name, vcs: 'git' }]
      if (!isSvnOn) return []
      if (await exists($, `${dir}/.svn`)) return [{ root: dir, name, vcs: 'svn' }]
      const inner = await subdirs($, dir)
      const isSvn = await Promise.all(inner.map(child => exists($, `${dir}/${child}/.svn`)))
      return inner.filter((_, index) => isSvn[index] === true).map(child => ({ root: `${dir}/${child}`, name: `${name}/${child}`, vcs: 'svn' }))
    }),
  )
  return { base: cwd, repos: found.flat() }
}

async function gatherGit($: EngineInterface, settings: Settings, repo: RepoRoot, sinceMs: number): Promise<RepoActivity> {
  const { root } = repo
  const email = (await git($, ['config', 'user.email'], root))?.trim() ?? ''
  const author = email !== '' ? email : (await git($, ['config', 'user.name'], root))?.trim() ?? ''
  const log = await git(
    $,
    [
      'log',
      ...(settings.allBranches ? ['--all'] : []),
      '--no-merges',
      `--since=${new Date(sinceMs).toISOString()}`,
      '--date=short',
      '--format=%ad%x09%h%x09%s',
      `--max-count=${MAX_COMMITS}`,
      ...(author !== '' ? ['--fixed-strings', `--author=${author}`] : []),
    ],
    root,
  )
  const status = (await git($, ['status', '--porcelain=v1', '--branch'], root)) ?? ''
  const [head = '', ...changed] = status.split('\n').filter(line => line.trim() !== '')
  const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(head)?.[1] ?? 'the current branch'
  const journal = await readJournal($, root, isoDay(sinceMs))
  return { name: repo.name, author, commits: parseLog(log ?? ''), branch, dirtyFiles: changed.length, journal, isLogFailed: log === undefined }
}

async function gatherSvn($: EngineInterface, settings: Settings, repo: RepoRoot, sinceMs: number): Promise<RepoActivity> {
  const since = isoDay(sinceMs)
  const log = await svn($, ['log', '--xml', '-r', `HEAD:{${since}}`, `--limit=${SVN_LOG_LIMIT}`], repo.root)
  // -q leaves unversioned files out; a status line starts with its change (A, C, D, M, R, !, ~) or, for a property change, a space then M.
  const status = (await svn($, ['status', '-q'], repo.root)) ?? ''
  const url = (await svn($, ['info', '--show-item', 'relative-url'], repo.root))?.trim() ?? ''
  return {
    name: repo.name,
    author: settings.svnAuthor,
    commits: parseSvnLog(log ?? '', settings.svnAuthor, sinceMs, isoDay).slice(0, MAX_COMMITS),
    branch: url !== '' ? url.replace(/^\^\//, '') : 'the working copy',
    dirtyFiles: status.split('\n').filter(line => /^([ACDMR!~]| M)/.test(line)).length,
    journal: await readJournal($, repo.root, since),
    isLogFailed: log === undefined,
  }
}

async function gather($: EngineInterface, settings: Settings, sinceMs: number): Promise<Activity | { error: string }> {
  const { base, repos } = await findRepos($, settings)
  if (repos.length === 0) return { error: `Not inside a ${settings.svnAuthor !== '' ? 'git or svn' : 'git'} repository, and none in this folder.` }
  const found: RepoActivity[] = []
  for (let i = 0; i < repos.length; i += REPO_BATCH) {
    const batch = repos.slice(i, i + REPO_BATCH)
    found.push(...(await Promise.all(batch.map(repo => (repo.vcs === 'git' ? gatherGit($, settings, repo, sinceMs) : gatherSvn($, settings, repo, sinceMs))))))
  }
  const failedLogs = found.filter(repo => repo.isLogFailed).map(repo => repo.name)
  const neighbours = settings.isHubbed ? await readNeighbours($, base, sinceMs) : { commits: [], sessions: 0, turns: 0, usd: 0 }
  const { sessions, isFailed: isSessionsFailed } = await readSessions($, settings, base, sinceMs)
  const gitRoots = repos.filter(repo => repo.vcs === 'git').map(repo => repo.root)
  const [only] = found
  if (found.length === 1 && only !== undefined) {
    const extra = unseenCommits(only.commits, neighbours.commits)
    // The log is newest first; commits other sessions made slot in by their day.
    const commits = extra.length === 0 ? only.commits : [...only.commits, ...extra].sort((a, b) => b.date.localeCompare(a.date))
    const { author, branch, dirtyFiles, journal } = only
    const { facts, failedFacts } = await readFacts($, settings, gitRoots, ticketsOf(commits, sessions))
    return { author: author !== '' ? author : 'all authors', commits, branch, dirtyFiles, journal, repos: [], failedLogs, neighbours, sessions, isSessionsFailed, facts, failedFacts }
  }
  const active = found.filter(repo => repo.commits.length > 0 || repo.dirtyFiles > 0 || repo.journal !== '')
  const listed = active.flatMap(repo => repo.commits.map(commit => ({ ...commit, repo: repo.name })))
  const commits = [...listed, ...unseenCommits(listed, neighbours.commits)].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_COMMITS)
  const { facts, failedFacts } = await readFacts($, settings, gitRoots, ticketsOf(commits, sessions))
  return {
    author: [...new Set(found.map(repo => (repo.author !== '' ? repo.author : 'all authors')))].join(', '),
    commits,
    branch: active.map(repo => `${repo.name} (${repo.branch})`).join(', '),
    dirtyFiles: active.reduce((sum, repo) => sum + repo.dirtyFiles, 0),
    journal: active.filter(repo => repo.journal !== '').map(repo => `## ${repo.name}\n${repo.journal}`).join('\n\n').slice(0, JOURNAL_TOTAL),
    repos: active,
    failedLogs,
    neighbours,
    sessions,
    isSessionsFailed,
    facts,
    failedFacts,
  }
}

/** Your pull requests in each git repository, by `gh pr list`; undefined when gh could read none. */
async function readPrs($: EngineInterface, roots: readonly string[]): Promise<unknown[] | undefined> {
  const lists = await Promise.all(
    roots.map(async root => {
      try {
        // An ssh host alias (git@github-work:owner/repo.git) is no host gh knows, so the repository is named from the remote.
        const remote = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec((await git($, ['remote', 'get-url', 'origin'], root))?.trim() ?? '')
        const repo = remote === null ? [] : ['--repo', `${remote[1]}/${remote[2]}`]
        const args = ['gh', 'pr', 'list', ...repo, '--state', 'all', '--author', '@me', '--limit', String(PR_LIMIT), '--json', 'number,title,state,mergedAt,headRefName']
        const run = await $.process.run(args, { cwd: root, timeoutMs: FACTS_TIMEOUT_MS })
        const parsed: unknown = run.exitCode === 0 ? JSON.parse(run.stdout) : undefined
        return Array.isArray(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    }),
  )
  const read = lists.filter((list): list is unknown[] => list !== undefined)
  return read.length === 0 && roots.length > 0 ? undefined : read.flat()
}

/** Status and assignee of each ticket, by scripts/jira.py; undefined when Jira could not be read (no credentials, no python3). */
async function readJira($: EngineInterface, settings: Settings, roots: readonly string[], keys: readonly string[]): Promise<Record<string, NonNullable<TicketFact['jira']>> | undefined> {
  const [first] = roots
  const name = first === undefined ? '' : ((await git($, ['config', 'user.name'], first))?.trim() ?? '')
  try {
    const request = JSON.stringify({ api: settings.jiraApi, keys, name })
    const run = await $.process.run(['python3', '-I', `${$.plugin.root}/scripts/jira.py`, request], { timeoutMs: FACTS_TIMEOUT_MS })
    const parsed: unknown = run.exitCode === 0 ? JSON.parse(run.stdout) : undefined
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, NonNullable<TicketFact['jira']>>) : undefined
  } catch {
    return undefined
  }
}

/** What GitHub (your PRs) and Jira (with `jiraApi` set) say about `keys`, and the sources that could not be read. */
async function readFacts($: EngineInterface, settings: Settings, roots: readonly string[], keys: readonly string[]): Promise<{ facts: TicketFacts; failedFacts: string[] }> {
  if (keys.length === 0) return { facts: {}, failedFacts: [] }
  const [prs, jira] = await Promise.all([readPrs($, roots), settings.jiraApi !== '' ? readJira($, settings, roots, keys) : Promise.resolve<Record<string, NonNullable<TicketFact['jira']>>>({})])
  const byPr = prFacts(prs ?? [], keys)
  const facts: TicketFacts = {}
  for (const key of keys) {
    const fact: TicketFact = { ...(byPr[key] !== undefined ? { pr: byPr[key] } : {}), ...(jira?.[key] !== undefined ? { jira: jira[key] } : {}) }
    if (fact.pr !== undefined || fact.jira !== undefined) facts[key] = fact
  }
  return { facts, failedFacts: [...(prs === undefined ? ['PRs (gh)'] : []), ...(jira === undefined ? ['Jira'] : [])] }
}

const promptFor = (activity: Activity, period: string, prLine: string | undefined): string =>
  [
    `Period: ${period}, author ${activity.author}`,
    ...(activity.repos.length === 0
      ? [`Branch: ${activity.branch} · ${plural(activity.dirtyFiles, 'file', 'files')} with uncommitted changes`]
      : [
          `Repositories (${activity.repos.length}); name the repository in a bullet when it helps the reader:`,
          ...activity.repos.map(repo => `- ${repo.name}: ${repo.branch} · ${plural(repo.dirtyFiles, 'file', 'files')} with uncommitted changes`),
        ]),
    '',
    'Commits (newest first):',
    activity.commits.length === 0 ? '(none)' : activity.commits.map(c => `${c.date}  ${c.repo === undefined ? '' : `[${c.repo}] `}${c.subject}`).join('\n'),
    ...(activity.journal !== '' ? ['', 'Journal notes:', activity.journal] : []),
    ...(activity.sessions.length > 0
      ? ['', "AI sessions (Claude Code and Codex), oldest first, each with the engineer's own prompts:", formatAiSessions(activity.sessions, isoDay)]
      : []),
    ...(Object.keys(activity.facts).length > 0
      ? ['', 'Ticket status from Jira and GitHub:', ...Object.entries(activity.facts).map(([key, fact]) => `- ${factLine(key, fact)}`)]
      : []),
    ...(activity.neighbours.sessions > 0
      ? ['', `Other Claude sessions on this project right now: ${activity.neighbours.sessions} (${activity.neighbours.turns} turns, $${activity.neighbours.usd.toFixed(2)} so far).`]
      : []),
    '',
    'Answer with exactly these two headings, each followed by "- " bullets, and nothing else:',
    'UPDATE:',
    'BLOCKERS:',
  ].join('\n')

/** Where the standup starts: the `count`-th latest standup meeting, or without one midnight `count` days back. */
const windowOf = (now: number, settings: Settings, count: number): { sinceMs: number; label: string; period: string } => {
  if (settings.meeting === undefined) {
    return { sinceMs: startOfDay(now - count * DAY_MS), label: sinceLabel(now, count), period: `since ${sinceLabel(now, count)} (${plural(count, 'day', 'days')})` }
  }
  const sinceMs = lastStandup(now, settings.meeting, count)
  const label = `the standup of ${momentLabel(sinceMs)}`
  return { sinceMs, label, period: `since ${label}${count > 1 ? ` (${count} standups back)` : ', the last one'}` }
}

async function generate($: EngineInterface, settings: Settings, days: number): Promise<StandupView> {
  const now = await $.clock.now()
  const { sinceMs, label, period } = windowOf(now, settings, days)
  const set = async (view: StandupView): Promise<StandupView> => {
    await update($, viewAtom, () => view)
    return view
  }
  await set({ status: 'working', text: '', detail: `Reading your git history and sessions since ${label}…`, days })
  const activity = await gather($, settings, sinceMs)
  if ('error' in activity) return set({ status: 'error', text: activity.error, detail: '', days })
  const failed = [
    ...(activity.failedLogs.length > 0 ? [` · could not read the log of ${activity.failedLogs.join(', ')}`] : []),
    ...(activity.isSessionsFailed ? [' · could not read your Claude Code and Codex sessions (python3)'] : []),
    ...(activity.failedFacts.length > 0 ? [` · could not read ${activity.failedFacts.join(' or ')}`] : []),
  ].join('')
  if (activity.commits.length === 0 && activity.journal === '' && activity.dirtyFiles === 0 && activity.sessions.length === 0) {
    return set({
      status: 'empty',
      text: `Nothing to report: no commits by ${activity.author}, sessions or journal notes since ${label}.`,
      detail: `Try a longer window, e.g. /standup 7.${failed}`,
      days,
    })
  }
  const prLine = reviewedLine(reviewedPrs(activity.sessions, activity.commits))
  const answer = await $.model
    .complete({ model: settings.model, system: SYSTEM, prompt: promptFor(activity, period, prLine), maxTokens: MODEL_MAX_TOKENS, effort: 'low', timeoutMs: MODEL_TIMEOUT_MS })
    .catch(() => undefined)
  const parsed = answer?.isAnswered === true ? parseSections(answer.text) : undefined
  const worked = workedTickets(activity.commits, activity.sessions)
  const sections = parsed === undefined ? undefined : { ...parsed, update: oneReviewLine(settleTickets(oneTicketPerBullet(oneLinePerTicket(parsed.update), worked), activity.facts, worked), prLine) }
  const why =
    answer === undefined ? 'the model was not available'
      : !answer.isAnswered ? `the model answered ${answer.reason}`
        : 'the reply was not in standup shape'
  const source = sections === undefined ? `listed from git and sessions (${why})` : `written by ${settings.model}`
  const repos = activity.repos.length > 0 ? ` in ${plural(activity.repos.length, 'repo', 'repos')}` : ''
  const sessionCount = activity.sessions.length > 0 ? ` + ${plural(activity.sessions.length, 'session', 'sessions')}` : ''
  const found = `${plural(activity.commits.length, 'commit', 'commits')}${repos}${sessionCount}${activity.journal !== '' ? ' + journal' : ''} since ${label}`
  const titles = activity.sessions
    .filter(session => ticketOf(session.title) === undefined && ticketOf(session.branch) === undefined)
    .map(session => session.title)
    .filter(title => title !== '' && !REVIEW_TITLE.test(title))
  const extra = [...new Set(titles), ...(prLine !== undefined ? [prLine] : [])]
  return set({
    status: 'ready',
    text: formatSections(sections ?? fallbackSections(activity.commits, activity.branch, activity.dirtyFiles, extra, activity.sessions, activity.facts), settings.style),
    detail: `${found} · ${source}${failed}`,
    days,
  })
}

export const register: Register = (on, options) => {
  const style = String(options.style ?? 'plain')
  const settings: Settings = {
    model: String(options.model ?? '').trim() || 'haiku',
    style: STYLES.find(known => known === style) ?? 'plain',
    allBranches: options.allBranches !== false,
    svnAuthor: String(options.svnAuthor ?? '').trim(),
    sessionDirs: list(String(options.sessionDirs ?? '~/.claude/projects, ~/.codex/sessions')),
    sessionScope: list(String(options.sessionScope ?? '')),
    meeting: parseMeeting(String(options.standupTime ?? ''), String(options.standupTimeZone ?? '').trim()),
    jiraApi: String(options.jiraApi ?? '').trim(),
    isHubbed: false,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'standup',
      description: 'Summarise what you did since your last standup (or workday), from git history and your Claude Code and Codex sessions, ready to paste',
      argumentHint: settings.meeting !== undefined ? '[standups back]' : '[days]',
    })
    afterStart($, 'standup', () => greetHub($, settings))
    return next(e)
  })

  on('command.run', { command: 'standup' }, async ($, e) => {
    const arg = e.args.trim()
    const days = arg !== '' ? Number(arg) : settings.meeting !== undefined ? 1 : defaultDays(await $.clock.now())
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return { text: `${settings.meeting !== undefined ? 'Standups back' : 'Days'} must be a whole number from 1 to ${MAX_DAYS}, e.g. /standup 3.` }
    }
    await $.ui.open({ id: PANE, title: 'Standup', rows: 18 })
    const view = await generate($, settings, days)
    if (view.status === 'error' || view.status === 'empty') return { text: view.text }
    return { text: `${view.detail}. Copy it from the Standup pane.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    if (view === null) return <Text dimColor>Run /standup to write one.</Text>
    const copy = async (surface: typeof e.surface) => {
      const copied = await $.ui.copy({ text: view.text, surface })
      $.ui.toast(copied.isCopied ? 'Copied, ready to paste' : `Could not copy (${copied.reason})`)
    }
    const lines = view.text.split('\n')

    return (
      <Box flexDirection="column" gap={1}>
        {view.status === 'working' && <Text color="suggestion">Writing your standup…</Text>}
        {view.status === 'ready' ? (
          <Box flexDirection="column">
            {lines.map(line =>
              line === '' ? <Text> </Text> : /^[-•]\s/.test(line) ? <Text>{`  ${line}`}</Text> : <Text bold>{line}</Text>,
            )}
          </Box>
        ) : (
          view.status === 'error' ? <Text color="error">{view.text}</Text> : view.text !== '' && <Text>{view.text}</Text>
        )}
        {view.detail !== '' && <Text dimColor wrap="truncate-end">{view.detail}</Text>}
        <Box gap={1}>
          {view.status === 'ready' && (
            <Button key="copy" label="Copy" hotkey="c" variant="primary" onPress={press => void copy(press.surface)} />
          )}
          {view.status !== 'working' && (
            <Button key="regenerate" label="Regenerate" hotkey="r" onPress={() => void generate($, settings, view.days)} />
          )}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'standup', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
