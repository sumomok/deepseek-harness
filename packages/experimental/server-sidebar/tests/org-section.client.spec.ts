/**
 * `createOrgSectionSource` over the real slot registry: the organization
 * section counts while a `settings.section` winner carries its id, and a
 * subscription made before the slot is declared still fires.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createOrgSectionSource, ORG_SECTION_ID } from '../src/client/org-section.ts'

/** A registry with the settings shell's section list declared by a stand-in shell, as `ui-settings-general` declares it. */
async function registry(): Promise<{ ctx: Context; declare: () => () => void }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: { 'sidebar.settings': { kind: 'single', scope: 'root' } } } as never, () => null)
  const declare = (): (() => void) => ctx.slots.register(
    { name: 'sidebar.settings', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
  return { ctx, declare }
}

/** Wait for the registry's microtask-batched notifications. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('createOrgSectionSource', () => {
  it('names the id the organization plugin registers its section under', () => {
    expect(ORG_SECTION_ID).toBe('sumomok-org')
  })

  it('reads absent before the list is declared, and present once the organization section registers', async () => {
    const { ctx, declare } = await registry()
    const source = createOrgSectionSource(ctx.slots)
    const changed = vi.fn()
    source.subscribe(changed)
    expect(source.getSnapshot()).toBe(false)
    declare()
    ctx.slots.register({ name: 'settings.section', id: 'account', label: 'Account' }, () => null)
    await flush()
    expect(source.getSnapshot()).toBe(false)
    const disposeOrg = ctx.slots.register({ name: 'settings.section', id: ORG_SECTION_ID, label: 'Organization' }, () => null)
    await flush()
    expect(changed).toHaveBeenCalled()
    expect(source.getSnapshot()).toBe(true)
    disposeOrg()
    expect(source.getSnapshot()).toBe(false)
  })

  it('answers from its cache while the list does not change', async () => {
    const { ctx, declare } = await registry()
    declare()
    ctx.slots.register({ name: 'settings.section', id: ORG_SECTION_ID, label: 'Organization' }, () => null)
    const entriesOfSlot = vi.spyOn(ctx.slots, 'entriesOfSlot')
    const source = createOrgSectionSource(ctx.slots)
    expect(source.getSnapshot()).toBe(true)
    expect(source.getSnapshot()).toBe(true)
    expect(entriesOfSlot).toHaveBeenCalledTimes(1)
  })

  it('reads absent once the shell that declared the list leaves', async () => {
    const { ctx, declare } = await registry()
    const undeclare = declare()
    ctx.slots.register({ name: 'settings.section', id: ORG_SECTION_ID, label: 'Organization' }, () => null)
    const source = createOrgSectionSource(ctx.slots)
    expect(source.getSnapshot()).toBe(true)
    undeclare()
    expect(source.getSnapshot()).toBe(false)
  })
})
