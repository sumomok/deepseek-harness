/**
 * The sentences `act_component` is described, refused, and reported with.
 *
 * The report text is composed here rather than in either half's posted body, so
 * what this file pins is the phrasing of every arm: each step named the way a
 * reader knows it, the ending it had, and the two cases the report has to
 * survive — a result naming a step the call did not carry, and a failure with
 * no sentence of its own.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { MAX_MESSAGE_CHARS, type ActComponentStep } from '../src/act-component-call.ts'
import { MAX_NODE_ID_LENGTH } from '../src/component-call.ts'
import {
  ACT_COMPONENT_DESCRIPTION, KEY_DESCRIPTION, NO_ENTRY_IN_FRONT, NO_STEPS_REFUSAL, ROW_DESCRIPTION, STEP_REFUSAL_TEXT,
  actComponentReportText, anotherEntryInFront, failureRefusal, ignoredFieldReason, inseparableReason, missingTargetReason,
  notInRowReason, notWritableReason, rowNotDrawnReason, rowsReason, sharedActionReason, spreadReason, stepRefusal,
  tooManyStepsRefusal, unclaimedRefusal, unverifiedRefusal, waitTimeoutReason, type SharedKey,
} from '../src/act-component-text.ts'

/** The entry id every report here names. */
const ENTRY = { id: 'demo', title: 'Demo' }

/**
 * The controls one refused step's key names.
 * @param key - the key the step named.
 * @param count - how many drawn controls carry it.
 * @param more - which of them, how the key names them, and where the step looked.
 * @returns the shared key a sentence is written for.
 */
function shared(key: string, count: number, more: Partial<SharedKey> = {}): SharedKey {
  return { key, by: 'action', count, node: undefined, row: undefined, ...more }
}

