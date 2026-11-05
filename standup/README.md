# standup

**Your daily standup, written from what you actually did.**

`/standup` reads your commits, your work in progress and the prompts you wrote in Claude Code and Codex since the last standup. It turns them into one line per ticket and ends each line with where the ticket really stands in Jira and GitHub, not the model's guess. Investigation, reviews and spikes count too, because they live in your sessions even when they leave no commit.

```text
/standup
- PROJ-2458: Made the recycle bin pager stay in view by sizing the grid wrapper (Dev Testing, PR #1904 merged)
- PROJ-2425: Mapped every order.CreatedBy reference and opened PROJ-2479 for the change (In Development)
- PRs #142 and #1913 reviewed
```

## What you get
- **One bullet per ticket** or requirement (`PROJ-2458: …`, `REQ-012: …`), each naming a single ticket.
- **Real status at the end of each bullet**, from your pull requests (`gh`) and, with `jiraApi` set, from Jira: `To Do`, `Dev Testing, PR #1890 merged`, `Blocked, assigned to Jane Doe`.
- **Reviews in one line:** `PRs #1890, #1913, and #142 reviewed`. Your own merged PRs are not counted as reviews.
- **Blockers** only when the activity shows one.
- **A pane** with the text exactly as it will paste, **Copy** (`c`), **Regenerate** (`r`) and **Close**.
- **A fallback:** when the model is unavailable, you still get a standup listed straight from git.

## Usage
- `/standup` covers the time since the latest standup held on a weekday, with `standupTime` set; otherwise since yesterday's midnight (Friday's on a Monday).
- `/standup 3` goes back to the 3rd latest standup, with `standupTime` set; otherwise the last 3 days (1–30).
- **Many repositories at once:** run it outside a git repository and it covers every git repository one level down, each filtered by its own `user.email` and tagged with its folder name. Repositories with no activity are left out.
- **svn too:** with `svnAuthor` set, svn working copies count, and a folder that is no repository is searched one more level down for them (`customer-branches/GLOBEX`). A working copy whose server is out of reach is named in the detail line.

## Which tickets get a bullet
A ticket gets a bullet when a commit, a branch or a session title is about it, or when a session on another ticket names it in your prompts (a ticket you created during a spike). Tickets named in sessions about no ticket (tooling, this standup) get none.

## Setup
To read Jira, set `jiraApi` and give the mod an API token through the `JIRA_API_EMAIL` and `JIRA_API_TOKEN` environment variables, or `~/.jira-cred` (`email:token`). Without them the standup still works, with status from GitHub only.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `haiku` | Model that writes the standup (alias or full id). |
| `style` | `plain` \| `markdown` \| `slack` | `plain` | Paste format: `Heading:` lines, `**bold**` headings, or Slack's `*bold*` and `•` bullets. |
| `allBranches` | boolean | `true` | Count commits on every branch, not just the checked-out one. |
| `svnAuthor` | string | `""` | Your svn user name; set it to include svn working copies. |
| `sessionDirs` | string | `~/.claude/projects, ~/.codex/sessions` | Comma-separated Claude Code projects and Codex sessions folders; empty leaves sessions out. On WSL, add the Windows ones (`/mnt/c/Users/<you>/.claude/projects`, `/mnt/c/Users/<you>/.codex/sessions`). |
| `sessionScope` | string | `""` | Comma-separated folders a session must have worked in to count; empty means the folder that holds the repository. Windows paths (`D:\work`) match their `/mnt/d/work` form. |
| `standupTime` | string | `""` | When the daily standup starts, `HH:MM` in `standupTimeZone`; the window starts at the latest one held Monday to Friday. Empty: midnight of the last workday. |
| `standupTimeZone` | string | `""` | IANA zone of `standupTime`. A zone with daylight saving moves the meeting in your own time (`10:45` in `America/New_York` is 12:45 in São Paulo in the northern winter, 11:45 in the summer). Empty: your computer's zone. |
| `jiraApi` | string (sensitive) | `""` | Jira REST API v3 base (`https://api.atlassian.com/ex/jira/<cloud id>/rest/api/3` or `https://<site>.atlassian.net/rest/api/3`), kept in Claude Code's secure storage. Empty leaves Jira out. |

## Privacy
- Sessions are read for your own prompts (each cut to 300 characters, at most 12 per session) and the session title. Tool output and answers are never read.
- A session counts only when its working folder is inside `sessionScope`, so personal projects and automated runs elsewhere stay out.
- The model gets only that activity: no conversation history is sent.

## How it works
- `/standup` runs `git log --author=<you>` over the window, `git status`, and reads any session-journal notes in `.claude/journal/`, then calls the model once.
- Sessions are read by `scripts/sessions.py` (`python3 -I`), because a transcript can be tens of MB. It opens only transcripts touched in the window, skips project folders outside the scope by name and every `subagents/` folder.
- PR reviews are found in sessions whose title or prompts speak of a review and name a PR (`PR #1913`, `review #142`, `pull/1913`). The reviews line is added even when the model leaves it out.
- Ticket status: `gh pr list --author @me --state all` in each repository gives the newest PR whose title or branch names the ticket, and `scripts/jira.py` reads each ticket's status and assignee. A source that cannot be read is named in the detail line.
- With the mods-hub plugin installed, commits other live sessions made on branches `git log` does not reach (a worktree, a fix branch) are added too, and the model is told how many other sessions are working on the project.
- It knows only what git, the journal, your sessions, GitHub and Jira know: meetings and work done elsewhere are yours to add after pasting.
