import type { Hook, PluginOptions, Register } from 'claude-code'

const COMMAND = 'whats-in-qa'
const OCTOPUS = 'octopus-deploy'
const ATLASSIAN = 'claude.ai Atlassian Rovo'

// Each filter argument and the userConfig field that holds its configured value.
const FILTERS = {
  sprint: 'sprint',
  project: 'projects',
  component: 'components',
  status: 'statuses',
  'exclude-status': 'excludeStatuses',
  assignee: 'assignee',
  label: 'labels',
  jql: 'extraJql',
} as const
type FilterArg = keyof typeof FILTERS

const USAGE = [
  'Usage: /whats-in-qa [sprint=…] [project=…] [component=…] [status=…] [exclude-status=…] [assignee=…] [label=…] [jql=…]',
  '',
  'Each argument overrides the plugin setting of the same filter for this run; key="" clears it.',
  '  sprint=           "Sprint 45", a sprint id, or open (every open sprint of the projects)',
  '  project=          Jira project keys, e.g. PROJ,CORE (required, here or in the settings)',
  '  component=        "Api,Web Team"',
  '  status=           only these statuses',
  '  exclude-status=   "Ready to Ship,Done,Cancelled"',
  '  assignee=         me, or account ids',
  '  label=            labels',
  '  jql=              any extra JQL clause, ANDed',
  '',
  'Octopus space, environment and projects, the Jira site and the commit window are plugin settings.',
].join('\n')

type Ticket = { key: string; status: string; assignee: string; summary: string }
type Commit = { sha: string; subject: string }
type Build = { project: string; version: string; deployedAt: string; inQa: Commit[]; pending: Commit[] }
type Api = Parameters<Hook<'command.run'>>[0]

