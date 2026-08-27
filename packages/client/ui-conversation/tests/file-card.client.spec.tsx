// @vitest-environment jsdom
// FileCard's own default expand/collapse behavior and the referent/open seam
// it dispatches through: a click always resolves through `openReferent`, and
// this card's default is the terminus only while nothing claims the click.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { FileCard, type FileCardProps } from '../src/client/chat/FileCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

const attachment: FileAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
  name: 'notes.txt',
  bytes: 42,
}

/** Simulates the real seam's default path: no listener claims the click. */
const openReferentRunsDefault: FileCardProps['openReferent'] = (_ref, onDefault) => Promise.resolve(onDefault())

/** Simulates a listener claiming the click: the default never runs. */
const openReferentClaims: FileCardProps['openReferent'] = () => Promise.resolve()

describe('FileCard', () => {
  it('defaults to expanding on click and lazily fetches text through loadFile', async () => {
    const loadFile = vi.fn(() => Promise.resolve('line one\nline two'))
    const view = render(
      <FileCard attachment={attachment} loadFile={loadFile} openReferent={openReferentRunsDefault} t={t} />,
    )
    expect(view.getByText('notes.txt')).toBeTruthy()
    expect(view.queryByRole('status')).toBeNull()
    const head = view.getByRole('button')
    expect(head.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(head)
    expect(loadFile).toHaveBeenCalledExactlyOnceWith(attachment)
    await waitFor(() => { expect(head.getAttribute('aria-expanded')).toBe('true') })
    await waitFor(() => {
      expect(view.container.querySelector('pre')?.textContent).toBe('line one\nline two')
    })
  })

  it('shows a loading status while the fetch is pending, then replaces it with the text', async () => {
    let resolveText: (text: string) => void = () => {}
    const loadFile = vi.fn(() => new Promise<string>((resolve) => { resolveText = resolve }))
    const view = render(
      <FileCard attachment={attachment} loadFile={loadFile} openReferent={openReferentRunsDefault} t={t} />,
    )
    fireEvent.click(view.getByRole('button'))
    await waitFor(() => { expect(view.getByRole('status').textContent).toBe(t('file.loading')) })
    resolveText('resolved text')
    await waitFor(() => { expect(view.getByText('resolved text')).toBeTruthy() })
    expect(view.queryByRole('status')).toBeNull()
  })

  it('shows a load-failed alert when loadFile rejects, and does not cache the failure as text', async () => {
    const loadFile = vi.fn(() => Promise.reject(new Error('boom')))
    const view = render(
      <FileCard attachment={attachment} loadFile={loadFile} openReferent={openReferentRunsDefault} t={t} />,
    )
    fireEvent.click(view.getByRole('button'))
    await waitFor(() => { expect(view.getByRole('alert').textContent).toBe(t('file.loadFailed')) })
    expect(view.queryByRole('status')).toBeNull()
  })

  it('collapses on a second click without re-fetching an already-loaded text', async () => {
    const loadFile = vi.fn(() => Promise.resolve('cached text'))
    const view = render(
      <FileCard attachment={attachment} loadFile={loadFile} openReferent={openReferentRunsDefault} t={t} />,
    )
    const head = view.getByRole('button')
    fireEvent.click(head)
    await waitFor(() => { expect(view.getByText('cached text')).toBeTruthy() })

    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('cached text')).toBeNull()

    fireEvent.click(head)
    await waitFor(() => { expect(view.getByText('cached text')).toBeTruthy() })
    expect(loadFile).toHaveBeenCalledOnce()
  })

  it('a listener that claims the referent/open dispatch suppresses the default expand entirely', async () => {
    const loadFile = vi.fn(() => Promise.resolve('never shown'))
    const view = render(
      <FileCard attachment={attachment} loadFile={loadFile} openReferent={openReferentClaims} t={t} />,
    )
    const head = view.getByRole('button')
    fireEvent.click(head)
    await Promise.resolve()
    await Promise.resolve()
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(loadFile).not.toHaveBeenCalled()
    expect(view.queryByText('never shown')).toBeNull()
  })

  it('dispatches the referent/open ref shaped for this attachment on click', () => {
    const openReferent = vi.fn(openReferentRunsDefault)
    const view = render(
      <FileCard attachment={attachment} loadFile={() => Promise.resolve('')} openReferent={openReferent} t={t} />,
    )
    fireEvent.click(view.getByRole('button'))
    expect(openReferent).toHaveBeenCalledExactlyOnceWith(
      {
        kind: 'file',
        target: attachment.name,
        raw: attachment.name,
        attachment,
        source: 'message-file-card',
        provenance: 'structured',
      },
      expect.any(Function),
    )
  })
})
