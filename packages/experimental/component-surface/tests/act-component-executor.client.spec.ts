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

  it('fails with the target it waited for when the block or the key never appears', async () => {
    draw()
    const drawn = drawnEntry(document)
    if (drawn === undefined) throw new Error('the case drew no entry')
    const cases: [ActComponentArgs['steps'][number], string][] = [
      [{ action: 'wait', node: 'ghost', timeoutMs: 50 }, '"ghost" did not appear in time'],
      [{ action: 'wait', key: 'ghost', timeoutMs: 50 }, '"ghost" did not appear in time'],
    ]
    for (const [step, message] of cases) {
      const report = await run(args([step]), drawn)
      expect({ step, report: report.steps }).toEqual({
        step,
        report: [{ index: 1, status: 'failed', message: `${message} is not part of the entry on display.` }],
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
})

describe('the key one control declares for itself', () => {
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
