/** General Settings row for when `/compact` runs while the agent is running a turn. */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ManualCompactionWhileBusy } from '@deepseek-ai/dsh-compaction/types'
import type { ChatKey } from '../locale.ts'
import { PreferenceRow } from './PreferenceRow.tsx'

/** Registration-side busy-state compaction preference. */
export interface BusyCompactionRowInjected {
  hooks: {
    /** Current timing, bound as useBusyCompaction. */
    busyCompaction: ObservableSnapshot<ManualCompactionWhileBusy>
  }
  /** Change when `/compact` runs while the agent is running a turn. */
  setBusyCompaction: (mode: ManualCompactionWhileBusy) => void
}

/** Full Settings-row props. */
export type BusyCompactionRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'chat'>
  & InjectFace<BusyCompactionRowInjected>

const LABELS: Readonly<Record<ManualCompactionWhileBusy, ChatKey>> = {
  'next-step': 'settings.compaction.nextStep',
  'turn-end': 'settings.compaction.turnEnd',
}

/**
 * Render the busy-state `/compact` timing selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function BusyCompactionRow({ useBusyCompaction, setBusyCompaction, t }: BusyCompactionRowProps) {
  const mode = useBusyCompaction(value => value)
  return (
    <PreferenceRow
      title={t('settings.compaction.title')}
      description={t('settings.compaction.description')}
      value={mode}
      selectedLabel={t(LABELS[mode])}
      options={(['next-step', 'turn-end'] as const).map(id => ({ id, label: t(LABELS[id]) }))}
      onSelect={(value) => { setBusyCompaction(value as ManualCompactionWhileBusy) }}
    />
  )
}
