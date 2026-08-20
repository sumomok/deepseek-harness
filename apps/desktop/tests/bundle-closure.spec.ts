/**
 * Which package references the payload-closure walk counts as keeping a
 * directory alive, and which it deliberately cannot see.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { specifierFor } from '../scripts/bundle-closure.ts'

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
