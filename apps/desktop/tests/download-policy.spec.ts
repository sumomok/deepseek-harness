/**
 * Which downloads the shell places itself, and the name it writes them under.
 * The Electron wiring around this decision needs a real session and is covered
 * by the real-process check instead; everything the handler decides is here.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { decideDownload, uniquePath, type DownloadRequest } from '../src/download-policy.ts'

const SERVER_ORIGIN = 'http://127.0.0.1:7777'
const DOWNLOADS = '/home/user/Downloads'
const EXPORT_URL = `${SERVER_ORIGIN}/api/session.export?sessionId=session-1&includeDescendants=true`

/** A request against an empty downloads folder with nothing in flight, with the fields a case cares about replaced. */
function request(overrides: Partial<DownloadRequest> = {}): DownloadRequest {
  return {
    urls: [EXPORT_URL],
    serverOrigin: SERVER_ORIGIN,
    filename: 'dsh-session-session-1.zip',
    downloadsDir: DOWNLOADS,
    claimed: new Set(),
    exists: () => false,
    ...overrides,
  }
}

/** A `taken` predicate that answers true for exactly these paths. */
function taken(...paths: readonly string[]): (candidate: string) => boolean {
  const set = new Set(paths)
  return candidate => set.has(candidate)
}

describe('decideDownload', () => {
  it('saves a download from the embedded server into the downloads folder', () => {
    expect(decideDownload(request())).toEqual({
      kind: 'save',
      path: '/home/user/Downloads/dsh-session-session-1.zip',
    })
  })

  it('saves a blob URL the served page minted for itself: its origin is the page origin', () => {
    expect(decideDownload(request({ urls: [`blob:${SERVER_ORIGIN}/9d1c1a24-0a2f-4d6e-9f36-1f1a5f0f2b77`] }))).toEqual({
      kind: 'save',
      path: '/home/user/Downloads/dsh-session-session-1.zip',
    })
  })

  it('leaves a blob URL minted by another origin to Electron', () => {
    expect(decideDownload(request({ urls: ['blob:https://example.com/9d1c1a24-0a2f-4d6e-9f36-1f1a5f0f2b77'] })))
      .toEqual({ kind: 'default', reason: 'other-origin' })
  })

  it('leaves another port, another host, and another scheme to Electron', () => {
    for (const url of [
      'http://127.0.0.1:7778/api/session.export',
      'http://localhost:7777/api/session.export',
      'https://127.0.0.1:7777/api/session.export',
    ]) {
      expect(decideDownload(request({ urls: [url] }))).toEqual({ kind: 'default', reason: 'other-origin' })
    }
  })

  it('leaves every URL that carries no origin of its own to Electron', () => {
    for (const url of [
      'data:application/zip;base64,UEsDBAoAAAAAAA==',
      'about:blank',
      'file:///etc/passwd',
      'blob:null/9d1c1a24-0a2f-4d6e-9f36-1f1a5f0f2b77',
      'not a url',
    ]) {
      expect(decideDownload(request({ urls: [url] }))).toEqual({ kind: 'default', reason: 'other-origin' })
    }
  })

  it('reads the whole redirect chain, not the URL it ended on', () => {
    // A transfer that started elsewhere is not the shell's to place, however it
    // ended up at the server; one that started at the server and left it is no
    // longer the server's file.
    expect(decideDownload(request({ urls: ['https://example.com/go', EXPORT_URL] })))
      .toEqual({ kind: 'default', reason: 'other-origin' })
    expect(decideDownload(request({ urls: [EXPORT_URL, 'https://example.com/elsewhere.zip'] })))
      .toEqual({ kind: 'default', reason: 'other-origin' })
    expect(decideDownload(request({ urls: [`${SERVER_ORIGIN}/api/session.export`, `${SERVER_ORIGIN}/api/blob/1`] })))
      .toEqual({ kind: 'save', path: '/home/user/Downloads/dsh-session-session-1.zip' })
  })

  it('leaves a download with no chain at all to Electron', () => {
    expect(decideDownload(request({ urls: [] }))).toEqual({ kind: 'default', reason: 'other-origin' })
  })

  it('keeps only the last path segment of the suggested name', () => {
    // Chromium sanitizes `getFilename()` before the shell sees it; the policy
    // strips separators itself so a written path can never leave the folder.
    expect(decideDownload(request({ filename: '../../etc/passwd' })))
      .toEqual({ kind: 'save', path: '/home/user/Downloads/passwd' })
    expect(decideDownload(request({ filename: '..\\..\\Windows\\System32\\drivers\\etc\\hosts' })))
      .toEqual({ kind: 'save', path: '/home/user/Downloads/hosts' })
    expect(decideDownload(request({ filename: 'nested/dsh-session-session-1.zip' })))
      .toEqual({ kind: 'save', path: '/home/user/Downloads/dsh-session-session-1.zip' })
  })

  it('falls back to a fixed name when the suggestion is only path syntax', () => {
    for (const filename of ['', '.', '..', '/', 'dir/']) {
      expect(decideDownload(request({ filename })))
        .toEqual({ kind: 'save', path: '/home/user/Downloads/download' })
    }
  })

  it('numbers around a name already in the folder', () => {
    expect(decideDownload(request({ exists: taken('/home/user/Downloads/dsh-session-session-1.zip') })))
      .toEqual({ kind: 'save', path: '/home/user/Downloads/dsh-session-session-1 (2).zip' })
  })

  it('numbers around a name an unfinished transfer already holds', () => {
    // Two gestures on one session suggest the same name, and nothing is on
    // disk under it until the first transfer writes; without the claim the
    // second download would be handed the first one's path.
    const claimed = new Set(['/home/user/Downloads/dsh-session-session-1.zip'])
    expect(decideDownload(request({ claimed })))
      .toEqual({ kind: 'save', path: '/home/user/Downloads/dsh-session-session-1 (2).zip' })
  })

  it('counts past both the folder and the transfers in flight', () => {
    const claimed = new Set(['/home/user/Downloads/dsh-session-session-1 (2).zip'])
    expect(decideDownload(request({ claimed, exists: taken('/home/user/Downloads/dsh-session-session-1.zip') })))
      .toEqual({ kind: 'save', path: '/home/user/Downloads/dsh-session-session-1 (3).zip' })
  })

  it('hands the download back rather than overwrite when every candidate name is taken', () => {
    expect(decideDownload(request({ exists: () => true }))).toEqual({ kind: 'default', reason: 'no-free-name' })
  })
})

