// Reads the sprint's issues and their changelogs from the Jira REST API, configured in ~/.config/jira.json.
import type { EngineInterface } from 'claude-code'

import type { ChangeItem, History, Issue } from './tick'

type Json = any

export const SETUP =
  'Jira is not configured: create ~/.config/jira.json (chmod 600) with {"apiBase", "email", "token"}, as the tick-sprint README describes.'

type Jira = { base: string; auth: string }

/** apiBase, email and token: JIRA_API_BASE, JIRA_API_EMAIL and JIRA_API_TOKEN over ~/.config/jira.json. */
async function jiraConfig($: EngineInterface): Promise<Jira> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  let found: Json = {}
  try {
    found = JSON.parse(String(await $.fs.read(`${home}/.config/jira.json`)))
  } catch {
    found = {}
  }
  const base = (await $.env.get('JIRA_API_BASE')) || found?.apiBase || ''
  const email = (await $.env.get('JIRA_API_EMAIL')) || found?.email || ''
  const token = (await $.env.get('JIRA_API_TOKEN')) || found?.token || ''
  if (!base || !email || !token) throw new Error(SETUP)
  return { base: String(base).replace(/\/+$/, ''), auth: `Basic ${btoa(`${email}:${token}`)}` }
}

async function call($: EngineInterface, jira: Jira, path: string, body?: unknown): Promise<Json> {
  const response = await $.http.fetch(`${jira.base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: jira.auth,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.status === 401) throw new Error('Jira answered 401: the token in ~/.config/jira.json is expired or lacks read:jira-work.')
  if (!response.ok) throw new Error(`Jira answered ${response.status} for ${path.split('?')[0]}`)
  try {
    return JSON.parse(response.text)
  } catch {
    throw new Error(`Jira answered something unreadable for ${path.split('?')[0]}`)
  }
}

async function search($: EngineInterface, jira: Jira, jql: string, fields: string[]): Promise<Json[]> {
  const issues: Json[] = []
  let token: string | undefined
  for (let page = 0; page < 20; page++) {
    const data = await call($, jira, '/search/jql', { jql, fields, maxResults: 100, ...(token ? { nextPageToken: token } : {}) })
    issues.push(...(data?.issues ?? []))
    if (data?.isLast !== false || !data?.nextPageToken) break
    token = data.nextPageToken
  }
  return issues
}

async function changelog($: EngineInterface, jira: Jira, key: string): Promise<History[]> {
  const histories: History[] = []
  for (let startAt = 0; startAt < 5000; ) {
    const data = await call($, jira, `/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=100`)
    const values: Json[] = data?.values ?? []
    for (const h of values) {
      histories.push({
        created: Date.parse(h.created),
        items: (h.items ?? []).map(
          (it: Json): ChangeItem => ({
            field: it.field,
            from: it.from ?? null,
            to: it.to ?? null,
            fromString: it.fromString ?? null,
            toString: it.toString ?? null,
          }),
        ),
      })
    }
    if (data?.isLast !== false || values.length === 0) break
    startAt += values.length
  }
  return histories
}

/** Your account id: /myself, or, when the token cannot read it, the assignee of an issue assigned to you. */
async function accountId($: EngineInterface, jira: Jira): Promise<string> {
  try {
    const me = await call($, jira, '/myself')
    if (me?.accountId) return me.accountId
  } catch {
    // a scoped read:jira-work token may not read /myself
  }
  const [mine] = await search($, jira, 'assignee = currentUser() ORDER BY updated DESC', ['assignee'])
  const id = mine?.fields?.assignee?.accountId
  if (!id) throw new Error('Could not find your Jira account id.')
  return id
}

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const jqlDate = (iso: string) => iso.replaceAll('-', '/')

const NO_EPIC = { epic: '', epicName: '(no epic)' }

/**
 * Every issue assigned to you at some point in [start, end] whose status changed then or that is in
 * progress now, each with its epic and full changelog.
 */
export async function loadIssues(
  $: EngineInterface,
  start: string,
  end: string,
  progress: (label: string) => Promise<unknown>,
): Promise<{ issues: Issue[]; me: string }> {
  const jira = await jiraConfig($)
  await progress('Finding your issues in Jira…')
  // Issues untouched during the sprint and not in progress now spent no active time in it.
  const during = `DURING ("${jqlDate(start)}", "${jqlDate(end)}")`
  const jql = `assignee was currentUser() ${during} AND (status changed ${during} OR statusCategory = "In Progress") ORDER BY key`
  const [nodes, me] = await Promise.all([search($, jira, jql, ['summary', 'status', 'assignee', 'parent']), accountId($, jira)])

  // A subtask's parent is a story: its epic is one level up.
  const epicOf = new Map<string, { epic: string; epicName: string }>()
  const midParents = new Set<string>()
  for (const n of nodes) {
    const p = n.fields?.parent
    if (p?.key && p.fields?.issuetype?.name !== 'Epic') midParents.add(p.key)
  }
  if (midParents.size > 0) {
    const parents = await search($, jira, `key in (${[...midParents].join(',')})`, ['parent'])
    for (const p of parents) {
      const gp = p.fields?.parent
      epicOf.set(p.key, gp?.key ? { epic: gp.key, epicName: gp.fields?.summary ?? gp.key } : NO_EPIC)
    }
  }

  let done = 0
  const issues = await mapLimit(nodes, 4, async (n): Promise<Issue> => {
    const histories = await changelog($, jira, n.key)
    done += 1
    await progress(`Reading changelog ${done}/${nodes.length}…`)
    const p = n.fields?.parent
    const group = !p?.key
      ? NO_EPIC
      : p.fields?.issuetype?.name === 'Epic'
        ? { epic: p.key, epicName: p.fields?.summary ?? p.key }
        : (epicOf.get(p.key) ?? NO_EPIC)
    return {
      key: n.key,
      summary: n.fields?.summary ?? '',
      status: n.fields?.status?.name ?? '',
      assigneeId: n.fields?.assignee?.accountId ?? null,
      ...group,
      histories,
      isChangelogPartial: false,
    }
  })
  return { issues, me }
}
