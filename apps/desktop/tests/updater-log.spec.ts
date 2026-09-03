/**
 * Which of electron-updater's own log lines reach `dsh-server.log`, and what
 * the one line among them that reports an already-recovered failure reads as
 * once it gets there.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { updaterLogLine } from '../src/updater-log.ts'

/** The prefix every caught differential-download failure is reported with. */
const FALLBACK = 'Cannot download differentially, fallback to full download: '

/**
 * The 217-character message `DigestTransform.validate` throws
 * (`builder-util-runtime/out/httpExecutor.js:431`), with two real base64
 * sha512 digests — the longest first line the rewrite has to carry whole.
 */
const CHECKSUM_MISMATCH
  = 'sha512 checksum mismatch, expected H0D8ktokFpR1CXnubPWC8tXX0o4YM13gWrxU0FYOD1MChgxlK/CNVgJSql50IQVG82n7u86MEs/HlXsmUv6adQ==,'
    + ' got Umd2iCLuYk1I/OFexcp5y9YCy39MIVelFlVpkfIu+Me173sY0f9BxZNw77CFhlHUSpNsEbexRMSP4E3zxqPo2g=='

/**
 * The entry the rewrite produces for one reason.
 * @param reason - what the line names as having stopped the differential download.
 * @returns the whole expected entry, newline included.
 */
const rewritten = (reason: string): string =>
  `[updater] differential download unavailable (${reason}); this update transfers the whole artifact\n`

describe('updaterLogLine', () => {
  it('drops the plan dump, the range lines, the blockmap duplicates and the Squirrel proxy trace', () => {
    expect(updaterLogLine('debug', JSON.stringify([{ kind: 0, start: 0, end: 65_536 }], null, 2))).toBeNull()
    expect(updaterLogLine('debug', 'e0f5 duplicated in blockmap (same size), it doesn\'t lead to broken differential downloader')).toBeNull()
    expect(updaterLogLine('debug', 'download range: bytes=0-65535')).toBeNull()
    expect(updaterLogLine('debug', 'Creating proxy server for native Squirrel.Mac (fileToProxy=https://lhr.ink/dsh-updates/mac/dsh-0.1.0-rc.29-arm64.zip)')).toBeNull()
  })

  it('keeps the two debug lines no other channel records', () => {
    expect(updaterLogLine('debug', 'nativeUpdater.update-downloaded')).toBe('[updater] debug: nativeUpdater.update-downloaded\n')
    expect(updaterLogLine('debug', 'updater cache dir: /Users/x/Library/Caches/dsh-updater'))
      .toBe('[updater] debug: updater cache dir: /Users/x/Library/Caches/dsh-updater\n')
  })

  it('keeps a debug line only when it starts with a kept prefix', () => {
    expect(updaterLogLine('debug', 'Proxy server is listening (updater cache dir: /tmp)')).toBeNull()
    expect(updaterLogLine('debug', 'seen nativeUpdater.update-downloaded')).toBeNull()
  })

  it('keeps the differential-download summary, which is on info', () => {
    expect(updaterLogLine('info', 'File has 214 changed blocks')).toBe('[updater] File has 214 changed blocks\n')
    expect(updaterLogLine('info', 'Full: 180 MB, To download: 16 MB (9%)')).toBe('[updater] Full: 180 MB, To download: 16 MB (9%)\n')
  })

  it('names the channel on warn and error and nothing on info', () => {
    expect(updaterLogLine('info', 'Checking for update')).toBe('[updater] Checking for update\n')
    expect(updaterLogLine('warn', 'Cannot cleanup: Error: EBUSY')).toBe('[updater] warn: Cannot cleanup: Error: EBUSY\n')
    expect(updaterLogLine('error', 'Error: net::ERR_CONNECTION_RESET')).toBe('[updater] error: Error: net::ERR_CONNECTION_RESET\n')
  })

  it('renders whatever the library passed, which is not always a string', () => {
    expect(updaterLogLine('error', new Error('boom'))).toBe('[updater] error: Error: boom\n')
    expect(updaterLogLine('info', undefined)).toBe('[updater] undefined\n')
  })

  it('rewrites the handled differential fallback to one line without the stack', () => {
    const message = `${FALLBACK}Error: net::ERR_CONNECTION_RESET\n    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:81067)\n    at SimpleURLLoaderWrapper.emit (node:events:518:28)`
    expect(updaterLogLine('error', message)).toBe(
      '[updater] differential download unavailable (net::ERR_CONNECTION_RESET); this update transfers the whole artifact\n',
    )
  })

  it('strips the class name, and keeps a reason that never carried one', () => {
    expect(updaterLogLine('error', `${FALLBACK}net::ERR_CONNECTION_RESET`)).toBe(rewritten('net::ERR_CONNECTION_RESET'))
    expect(updaterLogLine('error', `${FALLBACK}Error: version is different (1 - 2), full download is required`))
      .toBe(rewritten('version is different (1 - 2), full download is required'))
  })

  it('names a thrown value that is not an Error, which renders without a stack', () => {
    const thrown = { toString: () => 'weird thing' }
    expect(updaterLogLine('error', `${FALLBACK}${String(thrown)}`)).toBe(rewritten('weird thing'))
  })

  it('names the status an HttpError carries, whose description and header dump are on later lines', () => {
    // Assembled the way `createHttpError` does (`builder-util-runtime/out/httpExecutor.js:52-57`):
    // the status, then the description as indented JSON, then the header dump.
    const rendered = [
      'HttpError: 503 Service Unavailable',
      '{',
      '  "path": "/dsh-updates/win/latest.yml"',
      '}',
      'Headers: {"retry-after":"120","content-type":"text/html"}',
      '    at createHttpError (httpExecutor.js:52:12)',
    ].join('\n')
    expect(updaterLogLine('error', `${FALLBACK}${rendered}`)).toBe(rewritten('503 Service Unavailable'))
  })

  it('keeps a checksum mismatch whole, both digests included', () => {
    expect(CHECKSUM_MISMATCH).toHaveLength(217)
    const message = `${FALLBACK}Error: ${CHECKSUM_MISMATCH}\n    at DigestTransform.validate (httpExecutor.js:431:19)`
    expect(updaterLogLine('error', message)).toBe(rewritten(CHECKSUM_MISMATCH))
  })

  it('caps a first line longer than anything upstream produces', () => {
    expect(updaterLogLine('error', `${FALLBACK}Error: ${'x'.repeat(400)}`)).toBe(rewritten(`${'x'.repeat(320)}…`))
  })

  it('leaves every other error message whole', () => {
    const message = 'Error: ENOENT: no such file or directory, open \'latest.yml\'\n    at Object.openSync (node:fs:596:3)'
    expect(updaterLogLine('error', message)).toBe(`[updater] error: ${message}\n`)
    expect(updaterLogLine('error', 'Cannot download "https://lhr.ink/dsh-updates/win/latest.yml", status 503: Service Unavailable'))
      .toBe('[updater] error: Cannot download "https://lhr.ink/dsh-updates/win/latest.yml", status 503: Service Unavailable\n')
  })
})
