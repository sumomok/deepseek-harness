// @vitest-environment jsdom
/**
 * The component action executor in a real document: what a step reaches, and
 * what it refuses to reach.
 *
 * The whole point of the tool is the confine, so the cases here are the two
 * sides of it — a control the entry declares is pressed through the block's own
 * handler, and a control that lives anywhere else in the console (the switcher,
 * a sidebar field, another entry) is left alone and reported as not part of the
 * entry. jsdom is enough for both: nothing here needs layout, and the click a
 * step makes is a real DOM event either way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_MESSAGE_CHARS, parseActComponentArgs, type ActComponentArgs } from '../src/act-component-call.ts'
import { drawnEntry, type DrawnEntry } from '../src/client/entry-container.ts'
import { runActComponent, type ActComponentRun } from '../src/client/act-executor.ts'
import { actStepHolder, type ActStepHolder } from '../src/client/act-step.ts'
import { isCovered } from '../src/client/targets.ts'

/** The entry id every case here acts on. */
const ENTRY = 'demo'

/** The call id every run here belongs to. */
const CALL = 'call_1'

/** Where every run here holds its running step; emptied before each case. */
let holder: ActStepHolder = actStepHolder()

/** How the console's content column is drawn around one component entry. */
const COLUMN = `
<nav data-content-surface-switcher>
  <button data-content-surface-entry="page home">Home</button>
  <button data-content-surface-entry="component other">Other</button>
  <button data-content-surface-entry="component demo" data-content-surface-selected>Demo</button>
</nav>
<div data-content-surface-seat="page" data-content-surface-active></div>
<div data-content-surface-seat="component" data-content-surface-active>
  <div data-component-surface>
    <div data-component-node="toolbar">
      <button data-component-action="add">Add</button>
      <input data-component-field="zh_label">
      <input id="col">
      <label for="col">title</label>
    </div>
  </div>
</div>
<div data-content-surface-seat="component"><div data-component-surface data-component-node="stale"></div></div>
`

/** The console's own chrome, outside every component entry. */
const CHROME = `
<aside data-sidebar>
  <button data-component-action="console-add">Add from the console</button>
  <input aria-label="owner" value="">
</aside>
`

/** One call's arguments, as a model writes them. */
function args(steps: ActComponentArgs['steps']): ActComponentArgs {
  return { entry: ENTRY, steps }
}

/**
 * Run one call the way the seat does: the entry is read again before every
 * step, and the steps run inside a budget counted from now.
 * @param call - the call's arguments.
 * @param entry - the entry the case drew.
 * @param budgetMs - how long the steps may run.
 * @returns what the call ended as.
 */
function run(call: ActComponentArgs, entry: DrawnEntry, budgetMs = 10_000): Promise<ActComponentRun> {
  return runActComponent(call, entry, () => drawnEntry(document), Date.now() + budgetMs, CALL, holder)
}

/**
 * Draw the console, with one handler bound to each side of the confine.
 * @returns the spies the cases assert against.
 */
function draw(): { inside: ReturnType<typeof vi.fn>; outside: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = `${COLUMN}${CHROME}`
  const inside = vi.fn()
  const outside = vi.fn()
  document.querySelector('[data-component-action="add"]')?.addEventListener('click', inside)
  document.querySelector('[data-sidebar] [data-component-action="console-add"]')?.addEventListener('click', outside)
  return { inside, outside }
}

/**
 * What the document's hit test answers: jsdom has none, and a case that gives
 * a control a box to test sets what stands at its point.
 */
let hit: (x: number, y: number) => Element | null = () => null

beforeEach(() => {
  document.body.innerHTML = ''
  holder = actStepHolder()
  hit = () => null
  document.elementFromPoint = (x, y) => hit(x, y)
})

describe('the component entry a call may act on', () => {
  it('finds the entry the column is drawing, and nothing while another kind is in front', () => {
    document.body.innerHTML = COLUMN
    const drawn = drawnEntry(document)
    expect(drawn?.entryId).toBe(ENTRY)
    // The seat of another kind carries the same entry root, and the entry it
    // draws is not the one the column selected: the pair of markers is what
    // keeps a call from acting in a seat that is not on display.
    document.querySelector('[data-content-surface-seat="component"][data-content-surface-active]')
      ?.removeAttribute('data-content-surface-active')
    expect(drawnEntry(document)).toBeUndefined()
  })

  it('draws nothing to act on while no component entry is in front', () => {
    document.body.innerHTML = '<div data-content-surface-seat="component"><div data-component-surface></div></div>'
    expect(drawnEntry(document)).toBeUndefined()
  })

  it('refuses a selected entry of another kind, and one whose key names no kind at all', () => {
    document.body.innerHTML = `
      <nav data-content-surface-switcher>
        <button data-content-surface-entry="page home" data-content-surface-selected>Home</button>
      </nav>
      <div data-content-surface-seat="component" data-content-surface-active>
        <div data-component-surface></div>
      </div>
    `
    expect(drawnEntry(document)).toBeUndefined()
    document.querySelector('[data-content-surface-entry]')?.setAttribute('data-content-surface-entry', 'demo')
    expect(drawnEntry(document)).toBeUndefined()
  })

  it('refuses a selected tab that carries no entry key at all', () => {
    document.body.innerHTML = `
      <nav data-content-surface-switcher>
        <button data-content-surface-selected>Demo</button>
      </nav>
      <div data-content-surface-seat="component" data-content-surface-active>
        <div data-component-surface></div>
      </div>
    `
    expect(drawnEntry(document)).toBeUndefined()
  })

  it('draws nothing when the selected entry has no container drawn for it yet', () => {
    document.body.innerHTML = `
      <nav data-content-surface-switcher>
        <button data-content-surface-entry="component demo" data-content-surface-selected>Demo</button>
      </nav>
      <div data-content-surface-seat="component" data-content-surface-active></div>
    `
    expect(drawnEntry(document)).toBeUndefined()
  })
})

describe('a step inside the entry', () => {
  it('presses the control the block declares, through the block\'s own handler', async () => {
    const { inside, outside } = draw()
    const drawn = drawnEntry(document)
    expect(drawn).toBeDefined()
    const report = await run(args([{ action: 'click', node: 'toolbar', key: 'add' }]), drawn!)
    expect(report.status).toBe('done')
    expect(report.steps).toEqual([{ index: 1, status: 'ok' }])
    expect(inside).toHaveBeenCalledTimes(1)
    expect(outside).not.toHaveBeenCalled()
  })

  it('writes the field the block declares, and tells the block it changed', async () => {
    draw()
    const drawn = drawnEntry(document)
    const declared = document.querySelector('[data-component-field="zh_label"]') as HTMLInputElement
    const seen = vi.fn()
    declared.addEventListener('input', seen)
    const report = await run(args([{ action: 'set', node: 'toolbar', name: 'zh_label', value: 'X' }]), drawn!)
    expect(report.status).toBe('done')
    expect(declared.value).toBe('X')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('writes the field a label inside the entry names, which is all a block that declares none has', async () => {
    draw()
    const drawn = drawnEntry(document)
    const report = await run(args([{ action: 'set', name: 'title', value: 'Y' }]), drawn!)
    expect(report.status).toBe('done')
    expect((document.querySelector('#col') as HTMLInputElement).value).toBe('Y')
  })

  it('waits for a block that is drawn only later', async () => {
    draw()
    const drawn = drawnEntry(document)
    setTimeout(() => {
      const late = document.createElement('div')
      late.setAttribute('data-component-node', 'grid')
      document.querySelector('[data-component-surface]')?.append(late)
    }, 20)
    const report = await run(args([{ action: 'wait', node: 'grid', timeoutMs: 1000 }]), drawn!)
    expect(report.status).toBe('done')
  })
})

describe('a step that would leave the entry', () => {
  it('refuses a control only the console draws, and leaves it unpressed', async () => {
    const { inside, outside } = draw()
    const drawn = drawnEntry(document)
    const report = await run(args([{ action: 'click', key: 'console-add' }]), drawn!)
    expect(report.status).toBe('failed')
    expect(report.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'control "console-add" is not part of the entry on display.',
    }])
    expect(outside).not.toHaveBeenCalled()
    expect(inside).not.toHaveBeenCalled()
  })

  it('refuses a field only the console draws, and leaves it unwritten', async () => {
    draw()
    const drawn = drawnEntry(document)
    const report = await run(args([{ action: 'set', name: 'owner', value: 'X' }]), drawn!)
    expect(report.status).toBe('failed')
    expect(report.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'field "owner" is not part of the entry on display.',
    }])
    expect((document.querySelector('[data-sidebar] input') as HTMLInputElement).value).toBe('')
  })

  it('stops at the step that failed and reports the rest as not run', async () => {
    const { inside } = draw()
    const drawn = drawnEntry(document)
    const report = await run(args([
      { action: 'click', key: 'console-add' },
      { action: 'click', node: 'toolbar', key: 'add' },
    ]), drawn!)
    expect(report.status).toBe('failed')
    expect(report.steps.map(step => step.status)).toEqual(['failed', 'skipped'])
    expect(inside).not.toHaveBeenCalled()
  })
})

describe('the arguments one call may carry', () => {
  it('reads the three actions and refuses a step without its target', () => {
    expect(parseActComponentArgs({ entry: ENTRY, steps: [{ action: 'click', key: 'add' }] })).toEqual({
      entry: ENTRY,
      steps: [{ action: 'click', key: 'add' }],
    })
    expect(parseActComponentArgs({ entry: ENTRY, steps: [{ action: 'wait' }] })).toBeUndefined()
    expect(parseActComponentArgs({ entry: ENTRY, steps: [{ action: 'click', key: 'a b' }] })).toBeUndefined()
    expect(parseActComponentArgs({ entry: ENTRY, steps: [] })).toBeUndefined()
  })
})

/** Draw one entry whose own container holds the markup a case needs. */
function drawEntry(inner: string): DrawnEntry {
  document.body.innerHTML = `
    <nav data-content-surface-switcher>
      <button data-content-surface-entry="component ${ENTRY}" data-content-surface-selected>Demo</button>
    </nav>
    <div data-content-surface-seat="component" data-content-surface-active>
      <div data-component-surface>${inner}</div>
    </div>
  `
  const drawn = drawnEntry(document)
  if (drawn === undefined) throw new Error('the case drew no entry')
  return drawn
}

describe('the field a step writes', () => {
  it('takes the control whose own name is the column, when the block declares no field', async () => {
    const drawn = drawEntry('<input aria-label="title">')
    const report = await run(args([{ action: 'set', name: 'title', value: 'X' }]), drawn)
    expect(report.status).toBe('done')
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('X')
  })

  it('writes a select and a textarea the way a person would', async () => {
    const drawn = drawEntry(`
      <select data-component-field="kind"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <textarea data-component-field="note"></textarea>
    `)
    const changed = vi.fn()
    document.querySelector('select')?.addEventListener('change', changed)
    const report = await run(args([
      { action: 'set', name: 'kind', value: 'Beta' },
      { action: 'set', name: 'note', value: 'hello' },
    ]), drawn)
    expect(report.status).toBe('done')
    expect(document.querySelector('select')?.value).toBe('b')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(document.querySelector('textarea')?.value).toBe('hello')
  })

  it('chooses a native select\'s option by the label it shows, never by its value', async () => {
    const drawn = drawEntry(`
      <select data-component-field="kind">
        <option value="a">Alpha</option><option value="b">Beta</option><option value="c">Twin</option><option value="d">Twin</option>
      </select>
    `)
    const report = await run(args([{ action: 'set', name: 'kind', value: 'b' }]), drawn)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "kind" has no option "b".' }])
    const twice = await run(args([{ action: 'set', name: 'kind', value: 'Twin' }]), drawn)
    expect(twice.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'The field for "kind" draws more than one option "Twin", so this call cannot tell which to choose.',
    }])
    expect(document.querySelector('select')?.value).toBe('a')
  })

  it('refuses an option the native select draws disabled rather than choosing it', async () => {
    const drawn = drawEntry(`
      <select data-component-field="kind">
        <option value="a">Alpha</option><option value="b" disabled>Beta</option>
      </select>
    `)
    const report = await run(args([{ action: 'set', name: 'kind', value: 'Beta' }]), drawn)
    expect(report.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'The field for "kind" has the option "Beta" disabled, so this call cannot choose it.',
    }])
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('a')
  })

  it('refuses an option a disabled group holds rather than choosing it', async () => {
    // An `<optgroup disabled>` disables the options inside it, which is one a
    // person cannot choose either, however the select's own state reads.
    const drawn = drawEntry(`
      <select data-component-field="kind">
        <option value="a">Alpha</option>
        <optgroup label="More" disabled><option value="b">Beta</option></optgroup>
      </select>
    `)
    const report = await run(args([{ action: 'set', name: 'kind', value: 'Beta' }]), drawn)
    expect(report.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'The field for "kind" has the option "Beta" disabled, so this call cannot choose it.',
    }])
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('a')
  })

  it('fails the step when the control refuses the value rather than reporting a write that never happened', async () => {
    const drawn = drawEntry('<input type="number" data-component-field="count">')
    const report = await run(args([{ action: 'set', name: 'count', value: 'abc' }]), drawn)
    expect(report).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'The field for "count" is not one this call may write.' }],
      text: 'Acted on the component entry "Demo" (demo).\n- set "count": The field for "count" is not one this call may write.',
    })
  })

  it('searches the block itself when the block is the control', async () => {
    document.body.innerHTML = `
      <nav data-content-surface-switcher>
        <button data-content-surface-entry="component ${ENTRY}" data-content-surface-selected>Demo</button>
      </nav>
      <div data-content-surface-seat="component" data-content-surface-active>
        <input data-component-surface data-component-field="other" placeholder="title">
      </div>
    `
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    const report = await run(args([{ action: 'set', name: 'title', value: 'X' }]), drawn)
    expect(report.status).toBe('done')
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('X')
  })

  it('fails a step naming a control that names itself by nothing and cannot take a value', async () => {
    const drawn = drawEntry('<div data-component-field="title"><input id="unlabelled"></div>')
    const report = await run(args([{ action: 'set', name: 'title', value: 'X' }]), drawn)
    // The declared marker wins, and the control it names is not one that takes
    // a value: the step fails rather than reporting a write that never happened.
    expect(report.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'The field for "title" is not one this call may write.',
    }])
    expect((document.querySelector('#unlabelled') as HTMLInputElement).value).toBe('')
  })

  it('reads a control naming itself by an id no label inside the entry points at as naming nothing', async () => {
    const drawn = drawEntry('<input id="elsewhere">')
    const report = await run(args([{ action: 'set', name: 'title', value: 'X' }]), drawn)
    expect(report.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'field "title" is not part of the entry on display.',
    }])
  })
})

