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
import { parseActComponentArgs, type ActComponentArgs } from '../src/act-component-call.ts'
import { drawnEntry, type DrawnEntry } from '../src/client/entry-container.ts'
import { runActComponent, type ActComponentRun } from '../src/client/act-executor.ts'

/** The entry id every case here acts on. */
const ENTRY = 'demo'

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
 * Run one call the way the seat does: the entry is read again before every step.
 * @param call - the call's arguments.
 * @param entry - the entry the case drew.
 * @returns what the call ended as.
 */
function run(call: ActComponentArgs, entry: DrawnEntry): Promise<ActComponentRun> {
  return runActComponent(call, entry, () => drawnEntry(document))
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

beforeEach(() => { document.body.innerHTML = '' })

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
      <select data-component-field="kind"><option value="a">a</option><option value="b">b</option></select>
      <textarea data-component-field="note"></textarea>
    `)
    const report = await run(args([
      { action: 'set', name: 'kind', value: 'b' },
      { action: 'set', name: 'note', value: 'hello' },
    ]), drawn)
    expect(report.status).toBe('done')
    expect(document.querySelector('select')?.value).toBe('b')
    expect(document.querySelector('textarea')?.value).toBe('hello')
  })

  it('writes through the element itself when its prototype declares no value accessor', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    const drawn = drawEntry('<input data-component-field="title">')
    try {
      // The prototype accessor is what a controlled component replaces; a DOM
      // implementation without one leaves the step the plain assignment.
      delete (HTMLInputElement.prototype as { value?: unknown }).value
      const report = await run(args([{ action: 'set', name: 'title', value: 'X' }]), drawn)
      expect(report.status).toBe('done')
      expect((document.querySelector('input') as HTMLInputElement).value).toBe('X')
    } finally {
      if (descriptor !== undefined) Object.defineProperty(HTMLInputElement.prototype, 'value', descriptor)
    }
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
    document.body.innerHTML = `${COLUMN}`
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
    document.elementFromPoint = () => over
    try {
      expect(await run(args([{ action: 'click', key: 'go' }]), drawn)).toEqual({
        status: 'failed',
        steps: [{ index: 1, status: 'failed', message: 'control "go" is covered where it is drawn.' }],
        text: 'Acted on the component entry "Demo" (demo).\n- click on "go": control "go" is covered where it is drawn.',
      })
      expect(pressed).not.toHaveBeenCalled()
      // Something inside the control reaches it, and so does the point the
      // document reports no element for: neither is something drawn over it.
      document.elementFromPoint = () => inner
      expect((await run(args([{ action: 'click', key: 'go' }]), drawn)).status).toBe('done')
      expect(pressed).toHaveBeenCalledTimes(1)
      document.elementFromPoint = () => null
      expect((await run(args([{ action: 'click', key: 'go' }]), drawn)).status).toBe('done')
      expect(pressed).toHaveBeenCalledTimes(2)
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
  })

  it('reaches a table control through the copy the fixed-column layer draws of it', async () => {
    // One drawn column, drawn the way element-ui draws a fixed one: a body
    // wrapper a person scrolls, and a fixed layer standing over it as a second
    // copy of the same cell and the same heading. The copy is what the point
    // over the control's centre hits, and it is the same control reached twice
    // — pressing the one the block declared runs what a click there runs.
    const drawn = drawEntry(`
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
    const pressed = vi.fn()
    const sorted = vi.fn()
    cell.addEventListener('click', pressed)
    heading.addEventListener('click', sorted)
    for (const el of [cell, heading]) {
      el.getBoundingClientRect = () => ({
        left: 10, top: 20, width: 40, height: 10, right: 50, bottom: 30, x: 10, y: 20, toJSON: () => ({}),
      })
    }
    try {
      // The point over the cell's centre is held by the copy, and the point
      // over the heading's by the caret the fixed header draws.
      document.elementFromPoint = () => copyOfCell
      expect((await run(args([{ action: 'click', key: 'cell-click' }]), drawn)).status).toBe('done')
      expect(pressed).toHaveBeenCalledTimes(1)
      document.elementFromPoint = () => copyOfCaret
      expect((await run(args([{ action: 'click', key: 'sort' }]), drawn)).status).toBe('done')
      expect(sorted).toHaveBeenCalledTimes(1)
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
  })

  it('refuses a point held by another control of the same action, which is no copy of this one', async () => {
    // Copying is what a block does to ONE control: the row's operation links
    // all declare the same action and each carries its own key, so a link
    // holding the point over another link is a different operation rather
    // than the same one reached twice.
    const drawn = drawEntry(`
      <div data-component-node="grid">
        <a id="keep" data-component-action="operation" data-component-key="keep" href="#">Keep</a>
        <a id="drop" data-component-action="operation" data-component-key="drop" href="#">Drop</a>
        <div id="row-holder" data-component-action="operation" data-component-key="keep"><div class="cell" id="row-cell">row</div></div>
      </div>
    `)
    const keep = document.querySelector('#keep') as HTMLElement
    const dropped = vi.fn()
    keep.addEventListener('click', dropped)
    keep.getBoundingClientRect = () => ({
      left: 10, top: 20, width: 40, height: 10, right: 50, bottom: 30, x: 10, y: 20, toJSON: () => ({}),
    })
    try {
      // The other operation's own link holds the point, and so does an element
      // declaring this key on another kind of element: neither is a second
      // drawing of this control.
      document.elementFromPoint = () => document.querySelector('#drop')
      expect((await run(args([{ action: 'click', key: 'keep' }]), drawn)).steps).toEqual([{
        index: 1,
        status: 'failed',
        message: 'control "keep" is covered where it is drawn.',
      }])
      document.elementFromPoint = () => document.querySelector('#row-cell')
      expect((await run(args([{ action: 'click', key: 'keep' }]), drawn)).steps).toEqual([{
        index: 1,
        status: 'failed',
        message: 'control "keep" is covered where it is drawn.',
      }])
      expect(dropped).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
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
    document.elementFromPoint = () => document.querySelector('#copy-b')
    try {
      expect((await run(args([{ action: 'click', key: 'cell-click' }]), drawn)).steps).toEqual([{
        index: 1,
        status: 'failed',
        message: 'control "cell-click" is covered where it is drawn.',
      }])
      expect(pressed).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
  })

  it('refuses a table control something unrelated is drawn over', async () => {
    const drawn = drawEntry(`
      <div data-component-node="grid" class="el-table">
        <div class="el-table__body-wrapper"><table class="el-table__body"><tbody><tr>
          <td data-component-action="cell-click"><div class="cell">row</div></td>
        </tr></tbody></table></div>
        <div class="el-table__fixed"><div class="el-table__fixed-body-wrapper"><table class="el-table__body"><tbody><tr>
          <td data-component-action="cell-click"><div class="cell">row</div></td>
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
    document.elementFromPoint = () => document.querySelector('#mask')
    try {
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
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
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
    document.elementFromPoint = () => box
    try {
      expect((await run(args([{ action: 'click', key: 'tick' }]), drawn)).status).toBe('done')
      expect(toggled).toBe(1)
      expect(input.checked).toBe(true)
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
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
    document.elementFromPoint = (x, y) => (x === 30 && y === 25 ? over : button)
    try {
      expect((await run(args([{ action: 'click', key: 'go' }]), drawn)).steps).toEqual([{
        index: 1,
        status: 'failed',
        message: 'control "go" is covered where it is drawn.',
      }])
      expect(pressed).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
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
    document.elementFromPoint = () => over
    try {
      expect((await run(args([{ action: 'click', key: 'flat' }]), drawn)).status).toBe('done')
      expect(pressed).toHaveBeenCalledTimes(1)
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint')
    }
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

  it('presses the control a step names by that key, and the action key\'s first control otherwise', async () => {
    const drawn = drawEntry(`
      <button data-component-action="press" data-component-key="ok">OK</button>
      <button data-component-action="press" data-component-key="no">No</button>
    `)
    const buttons = [...document.querySelectorAll('button[data-component-action]')]
    const pressed = buttons.map(() => vi.fn())
    buttons.forEach((button, at) => { button.addEventListener('click', pressed[at] as () => void) })
    expect((await run(args([{ action: 'click', key: 'press' }]), drawn)).status).toBe('done')
    expect(pressed[0]).toHaveBeenCalledTimes(1)
    expect(pressed[1]).not.toHaveBeenCalled()
    expect((await run(args([{ action: 'click', key: 'no' }]), drawn)).status).toBe('done')
    expect(pressed[1]).toHaveBeenCalledTimes(1)
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
