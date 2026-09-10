/**
 * Which downloads the shell takes over, what its save dialog offers, and what
 * a finished transfer is reported as. The Electron wiring around these
 * decisions needs a real session and is covered by the real-process check
 * instead; everything the handler decides is here.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { decideDownload, downloadOutcome, uniquePath, type DownloadRequest } from '../src/download-policy.ts'

const SERVER_ORIGIN = 'http://127.0.0.1:7777'
const DOWNLOADS = '/home/user/Downloads'
const EXPORT_URL = `${SERVER_ORIGIN}/api/session.export?sessionId=session-1&includeDescendants=true`

/** Everything the dialog carries for a download named `dsh-session-session-1.zip`. */
const DIALOG = {
  title: '保存文件',
  message: '保存 dsh-session-session-1.zip',
  buttonLabel: '保存',
}

/** A request against an empty downloads folder, with the fields a case cares about replaced. */
function request(overrides: Partial<DownloadRequest> = {}): DownloadRequest {
  return {
    urls: [EXPORT_URL],
    serverOrigin: SERVER_ORIGIN,
    filename: 'dsh-session-session-1.zip',
    downloadsDir: DOWNLOADS,
    exists: () => false,
    ...overrides,
  }
}

/** The path a taken-over download's dialog opens on. */
function offered(overrides: Partial<DownloadRequest> = {}): string | undefined {
  const decision = decideDownload(request(overrides))
  if (decision.kind !== 'ask') throw new Error(`expected a dialog, got ${decision.kind}`)
  return decision.dialog.defaultPath
}

/** A `taken` predicate that answers true for exactly these paths. */
function taken(...paths: readonly string[]): (candidate: string) => boolean {
  const set = new Set(paths)
  return candidate => set.has(candidate)
}

describe('decideDownload', () => {
  it('asks where to save a download from the embedded server, offering the downloads folder', () => {
    expect(decideDownload(request())).toEqual({
      kind: 'ask',
      dialog: { ...DIALOG, defaultPath: '/home/user/Downloads/dsh-session-session-1.zip' },
    })
  })

  it('names the file it was handed and constrains nothing about it', () => {
    // Every attachment the embedded server serves arrives here, not only the
    // session-log export: the sidebar downloads workspace files over the same
    // origin. A `zip` filter would rename them — macOS maps `filters` onto
    // `setAllowedFileTypes:` and Electron sets no `allowsOtherFileTypes`.
    expect(decideDownload(request({
      urls: [`${SERVER_ORIGIN}/sidebar/file?sessionId=session-1&path=report.pdf&download=1`],
      filename: 'report.pdf',
    }))).toEqual({
      kind: 'ask',
      dialog: {
        title: '保存文件',
        message: '保存 report.pdf',
        buttonLabel: '保存',
        defaultPath: '/home/user/Downloads/report.pdf',
      },
    })
  })

  it('asks about a blob URL the served page minted for itself: its origin is the page origin', () => {
    expect(offered({ urls: [`blob:${SERVER_ORIGIN}/9d1c1a24-0a2f-4d6e-9f36-1f1a5f0f2b77`] }))
      .toBe('/home/user/Downloads/dsh-session-session-1.zip')
  })

  it('leaves a blob URL minted by another origin to Electron', () => {
    expect(decideDownload(request({ urls: ['blob:https://example.com/9d1c1a24-0a2f-4d6e-9f36-1f1a5f0f2b77'] })))
      .toEqual({ kind: 'default' })
  })

  it('leaves another port, another host, and another scheme to Electron', () => {
    for (const url of [
      'http://127.0.0.1:7778/api/session.export',
      'http://localhost:7777/api/session.export',
      'https://127.0.0.1:7777/api/session.export',
    ]) {
      expect(decideDownload(request({ urls: [url] }))).toEqual({ kind: 'default' })
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
      expect(decideDownload(request({ urls: [url] }))).toEqual({ kind: 'default' })
    }
  })

  it('reads the whole redirect chain, not the URL it ended on', () => {
    // A transfer that started elsewhere is not the shell's to take over,
    // however it ended up at the server; one that started at the server and
    // left it is no longer the server's file.
    expect(decideDownload(request({ urls: ['https://example.com/go', EXPORT_URL] }))).toEqual({ kind: 'default' })
    expect(decideDownload(request({ urls: [EXPORT_URL, 'https://example.com/elsewhere.zip'] })))
      .toEqual({ kind: 'default' })
    expect(offered({ urls: [`${SERVER_ORIGIN}/api/session.export`, `${SERVER_ORIGIN}/api/blob/1`] }))
      .toBe('/home/user/Downloads/dsh-session-session-1.zip')
  })

  it('leaves a download with no chain at all to Electron', () => {
    expect(decideDownload(request({ urls: [] }))).toEqual({ kind: 'default' })
  })

  it('keeps only the last path segment of the suggested name', () => {
    // Chromium sanitizes `getFilename()` before the shell sees it; the policy
    // strips separators itself so the offered path can never leave the folder.
    expect(offered({ filename: '../../etc/passwd' })).toBe('/home/user/Downloads/passwd')
    expect(offered({ filename: '..\\..\\Windows\\System32\\drivers\\etc\\hosts' })).toBe('/home/user/Downloads/hosts')
    expect(offered({ filename: 'nested/dsh-session-session-1.zip' }))
      .toBe('/home/user/Downloads/dsh-session-session-1.zip')
  })

  it('falls back to a fixed name when the suggestion is only path syntax', () => {
    for (const filename of ['', '.', '..', '/', 'dir/']) {
      expect(offered({ filename })).toBe('/home/user/Downloads/download')
    }
  })

  it('numbers around a name already in the folder', () => {
    expect(offered({ exists: taken('/home/user/Downloads/dsh-session-session-1.zip') }))
      .toBe('/home/user/Downloads/dsh-session-session-1 (2).zip')
  })

  it('offers the plain name when every candidate is taken', () => {
    // The offer is a suggestion in a dialog the user can retype, and the
    // system asks before replacing anything, so an occupied name is a worse
    // starting point rather than an overwrite.
    expect(offered({ exists: () => true })).toBe('/home/user/Downloads/dsh-session-session-1.zip')
  })
})

