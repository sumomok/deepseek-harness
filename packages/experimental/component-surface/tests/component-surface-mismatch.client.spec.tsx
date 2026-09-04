// @vitest-environment jsdom
/**
 * The `component` seat when the component row it was built against is not the
 * row it got.
 *
 * The renderer table arrives through the loader's module table, so the row a
 * deployment composes is not necessarily the one this bundle's `satisfies`
 * check was compiled against: a composition can mount an older row whose table
 * is missing a component the catalog here admits. The seat then says so in that
 * block's place and draws everything else, rather than dropping the whole entry
 * or leaving a blank box.
 *
 * The empty table stands for exactly that mismatch — it cannot be produced by
 * this repository's own pair, which is the point of pinning it here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-experimental-component-kit/src/client/locales.ts'
import { CONFIRM_BAR_ID } from '../src/component-call.ts'
import { ComponentSurface, type ComponentSurfaceProps } from '../src/client/ComponentSurface.tsx'

vi.mock('@deepseek-ai/dsh-experimental-component-kit/client', () => ({
  NS: 'componentKit',
  COMPONENT_RENDERERS: {},
}))

const t: ComponentSurfaceProps['t'] = makeTranslate(en)

afterEach(cleanup)

describe('component content seat without a matching component row', () => {
  it('says which block it cannot draw and keeps the rest of the entry', () => {
    const entry = {
      kind: 'component',
      entryId: 'budget',
      seq: 4,
      title: 'Budget approval',
      payload: { spec: { nodes: [{ id: 'ask', component: CONFIRM_BAR_ID, props: { buttons: [{ id: 'go', label: 'Go' }] } }] } },
    }
    const view = render(<ComponentSurface {...{ sessionId: 'a', entry, t } as unknown as ComponentSurfaceProps} />)
    expect(view.getByText('Budget approval')).toBeTruthy()
    expect(view.container.querySelector(`[data-component-surface-unsupported="${CONFIRM_BAR_ID}"]`)?.textContent)
      .toBe(en['block.unsupported'])
    expect(view.queryByRole('button')).toBeNull()
  })
})
