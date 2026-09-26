/**
 * The ctx.layout face this shell provides: each transition forwards to the
 * bound panel actions, main-panel selection refuses an unregistered key and
 * supersedes a pending navigation, and disposal aborts the pending one.
 */
import { describe, expect, it, vi } from 'vitest'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { PanelFace } from '../src/client/panel-face.ts'
import type { BoundPanelActions } from '../src/client/panel-face.ts'

function fakePanels(): BoundPanelActions {
  return {
    selectPanel: vi.fn(), retainMainPanels: vi.fn(), toggleSidebar: vi.fn(),
    openRightbar: vi.fn(), closeRightbar: vi.fn(),
    openDrawer: vi.fn(), closeDrawer: vi.fn(), setNarrow: vi.fn(),
  }
}

const panelInfo: HostObservable<PanelInfo> = {
  getSnapshot: () => ({ activePanelId: null }),
  subscribe: () => () => {},
}

const SCHEDULE = 'schedule' as MainPanelId

describe('PanelFace', () => {
  it('forwards the sidebar and right-column transitions to the bound actions', () => {
    const panels = fakePanels()
    const face = new PanelFace(panels, () => true, panelInfo)

    face.toggleSidebar()
    face.openRightbar(true, false)
    face.closeRightbar()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.openRightbar).toHaveBeenCalledWith(true, false)
    expect(panels.closeRightbar).toHaveBeenCalledTimes(1)
    expect(face.panelInfo).toBe(panelInfo)
  })

  it('selects a registered main panel or the Conversation, and refuses an unregistered one', () => {
    const panels = fakePanels()
    const face = new PanelFace(panels, id => id === SCHEDULE, panelInfo)

    face.selectPanel(SCHEDULE)
    face.selectPanel(null)
    expect(panels.selectPanel).toHaveBeenNthCalledWith(1, SCHEDULE)
    expect(panels.selectPanel).toHaveBeenNthCalledWith(2, null)

    expect(() => { face.selectPanel('missing' as MainPanelId) }).toThrow(/"missing" is not registered/)
    expect(panels.selectPanel).toHaveBeenCalledTimes(2)
  })

  it('aborts the pending navigation on the next navigation, a selection, and disposal', () => {
    const face = new PanelFace(fakePanels(), () => true, panelInfo)

    const first = face.beginNavigation()
    const second = face.beginNavigation()
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)

    face.selectPanel(null)
    expect(second.aborted).toBe(true)

    const third = face.beginNavigation()
    face.dispose()
    expect(third.aborted).toBe(true)
  })
})
