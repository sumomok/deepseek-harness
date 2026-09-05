// @vitest-environment jsdom
/**
 * The arrangement half of a spec: what the seat makes of one call's `layout`,
 * and what that becomes in the DOM.
 *
 * Two claims, and the second is why the first is lenient. Reading is the wire
 * edge's: the host has already judged the tree and told the model what it
 * refused, so what is left here runs over a payload nobody is waiting on — a
 * checkpoint another build wrote, or a subset of blocks because one of them is
 * waiting on the block that feeds it. Every tree this build cannot make sense
 * of therefore has one answer, the plain column, and the cases below are that
 * answer stated once per way of getting it wrong.
 *
 * The drawing is flex and nothing else: a direction, one of three gaps, whether
 * a row wraps, and a share of what is left over.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { readLayout, type BlockStack } from '../src/client/layout.ts'
import { StackLayout } from '../src/client/StackLayout.tsx'

afterEach(cleanup)

/** The two blocks every reading here arranges, in the order a call wrote them. */
const BLOCKS: ReadonlyMap<string, string> = new Map([['q', 'Q'], ['t', 'T']])

/** One block child of a stack. */
function place(id: string, flex?: number): Record<string, unknown> {
  return flex === undefined ? { node: 'component', id } : { node: 'component', id, flex }
}

/** Every block the arrangement places, in the order it places them. */
function placed(layout: BlockStack<string>): string[] {
  return layout.children.flatMap(child => (child.node === 'component' ? [child.block] : placed(child)))
}

/** The plain column a spec that declares no arrangement gets. */
const PLAIN = { node: 'stack', dir: 'col', gap: 'md', wrap: false }

describe('reading one call arrangement', () => {
  it('stacks the blocks in call order when the call declared no arrangement', () => {
    const layout = readLayout(undefined, BLOCKS)
    expect(layout).toMatchObject(PLAIN)
    expect(placed(layout)).toEqual(['Q', 'T'])
  })

  it('reads the direction, the gap, the wrap and each block share the call declared', () => {
    const layout = readLayout({
      node: 'stack',
      dir: 'row',
      gap: 'lg',
      wrap: true,
      children: [place('q', 1), place('t', 2)],
    }, BLOCKS)
    expect(layout).toMatchObject({ node: 'stack', dir: 'row', gap: 'lg', wrap: true })
    expect(layout.children).toEqual([
      { node: 'component', block: 'Q', flex: 1 },
      { node: 'component', block: 'T', flex: 2 },
    ])
  })

  it('fills in the gap and the wrap a stack left out', () => {
    const layout = readLayout({ node: 'stack', dir: 'row', children: [place('q'), place('t')] }, BLOCKS)
    expect(layout).toMatchObject({ dir: 'row', gap: 'md', wrap: false })
  })

  it('reads the share a nested stack asks for, the way it reads a block\'s', () => {
    const layout = readLayout({
      node: 'stack',
      dir: 'row',
      children: [place('q', 1), { node: 'stack', dir: 'col', flex: 3, children: [place('t')] }],
    }, BLOCKS)
    expect(layout.children[1]).toMatchObject({ node: 'stack', dir: 'col', flex: 3 })
  })

  it('carries the blocks themselves down through nested stacks', () => {
    const layout = readLayout({
      node: 'stack',
      dir: 'col',
      children: [place('q'), { node: 'stack', dir: 'row', children: [place('t')] }],
    }, BLOCKS)
    expect(placed(layout)).toEqual(['Q', 'T'])
  })

  it.each([
    ['a tree that is not an object at all', 'row'],
    ['a tree that is null', null],
    ['a tree that is a list', [place('q'), place('t')]],
    ['a root that is not a stack', { node: 'component', id: 'q' }],
    ['a property no stack carries', { node: 'stack', dir: 'row', align: 'end', children: [place('q'), place('t')] }],
    ['a direction outside the two', { node: 'stack', dir: 'diagonal', children: [place('q'), place('t')] }],
    ['a stack with no direction, which the host requires', { node: 'stack', children: [place('q'), place('t')] }],
    ['a nested stack with no direction', { node: 'stack', dir: 'row', children: [place('q'), { node: 'stack', children: [place('t')] }] }],
    ['a share of none on a nested stack', { node: 'stack', dir: 'row', children: [place('q'), { node: 'stack', dir: 'col', flex: 0, children: [place('t')] }] }],
    // The host refuses this one by name; here there is nobody to tell, so it is
    // read the way every other tree this build cannot make sense of is.
    ['a share on the outermost stack, which sits in nothing', { node: 'stack', dir: 'row', flex: 2, children: [place('q'), place('t')] }],
    ['a gap outside the three', { node: 'stack', dir: 'row', gap: 'xl', children: [place('q'), place('t')] }],
    ['a wrap that is not a boolean', { node: 'stack', dir: 'row', wrap: 'yes', children: [place('q'), place('t')] }],
    ['a stack holding no children', { node: 'stack', dir: 'row', children: [] }],
    ['children that are not a list', { node: 'stack', dir: 'row', children: { q: place('q') } }],
    ['a child that is not an object', { node: 'stack', dir: 'row', children: ['q', 't'] }],
    ['a property no placed block carries', { node: 'stack', dir: 'row', children: [{ ...place('q'), width: 200 }, place('t')] }],
    ['a block named by something other than a string', { node: 'stack', dir: 'row', children: [place('q'), { node: 'component', id: 7 }] }],
    ['a block this entry does not draw', { node: 'stack', dir: 'row', children: [place('q'), place('t'), place('gone')] }],
    ['a block placed twice', { node: 'stack', dir: 'row', children: [place('q'), place('t'), place('q')] }],
    ['a block left unplaced', { node: 'stack', dir: 'row', children: [place('q')] }],
    ['a share that is not a whole number', { node: 'stack', dir: 'row', children: [place('q', 1.5), place('t')] }],
    ['a share of none', { node: 'stack', dir: 'row', children: [place('q', 0), place('t')] }],
    ['a share past the ceiling', { node: 'stack', dir: 'row', children: [place('q', 13), place('t')] }],
    ['more children than there could be blocks', {
      node: 'stack',
      dir: 'row',
      children: [place('q'), place('t'), ...Array.from({ length: 12 }, () => ({ node: 'stack', dir: 'row', children: [] }))],
    }],
    ['stacks nested deeper than the ceiling', {
      node: 'stack',
      dir: 'col',
      children: [{
        node: 'stack',
        dir: 'col',
        children: [{
          node: 'stack',
          dir: 'col',
          children: [{ node: 'stack', dir: 'col', children: [place('q'), place('t')] }],
        }],
      }],
    }],
  ])('falls back to the plain column for %s', (_case, declared) => {
    const layout = readLayout(declared, BLOCKS)
    expect(layout).toMatchObject(PLAIN)
    expect(placed(layout)).toEqual(['Q', 'T'])
  })

  it('accepts stacks nested up to the ceiling', () => {
    const layout = readLayout({
      node: 'stack',
      dir: 'col',
      children: [{
        node: 'stack',
        dir: 'col',
        children: [{ node: 'stack', dir: 'row', children: [place('q'), place('t')] }],
      }],
    }, BLOCKS)
    expect(placed(layout)).toEqual(['Q', 'T'])
  })
})

