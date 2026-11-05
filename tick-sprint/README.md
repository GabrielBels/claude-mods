# tick-sprint

**Fill in your timesheet from the work Jira already saw you do.**

You know how many hours you worked in the sprint. You don't remember how they split across epics. `/tick <hours>` works it out from your Jira history: every issue weighs as much as the time it really spent in progress while it was yours, and the hours come back per epic, in quarter hours, adding up to exactly what you gave.

```text
/tick 55

Tick · sprint 28/10–11/11 · 55h

By epic:
      20h  Geo-Location Capture for Inspections (PROJ-2217)
   11.25h  General Continued Engineering (CORE-3600)
    10.5h  Customer Issues/Production Bugs (PROJ-1633)
       8h  Support Bugs (CORE-5425)
    5.25h  Project Care (OPS-445)

Issues (hours in an active status, the base of the split):
   47.5h  PROJ-2219 Web display of mobile-captured data
   41.2h  PROJ-2319 Localization for geo-location capture
   ...

• Sprint in progress: the split uses the time so far.
• Left out as cancelled: PROJ-2455.
```

## How the split works
- **Which issues:** every issue assigned to you at some point in the sprint that changed status during it or is in progress now. Cancelled issues are left out.
- **What counts:** the time each issue spent in an active status (`In Development`, `In Progress`, …) *while assigned to you*, inside the sprint, weekends left out. `Blocked`, `Ready for Development`, `Done` and every other status count for nothing.
- **To the minute:** an issue that went from `In Development` to `Blocked` at 11:45 after starting at 09:30 counts 2.25 hours, not the day.
- **Epics:** a subtask counts toward its story's epic; an issue with no epic is listed as `(no epic)`.
- **Rounding:** each epic gets a multiple of 0.25 h, and the parts always add up to the hours you gave.

## Usage
- `/tick 72` splits 72 hours across the current sprint.
- `/tick 75.5 -1` uses the previous sprint (`+1` for the next one). A decimal comma works too: `/tick 75,5 -1`.
- `/tick 80 15/10` or `/tick 80 2026-10-15` uses the sprint that contains that date.
- The **Tick · sprint** pane shows the hours per epic, the notes, and a **Copy (TSV)** button that copies `Epic<TAB>Hours` rows for a spreadsheet.

Sprints follow a fixed cadence from an anchor date: with `sprintAnchor` `2026-10-28` and `sprintDays` `14`, a sprint runs from 28/10 to 11/11, the day the next one starts.

## Setup
The mod reads Jira through the claude.ai Atlassian connector, so it needs no API token. The connector must be connected in your Claude Code session (`/mcp` lists it as `claude.ai Atlassian Rovo`).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `jiraSite` | string (sensitive) | `""` | Your Jira Cloud site (`acme.atlassian.net`), kept in Claude Code's secure storage. Required: `/tick` asks for it until it is set. |
| `sprintAnchor` | string | `2026-10-28` | Any date a sprint started on (`YYYY-MM-DD`). |
| `sprintDays` | number | `14` | Calendar days from one sprint's start to the next one's. |
| `utcOffsetHours` | number | `-3` | Where each day starts and ends, in hours from UTC. |
| `activeStatuses` | string | `In Development, In Progress, Ready (In Progress), Code Review, Dev Testing` | Comma-separated statuses whose time counts, spelled as in your Jira workflow. |

Leave `Code Review` and `Dev Testing` out of `activeStatuses` when an issue sits there waiting for other people: otherwise those days weigh as much as days you spent coding.

## How it works
- `/tick` runs one JQL search through the connector (`assignee was currentUser() DURING (…) AND (status changed DURING (…) OR statusCategory = "In Progress")`), then reads each issue's changelog, four at a time.
- The status and assignee timeline of each issue is rebuilt from its changelog and cut to the sprint and to the present.
- When an answer is larger than Claude Code's MCP output limit, Claude Code saves it to a file and the mod reads it from there.
- The pane draws from the session's state; nothing runs in the background.
