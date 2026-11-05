# standup
> /standup summarises what you did since your last standup, from git history and your Claude Code and Codex sessions, with ticket status from GitHub and Jira, one line per ticket, ready to paste.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
`/standup` collects your commits (by your `git config user.email`, across all branches) since your last standup (with `standupTime` set) or else the start of your last workday, your branch and work in progress, any session-journal notes in `.claude/journal/`, and the prompts you wrote in Claude Code and Codex sessions in that window, so investigation, brainstorming, testing and reviews count as work. A fast model turns that into one update list, one bullet per Jira ticket or requirement (`PROJ-2458: …`, `REQ-012: …`), shown in a pane with a Copy button; a **Blockers** list follows only when the activity shows one. Reviewed pull requests are folded into one bullet: `PRs #1890, #1913, and #142 reviewed`. Each ticket the activity names is looked up in your pull requests (`gh`) and, with `jiraApi` set, in Jira, and each ticket bullet ends with that status (`To Do`, `Dev Testing, PR #1890 merged`, `Blocked, assigned to Jane Doe`) in place of the model's guess. Each bullet names one ticket. A ticket gets a bullet when a commit, a branch or a session title is about it, or when a session on another ticket names it in your prompts (a ticket you created during a spike); tickets named in sessions on no ticket (tooling, this standup) get none. Every review bullet the model writes is replaced by the one PR reviews line. Without `standupTime`, on a Monday it looks back to Friday. If the model is unavailable you still get a standup listed straight from git.

## Usage
- `/standup` — since the latest standup held on a weekday, with `standupTime` set; else since yesterday's midnight (Friday's on a Monday).
- `/standup 3` — since the 3rd latest standup, with `standupTime` set; else the last 3 days (1–30).
- Outside a git repository, it covers every git repository directly inside the current folder (one level down) in one standup. Each repository's commits are filtered by that repository's own `user.email`, tagged with its folder name for the model, and repositories with no activity are left out. With `svnAuthor` set, svn working copies count too, and a folder that is no repository is looked into one more level for svn working copies only (`customer-branches/GLOBEX`). `svn log` asks the server, so a working copy whose server is out of reach is named in the detail line instead.
- The **Standup** pane shows the text exactly as it will paste, with **Copy** (`c`), **Regenerate** (`r`) and **Close**:

```
- PROJ-2458: Made the recycle bin pager stay in view by sizing the grid wrapper (Dev Testing, PR #1904 merged)
- PROJ-2425: Mapped every order.CreatedBy reference and opened PROJ-2479 for the change (In Development)
- PRs #142 and #1913 reviewed
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `haiku` | Model that writes the standup (alias or full id). |
| `style` | `plain` \| `markdown` \| `slack` | `plain` | Paste format: `Heading:` lines, `**bold**` headings, or Slack's `*bold*` and `•` bullets. |
| `allBranches` | boolean | `true` | Count commits on every branch, not just the checked-out one. |
| `svnAuthor` | string | `""` | Your svn user name; set it to include svn working copies. |
| `sessionDirs` | string | `~/.claude/projects, ~/.codex/sessions` | Comma-separated Claude Code projects and Codex sessions folders; empty leaves sessions out. On WSL, add the Windows ones (`/mnt/c/Users/<you>/.claude/projects`, `/mnt/c/Users/<you>/.codex/sessions`). |
| `standupTime` | string | `""` | When the daily standup starts, `HH:MM` in `standupTimeZone`; the window starts at the latest one held Monday to Friday. Empty: midnight of the last workday. |
| `standupTimeZone` | string | `""` | IANA zone of `standupTime`; a zone with daylight saving moves the meeting in your own time (`10:45` in `America/New_York` is 12:45 in São Paulo in the northern winter, 11:45 in the summer). Empty: your computer's zone. |
| `jiraApi` | string (sensitive) | `""` | Jira REST API v3 base (`https://<site>.atlassian.net/rest/api/3`), kept in Claude Code's secure storage, to read each ticket's status and assignee, with `JIRA_API_EMAIL` and `JIRA_API_TOKEN` or `~/.jira-cred` (`email:token`). Empty leaves Jira out. |
| `sessionScope` | string | `""` | Comma-separated folders a session must have worked in to count; empty means the folder that holds the repository. Windows paths (`D:\work`) match their `/mnt/d/work` form. |

## How it works
- `command.run` (`/standup`) runs `git log --since="N days ago midnight" --author=<you>`, `git status` and reads journal files through `$.fs`, then calls `$.model.complete` (no conversation history is sent, only that activity).
- The pane draws from `$.state`; Copy uses `$.ui.copy` on the surface you pressed it on.
- Sessions are read by `scripts/sessions.py` (`python3 -I`), since a transcript can be tens of MB and `$.fs.read` stops at 4 MiB. It opens only transcripts touched in the window, skips Claude Code project folders outside the scope by name and every `subagents/` folder, and keeps only your own prompts (each cut to 300 characters, at most 12 per session) and the session title. Tool output and answers are never read. A session counts when its working folder is inside `sessionScope`, so personal projects and automated runs elsewhere stay out.
- PR reviews are found in sessions whose title or prompts speak of a review and name a PR (`PR #1913`, `/dev-flow:pr-review 1913`, `review #142`, `pull/1913`); your own merged PRs (`(#1904)` in a commit subject) are left out. The line is added to the update even when the model leaves it out.
- Ticket status: `gh pr list --author @me --state all` in each git repository (named from its `origin` remote, so an ssh host alias works) gives the newest PR whose title or branch names the ticket; `scripts/jira.py` (`python3 -I`) reads each ticket's status and assignee, and a ticket is yours when it is assigned to the token's account. A source that cannot be read is named in the detail line.
- It sees only what git, the journal, your sessions, GitHub and Jira know: meetings and work done elsewhere are yours to add after pasting.
- With [mods-hub](../mods-hub) installed the mod says hello and reads the hub's `sessions.json` (one heartbeat per live session, with its latest `scope: 'global'` `git.commit` events): commits that other sessions on this project made on branches `git log` does not reach (a worktree, a fix branch) are added to the list, newest first and without duplicates, and the model is told how many other sessions are working on the project and what they have used (`Other Claude sessions on this project right now: 1 (27 turns, $3.20 so far)`). `session.ended` is not read: a session removes its own heartbeat when it ends, so only live sessions are visible. Without the hub the standup is built from git and the journal alone.
