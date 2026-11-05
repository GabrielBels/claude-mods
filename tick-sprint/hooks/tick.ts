// Pure sprint/time math: no `$`, so the tests drive it directly.
import type { EpicHours, IssueTime, TickReport } from '../types'

export type Settings = {
  anchor: string
  sprintDays: number
  utcOffsetHours: number
  activeStatuses: string[]
}

export type ChangeItem = {
  field: string
  from: string | null
  to: string | null
  fromString: string | null
  toString: string | null
}

export type History = { created: number; items: ChangeItem[] }

export type Issue = {
  key: string
  summary: string
  status: string
  assigneeId: string | null
  epic: string
  epicName: string
  histories: History[]
  /** the changelog came back cut and its oldest entry falls inside the sprint */
  isChangelogPartial: boolean
}

export type Sprint = { start: number; end: number }

const DAY = 86_400_000
const HOUR = 3_600_000
const STEP = 0.25

/** Day number (days since 1970-01-01) of `AAAA-MM-DD`, or null. */
export const parseDay = (text: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (!m) return null
  const [, y = '', mo = '', d = ''] = m
  return Math.floor(Date.UTC(+y, +mo - 1, +d) / DAY)
}

export const formatDay = (day: number): string => new Date(day * DAY).toISOString().slice(0, 10)

const dayOf = (ms: number, offset: number): number => Math.floor((ms + offset * HOUR) / DAY)
export const dayStart = (day: number, offset: number): number => day * DAY - offset * HOUR
const isWeekday = (day: number): boolean => {
  const w = new Date(day * DAY).getUTCDay()
  return w >= 1 && w <= 5
}

export const USAGE = 'Use /tick <hours> [-1 | +1 | YYYY-MM-DD | DD/MM], e.g. /tick 72 or /tick 75.5 -1.'

/** `<horas> [sprint]`: the hours worked in the sprint, then which sprint. */
export const parseArgs = (args: string): { hours: number; sprint: string } | { error: string } => {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const m = /^(\d+(?:[.,]\d+)?)h?$/i.exec(first)
  const hours = m ? Number((m[1] ?? '').replace(',', '.')) : NaN
  if (!(hours > 0)) return { error: `Give the hours you worked in the sprint. ${USAGE}` }
  return { hours, sprint: rest.join(' ') }
}

/**
 * The sprint an argument names: empty for the current one, `-1`/`+1` relative
 * to it, or a date inside it (`AAAA-MM-DD`, `DD/MM` or `DD/MM/AAAA`).
 */
