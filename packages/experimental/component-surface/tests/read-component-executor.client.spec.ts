// @vitest-environment jsdom
/**
 * The component read executor in a real document: what it reports about the
 * entry in front, as the tree a model reads.
 *
 * The whole point of the tool is that the reading names the same things the
 * acting tool acts on, so the cases here are the ones a model meets: the blocks
 * a placement drew with the controls and fields each draws, a table's rows
 * folded to what one row holds and the first rows named, the dialog an entry
 * has open fully listed under the block it stands in, and the two states a
 * press would refuse over. jsdom is enough for all of it: nothing here needs
 * layout, and the states read the same document properties the step executor
 * reads.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_ROW_NAMES } from '../src/read-component-call.ts'
import { drawnEntry, type DrawnEntry } from '../src/client/entry-container.ts'
import { readComponent } from '../src/client/read-executor.ts'
import type { ReadComponentArgs } from '../src/read-component-call.ts'

/** The entry id every case here reads. */
const ENTRY = 'demo'

/** Draw one entry whose own container holds the markup a case needs. */
function drawEntry(inner: string): DrawnEntry {
  document.body.innerHTML = `
    <nav data-content-surface-switcher>
      <button data-content-surface-entry="page home">Home</button>
      <button data-content-surface-entry="component ${ENTRY}" data-content-surface-selected>Demo</button>
    </nav>
    <div data-content-surface-seat="page" data-content-surface-active></div>
    <div data-content-surface-seat="component" data-content-surface-active>
      <div data-component-surface>${inner}</div>
    </div>
    <aside data-sidebar><button data-component-action="console-add">Add from the console</button></aside>
  `
  const drawn = drawnEntry(document)
  if (drawn === undefined) throw new Error('the case drew no entry')
  return drawn
}

/**
 * Read one call the way the seat does.
 * @param entry - the entry the case drew.
 * @param node - the block the call narrows the reading to, absent for the whole entry.
 * @returns the reading text.
 */
function read(entry: DrawnEntry, node?: string): string {
  const args: ReadComponentArgs = { entry: ENTRY, ...node === undefined ? {} : { node } }
  return readComponent(args, entry)
}

beforeEach(() => { document.body.innerHTML = '' })

