// @vitest-environment jsdom
/**
 * `CompactionRows`: what the console shows for a compaction that landed or
 * failed, in both languages. Neither row carries a count, a token figure, or
 * a control that would open the summary.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CompactedRow, CompactionFailedRow, type CompactedRowProps } from '../src/client/CompactionRows.tsx'
import { en, zh } from '../src/client/locales.ts'

/**
 * A `t` over one dictionary.
 * @param dictionary - the locale table to read.
 * @returns the lookup both rows receive.
 */
function lookup(dictionary: typeof zh): CompactedRowProps['t'] {
  return key => (dictionary as Record<string, string>)[key] ?? key
}

afterEach(() => {
  cleanup()
})

describe('CompactedRow', () => {
  it('says the earlier conversation was compacted, with nothing to press and no figure', () => {
    const { container } = render(<CompactedRow t={lookup(zh)} />)
    const row = container.querySelector('[data-server-sidebar-compaction="completed"]')
    expect(row?.textContent).toBe('已压缩较早的对话')
    expect(screen.queryByRole('button')).toBeNull()
    expect(row?.textContent).not.toMatch(/\d|tokens/u)
  })

  it('reads in English under the English dictionary', () => {
    const { container } = render(<CompactedRow t={lookup(en)} />)
    expect(container.querySelector('[data-server-sidebar-compaction="completed"]')?.textContent)
      .toBe('Earlier conversation compacted')
  })
})

describe('CompactionFailedRow', () => {
  it('reports the failure as one status line', () => {
    render(<CompactionFailedRow t={lookup(zh)} />)
    const row = screen.getByRole('status')
    expect(row.textContent).toBe('较早的对话压缩失败')
    expect(row.getAttribute('data-server-sidebar-compaction')).toBe('failed')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reads in English under the English dictionary', () => {
    render(<CompactionFailedRow t={lookup(en)} />)
    expect(screen.getByRole('status').textContent).toBe('Couldn’t compact the earlier conversation')
  })
})
