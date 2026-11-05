# whats-in-qa

**Know which tickets QA can test right now, without asking anyone.**

A ticket is ready to test when its code is in the build running on QA, whatever its Jira status says. `/whats-in-qa` reads the latest successful deployment of each Octopus project to that environment, follows the build back to its GitHub commit, and checks which of your sprint's tickets have commits in it.

```text
/whats-in-qa

Ready to test on qa: 2 · Web-App 1.0.1446.2 (2026-11-05 17:09 UTC) · Api 20261030.1273.1-1 (2026-10-30 19:13 UTC)

| Ticket    | Status       | Assignee | Build   |
|-----------|--------------|----------|---------|
| PROJ-2351 | Ready for QA | Paulo    | Api     |
| PROJ-2404 | Dev Testing  | Scott    | Web-App |

Partly on qa
- PROJ-2441 (Dev Testing): missing (#1412)

Merged, waiting for a qa deploy
- PROJ-2305 (Dev Testing): on Api main

12 tickets checked: project in ("PROJ", "CORE") AND sprint in openSprints() AND … ORDER BY key.
```

## What the report says
- **Ready to test:** every commit carrying the ticket key is in the deployed build.
- **Partly on QA:** some of the ticket's commits are deployed, others are only on the branch the build came from.
- **Merged, waiting for a deploy:** the ticket's commits are merged but newer than the deployed build.
- **On QA but Blocked:** deployed, but the ticket is `Blocked` in Jira.
- **Ready for QA, no matching commit found:** Jira says it is ready, but no commit in these repositories names it (its code may live elsewhere).

## Usage
- `/whats-in-qa` uses the filters in the plugin settings.
- Any filter can be given for one run, overriding its setting: `/whats-in-qa sprint="Sprint 45" component="Api,Web Team" assignee=me`.
- `key=""` clears a setting for one run: `/whats-in-qa component=""` looks at every component.

| Argument | Setting | Meaning |
| --- | --- | --- |
| `sprint=` | `sprint` | A sprint name (`"Sprint 45"`), a sprint id, or `open` for every open sprint of the projects. |
| `project=` | `projects` | Jira project keys. Required, in the call or in the settings. |
| `component=` | `components` | Only these components. |
| `status=` | `statuses` | Only these statuses. |
| `exclude-status=` | `excludeStatuses` | Leave these statuses out. |
| `assignee=` | `assignee` | `me`, or Jira account ids. |
| `label=` | `labels` | Only these labels. |
| `jql=` | `extraJql` | Any extra JQL clause, ANDed with the rest. |

Lists are comma-separated; quote a value with spaces (`exclude-status="Ready to Ship,Done"`).

## Setup
The mod reads Jira through the claude.ai Atlassian connector and Octopus through the Octopus Deploy MCP server, using your own sign-in to each, and GitHub through `gh`. In your Claude Code session, `/mcp` must list `claude.ai Atlassian Rovo` and `octopus-deploy`, and `gh auth status` must be signed in to an account that can read the repositories.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `jiraSite` | string (sensitive) | `""` | Your Jira Cloud site (`acme.atlassian.net`), kept in Claude Code's secure storage. Required. |
| `octopusSpace` | string | `""` | The Octopus space name. Required. |
| `octopusEnvironment` | string | `qa` | The environment whose deployments are checked. |
| `octopusProjects` | string | `""` | Comma-separated Octopus project names. Their releases must carry GitHub build information. Required. |
| `lookbackDays` | number | `45` | How many days of the deployed build's history are searched for ticket keys. |
| `sprint` | string | `open` | Default sprint filter. |
| `projects` | string | `""` | Default Jira projects. |
| `components`, `statuses`, `assignee`, `labels`, `extraJql` | string | `""` | Default filters, empty for none. |
| `excludeStatuses` | string | `Ready to Ship,Done,Cancelled` | Statuses left out by default. |

## How it works
- One JQL search through the connector lists the tickets; an answer over Claude Code's MCP output limit is read from the file Claude Code saves it to.
- For each Octopus project, the latest successful deployment to the environment gives the release, and the release's build information gives the repository, the commit and the branch.
- `gh api` lists the commits reachable from that commit within `lookbackDays`, and the commits on the branch that the build does not have yet.
- A ticket matches a commit when its key appears in the commit's first line, so `PROJ-1` never matches `PROJ-10`. Keys only in a commit's body, or in commits older than `lookbackDays`, are not seen.
