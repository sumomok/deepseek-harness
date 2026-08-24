/**
 * Which update-transfer failures are retried, how each plan spaces the
 * attempts, and what the caller is left holding when it runs out.
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CHECK_RETRY_DELAYS_MS,
  RETRY_DELAYS_MS,
  classifyDownloadError,
  describeDownloadError,
  type RetryHooks,
  withRetry,
} from '../src/download-retry.ts'

/**
 * An error carrying a `code`, which is the form Node's syscall failures and
 * builder-util-runtime's `newError`/`HttpError` both take.
 * @param code - the code to attach.
 * @param message - the message to carry, defaulting to the code.
 * @returns the error.
 */
function coded(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Collect the retry plan's calls against an instant clock.
 * @returns the hooks to pass, plus what they recorded.
 */
function recorder(): { hooks: RetryHooks; delays: number[]; reports: Array<[number, number, number, string]> } {
  const delays: number[] = []
  const reports: Array<[number, number, number, string]> = []
  return {
    delays,
    reports,
    hooks: {
      sleep: async (ms) => { delays.push(ms) },
      onRetry: (attempt, total, delayMs, error) => {
        reports.push([attempt, total, delayMs, describeDownloadError(error)])
      },
    },
  }
}

describe('classifyDownloadError', () => {
  it('retries the syscall codes a cut or refused connection carries', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']) {
      expect(classifyDownloadError(coded(code, `read ${code}`))).toBe('transient')
    }
  })

  it('retries the message forms that carry no code', () => {
    for (const message of [
      'Request timed out',
      'Request has been aborted by the server',
      'socket hang up',
      'net::ERR_CONNECTION_RESET',
      'net::ERR_INTERNET_DISCONNECTED',
    ]) expect(classifyDownloadError(new Error(message))).toBe('transient')
  })

  it('retries a server failure and a request the server asked for again', () => {
    for (const status of [500, 502, 503, 504, 408, 425, 429]) {
      expect(classifyDownloadError(coded(`HTTP_ERROR_${String(status)}`, `${String(status)} nope`))).toBe('transient')
    }
  })

  it('refuses to retry a status that decides this request', () => {
    for (const status of [400, 401, 403, 404, 410]) {
      expect(classifyDownloadError(coded(`HTTP_ERROR_${String(status)}`, `${String(status)} nope`))).toBe('fatal')
    }
  })

  it('reads the status out of the executor download failure that spells it in prose', () => {
    const url = 'https://lhr.ink/dsh-updates/mac/DSH%20Desktop-0.1.0.zip'
    expect(classifyDownloadError(new Error(`Cannot download "${url}", status 503: Service Unavailable`))).toBe('transient')
    expect(classifyDownloadError(new Error(`Cannot download "${url}", status 404: Not Found`))).toBe('fatal')
  })

  it('never retries an updater refusal, whatever its message says', () => {
    expect(classifyDownloadError(coded('ERR_UPDATER_INVALID_SIGNATURE', 'not signed by the application owner'))).toBe('fatal')
    expect(classifyDownloadError(coded('ERR_UPDATER_ZIP_FILE_NOT_FOUND', 'ZIP file not provided'))).toBe('fatal')
    // The message alone would read as a network failure; the code decides.
    expect(classifyDownloadError(coded('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'net::ERR_CONNECTION_RESET'))).toBe('fatal')
  })

  it('never retries bytes that failed their checksum', () => {
    expect(classifyDownloadError(coded('ERR_CHECKSUM_MISMATCH', 'sha512 checksum mismatch, expected a, got b'))).toBe('fatal')
  })

  it('calls an unrecognized failure fatal, including one that is not an Error', () => {
    expect(classifyDownloadError(new Error('Too many redirects (> 10)'))).toBe('fatal')
    expect(classifyDownloadError(new Error('Maximum allowed size is 500 MB'))).toBe('fatal')
    expect(classifyDownloadError(coded('ENOSPC', 'no space left on device'))).toBe('fatal')
    expect(classifyDownloadError('disconnected')).toBe('fatal')
    expect(classifyDownloadError(undefined)).toBe('fatal')
  })

  it('calls a response that carried no status fatal', () => {
    expect(classifyDownloadError(coded('HTTP_ERROR_-1', 'undefined undefined'))).toBe('fatal')
  })
})

describe('describeDownloadError', () => {
  it('names the error by its code where it carries one', () => {
    expect(describeDownloadError(coded('ECONNRESET', 'read ECONNRESET'))).toBe('ECONNRESET')
  })

  it('falls back to the first line of the message, capped', () => {
    expect(describeDownloadError(new Error('net::ERR_CONNECTION_RESET'))).toBe('net::ERR_CONNECTION_RESET')
    expect(describeDownloadError(new Error('503 Service Unavailable\nHeaders: {"server":"nginx"}'))).toBe('503 Service Unavailable')
    expect(describeDownloadError(new Error('x'.repeat(400)))).toBe(`${'x'.repeat(160)}…`)
  })

  it('describes a value that is not an Error', () => {
    expect(describeDownloadError('disconnected')).toBe('disconnected')
  })
})

describe('withRetry', () => {
  it('runs the download once when it succeeds', async () => {
    const run = vi.fn(async () => {})
    const { hooks, delays, reports } = recorder()
    await withRetry(run, RETRY_DELAYS_MS, hooks)
    expect(run).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
    expect(reports).toEqual([])
  })

  it('waits the planned delays and reports each retry before waiting', async () => {
    let attempts = 0
    const run = vi.fn(async () => {
      attempts += 1
      if (attempts < 3) throw coded('ECONNRESET', 'read ECONNRESET')
    })
    const { hooks, delays, reports } = recorder()
    await withRetry(run, RETRY_DELAYS_MS, hooks)
    expect(run).toHaveBeenCalledTimes(3)
    expect(delays).toEqual(RETRY_DELAYS_MS.slice(0, 2))
    expect(reports).toEqual([
      [1, RETRY_DELAYS_MS.length, RETRY_DELAYS_MS[0], 'ECONNRESET'],
      [2, RETRY_DELAYS_MS.length, RETRY_DELAYS_MS[1], 'ECONNRESET'],
    ])
  })

  it('spaces the whole plan out before giving up, and rejects with the last failure', async () => {
    const failures = [
      coded('ECONNRESET', 'read ECONNRESET'),
      new Error('Request timed out'),
      coded('HTTP_ERROR_503', '503 Service Unavailable'),
      new Error('net::ERR_INTERNET_DISCONNECTED'),
    ]
    let attempts = 0
    const run = vi.fn(async () => { throw failures[attempts++] })
    const { hooks, delays, reports } = recorder()
    await expect(withRetry(run, RETRY_DELAYS_MS, hooks)).rejects.toBe(failures[RETRY_DELAYS_MS.length])
    expect(run).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1)
    expect(delays).toEqual([...RETRY_DELAYS_MS])
    expect(reports.map(report => report[0])).toEqual([1, 2, 3])
  })

  it('rejects with a fatal failure without retrying or waiting', async () => {
    const failure = coded('ERR_UPDATER_INVALID_SIGNATURE', 'not signed by the application owner')
    const run = vi.fn(async () => { throw failure })
    const { hooks, delays, reports } = recorder()
    await expect(withRetry(run, RETRY_DELAYS_MS, hooks)).rejects.toBe(failure)
    expect(run).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([])
    expect(reports).toEqual([])
  })

  it('stops as soon as a retried download turns fatal', async () => {
    const failure = coded('ERR_CHECKSUM_MISMATCH', 'sha512 checksum mismatch, expected a, got b')
    let attempts = 0
    const run = vi.fn(async () => {
      attempts += 1
      throw attempts === 1 ? coded('ECONNRESET', 'read ECONNRESET') : failure
    })
    const { hooks, delays } = recorder()
    await expect(withRetry(run, RETRY_DELAYS_MS, hooks)).rejects.toBe(failure)
    expect(run).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([RETRY_DELAYS_MS[0]])
  })

  it('hands back what the attempt that completed returned', async () => {
    const run = vi.fn(async () => 'the manifest')
    const { hooks } = recorder()
    await expect(withRetry(run, RETRY_DELAYS_MS, hooks)).resolves.toBe('the manifest')
  })

  it('spaces a retried check along the check plan, not the download plan', async () => {
    let attempts = 0
    const run = vi.fn(async () => {
      attempts += 1
      if (attempts < 3) throw new Error('net::ERR_EMPTY_RESPONSE')
      return 'the manifest'
    })
    const { hooks, delays, reports } = recorder()
    await expect(withRetry(run, CHECK_RETRY_DELAYS_MS, hooks)).resolves.toBe('the manifest')
    expect(delays).toEqual(CHECK_RETRY_DELAYS_MS.slice(0, 2))
    expect(reports.map(report => report[1])).toEqual([CHECK_RETRY_DELAYS_MS.length, CHECK_RETRY_DELAYS_MS.length])
  })
})

describe('CHECK_RETRY_DELAYS_MS', () => {
  it('is a bounded, strictly increasing plan', () => {
    expect(CHECK_RETRY_DELAYS_MS.length).toBeGreaterThan(0)
    expect([...CHECK_RETRY_DELAYS_MS]).toEqual([...CHECK_RETRY_DELAYS_MS].sort((a, b) => a - b))
    expect(new Set(CHECK_RETRY_DELAYS_MS).size).toBe(CHECK_RETRY_DELAYS_MS.length)
  })

  it('fits inside the launch gate, which races the plan and opens on its own timeout', () => {
    // GATE_TIMEOUT_MS in src/updater.ts. A plan that outlasts it would let the
    // gate answer from the timeout instead of from a retried check.
    expect(CHECK_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)).toBeLessThan(15_000)
  })

  it('is tighter than the download plan, whose attempts each re-transfer the artifact', () => {
    const checkTotal = CHECK_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)
    const downloadTotal = RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)
    expect(checkTotal).toBeLessThan(downloadTotal)
  })
})

describe('RETRY_DELAYS_MS', () => {
  it('is a bounded, strictly increasing plan', () => {
    expect(RETRY_DELAYS_MS.length).toBeGreaterThan(0)
    expect([...RETRY_DELAYS_MS]).toEqual([...RETRY_DELAYS_MS].sort((a, b) => a - b))
    expect(new Set(RETRY_DELAYS_MS).size).toBe(RETRY_DELAYS_MS.length)
    expect(RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)).toBeLessThanOrEqual(60_000)
  })
})
