/**
 * The sentences `read_component` is described, refused, and reported with.
 *
 * The reading is composed here rather than in the console's own body, so what
 * this file pins is the line shape: the key a step names, what a control is,
 * where it is drawn, what a field holds, which dialog is open, and what a
 * reading cut to its own bounds says about itself.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_READING_CHARS, MAX_READING_LINES, MAX_READING_TEXT_CHARS, type ComponentReading,
} from '../src/read-component-call.ts'
import {
  BAD_ENTRY_REFUSAL, BAD_NODE_REFUSAL, CANCELLED_REFUSAL, ENTRY_DESCRIPTION, MISREPORTED_REFUSAL,
  NODE_DESCRIPTION, NO_AGENT_REFUSAL, READ_COMPONENT_DESCRIPTION, failureRefusal,
  readComponentReportText, unclaimedRefusal, unverifiedRefusal,
} from '../src/read-component-text.ts'

/** One reading of an entry with nothing drawn in it, which the cases extend. */
const EMPTY: ComponentReading = {
  entry: { id: 'demo', title: 'Demo' },
  blocks: [],
  controls: [],
  fields: [],
  dialogs: [],
}

describe('the offer and its refusals', () => {
  it('states what the reading answers and how a call addresses the entry', () => {
    expect(READ_COMPONENT_DESCRIPTION).toContain('Read what the component entry the user is looking at')
    expect(READ_COMPONENT_DESCRIPTION).toContain('it must be the entry currently in front')
    expect(READ_COMPONENT_DESCRIPTION).toContain('`node` narrows the reading to one block')
    expect(READ_COMPONENT_DESCRIPTION).toContain('the controls it draws with the key each one answers to')
    expect(READ_COMPONENT_DESCRIPTION).toContain('A reading longer than one answer may carry is cut short and says so.')
    expect(ENTRY_DESCRIPTION).toContain('must be the entry in front')
    expect(NODE_DESCRIPTION).toContain('Omit to read the whole entry')
  })

  it('states why each refusal happened, naming no other tool', () => {
    expect(NO_AGENT_REFUSAL).toBe('read_component needs a session: the entry it reads belongs to a session\'s content column.')
    expect(BAD_ENTRY_REFUSAL).toBe('entry must be the id of a component entry in the content panel.')
    expect(BAD_NODE_REFUSAL).toContain('node must be a block id')
    expect(CANCELLED_REFUSAL).toBe('The read_component call was cancelled.')
    expect(MISREPORTED_REFUSAL).toBe('The console answered a read_component call with something other than a reading.')
    expect(unclaimedRefusal(5000)).toBe('No console showing this session claimed the call within 5000ms, so nothing was read.')
    expect(unverifiedRefusal(15000))
      .toBe('A console claimed the call and reported nothing within 15000ms; the reading never arrived.')
    expect(failureRefusal('no entry')).toBe('read_component did not read: no entry')
  })
})

