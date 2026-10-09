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
import type { ActComponentStep } from '../src/act-component-call.ts'
import {
  ACT_COMPONENT_DESCRIPTION, NO_ENTRY_IN_FRONT, NO_STEPS_REFUSAL, STEP_REFUSAL_TEXT,
  actComponentReportText, anotherEntryInFront, failureRefusal, missingTargetReason, notWritableReason,
  stepRefusal, tooManyStepsRefusal, unclaimedRefusal, unverifiedRefusal, waitTimeoutReason,
} from '../src/act-component-text.ts'

/** The entry id every report here names. */
const ENTRY = { id: 'demo', title: 'Demo' }

describe('the offer and its refusals', () => {
  it('states the addressing vocabulary and the confine in the description', () => {
    expect(ACT_COMPONENT_DESCRIPTION).toContain('Act inside the component entry the user is looking at')
    expect(ACT_COMPONENT_DESCRIPTION).toContain('it must be the entry currently in front')
    expect(ACT_COMPONENT_DESCRIPTION).toContain('`click` presses the control')
    expect(ACT_COMPONENT_DESCRIPTION).toContain('`set` writes a value')
    expect(ACT_COMPONENT_DESCRIPTION).toContain('`wait` waits until a block')
    expect(ACT_COMPONENT_DESCRIPTION).toContain('The answer says which steps ran')
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
    ])).toBe([
      'Acted on the component entry "Demo" (demo).',
      '- click in toolbar on "add": done',
      '- click on "submit": done',
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

  it('reads a wait that names no block, which the type leaves open', () => {
    // Both fields are optional on the wait arm; the parser refuses such a step,
    // and the report text still has to name it rather than print `undefined`.
    const wait: ActComponentStep = { action: 'wait' }
    expect(actComponentReportText(ENTRY, [wait], [{ index: 1, status: 'ok' }]))
      .toBe('Acted on the component entry "Demo" (demo).\n- wait for : done')
  })
})
