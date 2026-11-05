# claude-mods

Claude Code mods by Gabriel Belisario.

| Mod | What it does |
| --- | --- |
| [standup](standup/README.md) | `/standup` summarises what you did since your last standup, from git history and your Claude Code and Codex sessions, with ticket status from GitHub and Jira, one line per ticket, ready to paste. |
| [handoff](handoff/README.md) | `/handoff` writes a short handoff note for a Jira ticket from Jira, your Claude Code and Codex sessions, git and the current conversation. |
| [tick-sprint](tick-sprint/README.md) | `/tick <hours>` splits the hours you worked in a sprint across your Jira epics, weighted by each issue's time in an active status, ready to log in Tick. |

## Install
At the prompt of a Claude Code terminal session, answer `y` to add the marketplace, then pick a scope:

```
/plugin install standup --marketplace GabrielBels/claude-mods
/plugin install handoff --marketplace GabrielBels/claude-mods
/plugin install tick-sprint --marketplace GabrielBels/claude-mods
```

From a shell:

```
claude plugin install tick-sprint --marketplace GabrielBels/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `GabrielBels/claude-mods`, then Add plugin.

## Configuration
Each mod's README lists its options. The Jira locations (`jiraApi`, `jiraSite`) are sensitive options: Claude Code keeps them in its secure storage, not in `settings.json`. Jira credentials for standup and handoff come from the `JIRA_API_EMAIL` and `JIRA_API_TOKEN` environment variables, or `~/.jira-cred` (`email:token`); tick-sprint reads Jira through the claude.ai Atlassian connector and needs none.

## License
MIT. See [LICENSE](LICENSE), and each mod's own `LICENSE` where it has one.
