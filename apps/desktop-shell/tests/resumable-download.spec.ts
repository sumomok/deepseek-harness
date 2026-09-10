/**
 * The shell's own resumable transfer, against a local server that honours
 * `Range`, can cut a response in half, and can answer the ways a server that
 * does not honour it answers.
 * @module
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discardPart, resumeDownload } from '../src/resumable-download.ts'
import type { TransferSample } from '../src/update-state.ts'

/** The artifact every case transfers: large enough to be cut in the middle. */
const ARTIFACT = randomBytes(64 * 1024)

/** The manifest's base64 sha512 for [[ARTIFACT]]. */
const SHA512 = createHash('sha512').update(ARTIFACT).digest('base64')

/** The validator the server publishes for [[ARTIFACT]]. */
const ETAG = '"artifact-v1"'

/** How the server answers this case's requests. */
interface ServerBehavior {
  /** Cut the response after this many body bytes, leaving the transfer to resume. */
  cutAfter?: number
  /** Ignore `Range` and answer the whole artifact with 200. */
  ignoreRange?: boolean
  /** Answer 416 whatever was asked for. */
  rangeNotSatisfiable?: boolean
  /** Answer this status with no body. */
  status?: number
  /** Accept the connection and then send nothing at all. */
  stall?: boolean
  /** Serve these bytes instead of [[ARTIFACT]], as a server that replaced the file would. */
  payload?: Buffer
  /** Publish no `ETag`, as a feed behind a proxy that strips validators does. */
  omitValidator?: boolean
  /** Honour `Range` but answer from this offset instead of the one asked for. */
  answerFrom?: number
  /** Answer 206 without saying which part of the artifact the body is. */
  omitContentRange?: boolean
}

/** Every request one started server received, in order. */
type Received = IncomingMessage['headers'][]

let server: Server | undefined
const directories: string[] = []

