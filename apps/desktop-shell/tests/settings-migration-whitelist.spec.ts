/**
 * The shell's copy of each plugin section's importable keys against the
 * vendored plugins' own `Config` schemas: the same keys, less the volatile keys
 * the migration drops, and the same verdict on every value the shell's
 * migration judges before the import sees it.
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DISCARDED_PLUGIN_KEYS, PLUGIN_SECTION_KEYS } from '../src/settings-migration.ts'

/** A schema node, as far as this comparison reads one. */
interface SchemaNode {
  (value: unknown): unknown
  meta: { volatile?: boolean }
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fromServer = createRequire(join(repoRoot, 'apps', 'desktop-server', 'package.json'))

/** The package each migrated section belongs to. */
const SECTION_PACKAGES: Record<string, string> = {
  'llm-permission-gateway': '@haoran/dsh-llm-permission-gateway',
  'auto-compact': '@haoran/dsh-auto-compact',
  'mcp-servers': '@haoran/dsh-mcp-servers',
  balance: '@sumomok/dsh-balance',
}

/** The vendored package's directory in the payload closure. */
function packageDir(section: string): string {
  return dirname(fromServer.resolve(`${SECTION_PACKAGES[section] ?? ''}/package.json`))
}

/**
 * The fields the vendored package's published `Config` type marks `Volatile`,
 * read from its declaration files: the schema's volatile set, available on a
 * tree nothing has been built in.
 */
function declaredVolatileKeys(section: string): string[] {
  const types = join(packageDir(section), 'lib', 'types')
  const keys = new Set<string>()
  for (const file of readdirSync(types).filter(name => name.endsWith('.d.ts'))) {
    for (const match of readFileSync(join(types, file), 'utf8').matchAll(/^\s+(\w+): Volatile</gm)) keys.add(match[1] ?? '')
  }
  return [...keys].sort()
}

/**
 * The vendored package's `Config.dict`, or undefined when its host half cannot
 * load here.
 *
 * The test runner hands a module under `node_modules` to Node unchanged, and
 * Node resolves the package's `@deepseek-ai/*` imports to the workspace
 * packages' `lib/` builds, which exist only after `pnpm run build`.
 */
async function configFields(section: string): Promise<Record<string, SchemaNode> | undefined> {
  try {
    const module = await import(pathToFileURL(join(packageDir(section), 'lib', 'index.js')).href) as { Config: { dict: Record<string, SchemaNode> } }
    return module.Config.dict
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return undefined
    throw error
  }
}

/** Whether the plugin's own schema accepts one value; the schema writes defaults into what it reads, so it reads a copy. */
function pluginAccepts(schema: SchemaNode, value: unknown): boolean {
  try {
    schema(structuredClone(value))
    return true
  } catch {
    // A refusal is the answer this comparison asks for.
    return false
  }
}

/** Values each key is judged on: what rc.33 wrote, every bound, one step past each bound, and hand-edited values. */
const SAMPLES: Record<string, Record<string, readonly unknown[]>> = {
  'llm-permission-gateway': {
    walledReview: [true, false, 'true', 1],
    judgeProvider: ['', 'deepseek-official', 3, false],
    judgeModel: ['', 'deepseek-v4-pro', 1.5, []],
    judgeReasoningEffort: ['', 'high', 'off', 2, {}],
  },
  'auto-compact': {
    enabled: [true, false, 'yes', 0],
    thresholdPercent: [20, 60, 73, 95, 19, 96, 72.5, 100, '60', true],
  },
  'mcp-servers': {
    servers: [[], [{ id: 'fixture', command: 'node' }], [1, 'x'], {}, 'servers'],
  },
  balance: {
    lowBalance: [0, 5, 10.5, 1e9, -1, -0.01, '5', true],
    criticalBalance: [0, 2, -3, '2'],
    maskBalance: [true, false, 'false', 0],
  },
}

describe('PLUGIN_SECTION_KEYS against the vendored plugins', () => {
  for (const section of Object.keys(SECTION_PACKAGES)) {
    it(`names exactly ${section}'s volatile fields, less the ones it drops`, () => {
      const volatile = declaredVolatileKeys(section)
      const discarded = Object.keys(DISCARDED_PLUGIN_KEYS[section] ?? {}).sort()
      expect(volatile.length).toBeGreaterThan(0)
      expect(volatile).toEqual(expect.arrayContaining(discarded))
      const imported = volatile.filter(key => !discarded.includes(key))
      expect(Object.keys(PLUGIN_SECTION_KEYS[section] ?? {}).sort()).toEqual(imported)
      expect(Object.keys(SAMPLES[section] ?? {}).sort()).toEqual(imported)
    })

    // Needs the workspace built (`pnpm run build`); skipped, and says so, on a clean tree.
    it(`judges every sample value of ${section} as the plugin does`, async (context) => {
      const dict = await configFields(section)
      if (dict === undefined) {
        context.skip('the vendored host half needs `pnpm run build` before it can load')
        return
      }
      for (const [key, values] of Object.entries(SAMPLES[section] ?? {})) {
        const shell = PLUGIN_SECTION_KEYS[section]?.[key]
        const plugin = dict[key]
        if (shell === undefined || plugin === undefined) throw new Error(`${section}.${key} is missing on one side`)
        expect(plugin.meta.volatile).toBe(true)
        for (const value of values) {
          expect({ key, value, accepted: shell(value) }).toEqual({ key, value, accepted: pluginAccepts(plugin, value) })
        }
      }
    })
  }
})
