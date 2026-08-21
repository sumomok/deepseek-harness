// @vitest-environment jsdom
/**
 * The probe end to end inside React: the Vue tree mounts into the bridge's
 * host, its own reactive state answers clicks, a React prop change patches the
 * live tree instead of remounting it, and unmount hands the container back
 * empty.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { VueProbeAction, type VueProbeActionProps } from '../src/client/VueProbeAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: VueProbeActionProps['t'] = makeTranslate(zh)
const props = { t } as unknown as VueProbeActionProps

const button = () => screen.getByRole('button', { name: zh['probe.aria'] })

describe('VueProbeAction', () => {
  it('mounts the Vue tree with the copy the React half resolved', () => {
    const { container } = render(<VueProbeAction {...props} />)
    expect(screen.getByText(zh['probe.title'])).toBeDefined()
    expect(button().textContent?.trim()).toBe(`${zh['probe.count']} 0`)
    expect(container.textContent).toContain(`${zh['probe.echo']} 0`)
  })

  it('counts in Vue and echoes the value back through React', async () => {
    render(<VueProbeAction {...props} />)
    fireEvent.click(button())
    // Vue flushes its render queue on a microtask; the React state update that
    // the same click triggers is already applied when the assertion runs.
    await Promise.resolve()
    expect(button().textContent?.trim()).toBe(`${zh['probe.count']} 1`)
    expect(screen.getByText(`${zh['probe.echo']} 1`)).toBeDefined()

    fireEvent.click(button())
    await Promise.resolve()
    // The count survived the React re-render the echo caused: the bridge
    // patched the existing tree instead of remounting it.
    expect(button().textContent?.trim()).toBe(`${zh['probe.count']} 2`)
    expect(screen.getByText(`${zh['probe.echo']} 2`)).toBeDefined()
  })

  it('empties its container on unmount', () => {
    const { container, unmount } = render(<VueProbeAction {...props} />)
    const host = container.firstElementChild
    expect(host?.childElementCount).toBe(1)
    unmount()
    expect(host?.childElementCount).toBe(0)
  })
})