export const resolveSprint = (arg: string, nowMs: number, s: Settings): Sprint | { error: string } => {
  const anchor = parseDay(s.anchor)
  if (anchor === null) return { error: `Invalid sprint anchor: "${s.anchor}" (use YYYY-MM-DD).` }
  if (!(s.sprintDays > 0)) return { error: `Invalid sprint length: ${s.sprintDays}.` }

  const today = dayOf(nowMs, s.utcOffsetHours)
  const text = arg.trim()
  let target = today
  let shift = 0

  if (/^[+-]\d{1,3}$/.test(text) || text === '0') {
    shift = Number(text)
  } else if (text !== '') {
    const br = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text)
    const [, dd = '', mm = '', yyyy = String(new Date(today * DAY).getUTCFullYear())] = br ?? []
    const day = br ? parseDay(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`) : parseDay(text)
    if (day === null) return { error: `Unknown sprint "${text}". ${USAGE}` }
    target = day
  }

  const k = Math.floor((target - anchor) / s.sprintDays) + shift
  const start = anchor + k * s.sprintDays
  return { start, end: start + s.sprintDays }
}

/**
 * Milliseconds the issue spent in an active status while assigned to `me`,
 * inside [fromMs, toMs), weekends left out.
 */
export const activeMs = (issue: Issue, me: string, s: Settings, fromMs: number, toMs: number): number => {
  const active = new Set(s.activeStatuses.map(x => x.trim().toLowerCase()).filter(Boolean))
  const hs = [...issue.histories].sort((a, b) => a.created - b.created)
  const first = (field: string): ChangeItem | undefined => {
    for (const h of hs) for (const it of h.items) if (it.field === field) return it
    return undefined
  }
  const firstStatus = first('status')
  const firstAssignee = first('assignee')
  let status: string | null = firstStatus ? firstStatus.fromString : issue.status
  let assignee: string | null = firstAssignee ? firstAssignee.from : issue.assigneeId
  let total = 0

  const add = (a: number, b: number) => {
    if (assignee !== me || status === null || !active.has(status.toLowerCase())) return
    let t = Math.max(a, fromMs)
    const hi = Math.min(b, toMs)
    while (t < hi) {
      const d = dayOf(t, s.utcOffsetHours)
      const next = Math.min(hi, dayStart(d + 1, s.utcOffsetHours))
      if (isWeekday(d)) total += next - t
      t = next
    }
  }

  let cursor = -Infinity
  for (const h of hs) {
    add(cursor, h.created)
    for (const it of h.items) {
      if (it.field === 'status') status = it.toString ?? status
      if (it.field === 'assignee') assignee = it.to
    }
    cursor = h.created
  }
  add(cursor, Infinity)
  return total
}

/** Splits `total` hours by weight in steps of 0.25h, the parts summing to `total` rounded to 0.25h. */
export const allocate = (weights: Map<string, number>, total: number): Map<string, number> => {
  const entries = [...weights].filter(([, w]) => w > 0)
  const sum = entries.reduce((a, [, w]) => a + w, 0)
  const out = new Map<string, number>()
  if (sum <= 0) return out
  const units = Math.round(total / STEP)
  const parts = entries.map(([k, w]) => {
    const exact = (w / sum) * units
    return { k, base: Math.floor(exact), rest: exact - Math.floor(exact) }
  })
  let left = units - parts.reduce((a, p) => a + p.base, 0)
  for (const p of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break
    p.base += 1
    left -= 1
  }
  for (const p of parts) if (p.base > 0) out.set(p.k, p.base * STEP)
  return out
}

const byHoursDesc = (a: EpicHours, b: EpicHours) => b.hours - a.hours || a.name.localeCompare(b.name)

export const buildReport = (
  issues: Issue[],
  me: string,
  s: Settings,
  sprint: Sprint,
  nowMs: number,
  totalHours: number,
): TickReport => {
  const off = s.utcOffsetHours
  const fromMs = dayStart(sprint.start, off)
  const toMs = Math.min(dayStart(sprint.end, off), nowMs)
  const names = new Map<string, string>()
  const weights = new Map<string, number>()
  const issueTimes: IssueTime[] = []
  const notes: string[] = []
  const cancelled: string[] = []
  const partial: string[] = []

  for (const issue of issues) {
    if (/cancel/i.test(issue.status)) {
      cancelled.push(issue.key)
      continue
    }
    if (issue.isChangelogPartial) partial.push(issue.key)
    const ms = activeMs(issue, me, s, fromMs, toMs)
    if (ms <= 0) continue
    names.set(issue.epic, issue.epicName)
    weights.set(issue.epic, (weights.get(issue.epic) ?? 0) + ms)
    issueTimes.push({ key: issue.key, summary: issue.summary, epic: issue.epic, activeHours: round2(ms / HOUR) })
  }

  const totals = [...allocate(weights, totalHours)]
    .map(([epic, hours]) => ({ epic, name: names.get(epic) ?? epic, hours }))
    .sort(byHoursDesc)

  if (totals.length === 0) notes.push('None of your issues was in an active status in this sprint; nothing to split.')
  if (sprint.end > dayOf(nowMs, off) + 1) notes.push('Sprint in progress: the split uses the time so far.')
  if (cancelled.length > 0) notes.push(`Left out as cancelled: ${cancelled.join(', ')}.`)
  if (partial.length > 0) notes.push(`Changelog cut short (time may be too low): ${partial.join(', ')}.`)

  return {
    sprintStart: formatDay(sprint.start),
    sprintEnd: formatDay(sprint.end),
    totalHours,
    totals,
    issues: issueTimes.sort((a, b) => b.activeHours - a.activeHours),
    notes,
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export const fmtHours = (h: number): string => h.toFixed(2).replace(/\.?0+$/, '')

export const brDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

export const epicLabel = (e: EpicHours): string => (e.epic === '' ? e.name : `${e.name} (${e.epic})`)

/** The report as plain text for the transcript. */
export const formatText = (r: TickReport): string => {
  const lines = [`Tick · sprint ${brDate(r.sprintStart)}–${brDate(r.sprintEnd)} · ${fmtHours(r.totalHours)}h`, '']
  if (r.totals.length > 0) {
    lines.push('By epic:')
    for (const e of r.totals) lines.push(`  ${fmtHours(e.hours).padStart(6)}h  ${epicLabel(e)}`)
    lines.push('', 'Issues (hours in an active status, the base of the split):')
    for (const i of r.issues) lines.push(`  ${fmtHours(i.activeHours).padStart(6)}h  ${i.key} ${i.summary}`)
  }
  if (r.notes.length > 0) lines.push('', ...r.notes.map(n => `• ${n}`))
  return lines.join('\n')
}

/** One row per epic, tab-separated, to paste into a spreadsheet. */
export const formatTsv = (r: TickReport): string =>
  ['Epic\tHoras', ...r.totals.map(e => `${epicLabel(e)}\t${fmtHours(e.hours)}`)].join('\n')
