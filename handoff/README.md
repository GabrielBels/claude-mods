# handoff
> /handoff writes a short handoff note for a Jira ticket from Jira, your Claude Code and Codex sessions, git and this conversation.

**Category:** Team & Docs · **Version:** 1.2.0-local.1

## What it does
`/handoff` asks a fork of the current conversation to write a short, factual handoff note (at most 30 lines and 300 words, one-line bullets, each fact said once) with six sections: **Goal**, **Status**, **What changed**, **Next steps**, **Gotchas** and **How to verify**.

When the branch or your words name a Jira ticket (`PROJ-2458`), the note is about that ticket, whatever this conversation was about. Before writing, the mod gathers:
- **Jira**: summary, type, status, priority, assignee, parent, description and the latest comments.
- **Your other sessions**: Claude Code and Codex sessions from the last 90 days whose branch, title, prompts or answers name the ticket (a session that created the ticket names it only in its answers). It reads your prompts, the title and the last answer, never tool output.
- **git and GitHub**: branches and worktrees named after the ticket (with each worktree's uncommitted files), commits whose message names it, and its pull requests.

The note's Goal is what the ticket asks for, and its Status compares that with what the sessions, git and the conversation show was done. Where the sources disagree (a Jira status that does not match the work, a comment that changed the scope), Gotchas says so.

Facts about the current working copy come from git, or from svn in an svn working copy such as a customer branch. The note is saved as `.claude/handoff/PROJ-2458/YYYY-MM-DD-HHMM.md` (without a ticket, `.claude/handoff/YYYY-MM-DD-HHMM.md`), copied to your clipboard and shown in a pane. It carries no absolute paths, session ids or machine names, so `communications:compose` can turn it into a Jira comment or a PR description as is.

## Usage
- `/handoff` — write, save and copy the note.
- `/handoff PROJ-2458` — name the ticket when the branch does not (`main`, svn working copies, `claude/...` branches).
- `/handoff PROJ-2458 repair script waits for DevOps` — add what the note should stress.
- To post the note, ask for it through `communications:compose`, e.g. "turn the last handoff into a Jira comment for PROJ-2458".
- The **Handoff** pane shows where it was saved, the note itself, which sources were read (`Sources: Jira · 2 other sessions · 5 commits.`), **Copy** (`c`) and **Close**. It warns when Jira could not be read or the model left a section out.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dir` | string | `.claude/handoff` | Folder for the notes, relative to the project root. |
| `copy` | boolean | `true` | Put each new note on the clipboard. |
| `jiraApi` | string (sensitive) | `""` | Jira REST API v3 base (`https://<site>.atlassian.net/rest/api/3`), kept in Claude Code's secure storage. Credentials come from `JIRA_API_EMAIL` and `JIRA_API_TOKEN`, or `~/.jira-cred` (`email:token`). Empty leaves Jira out. |
| `sessionDirs` | string | `~/.claude/projects, ~/.codex/sessions` | Session folders searched for the ticket. Empty leaves sessions out. |
| `sessionDays` | number | `90` | How many days back a session may have last been active. |

## How it works
- `command.run` (`/handoff`) reads the working copy through `$.process.run`: git, or svn when `git rev-parse` fails and `svn info` finds a working copy (`svn log` asks the server and waits up to 20 s). It takes the ticket from the first `ABC-123` key in the branch, then in your words.
- With a ticket, it runs `scripts/jira.py` (Jira REST, rich text flattened to plain text), `scripts/sessions.py` (transcripts touched in the window that name the key, the calling session left out because the fork already has it), the ticket's git refs, worktrees and commits, and `gh pr list --search <ticket>`, all at once. A source that fails is left out and named in the pane; a missing Jira also goes into Gotchas.
- `$.model.fork` writes the note with the whole conversation and those sources, which are marked as data, not instructions. The file is written with `$.fs` (a second note in the same minute gets `-2`) and copied with `$.ui.copy`.
- The pane draws from `$.state`. Nothing runs in the background. Timestamps use the session's clock.
- With [mods-hub](../mods-hub) installed the mod says hello and gives the model that writes the note the decisions recorded in the last day (the hub's `decision.recorded`: this session's, and those other sessions on the same project published for everyone, read from the hub's `sessions.json`), so the Gotchas and Goal sections can name them with their reasons. Without the hub the request is built from the conversation and the sources above.