describe('a field the entry draws more than once', () => {
  it('writes the copy inside the open dialog, which is the one a person would type into', async () => {
    // A page keeps its write dialog in the document with the same field names
    // the query panel carries; the dialog is what is asking for the value, so
    // the copy inside it is the field the call means, whatever order the entry
    // drew the two in.
    const drawn = drawEntry(`
      <input data-component-field="zh_label" id="query">
      <div class="el-dialog__wrapper"><div role="dialog" aria-modal="true" class="el-dialog">
        <input data-component-field="zh_label" id="dialog">
      </div></div>
    `)
    expect((await run(args([{ action: 'set', name: 'zh_label', value: 'X' }]), drawn)).status).toBe('done')
    expect((document.querySelector('#dialog') as HTMLInputElement).value).toBe('X')
    expect((document.querySelector('#query') as HTMLInputElement).value).toBe('')
  })

  it('writes the drawn copy when the dialog holding the other one is closed', async () => {
    const drawn = drawEntry(`
      <input data-component-field="zh_label" id="query">
      <div class="el-dialog__wrapper" style="display: none"><div role="dialog" class="el-dialog">
        <input data-component-field="zh_label" id="closed">
      </div></div>
    `)
    expect((await run(args([{ action: 'set', name: 'zh_label', value: 'X' }]), drawn)).status).toBe('done')
    expect((document.querySelector('#query') as HTMLInputElement).value).toBe('X')
    expect((document.querySelector('#closed') as HTMLInputElement).value).toBe('')
  })

  it('leaves the copies the document holds back out of the count, however the block hid them', async () => {
    const drawn = drawEntry(`
      <input data-component-field="zh_label" id="query">
      <div hidden><input data-component-field="zh_label" id="hidden-attr"></div>
      <div style="visibility: hidden"><input data-component-field="zh_label" id="invisible"></div>
    `)
    expect((await run(args([{ action: 'set', name: 'zh_label', value: 'X' }]), drawn)).status).toBe('done')
    expect((document.querySelector('#query') as HTMLInputElement).value).toBe('X')
    expect((document.querySelector('#hidden-attr') as HTMLInputElement).value).toBe('')
    expect((document.querySelector('#invisible') as HTMLInputElement).value).toBe('')
  })

  it('writes the only field there is even where the document hides it', async () => {
    // Nothing else names the column, so the hidden copy is the field: a page
    // that keeps a form in the document while it is closed still takes the
    // value, and a step that refused here would refuse a write a person can
    // make by opening the form.
    const drawn = drawEntry('<div style="display: none"><input data-component-field="zh_label" id="closed"></div>')
    expect((await run(args([{ action: 'set', name: 'zh_label', value: 'X' }]), drawn)).status).toBe('done')
    expect((document.querySelector('#closed') as HTMLInputElement).value).toBe('X')
  })

  it('writes the drawn copy when the open dialog holds the name only hidden', async () => {
    // The dialog is what is asking, but its own copy of the column is hidden:
    // a person would type into the drawn copy outside it, and the step writes
    // where the person could rather than into a control nobody can reach.
    const drawn = drawEntry(`
      <input data-component-field="zh_label" id="query">
      <div class="el-dialog__wrapper"><div role="dialog" aria-modal="true" class="el-dialog">
        <div hidden><input data-component-field="zh_label" id="dialog-hidden"></div>
      </div></div>
    `)
    expect((await run(args([{ action: 'set', name: 'zh_label', value: 'X' }]), drawn)).status).toBe('done')
    expect((document.querySelector('#query') as HTMLInputElement).value).toBe('X')
    expect((document.querySelector('#dialog-hidden') as HTMLInputElement).value).toBe('')
  })

  it('refuses a name two drawn controls carry rather than picking one of them', async () => {
    const drawn = drawEntry(`
      <input data-component-field="zh_label" id="first">
      <input data-component-field="zh_label" id="second">
    `)
    expect(await run(args([{ action: 'set', name: 'zh_label', value: 'X' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{
        index: 1,
        status: 'failed',
        message: 'field "zh_label" is drawn more than once in the entry, so this call cannot tell which one to write.',
      }],
      text: 'Acted on the component entry "Demo" (demo).'
        + '\n- set "zh_label": field "zh_label" is drawn more than once in the entry, so this call cannot tell which one to write.',
    })
    expect((document.querySelector('#first') as HTMLInputElement).value).toBe('')
    expect((document.querySelector('#second') as HTMLInputElement).value).toBe('')
  })
})

/**
 * Draw one select the way element-ui draws one, with the behaviour a case needs
 * from the component behind it: the list is a child of the select, in the
 * document from the start and hidden, the field's control is the select's own
 * read-only input, and a click on the select is what opens the list.
 * @param options - the labels the list offers, in order.
 * @param behavior - how the fixture's own component answers: a list already
 *   open, a component that takes nothing on a click, one that shows what it
 *   took as a tag rather than in its input.
 * @returns the drawn entry, and the select with the parts a case asserts on.
 */
function drawSelect(
  options: readonly string[],
  behavior: { readonly open?: boolean; readonly ignores?: boolean; readonly multiple?: boolean } = {},
): { drawn: DrawnEntry; select: HTMLElement; input: HTMLInputElement; menu: HTMLElement } {
  const items = options.map(label => `<li class="el-select-dropdown__item">${label}</li>`).join('')
  const drawn = drawEntry(`
    <div class="el-select">
      <input class="el-input__inner" data-component-field="city" readonly>
      <div class="el-select-dropdown">${items}</div>
    </div>
  `)
  const select = drawn.container.querySelector('.el-select') as HTMLElement
  const input = select.querySelector('input.el-input__inner') as HTMLInputElement
  const menu = select.querySelector('.el-select-dropdown') as HTMLElement
  menu.style.display = behavior.open === true ? '' : 'none'
  select.addEventListener('click', () => { menu.style.display = '' })
  for (const option of select.querySelectorAll('.el-select-dropdown__item')) {
    if (behavior.ignores === true) continue
    option.addEventListener('click', (event) => {
      // element-ui stops an option's click at the option, so the select's own
      // toggle never sees the choice.
      event.stopPropagation()
      if (behavior.multiple !== true) {
        input.value = (option.textContent ?? '').trim()
        return
      }
      // element-ui draws a multiple select's choice as a tag and clears the
      // input, so what the step's confirmation reads is the tag.
      input.value = ''
      const tag = document.createElement('span')
      tag.className = 'el-select__tags-text'
      tag.textContent = (option.textContent ?? '').trim()
      select.appendChild(tag)
    })
  }
  return { drawn, select, input, menu }
}

describe('a field the entry draws as a select', () => {
  it('opens the list, chooses the option the value names, and reports done once the select shows it', async () => {
    const { drawn, input, menu } = drawSelect(['核心', '接入'])
    // element-ui draws the field control read-only, with the list in the
    // document and hidden: the open a step makes is the click a person makes.
    expect(input.readOnly).toBe(true)
    expect(menu.style.display).toBe('none')
    expect(await run(args([{ action: 'set', name: 'city', value: '接入' }]), drawn)).toEqual({
      status: 'done',
      steps: [{ index: 1, status: 'ok' }],
      text: 'Acted on the component entry "Demo" (demo).\n- set "city": done',
    })
    expect(input.value).toBe('接入')
  })

  it('fails where the column switched to another entry while the list opened, and chooses nothing', async () => {
    // The entry the column switches to draws in the same element, so the
    // option the step would choose may be its own.
    const { drawn, select, input } = drawSelect(['接入'])
    select.addEventListener('click', () => {
      document.querySelector('[data-content-surface-selected]')?.setAttribute('data-content-surface-entry', 'component other')
    })
    const report = await run(args([{ action: 'set', name: 'city', value: '接入' }]), drawn)
    expect(report.steps).toEqual([
      { index: 1, status: 'failed', message: 'The entry in front is "other", not the one this call named.' },
    ])
    expect(input.value).toBe('')
  })

  it('chooses from a list already open without the click that would toggle it shut', async () => {
    // A previous step may have left the list open, and the toggle an open list
    // gets is the one that closes it.
    const { drawn, input, select, menu } = drawSelect(['接入'], { open: true })
    const toggled = vi.fn()
    select.addEventListener('click', toggled)
    expect((await run(args([{ action: 'set', name: 'city', value: '接入' }]), drawn)).status).toBe('done')
    expect(toggled).not.toHaveBeenCalled()
    expect(input.value).toBe('接入')
    expect(menu.style.display).toBe('')
  })

  it('confirms a multiple select through the tag it draws', async () => {
    const { drawn, input, select } = drawSelect(['接入'], { multiple: true })
    expect((await run(args([{ action: 'set', name: 'city', value: '接入' }]), drawn)).status).toBe('done')
    expect(input.value).toBe('')
    expect(select.querySelector('.el-select__tags-text')?.textContent).toBe('接入')
  })

  it('refuses a value no drawn option carries, naming it, and writes nothing', async () => {
    const { drawn, input } = drawSelect(['核心'])
    expect(await run(args([{ action: 'set', name: 'city', value: '接入' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'The field for "city" has no option "接入".' }],
      text: 'Acted on the component entry "Demo" (demo).\n- set "city": The field for "city" has no option "接入".',
    })
    expect(input.value).toBe('')
  })

  it('refuses a value two drawn options carry rather than choosing one of them', async () => {
    const { drawn, input } = drawSelect(['重复', '重复'])
    expect(await run(args([{ action: 'set', name: 'city', value: '重复' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{
        index: 1,
        status: 'failed',
        message: 'The field for "city" draws more than one option "重复", so this call cannot tell which to choose.',
      }],
      text: 'Acted on the component entry "Demo" (demo).'
        + '\n- set "city": The field for "city" draws more than one option "重复", so this call cannot tell which to choose.',
    })
    // Nothing was chosen: a guess between the two would write where the call
    // did not say.
    expect(input.value).toBe('')
  })

  it('fails where the select did not take the chosen option, rather than reporting the write', async () => {
    // A component that takes nothing on the click: nothing about the select
    // will ever show the value, so the step fails instead of reporting it.
    const { drawn, input } = drawSelect(['接入'], { ignores: true })
    expect(await run(args([{ action: 'set', name: 'city', value: '接入' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'The field for "city" did not take the option "接入".' }],
      text: 'Acted on the component entry "Demo" (demo).\n- set "city": The field for "city" did not take the option "接入".',
    })
    expect(input.value).toBe('')
  })

  it('refuses a disabled select before opening its list', async () => {
    const { drawn, input, menu } = drawSelect(['接入'])
    input.setAttribute('disabled', '')
    expect(await run(args([{ action: 'set', name: 'city', value: '接入' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'The field for "city" is disabled, so this call cannot write it.' }],
      text: 'Acted on the component entry "Demo" (demo).\n- set "city": The field for "city" is disabled, so this call cannot write it.',
    })
    expect(menu.style.display).toBe('none')
  })

  it('treats a select that holds the entry rather than standing inside it as no select at all', async () => {
    // The confine is the entry: a select wrapping it from outside would hold
    // options and a list this call may not reach, so the field counts as a
    // select only where the select itself stands inside the entry.
    document.body.innerHTML = `
      <nav data-content-surface-switcher>
        <button data-content-surface-entry="component ${ENTRY}" data-content-surface-selected>Demo</button>
      </nav>
      <div data-content-surface-seat="component" data-content-surface-active>
        <div class="el-select">
          <div data-component-surface>
            <input class="el-input__inner" data-component-field="city" readonly>
          </div>
        </div>
      </div>
    `
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    const report = await run(args([{ action: 'set', name: 'city', value: '接入' }]), drawn)
    expect(report.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'The field for "city" is read-only, so this call cannot write it.',
    }])
  })

  it('refuses a read-only control that is not a select instead of reporting a write it never made', async () => {
    // The regression this pins: the DOM value of a read-only control can be
    // assigned and read back, so the step used to report done for a field the
    // component behind it never took — the same false success a select's own
    // read-only control produces.
    const drawn = drawEntry('<input data-component-field="title" readonly>')
    const report = await run(args([{ action: 'set', name: 'title', value: 'X' }]), drawn)
    expect(report.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'The field for "title" is read-only, so this call cannot write it.',
    }])
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('')
  })

  it('refuses a disabled field', async () => {
    const drawn = drawEntry('<input data-component-field="title" disabled>')
    const report = await run(args([{ action: 'set', name: 'title', value: 'X' }]), drawn)
    expect(report.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'The field for "title" is disabled, so this call cannot write it.',
    }])
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('')
  })
})

/**
 * Draw one autocomplete the way element-ui draws one, with the behaviour a
 * case needs from the component behind it: the panel is a child of the
 * autocomplete, in the document from the start and hidden, the block answers a
 * typed query with its suggestions, an emptied field drops them, and a chosen
 * suggestion is what fills the input.
 * @param options - the labels the block answers with, in order.
 * @param behavior - how the fixture's own component answers: a block still
 *   loading, so the panel first holds the asking row and the suggestions land
 *   a turn later; a component that takes nothing on a click; or one that draws
 *   its panel only once the field was focused, which is element-ui's own rule
 *   for a block that does not open the panel itself. `answer` makes the block
 *   ask and then never answer, or answer with no suggestion, which closes the
 *   panel the way element-ui does. `opensOnAnswer` opens the panel when a late
 *   answer lands whether or not it was closed, as the vendored kit does.
 *   `answers` gives the labels the block answers one query text with, an empty
 *   list included, so a case can tell one query's answer from another's; a text
 *   it does not list is answered the way `options` says.
 *   `queryDelayMs` is the block's own debounce, so the asking row is drawn
 *   that long after the typing; `askingMs` is how long that row stands before
 *   the answer lands, and 20ms by default. `inFlightMs` opens the case with a
 *   query already out, as a field whose earlier text left one on the wire: its
 *   row is drawn from the start and answers with no suggestion that long
 *   after, element-ui keeping one loading flag that a cleared field does not
 *   reset; `'never'` leaves that query unanswered for the whole case, as a
 *   request the transport rejected does. The Tab key closes the panel from the
 *   field's root, as element-ui's own markup does; `asTextarea` draws that root
 *   as the `.el-textarea` element-ui gives a textarea field rather than the
 *   `.el-input` it gives a text field, with the control a `textarea`.
 * @returns the drawn entry, and the autocomplete with the parts a case asserts on.
 */
function drawAutocomplete(
  options: readonly string[],
  behavior: {
    readonly ignores?: boolean
    readonly loading?: boolean
    readonly opensOnFocus?: boolean
    readonly opensOnAnswer?: boolean
    readonly answer?: 'never' | 'none'
    readonly answers?: Readonly<Record<string, readonly string[]>>
    readonly queryDelayMs?: number
    readonly askingMs?: number
    readonly inFlightMs?: number | 'never'
    readonly asTextarea?: boolean
  } = {},
): {
  drawn: DrawnEntry
  autocomplete: HTMLElement
  root: HTMLElement
  input: HTMLInputElement | HTMLTextAreaElement
  panel: HTMLElement
  list: HTMLElement
} {
  const listed = (labels: readonly string[]): string => labels.map(label => `<li role="option">${label}</li>`).join('')
  const items = listed(options)
  // The newlines give the mutation text nodes besides the row, which is what
  // exercises the branch `addedAskingRow` answers for a node that is not an
  // Element.
  const askingRow = '\n<li><i class="el-icon-loading"></i></li>\n'
  const asTextarea = behavior.asTextarea === true
  const rootClass = asTextarea ? 'el-textarea' : 'el-input'
  const control = asTextarea
    ? '<textarea class="el-textarea__inner" data-component-field="topic"></textarea>'
    : '<input class="el-input__inner" data-component-field="topic">'
  const drawn = drawEntry(`
    <div class="el-autocomplete">
      <div class="${rootClass}">
        ${control}
      </div>
      <div class="el-autocomplete-suggestion">
        <div class="el-autocomplete-suggestion__wrap">
          <ul class="el-autocomplete-suggestion__list">${items}</ul>
        </div>
      </div>
    </div>
  `)
  const autocomplete = drawn.container.querySelector('.el-autocomplete') as HTMLElement
  const root = autocomplete.querySelector(`.${rootClass}`) as HTMLElement
  const input = autocomplete.querySelector(asTextarea ? 'textarea.el-textarea__inner' : 'input.el-input__inner') as HTMLInputElement | HTMLTextAreaElement
  const panel = autocomplete.querySelector('.el-autocomplete-suggestion') as HTMLElement
  const list = autocomplete.querySelector('.el-autocomplete-suggestion__list') as HTMLElement
  panel.style.display = 'none'
  let activated = behavior.opensOnFocus !== true
  // element-ui draws whatever the one loading flag says, so a query that starts
  // while another is still out finds the row already there and adds nothing,
  // and a cleared field keeps the row a query still out drew.
  let loading = behavior.inFlightMs !== undefined
  let drawnOptions = items
  let shown = items
  const render = (): void => {
    const asked = loading ? askingRow : drawnOptions
    if (asked === shown) return
    shown = asked
    list.innerHTML = asked
  }
  const answer = (labels: string): void => {
    loading = false
    drawnOptions = labels
    render()
    if (labels === '') panel.style.display = 'none'
    else if (behavior.opensOnAnswer === true) {
      activated = true
      panel.style.display = ''
    }
  }
  /** The answer to one query text: what `answers` lists for it, or `options`. */
  const answerFor = (typed: string): string => {
    const written = behavior.answers?.[typed]
    return written === undefined ? items : listed(written)
  }
  input.addEventListener('focus', () => { activated = true })
  // element-ui hears the Tab on the field's root, not on the control itself.
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return
    activated = false
    panel.style.display = 'none'
  })
  if (behavior.inFlightMs !== undefined) {
    render()
    if (typeof behavior.inFlightMs === 'number') setTimeout(() => { answer('') }, behavior.inFlightMs)
  }
  input.addEventListener('input', () => {
    // element-ui drops the suggestions with an emptied field and shows the
    // panel over a typed one; whether and what the block answers the typed
    // text with is set by `answer` and `answers`.
    if (input.value === '') {
      panel.style.display = 'none'
      drawnOptions = ''
      render()
      return
    }
    panel.style.display = activated ? '' : 'none'
    const asks = behavior.loading === true || behavior.answer !== undefined || behavior.answers !== undefined
    const askingMs = behavior.askingMs ?? 20
    const startAsking = (): void => {
      if (asks) {
        loading = true
        render()
      } else {
        // An answer clears element-ui's one loading flag even where an earlier
        // query left it set, which is what brings the suggestions back.
        loading = false
        drawnOptions = items
        render()
      }
      if (behavior.answer === 'none') setTimeout(() => { answer('') }, askingMs)
      else if (asks && behavior.answer !== 'never') {
        const labels = answerFor(input.value)
        setTimeout(() => { answer(labels) }, askingMs)
      }
    }
    const queryDelayMs = behavior.queryDelayMs ?? 0
    if (queryDelayMs === 0) startAsking()
    else setTimeout(startAsking, queryDelayMs)
  })
  // The suggestions are re-rendered per query, so the choice is heard where
  // it does not unmount: element-ui's own rows carry the click per row.
  list.addEventListener('click', (event) => {
    const option = (event.target as Element | null)?.closest('li')
    if (option === null || option === undefined) return
    if (option.querySelector('.el-icon-loading') !== null) return
    if (behavior.ignores === true) return
    input.value = (option.textContent ?? '').trim()
    // element-ui empties the suggestions on the choice itself.
    loading = false
    drawnOptions = ''
    render()
  })
  return { drawn, autocomplete, root, input, panel, list }
}

