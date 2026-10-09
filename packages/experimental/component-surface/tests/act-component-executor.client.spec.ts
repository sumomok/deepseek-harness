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
import { drawnEntry } from '../src/client/entry-container.ts'
import { runActComponent } from '../src/client/act-executor.ts'

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
})

describe('a step inside the entry', () => {
  it('presses the control the block declares, through the block\'s own handler', async () => {
    const { inside, outside } = draw()
    const drawn = drawnEntry(document)
    expect(drawn).toBeDefined()
    const report = await runActComponent(args([{ action: 'click', node: 'toolbar', key: 'add' }]), drawn!)
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
    const report = await runActComponent(args([{ action: 'set', node: 'toolbar', name: 'zh_label', value: 'X' }]), drawn!)
    expect(report.status).toBe('done')
    expect(declared.value).toBe('X')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('writes the field a label inside the entry names, which is all a block that declares none has', async () => {
    draw()
    const drawn = drawnEntry(document)
    const report = await runActComponent(args([{ action: 'set', name: 'title', value: 'Y' }]), drawn!)
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
    const report = await runActComponent(args([{ action: 'wait', node: 'grid', timeoutMs: 1000 }]), drawn!)
    expect(report.status).toBe('done')
  })
})

describe('a step that would leave the entry', () => {
  it('refuses a control only the console draws, and leaves it unpressed', async () => {
    const { inside, outside } = draw()
    const drawn = drawnEntry(document)
    const report = await runActComponent(args([{ action: 'click', key: 'console-add' }]), drawn!)
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
    const report = await runActComponent(args([{ action: 'set', name: 'owner', value: 'X' }]), drawn!)
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
    const report = await runActComponent(args([
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