describe('the tree a reading describes', () => {
  it('nests each block with its controls and fields, and the dialog the entry has open', () => {
    const drawn = drawEntry(`
      <div data-component-node="toolbar">
        <button data-component-action="add">Add</button>
        <input data-component-field="zh_label" value="层名">
      </div>
      <div data-component-node="grid"></div>
      <div class="el-dialog__wrapper"><div role="dialog" aria-modal="true" aria-label="编辑图层">
        <input data-component-field="layer_id" value="L-1">
        <button data-component-action="press" data-component-key="ok">确定</button>
        <button data-component-action="press" data-component-key="cancel">取消</button>
      </div></div>
    `)
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: toolbar, grid.',
      '  - "toolbar"',
      '    Controls:',
      '      - "add": button "Add"',
      '    Fields:',
      '      - "zh_label": textbox = "层名"',
      '  - "grid"',
      '    Controls: none.',
      '    Fields: none.',
      'Outside every block:',
      '  Controls: none.',
      '  Fields: none.',
      '  Dialog "编辑图层":',
      '    Controls:',
      '      - "press": button "确定", own key "ok"',
      '      - "press": button "取消", own key "cancel"',
      '    Fields:',
      '      - "layer_id": textbox = "L-1"',
    ].join('\n'))
  })

  it('nests a dialog under the block it stands in and names that node on its line', () => {
    const drawn = drawEntry(`
      <div data-component-node="grid">
        <button data-component-action="open">Open</button>
        <div role="dialog" aria-label="添加"><input data-component-field="zh_label" value=""></div>
      </div>
    `)
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: grid.',
      '  - "grid"',
      '    Controls:',
      '      - "open": button "Open"',
      '    Fields: none.',
      '    Dialog "添加" (in "grid"):',
      '      Controls: none.',
      '      Fields:',
      '        - "zh_label": textbox = ""',
    ].join('\n'))
  })

  it('names a dialog by the heading it draws where it carries no label', () => {
    const drawn = drawEntry('<div role="dialog"><h3>编辑图层</h3><input data-component-field="layer_id" value="L-1"></div>')
    expect(read(drawn)).toContain('Dialog "编辑图层":')
    expect(read(drawn)).toContain('    - "layer_id": textbox = "L-1"')
  })

  it('names a dialog by the element its label points at, and reports the two drawings as one dialog', () => {
    // A component library wraps a dialog in an overlay of its own; both carry
    // the role, and the reading reports the one the person sees.
    const drawn = drawEntry(`
      <div class="el-dialog__wrapper" aria-modal="true">
        <span id="title" hidden>编辑图层</span>
        <div role="dialog" aria-labelledby="title"><button data-component-action="press">确定</button></div>
      </div>
    `)
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: none.',
      'Controls: none.',
      'Fields: none.',
      'Dialog "编辑图层":',
      '  Controls:',
      '    - "press": button "确定"',
      '  Fields: none.',
    ].join('\n'))
  })

  it('says a dialog draws no name rather than reading one out of its body', () => {
    const drawn = drawEntry('<div role="dialog"><input data-component-field="layer_id" value=""></div>')
    expect(read(drawn)).toContain('Dialog unnamed:')
  })

  it('says nothing about the console\'s own chrome, which is no part of the entry', () => {
    const drawn = drawEntry('<div data-component-node="toolbar"><button data-component-action="add">Add</button></div>')
    const text = read(drawn)
    expect(text).not.toContain('console-add')
    expect(text).not.toContain('Home')
  })

  it('lists the blocks the entry draws, leaving one the document holds back out', () => {
    const drawn = drawEntry(`
      <div data-component-node="toolbar"><button data-component-action="add">Add</button></div>
      <div style="display: none" data-component-node="closed"><button data-component-action="save">Save</button></div>
      <div hidden data-component-node="hidden-attr"></div>
    `)
    expect(read(drawn)).toContain('Blocks: toolbar.')
    expect(read(drawn)).not.toContain('closed')
    expect(read(drawn)).not.toContain('hidden-attr')
  })

  it('says an entry with nothing drawn in it has nothing, rather than leaving the lines out', () => {
    const drawn = drawEntry('')
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: none.',
      'Controls: none.',
      'Fields: none.',
      'No dialog is open.',
    ].join('\n'))
  })
})

