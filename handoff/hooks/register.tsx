import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HandoffView } from '../types'
import { composeNote, decisionsOf, handoffPrompt, missingSections, sectionsOf, stampOf, svnCommitsOf, ticketOf } from './note'
import type { Decision, JiraTicket, RepoFacts, TicketFacts, TicketGit, TicketSession } from './note'
import { paneFailure } from './shared/render-safe'

const PANE = 'handoff'
const GIT_TIMEOUT_MS = 10_000
/** `svn log` asks the server, so it gets longer than the local reads. */
const SVN_LOG_TIMEOUT_MS = 20_000
/** mods-hub's heartbeat file: one entry per live session, with its last global events. */
const HUB_SESSIONS = '.claude/claude-mods/hub/sessions.json'
/** Decisions recorded in the last day count as this work's. */
const DECISION_WINDOW_MS = 24 * 3_600_000
const STATUS_LINES = 40
const STAT_LINES = 30
const MAX_SUFFIX = 20
/** Jira and GitHub answer over the network; the sessions script reads every transcript touched in the window. */
const SCRIPT_TIMEOUT_MS = 45_000
const GH_TIMEOUT_MS = 20_000
const TICKET_COMMITS = 15
const TICKET_WORKTREES = 2
const WORKTREE_STATUS_LINES = 20
const DAY_MS = 86_400_000

const viewAtom = atom({ plugin: 'handoff', key: 'view' } as const, null)

/**
 * `jiraApi`: the Jira REST API v3 base the ticket is read from ('' leaves Jira out). `sessionDirs`: the Claude Code
 * projects and Codex sessions folders searched for sessions on the ticket ([] leaves them out), `sessionDays` back.
 */
type Settings = { dir: string; copy: boolean; jiraApi: string; sessionDirs: string[]; sessionDays: number; isHubbed: boolean }

/** A failure's detail is a lowercase clause; as a command answer it starts a sentence. */
const asSentence = (clause: string): string => clause.charAt(0).toUpperCase() + clause.slice(1)

