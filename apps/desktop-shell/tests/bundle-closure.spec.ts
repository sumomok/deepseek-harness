/**
 * Which package references the payload-closure walk counts as keeping a
 * directory alive, and which it deliberately cannot see.
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundleClosure, specifierFor } from '../scripts/bundle-closure.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('specifierFor', () => {
  it('matches a specifier a bundler would follow', () => {
    for (const text of [
      'import open from \'open\'',
      'const open = require(\'open\')',
      'export { x } from "open"',
      'await import(\'open\')',
    ]) expect(specifierFor('open').test(text)).toBe(true)
  })

  it('matches the literal argument of a resolution call', () => {
    for (const text of [
      'import.meta.resolve(\'open\')',
      'createRequire(import.meta.url).resolve(\'open\')',
      'nodeRequire.resolve(\'open\')',
    ]) expect(specifierFor('open').test(text)).toBe(true)
  })

  it('matches a require built and invoked in one expression', () => {
    for (const text of [
      'const { Terminal } = createRequire(import.meta.url)(\'@xterm/headless\')',
      'createRequire(import.meta.url)("@xterm/headless")',
    ]) expect(specifierFor('@xterm/headless').test(text)).toBe(true)
  })

  it('matches a resolution call that reaches into a subpath of the package', () => {
    expect(specifierFor('@img/sharp-libvips-darwin-arm64').test('require.resolve(\'@img/sharp-libvips-darwin-arm64/binary\')')).toBe(true)
    expect(specifierFor('@vscode/ripgrep').test('nodeRequire.resolve(\'@vscode/ripgrep/bin/rg\')')).toBe(true)
  })

  it('cannot see a platform package assembled by substitution, which is why NATIVE exists', () => {
    expect(specifierFor('@img/sharp-darwin-arm64').test('const p = `@img/sharp-${platform}-${arch}`')).toBe(false)
  })

  it('ignores the name outside an import or resolution position', () => {
    for (const text of [
      'const label = \'open\'',
      '// see \'open\' for details',
      '{"name": "open"}',
      'throw new Error(\'open\')',
    ]) expect(specifierFor('open').test(text)).toBe(false)
  })
})

describe('bundleClosure', () => {
  it('keeps both platforms\' sherpa-onnx members, which only a relative require reaches', async () => {
    const payload = mkdtempSync(join(tmpdir(), 'bundle-closure-'))
    roots.push(payload)
    const members = [`sherpa-onnx-darwin-${process.arch}`, 'sherpa-onnx-win-x64']
    for (const name of ['sherpa-onnx-node', ...members, 'unreferenced']) {
      mkdirSync(join(payload, 'node_modules', name), { recursive: true })
      writeFileSync(join(payload, 'node_modules', name, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
    }
    writeFileSync(join(payload, 'node_modules', 'sherpa-onnx-node', 'index.js'),
      `module.exports = require('../sherpa-onnx-darwin-${process.arch}/sherpa-onnx.node')`)
    const result = await bundleClosure(payload)
    for (const name of ['sherpa-onnx-node', ...members]) expect(existsSync(join(payload, 'node_modules', name))).toBe(true)
    expect(existsSync(join(payload, 'node_modules', 'unreferenced'))).toBe(false)
    expect(result.removed).toBe(1)
  })
})