describe('the reading text', () => {
  it('names the entry, its blocks, the keys a step would name, and the values its fields hold', () => {
    expect(readComponentReportText({
      ...EMPTY,
      blocks: ['toolbar', 'grid'],
      controls: [
        { action: 'add', kind: 'button', words: 'Add', state: 'reachable', node: 'toolbar' },
        { action: 'press', ownKey: 'ok', kind: 'button', words: '保存', state: 'disabled', node: 'toolbar' },
        { ownKey: 'row-1', kind: 'link', words: '删除', state: 'covered', node: 'grid' },
        { action: 'select', kind: 'checkbox', words: '', state: 'reachable', dialog: 'edit' },
      ],
      fields: [
        { name: 'zh_label', kind: 'textbox', value: '层名', state: 'reachable', node: 'toolbar' },
        { name: 'layer_id', kind: 'textbox', value: '', state: 'reachable', dialog: 'edit' },
        { name: 'remember', kind: 'checkbox', checked: false, state: 'reachable' },
        { name: 'secret', kind: 'textbox', secret: true, state: 'reachable' },
      ],
      dialogs: ['edit'],
    })).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: toolbar, grid.',
      'Controls:',
      '- "add" (in toolbar): button "Add"',
      '- "press" (in toolbar): button "保存", own key "ok" (disabled)',
      '- own key "row-1" (in grid): link "删除" (covered where it is drawn)',
      '- "select" (in the dialog "edit"): checkbox',
      'Fields:',
      '- "zh_label" (in toolbar): textbox = "层名"',
      '- "layer_id" (in the dialog "edit"): textbox = ""',
      '- "remember": checkbox [ ]',
      '- "secret": textbox = (hidden)',
      'Open dialog: "edit".',
    ].join('\n'))
    expect(readComponentReportText({ ...EMPTY, fields: [{ name: 'remember', kind: 'checkbox', checked: true, state: 'reachable' }] }))
      .toContain('- "remember": checkbox [x]')
  })

  it('says what an entry with nothing drawn in it has, rather than leaving the lines out', () => {
    expect(readComponentReportText(EMPTY)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: none.',
      'Controls: none.',
      'Fields: none.',
      'No dialog is open.',
    ].join('\n'))
  })

  it('says a block the entry does not draw is not part of it, in the vocabulary a step is refused with', () => {
    expect(readComponentReportText({ ...EMPTY, blocks: ['toolbar'], missingNode: 'ghost' })).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: toolbar.',
      'block "ghost" is not part of the entry on display.',
      'Controls: none.',
      'Fields: none.',
      'No dialog is open.',
    ].join('\n'))
  })

  it('names the dialogs an entry has open, and says when one draws no name of its own', () => {
    expect(readComponentReportText({ ...EMPTY, dialogs: [''] })).toContain('Open dialog: unnamed.')
    expect(readComponentReportText({ ...EMPTY, dialogs: ['add', ''] })).toContain('Open dialogs: "add", unnamed.')
  })

  it('names a control whose two keys the reading carries neither of, which its own type leaves open', () => {
    // The console always reads a control out of a mark, so this arm of the
    // control type is one no reading of a real document produces: the line
    // still says which key a step would name rather than printing nothing.
    expect(readComponentReportText({ ...EMPTY, controls: [{ kind: 'div', words: '', state: 'reachable' }] }))
      .toContain('- own key "": div')
  })

  it('collapses drawn text to one line and cuts it to the reading\'s own bound', () => {
    const long = 'a'.repeat(MAX_READING_TEXT_CHARS + 10)
    const text = readComponentReportText({
      ...EMPTY,
      fields: [{ name: 'note', kind: 'textbox', value: `first\n  second  ${long}`, state: 'reachable' }],
    })
    expect(text).toContain('= "first second ')
    expect(text).not.toContain('\nfirst')
    expect(text).toContain(`${'a'.repeat(MAX_READING_TEXT_CHARS - 'first second '.length - 1)}…`)
  })

  it('cuts a reading that runs past its line ceiling before its character ceiling, and says how much was left', () => {
    // The reading is header, blocks, the section title, one line per control,
    // the empty fields line and the dialog line: 205 lines, of which the last
    // line is given up to the note and the five behind it are left out.
    const controls = Array.from({ length: MAX_READING_LINES }, (_unused, at) => ({
      action: `key-${at}`, kind: 'button', words: 'x', state: 'reachable' as const,
    }))
    const lines = readComponentReportText({ ...EMPTY, controls }).split('\n')
    expect(lines).toHaveLength(MAX_READING_LINES)
    expect(lines.at(-1)).toBe('(Truncated: 6 more lines were not shown.)')
    expect(lines[2]).toBe('Controls:')
    expect(lines.at(-2)).toBe(`- "key-${MAX_READING_LINES - 5}": button "x"`)
  })

  it('says one line was left when one line was', () => {
    // Five control lines fewer puts the reading exactly one line over the
    // ceiling: 200 composed, 199 kept in front of the note.
    const controls = Array.from({ length: MAX_READING_LINES - 5 }, (_unused, at) => ({
      action: `key-${at}`, kind: 'button', words: 'x', state: 'reachable' as const,
    }))
    const text = readComponentReportText({ ...EMPTY, controls })
    expect(text).toContain('(Truncated: one more line was not shown.)')
  })

  it('adds no note to a reading that fits inside both ceilings', () => {
    const controls = Array.from({ length: MAX_READING_LINES - 6 }, (_unused, at) => ({
      action: `key-${at}`, kind: 'button', words: 'x', state: 'reachable' as const,
    }))
    const text = readComponentReportText({ ...EMPTY, controls })
    expect(text).not.toContain('Truncated')
    expect(text.split('\n')).toHaveLength(MAX_READING_LINES - 1)
  })

  it('cuts a reading that runs past its character ceiling when its lines are long', () => {
    const controls = Array.from({ length: 120 }, (_unused, at) => ({
      action: `key-${at}`, kind: 'button', words: 'x'.repeat(400), state: 'reachable' as const,
    }))
    const text = readComponentReportText({ ...EMPTY, controls })
    expect(text.length).toBeLessThanOrEqual(MAX_READING_CHARS)
    expect(text).toContain('more lines were not shown.)')
    expect(text.split('\n').length).toBeLessThan(MAX_READING_LINES)
  })
})
