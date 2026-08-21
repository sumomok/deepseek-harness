// @vitest-environment jsdom
/**
 * Theme projection behavior: what a snapshot writes to the document, that a
 * second projection retracts exactly the token names the first wrote (a token
 * dropped between themes must not linger), and that retraction restores the
 * pre-shell document while leaving foreign inline variables alone.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { DARK_PALETTE_ATTRIBUTE, projectTheme, retractTheme } from '../src/client/theme-projection.ts'

/** One resolved snapshot; only `active` reaches the document. */
function snapshot(colorScheme: 'light' | 'dark', tokens: Record<string, string> = {}): ThemeSnapshot {
  const active = { id: colorScheme, colorScheme, tokens }
  return { preference: colorScheme, active, themes: [active], revision: 1 }
}

afterEach(() => {
  document.body.removeAttribute('style')
  document.body.removeAttribute(DARK_PALETTE_ATTRIBUTE)
  document.documentElement.removeAttribute('style')
})

describe('projectTheme', () => {
  it('writes the root color scheme, the palette attribute, and the active tokens', () => {
    const applied = projectTheme(snapshot('dark', { '--dsw-alias-bg-base': 'rgb(1, 2, 3)' }), [])

    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_PALETTE_ATTRIBUTE)).toBe(true)
    expect(document.body.style.getPropertyValue('--dsw-alias-bg-base')).toBe('rgb(1, 2, 3)')
    expect(applied).toEqual(['--dsw-alias-bg-base'])
  })

  it('drops the palette attribute for a light snapshot', () => {
    projectTheme(snapshot('dark'), [])
    projectTheme(snapshot('light'), [])
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_PALETTE_ATTRIBUTE)).toBe(false)
  })

  it('removes a token the next theme no longer defines', () => {
    const applied = projectTheme(snapshot('light', { '--dsw-alias-brand-primary': 'red' }), [])
    projectTheme(snapshot('light', { '--dsw-alias-label-primary': 'blue' }), applied)

    expect(document.body.style.getPropertyValue('--dsw-alias-brand-primary')).toBe('')
    expect(document.body.style.getPropertyValue('--dsw-alias-label-primary')).toBe('blue')
  })
})

describe('retractTheme', () => {
  it('restores the document to its pre-shell state', () => {
    const applied = projectTheme(snapshot('dark', { '--dsw-alias-bg-base': 'black' }), [])
    retractTheme(applied)

    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute(DARK_PALETTE_ATTRIBUTE)).toBe(false)
    expect(document.body.style.getPropertyValue('--dsw-alias-bg-base')).toBe('')
  })

  it('leaves an inline variable the projection never wrote', () => {
    document.body.style.setProperty('--foreign-token', 'green')
    retractTheme(projectTheme(snapshot('light', { '--dsw-alias-bg-base': 'white' }), []))
    expect(document.body.style.getPropertyValue('--foreign-token')).toBe('green')
  })
})
