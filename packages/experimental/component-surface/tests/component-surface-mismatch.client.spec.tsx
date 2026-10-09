// @vitest-environment jsdom
/**
 * The `component` seat on a page that cannot draw the block a payload names.
 *
 * Two pages reach it and they are answered differently. A page whose registry
 * carries the component's definition but no renderer for it draws the seat's
 * own line in that block's place and keeps the rest of the entry. A page that
 * loaded no component plugin at all has no definition either, so the same
 * judgement the host ran refuses the whole payload and the seat says the entry
 * cannot be displayed — which is what a record replayed on a page with no
 * components is.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { CONFIRM_BAR_ID } from '../src/component-call.ts'
import { en } from '../src/client/locales.ts'
import { ComponentSurface, type ComponentSurfaceProps } from '../src/client/ComponentSurface.tsx'
import type { ComponentRendererTable } from '../src/client/registry.ts'
import { KIT_CATALOG } from './kit-catalog.client.ts'
import { NO_COMPONENTS } from './renderer-table.client.ts'

/** A page holding the definitions of a component row whose renderers it does not have. */
const NO_RENDERERS: ComponentRendererTable = { catalog: KIT_CATALOG, rendererFor: () => undefined }

const t: ComponentSurfaceProps['t'] = makeTranslate(en)

afterEach(cleanup)

/** One entry carrying one confirmation bar, as the column publishes it. */
const ENTRY = {
  kind: 'component',
  entryId: 'budget',
  seq: 4,
  title: 'Budget approval',
  payload: { spec: { nodes: [{ id: 'ask', component: CONFIRM_BAR_ID, props: { buttons: [{ id: 'go', label: 'Go' }] } }] } },
}

/**
 * Draw one seat over {@link ENTRY} with the components a page has.
 * @param components - the page's renderer table.
 * @returns the rendered seat.
 */
function seat(components: ComponentRendererTable) {
  const useSessions = ((selector: (snapshot: unknown) => unknown) => selector({ byId: {} })) as ComponentSurfaceProps['useSessions']
  return render(<ComponentSurface {...{
    sessionId: 'a',
    entry: ENTRY,
    useSessions,
    pending: new Map(),
    components,
    offerCalls: () => {},
    parkCalls: () => {},
    t,
  } as unknown as ComponentSurfaceProps} />)
}

describe('component content seat that cannot draw a block', () => {
  it('says which block it cannot draw and keeps the rest of the entry', () => {
    const view = seat(NO_RENDERERS)
    expect(view.getByText('Budget approval')).toBeTruthy()
    expect(view.container.querySelector(`[data-component-surface-unsupported="${CONFIRM_BAR_ID}"]`)?.textContent)
      .toBe(en['block.unsupported'])
    expect(view.queryByRole('button')).toBeNull()
  })

  it('says the entry cannot be displayed on a page that composed no component row', () => {
    const view = seat(NO_COMPONENTS)
    expect(view.container.querySelector('[data-component-surface-error]')?.textContent).toBe(en['block.unreadable'])
    expect(view.queryByRole('button')).toBeNull()
  })
})
