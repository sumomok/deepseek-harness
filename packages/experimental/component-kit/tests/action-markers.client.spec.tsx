// @vitest-environment jsdom
/**
 * The gate between the catalog and the renderers: every action a kit component
 * declares has a stated disposition — the control that performs it, or the
 * reason nothing a press can reach does — and this file fails when the catalog
 * gains an action nobody has ruled on, or when a disposition names one the
 * catalog does not declare.
 *
 * What a disposition's `carried` arm means is asserted where the control is
 * drawn: the renderer's own spec drives its component and checks the control
 * carries the action's id (`confirm-bar`, `table-detail-renderer`,
 * `tu-query-cond-adv-renderer`, `data-page-renderer` and `form-page-renderer`
 * specs). This file is the cross-component half, which no single component's
 * spec can check: the catalog `act_component` reads and the marks the
 * renderers write agreeing on the same set of actions.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { COMPONENT_KIT_ENTRIES } from '@deepseek-ai/dsh-experimental-component-surface/client'
import { markTable } from '../src/client/marks.ts'

/** The disposition of an action a drawn control performs. */
const CARRIED = 'carried'

/**
 * Every action each component declares, with what performs it or what reports
 * it instead.
 *
 * A `carried` action is one the renderer marks on the control that performs
 * it; anything else is a sentence saying which gesture reports the action and
 * why this row marks no control of the drawn block for it: nothing a press can
 * reach performs it, or the block draws no control of its own because the
 * gesture belongs to a block beside it.
 */
const DISPOSITIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'el.confirm-bar': {
    press: CARRIED,
  },
  'el.filter-bar': {
    submit: CARRIED,
    change: 'reported when a condition changes rather than by a press; the value controls the edits come from carry data-component-field',
  },
  'toy.table': {
    select: CARRIED,
    'row-click': CARRIED,
    sort: CARRIED,
    operation: CARRIED,
  },
  'toy.data-page': {
    load: 'reported when the page has loaded its table; no control performs it',
    denied: 'reported when the deployment judges this account on this table; no control performs it',
    'auth-failed': 'reported when the request layer refuses the stored sign-in; no control performs it',
    query: CARRIED,
    'cell-click': CARRIED,
    select: CARRIED,
    'card-open': CARRIED,
    'card-close': CARRIED,
    added: CARRIED,
    modified: CARRIED,
    operation: CARRIED,
    exported: CARRIED,
    deleted: CARRIED,
    'batch-modified': CARRIED,
  },
  'toy.form-page': {
    added: CARRIED,
    modified: CARRIED,
  },
  'toy.info-card': {
    'card-open': 'reported when the data page hands the card the record it opened; the gesture is the page\'s own row interaction, and the card this block draws has no entrance of its own',
    'card-close': 'reported when the data page withdraws the record it published — it closed its own card, cleared the query, turned the page, or deleted the record; the card this block mounts is drawn without a closer, so no press of the block performs it',
  },
}

