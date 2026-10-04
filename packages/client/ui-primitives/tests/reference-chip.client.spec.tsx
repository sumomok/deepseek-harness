// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReferenceChip, referenceLabelsOf } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('ReferenceChip', () => {
  it('renders only its label, also as the hover title, with no controls by default', () => {
    const { container } = render(<ReferenceChip label="新增" className="placed" />)
    const chip = container.querySelector('[data-reference-chip]')!
    expect(chip.textContent).toBe('新增')
    expect(chip.getAttribute('title')).toBe('新增')
    expect(chip.classList.contains('placed')).toBe(true)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers the owner action on the label and removal inside the chip', () => {
    const onActivate = vi.fn()
    const onRemove = vi.fn()
    const { container } = render(<ReferenceChip label="新增" onActivate={onActivate} remove={{ label: '移除「新增」', onRemove }} />)
    fireEvent.click(screen.getByRole('button', { name: '新增' }))
    expect(onActivate).toHaveBeenCalledOnce()
    const remove = screen.getByRole('button', { name: '移除「新增」' })
    expect(container.querySelector('[data-reference-chip]')!.contains(remove)).toBe(true)
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledOnce()
  })
})

describe('referenceLabelsOf', () => {
  it('reads labels in order from a source carrying references', () => {
    expect(referenceLabelsOf({ kind: 'user', references: [{ label: 'a', data: {} }, { label: 'b' }] })).toEqual(['a', 'b'])
  })

  it.each([undefined, null, 'user', { kind: 'user' }, { references: 'x' }])('reads no labels from %j', (source) => {
    expect(referenceLabelsOf(source)).toEqual([])
  })

  it('skips entries that are not objects with a string label', () => {
    expect(referenceLabelsOf({ references: [null, 1, { label: 2 }, {}, { label: 'kept' }] })).toEqual(['kept'])
  })
})