const text = (options: PluginOptions, key: string) => {
  const value = options[key]
  return Array.isArray(value) ? value.join(',') : String(value ?? '').trim()
}
const list = (value: string) => value.split(',').map(v => v.trim()).filter(Boolean)
const quote = (value: string) => (/^\d+$/.test(value) || /\(\)$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`)
const inClause = (field: string, values: string[], negate = false) =>
  `${field} ${negate ? 'not in' : 'in'} (${values.map(quote).join(', ')})`

/**
 * Builds the Jira filter from the plugin settings, each overridden by a
 * `key=value` / `key="a, b"` argument of the same filter, or says what is wrong.
 */
export function buildJql(options: PluginOptions, args: string): { jql: string } | { error: string } {
  const values = new Map<FilterArg, string>()
  for (const [arg, field] of Object.entries(FILTERS)) values.set(arg as FilterArg, text(options, field))

  let unknown: string | undefined
  const rest = args.replace(/([\w-]+)=(?:"([^"]*)"|(\S*))/g, (_, key: string, quoted?: string, bare?: string) => {
    if (key in FILTERS) values.set(key as FilterArg, (quoted ?? bare ?? '').trim())
    else unknown ??= key
    return ''
  })
  if (unknown) return { error: `Unknown filter "${unknown}".` }
  if (rest.trim()) return { error: `Could not read "${rest.trim()}".` }

  const get = (arg: FilterArg) => values.get(arg) ?? ''
  if (!get('project')) return { error: 'No Jira project: pass project= or set "Jira projects" in the plugin settings.' }

  const clauses = [inClause('project', list(get('project')))]
  const sprint = get('sprint')
  if (sprint) clauses.push(sprint.toLowerCase() === 'open' ? 'sprint in openSprints()' : inClause('sprint', list(sprint)))
  if (get('component')) clauses.push(inClause('component', list(get('component'))))
  if (get('status')) clauses.push(inClause('status', list(get('status'))))
  if (get('exclude-status')) clauses.push(inClause('status', list(get('exclude-status')), true))
  if (get('assignee')) clauses.push(inClause('assignee', list(get('assignee')).map(a => (a === 'me' ? 'currentUser()' : a))))
  if (get('label')) clauses.push(inClause('labels', list(get('label'))))
  if (get('jql')) clauses.push(`(${get('jql')})`)

  return { jql: `${clauses.join(' AND ')} ORDER BY key` }
}

async function callJson($: Api, server: string, tool: string, args: Record<string, unknown>) {
  const result = await $.mcp.call(server, tool, args)
  const body = result.content.map(block => ('text' in block ? block.text : '')).join('')
  if (result.isError) throw new Error(`${server} ${tool} failed: ${body.slice(0, 300)}`)
  // An answer over the engine's MCP size limit comes back as a note naming the file that holds it.
  const saved = /(?:Output has been saved to|Full output saved to:)\s*(\S+?)\.?(?:\s|$)/.exec(body)?.[1]
  try {
    return JSON.parse(saved ? await $.fs.read(saved) : body)
  } catch {
    throw new Error(`${server} ${tool} returned non-JSON: ${body.slice(0, 300)}`)
  }
}

async function gh($: Api, args: string[]): Promise<Commit[]> {
  const { exitCode, stdout, stderr } = await $.process.run(['gh', 'api', ...args])
  if (exitCode !== 0) throw new Error(`gh api ${args[0]} failed: ${stderr.trim().slice(0, 300)}`)

  return stdout
    .split('\n')
    .filter(line => line.includes('\t'))
    .map(line => {
      const [sha, subject] = line.split('\t')
      return { sha: sha ?? '', subject: subject ?? '' }
    })
}

const COMMIT_LINE = '.sha[0:9] + "\\t" + (.commit.message | split("\\n")[0])'

async function loadTickets($: Api, site: string, jql: string): Promise<Ticket[]> {
  const tickets: Ticket[] = []
  let nextPageToken: string | undefined
  do {
    const page = await callJson($, ATLASSIAN, 'searchJiraIssuesUsingJql', {
      cloudId: site,
      jql,
      fields: ['summary', 'status', 'assignee'],
      maxResults: 100,
      responseContentFormat: 'markdown',
      ...(nextPageToken ? { nextPageToken } : {}),
    })
    for (const node of page.issues?.nodes ?? []) {
      tickets.push({
        key: node.key,
        status: node.fields?.status?.name ?? '?',
        assignee: node.fields?.assignee?.displayName ?? '—',
        summary: node.fields?.summary ?? '',
      })
    }
    nextPageToken = page.issues?.pageInfo?.hasNextPage ? page.issues.pageInfo.endCursor : undefined
  } while (nextPageToken)

  return tickets
}

type Item = { Id: string; Name: string }
const named = (items: Item[] | undefined, name: string) => items?.find(i => i.Name.toLowerCase() === name.toLowerCase())

/** Resolves the Octopus space, environment and projects named in the settings to their ids. */
async function resolveOctopus($: Api, spaceName: string, environmentName: string, projectNames: string[]) {
  const spaces = await callJson($, OCTOPUS, 'find_spaces', { Name: spaceName })
  const space = named(spaces.Page?.Items, spaceName)
  if (!space) throw new Error(`Octopus space "${spaceName}" not found`)

  const [environments, ...projects] = await Promise.all([
    callJson($, OCTOPUS, 'find_environments', { SpaceId: space.Id, Name: environmentName, Skip: 0, Take: 5 }),
    ...projectNames.map(name => callJson($, OCTOPUS, 'find_projects', { SpaceId: space.Id, PartialName: name, Take: 50 })),
  ])
  const environment = named(environments.Page?.Items, environmentName)
  if (!environment) throw new Error(`Octopus environment "${environmentName}" not found in ${spaceName}`)

  return {
    spaceId: space.Id,
    environmentId: environment.Id,
    projects: projectNames.map((name, i) => {
      const project = named(projects[i]?.Page?.Items, name)
      if (!project) throw new Error(`Octopus project "${name}" not found in ${spaceName}`)
      return project
    }),
  }
}

async function loadBuild($: Api, spaceId: string, environmentId: string, project: Item, since: string): Promise<Build> {
  const deployments = await callJson($, OCTOPUS, 'find_deployments', {
    SpaceId: spaceId,
    Projects: [project.Id],
    Environments: [environmentId],
    TaskState: 'Success',
    Take: 1,
  })
  const deployment = deployments.Page?.Items?.[0]
  if (!deployment) throw new Error(`${project.Name} has no successful deployment to that environment`)

  const { Release: release } = await callJson($, OCTOPUS, 'execute_query', {
    Name: 'get_release',
    Arguments: { Id: deployment.ReleaseId, SpaceId: spaceId },
  })
  const build = release?.BuildInformation?.find((b: { VcsCommitNumber?: string }) => b.VcsCommitNumber)
  if (!build) throw new Error(`${project.Name} ${release?.Version} has no build information`)

  const repo = String(build.VcsRoot).replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  const sha: string = build.VcsCommitNumber
  const branch: string = build.Branch || 'main'

  const [inQa, pending] = await Promise.all([
    gh($, ['--paginate', `repos/${repo}/commits?sha=${sha}&since=${since}&per_page=100`, '--jq', `.[] | ${COMMIT_LINE}`]),
    gh($, [`repos/${repo}/compare/${sha}...${branch}`, '--jq', `.commits[] | ${COMMIT_LINE}`]),
  ])

  return {
    project: project.Name,
    version: release.Version,
    deployedAt: String(deployment.Created).slice(0, 16).replace('T', ' '),
    inQa,
    pending,
  }
}

const mentions = (key: string) => {
  const pattern = new RegExp(`(^|[^A-Za-z0-9-])${key}(?![0-9])`)
  return (commit: Commit) => pattern.test(commit.subject)
}

export function buildReport(tickets: Ticket[], builds: Build[], environment: string, jql: string, lookbackDays: number): string {
  const inQa = builds.flatMap(b => b.inQa.map(c => ({ ...c, project: b.project })))
  const pending = builds.flatMap(b => b.pending.map(c => ({ ...c, project: b.project })))

  const ready: string[] = []
  const blocked: string[] = []
  const partial: string[] = []
  const waiting: string[] = []
  const noCommits: string[] = []

  for (const t of tickets) {
    const deployed = inQa.filter(mentions(t.key))
    const notDeployed = pending.filter(mentions(t.key))
    const where = [...new Set(deployed.map(c => c.project))].join(', ')

    if (deployed.length > 0 && notDeployed.length > 0) {
      partial.push(`- **${t.key}** (${t.status}): missing ${notDeployed.map(c => c.subject.match(/\(#\d+\)/)?.[0] ?? c.sha).join(', ')}`)
    } else if (deployed.length > 0 && t.status === 'Blocked') {
      blocked.push(t.key)
    } else if (deployed.length > 0) {
      ready.push(`| ${t.key} | ${t.status} | ${t.assignee} | ${where} |`)
    } else if (notDeployed.length > 0) {
      waiting.push(`- **${t.key}** (${t.status}): on ${[...new Set(notDeployed.map(c => c.project))].join(', ')} main`)
    } else if (t.status === 'Ready for QA') {
      noCommits.push(t.key)
    }
  }

  const lines = [
    `**Ready to test on ${environment}: ${ready.length}** · ` +
      builds.map(b => `${b.project} \`${b.version}\` (${b.deployedAt} UTC)`).join(' · '),
    '',
  ]
  if (ready.length > 0) lines.push('| Ticket | Status | Assignee | Build |', '|---|---|---|---|', ...ready, '')
  else lines.push('_None._', '')
  if (partial.length > 0) lines.push(`**Partly on ${environment}**`, ...partial, '')
  if (waiting.length > 0) lines.push(`**Merged, waiting for a ${environment} deploy**`, ...waiting, '')
  if (blocked.length > 0) lines.push(`**On ${environment} but Blocked:** ${blocked.join(', ')}`, '')
  if (noCommits.length > 0) lines.push(`**Ready for QA, no matching commit found:** ${noCommits.join(', ')}`, '')
  lines.push(
    `_${tickets.length} tickets checked: \`${jql}\`. Commits matched by ticket key in the subject, last ${lookbackDays} days._`,
  )

  return lines.join('\n')
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Jira tickets (filtered by the plugin settings and the arguments) already deployed to an Octopus environment',
      argumentHint: '[sprint=…] [project=…] [component=…] [exclude-status=…] [assignee=…] [label=…] [jql=…]',
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const filter = buildJql(options, e.args)
    if ('error' in filter) return { text: `${filter.error}\n\n${USAGE}` }

    const environment = text(options, 'octopusEnvironment')
    const octopusProjects = list(text(options, 'octopusProjects'))
    const missing = [
      ['jiraSite', 'Jira site'],
      ['octopusSpace', 'Octopus space'],
      ['octopusEnvironment', 'Octopus environment'],
      ['octopusProjects', 'Octopus projects'],
    ].filter(([key]) => !text(options, key ?? ''))
    if (missing.length > 0) {
      return { text: `Set ${missing.map(([, title]) => `"${title}"`).join(', ')} in the plugin settings: /plugin, then configure whats-in-qa.` }
    }
    const lookbackDays = Number(options.lookbackDays) || 45
    const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 19) + 'Z'

    try {
      $.ui.status('whats-in-qa: reading Jira, Octopus and GitHub…')
      const [tickets, octopus] = await Promise.all([
        loadTickets($, text(options, 'jiraSite'), filter.jql),
        resolveOctopus($, text(options, 'octopusSpace'), environment, octopusProjects),
      ])
      const builds = await Promise.all(
        octopus.projects.map(p => loadBuild($, octopus.spaceId, octopus.environmentId, p, since)),
      )
      const report = buildReport(tickets, builds, environment, filter.jql, lookbackDays)

      return { text: report, context: [`/whats-in-qa result:\n${report}`] }
    } catch (error) {
      return { text: `whats-in-qa failed: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      $.ui.status(undefined)
    }
  })
}