describe('the offer and its refusals', () => {
  it('states the addressing vocabulary and the confine in the description', () => {
    expect(ACT_COMPONENT_DESCRIPTION).toContain('Act inside the component entry the user is looking at')
    expect(ACT_COMPONENT_DESCRIPTION).toContain('it must be the entry currently in front')
    expect(ACT_COMPONENT_DESCRIPTION).toContain(
      '- `click` presses one control: name it by the action key a block declares for it (a toolbar button\'s `add`),\n'
      + '  or, where several drawn controls share one action — one button per listed item — by that control\'s own key;\n'
      + '  where a table draws the control once per row, add `row` to press the one in that row.',
    )
    // The description and the parameter name this tool and its own fields alone.
    expect(ACT_COMPONENT_DESCRIPTION).not.toContain('read_component')
    expect(ROW_DESCRIPTION).toBe(
      'For a click only: the row the control is drawn in, by the key the row carries. Omit for a control outside every row.',
    )
    expect(ACT_COMPONENT_DESCRIPTION).toContain('`set` writes a value')
    expect(ACT_COMPONENT_DESCRIPTION).toContain('`wait` waits until a block')
    expect(ACT_COMPONENT_DESCRIPTION).toContain('The answer says which steps ran')
    expect(KEY_DESCRIPTION).toBe(
      'The control this step presses or waits for: its action key, or its own key where several drawn controls share one action.',
    )
    expect(NO_STEPS_REFUSAL).toBe('act_component needs at least one step.')
    expect(STEP_REFUSAL_TEXT).toContain('a step must name `click`, `set`, or `wait`')
  })

  it('names the ceiling, the step, and the deadline in the sentence it belongs to', () => {
    expect(tooManyStepsRefusal(8)).toBe('act_component runs at most 8 steps in one call.')
    expect(stepRefusal(3, 'a step must name `click`')).toBe('step 3: a step must name `click`')
    expect(unclaimedRefusal(5000)).toBe('No console showing this session claimed the call within 5000ms, so no step ran.')
    expect(unverifiedRefusal(15000)).toBe(
      'A console claimed the call and reported nothing within 15000ms; '
      + 'the steps may have run in full, in part, or not at all.',
    )
    expect(failureRefusal('no entry')).toBe('act_component did not run: no entry')
    expect(anotherEntryInFront('other')).toBe('The entry in front is "other", not the one this call named.')
    expect(NO_ENTRY_IN_FRONT).toBe('No component entry is in front, so there is nothing to act on.')
  })

  it('names the field a step carries that its action does not take', () => {
    expect(stepRefusal(2, ignoredFieldReason({ action: 'click', field: 'name' })))
      .toBe('step 2: a click presses one control named by its key, so it takes no "name".')
    expect(ignoredFieldReason({ action: 'set', field: 'key' }))
      .toBe('a set writes the one field its name addresses, so it takes no "key".')
    expect(ignoredFieldReason({ action: 'wait', field: 'value' }))
      .toBe('a wait waits for a block or a control, so it takes no "value".')
    expect(ignoredFieldReason({ action: 'set', field: 'row' }))
      .toBe('a set writes the one field its name addresses, so it takes no "row".')
    expect(ignoredFieldReason({ action: 'wait', field: 'row' }))
      .toBe('a wait waits for a block or a control, so it takes no "row".')
  })

  it('says how many drawn controls a key names, and which own keys tell them apart', () => {
    expect(sharedActionReason(shared('locate', 2, { node: 'map' }), ['beijing', 'tianjin']))
      .toBe('action "locate" names 2 drawn controls in block "map"; name the one to press by its own key: beijing, tianjin.')
    expect(inseparableReason(shared('cell-click', 12)))
      .toBe('action "cell-click" names 12 drawn controls in the entry, and no step can name each of them by an own key.')
    expect(inseparableReason(shared('modify', 5, { by: 'own-key' })))
      .toBe('own key "modify" is carried by 5 drawn controls in the entry, so no step can tell them apart.')
    // Where the step named a row, every sentence is about that row's controls.
    expect(sharedActionReason(shared('card-open', 2, { node: 'page', row: '1044' }), ['zh_label', 'region']))
      .toBe('action "card-open" names 2 drawn controls of row "1044" in block "page"; name the one to press by its own key: zh_label, region.')
    expect(inseparableReason(shared('modify', 2, { by: 'own-key', row: '1044' })))
      .toBe('own key "modify" is carried by 2 drawn controls of row "1044" in the entry, so no step can tell them apart.')
  })

  it('says a named row is not drawn, or draws no control the key names', () => {
    expect(rowNotDrawnReason('1044', 'layer-table')).toBe('row "1044" is not drawn in block "layer-table".')
    expect(rowNotDrawnReason('1044', undefined)).toBe('row "1044" is not drawn in the entry.')
    expect(notInRowReason('modify', '1044', 'layer-table')).toBe('row "1044" draws no control "modify" in block "layer-table".')
  })

  it('names the rows a key\'s controls are drawn in, and what a row drawing several still needs', () => {
    const keys = ['1134933624650219530', '1134933624650219531', '1134933624650219532']
    expect(rowsReason(shared('modify', 3, { by: 'own-key', node: 'page' }), { keys, crowded: 'none', rowless: 0 })).toBe(
      'own key "modify" is carried by 3 drawn controls in block "page", one per row; name the row with `row`: '
      + '1134933624650219530, 1134933624650219531, 1134933624650219532.',
    )
    expect(rowsReason(shared('card-open', 3), { keys: ['1', '2'], crowded: 'told-apart', rowless: 0 })).toBe(
      'action "card-open" names 3 drawn controls in the entry across 2 rows; name the row with `row`: 1, 2; '
      + 'a row draws more than one of them, so name the one to press by its own key with `row`.',
    )
    expect(rowsReason(shared('card-open', 3), { keys: ['1'], crowded: 'not-told-apart', rowless: 1 })).toBe(
      'action "card-open" names 3 drawn controls in the entry across 1 row; name the row with `row`: 1; '
      + 'a row draws more than one of them, and no step can tell those apart; 1 of them is drawn in no row a step can name.',
    )
    // Fifty rows: ten keys, the rest counted, inside the bound a host reads.
    const fifty = Array.from({ length: 50 }, (_, at) => `${String(1000 + at)}${'0'.repeat(60)}`)
    const sentence = rowsReason(shared('select', 50, { node: 'page' }), { keys: fifty, crowded: 'none', rowless: 0 })
    expect(sentence.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(sentence).toContain(fifty[0])
    expect(sentence).not.toContain(fifty[9])
    expect(sentence).toMatch(/ and \d+ more\.$/)
  })

  it('names the blocks a key\'s controls are drawn in, and counts the ones past the list or the report bound', () => {
    expect(spreadReason(shared('press', 4), { blocks: ['bar1', 'bar2'], outside: 0, unnamed: 0, unnamedBlocks: 0 }))
      .toBe('action "press" names 4 drawn controls in 2 blocks of the entry: bar1, bar2; name one of them as `node` to look in that block alone.')
    // Looked for inside a block that holds others, the blocks are the ones inside it.
    expect(spreadReason(shared('press', 4, { node: 'outer' }), { blocks: ['bar1', 'bar2'], outside: 0, unnamed: 0, unnamedBlocks: 0 }))
      .toBe('action "press" names 4 drawn controls in 2 blocks inside block "outer": bar1, bar2; name one of them as `node` to look in that block alone.')
    // Controls no `node` names are counted beside the blocks one does.
    expect(spreadReason(shared('approve', 3, { by: 'own-key' }), { blocks: ['bar1', 'bar2'], outside: 1, unnamed: 0, unnamedBlocks: 0 }))
      .toBe('own key "approve" is carried by 3 drawn controls in the entry, 1 of them outside every block; '
        + 'the rest are in 2 blocks: bar1, bar2; name one of them as `node` to look in that block alone.')
    expect(spreadReason(shared('approve', 3, { by: 'own-key' }), { blocks: ['bar1'], outside: 1, unnamed: 1, unnamedBlocks: 1 }))
      .toBe('own key "approve" is carried by 3 drawn controls in the entry, 1 of them outside every block and 1 of them in a '
        + 'block whose id no step can name; the rest are in block bar1; name it as `node` to look in that block alone.')
    expect(spreadReason(shared('press', 6), { blocks: ['bar1'], outside: 0, unnamed: 4, unnamedBlocks: 2 }))
      .toBe('action "press" names 6 drawn controls in the entry, 4 of them in blocks whose id no step can name; '
        + 'the rest are in block bar1; name it as `node` to look in that block alone.')
    const twelve = Array.from({ length: 12 }, (_, at) => `bar${String(at + 1)}`)
    expect(spreadReason(shared('approve', 12, { by: 'own-key' }), { blocks: twelve, outside: 0, unnamed: 0, unnamedBlocks: 0 })).toBe(
      'own key "approve" is carried by 12 drawn controls in 12 blocks of the entry: '
      + 'bar1, bar2, bar3, bar4, bar5, bar6, bar7, bar8, bar9, bar10 and 2 more; name one of them as `node` to look in that block alone.',
    )
    // Block ids as long as a block id may be: ten of them would carry the
    // sentence past what a host reads one step's sentence as.
    const long = Array.from({ length: 10 }, (_, at) => `${String(at)}${'b'.repeat(MAX_NODE_ID_LENGTH - 1)}`)
    const sentence = spreadReason(shared('k'.repeat(64), 10, { by: 'own-key' }), { blocks: long, outside: 0, unnamed: 0, unnamedBlocks: 0 })
    expect(sentence.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(sentence).toContain(long[0])
    expect(sentence).not.toContain(long[9])
    expect(sentence).toMatch(/ and \d+ more; name one of them as `node` to look in that block alone\.$/)
  })

  it('says only that a target is not part of the entry, whichever side of the confine it is on', () => {
    expect(missingTargetReason('control "add"')).toBe('control "add" is not part of the entry on display.')
    expect(notWritableReason('title')).toBe('The field for "title" is not one this call may write.')
  })

  it('gives a wait that ran out its own sentence, naming the target and the time waited', () => {
    // A target the entry declares and simply did not draw in time is not a
    // target the entry does not hold: the sentence says which it was plain.
    expect(waitTimeoutReason('"ghost"', 50)).toBe('"ghost" did not appear within 50ms.')
    expect(waitTimeoutReason('"add"', 2000)).toBe('"add" did not appear within 2000ms.')
  })
})

describe('the report text', () => {
  it('names each step the way a reader knows it, with the ending it had', () => {
    const steps: ActComponentStep[] = [
      { action: 'click', node: 'toolbar', key: 'add' },
      { action: 'click', key: 'submit' },
      { action: 'click', node: 'page', key: 'modify', row: '1044' },
      { action: 'set', node: 'grid', name: 'title', value: 'X' },
      { action: 'set', name: 'zh_label', value: 'Y' },
      { action: 'wait', node: 'grid' },
      { action: 'wait', key: 'add' },
    ]
    expect(actComponentReportText(ENTRY, steps, [
      { index: 1, status: 'ok' },
      { index: 2, status: 'ok' },
      { index: 3, status: 'ok' },
      { index: 4, status: 'ok' },
      { index: 5, status: 'ok' },
      { index: 6, status: 'ok' },
      { index: 7, status: 'ok' },
    ])).toBe([
      'Acted on the component entry "Demo" (demo).',
      '- click in toolbar on "add": done',
      '- click on "submit": done',
      '- click in page on "modify" of row "1044": done',
      '- set "title" in grid: done',
      '- set "zh_label": done',
      '- wait for grid: done',
      '- wait for add: done',
    ].join('\n'))
  })

  it('reads a failure\'s own sentence, falls back when it has none, and marks the rest not run', () => {
    const steps: ActComponentStep[] = [{ action: 'click', key: 'add' }, { action: 'click', key: 'add' }]
    expect(actComponentReportText(ENTRY, steps, [
      { index: 1, status: 'failed', message: 'control "add" is not part of the entry on display.' },
      { index: 2, status: 'skipped' },
    ])).toBe([
      'Acted on the component entry "Demo" (demo).',
      '- click on "add": control "add" is not part of the entry on display.',
      '- click on "add": not run',
    ].join('\n'))
  })

  it('names a step by its index when the report carries one the call did not', () => {
    expect(actComponentReportText(ENTRY, [{ action: 'click', key: 'add' }], [
      { index: 2, status: 'ok' },
      { index: 3, status: 'failed', message: 'no reason given' },
    ])).toBe([
      'Acted on the component entry "Demo" (demo).',
      '- step 2: done',
      '- step 3: no reason given',
    ].join('\n'))
  })
})
