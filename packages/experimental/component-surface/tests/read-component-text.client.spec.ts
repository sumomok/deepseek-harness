/**
 * The sentences `read_component` is described, refused, and reported with.
 *
 * The reading is composed here rather than in the console's own body, so what
 * this file pins is the tree's shape: the entry, one node per block, the keys a
 * step names, what a field holds, the dialog an entry has open listed in full,
 * the rows folded to a count, a counted set and the first names — and what a
 * reading does with an answer that does not fit: it gives up row detail first,
 * says so, and never gives up the dialog.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_READING_CHARS, MAX_READING_LINES, MAX_READING_TEXT_CHARS, MAX_ROW_NAMES,
  type ComponentReadBlock, type ComponentReading, type ComponentReadRow,
} from '../src/read-component-call.ts'
import {
  BAD_ENTRY_REFUSAL, BAD_NODE_REFUSAL, CANCELLED_REFUSAL, ENTRY_DESCRIPTION, MISREPORTED_REFUSAL,
  NODE_DESCRIPTION, NO_AGENT_REFUSAL, READ_COMPONENT_DESCRIPTION, failureRefusal,
  readComponentReportText, unclaimedRefusal, unverifiedRefusal,
} from '../src/read-component-text.ts'

/** One reading of an entry with nothing drawn in it, which the cases extend. */
const EMPTY: ComponentReading = {
  entry: { id: 'demo', title: 'Demo' },
  blockIds: [],
  blocks: [],
  outside: { controls: [], fields: [], dialogs: [] },
}

/** One block with nothing of its own, which the cases extend. */
function block(node: string, rest: Partial<ComponentReadBlock> = {}): ComponentReadBlock {
  return { node, controls: [], fields: [], dialogs: [], ...rest }
}

/** One drawn row, counted the way the executor counts one. */
function row(name: string, draws: ComponentReadRow['draws']): ComponentReadRow {
  return { name, draws }
}

/** The one dialog every crowded case keeps open. */
const DIALOG = {
  name: '新增',
  node: 'grid',
  controls: [{ action: 'added' as const, kind: 'button', words: '保存', state: 'reachable' as const }],
  fields: [{ name: 'zh_label', kind: 'textbox', value: '', state: 'reachable' as const }],
}

/**
 * One control line, so a case can make a reading exactly as long as it needs.
 * @param at - which control it is.
 * @returns the control.
 */
function control(at: number): ComponentReadBlock['controls'][number] {
  return { action: `key-${String(at)}`, kind: 'button', words: 'x', state: 'reachable' }
}

/**
 * A reading whose block draws `count` controls beside one folded table of
 * twenty named rows, with the dialog open inside the block.
 * @param count - how many controls the block draws.
 * @returns the reading.
 */
function crowded(count: number): ComponentReading {
  const named = Array.from({ length: MAX_ROW_NAMES }, (_unused, at) => row(`row-${String(at)}`, [{ action: 'cell-click', kind: 'td', count: 12 }]))
  return {
    ...EMPTY,
    blockIds: ['grid'],
    blocks: [block('grid', {
      controls: Array.from({ length: count }, (_unused, at) => control(at)),
      rows: { drawn: 400, named },
      dialogs: [DIALOG],
    })],
  }
}

/**
 * How many controls {@link crowded} may draw before the reading stops fitting.
 * @param count - how many controls the block draws.
 * @returns the composed text.
 */
function crowdedText(count: number): string {
  return readComponentReportText(crowded(count))
}

