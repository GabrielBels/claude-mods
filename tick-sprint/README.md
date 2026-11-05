# tick-sprint
> /tick &lt;hours&gt; splits the hours you worked in a sprint across your Jira epics, weighted by each issue's time in an active status, ready to log in Tick.

**Category:** Team · **Version:** 0.1.0

## What it does
`/tick <hours>` takes the hours you worked in a sprint and divides them across the epics of the Jira issues you worked on, in quarter-hour steps that add up to exactly the hours given.

Each issue weighs as much as the time it spent in an active status (`In Development`, `Code Review`, ...) while assigned to you, inside the sprint, weekends left out. Time in any other status, `Blocked` included, does not count. The time between two status changes is taken to the minute, so an issue moved from `In Development` to `Blocked` on the same day counts only the time in between.

The mod reads Jira through the claude.ai Atlassian connector, so it needs no token of its own. It takes the issues assigned to you at some point in the sprint whose status changed during it or that are in progress now, then reads each one's changelog. A subtask counts toward its story's epic; an issue without an epic is listed as `(sem epic)`. Cancelled issues are left out.

Sprints follow a fixed cadence from an anchor date (14 days by default): the sprint that starts on 2026-10-28 ends on 2026-11-11, which is also when the next one starts. For the sprint in progress, the proportions use the time up to now.

## Usage
- `/tick 72` splits 72 hours across the current sprint.
- `/tick 75,5 -1` uses the previous sprint (`+1` for the next one).
- `/tick 80 15/10` or `/tick 80 2026-10-15` uses the sprint that contains that date.
- The output lists the hours per epic and the active hours of each issue, which are the base of the split. The **Tick · sprint** pane shows the same per-epic hours and a **Copiar (TSV)** button that copies them as tab-separated rows.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `jiraSite` | string (sensitive) | `""` | Your Jira Cloud site (`acme.atlassian.net`), kept in Claude Code's secure storage. Required: `/tick` asks for it until it is set. |
| `sprintAnchor` | string | `2026-10-28` | Any date a sprint started on (`YYYY-MM-DD`). |
| `sprintDays` | number | `14` | Calendar days from one sprint's start to the next. |
| `utcOffsetHours` | number | `-3` | Where each day starts and ends (Brasília is `-3`). |
| `activeStatuses` | string | `In Development, In Progress, Ready (In Progress), Code Review, Dev Testing` | Comma-separated statuses whose time counts. |

## Testing
To run the tests, use `claude plugin test <path to tick-sprint>`.