describe('the actions the catalog declares and the marks the renderers write', () => {
  it('states a disposition for every declared action, and names no action the catalog does not declare', () => {
    const declared: Record<string, string[]> = {}
    for (const entry of COMPONENT_KIT_ENTRIES) {
      if (entry.actions.length === 0) continue
      declared[String(entry.id)] = entry.actions.map(action => action.id)
    }
    const dispositioned: Record<string, string[]> = {}
    for (const [component, actions] of Object.entries(DISPOSITIONS)) dispositioned[component] = Object.keys(actions)
    // One comparison for both directions: an action the catalog gained is a
    // disposition missing here, and a disposition for an action that is gone
    // is a line this file no longer holds.
    expect(dispositioned).toEqual(declared)
  })

  it('writes one row operation mark per drawn control, and none past the drawn ones', () => {
    // A unit case for the pairing itself, which the vendored markup never
    // reaches with the lists unequal: a key whose control the page did not
    // draw must not land on the next row's control, which would name an
    // operation nobody pressed.
    document.body.innerHTML = `
      <div class="el-table__body-wrapper"><table><tbody><tr>
        <td><div class="column-operation"><span class="operation-custom"><a href="#">Ping</a></span></div></td>
      </tr></tbody></table></div>
    `
    markTable(document.body, { operations: { custom: ['ping', 'ghost'] } })
    expect(document.querySelector('.operation-custom a')?.getAttribute('data-component-key')).toBe('ping')
    expect(document.querySelector('[data-component-key="ghost"]')).toBeNull()
  })

  /** One table as el-table draws it: a scrolling body and a fixed layer, two records each. */
  const TABLE = `
    <div class="el-table">
      <div class="el-table__body-wrapper"><table><tbody>
        <tr class="el-table__row"><td class="el-table_1_column_1 is-hidden"><a class="trans">甲</a></td><td class="el-table_1_column_2">北京</td></tr>
        <tr class="el-table__row"><td class="el-table_1_column_1 is-hidden"><a class="trans">乙</a></td><td class="el-table_1_column_2">上海</td></tr>
      </tbody></table></div>
      <div class="el-table__fixed"><div class="el-table__fixed-body-wrapper"><table><tbody>
        <tr class="el-table__row"><td class="el-table_1_column_1"><a class="trans">甲</a></td><td class="el-table_1_column_2 is-hidden">北京</td></tr>
        <tr class="el-table__row"><td class="el-table_1_column_1"><a class="trans">乙</a></td><td class="el-table_1_column_2 is-hidden">上海</td></tr>
      </tbody></table></div></div>
    </div>
  `

  /** The row key every record row of the document carries, body by body. */
  function rowKeys(): (string | null)[][] {
    return [...document.querySelectorAll('tbody')].map(body => [...body.children].map(row => row.getAttribute('data-component-row')))
  }

  it('keys every copy of a row, takes off a key no step could carry, and leaves the keys where a pass cannot line them up', () => {
    document.body.innerHTML = TABLE
    markTable(document.body, { rowKeys: () => ['1044', '1045'] })
    expect(rowKeys()).toEqual([['1044', '1045'], ['1044', '1045']])
    // A pass whose keys do not line up with the drawn rows writes nothing.
    markTable(document.body, { rowKeys: () => ['1046'] })
    markTable(document.body, { rowKeys: () => undefined })
    expect(rowKeys()).toEqual([['1044', '1045'], ['1044', '1045']])
    // A key a step could not carry, or none, is taken off the row.
    markTable(document.body, { rowKeys: () => ['a b', undefined] })
    expect(rowKeys()).toEqual([[null, null], [null, null]])
  })

  it('marks each record\'s name cell in the pass that writes its key, and leaves the names with the keys', () => {
    document.body.innerHTML = TABLE
    /** The cells marked as their row's name, by the words they draw. */
    const names = (): string[] => [...document.querySelectorAll('[data-component-row-name]')].map(cell => cell.textContent ?? '')
    // A pass that cannot key the rows names none of them either.
    markTable(document.body, { rowKeys: () => undefined })
    expect(names()).toEqual([])
    markTable(document.body, { rowKeys: () => ['1044', '1045'] })
    expect(names()).toEqual(['甲', '乙'])
    expect([...document.querySelectorAll('[data-component-row-name]')].every(cell => cell.closest('.el-table__fixed') !== null)).toBe(true)
    // A pass that leaves the keys leaves the names, and one that writes keys
    // takes the mark off a cell no longer named.
    const stale = document.querySelector('.el-table__body-wrapper td.el-table_1_column_2') as Element
    stale.setAttribute('data-component-row-name', '')
    markTable(document.body, { rowKeys: () => ['1046'] })
    expect(names()).toEqual(['北京', '甲', '乙'])
    markTable(document.body, { rowKeys: () => ['1044', '1045'] })
    expect(names()).toEqual(['甲', '乙'])
  })

  it('marks each drawn record link with the column it is drawn in, and with no own key where the table names none', () => {
    document.body.innerHTML = TABLE
    const table = document.querySelector('.el-table') as Element
    markTable(document.body, { link: 'card-open' })
    const links = (): (string | null)[][] => [...document.querySelectorAll('a.trans')]
      .map(link => [link.getAttribute('data-component-action'), link.getAttribute('data-component-key')])
    // The placeholder copies stay unmarked; the drawn ones carry the action.
    expect(links()).toEqual([[null, null], [null, null], ['card-open', null], ['card-open', null]])
    // el-table holds its columns on its own component, by the id each cell carries.
    Object.assign(table, { __vue__: { columns: [{ id: 'el-table_1_column_1', property: 'zh_label' }, { id: 'el-table_1_column_2', property: 'city' }] } })
    markTable(document.body, { link: 'card-open' })
    expect(links()).toEqual([[null, null], [null, null], ['card-open', 'zh_label'], ['card-open', 'zh_label']])
    // A column whose property no step could carry gives the link no own key.
    Object.assign(table, { __vue__: { columns: [{ id: 'el-table_1_column_1', property: 'zh label' }] } })
    markTable(document.body, { link: 'card-open' })
    expect(links()).toEqual([[null, null], [null, null], ['card-open', null], ['card-open', null]])
  })
})