describe('a field the entry draws as an autocomplete', () => {
  it('types the value, chooses the suggestion it names, and reports done once the panel closed on the choice', async () => {
    const { drawn, input } = drawAutocomplete(['森林防火一张图', '林地一张图'])
    expect(await run(args([{ action: 'set', name: 'topic', value: '森林防火一张图' }]), drawn)).toEqual({
      status: 'done',
      steps: [{ index: 1, status: 'ok' }],
      text: 'Acted on the component entry "Demo" (demo).\n- set "topic": done',
    })
    expect(input.value).toBe('森林防火一张图')
  })

  it('focuses the field, which is what opens the panel of a block that does not open it itself', async () => {
    const { drawn, input } = drawAutocomplete(['接入'], { opensOnFocus: true })
    expect((await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)).status).toBe('done')
    expect(input.value).toBe('接入')
  })

  it('does not count the row the block draws while it is still asking as a suggestion', async () => {
    // A wait that settled on the loading row would match against a list that
    // holds no choice yet and report no option before any arrived.
    const { drawn, input } = drawAutocomplete(['接入'], { loading: true })
    expect((await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)).status).toBe('done')
    expect(input.value).toBe('接入')
  })

  it('finds the suggestion on a retry where the field kept its focus and a Tab left the panel closed', async () => {
    // The regression this pins: a Tab closed the panel with the focus still in
    // the field, so the row this query draws stands in a hidden panel. A step
    // that read the row's presence off what is drawn would take the row for
    // the block's answer and refuse a value still on its way.
    const { drawn, input } = drawAutocomplete(['接入'], { opensOnFocus: true, loading: true, opensOnAnswer: true, askingMs: 200 })
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
    expect(report.steps).toEqual([{ index: 1, status: 'ok' }])
    expect(input.value).toBe('接入')
  })

  it('refuses a value no drawn suggestion carries, naming it, and leaves the field as it found it', async () => {
    // The typing is the step's own: leaving it standing on a refusal would be
    // text the entry now holds and the block never took.
    const { drawn, input } = drawAutocomplete(['核心'])
    expect(await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }],
      text: 'Acted on the component entry "Demo" (demo).\n- set "topic": The field for "topic" has no option "接入".',
    })
    expect(input.value).toBe('')
  })

  it('refuses a value the block answers with no suggestion for as soon as the answer lands', { timeout: 3000 }, async () => {
    // The asking row came and went with nothing drawn: the block answered, and
    // the wait does not run on to the call's deadline to say so.
    const { drawn, input } = drawAutocomplete(['接入'], { answer: 'none' })
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn, 60_000)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }])
    expect(input.value).toBe('')
  })

  it('refuses it the same way where the asking row is drawn and gone between two looks', { timeout: 3000 }, async () => {
    // The regression this pins: the row is drawn and gone inside one poll
    // interval, so looking for it at poll time could miss it entirely and leave
    // the step waiting for a deadline that a refusal does not need.
    const { drawn, input } = drawAutocomplete(['接入'], { answer: 'none', queryDelayMs: 15, askingMs: 10 })
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn, 60_000)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }])
    expect(input.value).toBe('')
  })

  it('refuses a value the block answers with no suggestion for even where a query was already out', { timeout: 4000 }, async () => {
    // The regression this pins: the earlier query's row was already standing
    // when the watching began, and element-ui's one loading flag means this
    // step's query adds no row of its own — a step that only watched for an
    // added row would run out the call's time over two answers that both came
    // back empty.
    const { drawn, input } = drawAutocomplete(['接入'], { answer: 'none', inFlightMs: 300 })
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn, 2000)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }])
    expect(input.value).toBe('')
  })

  it('types its own value where a query already out never calls back, rather than waiting out the call', { timeout: 20_000 }, async () => {
    // The regression this pins: a query that never answers leaves element-ui's
    // loading flag set and its asking row standing, so a wait for that row to
    // go would run to the call's deadline and every later `set` on the field
    // would report the time-out sentence until somebody typed in it. The step
    // waits no longer than the component's own re-render bound and types, and
    // its own answer clears the row.
    const { drawn, input } = drawAutocomplete(['接入'], { inFlightMs: 'never' })
    const started = performance.now()
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn, 4000)
    expect(report.steps).toEqual([{ index: 1, status: 'ok' }])
    expect(input.value).toBe('接入')
    // Well before the budget's end: the step waited out the bound, not the
    // call.
    expect(performance.now() - started).toBeLessThan(2500)
  })

  it('says the call ran out of time, not that there is no option, while the block is still asking', async () => {
    const { drawn, input } = drawAutocomplete(['接入'], { answer: 'never' })
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }, { action: 'click', key: 'add' }]), drawn, 150)
    expect(report.steps).toEqual([
      { index: 1, status: 'failed', message: 'The console\'s time for this call ran out before this step finished.' },
      { index: 2, status: 'skipped' },
    ])
    expect(input.value).toBe('')
  })

  it('puts back what the field held before the step typed, tells the block it did, and closes the panel', async () => {
    // A field that already holds a choice — a related record the person picked
    // — keeps it through a refusal: the step's own typing is what is undone.
    const { drawn, input, panel } = drawAutocomplete(['核心'])
    input.value = '林地一张图'
    const heard: string[] = []
    input.addEventListener('change', () => { heard.push(input.value) })
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }])
    expect(input.value).toBe('林地一张图')
    expect(heard).toEqual(['', '接入', '林地一张图'])
    expect(panel.style.display).toBe('none')
  })

  it('waits for the block to answer the text it put back before closing a panel the answer opens', async () => {
    // The vendored kit opens the panel on every answer, closed or not, so a
    // panel closed before the block answered the restored text would open
    // again under a refusal.
    const { drawn, input, panel } = drawAutocomplete(['核心'], { loading: true, opensOnAnswer: true })
    input.value = '林地一张图'
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }])
    await new Promise<void>((resolve) => { setTimeout(resolve, 60) })
    expect(input.value).toBe('林地一张图')
    expect(panel.style.display).toBe('none')
  })

  it('puts the text back and closes the panel even when the call\'s time runs out while the block answers', async () => {
    const { drawn, input, panel } = drawAutocomplete(['接入'], { answer: 'never' })
    input.value = '林地一张图'
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn, 150)
    expect(report.steps).toEqual([
      { index: 1, status: 'failed', message: 'The console\'s time for this call ran out before this step finished.' },
    ])
    expect(input.value).toBe('林地一张图')
    expect(panel.style.display).toBe('none')
  })

  it('waits out the restored text\'s query whose asking row is drawn and gone between two looks', async () => {
    // The row lives less than one look and the answer behind it opens the
    // panel, so a close sent on the strength of the row having started would
    // be undone by that answer.
    const { drawn, root, input, panel } = drawAutocomplete(['核心'], {
      opensOnFocus: true, loading: true, opensOnAnswer: true, queryDelayMs: 15, askingMs: 10,
    })
    input.value = '林地一张图'
    input.focus()
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: false }))
    const tabs: string[] = []
    root.addEventListener('keydown', (event) => { tabs.push(event.key) })
    const started = performance.now()
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }])
    // The row was recorded as it was added, not missed and waited out.
    expect(performance.now() - started).toBeLessThan(600)
    await new Promise<void>((resolve) => { setTimeout(resolve, 40) })
    expect(tabs).toEqual(['Tab'])
    expect(panel.style.display).toBe('none')
  })

  it('waits out the restored text\'s query whose asking row is drawn in a hidden panel', async () => {
    // The row stands in a panel a Tab closed while the field kept its focus,
    // where a look at what is drawn misses it: the close would then be sent
    // before the answer that opens the panel again.
    const { drawn, root, input, panel } = drawAutocomplete([], {
      opensOnFocus: true, opensOnAnswer: true, queryDelayMs: 15, askingMs: 200,
      answers: { 接入: [], 林地一张图: ['林地一张图'] },
    })
    input.value = '林地一张图'
    input.focus()
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: false }))
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn, 60_000)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }])
    expect(input.value).toBe('林地一张图')
    // The restored text's answer lands after the close: one sent before it
    // would leave the panel the answer opened on screen.
    await new Promise<void>((resolve) => { setTimeout(resolve, 250) })
    expect(panel.style.display).toBe('none')
  })

  it('closes the panel with a Tab the field\'s own root hears and no bubbling listener does', async () => {
    // element-ui hears the key on the `.el-input` root; a listener outside the
    // field sees it only in the capture phase, which is what leaves the
    // console's own keyboard-operation styling with the key.
    const { drawn, root, input, panel } = drawAutocomplete(['核心'], { loading: true })
    input.value = '林地一张图'
    const heard: string[] = []
    root.addEventListener('keydown', (event) => { heard.push(event.key) })
    const bubbled: string[] = []
    const listen = (event: KeyboardEvent): void => { bubbled.push(event.key) }
    window.addEventListener('keydown', listen)
    try {
      const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
      expect(report.status).toBe('failed')
    } finally {
      window.removeEventListener('keydown', listen)
    }
    expect(heard).toEqual(['Tab'])
    expect(bubbled).toEqual([])
    expect(panel.style.display).toBe('none')
  })

  it('closes a textarea field\'s panel from the root element-ui draws for it', async () => {
    // element-ui draws a textarea field's root as `.el-textarea`, not
    // `.el-input`, and hears the Tab there; that Tab is what closes the panel
    // the restored text's answer opens.
    const { drawn, root, input, panel } = drawAutocomplete(['核心'], { loading: true, asTextarea: true })
    input.value = '林地一张图'
    const heard: string[] = []
    root.addEventListener('keydown', (event) => { heard.push(event.key) })
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }])
    expect(input.value).toBe('林地一张图')
    expect(heard).toEqual(['Tab'])
    expect(panel.style.display).toBe('none')
  })

  it('sends no Tab where the entry left the front while the restored text was answered', async () => {
    // Another entry may draw in the element this one held, and the key would
    // close whatever panel that entry has open.
    const { drawn, root, input } = drawAutocomplete(['核心'], { loading: true })
    input.value = '林地一张图'
    const heard: string[] = []
    root.addEventListener('keydown', (event) => { heard.push(event.key) })
    input.addEventListener('input', () => {
      if (input.value !== '林地一张图') return
      document.querySelector('[data-content-surface-selected]')?.setAttribute('data-content-surface-entry', 'component other')
    })
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }])
    expect(heard).toEqual([])
  })

  it('sends no key where a suggestion field is drawn without an element-ui input root', async () => {
    // A block may draw its own suggestion markup. The value is still put back,
    // and element-ui hears nothing: there is no root of its own to close on.
    const drawn = drawEntry(`
      <div class="el-autocomplete">
        <input class="el-input__inner" data-component-field="topic">
        <div class="el-autocomplete-suggestion"><div class="el-autocomplete-suggestion__wrap">
          <ul class="el-autocomplete-suggestion__list"><li role="option">核心</li></ul>
        </div></div>
      </div>
    `)
    const input = drawn.container.querySelector('input') as HTMLInputElement
    input.value = '林地一张图'
    const heard: string[] = []
    input.addEventListener('keydown', (event) => { heard.push(event.key) })
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
    expect(report.steps).toEqual([{ index: 1, status: 'failed', message: 'The field for "topic" has no option "接入".' }])
    expect(input.value).toBe('林地一张图')
    expect(heard).toEqual([])
  })

  it('writes nothing back where the step left the field holding what it held, and closes the panel', async () => {
    const { drawn, input, panel } = drawAutocomplete(['核心'])
    input.value = '接入'
    const heard: string[] = []
    input.addEventListener('change', () => { heard.push(input.value) })
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
    expect(report.status).toBe('failed')
    expect(heard).toEqual(['', '接入'])
    expect(panel.style.display).toBe('none')
  })

  it('fails where the column switched to another entry while the block answered, and leaves the field alone', async () => {
    // The entry the column switches to draws in the same element, so the
    // suggestions and the field the step would go on with may be its own.
    const { drawn, input } = drawAutocomplete(['接入'])
    const chosen = vi.fn()
    input.addEventListener('input', () => {
      if (input.value !== '接入') return
      document.querySelector('[data-content-surface-selected]')?.setAttribute('data-content-surface-entry', 'component other')
    })
    drawn.container.querySelector('.el-autocomplete-suggestion__list')?.addEventListener('click', chosen)
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
    expect(report.steps).toEqual([
      { index: 1, status: 'failed', message: 'The entry in front is "other", not the one this call named.' },
    ])
    expect(chosen).not.toHaveBeenCalled()
    expect(input.value).toBe('接入')
  })

  it('refuses a suggestion field whose control takes no typing', async () => {
    const drawn = drawEntry('<div class="el-autocomplete"><span data-component-field="topic">接入</span></div>')
    expect((await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'The field for "topic" is not one this call may write.',
    }])
  })

  it('refuses a value two drawn suggestions carry rather than choosing one of them', async () => {
    const { drawn, input } = drawAutocomplete(['重复', '重复'])
    expect(await run(args([{ action: 'set', name: 'topic', value: '重复' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{
        index: 1,
        status: 'failed',
        message: 'The field for "topic" draws more than one option "重复", so this call cannot tell which to choose.',
      }],
      text: 'Acted on the component entry "Demo" (demo).'
        + '\n- set "topic": The field for "topic" draws more than one option "重复", so this call cannot tell which to choose.',
    })
    expect(input.value).toBe('')
  })

  it('fails where the panel stayed open on the click, rather than reporting the choice', async () => {
    // A component that takes nothing on the click: nothing about the panel
    // will ever close on the value, so the step fails instead of reporting it.
    const { drawn, input } = drawAutocomplete(['接入'], { ignores: true })
    expect(await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'The field for "topic" did not take the option "接入".' }],
      text: 'Acted on the component entry "Demo" (demo).\n- set "topic": The field for "topic" did not take the option "接入".',
    })
    expect(input.value).toBe('')
  })

  it('refuses a disabled suggestion field', async () => {
    const { drawn, input } = drawAutocomplete(['接入'])
    input.setAttribute('disabled', '')
    expect(await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'The field for "topic" is disabled, so this call cannot write it.' }],
      text: 'Acted on the component entry "Demo" (demo).\n- set "topic": The field for "topic" is disabled, so this call cannot write it.',
    })
    expect(input.value).toBe('')
  })

  it('writes a control whose autocomplete holds the entry from outside as plain text', async () => {
    // The confine is the entry: an autocomplete wrapping it from outside would
    // hold suggestions this call may not reach, so the field counts as a
    // suggestion field only where the autocomplete itself stands inside it —
    // and the control inside is then what it is, a writable input.
    document.body.innerHTML = `
      <nav data-content-surface-switcher>
        <button data-content-surface-entry="component ${ENTRY}" data-content-surface-selected>Demo</button>
      </nav>
      <div data-content-surface-seat="component" data-content-surface-active>
        <div class="el-autocomplete">
          <div data-component-surface>
            <input class="el-input__inner" data-component-field="topic">
          </div>
        </div>
      </div>
    `
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    const report = await run(args([{ action: 'set', name: 'topic', value: '接入' }]), drawn)
    expect(report.status).toBe('done')
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('接入')
  })
})

