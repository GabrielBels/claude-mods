# handoff

**Leave a ticket so the next person can pick it up in a minute.**

`/handoff` writes a short, factual note about a Jira ticket, from everything that knows about it: the ticket itself, git and GitHub, your other Claude Code and Codex sessions on it, and the conversation you are in. It compares what the ticket asks for with what was actually done, and says so when the sources disagree.

```markdown
## Goal
Keep the recycle bin pager visible at any window height (PROJ-2458).
## Status
- Done: grid wrapper is a size container; pager stays in view on desktop.
- In progress: mobile layout, raised in the latest Jira comment.
## What changed
- `Web/RecycleBin.css`: wrapper sized as a container, pager pinned to its bottom.
## Next steps
1. Reproduce on a 375 px viewport and adjust the container query.
2. Move the ticket to Code Review once PR #1904 passes.
## Gotchas
- Jira says Code Review, but the mobile fix is not pushed yet.
## How to verify
- Open the recycle bin with 200 rows and shrink the window: the pager stays visible.
```

## What you get
- **Six fixed sections:** Goal, Status, What changed, Next steps, Gotchas, How to verify.
- **Short on purpose:** at most 30 lines and 300 words, one-line bullets, each fact said once.
- **Ready to reuse:** no absolute paths, session ids or machine names, so the note can become a Jira comment or a PR description as is.
- **Saved and copied:** the note is written to `.claude/handoff/PROJ-2458/YYYY-MM-DD-HHMM.md` (without a ticket, `.claude/handoff/YYYY-MM-DD-HHMM.md`), copied to your clipboard and shown in a pane.
- **Honest about gaps:** the pane names the sources it read (`Sources: Jira · 2 other sessions · 5 commits.`) and warns when Jira could not be read or the model left a section out.

## Usage
- `/handoff` writes, saves and copies the note. The ticket comes from the first `ABC-123` key in the branch name.
- `/handoff PROJ-2458` names the ticket when the branch does not (`main`, svn working copies, `claude/...` branches).
- `/handoff PROJ-2458 repair script waits for DevOps` adds what the note should stress.

## What it reads
With a ticket, the mod gathers these sources at once, before the model writes:
- **Jira:** summary, type, status, priority, assignee, parent, description and the latest comments.
- **Your other sessions:** Claude Code and Codex sessions from the last 90 days whose branch, title, prompts or answers name the ticket. It reads your prompts, the title and the last answer, never tool output.
- **git and GitHub:** branches and worktrees named after the ticket (with each worktree's uncommitted files), commits whose message names it, and its pull requests.
- **The working copy:** git, or svn in an svn working copy such as a customer branch.

The note is about the ticket even when the current conversation was about something else.

## Setup
To read Jira, set `jiraApi` and give the mod an API token through the `JIRA_API_EMAIL` and `JIRA_API_TOKEN` environment variables, or `~/.jira-cred` (`email:token`). Without them the note still comes out, and Gotchas says Jira was not read.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dir` | string | `.claude/handoff` | Folder for the notes, relative to the project root. |
| `copy` | boolean | `true` | Put each new note on the clipboard. |
| `jiraApi` | string (sensitive) | `""` | Jira REST API v3 base (`https://api.atlassian.com/ex/jira/<cloud id>/rest/api/3` or `https://<site>.atlassian.net/rest/api/3`), kept in Claude Code's secure storage. Empty leaves Jira out. |
| `sessionDirs` | string | `~/.claude/projects, ~/.codex/sessions` | Session folders searched for the ticket. Empty leaves sessions out. |
| `sessionDays` | number | `90` | How many days back a session may have last been active. |

## How it works
- `/handoff` reads the working copy with git, or with svn when `git rev-parse` fails and `svn info` finds a working copy (`svn log` asks the server and waits up to 20 s).
- With a ticket, it runs `scripts/jira.py` (Jira REST, rich text flattened to plain text), `scripts/sessions.py` (transcripts touched in the window that name the key, the current session left out because the note's writer already has it), the ticket's git refs, worktrees and commits, and `gh pr list --search <ticket>`, all at once. A source that fails is left out and named in the pane.
- A fork of the current conversation writes the note, with those sources marked as data, not instructions. A second note in the same minute gets `-2`.
- With the mods-hub plugin installed, the decisions recorded in the last day by this and other sessions on the project are passed along, so Goal and Gotchas can name them with their reasons.
- Nothing runs in the background. Timestamps use the session's clock.
