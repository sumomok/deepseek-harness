// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { act, fireEvent, screen } from '@testing-library/react'
import { expect, onTestFinished } from 'vitest'

usePinnedBrowserLanguages('en-US')

const it = createClientTest({
  roster: webApp.without(['@deepseek-ai/dsh-client-ui-settings-models']),
}, { mount: true })

function Section() { return null }

function SectionIcon({ size, active }: PropsRuntime<'settings.section.icon'>) {
  return <svg width={size} height={size} viewBox="0 0 16 16" data-testid="section-icon" data-active={active}>
    <circle cx="8" cy="8" r="6" fill="currentColor" />
  </svg>
}

const contribution = {
  name: 'test-settings-icon',
  inject: ['slots'],
  apply(ctx: Context) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'custom', label: 'Custom',
    }, Section))
    ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
      name: 'settings.section.icon', id: 'custom', label: 'Unused icon label',
    }, SectionIcon))
    ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
      name: 'settings.section.icon', id: 'unmatched',
    }, SectionIcon))
  },
}

it('renders a contributed section icon and restores the default after its plugin unloads', async ({ start }) => {
  // jsdom omits the browser method used when the settings row receives focus.
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value() {} })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
  const c = await start()
  const plugin = c.ctx.plugin(contribution)
  await act(async () => { await plugin })
  fireEvent.click(screen.getByRole('button', { name: 'Account menu' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
  const row = screen.getByRole('button', { name: 'Custom' })
  // Grouped settings navigation places glyphs on group titles and keeps member rows icon-free;
  // the settings.section.icon slot remains declared so plugins registering icons mount and dispose cleanly.
  expect(row.textContent).toBe('Custom')
  expect(row.querySelector('svg')).toBeNull()
  expect(c.ctx.slots.entries('settings.section.icon').map(entry => entry.options.id)).toEqual(['custom', 'unmatched'])
  const general = screen.getByRole('button', { name: 'General settings' })
  expect(general.querySelector('svg')).toBeNull()
  fireEvent.click(row)
  expect(row.getAttribute('aria-current')).toBe('true')

  const replacement = c.ctx.plugin({
    name: 'test-settings-icon-replacement', inject: ['slots'],
    apply(ctx) {
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon', id: 'general',
      }, SectionIcon))
    },
  })
  await act(async () => { await replacement })
  expect(c.ctx.slots.entries('settings.section.icon').map(entry => entry.options.id)).toContain('general')
  await act(async () => { await replacement.dispose() })
  expect(c.ctx.slots.entries('settings.section.icon').map(entry => entry.options.id)).not.toContain('general')
  await act(async () => { await plugin.dispose() })
  expect(screen.queryByRole('button', { name: 'Custom' })).toBeNull()
  expect(c.ctx.slots.entries('settings.section.icon')).toHaveLength(0)
}, 60_000)
