/**
 * The ctx.layout face this shell provides: the three transitions forward to
 * whichever bound action set is attached, an unwired call fails loud rather
 * than dropping the gesture, and re-attaching replaces a stale set (which is
 * what an entry re-register produces).
 */
import { describe, expect, it, vi } from 'vitest'
import { createPanelFace } from '../src/client/panel-face.ts'
import type { BoundPanelActions } from '../src/client/panel-face.ts'

function fakePanels(): BoundPanelActions {
  return { toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn() }
}

describe('createPanelFace', () => {
  it('forwards each transition to the attached action set', () => {
    const face = createPanelFace()
    const panels = fakePanels()
    face.attach(panels)

    face.layout.toggleSidebar()
    face.layout.openDetails()
    face.layout.closeDetails()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
  })

  it('fails loud before the root entry wired its actions', () => {
    const { layout } = createPanelFace()
    expect(() => { layout.toggleSidebar() }).toThrow(/panel actions not wired/)
    expect(() => { layout.openDetails() }).toThrow(/panel actions not wired/)
    expect(() => { layout.closeDetails() }).toThrow(/panel actions not wired/)
  })

  it('re-attach replaces the stale action set (entry re-register)', () => {
    const face = createPanelFace()
    const stale = fakePanels()
    const fresh = fakePanels()
    face.attach(stale)
    face.attach(fresh)

    face.layout.toggleSidebar()

    expect(stale.toggleSidebar).not.toHaveBeenCalled()
    expect(fresh.toggleSidebar).toHaveBeenCalledTimes(1)
  })
})
