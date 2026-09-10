// @vitest-environment jsdom
/**
 * The shared export panel: an indeterminate bar until the Host announces the
 * archive's extent, a determinate one with entry and size counts after, a
 * settled completion state, a failure that names its reason, and a footer that
 * cancels the transfer while it runs and closes the panel once it has settled.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import { SessionLogDownloadDialog } from '../src/client/Dialog.tsx'
import type { SessionLogDownloadDialogProps } from '../src/client/Dialog.tsx'
import { en } from '../src/client/locales.ts'
import { SESSION_EXPORT_PROGRESS_START, type SessionExportProgress } from '../src/client/progress.ts'

const SID = 'session-export-dialog' as SessionId

/** The runtime's own `{name}` interpolation, so the fixtures read what users read. */
function translate(key: keyof typeof en, params?: Record<string, string | number>): string {
  return en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
}

function bench(
  controller = new SessionLogDownloadController(async () => new Response('zip', { status: 200 }), vi.fn()),
) {
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  const cancel = vi.fn((sessionId: SessionId) => { controller.cancel(sessionId) })
  function useSessionLogDownload<T>(selector: (state: ReturnType<typeof controller.store.getSnapshot>) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
  const props = {
    sessionId: SID, useSessionLogDownload, dismiss, cancel, t: translate,
  } as unknown as SessionLogDownloadDialogProps
  const view = render(<SessionLogDownloadDialog {...props} />)
  return { controller, dismiss, cancel, view }
}

function show(
  controller: SessionLogDownloadController,
  status: 'downloading' | 'success' | 'error',
  progress: SessionExportProgress = SESSION_EXPORT_PROGRESS_START,
  error: string | null = null,
): void {
  act(() => {
    controller.store.set({ bySession: { [SID]: { open: true, status, error, progress } } })
  })
}

afterEach(cleanup)

describe('SessionLogDownloadDialog', () => {
  it('shows an indeterminate bar until the host announces the archive extent', async () => {
    const b = bench()
    show(b.controller, 'downloading')

    const dialog = await b.view.findByRole('dialog', { name: 'Exporting Session' })
    const bar = b.view.getByRole('progressbar', { name: 'Export progress' })
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
    expect(bar.firstElementChild?.getAttribute('style')).toBeNull()
    expect(dialog.textContent).toContain('Exported 0 B')
  })

  it('keeps a single-entry archive indeterminate when the host announced no wire estimate', async () => {
    const b = bench()
    show(b.controller, 'downloading', {
      fraction: null, entriesDone: 0, entriesTotal: 1, receivedBytes: 40_960,
    })

    const dialog = await b.view.findByRole('dialog', { name: 'Exporting Session' })
    // The entry count never reaches the panel: with one entry it would read
    // 0/1 for the whole transfer.
    expect(dialog.textContent).toContain('Exported 40 KB')
    expect(dialog.textContent).not.toContain('0/1')
    expect(b.view.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  })

  it('shows the received size and the announced fraction once it can', async () => {
    const b = bench()
    show(b.controller, 'downloading', {
      fraction: 0.5, entriesDone: 2, entriesTotal: 4, receivedBytes: 1024,
    })

    const dialog = await b.view.findByRole('dialog', { name: 'Exporting Session' })
    expect(dialog.textContent).toContain('Exported 1 KB')
    expect(dialog.textContent).not.toContain('2/4')
    const bar = b.view.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('50')
    expect(bar.firstElementChild?.getAttribute('style')).toBe('width: 50%;')
  })

  it('cancels the transfer from the footer while it runs', async () => {
    const b = bench()
    show(b.controller, 'downloading')

    const action = await b.view.findByRole('button', { name: 'Cancel' })
    fireEvent.click(action)
    await waitFor(() => { expect(b.cancel).toHaveBeenCalledWith(SID) })
    expect(b.dismiss).not.toHaveBeenCalled()
  })

  it('closes without cancelling from the header control while it runs', async () => {
    const b = bench()
    show(b.controller, 'downloading')

    await b.view.findByRole('dialog', { name: 'Exporting Session' })
    const close = b.view.getAllByRole('button', { name: 'Close' })[0]
    if (close === undefined) throw new Error('Session export panel has no close control')
    fireEvent.click(close)
    await waitFor(() => { expect(b.dismiss).toHaveBeenCalledWith(SID) })
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('reports completion with a full bar and the browser hand-off', async () => {
    const b = bench()
    show(b.controller, 'success', { fraction: 1, entriesDone: 4, entriesTotal: 4, receivedBytes: 2048 })

    const dialog = await b.view.findByRole('dialog', { name: 'Export complete' })
    expect(dialog.textContent).toContain('Handed to the browser to save.')
    expect(dialog.textContent).toContain('Exported 2 KB')
    expect(b.view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  })

  it('names the failure reason and drops the bar', async () => {
    const b = bench()
    show(b.controller, 'error', SESSION_EXPORT_PROGRESS_START, 'HTTP 500 backend unavailable')

    const dialog = await b.view.findByRole('dialog', { name: 'Export failed' })
    expect(dialog.textContent).toContain('HTTP 500 backend unavailable')
    expect(b.view.queryByRole('progressbar')).toBeNull()
    const close = b.view.getAllByRole('button', { name: 'Close' }).at(-1)
    if (close === undefined) throw new Error('Session export panel has no footer action')
    fireEvent.click(close)
    await waitFor(() => { expect(b.dismiss).toHaveBeenCalledWith(SID) })
  })

  it('uses fallback copy when a failure has no detail', async () => {
    const b = bench()
    show(b.controller, 'error', SESSION_EXPORT_PROGRESS_START, '')

    const dialog = await b.view.findByRole('dialog', { name: 'Export failed' })
    expect(dialog.textContent).toContain('Could not start the Session export.')
  })

  it('renders nothing for a Session with no export state', () => {
    const b = bench()
    expect(b.view.queryByRole('dialog')).toBeNull()
  })
})
