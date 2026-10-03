/**
 * Which package references the payload-closure walk counts as keeping a
 * directory alive, and which it deliberately cannot see.
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundleClosure, REFERENCE_SCAN_SOURCE, referencedNames, specifierFor } from '../scripts/bundle-closure.ts'

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

/**
 * Every name the reachability walk could be asked about, including names that
 * prefix one another (`lodash` / `lodash.merge`, `@a/b` / `@a/b-c`), a name
 * that is a path segment of another, and names that look like keywords.
 */
const NAMES = [
  'open', 'lodash', 'lodash.merge', 'lodash.mergewith', '@a/b', '@a/b-c', '@a/bc', '@xterm/headless',
  '@img/sharp-libvips-darwin-arm64', '@vscode/ripgrep', 'import', 'require', 'from', 'a', 'b', 'x$y', 'q.r',
]

/** The same answer for every name, by the per-name pattern and by the single scan. */
function expectSameAnswers(text: string): void {
  const found = referencedNames(text, new Set(NAMES))
  for (const name of NAMES) {
    expect(found.has(name), `${name} in ${JSON.stringify(text)}`).toBe(specifierFor(name).test(text))
  }
}

/** A deterministic generator (mulberry32), so a failing text reproduces from the seed. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('referencedNames', () => {
  it('answers like specifierFor for every name on crafted texts', () => {
    for (const text of [
      'import open from \'open\'',
      'export * from "lodash.merge"',
      'require(`lodash`)',
      'require("lodash/fp/merge.js")',
      'require(\'lodash.mergewith/index.js\')',
      'await import(\'@a/b-c\')',
      'import("@a/b/deep/sub/path.js")',
      'import.meta.resolve(\'@img/sharp-libvips-darwin-arm64/binary\')',
      'createRequire(import.meta.url).resolve("@vscode/ripgrep/bin/rg")',
      'const { Terminal } = createRequire(import.meta.url)(\'@xterm/headless\')',
      'nodeRequire.resolve(`open`)',
      '__webpack_require__.resolve(\'q.r\')',
      'requireFoo$.resolve("x$y")',
      'require(\'\')',
      'require(\'/abs\')',
      'require(\'a\'\'b\')',
      'require(\'./import\')(\'a\')',
      'require("./import" + "from")',
      'import\'a\'',
      'from"b"',
      'require(\'@a/b\'',
      'const label = \'open\'; throw new Error("lodash")',
      '{"name": "open", "main": "require"}',
      'const p = `@img/sharp-${platform}-${arch}`',
      'require(\'lodash.merge',
      // Minified identifier runs; specifierFor's cost grows with the square of
      // their length, which is what bounds them here.
      `${'a'.repeat(600)}require('open')${'_$Zz9'.repeat(120)}from"@a/bc"`,
      `var ${'r'.repeat(600)}equire_${'q'.repeat(600)}=0;${'x'.repeat(600)}Require.resolve('b')`,
    ]) expectSameAnswers(text)
  })

  it('answers like specifierFor for every name on generated texts', () => {
    const tokens = [
      'from', 'require', 'import', 'import.meta', '.resolve', 'createRequire(import.meta.url)', 'nodeRequire',
      '(', ')', ' ', '\n', '.', ';', '/', '\'', '"', '`', '$', '_', 'x', 'q.r', ...NAMES,
    ]
    const next = seeded(20261004)
    for (let round = 0; round < 3000; round++) {
      let text = ''
      const length = 1 + Math.floor(next() * 24)
      for (let index = 0; index < length; index++) text += tokens[Math.floor(next() * tokens.length)]
      expectSameAnswers(text)
    }
  })

  it('looks for the same call forms as specifierFor', () => {
    // The prefixes are read back out of specifierFor's own pattern, so this
    // fails when either pattern is changed without the other.
    const literal = new RegExp(String.raw`['"\`]probe(?:/[^'"\`]*)?['"\`]`).source
    const pieces = specifierFor('probe').source.split(literal)
    expect(pieces.at(-1)).toBe('')
    const prefixes = pieces.slice(0, -1).map((piece, index) => index === 0 ? piece : piece.replace(/^\|/, ''))
    expect(prefixes).toHaveLength(3)
    const scan = new RegExp(REFERENCE_SCAN_SOURCE).source
    expect(scan.startsWith(String.raw`['"\`](?<=(?:` + prefixes.join('|') + String.raw`)['"\`])`)).toBe(true)
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
