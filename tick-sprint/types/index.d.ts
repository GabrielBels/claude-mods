export type EpicHours = { epic: string; name: string; hours: number }

export type IssueTime = {
  key: string
  summary: string
  epic: string
  activeHours: number
}

export type TickReport = {
  sprintStart: string
  sprintEnd: string
  totalHours: number
  totals: EpicHours[]
  issues: IssueTime[]
  notes: string[]
}

export type TickView =
  | { kind: 'empty' }
  | { kind: 'loading'; label: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; report: TickReport }

declare module 'claude-code' {
  interface PluginState {
    'tick-sprint': { view: Shaped<TickView> }
  }
}
