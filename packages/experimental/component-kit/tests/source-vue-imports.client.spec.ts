/**
 * The rule the browser bundle's `vue` alias rests on: no source file in this
 * package imports `vue` for itself.
 *
 * The bundle maps the bare specifier onto `src/client/vue-shim.ts`, so an
 * import here would resolve back into the shim and close a cycle. Every source
 * file takes the runtime from the shim instead. The rule covers the whole
 * package rather than its bare name: the alias matches the bare specifier and
 * nothing else, so `vue/dist/vue.runtime.common.js` would resolve to the `vue`
 * this manifest declares and inline a second runtime instead. What the bundle
 * ends up carrying is checked separately, in
 * `tests/client-bundle-vue.client.spec.ts`. This runs outside jsdom because it
 * reads the package off disk rather than drawing anything.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = fileURLToPath(new URL('../src', import.meta.url))

/** The package, bare or by subpath, as it appears inside a specifier. */
const VUE_SPECIFIER = String.raw`['"]vue(?:\/[^'"]*)?['"]`

/** Any of the three ways a module can name the `vue` package. */
const VUE_IMPORT = new RegExp(
  String.raw`\bfrom\s+${VUE_SPECIFIER}|\brequire\(\s*${VUE_SPECIFIER}\s*\)|^\s*import\s+${VUE_SPECIFIER}`,
)

/** Line openings that begin a comment, which is where these files discuss the rule. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

/**
 * Whether a source file names the `vue` package in code.
 * @param source - the file's text.
 * @returns true when a non-comment line imports or requires `vue`.
 */
function importsVue(source: string): boolean {
  return source.split('\n').some(line => !COMMENT_LINE.test(line) && VUE_IMPORT.test(line))
}

describe('component-kit sources', () => {
  it('never import vue for themselves', () => {
    const offenders = readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map(entry => `${entry.parentPath}/${entry.name}`)
      .filter(file => importsVue(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('recognizes each way a module can name the package', () => {
    // The rule is only as good as the pattern behind it, and the pattern is
    // what a reviewer reads instead of the bundle.
    expect(importsVue("import Vue from 'vue'")).toBe(true)
    expect(importsVue('const Vue = require("vue")')).toBe(true)
    expect(importsVue("import 'vue'")).toBe(true)
    // A subpath is the same package and the same second runtime; the bundle's
    // alias does not cover it, so this rule has to.
    expect(importsVue("import Vue from 'vue/dist/vue.runtime.common.js'")).toBe(true)
    expect(importsVue('const { set } = require("vue/dist/vue.runtime.esm.js")')).toBe(true)
    expect(importsVue(" * takes the runtime from `require('vue')` instead")).toBe(false)
    expect(importsVue("import Vue from './vue-shim.ts'")).toBe(false)
    expect(importsVue("import { Vue } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'")).toBe(false)
  })
})