describe('the rows a scope draws, folded', () => {
  it('counts the rows, names them, and counts what one row draws instead of listing a cell per line', () => {
    const drawn = drawEntry(`
      <div data-component-node="grid"><table><tbody>
        <tr>
          <td data-component-action="cell-click">one</td>
          <td data-component-action="cell-click">two</td>
          <td data-component-action="operation" data-component-key="modify">修改</td>
        </tr>
        <tr>
          <td data-component-action="cell-click">three</td>
          <td data-component-action="cell-click">four</td>
          <td data-component-action="operation" data-component-key="modify">修改</td>
        </tr>
      </tbody></table></div>
    `)
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: grid.',
      '  - "grid"',
      '    Controls: none.',
      '    Fields: none.',
      '    Rows: 2 drawn.',
      '      Each row draws:',
      '        - "cell-click" ×2: td',
      '        - "operation" ×1: td, own key "modify"',
      '      Named rows:',
      '        - "one"',
      '        - "three"',
      'No dialog is open.',
    ].join('\n'))
  })

  it('merges the copies of one row a fixed layer draws, counting the record once', () => {
    // A table with fixed columns draws every row once in the scrolling body
    // and once per fixed layer; a reading counts records, not elements.
    const drawn = drawEntry(`
      <div data-component-node="grid">
        <div class="fixed"><table><tbody>
          <tr><td data-component-action="select"></td><td data-component-action="cell-click">预案一</td></tr>
          <tr><td data-component-action="select"></td><td data-component-action="cell-click">预案二</td></tr>
        </tbody></table></div>
        <div class="body"><table><tbody>
          <tr><td data-component-action="cell-click">甲</td><td data-component-action="cell-click">乙</td></tr>
          <tr><td data-component-action="cell-click">丙</td><td data-component-action="cell-click">丁</td></tr>
        </tbody></table></div>
      </div>
    `)
    const text = read(drawn)
    expect(text).toContain('Rows: 2 drawn.')
    expect(text).toContain('      Each row draws:')
    expect(text).toContain('        - "select" ×1: td')
    expect(text).toContain('        - "cell-click" ×3: td')
    // The row is named by the first drawn copy's own words.
    expect(text).toContain('        - "预案一"')
    expect(text).toContain('        - "预案二"')
  })

  it('names a row by the first copy that draws words, where the first copy draws none', () => {
    // The copies are compared in the order they stand in the document: a copy
    // that draws nothing but its controls names nothing, and the next copy's
    // own words are the record's name.
    const drawn = drawEntry(`
      <div data-component-node="grid">
        <div class="fixed"><table><tbody>
          <tr><td data-component-action="select"></td></tr>
        </tbody></table></div>
        <div class="body"><table><tbody>
          <tr><td data-component-action="cell-click">预案一</td></tr>
        </tbody></table></div>
      </div>
    `)
    expect(read(drawn)).toContain('        - "预案一"')
  })

  it('counts a row control that carries an own key and no action', () => {
    const drawn = drawEntry(`
      <div data-component-node="grid"><table><tbody>
        <tr><td data-component-key="pick">选</td></tr>
      </tbody></table></div>
    `)
    const text = read(drawn)
    expect(text).toContain('        - own key "pick" ×1: td')
    expect(text).toContain('        - "选"')
  })

  it('folds the rows a dialog draws itself, and keeps the dialog\'s own fields beside them', () => {
    const drawn = drawEntry(`
      <div role="dialog" aria-label="选择">
        <input data-component-field="zh_label" value="">
        <table><tbody>
          <tr><td data-component-action="cell-click">甲</td></tr>
          <tr><td data-component-action="cell-click">乙</td></tr>
        </tbody></table>
      </div>
    `)
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: none.',
      'Controls: none.',
      'Fields: none.',
      'Dialog "选择":',
      '  Controls: none.',
      '  Fields:',
      '    - "zh_label": textbox = ""',
      '  Rows: 2 drawn.',
      '    Each row draws:',
      '      - "cell-click" ×1: td',
      '    Named rows:',
      '      - "甲"',
      '      - "乙"',
    ].join('\n'))
  })

  it('names no more rows than the reading carries, and counts the rest', () => {
    const rows = Array.from({ length: MAX_ROW_NAMES + 3 }, (_unused, at) => `<tr><td data-component-action="cell-click">r${String(at)}</td></tr>`).join('')
    const drawn = drawEntry(`<div data-component-node="grid"><table><tbody>${rows}</tbody></table></div>`)
    const text = read(drawn)
    expect(text).toContain(`Rows: ${String(MAX_ROW_NAMES + 3)} drawn.`)
    expect(text).toContain(`        - "r${String(MAX_ROW_NAMES - 1)}"`)
    expect(text).not.toContain(`- "r${String(MAX_ROW_NAMES)}"`)
    expect(text).toContain('(3 more drawn rows are not named.)')
  })

  it('writes one block per row where the rows do not all draw the same thing', () => {
    const drawn = drawEntry(`
      <div data-component-node="grid"><table><tbody>
        <tr><td data-component-action="cell-click">one</td></tr>
        <tr><td data-component-action="cell-click">two</td><td data-component-action="select"></td></tr>
      </tbody></table></div>
    `)
    expect(read(drawn)).toContain([
      '      - "one":',
      '        - "cell-click" ×1: td',
      '      - "two":',
      '        - "cell-click" ×1: td',
      '        - "select" ×1: td',
    ].join('\n'))
  })

  it('says a row that draws no words is one rather than printing empty quotes', () => {
    const drawn = drawEntry('<div data-component-node="grid"><table><tbody><tr><td data-component-action="cell-click"></td></tr></tbody></table></div>')
    expect(read(drawn)).toContain('        - (no words drawn)')
  })

  it('reads the page\'s own words for how many records its query matched, where it draws them', () => {
    const drawn = drawEntry(`
      <div data-component-node="grid"><table><tbody>
        <tr><td data-component-action="cell-click">one</td></tr>
      </tbody></table>
      <div class="el-pagination__total">共 1048 条</div></div>
    `)
    expect(read(drawn)).toContain('Rows: 1 drawn (the page says "共 1048 条").')
  })

  it('leaves a field drawn inside a row on its own line, with the value it holds', () => {
    const drawn = drawEntry(`
      <div data-component-node="grid"><table><tbody>
        <tr><td data-component-action="cell-click">one</td><td><input data-component-field="zh_label" value="甲"></td></tr>
      </tbody></table></div>
    `)
    const text = read(drawn)
    expect(text).toContain('    Fields:')
    expect(text).toContain('      - "zh_label": textbox = "甲"')
    expect(text).toContain('Rows: 1 drawn.')
  })

  it('keeps a dialog complete however many rows the page draws around it', () => {
    const rows = Array.from({ length: 400 }, (_unused, at) => `<tr><td data-component-action="cell-click">r${String(at)}</td><td data-component-action="cell-click">c${String(at)}</td></tr>`).join('')
    const drawn = drawEntry(`
      <div data-component-node="grid"><table><tbody>${rows}</tbody></table>
        <div role="dialog" aria-label="新增"><input data-component-field="zh_label" value="">
          <button data-component-action="added">保存</button></div>
      </div>
    `)
    const text = read(drawn)
    expect(text).toContain('Rows: 400 drawn.')
    expect(text).toContain('    Dialog "新增" (in "grid"):')
    expect(text).toContain('        - "added": button "保存"')
    expect(text).toContain('        - "zh_label": textbox = ""')
    expect(text).not.toContain('Truncated')
    expect(text.split('\n').length).toBeLessThan(100)
  })
})