const capLines = (text: string, max: number): string => {
  const lines = text.trimEnd().split('\n').filter(line => line.trim() !== '')
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more`].join('\n') : lines.join('\n')
}

async function git($: EngineInterface, args: readonly string[]): Promise<string | undefined> {
  try {
    const run = await $.process.run(['git', ...args], { timeoutMs: GIT_TIMEOUT_MS })
    return run.exitCode === 0 ? run.stdout : undefined
  } catch {
    return undefined
  }
}

async function svn($: EngineInterface, args: readonly string[], cwd?: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string | undefined> {
  try {
    const run = await $.process.run(['svn', '--non-interactive', ...args], { cwd, timeoutMs })
    return run.exitCode === 0 ? run.stdout : undefined
  } catch {
    return undefined
  }
}

/** An svn working copy's facts (customer branches): its path in the repository, every changed or unversioned file, the last 5 revisions. */
async function svnFacts($: EngineInterface): Promise<RepoFacts | undefined> {
  const root = (await svn($, ['info', '--show-item', 'wc-root']))?.trim()
  if (root === undefined || root === '') return undefined
  return {
    vcs: 'svn',
    branch: (await svn($, ['info', '--show-item', 'relative-url'], root))?.trim() || root.split('/').pop() || root,
    status: capLines((await svn($, ['status'], root)) ?? '', STATUS_LINES),
    diffStat: '',
    commits: svnCommitsOf((await svn($, ['log', '--xml', '-l', '5'], root, SVN_LOG_TIMEOUT_MS)) ?? ''),
  }
}

/** git facts, or svn's when this is an svn working copy; undefined outside both. */
async function repoFacts($: EngineInterface): Promise<RepoFacts | undefined> {
  const branch = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  if (branch === undefined) return svnFacts($)
  return {
    vcs: 'git',
    branch,
    status: capLines((await git($, ['status', '--short'])) ?? '', STATUS_LINES),
    diffStat: capLines((await git($, ['diff', '--stat', 'HEAD'])) ?? '', STAT_LINES),
    commits: capLines((await git($, ['log', '-5', '--format=%h %s'])) ?? '', 5),
  }
}

/** Runs one of the mod's scripts with a JSON request; its exit code and stdout, or undefined when python3 could not run it. */
async function script($: EngineInterface, name: string, request: unknown): Promise<{ exitCode: number; stdout: string } | undefined> {
  try {
    const run = await $.process.run(['python3', '-I', `${$.plugin.root}/scripts/${name}`, JSON.stringify(request)], { timeoutMs: SCRIPT_TIMEOUT_MS })
    return { exitCode: run.exitCode ?? -1, stdout: run.stdout }
  } catch {
    return undefined
  }
}

async function readJira($: EngineInterface, settings: Settings, key: string): Promise<Pick<TicketFacts, 'jira' | 'jiraError'>> {
  if (settings.jiraApi === '') return { jiraError: 'jiraApi is not set' }
  const run = await script($, 'jira.py', { api: settings.jiraApi, key })
  if (run === undefined) return { jiraError: 'python3 could not run scripts/jira.py' }
  if (run.exitCode === 2) return { jiraError: 'no credentials: JIRA_API_EMAIL and JIRA_API_TOKEN, or ~/.jira-cred' }
  if (run.exitCode !== 0) return { jiraError: 'Jira did not answer for this key (network, permission or a wrong key)' }
  try {
    return { jira: JSON.parse(run.stdout) as JiraTicket }
  } catch {
    return { jiraError: 'Jira answered with something unreadable' }
  }
}

async function readSessions($: EngineInterface, settings: Settings, key: string): Promise<TicketSession[]> {
  if (settings.sessionDirs.length === 0) return []
  const since = (await $.clock.now()) - settings.sessionDays * DAY_MS
  const exclude = await $.session.id().catch(() => '')
  const run = await script($, 'sessions.py', { key, dirs: settings.sessionDirs, since, exclude })
  if (run === undefined || run.exitCode !== 0) return []
  try {
    const sessions: unknown = JSON.parse(run.stdout)
    return Array.isArray(sessions) ? (sessions as TicketSession[]) : []
  } catch {
    return []
  }
}

/** The ticket's branches (any case), the worktrees on them with their uncommitted files, the commits that name it and its PRs. */
async function ticketGit($: EngineInterface, key: string): Promise<TicketGit | undefined> {
  const refs = await git($, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
  if (refs === undefined) return undefined
  const lower = key.toLowerCase()
  const branches = refs.split('\n').map(ref => ref.trim()).filter(ref => ref !== '' && ref.toLowerCase().includes(lower))
  const listed = (await git($, ['worktree', 'list', '--porcelain'])) ?? ''
  const onTicket = listed
    .split('\n\n')
    .map(block => ({ path: /^worktree (.+)$/m.exec(block)?.[1] ?? '', branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? '' }))
    .filter(one => one.path !== '' && one.branch.toLowerCase().includes(lower))
    .slice(0, TICKET_WORKTREES)
  const worktrees = await Promise.all(
    onTicket.map(async one => ({
      name: one.path.split('/').pop() ?? one.path,
      branch: one.branch,
      status: capLines((await git($, ['-C', one.path, 'status', '--short'])) ?? '', WORKTREE_STATUS_LINES),
    })),
  )
  const commits = capLines((await git($, ['log', '--all', '-i', `--grep=${key}`, '--format=%h %ad %s', '--date=short', `-n${TICKET_COMMITS}`])) ?? '', TICKET_COMMITS)
  return { branches, worktrees, commits, prs: await ticketPrs($, key) }
}

/** `owner/repo` of a GitHub remote URL, SSH host aliases included (`git@github-work:owner/repo.git`). */
export const githubRepoOf = (url: string): string | undefined => /[:/]([^/:\s]+\/[^/:\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]

/** The ticket's pull requests by `gh`, one `#n STATE title (branch)` line each; empty when gh is missing or not signed in. */
async function ticketPrs($: EngineInterface, key: string): Promise<string> {
  const repo = githubRepoOf((await git($, ['remote', 'get-url', 'origin'])) ?? '')
  if (repo === undefined) return ''
  try {
    const run = await $.process.run(['gh', 'pr', 'list', '--repo', repo, '--state', 'all', '--search', key, '--json', 'number,title,state,headRefName', '--limit', '5'], { timeoutMs: GH_TIMEOUT_MS })
    if (run.exitCode !== 0) return ''
    const prs = JSON.parse(run.stdout) as { number: number; title: string; state: string; headRefName: string }[]
    return prs.map(pr => `#${pr.number} ${pr.state} ${pr.title} (${pr.headRefName})`).join('\n')
  } catch {
    return ''
  }
}

async function ticketFacts($: EngineInterface, settings: Settings, key: string, vcs: RepoFacts['vcs'] | undefined): Promise<TicketFacts> {
  const [jira, sessions, gitFacts] = await Promise.all([readJira($, settings, key), readSessions($, settings, key), vcs === 'git' ? ticketGit($, key) : Promise.resolve(undefined)])
  return { ...jira, sessions, git: gitFacts }
}

/**
 * The decisions the hub has seen recorded (`decision.recorded`) in the last day: this session's, and those other
 * sessions on the same project published for everyone (the hub's sessions.json); nothing without the hub.
 */
async function hubDecisions($: EngineInterface, root: string, now: number): Promise<Decision[]> {
  const since = now - DECISION_WINDOW_MS
  const events: unknown[] = []
  try {
    events.push(...(await $.mods.recent({ topic: 'decision.recorded' })))
  } catch {
    return []
  }
  try {
    const home = await $.env.get('HOME')
    const sessions: unknown = home === undefined || home === '' ? {} : JSON.parse(await $.fs.read(`${home}/${HUB_SESSIONS}`))
    for (const entry of typeof sessions === 'object' && sessions !== null ? Object.values(sessions) : []) {
      const { cwd, events: own } = (entry ?? {}) as { cwd?: unknown; events?: unknown }
      if (typeof cwd === 'string' && (cwd === root || cwd.startsWith(`${root}/`)) && Array.isArray(own)) events.push(...own)
    }
  } catch {
    // No heartbeat file: this session's decisions are enough.
  }
  return decisionsOf(events, since)
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

/** With mods-hub installed: hello (this mod reads `decision.recorded`, and the other sessions' heartbeats). */
async function greetHub($: EngineInterface, settings: Settings): Promise<void> {
  if ((await hubMode($)) === undefined) return
  settings.isHubbed = await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['decision.recorded', 'session.ended'] })
}

