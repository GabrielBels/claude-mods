# claude-mods

**Four Claude Code mods for the paperwork around the code: the daily standup, the ticket handoff, the timesheet and what QA can test.**

They read what you already left behind in git, Jira and your Claude Code and Codex sessions, and hand you text that is ready to paste. Each one is a slash command, and each answer also opens in a pane with a Copy button.

| Mod | You type | You get |
| --- | --- | --- |
| [**standup**](standup/README.md) | `/standup` | One line per ticket about what you did since the last standup, each ending with the ticket's real status from Jira and GitHub. |
| [**handoff**](handoff/README.md) | `/handoff PROJ-2458` | A short handoff note (Goal, Status, What changed, Next steps, Gotchas, How to verify) built from Jira, git, your other sessions and the current conversation. |
| [**tick-sprint**](tick-sprint/README.md) | `/tick 72` | Your 72 sprint hours split across your Jira epics, weighted by how long each issue was really in progress, ready to log in Tick. |
| [**whats-in-qa**](whats-in-qa/README.md) | `/whats-in-qa` | The sprint tickets whose code is already in the build deployed to QA, plus the ones partly deployed or merged and waiting for a deploy. |

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
/plugin install whats-in-qa --marketplace GabrielBels/claude-mods
```

From a shell, use `claude plugin install <mod> --marketplace GabrielBels/claude-mods`. In the desktop app, where `/plugin` does not run, click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `GabrielBels/claude-mods`, then **Add plugin**.

The install shows a settings screen for each mod. Every option has a default except, for whats-in-qa, the Octopus space and projects. To change a setting later, open `/plugin` and configure the mod.

## What each mod needs
| | standup | handoff | tick-sprint | whats-in-qa |
| --- | --- | --- | --- | --- |
| git | yes | yes | — | — |
| Python 3 | yes | yes | — | — |
| GitHub CLI (`gh`, signed in) | for PR status | for the ticket's PRs | — | required |
| Jira | optional: `~/.config/jira.json` | optional: `~/.config/jira.json` | required: `~/.config/jira.json` | required: `~/.config/jira.json` |
| Octopus Deploy MCP server | — | — | — | required |
| svn | optional, for svn working copies | optional, for svn working copies | — | — |

## Jira setup
All four mods read Jira from one file, `~/.config/jira.json`, that you create once:

```json
{"apiBase": "https://api.atlassian.com/ex/jira/<cloud id>/rest/api/3", "email": "<your Atlassian email>", "token": "<API token>"}
```

1. To find your cloud id, open `https://<site>.atlassian.net/_edge/tenant_info` in a browser.
2. To get a token, create a scoped API token (Jira app, scope `read:jira-work`) at https://id.atlassian.com/manage-profile/security/api-tokens. Scoped tokens only work through the `api.atlassian.com` gateway above.
3. To write the file without the token showing up in your shell history, run:
   ```bash
   read -s -p "Token: " T && mkdir -p ~/.config && printf '{"apiBase": "%s", "email": "%s", "token": "%s"}\n' 'https://api.atlassian.com/ex/jira/<cloud id>/rest/api/3' '<email>' "$T" > ~/.config/jira.json && chmod 600 ~/.config/jira.json && unset T
   ```

`JIRA_API_BASE`, `JIRA_API_EMAIL` and `JIRA_API_TOKEN` override the file's values. Without the file, standup works from GitHub alone, handoff writes the note and says Jira was not read, and tick-sprint and whats-in-qa ask you to create it.

## Your secrets stay on your machine
- **Jira:** every mod reads your Jira site and token from `~/.config/jira.json`, readable only by you (`chmod 600`); the token is only sent to your Jira's API. Nothing in this repository holds anyone's values.
- **whats-in-qa:** also reads Octopus through your Octopus Deploy MCP server and GitHub through your `gh` sign-in.
- **Your sessions:** the mods read your own prompts and session titles, never tool output. The model that writes the text gets only that activity, not your conversation history.

## Develop
To run a mod's tests, use `claude plugin test <mod folder>`. To check a mod's manifest and hooks the way Claude Code loads them, use `claude plugin validate <mod folder>`. To try a change before installing it, start a session with `claude --plugin-dir ./<mod folder>`.

## License
MIT. See [LICENSE](LICENSE), and each mod's own `LICENSE` where it has one.