describe('where a step would reach each target', () => {
  it('reports a disabled control and an undrawn one as the platform says, and presses nothing', () => {
    const drawn = drawEntry(`
      <button data-component-action="save" disabled>Save</button>
      <div data-component-action="discard" aria-disabled="true">Discard</div>
      <fieldset disabled><button data-component-action="reset">Reset</button></fieldset>
      <div hidden><button data-component-action="hidden-key">Hidden</button></div>
      <div style="visibility: hidden"><button data-component-action="invisible">Invisible</button></div>
      <div style="display: none"><button data-component-action="gone">Gone</button></div>
    `)
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: none.',
      'Controls:',
      '  - "save": button "Save" (disabled)',
      '  - "discard": div "Discard" (disabled)',
      '  - "reset": button "Reset" (disabled)',
      'Fields: none.',
      'No dialog is open.',
    ].join('\n'))
  })

  it('reports a control the document\'s hit test finds covered, and one it reaches as reachable', () => {
    const drawn = drawEntry('<button data-component-action="go"><span id="label">Go</span></button><span id="over">cover</span>')
    const button = document.querySelector('[data-component-action="go"]') as HTMLElement
    const over = document.querySelector('#over') as HTMLElement
    button.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 40, height: 10, right: 50, bottom: 30, x: 10, y: 20, toJSON: () => ({}),
    })
    document.elementFromPoint = () => over
    try {
      expect(read(drawn)).toContain('  - "go": button "Go" (covered where it is drawn)')
      document.elementFromPoint = () => button
      expect(read(drawn)).toContain('  - "go": button "Go"\n')
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
  })

  it('reports a field\'s own state and what a tick box holds instead of a value', () => {
    const drawn = drawEntry(`
      <input data-component-field="locked" value="L-1" disabled>
      <input data-component-field="remember" type="checkbox" checked>
      <input data-component-field="secret" type="password" value="hunter2">
      <select data-component-field="kind"><option value="a">a</option><option value="b" selected>b</option></select>
    `)
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: none.',
      'Controls: none.',
      'Fields:',
      '  - "locked": textbox = "L-1" (disabled)',
      '  - "remember": checkbox [x]',
      '  - "secret": textbox = (hidden)',
      '  - "kind": combobox = "b"',
      'No dialog is open.',
    ].join('\n'))
  })
})

