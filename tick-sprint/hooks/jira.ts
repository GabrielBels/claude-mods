// Reads the sprint's issues and their changelogs through the Atlassian connector.
import type { EngineInterface } from 'claude-code'

import type { ChangeItem, History, Issue } from './tick'

export const SERVER = 'claude.ai Atlassian Rovo'

type Json = any

async function callJson($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<Json> {
  const result = await $.mcp.call(SERVER, tool, args)
  const text = result.content.map(c => c.text ?? '').join('')
  if (result.isError) throw new Error(`${tool}: ${text.slice(0, 300) || 'erro sem mensagem'}`)
  // An answer over the engine's MCP size limits comes back as a note naming the file that holds it,
  // in one of two wordings ("Output has been saved to <path>." or "Full output saved to: <path>").
  const saved = /(?:Output has been saved to|Full output saved to:)\s*(\S+?)\.?(?:\s|$)/.exec(text)?.[1]
  try {
    return JSON.parse(saved ? await $.fs.read(saved) : text)
  } catch {
    if (result.structuredContent !== undefined) return result.structuredContent
    throw new Error(`${tool}: resposta inesperada do conector (${text.slice(0, 120)})`)
  }
}

async function search(
  $: EngineInterface,
  site: string,
  jql: string,
  fields: string[],
): Promise<{ nodes: Json[]; accountId: string | null }> {
  const nodes: Json[] = []
  let accountId: string | null = null
  let token: string | undefined
  for (let page = 0; page < 20; page++) {
    const data = await callJson($, 'searchJiraIssuesUsingJql', {
      cloudId: site,
      jql,
      fields,
      maxResults: 100,
      responseContentFormat: 'markdown',
      ...(token ? { nextPageToken: token } : {}),
    })
    nodes.push(...(data?.issues?.nodes ?? []))
    accountId ??= data?.context?.atlassianAccountId ?? null
    const info = data?.issues?.pageInfo
    if (!info?.hasNextPage || !info.endCursor) break
    token = info.endCursor
  }
  return { nodes, accountId }
}

async function changelog($: EngineInterface, site: string, key: string, fromMs: number) {
  const data = await callJson($, 'getJiraIssue', {
    cloudId: site,
    issueIdOrKey: key,
    expand: 'changelog',
    fields: ['status'],
    updateHistory: false,
  })
  const log = data?.issues?.nodes?.[0]?.changelog ?? data?.changelog ?? {}
  const histories: History[] = (log.histories ?? []).map((h: Json) => ({
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
  }))
  const oldest = Math.min(...histories.map(h => h.created))
  const isPartial = typeof log.total === 'number' && histories.length < log.total && oldest > fromMs
  return { histories, isPartial }
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

const NO_EPIC = { epic: '', epicName: '(sem epic)' }

/**
 * Every issue assigned to the current user at some point in [start, end],
 * each with its epic and changelog.
 */
export async function loadIssues(
  $: EngineInterface,
  site: string,
  start: string,
  end: string,
  fromMs: number,
  progress: (label: string) => Promise<unknown>,
): Promise<{ issues: Issue[]; me: string }> {
  await progress('Buscando suas issues no Jira…')
  // Issues untouched during the sprint and not in progress now spent no active time in it.
  const during = `DURING ("${jqlDate(start)}", "${jqlDate(end)}")`
  const jql = `assignee was currentUser() ${during} AND (status changed ${during} OR statusCategory = "In Progress") ORDER BY key`
  const { nodes, accountId } = await search($, site, jql, ['summary', 'status', 'assignee', 'parent'])
  let me = accountId
  if (!me) {
    const info = await callJson($, 'atlassianUserInfo', {})
    me = info?.account_id ?? info?.accountId ?? null
  }
  if (!me) throw new Error('Não consegui descobrir seu accountId no Jira.')

  // A subtask's parent is a story: its epic is one level up.
  const epicOf = new Map<string, { epic: string; epicName: string }>()
  const midParents = new Set<string>()
  for (const n of nodes) {
    const p = n.fields?.parent
    if (p?.key && p.fields?.issuetype?.name !== 'Epic') midParents.add(p.key)
  }
  if (midParents.size > 0) {
    const { nodes: parents } = await search($, site, `key in (${[...midParents].join(',')})`, ['parent'])
    for (const p of parents) {
      const gp = p.fields?.parent
      epicOf.set(p.key, gp?.key ? { epic: gp.key, epicName: gp.fields?.summary ?? gp.key } : NO_EPIC)
    }
  }

  let done = 0
  const issues = await mapLimit(nodes, 4, async (n): Promise<Issue> => {
    const log = await changelog($, site, n.key, fromMs)
    done += 1
    await progress(`Lendo changelog ${done}/${nodes.length}…`)
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
      histories: log.histories,
      isChangelogPartial: log.isPartial,
    }
  })
  return { issues, me }
}