describe('downloadOutcome', () => {
  it('logs where a completed transfer landed and reveals it there', () => {
    expect(downloadOutcome('completed', '/d/exports/dsh-session-session-1.zip', 'dsh-session-session-1.zip')).toEqual({
      line: '[desktop] download saved: /d/exports/dsh-session-session-1.zip\n',
      reveal: '/d/exports/dsh-session-session-1.zip',
    })
  })

  it('logs a dismissed dialog under the name the download suggested', () => {
    // Dismissing the dialog ends the transfer before any path exists, so
    // `getSavePath()` is empty and the suggestion is all there is to name.
    expect(downloadOutcome('cancelled', '', 'dsh-session-session-1.zip')).toEqual({
      line: '[desktop] download cancelled: dsh-session-session-1.zip\n',
    })
  })

  it('logs a cancellation after a path was chosen under that path', () => {
    expect(downloadOutcome('cancelled', '/d/exports/dsh-session-session-1.zip', 'dsh-session-session-1.zip')).toEqual({
      line: '[desktop] download cancelled: /d/exports/dsh-session-session-1.zip\n',
    })
  })

  it('tells the user a failed transfer wrote nothing, naming the file alone', () => {
    // The bytes come off loopback and the export's are already in the page's
    // memory when its `blob:` download starts, so this ending is a write
    // failure — a full volume, a location that is not writable.
    expect(downloadOutcome('interrupted', '/d/exports/dsh-session-session-1.zip', 'dsh-session-session-1.zip')).toEqual({
      line: '[desktop] download interrupted: /d/exports/dsh-session-session-1.zip\n',
      alert: {
        message: '文件没有保存成功',
        detail: 'dsh-session-session-1.zip:写入失败,请检查保存位置后重试。',
      },
    })
  })

  it('names the suggestion when a transfer failed before a path existed', () => {
    expect(downloadOutcome('interrupted', '', 'dsh-session-session-1.zip')).toEqual({
      line: '[desktop] download interrupted: dsh-session-session-1.zip\n',
      alert: {
        message: '文件没有保存成功',
        detail: 'dsh-session-session-1.zip:写入失败,请检查保存位置后重试。',
      },
    })
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
