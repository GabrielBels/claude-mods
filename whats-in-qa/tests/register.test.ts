import { expect, test } from 'claude-code/testing'

const text = (value: unknown) => ({ value: { content: [{ type: 'text', text: value }], isError: false } })

type On = Parameters<Parameters<typeof test>[1]>[1]

const json = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } })
const ticket = (key: string, status: string) => ({
  key,
  fields: { status: { name: status }, assignee: { displayName: 'Dev' }, summary: key },
})
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const TEAM = {
  options: {
    projects: 'PROJ,CORE',
    components: 'Api,Web Team',
    excludeStatuses: 'Ready to Ship,Done,Cancelled',
    jiraSite: 'acme.atlassian.net',
    octopusSpace: 'Acme',
    octopusEnvironment: 'qa',
    octopusProjects: 'Web-App,Api',
  },
}

function stubEngine(on: On, seen: { jql: string[]; oversized?: boolean }, ghFails = false) {
  on('command.register', () => ({ value: { command: 'whats-in-qa' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('mcp.call', (_, e) => {
    switch (e.tool) {
      case 'searchJiraIssuesUsingJql':
        if (seen.oversized) {
          seen.jql.push(String(e.args.jql))
          return text('Error: result exceeds maximum allowed tokens. Output has been saved to /tmp/jira-page.txt.\nFormat: JSON')
        }
        seen.jql.push(String(e.args.jql))
        return json({
          issues: {
            nodes: [
              ticket('PROJ-1', 'Dev Testing'),
              ticket('PROJ-2', 'Ready for QA'),
              ticket('PROJ-3', 'Dev Testing'),
              ticket('PROJ-4', 'Blocked'),
              ticket('PROJ-5', 'Ready for QA'),
              ticket('PROJ-10', 'Dev Testing'),
            ],
            pageInfo: { hasNextPage: false },
          },
        })
      case 'find_spaces':
        return json({ Page: { Items: [{ Id: 'Spaces-1', Name: 'Acme' }] } })
      case 'find_environments':
        return json({ Page: { Items: [{ Id: 'Environments-3', Name: 'qa' }] } })
      case 'find_projects':
        // A partial-name search also returns look-alikes; only the exact name counts.
        return json({
          Page: {
            Items: [
              { Id: 'P-web', Name: 'Web-App' },
              { Id: 'P-api', Name: 'Api' },
              { Id: 'P-db', Name: 'Api-DbUpdates' },
            ],
          },
        })
      case 'find_deployments': {
        const web = (e.args.Projects as string[])[0] === 'P-web'
        return json({ Page: { Items: [{ ReleaseId: web ? 'R-web' : 'R-api', Created: '2026-11-05T17:09:21Z' }] } })
      }
      default: {
        const web = (e.args.Arguments as { Id: string }).Id === 'R-web'
        return json({
          Release: {
            Version: web ? '1.0.1' : '2026.1',
            BuildInformation: [
              { VcsRoot: `https://github.com/Org/${web ? 'web' : 'api'}`, VcsCommitNumber: web ? 'aaaaaaa' : 'bbbbbbb', Branch: 'main' },
            ],
          },
        })
      }
    }
  })
  on('process.run', (_, e) => {
    if (ghFails) {
      return { value: { exitCode: 1, stdout: '', stderr: 'HTTP 401', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const url = e.argv[e.argv.length - 3] ?? ''
    const lines: Record<string, string> = {
      'commits:web': 'a1\tPROJ-1: web part (#10)\na2\tPROJ-3: first half (#11)\na3\tPROJ-4: scripts (#12)\na4\tPROJ-100: other (#13)',
      'compare:web': '',
      'commits:api': 'b1\tPROJ-2: api fix (#20)',
      'compare:api': 'b2\tPROJ-3: second half (#21)\nb3\tPROJ-10 - waiting (#22)',
    }
    return ok(lines[`${url.includes('/compare/') ? 'compare' : 'commits'}:${url.includes('/web/') ? 'web' : 'api'}`] ?? '')
  })
}

async function run($: Parameters<Parameters<typeof test>[1]>[0], args = '') {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return (await $.command.run({ command: 'whats-in-qa', args })).text ?? ''
}

test('classifies the configured tickets by what the QA builds contain', TEAM, async ($, on) => {
  const seen = { jql: [] as string[] }
  stubEngine(on, seen)

  const text = await run($)

  expect(text).toContain('**Ready to test on qa: 2**')
  expect(text).toContain('| PROJ-1 | Dev Testing | Dev | Web-App |')
  expect(text).toContain('| PROJ-2 | Ready for QA | Dev | Api |')
  expect(text).toContain('- **PROJ-3** (Dev Testing): missing (#21)')
  expect(text).toContain('**On qa but Blocked:** PROJ-4')
  expect(text).toContain('- **PROJ-10** (Dev Testing): on Api main')
  expect(text).toContain('**Ready for QA, no matching commit found:** PROJ-5')
  // PROJ-1 must not match PROJ-10 or PROJ-100.
  expect(text).not.toContain('| PROJ-10 |')
})

test('the settings alone make the Jira filter', TEAM, async ($, on) => {
  const seen = { jql: [] as string[] }
  stubEngine(on, seen)

  await run($)

  expect(seen.jql[0]).toBe(
    'project in ("PROJ", "CORE") AND sprint in openSprints() AND component in ("Api", "Web Team") ' +
      'AND status not in ("Ready to Ship", "Done", "Cancelled") ORDER BY key',
  )
})

test('arguments override settings for one run, and key="" clears one', TEAM, async ($, on) => {
  const seen = { jql: [] as string[] }
  stubEngine(on, seen)

  await run($, 'sprint="Sprint 45" component="" assignee=me')

  expect(seen.jql[0]).toBe(
    'project in ("PROJ", "CORE") AND sprint in ("Sprint 45") ' +
      'AND status not in ("Ready to Ship", "Done", "Cancelled") AND assignee in (currentUser()) ORDER BY key',
  )
})

test('with no project configured or passed, it shows the usage and queries nothing', async ($, on) => {
  const seen = { jql: [] as string[] }
  stubEngine(on, seen)

  const missing = await run($)
  const unknown = await run($, 'project=PROJ team=x')

  expect(missing).toContain('No Jira project')
  expect(missing).toContain('Usage: /whats-in-qa')
  expect(unknown).toContain('Unknown filter "team".')
  expect(seen.jql.length).toBe(0)
})

test('reports a failing source instead of a partial table', TEAM, async ($, on) => {
  stubEngine(on, { jql: [] }, true)

  const text = await run($)

  expect(text).toContain('whats-in-qa failed: gh api')
  expect(text).toContain('HTTP 401')
})

test('an oversized Jira answer is read from the file the engine saved it to', TEAM, async ($, on) => {
  const seen = { jql: [] as string[], oversized: true }
  stubEngine(on, seen)
  on('fs.read', (_, e) => {
    expect(e.path).toBe('/tmp/jira-page.txt')
    return { value: JSON.stringify({ issues: { nodes: [ticket('PROJ-2', 'Ready for QA')], pageInfo: { hasNextPage: false } } }) }
  })

  const report = await run($)

  expect(report).toContain('| PROJ-2 | Ready for QA | Dev | Api |')
})

test('without the location settings it says which ones to set', { options: { projects: 'PROJ' } }, async ($, on) => {
  stubEngine(on, { jql: [] })

  const report = await run($)

  expect(report).toContain('"Jira site", "Octopus space", "Octopus projects"')
})