describe('a control that is not an HTMLElement', () => {
  it('is pressed with a click event, so a drawn SVG control still runs its handler', async () => {
    const drawn = drawEntry('<svg><circle data-component-action="pick"></circle></svg>')
    const picked = vi.fn()
    document.querySelector('circle')?.addEventListener('click', picked)
    const report = await run(args([{ action: 'click', key: 'pick' }]), drawn)
    expect(report.status).toBe('done')
    expect(picked).toHaveBeenCalledTimes(1)
  })
})

describe('a step naming a block the entry does not draw', () => {
  it('refuses the click and the write before touching anything', async () => {
    draw()
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    const report = await run(args([
      { action: 'click', node: 'ghost', key: 'add' },
      { action: 'set', node: 'ghost', name: 'title', value: 'X' },
    ]), drawn)
    expect(report).toEqual({
      status: 'failed',
      steps: [
        { index: 1, status: 'failed', message: 'block "ghost" is not part of the entry on display.' },
        { index: 2, status: 'skipped' },
      ],
      text: [
        'Acted on the component entry "Demo" (demo).',
        '- click in ghost on "add": block "ghost" is not part of the entry on display.',
        '- set "title" in ghost: not run',
      ].join('\n'),
    })
  })
})

describe('the time a call\'s steps may run for', () => {
  it('stops the step whose wait the deadline cuts short, and runs none of the steps behind it', async () => {
    const { inside } = draw()
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    const report = await run(args([{ action: 'wait', key: 'ghost', timeoutMs: 5000 }, { action: 'click', key: 'add' }]), drawn, 80)
    expect(report.steps).toEqual([
      { index: 1, status: 'failed', message: 'The console\'s time for this call ran out before this step finished.' },
      { index: 2, status: 'skipped' },
    ])
    expect(inside).not.toHaveBeenCalled()
  })

  it('starts no step once the deadline has passed', async () => {
    const { inside } = draw()
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    const report = await run(args([{ action: 'click', key: 'add' }]), drawn, -1)
    expect(report.steps).toEqual([
      { index: 1, status: 'failed', message: 'The console\'s time for this call ran out before this step finished.' },
    ])
    expect(inside).not.toHaveBeenCalled()
  })
})

