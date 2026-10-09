// @vitest-environment jsdom
/**
 * The gate between the catalog and the renderers: every action a kit component
 * declares has a stated disposition — the control that performs it, or the
 * reason nothing a press can reach does — and this file fails when the catalog
 * gains an action nobody has ruled on, or when a disposition names one the
 * catalog does not declare.
 *
 * What a disposition's `carried` arm means is asserted where the control is
 * drawn: each renderer's own spec drives its component and checks the control
 * carries the action's id (`confirm-bar`, `table-detail-renderer`,
 * `tu-query-cond-adv-renderer` and `data-page-renderer` specs). This file is
 * the cross-component half, which no single component's spec can check: the
 * catalog `act_component` reads and the marks the renderers write agreeing on
 * the same set of actions.
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
 * why no control of the drawn block performs it. The reasons are the ones the
 * delivery report's table carries.
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
    'card-open': 'the page opens its side card from the row interaction already marked as cell-click; the action has no control of its own',
    'card-close': 'the card draws its own closer inside the vendored component, which this row identifies by no stable class and does not mark',
    added: CARRIED,
    modified: CARRIED,
    operation: CARRIED,
    exported: CARRIED,
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
      <div class="el-table__body-wrapper"><tbody><tr>
        <td><div class="column-operation"><span class="operation-custom"><a href="#">Ping</a></span></div></td>
      </tr></tbody></div>
    `
    markTable(document.body, { operations: { custom: ['ping', 'ghost'] } })
    expect(document.querySelector('.operation-custom a')?.getAttribute('data-component-key')).toBe('ping')
    expect(document.querySelector('[data-component-key="ghost"]')).toBeNull()
  })

  it('carries every action a class of controls performs', () => {
    // A `carried` action's control is asserted in the renderer's own spec, so
    // what is checked here is that the marker names at least the actions this
    // delivery claims are reachable, and that every other disposition says why.
    const carried = Object.entries(DISPOSITIONS).flatMap(([component, actions]) =>
      Object.entries(actions).filter(([, disposition]) => disposition === CARRIED).map(([action]) => `${component}/${action}`))
    expect(carried).toEqual([
      'el.confirm-bar/press',
      'el.filter-bar/submit',
      'toy.table/select',
      'toy.table/row-click',
      'toy.table/sort',
      'toy.table/operation',
      'toy.data-page/query',
      'toy.data-page/cell-click',
      'toy.data-page/select',
      'toy.data-page/added',
      'toy.data-page/modified',
      'toy.data-page/operation',
      'toy.data-page/exported',
    ])
  })
})