describe('the offer and its refusals', () => {
  it('states what the reading answers and how a call addresses the entry', () => {
    expect(READ_COMPONENT_DESCRIPTION).toContain('Read what the component entry the user is looking at')
    expect(READ_COMPONENT_DESCRIPTION).toContain('it must be the entry currently in front')
    expect(READ_COMPONENT_DESCRIPTION).toContain('`node` narrows the reading to one block')
    expect(READ_COMPONENT_DESCRIPTION).toContain('The answer is a tree')
    expect(READ_COMPONENT_DESCRIPTION).toContain('gives up row detail before anything else and says what it gave up')
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

describe('the tree a reading writes', () => {
  it('nests the blocks, the keys a step would name, the values its fields hold, and the dialog', () => {
    expect(readComponentReportText({
      ...EMPTY,
      blockIds: ['toolbar', 'grid'],
      blocks: [
        block('toolbar', {
          controls: [
            { action: 'add', kind: 'button', words: 'Add', state: 'reachable' },
            { action: 'press', ownKey: 'ok', kind: 'button', words: '保存', state: 'disabled' },
          ],
          fields: [
            { name: 'zh_label', kind: 'textbox', value: '层名', state: 'reachable' },
            { name: 'remember', kind: 'checkbox', checked: false, state: 'reachable' },
            { name: 'secret', kind: 'textbox', secret: true, state: 'reachable' },
          ],
        }),
        block('grid', {
          controls: [{ ownKey: 'row-1', kind: 'link', words: '删除', state: 'covered' }],
          dialogs: [{
            name: 'edit',
            node: 'grid',
            controls: [{ action: 'select', kind: 'checkbox', words: '', state: 'reachable' }],
            fields: [{ name: 'layer_id', kind: 'textbox', value: '', state: 'reachable' }],
          }],
        }),
      ],
      outside: {
        controls: [{ action: 'close', kind: 'button', words: '关闭', state: 'reachable' }],
        fields: [{ name: 'title', kind: 'textbox', value: 'x', state: 'reachable' }],
        dialogs: [],
      },
    })).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: toolbar, grid.',
      '  - "toolbar"',
      '    Controls:',
      '      - "add": button "Add"',
      '      - "press": button "保存", own key "ok" (disabled)',
      '    Fields:',
      '      - "zh_label": textbox = "层名"',
      '      - "remember": checkbox [ ]',
      '      - "secret": textbox = (hidden)',
      '  - "grid"',
      '    Controls:',
      '      - own key "row-1": link "删除" (covered where it is drawn)',
      '    Fields: none.',
      '    Dialog "edit" (in "grid"):',
      '      Controls:',
      '        - "select": checkbox',
      '      Fields:',
      '        - "layer_id": textbox = ""',
      'Outside every block:',
      '  Controls:',
      '    - "close": button "关闭"',
      '  Fields:',
      '    - "title": textbox = "x"',
    ].join('\n'))
    expect(readComponentReportText({ ...EMPTY, blocks: [block('toolbar', { fields: [{ name: 'remember', kind: 'checkbox', checked: true, state: 'reachable' }] })] }))
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

  it('prints the entry\'s own outside scope bare where the entry draws no block at all', () => {
    expect(readComponentReportText({
      ...EMPTY,
      outside: {
        controls: [{ action: 'console-add', kind: 'button', words: 'Add', state: 'reachable' }],
        fields: [], dialogs: [],
      },
    })).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: none.',
      'Controls:',
      '  - "console-add": button "Add"',
      'Fields: none.',
      'No dialog is open.',
    ].join('\n'))
  })

  it('says a block the entry does not draw is not part of it, in the vocabulary a step is refused with', () => {
    expect(readComponentReportText({ ...EMPTY, blockIds: ['toolbar'], missingNode: 'ghost' })).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: toolbar.',
      'block "ghost" is not part of the entry on display.',
      'No dialog is open.',
    ].join('\n'))
  })

  it('still names the dialog the entry has open where the block the call named is not drawn', () => {
    const text = readComponentReportText({
      ...EMPTY,
      blockIds: ['toolbar'],
      missingNode: 'ghost',
      outside: { controls: [], fields: [], dialogs: [{ name: '添加', controls: [], fields: [] }] },
    })
    expect(text).toContain('block "ghost" is not part of the entry on display.')
    expect(text).toContain('Dialog "添加":')
  })

  it('names a control whose two keys the reading carries neither of, which its own type leaves open', () => {
    // The console always reads a control out of a mark, so this arm of the
    // control type is one no reading of a real document produces: the line
    // still says which key a step would name rather than printing nothing.
    expect(readComponentReportText({ ...EMPTY, outside: { controls: [{ kind: 'div', words: '', state: 'reachable' }], fields: [], dialogs: [] } }))
      .toContain('- own key "": div')
  })

  it('names a dialog that draws none as unnamed, with the block it stands in', () => {
    expect(readComponentReportText({
      ...EMPTY,
      blockIds: ['grid'],
      blocks: [block('grid', { dialogs: [{ name: '', node: 'grid', controls: [], fields: [] }] })],
    })).toContain('    Dialog unnamed (in "grid"):')
  })

  it('collapses drawn text to one line and cuts it to the reading\'s own bound', () => {
    const long = 'a'.repeat(MAX_READING_TEXT_CHARS + 10)
    const text = readComponentReportText({
      ...EMPTY,
      outside: {
        controls: [], dialogs: [],
        fields: [{ name: 'note', kind: 'textbox', value: `first\n  second  ${long}`, state: 'reachable' }],
      },
    })
    expect(text).toContain('= "first second ')
    expect(text).not.toContain('\nfirst')
    expect(text).toContain(`${'a'.repeat(MAX_READING_TEXT_CHARS - 'first second '.length - 1)}…`)
  })
})