/** `.claude/handoff/2026-10-07-1342.md`, or `-2`, `-3`… when that minute already has one. */
async function freePath($: EngineInterface, dir: string, stamp: string): Promise<string> {
  for (let n = 1; n <= MAX_SUFFIX; n += 1) {
    const path = `${dir}/${stamp}${n === 1 ? '' : `-${n}`}.md`
    if (!(await $.fs.exists(path))) return path
  }
  return `${dir}/${stamp}-${Date.now()}.md`
}

async function writeHandoff($: EngineInterface, settings: Settings, note: string): Promise<HandoffView> {
  const set = async (view: HandoffView): Promise<HandoffView> => {
    await update($, viewAtom, () => view)
    return view
  }
  await set({ status: 'writing', text: '', path: '', isCopied: false, detail: 'Reading the session and git…' })
  const facts = await repoFacts($)
  const ticket = ticketOf(facts?.branch, note)
  if (ticket !== undefined) await set({ status: 'writing', text: '', path: '', isCopied: false, detail: `Reading ${ticket} from Jira, your sessions and git…` })
  const gathered = ticket === undefined ? undefined : await ticketFacts($, settings, ticket, facts?.vcs)
  const decisions = settings.isHubbed ? await hubDecisions($, await $.session.root(), await $.clock.now()) : []
  await set({ status: 'writing', text: '', path: '', isCopied: false, detail: 'Writing the note…' })
  const reply = await $.model.fork({ prompt: handoffPrompt(facts, note, decisions, ticket, gathered) })
  if (!reply.isAnswered) {
    const why =
      reply.reason === 'nothing-to-fork' ? 'nothing to hand off yet: this conversation has no work in it.'
        : reply.reason === 'api-error' ? `the model call failed (${reply.error}).`
          : reply.reason === 'aborted' ? 'writing the note was interrupted.'
            : 'the model wrote nothing.'
    return set({ status: 'error', text: '', path: '', isCopied: false, detail: why })
  }
  const when = await $.clock.now()
  const root = await $.session.root()
  const text = composeNote(sectionsOf(reply.text), { when, branch: facts?.branch, vcs: facts?.vcs, ticket })
  const absolute = await freePath($, `${root}/${settings.dir}${ticket === undefined ? '' : `/${ticket}`}`, stampOf(when))
  await $.fs.write(absolute, text)
  const path = absolute.slice(root.length + 1)
  const isCopied = settings.copy && (await $.ui.copy({ text }).catch(() => ({ isCopied: false }))).isCopied
  const missing = missingSections(text)
  const detail = [
    missing.length === 0 ? '' : `Missing sections: ${missing.join(', ')}.`,
    gathered?.jiraError === undefined ? '' : `Jira not read: ${gathered.jiraError}.`,
    gathered === undefined ? '' : `Sources: ${gathered.jira === undefined ? 'no Jira' : 'Jira'} · ${gathered.sessions.length} other session${gathered.sessions.length === 1 ? '' : 's'} · ${gathered.git === undefined ? 'no git' : `${gathered.git.commits === '' ? 0 : gathered.git.commits.split('\n').length} commits`}.`,
  ]
    .filter(Boolean)
    .join(' ')
  return set({ status: 'ready', text, path, isCopied, detail })
}

