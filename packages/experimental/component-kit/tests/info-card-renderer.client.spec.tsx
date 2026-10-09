// @vitest-environment jsdom
/**
 * `toy.info-card`: that the vendored card mounts nothing before its base path
 * is in force, says where the card comes from and requests nothing while the
 * data page beside it has opened nothing, shows the record it is handed with
 * the sections the view chose, reports each record it shows and that it shows
 * none any more — once per placing call, however often the block is redrawn —
 * and reads no credential of its own.
 *
 * The backend is the shared stub on `XMLHttpRequest` the data page's own spec
 * draws against. Nothing here reaches a network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { setBizBasePath } from '@sumomok/toy-crud-kit'
import { installElementUI } from '../src/client/element-ui.ts'
import { InfoCardRenderer } from '../src/client/InfoCardRenderer.tsx'
import { en } from '../src/client/locales.ts'
import type { ComponentActionHandler, ComponentRendererProps } from '../src/client/renderer.ts'
import type { VueInstance } from '../src/client/vue-shim.ts'
import { defineTable, drain, flush, seen, settleProgress, STORED_TOKEN, StubRequest } from './fixtures/crud-backend.client.ts'

/** What the base-path read answers with, per case: a path, or a refusal. */
let basePath: Promise<string> = Promise.resolve('/probe-base/')

vi.mock('../src/client/data-page-settings.ts', () => ({
  dataPageBasePathReady: (): Promise<string> => basePath,
  settleDataPageBasePath: (): Promise<string> => basePath,
}))

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** The table the cards here show a record of. */
const META = 'probe_card'

