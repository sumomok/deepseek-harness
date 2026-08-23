/**
 * The demo panel: {@link EChartsBar} plus the React state that exercises both
 * directions across the bridge.
 *
 * Everything framework-shaped stops here. The component resolves its slot share
 * (the locale seat `t`), owns the data set and the last selection in React
 * state, and hands the chart a flat record of strings, numbers, and one
 * callback. Nothing below this file imports React, and nothing above it imports
 * Vue.
 *
 * The panel names no slot: it is what a placement plugin registers, not a
 * placement itself.
 */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { EChartsBar } from './EChartsBar.tsx'
import css from './chart.module.css'

/** Composed slot props: this package's locale seat, and nothing about a layout. */
export type ChartPanelProps = PropsLocale<'vue2EchartsPoc'>

/** The seven dictionary keys the demo plots, in axis order. */
const CATEGORY_KEYS = [
  'panel.category.1', 'panel.category.2', 'panel.category.3', 'panel.category.4',
  'panel.category.5', 'panel.category.6', 'panel.category.7',
] as const

/** Opening data set: fixed, so a screenshot and a browser scenario read the same bars. */
const SEED_VALUES: readonly number[] = [120, 200, 150, 80, 70, 110, 130]

/** Bar heights the Randomize button installs; the range keeps every bar visible. */
function randomValues(): number[] {
  return SEED_VALUES.map(() => 20 + Math.round(Math.random() * 180))
}

/** One bar's identity as the chart reported it. */
interface Selection {
  /** Category label the chart reported. */
  category: string
  /** Bar height the chart reported. */
  value: number
}

/**
 * Render the demo chart panel.
 * @param props - composed slot props.
 * @returns the panel body.
 */
export function ChartPanel({ t }: ChartPanelProps) {
  const [values, setValues] = useState<readonly number[]>(SEED_VALUES)
  const [selected, setSelected] = useState<Selection | null>(null)

  return (
    <div className={css.panel}>
      <div className={css.chartSlot}>
        <EChartsBar
          title={t('panel.title')}
          categories={CATEGORY_KEYS.map(key => t(key))}
          values={values}
          selectedLabel={selected === null
            ? t('panel.unselected')
            : t('panel.selected', { category: selected.category, value: selected.value })}
          onSelect={(category, value) => { setSelected({ category, value }) }}
        />
      </div>
      <button
        className={css.button}
        type="button"
        onClick={() => { setValues(randomValues()) }}
      >
        {t('panel.randomize')}
      </button>
    </div>
  )
}
