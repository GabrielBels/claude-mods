# claude-mods

**Three Claude Code mods for the paperwork around the code: the daily standup, the ticket handoff and the timesheet.**

They read what you already left behind in git, Jira and your Claude Code and Codex sessions, and hand you text that is ready to paste. Each one is a slash command, and each answer also opens in a pane with a Copy button.

| Mod | You type | You get |
| --- | --- | --- |
| [**standup**](standup/README.md) | `/standup` | One line per ticket about what you did since the last standup, each ending with the ticket's real status from Jira and GitHub. |
| [**handoff**](handoff/README.md) | `/handoff PROJ-2458` | A short handoff note (Goal, Status, What changed, Next steps, Gotchas, How to verify) built from Jira, git, your other sessions and the current conversation. |
| [**tick-sprint**](tick-sprint/README.md) | `/tick 72` | Your 72 sprint hours split across your Jira epics, weighted by how long each issue was really in progress, ready to log in Tick. |

```text
/standup
- PROJ-2458: Made the recycle bin pager stay in view by sizing the grid wrapper (Dev Testing, PR #1904 merged)
- PROJ-2425: Mapped every order.CreatedBy reference and opened PROJ-2479 for the change (In Development)
- PRs #142 and #1913 reviewed
```

## Install
To add the marketplace and install a mod, type this at the prompt of a Claude Code terminal session, answer `y` to add the marketplace, then pick a scope:

```text
/plugin install standup --marketplace GabrielBels/claude-mods
/plugin install handoff --marketplace GabrielBels/claude-mods
/plugin install tick-sprint --marketplace GabrielBels/claude-mods
```

From a shell, use `claude plugin install <mod> --marketplace GabrielBels/claude-mods`. In the desktop app, where `/plugin` does not run, click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `GabrielBels/claude-mods`, then **Add plugin**.

The install shows a settings screen for each mod. Every option has a default except the Jira location, described below. To change a setting later, open `/plugin` and configure the mod.

## What each mod needs
| | standup | handoff | tick-sprint |
| --- | --- | --- | --- |
| git | yes | yes | — |
| Python 3 | yes | yes | — |
| GitHub CLI (`gh`, signed in) | for PR status | for the ticket's PRs | — |
| Jira | optional: `jiraApi` + credentials | optional: `jiraApi` + credentials | required: `jiraSite` + the claude.ai Atlassian connector |
| svn | optional, for svn working copies | optional, for svn working copies | — |

## Your secrets stay on your machine
- **Jira location:** `jiraApi` (standup, handoff) and `jiraSite` (tick-sprint) are *sensitive* plugin options. Claude Code keeps them in its secure storage, not in `settings.json`, and nothing in this repository holds anyone's values.
- **Jira credentials:** standup and handoff read Jira with an API token from the `JIRA_API_EMAIL` and `JIRA_API_TOKEN` environment variables, or from `~/.jira-cred` (`email:token`). tick-sprint uses the claude.ai Atlassian connector you already signed in to, so it needs no token.
- **Your sessions:** the mods read your own prompts and session titles, never tool output. The model that writes the text gets only that activity, not your conversation history.

## Develop
To run a mod's tests, use `claude plugin test <mod folder>`. To check a mod's manifest and hooks the way Claude Code loads them, use `claude plugin validate <mod folder>`. To try a change before installing it, start a session with `claude --plugin-dir ./<mod folder>`.

## License
MIT. See [LICENSE](LICENSE), and each mod's own `LICENSE` where it has one.
