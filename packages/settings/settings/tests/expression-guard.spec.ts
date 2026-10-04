/** Settings and editor writes carry Loader expressions only as unchanged copies of stored ones. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ConfigExpressionRejectedError } from '@deepseek-ai/dsh-config-editor'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { configurationFixture } from './configuration-fixture.ts'

// Apart from the one that throws to show it never runs, every refused expression below evaluates to a value this
// schema accepts, so only the expression rule refuses it.
const schema = z.object({
  ordinary: z.string(),
  label: z.string().default('plain').volatile(),
  alias: z.string().default('plain').volatile(),
  value: z.union([z.string(), z.number()]).default(0).volatile(),
  nested: z.object({ live: z.string().default('plain').volatile() }),
  list: z.array(z.string()).default([]).volatile(),
})

/** Boot with the given profile patch and, optionally, a replacement bundle config for `first`. */
async function boot(patch = '[]\n', bundled?: Record<string, unknown>) {
  const fixture = await configurationFixture({ schema, hmr: false })
  await fixture.ctx.fiber.dispose()
  if (bundled !== undefined) {
    const bundlePath = join(fixture.profile.dir, 'node_modules', 'test-bundle', 'cordis.patch.yml')
    const patches = JSON.parse(readFileSync(bundlePath, 'utf8')) as Array<{ insert: Array<{ id: string; config?: object }> }>
    patches[0]!.insert.find(row => row.id === 'first')!.config = bundled
    writeFileSync(bundlePath, JSON.stringify(patches))
  }
  writeFileSync(fixture.profile.patchPath, patch)
  const ctx = await fixture.start()
  return { ctx, profile: fixture.profile }
}

function first(ctx: Context) {
  return ctx.configEditor.entries().find(row => row.options.id === 'first')!
}

function form(ctx: Context) {
  return ctx.settings.describe().find(row => row.ns === 'first')!
}

/** The live form value and its revision; the revision advances whenever the entry's raw config changes. */
function state(ctx: Context) {
  const { value, revision } = form(ctx)
  return { value, revision }
}

/** Run one write and assert the expression refusal left the patch, the raw entry, and the live form untouched. */
async function expectRefused(
  ctx: Context, profile: ProfileContext, write: () => Promise<void>, path: string[], source: string,
): Promise<Error> {
  const before = readFileSync(profile.patchPath, 'utf8')
  const raw: unknown = structuredClone(first(ctx).options.config)
  const live = state(ctx)
  const error = await write().then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(ConfigExpressionRejectedError)
  expect(error).toMatchObject({ entryId: 'first', path })
  expect((error as Error).message).not.toContain(source)
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(first(ctx).options.config).toEqual(raw)
  expect(state(ctx)).toEqual(live)
  return error as Error
}

it('refuses a new expression written through update and never evaluates it', async () => {
  const { ctx, profile } = await boot()
  await expectRefused(ctx, profile, () => ctx.settings.update('first', { label: { __jsExpr: "'injected'" } }), ['label'], 'injected')
  await expectRefused(ctx, profile, () => ctx.settings.update('first', { label: { __jsExpr: 'throw new Error("evaluated")' } }), ['label'], 'evaluated')
})

it('accepts an existing expression written back unchanged beside another edit', async () => {
  const { ctx, profile } = await boot('- id: first\n  config:\n    ordinary: fixed\n    label: !!js "\'stored\'"\n')
  await ctx.settings.update('first', { label: { __jsExpr: "'stored'" }, alias: 'changed' })
  const saved = readFileSync(profile.patchPath, 'utf8')
  expect(saved).toContain('label: !!js')
  expect(saved).toContain('alias: changed')
  expect(form(ctx).value).toMatchObject({ label: 'stored', alias: 'changed' })
})

it('accepts an expression copied unchanged from the inherited layer', async () => {
  const { ctx, profile } = await boot(
    '- id: first\n  config:\n    ordinary: fixed\n    label: literal\n',
    { ordinary: 'fixed', label: { __jsExpr: "'bundled'" } },
  )
  await ctx.settings.mutate('first', [{ op: 'unset', path: ['label'] }])
  expect(form(ctx).value).toMatchObject({ label: 'bundled' })
  await ctx.settings.update('first', { label: 'literal' })
  await ctx.settings.update('first', { label: { __jsExpr: "'bundled'" }, alias: 'changed' })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('label: !!js')
  expect(form(ctx).value).toMatchObject({ label: 'bundled', alias: 'changed' })
})

it('refuses a changed expression, a key added beside a stored one, and a stored one moved to another path', async () => {
  const { ctx, profile } = await boot('- id: first\n  config:\n    ordinary: fixed\n    label: !!js "\'stored\'"\n')
  await expectRefused(ctx, profile, () => ctx.settings.update('first', { label: { __jsExpr: "'changed'" } }), ['label'], 'changed')
  await expectRefused(ctx, profile, () => ctx.settings.update('first', { label: { __jsExpr: "'stored'", other: 1 } }), ['label'], 'stored')
  await expectRefused(ctx, profile, () => ctx.settings.update('first', { alias: { __jsExpr: "'stored'" } }), ['alias'], 'stored')
})

it('refuses new expressions at nested and array paths through every write operation', async () => {
  const { ctx, profile } = await boot()
  await expectRefused(ctx, profile, () => ctx.settings.update('first', { nested: { live: { __jsExpr: "'deep'" } } }), ['nested', 'live'], 'deep')
  await expectRefused(ctx, profile, () => ctx.settings.mutate('first', [{ op: 'set', path: ['nested', 'live'], value: { __jsExpr: "'set'" } }]), ['nested', 'live'], 'set')
  await expectRefused(ctx, profile, () => ctx.settings.update('first', { list: ['plain', { __jsExpr: "'item'" }] }), ['list', '1'], 'item')
  await expectRefused(ctx, profile, () => ctx.settings.replace('first', { label: { __jsExpr: "'replaced'" } }), ['label'], 'replaced')
})

it('refuses an expression key beside other keys, which the editor stores as a plain map that Loader still evaluates', async () => {
  const { ctx, profile } = await boot()
  await expectRefused(ctx, profile, () => ctx.settings.update('first', { label: { __jsExpr: "'mixed'", other: 1 } }), ['label'], 'mixed')
})

it('refuses an expression key whose value is not a string', async () => {
  const { ctx, profile } = await boot()
  await expectRefused(ctx, profile, () => ctx.settings.update('first', { value: { __jsExpr: 7 } }), ['value'], '7')
})

it('refuses a root expression and one planted into the change arguments', async () => {
  const { ctx, profile } = await boot()
  const root = await expectRefused(ctx, profile, () => ctx.configEditor.edit(first(ctx), () => ({ __jsExpr: "({ ordinary: 'top' })" })), [], 'top')
  expect(root.message).toBe('Configuration for "first" may not add or change the JavaScript expression at the config root')
  await expectRefused(ctx, profile, () => ctx.configEditor.edit(first(ctx), (current, inherited) => {
    current['label'] = inherited['label'] = { __jsExpr: "'planted'" }
    return current
  }), ['label'], 'planted')
})