describe('the fields an entry names', () => {
  it('reads the ones a block declares, and the ones a control names itself by', () => {
    const drawn = drawEntry(`
      <input data-component-field="zh_label" value="层名">
      <input aria-label="layer_id" value="L-2">
      <input id="named"><label for="named">layer_alias</label>
      <input placeholder="unrelated">
    `)
    expect(read(drawn)).toContain('  - "layer_id": textbox = "L-2"')
    expect(read(drawn)).toContain('  - "layer_alias": textbox = ""')
    // A placeholder is a name a `set` step may write by, so the reading lists
    // it too rather than hiding a target that exists.
    expect(read(drawn)).toContain('  - "unrelated": textbox = ""')
  })

  it('leaves out a control the entry neither declares nor names', () => {
    const drawn = drawEntry('<input id="nowhere" value="x">')
    expect(read(drawn)).toContain('Fields: none.')
  })

  it('leaves out a field the document holds back, and reads both copies once the dialog opens', () => {
    const drawn = drawEntry(`
      <input data-component-field="zh_label" id="query" value="query">
      <div class="el-dialog__wrapper" style="display: none"><div role="dialog">
        <input data-component-field="zh_label" id="closed" value="closed">
      </div></div>
    `)
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: none.',
      'Controls: none.',
      'Fields:',
      '  - "zh_label": textbox = "query"',
      'No dialog is open.',
    ].join('\n'))
    // The dialog opens: both copies are drawn, and the reading says which one
    // is inside the dialog — the one a `set` step would write.
    document.querySelector('.el-dialog__wrapper')?.removeAttribute('style')
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: none.',
      'Controls: none.',
      'Fields:',
      '  - "zh_label": textbox = "query"',
      'Dialog unnamed:',
      '  Controls: none.',
      '  Fields:',
      '    - "zh_label": textbox = "closed"',
    ].join('\n'))
  })
})

describe('a reading narrowed to one block', () => {
  it('reads that block\'s contents and still lists every block the entry draws', () => {
    const drawn = drawEntry(`
      <div data-component-node="toolbar"><button data-component-action="add">Add</button></div>
      <div data-component-node="grid"><button data-component-action="cell-click">row</button></div>
    `)
    expect(read(drawn, 'grid')).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: toolbar, grid.',
      '  - "grid"',
      '    Controls:',
      '      - "cell-click": button "row"',
      '    Fields: none.',
      'No dialog is open.',
    ].join('\n'))
  })

  it('says a block the entry does not draw is not part of it, and lists what it does draw', () => {
    const drawn = drawEntry('<div data-component-node="toolbar"><button data-component-action="add">Add</button></div>')
    expect(read(drawn, 'ghost')).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: toolbar.',
      'block "ghost" is not part of the entry on display.',
      'No dialog is open.',
    ].join('\n'))
  })

  it('still reports the dialog the entry has open when the block it named is not drawn', () => {
    const drawn = drawEntry(`
      <div data-component-node="grid">
        <div role="dialog" aria-label="添加"><input data-component-field="zh_label" value=""></div>
      </div>
    `)
    const text = read(drawn, 'ghost')
    expect(text).toContain('block "ghost" is not part of the entry on display.')
    expect(text).toContain('Dialog "添加" (in "grid"):')
    expect(text).toContain('    - "zh_label": textbox = ""')
  })

  it('reads the dialogs drawn inside the block it was narrowed to', () => {
    const drawn = drawEntry(`
      <div data-component-node="toolbar"><div role="dialog" aria-label="添加"><input data-component-field="zh_label" value=""></div></div>
      <div data-component-node="grid"><div role="dialog" aria-label="查询"></div></div>
    `)
    expect(read(drawn, 'grid')).toContain('Dialog "查询" (in "grid"):')
    expect(read(drawn, 'toolbar')).toContain('Dialog "添加" (in "toolbar"):')
  })

  it('reads a block drawn inside another with its own contents, and the inner node under itself', () => {
    const drawn = drawEntry(`
      <div data-component-node="outer">
        <button data-component-action="add">Add</button>
        <div data-component-node="inner"><button data-component-action="save">Save</button></div>
      </div>
    `)
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: outer, inner.',
      '  - "outer"',
      '    Controls:',
      '      - "add": button "Add"',
      '    Fields: none.',
      '  - "inner"',
      '    Controls:',
      '      - "save": button "Save"',
      '    Fields: none.',
      'No dialog is open.',
    ].join('\n'))
    // A reading narrowed to the outer block does not report the inner one, and
    // keeps what the inner node draws under the block the call named.
    expect(read(drawn, 'outer')).toContain([
      '  - "outer"',
      '    Controls:',
      '      - "add": button "Add"',
      '      - "save": button "Save"',
    ].join('\n'))
  })
})