const DEFAULT_JIRA_API = ''
const DEFAULT_SESSION_DIRS = '~/.claude/projects, ~/.codex/sessions'

export const register: Register = (on, options) => {
  const days = Number(options.sessionDays ?? 90)
  const settings: Settings = {
    dir: String(options.dir ?? '').trim().replace(/^\.\/|\/+$/g, '') || '.claude/handoff',
    copy: options.copy !== false,
    jiraApi: String(options.jiraApi ?? DEFAULT_JIRA_API).trim(),
    sessionDirs: String(options.sessionDirs ?? DEFAULT_SESSION_DIRS).split(',').map(dir => dir.trim()).filter(Boolean),
    sessionDays: Number.isFinite(days) && days > 0 ? days : 90,
    isHubbed: false,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'handoff',
      description: 'Write a handoff note (goal, status, changes, next steps) to .claude/handoff/<ticket> and copy it',
      argumentHint: '[ticket] [what to stress]',
    })
    afterStart($, 'handoff', () => greetHub($, settings))
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Handoff', rows: 24 })
    const view = await writeHandoff($, settings, e.args.trim())
    if (view.status !== 'ready') {
      await $.ui.close({ id: PANE })
      return { text: asSentence(view.detail) }
    }
    const copied = view.isCopied ? ' and copied it to the clipboard' : settings.copy ? ' (the clipboard was not reachable; use Copy in the pane)' : ''
    return { text: `Wrote ${view.path}${copied}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    if (view === null || view.status === 'writing') {
      return <Text color="suggestion">{view?.detail ?? 'Writing the handoff note…'}</Text>
    }
    const copy = async (surface: typeof e.surface) => {
      const copied = await $.ui.copy({ text: view.text, surface })
      $.ui.toast(copied.isCopied ? 'Note copied' : `Could not copy (${copied.reason})`)
    }

    return (
      <Box flexDirection="column" gap={1}>
        {view.status === 'error' ? (
          <Text color="error">{view.detail}</Text>
        ) : (
          <Box flexDirection="column">
            <Text bold wrap="truncate-end">{`Saved to ${view.path}`}</Text>
            <Text dimColor>{view.isCopied ? 'Copied to the clipboard: paste it where your teammate will see it.' : 'Use Copy to put it on the clipboard.'}</Text>
            {view.detail !== '' && <Text color="warning">{view.detail}</Text>}
          </Box>
        )}
        {view.status === 'ready' && <Markdown key="note" text={view.text} />}
        <Box gap={1}>
          {view.status === 'ready' && <Button key="copy" label="Copy" hotkey="c" variant="primary" onPress={press => void copy(press.surface)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'handoff', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
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