describe('the rows a reading folds', () => {
  it('counts what one row draws where every row draws it, and names each row', () => {
    const named = [row('一', [{ action: 'cell-click', kind: 'td', count: 11 }]), row('二', [{ action: 'cell-click', kind: 'td', count: 11 }])]
    expect(readComponentReportText({
      ...EMPTY,
      blockIds: ['grid'],
      blocks: [block('grid', { rows: { drawn: 2, named } })],
    })).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: grid.',
      '  - "grid"',
      '    Controls: none.',
      '    Fields: none.',
      '    Rows: 2 drawn.',
      '      Each row draws:',
      '        - "cell-click" ×11: td',
      '      Named rows:',
      '        - "一"',
      '        - "二"',
      'No dialog is open.',
    ].join('\n'))
  })

  it('reads the page\'s own words for the records its query matched, where it draws them', () => {
    const text = readComponentReportText({
      ...EMPTY,
      blockIds: ['grid'],
      blocks: [block('grid', { rows: { drawn: 20, total: '共 1048 条', named: [row('一', [{ action: 'cell-click', kind: 'td', count: 2 }])] } })],
    })
    expect(text).toContain('    Rows: 20 drawn (the page says "共 1048 条").')
  })

  it('writes one block per row where the rows do not all draw the same thing', () => {
    const text = readComponentReportText({
      ...EMPTY,
      blockIds: ['grid'],
      blocks: [block('grid', {
        rows: {
          drawn: 2,
          named: [
            row('一', [{ action: 'cell-click', kind: 'td', count: 1 }]),
            row('二', [{ action: 'cell-click', kind: 'td', count: 1 }, { action: 'select', kind: 'checkbox', count: 1 }]),
          ],
        },
      })],
    })
    expect(text).toContain([
      '      - "一":',
      '        - "cell-click" ×1: td',
      '      - "二":',
      '        - "cell-click" ×1: td',
      '        - "select" ×1: checkbox',
    ].join('\n'))
  })

  it('says how many more rows are drawn than named, and how a row that draws no words is called', () => {
    const text = readComponentReportText({
      ...EMPTY,
      blockIds: ['grid'],
      blocks: [block('grid', {
        rows: {
          drawn: 30,
          named: [row('', [{ action: 'cell-click', kind: 'td', count: 1 }]), row('二', [{ action: 'cell-click', kind: 'td', count: 1 }])],
        },
      })],
    })
    expect(text).toContain('        - (no words drawn)')
    expect(text).toContain('        (28 more drawn rows are not named.)')
  })

  it('says only the count where a reading names no row of its own', () => {
    const text = readComponentReportText({
      ...EMPTY,
      blockIds: ['grid'],
      blocks: [block('grid', { rows: { drawn: 4, named: [] } })],
    })
    expect(text).toContain('    Rows: 4 drawn.')
    expect(text).toContain('      Named rows:')
  })
})

