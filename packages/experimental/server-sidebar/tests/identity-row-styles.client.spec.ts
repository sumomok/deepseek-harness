/**
 * The footer identity band's one-row rule, read as CSS text: jsdom has no
 * layout, so what is assertable here is the declaration set that decides
 * which part of the band gives ground when the column is narrow — the band
 * never wraps, the identity cluster absorbs the shortfall, the name
 * truncates, and the settings seat holds the size its occupant draws.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/ServerSidebarRoot.module.css', import.meta.url)),
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

describe('ServerSidebarRoot.module.css identity band', () => {
  it('keeps the signed-in name and the settings seat on one row', () => {
    expect(declarations('.identityRow')?.get('flex-wrap')).toBe('nowrap')
    expect(declarations('.identityRow')?.get('justify-content')).toBe('space-between')
    expect(declarations('.identityRow')?.get('min-width')).toBe('0')
  })

  it('spends the row\'s shortfall on the identity cluster, never on the settings seat', () => {
    expect(declarations('.avatarRow')?.get('flex')).toBe('1 1 auto')
    expect(declarations('.avatarRow')?.get('min-width')).toBe('0')
    expect(declarations('.settingsArea')?.get('flex')).toBe('none')
  })

  it('truncates the name and keeps the sign-out label whole', () => {
    expect(declarations('.avatarName')?.get('min-width')).toBe('0')
    expect(declarations('.avatarName')?.get('overflow')).toBe('hidden')
    expect(declarations('.avatarName')?.get('text-overflow')).toBe('ellipsis')
    expect(declarations('.avatarName')?.get('white-space')).toBe('nowrap')
    expect(declarations('.signOut')?.get('flex')).toBe('none')
  })
})