describe('uniquePath', () => {
  it('returns the path unchanged when nothing occupies it', () => {
    expect(uniquePath('/d/a.zip', () => false)).toBe('/d/a.zip')
  })

  it('counts from 2 upwards, skipping every name already taken', () => {
    expect(uniquePath('/d/a.zip', taken('/d/a.zip'))).toBe('/d/a (2).zip')
    expect(uniquePath('/d/a.zip', taken('/d/a.zip', '/d/a (2).zip'))).toBe('/d/a (3).zip')
    expect(uniquePath('/d/a.zip', taken('/d/a.zip', '/d/a (2).zip', '/d/a (3).zip'))).toBe('/d/a (4).zip')
  })

  it('inserts the number before the last dot-suffix only', () => {
    // `extname` reads one suffix, so a double extension keeps its first half
    // in the stem: `session.tar.gz` numbers as `session.tar (2).gz`.
    expect(uniquePath('/d/session.tar.gz', taken('/d/session.tar.gz'))).toBe('/d/session.tar (2).gz')
  })

  it('appends the number when there is no extension to insert before', () => {
    expect(uniquePath('/d/export', taken('/d/export'))).toBe('/d/export (2)')
  })

  it('treats a leading dot as the name rather than an extension', () => {
    expect(uniquePath('/d/.zshrc', taken('/d/.zshrc'))).toBe('/d/.zshrc (2)')
  })

  it('gives up rather than return an occupied path', () => {
    expect(uniquePath('/d/a.zip', () => true)).toBeUndefined()
  })
})