describe('a wait step', () => {
  it('waits for a declared key with the built-in deadline when the step names none', async () => {
    draw()
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    const report = await run(args([{ action: 'wait', key: 'add' }]), drawn)
    expect(report.status).toBe('done')
  })

  it('waits for a control to be drawn, not merely to exist in the document', async () => {
    // The waiter asks the same question a press does: a control kept in the
    // document while closed is not one the wait may call appeared.
    const drawn = drawEntry('<div hidden id="sheet"><button data-component-action="save">Save</button></div>')
    setTimeout(() => { document.querySelector('#sheet')?.removeAttribute('hidden') }, 80)
    expect((await run(args([{ action: 'wait', key: 'save', timeoutMs: 1000 }]), drawn)).status).toBe('done')
  })

  it('fails rather than letting a hidden control satisfy the wait', async () => {
    const drawn = drawEntry('<div hidden><button data-component-action="save">Save</button></div>')
    expect(await run(args([{ action: 'wait', key: 'save', timeoutMs: 60 }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'control "save" did not appear within 60ms.' }],
      text: 'Acted on the component entry "Demo" (demo).\n- wait for save: control "save" did not appear within 60ms.',
    })
  })

  it('fails with the target it waited for and the time it waited, not with a sentence about the entry', async () => {
    draw()
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    const cases: [ActComponentArgs['steps'][number], string][] = [
      [{ action: 'wait', node: 'ghost', timeoutMs: 50 }, '"ghost" did not appear within 50ms.'],
      [{ action: 'wait', key: 'ghost', timeoutMs: 50 }, 'control "ghost" did not appear within 50ms.'],
      // A step that named both waited for a key inside the block, and the
      // sentence says which key it was rather than only where it looked.
      [{ action: 'wait', node: 'ghost', key: 'save', timeoutMs: 50 }, 'control "save" in "ghost" did not appear within 50ms.'],
    ]
    for (const [step, message] of cases) {
      const report = await run(args([step]), drawn)
      expect({ step, report: report.steps }).toEqual({
        step,
        report: [{ index: 1, status: 'failed', message }],
      })
    }
  })

})

describe('the entry a long call is running against', () => {
  /**
   * Draw the console and replace the entry in front from the block's own
   * handler, the way the column does when a press switches what it draws.
   * @param replace - what the handler does to the drawn entry.
   * @returns the entry the call started on.
   */
  function drawAndSwitch(replace: () => void): DrawnEntry {
    document.body.innerHTML = COLUMN
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    document.querySelector('[data-component-action="add"]')?.addEventListener('click', replace)
    return drawn
  }

  it('stops the remaining steps where the column switched to another entry after one ran', async () => {
    const drawn = drawAndSwitch(() => {
      document.querySelector('[data-content-surface-selected]')
        ?.setAttribute('data-content-surface-entry', 'component other')
    })
    const report = await run(args([
      { action: 'click', key: 'add' },
      { action: 'set', name: 'zh_label', value: 'X' },
      { action: 'click', key: 'add' },
    ]), drawn)
    // The step aimed at a control the entry declares is refused rather than
    // run in the entry that took its place, and the write it would have made
    // beside it never happens.
    expect(report.status).toBe('failed')
    expect(report.steps).toEqual([
      { index: 1, status: 'ok' },
      { index: 2, status: 'failed', message: 'The entry in front is "other", not the one this call named.' },
      { index: 3, status: 'skipped' },
    ])
    expect((document.querySelector('[data-component-field="zh_label"]') as HTMLInputElement).value).toBe('')
  })

  it('fails a wait the entry that took this one\'s place would have satisfied', async () => {
    // One kind's entries share the element they are drawn in, so the entry
    // the column switches to can draw the very control the step waits for.
    document.body.innerHTML = COLUMN
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    setTimeout(() => {
      document.querySelector('[data-content-surface-selected]')?.setAttribute('data-content-surface-entry', 'component other')
      drawn.container.insertAdjacentHTML('beforeend', '<button data-component-action="later">Later</button>')
    }, 60)
    const report = await run(args([{ action: 'wait', key: 'later', timeoutMs: 1000 }, { action: 'click', key: 'later' }]), drawn)
    expect(report.steps).toEqual([
      { index: 1, status: 'failed', message: 'The entry in front is "other", not the one this call named.' },
      { index: 2, status: 'skipped' },
    ])
  })

  it('stops the remaining steps where the same entry was redrawn into a new element', async () => {
    const drawn = drawAndSwitch(() => {
      const fresh = document.createElement('div')
      fresh.setAttribute('data-component-surface', '')
      document.querySelector('[data-content-surface-seat="component"][data-content-surface-active] [data-component-surface]')
        ?.replaceWith(fresh)
    })
    const report = await run(args([
      { action: 'click', key: 'add' },
      { action: 'set', name: 'zh_label', value: 'X' },
    ]), drawn)
    expect(report.steps).toEqual([
      { index: 1, status: 'ok' },
      { index: 2, status: 'failed', message: 'The entry was redrawn while this call was running.' },
    ])
  })

  it('stops the remaining steps where no component entry is in front any more', async () => {
    const drawn = drawAndSwitch(() => {
      document.querySelector('[data-content-surface-seat="component"][data-content-surface-active]')
        ?.removeAttribute('data-content-surface-active')
    })
    const report = await run(args([
      { action: 'click', key: 'add' },
      { action: 'set', name: 'zh_label', value: 'X' },
    ]), drawn)
    expect(report.steps).toEqual([
      { index: 1, status: 'ok' },
      { index: 2, status: 'failed', message: 'No component entry is in front, so there is nothing to act on.' },
    ])
  })
})

