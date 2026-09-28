/**
 * The Host bundles `build.ts` writes, built in memory with the same options:
 * each must import cordis and schemastery rather than carry copies.
 * @module
 */

import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { HOST_EXTERNALS, type HostModule, hostBuild } from '../build-options.ts'

describe.each<HostModule>(['index', 'server-log'])('lib/%s.js', (module) => {
  it('imports @deepseek-ai/cordis and @deepseek-ai/schemastery instead of bundling them', async () => {
    const result = await build({ ...hostBuild(new URL('..', import.meta.url).pathname, module), write: false, metafile: true })
    const [output] = result.outputFiles ?? []
    expect(output).toBeDefined()
    const text = output?.text ?? ''
    const inputs = Object.keys(result.metafile?.inputs ?? {})
    expect(inputs.filter(input => /vendor\/(?:cordis|schemastery)\//u.test(input))).toEqual([])
    expect(inputs.some(input => input.endsWith(`src/${module}.ts`))).toBe(true)
    // `src/index.ts` imports cordis for types only, so its bundle names schemastery alone.
    const imported = module === 'index' ? ['@deepseek-ai/schemastery'] : HOST_EXTERNALS
    for (const name of imported) expect(text).toMatch(new RegExp(`^import [^\\n]* from "${name}";$`, 'mu'))
  })
})

describe('build.ts', () => {
  it('builds both Host modules with those options', () => {
    // build.ts runs its builds on import, so its source is read instead.
    const source = readFileSync(new URL('../build.ts', import.meta.url), 'utf8')
    expect(source).toContain('await build(hostBuild(root, \'index\'))')
    expect(source).toContain('await build(hostBuild(root, \'server-log\'))')
  })
})
