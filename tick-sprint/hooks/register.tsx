import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { TickView } from '../types'
import { loadIssues } from './jira'
import { brDate, buildReport, dayStart, epicLabel, fmtHours, formatDay, formatText, formatTsv, parseArgs, resolveSprint, USAGE } from './tick'
import type { Settings } from './tick'

const PANE = 'tick-sprint'
const TITLE = 'Tick · sprint'
// Change the tag when TickView's fields change: it declines what an earlier version stored.
const view = atom({ plugin: 'tick-sprint', key: 'view' } as const, { kind: 'empty' } as TickView, {
  shape: 'view-2',
})

const str = (o: PluginOptions, k: string, d: string) => (typeof o[k] === 'string' ? (o[k] as string) : d)
const num = (o: PluginOptions, k: string, d: number) => (typeof o[k] === 'number' ? (o[k] as number) : d)

const settingsOf = (o: PluginOptions): Settings & { site: string } => ({
  site: str(o, 'jiraSite', '').trim(),
  anchor: str(o, 'sprintAnchor', '2026-10-28'),
  sprintDays: num(o, 'sprintDays', 14),
  utcOffsetHours: num(o, 'utcOffsetHours', -3),
  activeStatuses: str(o, 'activeStatuses', 'In Development, In Progress, Ready (In Progress), Code Review, Dev Testing').split(','),
})

function show($: EngineInterface, next: TickView) {
  return update($, view, () => next)
}

async function run($: EngineInterface, args: string, s: Settings & { site: string }) {
  if (s.site === '') throw new Error('Set your Jira site (jiraSite) for tick-sprint in /plugin.')
  const parsed = parseArgs(args)
  if ('error' in parsed) throw new Error(parsed.error)
  const now = await $.clock.now()
  const sprint = resolveSprint(parsed.sprint, now, s)
  if ('error' in sprint) throw new Error(sprint.error)
  const fromMs = dayStart(sprint.start, s.utcOffsetHours)
  const { issues, me } = await loadIssues($, s.site, formatDay(sprint.start), formatDay(sprint.end), fromMs, label =>
    show($, { kind: 'loading', label }),
  )
  return buildReport(issues, me, s, sprint, now, parsed.hours)
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tick',
      description: 'Split your sprint hours across your Jira epics, ready to log in Tick',
      argumentHint: '<hours> [-1 | YYYY-MM-DD | DD/MM]',
    })
    return next(e)
  })

  on('command.run', { command: 'tick' }, async ($, e) => {
    await show($, { kind: 'loading', label: 'Working out the sprint…' })
    await $.ui.open({ id: PANE, title: TITLE })
    try {
      const report = await run($, e.args, settings)
      await show($, { kind: 'ready', report })
      const text = formatText(report)
      return { text, context: [`Resumo do Tick calculado pelo comando /tick:\n${text}`] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await show($, { kind: 'error', message })
      return { text: `/tick failed: ${message}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const width = Math.max(20, e.props.bodyColumns)
    const fit = (t: string) => (t.length > width ? `${t.slice(0, width - 1)}…` : t)

    if (v.kind === 'empty') return <Text dimColor>{USAGE}</Text>
    if (v.kind === 'loading') return <Text dimColor>{v.label}</Text>
    if (v.kind === 'error') return <Text color="red">{v.message}</Text>

    const r = v.report
    return (
      <Box flexDirection="column">
        <Text bold>
          Sprint {brDate(r.sprintStart)}–{brDate(r.sprintEnd)} · {fmtHours(r.totalHours)}h
        </Text>
        <Text> </Text>
        {r.totals.map(t => (
          <Text>{fit(`${fmtHours(t.hours).padStart(6)}h  ${epicLabel(t)}`)}</Text>
        ))}
        {r.notes.length > 0 && <Text> </Text>}
        {r.notes.map(n => (
          <Text dimColor>• {n}</Text>
        ))}
        <Text> </Text>
        <Button
          key="copy"
          label="Copy (TSV)"
          onPress={() => $.ui.copy({ text: formatTsv(r), surface: e.surface })}
        />
      </Box>
    )
  })
}