describe('the words a control is described by', () => {
  it('falls back to the name a control carries where it draws no words', () => {
    const drawn = drawEntry('<button data-component-action="select" aria-label="select row 4"><i class="box"></i></button>')
    expect(read(drawn)).toContain('  - "select": button "select row 4"')
  })

  it('reports a control that draws and carries nothing by its kind alone', () => {
    const drawn = drawEntry('<div data-component-key="only"></div>')
    expect(read(drawn)).toContain('  - own key "only": div')
  })
})

describe('what one control is, as the platform names it', () => {
  it('reads the role a control declares, and the kind it is when that role is empty', () => {
    const drawn = drawEntry(`
      <div data-component-action="pick" role="menuitem">Pick</div>
      <div data-component-action="plain" role="">Plain</div>
    `)
    expect(read(drawn)).toContain('  - "pick": menuitem "Pick"')
    expect(read(drawn)).toContain('  - "plain": div "Plain"')
  })

  it('reads the two input types the platform names apart, and a select and a textarea as their own words', () => {
    const drawn = drawEntry(`
      <input data-component-action="tick" type="radio" aria-label="one">
      <select data-component-field="kind"><option value="b" selected>b</option></select>
      <textarea data-component-field="note">hello</textarea>
    `)
    expect(read(drawn)).toContain('  - "tick": radio "one"')
    expect(read(drawn)).toContain('  - "kind": combobox = "b"')
    expect(read(drawn)).toContain('  - "note": textbox = "hello"')
  })

  it('reads a field a block declares on something that takes no value, which it reports by its kind alone', () => {
    const drawn = drawEntry('<div data-component-field="title">Title</div>')
    expect(read(drawn)).toContain('  - "title": div')
  })
})

describe('a control or a field the scope itself is', () => {
  it('reads the block it was narrowed to when that block is the control', () => {
    const drawn = drawEntry('<button data-component-node="save" data-component-action="press">Save</button>')
    expect(read(drawn, 'save')).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: save.',
      '  - "save"',
      '    Controls:',
      '      - "press": button "Save"',
      '    Fields: none.',
      'No dialog is open.',
    ].join('\n'))
  })

  it('reads the block it was narrowed to when that block is the field', () => {
    const drawn = drawEntry('<input data-component-node="zh_label" data-component-field="zh_label" value="层名">')
    expect(read(drawn, 'zh_label')).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: zh_label.',
      '  - "zh_label"',
      '    Controls: none.',
      '    Fields:',
      '      - "zh_label": textbox = "层名"',
      'No dialog is open.',
    ].join('\n'))
  })
})

describe('the name a dialog declares', () => {
  it('skips the elements a label does not point at, and falls to a heading where the label names nothing', () => {
    const drawn = drawEntry(`
      <div role="dialog" aria-labelledby="gone"><h4>编辑图层</h4><span id="other">其他</span></div>
    `)
    expect(read(drawn)).toContain('Dialog "编辑图层":')
  })

  it('reports a dialog whose nested roles all declare nothing as unnamed', () => {
    const drawn = drawEntry('<div aria-modal="true"><div role="dialog"><input data-component-field="zh_label" value=""></div></div>')
    expect(read(drawn)).toContain('Dialog unnamed:')
    expect(read(drawn)).toContain('    - "zh_label": textbox = ""')
  })

  it('reads a dialog drawn inside a dialog as one dialog, with the contents of both', () => {
    const drawn = drawEntry(`
      <div role="dialog" aria-label="外层">
        <button data-component-action="outer">Outer</button>
        <div aria-modal="true"><div role="dialog" aria-label="内层"><button data-component-action="inner">Inner</button></div></div>
      </div>
    `)
    expect(read(drawn)).toBe([
      'Read the component entry "Demo" (demo).',
      'Blocks: none.',
      'Controls: none.',
      'Fields: none.',
      'Dialog "外层":',
      '  Controls:',
      '    - "outer": button "Outer"',
      '    - "inner": button "Inner"',
      '  Fields: none.',
    ].join('\n'))
  })
})