defineTable(META, {
  gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1' }],
  formItems: [{ relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' }],
  rows: [{ int_id: '1', zh_label: '甲' }],
})

beforeAll(() => {
  installElementUI()
  vi.stubGlobal('XMLHttpRequest', StubRequest)
  localStorage.setItem('accessToken', STORED_TOKEN)
  setBizBasePath('/probe-base/')
})

beforeEach(() => {
  basePath = Promise.resolve('/probe-base/')
  localStorage.removeItem('userInfo')
  seen.length = 0
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await drain()
})

// The last case's bar is still fading when the file ends, and jsdom is torn
// down right after: the removal would reach for a document that is gone.
afterAll(settleProgress)

/**
 * Draw one info card block.
 * @param props - the block's properties.
 * @param onAction - the block's action sink.
 * @returns the rendered view, the sink, and a way to hand the same block other properties.
 */
function draw(props: Record<string, unknown>, onAction = vi.fn<ComponentActionHandler>()) {
  const element = (next: Record<string, unknown>) =>
    <InfoCardRenderer nodeId="card-1" props={next} state="idle" onAction={onAction} onOutput={vi.fn()} t={t} />
  const view = render(element(props))
  return { view, onAction, redraw: (next: Record<string, unknown>) => { view.rerender(element(next)) } }
}

/**
 * The kit's card under one drawn block, once it is mounted.
 * @param container - the drawn block.
 * @returns the instance.
 */
async function cardOf(container: HTMLElement): Promise<VueInstance & { $props: Record<string, unknown> }> {
  await vi.waitFor(() => { expect(container.querySelector('[data-toy-crud-box]')).not.toBeNull() })
  const box = container.querySelector('[data-toy-crud-box]') as HTMLElement
  const rootEl = box.firstElementChild?.firstElementChild as HTMLElement & { __vue__?: VueInstance }
  let instance = rootEl.__vue__ as VueInstance
  while (instance.$options.name !== 'ToyInfoCard') instance = instance.$children[0] as VueInstance
  return instance as VueInstance & { $props: Record<string, unknown> }
}

describe('toy.info-card', () => {
  it('says where the card comes from, and requests and reads nothing, while the data page has opened nothing', async () => {
    const cookie = vi.spyOn(Document.prototype, 'cookie', 'get')
    const stored = vi.spyOn(Storage.prototype, 'getItem')
    const { view, onAction } = draw({})
    const card = await cardOf(view.container)
    await drain()
    expect(view.container.querySelector('[data-info-card-idle]')?.textContent).toBe(en['infoCard.idle'])
    expect(card.$props['record']).toBeUndefined()
    expect(seen).toEqual([])
    expect(cookie).not.toHaveBeenCalled()
    expect(stored).not.toHaveBeenCalled()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('shows the record it is handed with the sections the view chose, and reports it with its table', async () => {
    const record = { id: '1', name: '甲', type: META }
    const { view, onAction } = draw(Object.freeze({ record, infoCardTabs: ['attributes'] }))
    const card = await cardOf(view.container)
    expect(card.$props['record']).toEqual(record)
    expect(card.$props['infoCardTabs']).toEqual(['attributes'])
    expect(view.container.querySelector('[data-info-card-idle]')).toBeNull()
    await vi.waitFor(() => { expect(onAction).toHaveBeenCalledWith('card-open', { name: '甲', type: META }) })
    await drain()
    // Whatever the card fetched for the record went under the base path with the visitor's own token.
    for (const sent of seen) {
      expect(sent.url.startsWith('/probe-base/')).toBe(true)
      expect(sent.authorization).toBe(STORED_TOKEN)
    }
  })

  it('names a record the page showed no name for by its id, and reports another record and the card emptying', async () => {
    const { view, onAction, redraw } = draw(Object.freeze({ record: { id: 7, type: META } }))
    await cardOf(view.container)
    await vi.waitFor(() => { expect(onAction).toHaveBeenLastCalledWith('card-open', { name: '7', type: META }) })
    redraw(Object.freeze({ record: { id: '1', name: '甲', type: META } }))
    await vi.waitFor(() => { expect(onAction).toHaveBeenLastCalledWith('card-open', { name: '甲', type: META }) })
    redraw(Object.freeze({}))
    await vi.waitFor(() => { expect(onAction).toHaveBeenLastCalledWith('card-close', {}) })
    expect(view.container.querySelector('[data-info-card-idle]')?.textContent).toBe(en['infoCard.idle'])
    expect(onAction).toHaveBeenCalledTimes(3)
  })

  it('reports the record it shows once per placing call, however often the block is redrawn', async () => {
    const props = Object.freeze({ record: { id: '1', name: '甲', type: META } })
    const first = draw(props)
    await cardOf(first.view.container)
    await vi.waitFor(() => { expect(first.onAction).toHaveBeenCalledTimes(1) })
    first.view.unmount()
    // The same property record: the column dropped the block and drew it
    // again, and the card raised the same record once more.
    const again = draw(props, first.onAction)
    await cardOf(again.view.container)
    await flush()
    expect(first.onAction).toHaveBeenCalledTimes(1)
    again.view.unmount()
    // A new record object is a record opened again, and is reported again.
    const reopened = draw(Object.freeze({ record: { id: '1', name: '甲', type: META } }), first.onAction)
    await cardOf(reopened.view.container)
    await vi.waitFor(() => { expect(first.onAction).toHaveBeenCalledTimes(2) })
  })

  it('reports nothing for a record no report may carry', async () => {
    const { view, onAction } = draw({})
    const card = await cardOf(view.container)
    card.$emit('info-card-open', { id: '1', name: '甲', type: '1st' })
    expect(onAction).not.toHaveBeenCalled()
  })

  it('mounts nothing before the base path is in force, and says so either way', async () => {
    let release: (path: string) => void = () => {}
    basePath = new Promise((resolve) => { release = resolve })
    const waiting = draw({})
    expect(waiting.view.container.querySelector('[data-info-card-stalled="waiting"]')?.textContent).toBe(en['infoCard.preparing'])
    expect(waiting.view.container.querySelector('[data-toy-crud-box]')).toBeNull()
    release('/probe-base/')
    await cardOf(waiting.view.container)
    cleanup()
    basePath = Promise.reject(new Error('component-kit: answered 503'))
    const failed = draw({ record: { id: '1', name: '甲', type: 'probe_card_unreached' } })
    await vi.waitFor(() => {
      expect(failed.view.container.querySelector('[data-info-card-stalled="failed"]')?.textContent).toBe(en['infoCard.unavailable'])
    })
    await flush()
    // Read by the record's own table rather than by counting requests: the
    // request layer refreshes a cached scheme a turn later, so a card a
    // previous case drew can still have one in flight.
    expect(seen.filter(sent => sent.url.includes('probe_card_unreached'))).toEqual([])
    expect(failed.onAction).not.toHaveBeenCalled()
  })
})
