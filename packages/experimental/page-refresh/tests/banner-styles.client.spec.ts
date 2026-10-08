/**
 * The banner's one-line rule, read as CSS text: jsdom has no layout, so what
 * is assertable here is the declaration set that keeps the banner one line
 * tall at any viewport width — the sentence never wraps and is cut with an
 * ellipsis, and the reload button keeps its size.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/PageRefreshBanner.module.css', import.meta.url)),
  'utf8',
)

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when the rule is absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('PageRefreshBanner.module.css', () => {
  it('cuts the sentence on one line instead of wrapping it', () => {
    const text = declarations('.text')
    expect(text?.get('min-width')).toBe('0')
    expect(text?.get('white-space')).toBe('nowrap')
    expect(text?.get('overflow')).toBe('hidden')
    expect(text?.get('text-overflow')).toBe('ellipsis')
  })

  it('keeps the reload button whole beside a cut sentence', () => {
    expect(declarations('.banner > button')?.get('flex')).toBe('none')
  })
})
