/**
 * Shared helpers for stylesheet-contract specs: flatten CSS text on disk into
 * rules and enumerate the package stylesheets those contracts range over.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One flattened CSS rule: its comma-separated selector parts and its declarations in source order. */
export interface CssRule {
  selectors: string[]
  declarations: [property: string, value: string][]
}

/** Root the package-wide stylesheet scans walk. */
const PACKAGES_DIR = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Stylesheets copied verbatim from a third party, which these contracts do not
 * range over: the rules below state how this product's own surfaces are drawn,
 * and a vendored sheet is regenerated from upstream rather than authored here,
 * so a violation in one is neither fixable nor a fact about this product. Each
 * entry is a repository-relative path; the scan asserts every one still exists,
 * so a moved or deleted copy fails here instead of silently widening the scan.
 */
const VENDORED_STYLESHEETS = [
  // element-ui 2.15.14 theme-chalk/index.css — see the component-kit README.
  'experimental/component-kit/src/client/element-ui.css',
]

/**
 * Flatten a stylesheet into rules. Whitespace, declaration order, and trailing
 * semicolons are normalized away; nesting is not handled, which no sheet under
 * test uses, and at-rule preludes surface as selector-less rule boundaries.
 * @param css - stylesheet text.
 * @returns one entry per rule, in source order.
 */
export function parseRules(css: string): CssRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rules: CssRule[] = []
  // Destructuring defaults only satisfy noUncheckedIndexedAccess; both groups
  // are unconditional in the pattern.
  for (const [, selector = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = body
      .split(';')
      .map(part => part.trim())
      .filter(part => part.includes(':'))
      .map((part): [string, string] => {
        const colon = part.indexOf(':')
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]
      })
    rules.push({ selectors: selector.split(',').map(part => part.trim()), declarations })
  }
  return rules
}

/**
 * Half-open source span of one at-rule's block, excluding its prelude.
 * @param css - stylesheet text.
 * @param prelude - exact at-rule prelude to locate, without the opening brace.
 * @returns the block's brace offsets, or undefined when the prelude is absent.
 */
export function atRuleBlock(css: string, prelude: string): { start: number; end: number } | undefined {
  const opening = css.indexOf(`${prelude} {`)
  if (opening === -1) return undefined
  const start = css.indexOf('{', opening)
  let depth = 0
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return { start, end: index }
    }
  }
  throw new Error(`unbalanced braces after ${prelude}`)
}

/**
 * Custom-property names a value reads.
 * @param value - declaration value, possibly with nested var() calls.
 * @returns every referenced custom-property name, in source order.
 */
export function varReferences(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(([, name = '']) => name)
}

/**
 * Every CSS file shipped as package source, excluding build output and
 * installed dependencies.
 * @returns absolute paths of the stylesheets under packages/.
 */
export function packageStylesheets(): string[] {
  const vendored = new Set(VENDORED_STYLESHEETS.map(path => join(PACKAGES_DIR, path)))
  for (const path of vendored) {
    if (!existsSync(path)) throw new Error(`stylesheet-scan: vendored stylesheet ${path} no longer exists`)
  }
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'lib' && entry.name !== 'dist') walk(path)
      } else if (entry.name.endsWith('.css') && !vendored.has(path)) found.push(path)
    }
  }
  walk(PACKAGES_DIR)
  return found
}