describe('drawing one arrangement', () => {
  it('draws each stack as a flex box saying which way it runs, how far apart, and whether it wraps', () => {
    const layout = readLayout({
      node: 'stack',
      dir: 'row',
      gap: 'lg',
      wrap: true,
      children: [place('q', 3), { node: 'stack', dir: 'col', gap: 'sm', children: [place('t')] }],
    }, BLOCKS)
    const view = render(<StackLayout layout={layout} renderBlock={block => <span>{block}</span>} />)
    const stacks = view.container.querySelectorAll('[data-component-stack]')
    expect([...stacks].map(stack => stack.getAttribute('data-component-stack'))).toEqual(['row', 'col'])
    expect(stacks[0]?.getAttribute('data-component-gap')).toBe('lg')
    expect(stacks[0]?.getAttribute('data-component-wrap')).toBe('wrap')
    expect(stacks[1]?.getAttribute('data-component-gap')).toBe('sm')
    // The inner stack declared no wrap, so nothing says it does.
    expect(stacks[1]?.getAttribute('data-component-wrap')).toBeNull()
    // The share is a share of what is left over, so it reaches the cell as a
    // growth factor rather than as a width.
    expect((stacks[0]?.firstElementChild as HTMLElement).style.flexGrow).toBe('3')
    expect(view.getByText('Q')).toBeTruthy()
    expect(view.getByText('T')).toBeTruthy()
  })

  it('divides a row between a block and a nested stack by the shares they asked for', () => {
    const layout = readLayout({
      node: 'stack',
      dir: 'row',
      children: [place('q', 1), { node: 'stack', dir: 'col', flex: 3, children: [place('t')] }],
    }, BLOCKS)
    const view = render(<StackLayout layout={layout} renderBlock={block => <span>{block}</span>} />)
    const cells = view.container.querySelectorAll(':scope > [data-component-stack] > div')
    expect([...cells].map(cell => (cell as HTMLElement).style.flexGrow)).toEqual(['1', '3'])
  })

  it('leaves a block that declared no share to its own size', () => {
    const layout = readLayout(undefined, BLOCKS)
    const view = render(<StackLayout layout={layout} renderBlock={block => <span>{block}</span>} />)
    const cells = view.container.querySelectorAll('[data-component-stack] > div')
    expect([...cells].map(cell => (cell as HTMLElement).style.flexGrow)).toEqual(['', ''])
  })

  it('draws one block per placement and no more', () => {
    const renderBlock = vi.fn((block: string) => <span>{block}</span>)
    render(<StackLayout layout={readLayout(undefined, BLOCKS)} renderBlock={renderBlock} />)
    expect(renderBlock.mock.calls.map(([block]) => block)).toEqual(['Q', 'T'])
  })
})
