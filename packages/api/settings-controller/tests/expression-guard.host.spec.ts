/** Remote settings writes refuse new Loader expressions without any method-filter plugin mounted. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import SettingsController from '../src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'

it('refuses update, replace, and mutate that add an expression and leaves the profile patch unchanged', async () => {
  const { ctx, profile } = await configurationFixture()
  await ctx.plugin(SettingsController)
  const controller = ctx.settingsController
  const before = readFileSync(profile.patchPath, 'utf8')
  const expression = { __jsExpr: '9' }
  const writes = [
    () => controller.update('first', { count: expression }, undefined),
    () => controller.replace('first', { count: expression }, undefined),
    () => controller.mutate('first', [{ op: 'set', path: ['count'], value: expression }], undefined),
  ]
  for (const write of writes) {
    const failure = await write().then(() => undefined, (error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'settings/rejected',
      message: 'Configuration for "first" may not add or change the JavaScript expression at "count"',
      details: { ns: 'first' },
    })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
    expect(controller.describe().namespaces.find(row => row.ns === 'first')!.value).toMatchObject({ count: 2 })
  }
})