describe('a reading larger than one answer may carry', () => {
  it('gives up the row names first, says so, and keeps the dialog in full', () => {
    // Twenty named rows is twenty-one lines, so a reading just past the line
    // ceiling fits again once the names go — and what the answer gives up is
    // said in its own words rather than left to be noticed.
    const text = crowdedText(172)
    expect(text).toContain('400 drawn rows are not named: the reading was cut to fit one answer.')
    expect(text).not.toContain('Named rows:')
    expect(text).not.toContain('- "row-0"')
    expect(text).toContain('        - "cell-click" ×12: td')
    expect(text.split('\n').length).toBeLessThanOrEqual(MAX_READING_LINES)
  })

  it('gives up what the rows draw as well, and says that too', () => {
    const text = crowdedText(187)
    expect(text).toContain('400 drawn rows are not described: the reading was cut to fit one answer.')
    expect(text).not.toContain('Each row draws:')
    expect(text).toContain('    Dialog "新增" (in "grid"):')
    expect(text).toContain('        - "zh_label": textbox = ""')
    expect(text.split('\n').length).toBeLessThanOrEqual(MAX_READING_LINES)
  })

  it('never gives up the dialog, the block, the controls or the fields, however crowded the page', () => {
    for (const count of [0, 40, 100, 172, 187]) {
      const text = crowdedText(count)
      expect(text).toContain('  - "grid"')
      expect(text).toContain('    Dialog "新增" (in "grid"):')
      expect(text).toContain('        - "added": button "保存"')
      expect(text).toContain('        - "zh_label": textbox = ""')
      if (count > 0) expect(text).toContain('      - "key-0": button "x"')
      expect(text.length).toBeLessThanOrEqual(MAX_READING_CHARS)
    }
  })

  it('cuts only a reading whose very blocks and dialogs are larger than one answer', () => {
    const controls = Array.from({ length: MAX_READING_LINES }, (_unused, at) => control(at))
    const text = readComponentReportText({ ...EMPTY, blockIds: ['grid'], blocks: [block('grid', { controls })] })
    const lines = text.split('\n')
    expect(lines).toHaveLength(MAX_READING_LINES)
    expect(lines.at(-1)).toMatch(/^\(Truncated: \d+ more lines were not shown\.\)$/)
    expect(lines[2]).toBe('  - "grid"')
  })

  it('says one line was left when one line was', () => {
    const controls = Array.from({ length: MAX_READING_LINES }, (_unused, at) => control(at)).slice(0, MAX_READING_LINES - 6)
    const text = readComponentReportText({ ...EMPTY, blockIds: ['grid'], blocks: [block('grid', { controls })] })
    expect(text).toContain('(Truncated: one more line was not shown.)')
  })

  it('adds no note to a reading that fits inside both ceilings', () => {
    const controls = Array.from({ length: MAX_READING_LINES - 10 }, (_unused, at) => control(at))
    const text = readComponentReportText({ ...EMPTY, blockIds: ['grid'], blocks: [block('grid', { controls })] })
    expect(text).not.toContain('Truncated')
    expect(text).not.toContain('was cut to fit one answer')
  })

  it('cuts a reading that runs past its character ceiling when its lines are long', () => {
    const controls = Array.from({ length: 120 }, (_unused, at) => ({
      action: `key-${String(at)}`, kind: 'button', words: 'x'.repeat(400), state: 'reachable' as const,
    }))
    const text = readComponentReportText({ ...EMPTY, blockIds: ['grid'], blocks: [block('grid', { controls })] })
    expect(text.length).toBeLessThanOrEqual(MAX_READING_CHARS)
    expect(text).toContain('more lines were not shown.)')
    expect(text.split('\n').length).toBeLessThan(MAX_READING_LINES)
  })
})
