/** The package boots through the real Loader from a cordis.yml, with its config parsed by the plugin. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'

it('loads from a cordis.yml and exposes the service', async () => {
  // Source-mode shim: the committed package entry is `lib/`, which a keyless source test does not build.
  const { register: registerTsx } = await import('tsx/esm/api')
  registerTsx()
  const dir = await mkdtemp(join(import.meta.dirname, '.loader-'))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
  const shim = join(dir, 'node_modules', '@deepseek-ai', 'dsh-experimental-decision-state')
  await mkdir(shim, { recursive: true })
  await writeFile(join(shim, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-experimental-decision-state', type: 'module', exports: './entry.mjs',
  }))
  const source = pathToFileURL(join(import.meta.dirname, '..', 'src', 'index.ts')).href
  await writeFile(join(shim, 'entry.mjs'), `export { default } from '${source}'\n`)
  const config = join(dir, 'cordis.yml')
  await writeFile(config, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-experimental-decision-state'",
    '  config:',
    '    scopes:',
    '      demo:',
    '        units: [a, b, c]',
    '',
  ].join('\n'))
  const ctx = await boot('test', config)
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const service = ctx.get('decisionState')
  expect(service).toBeDefined()
  expect(service?.constructor.name).toBe('DecisionStateService')
})
