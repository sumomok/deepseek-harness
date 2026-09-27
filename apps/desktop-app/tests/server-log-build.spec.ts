/**
 * The exporter bundle `build.ts` writes, built in memory with the same
 * options: it must import cordis and schemastery rather than carry copies.
 * @module
 */

import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { SERVER_LOG_EXTERNALS, serverLogBuild } from '../build-options.ts'

describe('lib/server-log.js', () => {
  it('imports @deepseek-ai/cordis and @deepseek-ai/schemastery instead of bundling them', async () => {
    const result = await build({ ...serverLogBuild(new URL('..', import.meta.url).pathname), write: false, metafile: true })
    const [output] = result.outputFiles ?? []
    expect(output).toBeDefined()
    const text = output?.text ?? ''
    for (const name of SERVER_LOG_EXTERNALS) expect(text).toMatch(new RegExp(`^import [^\\n]* from "${name}";$`, 'mu'))
    const inputs = Object.keys(result.metafile?.inputs ?? {})
    expect(inputs.filter(input => /vendor\/(?:cordis|schemastery)\//u.test(input))).toEqual([])
    expect(inputs.some(input => input.endsWith('src/server-log.ts'))).toBe(true)
  })
})

describe('build.ts', () => {
  it('builds the exporter with those options', () => {
    // build.ts runs its builds on import, so its source is read instead.
    const source = readFileSync(new URL('../build.ts', import.meta.url), 'utf8')
    expect(source).toContain('await build(serverLogBuild(root))')
  })
})
