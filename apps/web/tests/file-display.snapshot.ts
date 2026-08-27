// @vitest-environment jsdom
// Text-file attachment surfaces over the BUILT client graph (the
// code-mode-fixture idiom: real bundles via AppWebEntry, keyless
// FixtureApiClient transport). A live round trip: paste a text file into the
// composer, send it, and confirm the bubble renders the FileCard default and
// its click resolves the exact sent text through the authorized
// `session.file` route — proving the session log carries a ref
// (`FixtureApiClient` durably indexes the text by attachment id, never
// inline) and the referent/open seam's default expand fetches it back.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

const FILE_TEXT = '# fixture notes\nfirst line\nsecond line'

it('sends a pasted text file, renders its bubble card, and expands the exact text via loadFile', async () => {
  mountAssembledApp()

  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (start === null) throw new Error('fixture Workspace new-session action missing')
  fireEvent.click(start)

  const textarea = await screen.findByPlaceholderText('Describe what you want to build', {}, { timeout: 10_000 })
  const file = new File([FILE_TEXT], 'notes.txt', { type: 'text/plain' })
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'text/plain', getAsFile: () => file }],
      getData: () => '',
    },
  })

  // The paste routes through the async content sniff (file-sniff.ts) before
  // landing in the file chip row, a sibling of the image rail.
  const chipRow = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[role="group"][aria-label="Pending files"]')
    if (el === null) throw new Error('file chip row missing')
    return el
  }, { timeout: 5_000 })
  expect(within(chipRow).getByText('notes.txt')).toBeTruthy()

  fireEvent.keyDown(textarea, { key: 'Enter' })

  // The durable user/message lands synchronously inside the fixture's prompt
  // handler: the bubble's FileCard appears without waiting on any reply.
  const card = await waitFor(() => {
    const name = screen.getByText('notes.txt')
    const button = name.closest('button')
    if (button === null) throw new Error('file card head button missing')
    return button
  }, { timeout: 10_000 })
  expect(card.getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector('[role="group"][aria-label="Pending files"]')).toBeNull()

  // Clicking with no referent/open listener registered runs FileCard's own
  // default: expand and lazily resolve the text through loadFile, which the
  // fixture serves from ISession.readFile (session.file) keyed by the
  // attachment id the prompt handler minted — never from inline log content.
  fireEvent.click(card)
  await waitFor(() => { expect(card.getAttribute('aria-expanded')).toBe('true') })
  await waitFor(() => {
    const pre = card.closest('div')?.querySelector('pre')
    if (pre?.textContent !== FILE_TEXT) throw new Error('expanded file text mismatch')
  }, { timeout: 5_000 })

  // A second click collapses it again without losing the resolved text on re-expand.
  fireEvent.click(card)
  await waitFor(() => { expect(card.getAttribute('aria-expanded')).toBe('false') })
  fireEvent.click(card)
  await waitFor(() => {
    const pre = card.closest('div')?.querySelector('pre')
    expect(pre?.textContent).toBe(FILE_TEXT)
  })
})