afterEach(async () => {
  const running = server
  server = undefined
  if (running !== undefined) {
    running.closeAllConnections()
    await new Promise<void>((resolve) => { running.close(() => { resolve() }) })
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * Start the feed this case downloads from.
 * @param behavior - how it answers.
 * @returns the artifact's URL and the headers of every request it received.
 */
async function serve(behavior: ServerBehavior = {}): Promise<{ url: string; received: Received }> {
  const received: Received = []
  const payload = behavior.payload ?? ARTIFACT
  const answer = (request: IncomingMessage, response: ServerResponse): void => {
    received.push(request.headers)
    if (behavior.stall === true) return
    if (behavior.status !== undefined) {
      response.writeHead(behavior.status)
      response.end()
      return
    }
    if (behavior.rangeNotSatisfiable === true) {
      response.writeHead(416, { 'content-range': `bytes */${String(payload.byteLength)}` })
      response.end()
      return
    }
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
    const ifRange = request.headers['if-range']
    const honoured = range !== null && behavior.ignoreRange !== true && (ifRange === undefined || ifRange === ETAG)
    const from = honoured ? behavior.answerFrom ?? Number(range[1]) : 0
    const body = payload.subarray(from)
    response.writeHead(honoured ? 206 : 200, {
      ...behavior.omitValidator === true ? {} : { etag: ETAG },
      'accept-ranges': 'bytes',
      'content-length': String(body.byteLength),
      ...honoured && behavior.omitContentRange !== true
        ? { 'content-range': `bytes ${String(from)}-${String(payload.byteLength - 1)}/${String(payload.byteLength)}` }
        : {},
    })
    if (behavior.cutAfter === undefined) {
      response.end(body)
      return
    }
    response.write(body.subarray(0, behavior.cutAfter))
    // A connection the network cut: the bytes already written arrive, and the
    // request ends without the rest and without a clean close.
    setTimeout(() => { request.socket.destroy() }, 10)
  }
  const started = createServer(answer)
  server = started
  await new Promise<void>((resolve) => { started.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = started.address()
  if (address === null || typeof address === 'string') throw new Error('the test server reported no TCP address')
  return { url: `http://127.0.0.1:${String(address.port)}/DSH%20Desktop-1.0.0-arm64-mac.zip`, received }
}

/**
 * A directory this case may write its `.part` file into.
 * @returns the `.part` file path, removed by the shared teardown.
 */
function partFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-resume-'))
  directories.push(directory)
  return join(directory, 'artifact.part')
}

describe('a transfer that completes in one attempt', () => {
  it('writes the artifact and reports its size', async () => {
    const { url, received } = await serve()
    const file = partFile()
    expect(await resumeDownload({ url, partFile: file, sha512: SHA512 })).toBe(ARTIFACT.byteLength)
    expect(readFileSync(file).equals(ARTIFACT)).toBe(true)
    expect(received[0]?.range).toBeUndefined()
  })

  it('reports progress against the size the answer named', async () => {
    const { url } = await serve()
    const samples: TransferSample[] = []
    await resumeDownload({ url, partFile: partFile(), sha512: SHA512 }, {
      onProgress: (sample) => { samples.push(sample) },
    })
    const last = samples.at(-1)
    expect(last).toEqual({ percent: 100, transferred: ARTIFACT.byteLength, total: ARTIFACT.byteLength })
  })
})

describe('a transfer the network cut', () => {
  it('keeps what arrived and finishes it from that offset', async () => {
    const cutAfter = 20_000
    const first = await serve({ cutAfter })
    const file = partFile()
    await expect(resumeDownload({ url: first.url, partFile: file, sha512: SHA512 })).rejects.toThrow()
    const kept = readFileSync(file)
    expect(kept.byteLength).toBeGreaterThan(0)
    expect(kept.byteLength).toBeLessThan(ARTIFACT.byteLength)
    expect(kept.equals(ARTIFACT.subarray(0, kept.byteLength))).toBe(true)

    const second = await serve()
    expect(await resumeDownload({ url: second.url, partFile: file, sha512: SHA512 })).toBe(ARTIFACT.byteLength)
    const finished = readFileSync(file)
    expect(createHash('sha512').update(finished).digest('base64')).toBe(SHA512)
    expect(finished.equals(ARTIFACT)).toBe(true)
    // The second attempt asked only for the rest, and proved which artifact
    // the bytes it holds came from.
    expect(second.received[0]?.range).toBe(`bytes=${String(kept.byteLength)}-`)
    expect(second.received[0]?.['if-range']).toBe(ETAG)
  })

  it('resumes again and again until the artifact is whole', async () => {
    const file = partFile()
    for (const cutAfter of [8_000, 8_000, 8_000]) {
      const cut = await serve({ cutAfter })
      await expect(resumeDownload({ url: cut.url, partFile: file, sha512: SHA512 })).rejects.toThrow()
      server?.closeAllConnections()
    }
    const held = readFileSync(file).byteLength
    expect(held).toBeGreaterThan(8_000)
    const last = await serve()
    expect(await resumeDownload({ url: last.url, partFile: file, sha512: SHA512 })).toBe(ARTIFACT.byteLength)
    expect(last.received[0]?.range).toBe(`bytes=${String(held)}-`)
  })
})

describe('a server that will not continue the transfer', () => {
  it('starts over when it answers 200 to a Range request', async () => {
    const file = partFile()
    writeFileSync(file, ARTIFACT.subarray(0, 5_000))
    const { url } = await serve({ ignoreRange: true })
    expect(await resumeDownload({ url, partFile: file, sha512: SHA512 })).toBe(ARTIFACT.byteLength)
    expect(readFileSync(file).equals(ARTIFACT)).toBe(true)
  })

  it('starts over when it answers 416', async () => {
    const file = partFile()
    writeFileSync(file, Buffer.concat([ARTIFACT, randomBytes(16)]))
    const { url, received } = await serve({ rangeNotSatisfiable: true })
    await expect(resumeDownload({ url, partFile: file, sha512: SHA512 })).rejects.toThrow(/416/)
    // Both passes were spent: the first asked from the offset it held, the
    // second from zero, and the part was discarded in between.
    expect(received).toHaveLength(2)
    expect(received[0]?.range).toBe(`bytes=${String(ARTIFACT.byteLength + 16)}-`)
    expect(received[1]?.range).toBeUndefined()
  })

  it('takes no bytes from a 206 that begins somewhere else', async () => {
    const file = partFile()
    writeFileSync(file, ARTIFACT.subarray(0, 5_000))
    const { url } = await serve({ answerFrom: 1_000 })
    await expect(resumeDownload({ url, partFile: file, sha512: SHA512 })).rejects.toThrow(/区间与请求不符/)
    // Nothing of that answer reached the disk, and the prefix that was there
    // before it is what the next attempt resumes from.
    expect(readFileSync(file)).toEqual(ARTIFACT.subarray(0, 5_000))
  })

  it('takes no bytes from a 206 that names no range', async () => {
    const file = partFile()
    writeFileSync(file, ARTIFACT.subarray(0, 5_000))
    const { url } = await serve({ omitContentRange: true })
    await expect(resumeDownload({ url, partFile: file, sha512: SHA512 })).rejects.toThrow(/缺少 Content-Range/)
    expect(readFileSync(file)).toEqual(ARTIFACT.subarray(0, 5_000))
  })

  it('reports the status it refused with', async () => {
    const { url } = await serve({ status: 503 })
    await expect(resumeDownload({ url, partFile: partFile(), sha512: SHA512 })).rejects.toThrow(/503/)
  })
})

describe('what the digest protects', () => {
  it('discards the part when the completed artifact is not the one the manifest names', async () => {
    const { url } = await serve({ payload: randomBytes(1_024) })
    const file = partFile()
    await expect(resumeDownload({ url, partFile: file, sha512: SHA512 })).rejects.toThrow(/校验不符/)
    expect(existsSync(file)).toBe(false)
  })

  it('keeps the part when the transfer was merely interrupted', async () => {
    const { url } = await serve({ cutAfter: 4_000 })
    const file = partFile()
    await expect(resumeDownload({ url, partFile: file, sha512: SHA512 })).rejects.toThrow()
    expect(existsSync(file)).toBe(true)
  })
})

describe('a part file that cannot be written', () => {
  it('ends the attempt with the write failure instead of raising it at the process', async () => {
    // No validator, so nothing is written beside the part file and the stream
    // itself is what meets the missing directory.
    const { url } = await serve({ omitValidator: true })
    // The directory the cache lived in is gone, which is what a cleaner or an
    // uninstall of a previous version leaves behind; ENOSPC and EACCES reach
    // the stream through the same `error` event.
    const file = join(partFile(), '..', 'gone', 'artifact.part')
    const escaped: unknown[] = []
    const sentinel = (error: unknown): void => { escaped.push(error) }
    process.on('uncaughtException', sentinel)
    try {
      await expect(resumeDownload({ url, partFile: file, sha512: SHA512 }, { idleTimeoutMs: 500 }))
        .rejects.toThrow(/ENOENT/)
      // The stream's failure arrives on its own turn of the loop; nothing may
      // be waiting on this process's handler by the time the promise settles.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    } finally {
      process.off('uncaughtException', sentinel)
    }
    expect(escaped).toEqual([])
  })
})

describe('a transfer that stalls', () => {
  it('is abandoned once nothing has arrived for the idle bound', async () => {
    const { url } = await serve({ stall: true })
    await expect(resumeDownload({ url, partFile: partFile(), sha512: SHA512 }, { idleTimeoutMs: 60 }))
      .rejects.toThrow()
  })
})

describe('discarding a part', () => {
  it('removes the bytes and what was recorded about them', async () => {
    const { url } = await serve({ cutAfter: 4_000 })
    const file = partFile()
    await expect(resumeDownload({ url, partFile: file, sha512: SHA512 })).rejects.toThrow()
    expect(existsSync(`${file}.origin.json`)).toBe(true)
    discardPart(file)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.origin.json`)).toBe(false)
  })
})
