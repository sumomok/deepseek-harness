import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Microcompact from '@deepseek-ai/dsh-compaction-microcompact'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('compaction-microcompact real Loader composition', () => {
  it('loads the default plugin export and resolves all nine config fields', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-compact-microcompact-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-compaction-microcompact'",
      '  config:',
      '    enabled: true',
      '    minIdleSeconds: 60',
      '    keepRecentToolUses: 2',
      '    minClearableToolUses: 3',
      '    clearAtLeastTokens: 4',
      '    maxClearPerRun: 5',
      '    keepErrors: false',
      '    allowHostOnlyReadback: true',
      '    excludeTools: [read, bash]',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-session-projection') return SessionProjectionRegistry
        if (specifier === '@deepseek-ai/dsh-token-meter') return TokenMeter
        if (specifier === '@deepseek-ai/dsh-compaction-microcompact') return Microcompact
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.get('microcompact')).toBeInstanceOf(Microcompact)
    expect(context.microcompact.config).toEqual({
      enabled: true,
      minIdleSeconds: 60,
      keepRecentToolUses: 2,
      minClearableToolUses: 3,
      clearAtLeastTokens: 4,
      maxClearPerRun: 5,
      keepErrors: false,
      allowHostOnlyReadback: true,
      excludeTools: ['read', 'bash'],
    })
  })
})