describe('a press the control itself refuses', () => {
  it('refuses a disabled control and an aria-disabled one, and presses neither', async () => {
    const drawn = drawEntry(`
      <button data-component-action="save" disabled>Save</button>
      <div data-component-action="discard" aria-disabled="true">Discard</div>
    `)
    const saved = vi.fn()
    const discarded = vi.fn()
    document.querySelector('[data-component-action="save"]')?.addEventListener('click', saved)
    document.querySelector('[data-component-action="discard"]')?.addEventListener('click', discarded)
    expect(await run(args([{ action: 'click', key: 'save' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'control "save" is disabled.' }],
      text: 'Acted on the component entry "Demo" (demo).\n- click on "save": control "save" is disabled.',
    })
    expect(await run(args([{ action: 'click', key: 'discard' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'control "discard" is disabled.' }],
      text: 'Acted on the component entry "Demo" (demo).\n- click on "discard": control "discard" is disabled.',
    })
    expect(saved).not.toHaveBeenCalled()
    expect(discarded).not.toHaveBeenCalled()
  })

  it('refuses a control an ancestor fieldset disabled, which carries no attribute of its own', async () => {
    // The platform disables everything inside a disabled fieldset while leaving
    // the controls' own `disabled` attributes unset, so a press that reads only
    // the attribute would report a step the browser never let run.
    const drawn = drawEntry('<fieldset disabled><button data-component-action="save">Save</button></fieldset>')
    const saved = vi.fn()
    document.querySelector('[data-component-action="save"]')?.addEventListener('click', saved)
    expect(await run(args([{ action: 'click', key: 'save' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'control "save" is disabled.' }],
      text: 'Acted on the component entry "Demo" (demo).\n- click on "save": control "save" is disabled.',
    })
    expect(saved).not.toHaveBeenCalled()
  })

  it('refuses a covered control and presses one the document\'s hit test reaches', async () => {
    const drawn = drawEntry('<button data-component-action="go"><span id="label">Go</span></button><span id="over">cover</span>')
    const button = document.querySelector('[data-component-action="go"]') as HTMLElement
    const inner = document.querySelector('#label') as HTMLElement
    const over = document.querySelector('#over') as HTMLElement
    const pressed = vi.fn()
    button.addEventListener('click', pressed)
    button.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 40, height: 10, right: 50, bottom: 30, x: 10, y: 20, toJSON: () => ({}),
    })
    hit = () => over
    expect(await run(args([{ action: 'click', key: 'go' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'control "go" is covered where it is drawn.' }],
      text: 'Acted on the component entry "Demo" (demo).\n- click on "go": control "go" is covered where it is drawn.',
    })
    expect(pressed).not.toHaveBeenCalled()
    // Something inside the control reaches it, and so does the point the
    // document reports no element for: neither is something drawn over it.
    hit = () => inner
    expect((await run(args([{ action: 'click', key: 'go' }]), drawn)).status).toBe('done')
    expect(pressed).toHaveBeenCalledTimes(1)
    hit = () => null
    expect((await run(args([{ action: 'click', key: 'go' }]), drawn)).status).toBe('done')
    expect(pressed).toHaveBeenCalledTimes(2)
  })

  it('reaches a table control through the copy the fixed-column layer draws of it', () => {
    // One drawn column, drawn the way element-ui draws a fixed one: a body
    // wrapper a person scrolls, and a fixed layer standing over it as a second
    // copy of the same cell and the same heading. The copy is what the point
    // over the control's centre hits, and it is the same control reached twice.
    // The hit test is asked directly: with both drawings marked, a step naming
    // the action names two drawn controls and is refused before any point is
    // tested, which is why component-kit marks only the drawing el-table does
    // not hide.
    drawEntry(`
      <div data-component-node="grid" class="el-table">
        <div class="el-table__header-wrapper"><table class="el-table__header"><thead><tr>
          <th data-component-action="sort"><i class="sort-caret"></i></th>
        </tr></thead></table></div>
        <div class="el-table__body-wrapper"><table class="el-table__body"><tbody><tr>
          <td data-component-action="cell-click"><div class="cell" id="own-cell">row</div></td>
        </tr></tbody></table></div>
        <div class="el-table__fixed">
          <div class="el-table__fixed-header-wrapper"><table class="el-table__header"><thead><tr>
            <th data-component-action="sort"><i class="sort-caret"></i></th>
          </tr></thead></table></div>
          <div class="el-table__fixed-body-wrapper"><table class="el-table__body"><tbody><tr>
            <td data-component-action="cell-click"><div class="cell" id="copy-cell">row</div></td>
          </tr></tbody></table></div>
        </div>
      </div>
    `)
    const cell = document.querySelector('.el-table__body-wrapper td') as HTMLElement
    const heading = document.querySelector('.el-table__header-wrapper th') as HTMLElement
    const copyOfCell = document.querySelector('#copy-cell') as HTMLElement
    const copyOfCaret = document.querySelector('.el-table__fixed-header-wrapper .sort-caret') as HTMLElement
    for (const el of [cell, heading]) {
      el.getBoundingClientRect = () => ({
        left: 10, top: 20, width: 40, height: 10, right: 50, bottom: 30, x: 10, y: 20, toJSON: () => ({}),
      })
    }
    // The point over the cell's centre is held by the copy, and the point
    // over the heading's by the caret the fixed header draws.
    hit = () => copyOfCell
    expect(isCovered(cell)).toBe(false)
    hit = () => copyOfCaret
    expect(isCovered(heading)).toBe(false)
  })

  it('refuses a point held by another control of the same action, which is no copy of this one', () => {
    // Copying is what a block does to ONE control: the row's operation links
    // all declare the same action and each carries its own key, so a link
    // holding the point over another link is a different operation rather
    // than the same one reached twice. The hit test is asked directly, because
    // a step naming `keep` in this block names two drawn controls and is
    // refused before any point is tested.
    drawEntry(`
      <div data-component-node="grid">
        <a id="keep" data-component-action="operation" data-component-key="keep" href="#">Keep</a>
        <a id="drop" data-component-action="operation" data-component-key="drop" href="#">Drop</a>
        <div id="row-holder" data-component-action="operation" data-component-key="keep"><div class="cell" id="row-cell">row</div></div>
      </div>
    `)
    const keep = document.querySelector('#keep') as HTMLElement
    keep.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 40, height: 10, right: 50, bottom: 30, x: 10, y: 20, toJSON: () => ({}),
    })
    // The other operation's own link holds the point, and so does an element
    // declaring this key on another kind of element: neither is a second
    // drawing of this control.
    hit = () => document.querySelector('#drop')
    expect(isCovered(keep)).toBe(true)
    hit = () => document.querySelector('#row-cell')
    expect(isCovered(keep)).toBe(true)
  })

  it('refuses a copy drawn by another block, which is no drawing of this control', async () => {
    const drawn = drawEntry(`
      <div data-component-node="grid-a">
        <table><tbody><tr><td data-component-action="cell-click"><div class="cell" id="own-a">row</div></td></tr></tbody></table>
      </div>
      <div data-component-node="grid-b">
        <table><tbody><tr><td data-component-action="cell-click"><div class="cell" id="copy-b">row</div></td></tr></tbody></table>
      </div>
    `)
    const cell = document.querySelector('[data-component-node="grid-a"] td') as HTMLElement
    const pressed = vi.fn()
    cell.addEventListener('click', pressed)
    cell.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 40, height: 10, right: 50, bottom: 30, x: 10, y: 20, toJSON: () => ({}),
    })
    hit = () => document.querySelector('#copy-b')
    expect((await run(args([{ action: 'click', node: 'grid-a', key: 'cell-click' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'control "cell-click" is covered where it is drawn.',
    }])
    expect(pressed).not.toHaveBeenCalled()
  })

  it('refuses a table control something unrelated is drawn over', async () => {
    const drawn = drawEntry(`
      <div data-component-node="grid" class="el-table">
        <div class="el-table__body-wrapper"><table class="el-table__body"><tbody><tr>
          <td data-component-action="cell-click"><div class="cell">row</div></td>
        </tr></tbody></table></div>
        <div class="el-table__fixed"><div class="el-table__fixed-body-wrapper"><table class="el-table__body"><tbody><tr>
          <td class="is-hidden"><div class="cell">row</div></td>
        </tr></tbody></table></div></div>
        <button data-component-key="only">Only a key</button>
        <div id="mask">cover</div>
      </div>
    `)
    const cell = document.querySelector('.el-table__body-wrapper td') as HTMLElement
    const only = document.querySelector('[data-component-key="only"]') as HTMLElement
    const pressed = vi.fn()
    const pressedOnly = vi.fn()
    cell.addEventListener('click', pressed)
    only.addEventListener('click', pressedOnly)
    for (const el of [cell, only]) {
      el.getBoundingClientRect = () => ({
        left: 10, top: 20, width: 40, height: 10, right: 50, bottom: 30, x: 10, y: 20, toJSON: () => ({}),
      })
    }
    hit = () => document.querySelector('#mask')
    expect((await run(args([{ action: 'click', key: 'cell-click' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'control "cell-click" is covered where it is drawn.',
    }])
    // A control the block marks by its own key alone is covered the same
    // way: nothing on the point carries an action that could be its copy.
    expect((await run(args([{ action: 'click', key: 'only' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'control "only" is covered where it is drawn.',
    }])
    expect(pressed).not.toHaveBeenCalled()
    expect(pressedOnly).not.toHaveBeenCalled()
  })

  it('reaches a control through the label that carries it', async () => {
    const drawn = drawEntry('<label><input type="checkbox" data-component-action="tick"><span id="box">tick</span></label>')
    const input = document.querySelector('input') as HTMLInputElement
    const box = document.querySelector('#box') as HTMLElement
    input.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 12, height: 12, right: 12, bottom: 12, x: 0, y: 0, toJSON: () => ({}),
    })
    let toggled = 0
    input.addEventListener('change', () => { toggled += 1 })
    hit = () => box
    expect((await run(args([{ action: 'click', key: 'tick' }]), drawn)).status).toBe('done')
    expect(toggled).toBe(1)
    expect(input.checked).toBe(true)
  })

  it('asks the hit test about the centre of the control, where a person\'s click would land', async () => {
    const drawn = drawEntry('<button data-component-action="go">Go</button><span id="over">cover</span>')
    const button = document.querySelector('[data-component-action="go"]') as HTMLElement
    const over = document.querySelector('#over') as HTMLElement
    const pressed = vi.fn()
    button.addEventListener('click', pressed)
    button.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 40, height: 10, right: 50, bottom: 30, x: 10, y: 20, toJSON: () => ({}),
    })
    // The overlay holds one point of the control and one only: its centre, the
    // point the step's press would land on. Any other point the test is asked
    // about answers the control itself, so a press that probes somewhere else
    // reads as reachable and reports a step this case refuses.
    hit = (x, y) => (x === 30 && y === 25 ? over : button)
    expect((await run(args([{ action: 'click', key: 'go' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'control "go" is covered where it is drawn.',
    }])
    expect(pressed).not.toHaveBeenCalled()
  })

  it('presses a control the document gives no box to test', async () => {
    const drawn = drawEntry('<button data-component-action="flat">Flat</button><span id="over">cover</span>')
    const button = document.querySelector('[data-component-action="flat"]') as HTMLElement
    const over = document.querySelector('#over') as HTMLElement
    const pressed = vi.fn()
    button.addEventListener('click', pressed)
    // A box with no width and no height is one drawn at no point, so the hit
    // test below has nothing to say about it even where it names something
    // else — the same rule as a point the test reports no element for.
    button.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) })
    hit = () => over
    expect((await run(args([{ action: 'click', key: 'flat' }]), drawn)).status).toBe('done')
    expect(pressed).toHaveBeenCalledTimes(1)
  })
})

describe('a control the block keeps in the document while it is closed', () => {
  it('presses the drawn copy of a key, not the hidden copy the search meets first', async () => {
    // A page keeps each row's confirmation bubble in the document while it is
    // closed, and those hidden copies come before the one bubble a person
    // opened: a press taking the first match would press the element nobody
    // sees while the control the user is looking at is never pressed.
    const drawn = drawEntry(`
      <div hidden><button data-component-action="deleted">Confirm</button></div>
      <button data-component-action="deleted">Confirm</button>
    `)
    const [hidden, shown] = [...document.querySelectorAll('[data-component-action="deleted"]')] as HTMLElement[]
    const pressedHidden = vi.fn()
    const pressedShown = vi.fn()
    hidden?.addEventListener('click', pressedHidden)
    shown?.addEventListener('click', pressedShown)
    expect((await run(args([{ action: 'click', key: 'deleted' }]), drawn)).status).toBe('done')
    expect(pressedShown).toHaveBeenCalledTimes(1)
    expect(pressedHidden).not.toHaveBeenCalled()
  })

  it('refuses a key every control carrying it is undrawn, naming what stopped it', async () => {
    const drawn = drawEntry('<div style="display: none"><button data-component-action="deleted">Confirm</button></div>')
    const pressed = vi.fn()
    document.querySelector('[data-component-action="deleted"]')?.addEventListener('click', pressed)
    expect(await run(args([{ action: 'click', key: 'deleted' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{
        index: 1,
        status: 'failed',
        message: 'control "deleted" is not drawn, so this call cannot press it.',
      }],
      text: 'Acted on the component entry "Demo" (demo).'
        + '\n- click on "deleted": control "deleted" is not drawn, so this call cannot press it.',
    })
    expect(pressed).not.toHaveBeenCalled()
  })

  it('carries the same refusal for a key only an undrawn control of its own declares', async () => {
    const drawn = drawEntry('<div hidden><a data-component-key="keep" href="#">Keep</a></div>')
    expect(await run(args([{ action: 'click', key: 'keep' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{
        index: 1,
        status: 'failed',
        message: 'control "keep" is not drawn, so this call cannot press it.',
      }],
      text: 'Acted on the component entry "Demo" (demo).'
        + '\n- click on "keep": control "keep" is not drawn, so this call cannot press it.',
    })
  })
})

describe('the step after a press', () => {
  it('resolves what the press drew rather than the copy that stood there before the block rendered', async () => {
    // The block draws on its own turn — React and Vue alike arrange a render
    // for after the handler returns — so the write a call places right after
    // the press that opened a dialog must be resolved once that render landed.
    // Resolved earlier it finds the same-named control standing outside the
    // dialog, writes that, and reports a write the dialog never took.
    const drawn = drawEntry(`
      <input data-component-field="zh_label" id="query">
      <button data-component-action="add">Add</button>
    `)
    document.querySelector('[data-component-action="add"]')?.addEventListener('click', () => {
      setTimeout(() => {
        const dialog = document.createElement('div')
        dialog.className = 'el-dialog__wrapper'
        const inside = document.createElement('div')
        inside.setAttribute('role', 'dialog')
        const input = document.createElement('input')
        input.setAttribute('data-component-field', 'zh_label')
        input.id = 'dialog-input'
        inside.append(input)
        dialog.append(inside)
        document.querySelector('[data-component-surface]')?.append(dialog)
      }, 0)
    })
    const report = await run(args([
      { action: 'click', key: 'add' },
      { action: 'set', name: 'zh_label', value: 'X' },
    ]), drawn)
    expect(report.status).toBe('done')
    expect((document.querySelector('#dialog-input') as HTMLInputElement).value).toBe('X')
    expect((document.querySelector('#query') as HTMLInputElement).value).toBe('')
  })
})

describe('the key one control declares for itself', () => {
  it('reads a step\'s key as an action first, so a control carrying it as its own key does not shadow one that declares it', async () => {
    // One step names one key, and both alphabets may hold it: a component may
    // declare an action called `go` and draw a control whose own key is also
    // `go`. The action's control is the one the step means — the key the block
    // declares as an action is what a call addresses — and it wins wherever the
    // control carrying the key as its own name was drawn first.
    const drawn = drawEntry(`
      <button data-component-key="go">By key</button>
      <button data-component-action="go">By action</button>
    `)
    // The entry's own two buttons: the console's switcher draws one beside them.
    const [byKey, byAction] = [...document.querySelectorAll('[data-component-surface] button')]
    const pressedKey = vi.fn()
    const pressedAction = vi.fn()
    byKey?.addEventListener('click', pressedKey)
    byAction?.addEventListener('click', pressedAction)
    expect((await run(args([{ action: 'click', key: 'go' }]), drawn)).status).toBe('done')
    expect(pressedAction).toHaveBeenCalledTimes(1)
    expect(pressedKey).not.toHaveBeenCalled()
  })

  it('presses the control a step names by its own key, and refuses the action several drawn controls share', async () => {
    const drawn = drawEntry(`
      <div data-component-node="bar">
        <button data-component-action="press" data-component-key="ok">OK</button>
        <button data-component-action="press" data-component-key="no">No</button>
      </div>
    `)
    const buttons = [...document.querySelectorAll('button[data-component-action]')]
    const pressed = buttons.map(() => vi.fn())
    buttons.forEach((button, at) => { button.addEventListener('click', pressed[at] as () => void) })
    // The action alone does not say which button the step means, so none is
    // pressed and the sentence lists the keys that would.
    expect(await run(args([{ action: 'click', key: 'press' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{
        index: 1,
        status: 'failed',
        message: 'action "press" names 2 drawn controls in the entry; name the one to press by its own key: ok, no.',
      }],
      text: 'Acted on the component entry "Demo" (demo).\n- click on "press": '
        + 'action "press" names 2 drawn controls in the entry; name the one to press by its own key: ok, no.',
    })
    expect((await run(args([{ action: 'click', node: 'bar', key: 'press' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'action "press" names 2 drawn controls in block "bar"; name the one to press by its own key: ok, no.',
    }])
    expect(pressed[0]).not.toHaveBeenCalled()
    expect(pressed[1]).not.toHaveBeenCalled()
    expect((await run(args([{ action: 'click', key: 'no' }]), drawn)).status).toBe('done')
    expect(pressed[1]).toHaveBeenCalledTimes(1)
    expect(pressed[0]).not.toHaveBeenCalled()
  })

  it('presses the one drawn control an action key names where its sharers are undrawn', async () => {
    const drawn = drawEntry(`
      <button data-component-action="press" data-component-key="ok" hidden>OK</button>
      <button data-component-action="press" data-component-key="no">No</button>
    `)
    const shown = document.querySelector('[data-component-key="no"]') as HTMLElement
    const pressed = vi.fn()
    shown.addEventListener('click', pressed)
    expect((await run(args([{ action: 'click', key: 'press' }]), drawn)).status).toBe('done')
    expect(pressed).toHaveBeenCalledTimes(1)
  })

  it('refuses an action several drawn controls share where their own keys do not tell them apart', async () => {
    // One cell per row, every one declaring the same action: no key names a
    // row, so the step is refused rather than pressing the first row.
    const unkeyed = drawEntry(`
      <table><tbody>
        <tr><td data-component-action="cell-click">a</td></tr>
        <tr><td data-component-action="cell-click">b</td></tr>
        <tr><td data-component-action="cell-click">c</td></tr>
      </tbody></table>
    `)
    const clicked = vi.fn()
    for (const cell of document.querySelectorAll('td')) cell.addEventListener('click', clicked)
    expect((await run(args([{ action: 'click', key: 'cell-click' }]), unkeyed)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'action "cell-click" names 3 drawn controls in the entry, and no step can name each of them by an own key.',
    }])
    expect(clicked).not.toHaveBeenCalled()
    // Drawn in one block instead of none, they are still one place to look:
    // the sentence stays the unlisted one rather than counting blocks.
    const blocked = drawEntry(`
      <div data-component-node="page-1">
        <table><tbody>
          <tr><td data-component-action="cell-click">a</td></tr>
          <tr><td data-component-action="cell-click">b</td></tr>
          <tr><td data-component-action="cell-click">c</td></tr>
        </tbody></table>
      </div>
    `)
    const refused = (await run(args([{ action: 'click', key: 'cell-click' }]), blocked)).steps
    expect(refused).toEqual([{
      index: 1,
      status: 'failed',
      message: 'action "cell-click" names 3 drawn controls in the entry, and no step can name each of them by an own key.',
    }])
    expect(refused[0]?.status === 'failed' ? refused[0].message : '').not.toContain('blocks of the entry')
    // Own keys that repeat, and one a step could not name, tell them apart no
    // better than none.
    for (const keys of [['modify', 'modify'], ['keep', 'a b']]) {
      const drawn = drawEntry(keys.map(key => `<a data-component-action="operation" data-component-key="${key}">x</a>`).join(''))
      expect((await run(args([{ action: 'click', key: 'operation' }]), drawn)).steps).toEqual([{
        index: 1,
        status: 'failed',
        message: 'action "operation" names 2 drawn controls in the entry, and no step can name each of them by an own key.',
      }])
    }
  })

  it('refuses an own key several drawn controls carry, which no step can tell apart', async () => {
    // Every row's modify link carries the same own key, which is the block's
    // markup rather than anything the step could have written differently.
    const drawn = drawEntry(`
      <div data-component-node="grid">
        <a data-component-action="operation" data-component-key="modify">Modify</a>
        <a data-component-action="operation" data-component-key="modify">Modify</a>
        <a data-component-action="operation" data-component-key="modify">Modify</a>
      </div>
    `)
    const pressed = vi.fn()
    for (const link of document.querySelectorAll('a')) link.addEventListener('click', pressed)
    expect(await run(args([{ action: 'click', key: 'modify' }]), drawn)).toEqual({
      status: 'failed',
      steps: [{
        index: 1,
        status: 'failed',
        message: 'own key "modify" is carried by 3 drawn controls in the entry, so no step can tell them apart.',
      }],
      text: 'Acted on the component entry "Demo" (demo).\n- click on "modify": '
        + 'own key "modify" is carried by 3 drawn controls in the entry, so no step can tell them apart.',
    })
    expect((await run(args([{ action: 'click', node: 'grid', key: 'modify' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'own key "modify" is carried by 3 drawn controls in block "grid", so no step can tell them apart.',
    }])
    expect(pressed).not.toHaveBeenCalled()
  })

  it('names the blocks a key\'s controls are drawn in where naming one of them looks at fewer', async () => {
    // Two confirmation bars, each drawing the same two buttons: no own key
    // tells the four apart, and a block does.
    const drawn = drawEntry(['bar1', 'bar2'].map(bar => `
      <div data-component-node="${bar}">
        <button data-component-action="press" data-component-key="approve">Approve</button>
        <button data-component-action="press" data-component-key="reject">Reject</button>
      </div>
    `).join(''))
    const pressed: string[] = []
    for (const button of document.querySelectorAll('button')) {
      const named = `${String(button.parentElement?.getAttribute('data-component-node'))}/${String(button.getAttribute('data-component-key'))}`
      button.addEventListener('click', () => { pressed.push(named) })
    }
    expect((await run(args([{ action: 'click', key: 'approve' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'own key "approve" is carried by 2 drawn controls in 2 blocks of the entry: bar1, bar2; '
        + 'name one of them as `node` to look in that block alone.',
    }])
    expect((await run(args([{ action: 'click', key: 'press' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'action "press" names 4 drawn controls in 2 blocks of the entry: bar1, bar2; '
        + 'name one of them as `node` to look in that block alone.',
    }])
    expect(pressed).toEqual([])
    // Within one block the action still names two buttons, which their own keys tell apart.
    expect((await run(args([{ action: 'click', node: 'bar1', key: 'press' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'action "press" names 2 drawn controls in block "bar1"; name the one to press by its own key: approve, reject.',
    }])
    expect((await run(args([{ action: 'click', node: 'bar2', key: 'approve' }]), drawn)).status).toBe('done')
    expect(pressed).toEqual(['bar2/approve'])
  })

  it('lists the blocks a step can name where others carry ids no step can, and counts those', async () => {
    // "bar 2" carries a space, which no target name admits, so a `node` could
    // never name that block; "bar1" still can, and naming it looks at fewer.
    const drawn = drawEntry(['bar1', 'bar 2'].map(bar => `
      <div data-component-node="${bar}">
        <button data-component-action="press" data-component-key="approve">Approve</button>
      </div>
    `).join(''))
    const pressed: string[] = []
    for (const button of document.querySelectorAll('button')) {
      const named = String(button.parentElement?.getAttribute('data-component-node'))
      button.addEventListener('click', () => { pressed.push(named) })
    }
    expect((await run(args([{ action: 'click', key: 'approve' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'own key "approve" is carried by 2 drawn controls in the entry, 1 of them in a block whose id no step can name; '
        + 'the rest are in block bar1; name it as `node` to look in that block alone.',
    }])
    expect((await run(args([{ action: 'click', node: 'bar1', key: 'approve' }]), drawn)).status).toBe('done')
    expect(pressed).toEqual(['bar1'])

    // An id past the length a step's name may reach is no more nameable, and
    // listing it would carry the sentence past what a host reads.
    const long = drawEntry(`
      <div data-component-node="${'x'.repeat(600)}">
        <button data-component-action="press" data-component-key="approve">Approve</button>
      </div>
      <div data-component-node="bar1">
        <button data-component-action="press" data-component-key="approve">Approve</button>
      </div>
    `)
    const [result] = (await run(args([{ action: 'click', key: 'approve' }]), long)).steps
    const message = result?.status === 'failed' ? result.message : ''
    expect(message).not.toContain('x'.repeat(65))
    expect(message).toContain('the rest are in block bar1')
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)

    // Where no block of them is one a step can name, no `node` helps, and the
    // sentence says no step tells them apart.
    const unnamed = drawEntry(`
      <div data-component-node="bar 1"><button data-component-action="press" data-component-key="approve">A</button></div>
      <button data-component-action="press" data-component-key="approve">B</button>
    `)
    expect((await run(args([{ action: 'click', key: 'approve' }]), unnamed)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'own key "approve" is carried by 2 drawn controls in the entry, so no step can tell them apart.',
    }])
  })

  it('counts the controls outside every block beside the blocks a `node` names', async () => {
    // Two bars and one loose button carry the same own key: naming a bar looks
    // at that bar's button alone, and the count says one more stands outside.
    const drawn = drawEntry(`
      ${['bar1', 'bar2'].map(bar => `<div data-component-node="${bar}"><button data-component-key="approve">A</button></div>`).join('')}
      <button data-component-key="approve">Loose</button>
    `)
    const pressed: string[] = []
    for (const button of document.querySelectorAll('[data-component-surface] button')) {
      const named = button.parentElement?.getAttribute('data-component-node') ?? 'loose'
      button.addEventListener('click', () => { pressed.push(named) })
    }
    expect((await run(args([{ action: 'click', key: 'approve' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'own key "approve" is carried by 3 drawn controls in the entry, 1 of them outside every block; '
        + 'the rest are in 2 blocks: bar1, bar2; name one of them as `node` to look in that block alone.',
    }])
    expect((await run(args([{ action: 'click', node: 'bar2', key: 'approve' }]), drawn)).status).toBe('done')
    // One block and one loose control: naming the block still looks at fewer.
    const one = drawEntry(`
      <div data-component-node="bar1"><button data-component-key="approve">A</button></div>
      <button data-component-key="approve">Loose</button>
    `)
    expect((await run(args([{ action: 'click', key: 'approve' }]), one)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'own key "approve" is carried by 2 drawn controls in the entry, 1 of them outside every block; '
        + 'the rest are in block bar1; name it as `node` to look in that block alone.',
    }])
    expect(pressed).toEqual(['bar2'])
  })

  it('means the controls a named block draws itself before those of a block drawn inside it', async () => {
    // A bar with a nested bar: the outer bar's own button and the inner bar's
    // carry one own key. Naming either block is what tells them apart.
    const drawn = drawEntry(`
      <div data-component-node="outer">
        <button data-component-action="press" data-component-key="approve">Outer</button>
        <div data-component-node="inner">
          <button data-component-action="press" data-component-key="approve">Inner</button>
        </div>
      </div>
    `)
    const pressed: string[] = []
    for (const button of document.querySelectorAll('[data-component-surface] button')) {
      const words = button.textContent
      button.addEventListener('click', () => { pressed.push(words) })
    }
    expect((await run(args([{ action: 'click', key: 'approve' }]), drawn)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'own key "approve" is carried by 2 drawn controls in 2 blocks of the entry: outer, inner; '
        + 'name one of them as `node` to look in that block alone.',
    }])
    expect((await run(args([{ action: 'click', node: 'outer', key: 'approve' }]), drawn)).status).toBe('done')
    expect((await run(args([{ action: 'click', node: 'inner', key: 'approve' }]), drawn)).status).toBe('done')
    expect(pressed).toEqual(['Outer', 'Inner'])
    // A block that draws none of them itself names the blocks inside it, as inside it.
    const holding = drawEntry(`
      <div data-component-node="outer">
        ${['bar1', 'bar2'].map(bar => `<div data-component-node="${bar}"><button data-component-action="press" data-component-key="approve">A</button><button data-component-action="press" data-component-key="reject">R</button></div>`).join('')}
      </div>
    `)
    expect((await run(args([{ action: 'click', node: 'outer', key: 'press' }]), holding)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'action "press" names 4 drawn controls in 2 blocks inside block "outer": bar1, bar2; '
        + 'name one of them as `node` to look in that block alone.',
    }])
  })

  it('lists at most ten own keys, and fewer where the sentence would pass the report bound', async () => {
    const twelve = Array.from({ length: 12 }, (_, at) => `k${String(at + 1)}`)
    const many = drawEntry(twelve.map(key => `<button data-component-action="locate" data-component-key="${key}">x</button>`).join(''))
    expect((await run(args([{ action: 'click', key: 'locate' }]), many)).steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'action "locate" names 12 drawn controls in the entry; name the one to press by its own key: '
        + 'k1, k2, k3, k4, k5, k6, k7, k8, k9, k10 and 2 more.',
    }])
    // Own keys as long as a step's key may be: ten of them would carry the
    // sentence past what a host reads one step's sentence as.
    const long = Array.from({ length: 10 }, (_, at) => `${String(at)}${'k'.repeat(63)}`)
    const wide = drawEntry(long.map(key => `<button data-component-action="locate" data-component-key="${key}">x</button>`).join(''))
    const [result] = (await run(args([{ action: 'click', key: 'locate' }]), wide)).steps
    const message = result?.status === 'failed' ? result.message : ''
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    expect(message.startsWith('action "locate" names 10 drawn controls in the entry; name the one to press by its own key: 0k')).toBe(true)
    expect(message).toMatch(/ and \d+ more\.$/)
    expect(message).toContain(long[0])
    expect(message).not.toContain(long[9])
  })

  it('waits for a key several drawn controls carry, which any one of them satisfies', async () => {
    const drawn = drawEntry(`
      <button data-component-action="press" data-component-key="ok">OK</button>
      <button data-component-action="press" data-component-key="ok">OK</button>
    `)
    expect((await run(args([{ action: 'wait', key: 'press' }, { action: 'wait', key: 'ok' }]), drawn)).status).toBe('done')
  })
})

/**
 * One table of records keyed by row, as a component marks one: each row
 * carries its key, a cell that opens it, and the row's own modify link.
 * @param keys - the row keys, in the order drawn.
 * @returns the markup.
 */
function keyedRows(keys: readonly string[]): string {
  return keys.map(key => `
    <tr data-component-row="${key}">
      <td data-component-action="cell-click">${key}-name</td>
      <td><a data-component-action="operation" data-component-key="modify">修改</a></td>
    </tr>
  `).join('')
}

/**
 * Record which row each pressed control of the entry stood in.
 * @returns the rows pressed, in order.
 */
function pressedRows(): string[] {
  const pressed: string[] = []
  for (const control of document.querySelectorAll('[data-component-surface] [data-component-action]')) {
    const row = control.closest('[data-component-row]')?.getAttribute('data-component-row') ?? 'none'
    const node = control.closest('[data-component-node]')?.getAttribute('data-component-node') ?? 'entry'
    control.addEventListener('click', (event) => {
      // Only the control the press was aimed at: a click bubbles through the row's own cell.
      if (event.currentTarget === event.target) pressed.push(`${node}/${row}/${String(control.getAttribute('data-component-key') ?? control.getAttribute('data-component-action'))}`)
    })
  }
  return pressed
}

/** The step's refusal sentence, or the empty string where it ran. */
async function refusal(call: ActComponentArgs, entry: DrawnEntry): Promise<string> {
  const [step] = (await run(call, entry)).steps
  return step?.status === 'failed' ? step.message : ''
}

describe('a control a table draws once per row', () => {
  const KEYS = ['1134933624650219530', '1134933624650219531', '1134933624650219532']

  it('presses the control of the row the step names, neither the first nor the last', async () => {
    const drawn = drawEntry(`<div data-component-node="grid"><table><tbody>${keyedRows(KEYS)}</tbody></table></div>`)
    const pressed = pressedRows()
    expect((await run(args([{ action: 'click', key: 'modify', row: KEYS[1] as string }]), drawn)).status).toBe('done')
    expect((await run(args([{ action: 'click', node: 'grid', key: 'cell-click', row: KEYS[1] as string }]), drawn)).status).toBe('done')
    expect(pressed).toEqual([`grid/${String(KEYS[1])}/modify`, `grid/${String(KEYS[1])}/cell-click`])
  })

  it('lists the row keys where a step names a control every row draws and no row', async () => {
    const drawn = drawEntry(`<div data-component-node="grid"><table><tbody>${keyedRows(KEYS)}</tbody></table></div>`)
    const pressed = pressedRows()
    expect(await refusal(args([{ action: 'click', key: 'modify' }]), drawn)).toBe(
      'own key "modify" is carried by 3 drawn controls in the entry, one per row; name the row with `row`: '
      + `${KEYS.join(', ')}.`,
    )
    expect(await refusal(args([{ action: 'click', node: 'grid', key: 'cell-click' }]), drawn)).toBe(
      'action "cell-click" names 3 drawn controls in block "grid", one per row; name the row with `row`: '
      + `${KEYS.join(', ')}.`,
    )
    expect(pressed).toEqual([])
  })

  it('says a row is not drawn, and that a drawn row draws no such control, pressing nothing', async () => {
    const drawn = drawEntry(`
      <div data-component-node="grid"><table><tbody>
        ${keyedRows(['1044', '1045'])}
        <tr data-component-row="1046"><td data-component-action="cell-click">1046-name</td></tr>
      </tbody></table></div>
    `)
    const pressed = pressedRows()
    expect(await refusal(args([{ action: 'click', key: 'modify', row: '9999' }]), drawn)).toBe('row "9999" is not drawn in the entry.')
    expect(await refusal(args([{ action: 'click', node: 'grid', key: 'modify', row: '9999' }]), drawn))
      .toBe('row "9999" is not drawn in block "grid".')
    expect(await refusal(args([{ action: 'click', node: 'grid', key: 'modify', row: '1046' }]), drawn))
      .toBe('row "1046" draws no control "modify" in block "grid".')
    // A key nothing draws is refused for the key, whichever row the step names.
    expect(await refusal(args([{ action: 'click', key: 'ghost', row: '1044' }]), drawn)).toBe('control "ghost" is not part of the entry on display.')
    // A row is drawn only where a person could see it.
    document.querySelector('[data-component-row="1045"]')?.setAttribute('hidden', '')
    expect(await refusal(args([{ action: 'click', key: 'modify', row: '1045' }]), drawn)).toBe('row "1045" is not drawn in the entry.')
    expect(pressed).toEqual([])
  })

  it('reads the row off every copy a fixed layer draws, pressing the drawn copy of that row', async () => {
    const drawn = drawEntry(`
      <div data-component-node="grid">
        <div class="body"><table><tbody>
          <tr data-component-row="1"><td>甲</td></tr>
          <tr data-component-row="2"><td>乙</td></tr>
        </tbody></table></div>
        <div class="fixed"><table><tbody>
          <tr data-component-row="1"><td><span><a data-component-action="card-open" data-component-key="zh_label">甲</a></span></td></tr>
          <tr data-component-row="2"><td><span><a data-component-action="card-open" data-component-key="zh_label">乙</a></span></td></tr>
        </tbody></table></div>
      </div>
    `)
    const pressed = pressedRows()
    expect((await run(args([{ action: 'click', key: 'card-open', row: '2' }]), drawn)).status).toBe('done')
    expect(pressed).toEqual(['grid/2/zh_label'])
  })

  it('names the rows before the own keys, and says what a row drawing several still needs', async () => {
    // Each row draws its name link and a relation link: one action, an own key
    // per column. The row narrows first, and the own key then names the link.
    const drawn = drawEntry(`
      <div data-component-node="page"><table><tbody>
        ${['1044', '1045'].map(key => `<tr data-component-row="${key}">
          <td><a data-component-action="card-open" data-component-key="zh_label">${key}</a></td>
          <td><a data-component-action="card-open" data-component-key="region">华北</a></td>
        </tr>`).join('')}
      </tbody></table></div>
    `)
    const pressed = pressedRows()
    expect(await refusal(args([{ action: 'click', key: 'card-open' }]), drawn)).toBe(
      'action "card-open" names 4 drawn controls in the entry across 2 rows; name the row with `row`: 1044, 1045; '
      + 'a row draws more than one of them, so name the one to press by its own key with `row`.',
    )
    expect(await refusal(args([{ action: 'click', key: 'card-open', row: '1045' }]), drawn)).toBe(
      'action "card-open" names 2 drawn controls of row "1045" in the entry; name the one to press by its own key: zh_label, region.',
    )
    expect(await refusal(args([{ action: 'click', key: 'region' }]), drawn)).toBe(
      'own key "region" is carried by 2 drawn controls in the entry, one per row; name the row with `row`: 1044, 1045.',
    )
    expect((await run(args([{ action: 'click', key: 'region', row: '1045' }]), drawn)).status).toBe('done')
    expect(pressed).toEqual(['page/1045/region'])
  })

  it('names the rows where own keys would also tell the controls apart, since a row is what a reading lists', async () => {
    const drawn = drawEntry(`<table><tbody>
      <tr data-component-row="1"><td><a data-component-action="locate" data-component-key="k1">x</a></td></tr>
      <tr data-component-row="2"><td><a data-component-action="locate" data-component-key="k2">x</a></td></tr>
    </tbody></table>`)
    expect(await refusal(args([{ action: 'click', key: 'locate' }]), drawn)).toBe(
      'action "locate" names 2 drawn controls in the entry, one per row; name the row with `row`: 1, 2.',
    )
  })

  it('says no step tells apart two controls one row draws alike, and counts the ones in no row', async () => {
    const drawn = drawEntry(`
      <button data-component-action="cell-click">toolbar</button>
      <table><tbody>
        <tr data-component-row="1"><td data-component-action="cell-click">a</td><td data-component-action="cell-click">b</td></tr>
        <tr data-component-row="2"><td data-component-action="cell-click">c</td><td data-component-action="cell-click">d</td></tr>
        <tr data-component-row="a b"><td data-component-action="cell-click">e</td></tr>
      </tbody></table>
    `)
    expect(await refusal(args([{ action: 'click', key: 'cell-click' }]), drawn)).toBe(
      'action "cell-click" names 6 drawn controls in the entry across 2 rows; name the row with `row`: 1, 2; '
      + 'a row draws more than one of them, and no step can tell those apart; 2 of them are drawn in no row a step can name.',
    )
    expect(await refusal(args([{ action: 'click', key: 'cell-click', row: '1' }]), drawn)).toBe(
      'action "cell-click" names 2 drawn controls of row "1" in the entry, and no step can name each of them by an own key.',
    )
    // Every control in one row: naming the row looks at no fewer, so the row is not offered.
    const single = drawEntry(`<table><tbody>
      <tr data-component-row="1"><td data-component-action="cell-click">a</td><td data-component-action="cell-click">b</td></tr>
    </tbody></table>`)
    expect(await refusal(args([{ action: 'click', key: 'cell-click' }]), single)).toBe(
      'action "cell-click" names 2 drawn controls in the entry, and no step can name each of them by an own key.',
    )
  })

  it('names the blocks before the rows where two tables key their rows alike', async () => {
    // Two tables keyed by position: row "2" is drawn in both.
    const drawn = drawEntry(['t1', 't2'].map(table => `
      <div data-component-node="${table}"><table><tbody>
        <tr data-component-row="1"><td data-component-action="row-click">${table}-1</td></tr>
        <tr data-component-row="2"><td data-component-action="row-click">${table}-2</td></tr>
      </tbody></table></div>
    `).join(''))
    const pressed = pressedRows()
    expect(await refusal(args([{ action: 'click', key: 'row-click' }]), drawn)).toBe(
      'action "row-click" names 4 drawn controls in 2 blocks of the entry: t1, t2; name one of them as `node` to look in that block alone.',
    )
    expect(await refusal(args([{ action: 'click', key: 'row-click', row: '2' }]), drawn)).toBe(
      'action "row-click" names 2 drawn controls of row "2" in 2 blocks of the entry: t1, t2; name one of them as `node` to look in that block alone.',
    )
    expect((await run(args([{ action: 'click', node: 't2', key: 'row-click', row: '2' }]), drawn)).status).toBe('done')
    expect(pressed).toEqual(['t2/2/row-click'])
  })
})

describe('the step a gesture is reported during', () => {
  it('holds each step while it runs, with its call and its position, and nothing between or after them', async () => {
    const drawn = drawEntry(`
      <button data-component-action="add">Add</button>
      <button data-component-action="save">Save</button>
    `)
    const seen: unknown[] = []
    document.querySelector('[data-component-action="add"]')?.addEventListener('click', () => {
      seen.push(holder.current)
      // A report the block sends once the press returned, as an answer from
      // a backend would arrive: the next step has not started, so nothing is
      // held.
      setTimeout(() => { seen.push(holder.current) }, 0)
    })
    document.querySelector('[data-component-action="save"]')?.addEventListener('click', () => { seen.push(holder.current) })
    expect((await run(args([{ action: 'click', key: 'add' }, { action: 'click', key: 'save' }]), drawn)).status).toBe('done')
    expect(seen).toEqual([
      { entryId: ENTRY, callId: CALL, step: 1 },
      undefined,
      { entryId: ENTRY, callId: CALL, step: 2 },
    ])
    expect(holder.current).toBeUndefined()
  })

  it('holds a set while it writes, so what the write reports is the step\'s', async () => {
    const drawn = drawEntry('<input aria-label="title">')
    const seen: unknown[] = []
    document.querySelector('input')?.addEventListener('change', () => { seen.push(holder.current) })
    expect((await run(args([{ action: 'set', name: 'title', value: 'Q3' }]), drawn)).status).toBe('done')
    expect(seen).toEqual([{ entryId: ENTRY, callId: CALL, step: 1 }])
    expect(holder.current).toBeUndefined()
  })

  it('holds nothing while a wait runs, neither the press before it reports later nor what the user does', async () => {
    const drawn = drawEntry(`
      <button data-component-action="add">Add</button>
      <button data-component-action="reject">Reject</button>
    `)
    const surface = document.querySelector('[data-component-surface]') as HTMLElement
    const seen: Record<string, unknown> = {}
    document.querySelector('[data-component-action="add"]')?.addEventListener('click', () => {
      seen['press'] = holder.current
      // The press's own block answers once a timer fires, which is after the
      // click step returned and while the wait after it runs.
      setTimeout(() => { seen['answer'] = holder.current }, 50)
      // The user presses another control of the entry while the wait runs.
      setTimeout(() => { (document.querySelector('[data-component-action="reject"]') as HTMLElement).click() }, 100)
      // What the wait waits for is drawn after both.
      setTimeout(() => {
        const done = document.createElement('button')
        done.setAttribute('data-component-action', 'done')
        surface.append(done)
      }, 150)
    })
    document.querySelector('[data-component-action="reject"]')?.addEventListener('click', () => { seen['user'] = holder.current })
    const report = await run(args([{ action: 'click', key: 'add' }, { action: 'wait', key: 'done', timeoutMs: 2_000 }]), drawn)
    expect(report.status).toBe('done')
    expect(seen).toEqual({ press: { entryId: ENTRY, callId: CALL, step: 1 }, answer: undefined, user: undefined })
    expect(holder.current).toBeUndefined()
  })

  it('empties the holder when a step fails, and holds nothing for the steps it skips', async () => {
    const drawn = drawEntry('<button data-component-action="add">Add</button>')
    const seen: unknown[] = []
    document.querySelector('[data-component-action="add"]')?.addEventListener('click', () => { seen.push(holder.current) })
    const report = await run(args([{ action: 'click', key: 'gone' }, { action: 'click', key: 'add' }]), drawn)
    expect(report.steps.map(step => step.status)).toEqual(['failed', 'skipped'])
    expect(seen).toEqual([])
    expect(holder.current).toBeUndefined()
  })
})

describe('a control whose id is not an identifier', () => {
  it('reads the label by comparing `for`, and one such control breaks no other write', async () => {
    const drawn = drawEntry(`
      <label for="gone">stale</label>
      <input id="a&quot;b"><label for="a&quot;b">title</label>
      <input id='q"uote'>
      <input aria-label="owner">
    `)
    const [quoted, unlabelled, owner] = [...document.querySelectorAll('input')] as HTMLInputElement[]
    const report = await run(args([
      { action: 'set', name: 'title', value: 'X' },
      { action: 'set', name: 'owner', value: 'Y' },
    ]), drawn)
    expect(report.status).toBe('done')
    expect(quoted?.value).toBe('X')
    expect(unlabelled?.value).toBe('')
    expect(owner?.value).toBe('Y')
  })
})
