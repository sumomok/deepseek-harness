/**
 * The loopback render protocol: what it refuses, in what order it decides, and
 * what it does with the requests it accepts. The window half is injected, so
 * everything here runs without a display.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  blockedByPattern, REPORT_HEADER_BYTES, RENDER_LIMITS, startRenderService,
  type Capture, type CaptureNow, type RenderLimits, type RenderPhase, type RenderReport,
  type RenderRequest, type RenderServiceHandle, type RenderTrace, type Renderer,
} from '../src/render-service.ts'

/** Stand-in for encoded pixels; the service must hand these back untouched. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])

/** What every renderer here answers with, at the size {@link VALID} asks for. */
const CAPTURE: Capture = { png: PNG, width: 800, height: 600 }

/** A request every field of which is valid, used wherever the body is not what is under test. */
const VALID = { url: 'https://example.test/page', width: 800, height: 600 }

/** The two fields `resolveRequest` fills in for a request that names neither, on the shell's own limits. */
const RESOLVED = { timeoutMs: RENDER_LIMITS.timeoutMs, onTimeout: 'fail' as const }

/**
 * The report one answer carries.
 * @param response - the answer to read.
 * @returns the parsed report; fails the test when the header is missing.
 */
function reportOf(response: Response): RenderReport {
  const header = response.headers.get('x-dsh-render-report')
  expect(header).not.toBeNull()
  return JSON.parse(decodeURIComponent(header ?? '')) as RenderReport
}

let service: RenderServiceHandle | undefined

afterEach(async () => {
  await service?.close()
  service = undefined
})

/**
 * Start one service for this test, on the shell's bounds unless overridden.
 * @param renderer - the injected window half.
 * @param limits - the bounds to change for this test.
 * @returns the listening handle, closed by the shared teardown.
 */
async function start(renderer: Renderer, limits: Partial<RenderLimits> = {}): Promise<RenderServiceHandle> {
  service = await startRenderService({ renderer, limits: { ...RENDER_LIMITS, ...limits } })
  return service
}

/** A renderer that answers every request with {@link CAPTURE} and records what it was asked for. */
function recordingRenderer(): { renderer: Renderer; seen: RenderRequest[] } {
  const seen: RenderRequest[] = []
  return {
    seen,
    renderer: async (request) => {
      seen.push(request)
      return CAPTURE
    },
  }
}

/** The deadline every timeout-line case runs on; short enough to be quick, long enough for the chain to reach the renderer. */
const TRACE_TIMEOUT_MS = 60

/**
 * A renderer that hands its trace to `record` and then waits out the deadline,
 * so what the service answers is a 504 describing exactly what was recorded.
 * @param record - fills the trace the way the window half would.
 * @returns the renderer to inject.
 */
function tracingRenderer(record: (trace: RenderTrace) => void): Renderer {
  return async (_request, signal, trace) => {
    record(trace)
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('render aborted')) }, { once: true })
    })
    return CAPTURE
  }
}

/**
 * The single line a render whose trace `record` filled is answered with.
 * @param record - fills the trace the way the window half would.
 * @param body - the request body, when the URL matters to what the line says.
 * @returns the 504 body without its trailing newline.
 */
async function timedOutLine(record: (trace: RenderTrace) => void, body: unknown = VALID): Promise<string> {
  const handle = await start(tracingRenderer(record), { timeoutMs: TRACE_TIMEOUT_MS })
  try {
    const response = await post(handle, body)
    expect(response.status).toBe(504)
    return (await response.text()).trimEnd()
  } finally {
    await handle.close()
    service = undefined
  }
}

/** POST a body to `/render` with this service's own token and content type. */
async function post(handle: RenderServiceHandle, body: unknown): Promise<Response> {
  return fetch(`${handle.endpoint}/render`, {
    method: 'POST',
    headers: { authorization: `Bearer ${handle.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** A promise the test opens by hand, for holding a renderer mid-render. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { wait, open }
}

/** Poll until `predicate` holds, so a test never depends on a fixed wait. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('the listener', () => {
  it('binds the loopback address and mints a fresh 32-byte token', async () => {
    const first = await start(recordingRenderer().renderer)
    expect(first.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    const second = await startRenderService({ renderer: recordingRenderer().renderer, limits: RENDER_LIMITS })
    expect(second.token).not.toBe(first.token)
    await second.close()
  })

  it('stops answering once it is closed', async () => {
    const handle = await start(recordingRenderer().renderer)
    await handle.close()
    service = undefined
    await expect(post(handle, VALID)).rejects.toThrow()
  })
})

describe('authorization', () => {
  it('refuses a request carrying no authorization header', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    const response = await fetch(`${handle.endpoint}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await response.text()).toContain('Bearer')
    expect(seen).toEqual([])
  })

  it('refuses another token of the same length and a token of another length', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    for (const token of ['0'.repeat(64), 'short', `${handle.token}0`]) {
      const response = await fetch(`${handle.endpoint}/render`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(VALID),
      })
      expect(response.status).toBe(401)
      await response.text()
    }
    expect(seen).toEqual([])
  })

  it('refuses an authorization header that is not a bearer credential', async () => {
    const handle = await start(recordingRenderer().renderer)
    for (const header of [handle.token, `Basic ${handle.token}`, 'Bearer', `Bearer ${handle.token} extra`]) {
      const response = await fetch(`${handle.endpoint}/render`, {
        method: 'POST',
        headers: { authorization: header, 'content-type': 'application/json' },
        body: JSON.stringify(VALID),
      })
      expect(response.status).toBe(401)
      await response.text()
    }
  })

  it('accepts the scheme in any case, which is what the header grammar says', async () => {
    const handle = await start(recordingRenderer().renderer)
    const response = await fetch(`${handle.endpoint}/render`, {
      method: 'POST',
      headers: { authorization: `bearer  ${handle.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(VALID),
    })
    expect(response.status).toBe(200)
    await response.arrayBuffer()
  })
})

describe('routing', () => {
  it('answers 404 for every other method and path, without asking for a token', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    const routes: [string, string][] = [['GET', '/render'], ['DELETE', '/render'], ['POST', '/'], ['POST', '/screenshot']]
    for (const [method, path] of routes) {
      const response = await fetch(`${handle.endpoint}${path}`, { method })
      expect(response.status).toBe(404)
      expect(await response.text()).toContain(`${method} ${path}`)
    }
    expect(seen).toEqual([])
  })

  it('ignores a query string on the render path', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    const response = await fetch(`${handle.endpoint}/render?trace=1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(VALID),
    })
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    expect(seen).toHaveLength(1)
  })
})

describe('request validation', () => {
  it('refuses a body that is not JSON, not an object, or larger than the cap', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer, { maxBodyBytes: 1024 })
    const cases: [string, string][] = [
      ['not json at all', 'body must be JSON'],
      ['"a string"', 'body must be a JSON object'],
      ['[1, 2]', 'body must be a JSON object'],
      ['null', 'body must be a JSON object'],
      [JSON.stringify({ ...VALID, padding: 'x'.repeat(2048) }), 'at most 1024 bytes'],
    ]
    for (const [body, expected] of cases) {
      const response = await fetch(`${handle.endpoint}/render`, {
        method: 'POST',
        headers: { authorization: `Bearer ${handle.token}`, 'content-type': 'application/json' },
        body,
      })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain(expected)
    }
    expect(seen).toEqual([])
  })

  it('requires the JSON content type', async () => {
    const handle = await start(recordingRenderer().renderer)
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const response = await fetch(`${handle.endpoint}/render`, {
        method: 'POST',
        headers: { authorization: `Bearer ${handle.token}`, 'content-type': type },
        body: JSON.stringify(VALID),
      })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('application/json')
    }
  })

  it('refuses every malformed field with the rule it broke', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    const cases: [unknown, string][] = [
      [{ ...VALID, url: undefined }, 'url must be a non-empty string'],
      [{ ...VALID, url: '' }, 'url must be a non-empty string'],
      [{ ...VALID, url: 42 }, 'url must be a non-empty string'],
      [{ ...VALID, url: '/relative/path' }, 'url must be an absolute URL'],
      [{ ...VALID, width: undefined }, 'width must be an integer'],
      [{ ...VALID, width: 15 }, 'width must be an integer'],
      [{ ...VALID, width: 4097 }, 'width must be an integer'],
      [{ ...VALID, width: 800.5 }, 'width must be an integer'],
      [{ ...VALID, width: '800' }, 'width must be an integer'],
      [{ ...VALID, height: undefined }, 'height must be an integer'],
      [{ ...VALID, height: 0 }, 'height must be an integer'],
      [{ ...VALID, fullPage: 'yes' }, 'fullPage must be a boolean'],
      [{ ...VALID, delayMs: -1 }, 'delayMs must be an integer between 0 and 10000'],
      [{ ...VALID, delayMs: 10_001 }, 'delayMs must be an integer between 0 and 10000'],
      [{ ...VALID, delayMs: 1.5 }, 'delayMs must be an integer between 0 and 10000'],
      [{ ...VALID, delayMs: 'soon' }, 'delayMs must be an integer between 0 and 10000'],
    ]
    for (const [body, expected] of cases) {
      const response = await post(handle, body)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain(expected)
    }
    expect(seen).toEqual([])
  })

  it('refuses a headers or cookies field that is not a map of strings', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    const cases: [unknown, string][] = [
      [{ ...VALID, headers: 'authorization: Bearer x' }, 'headers must be a JSON object of string values'],
      [{ ...VALID, headers: ['a'] }, 'headers must be a JSON object of string values'],
      [{ ...VALID, cookies: 42 }, 'cookies must be a JSON object of string values'],
      [{ ...VALID, headers: { 'x-count': 7 } }, 'headers.x-count must be a string'],
      [{ ...VALID, cookies: { session: null } }, 'cookies.session must be a string'],
      [{ ...VALID, headers: { 'x bad': 'v' } }, 'headers name "x bad" is not a valid token'],
      [{ ...VALID, cookies: { 'bad;name': 'v' } }, 'cookies name "bad;name" is not a valid token'],
      [{ ...VALID, headers: { '': 'v' } }, 'headers name "" is not a valid token'],
    ]
    for (const [body, expected] of cases) {
      const response = await post(handle, body)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain(expected)
    }
    expect(seen).toEqual([])
  })

  it('refuses a value carrying a character that would mean something else on the wire', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    const cases: unknown[] = [
      // A newline would append a header nobody sent: loadURL takes them as one
      // newline-separated string.
      { ...VALID, headers: { 'x-note': 'one\ntwo: three' } },
      { ...VALID, headers: { 'x-note': 'tab\rreturn' } },
      // A semicolon ends a cookie and starts its attributes, which is what
      // keeps `Path` and `Domain` out of a caller's reach: the window half
      // decides both.
      { ...VALID, cookies: { session: 'abc; Path=/' } },
      { ...VALID, cookies: { session: 'a,b' } },
    ]
    for (const body of cases) {
      const response = await post(handle, body)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('carries a character its grammar does not allow')
    }
    expect(seen).toEqual([])
  })

  it('points a cookie header at the field that actually applies it', async () => {
    const handle = await start(recordingRenderer().renderer)
    const response = await post(handle, { ...VALID, headers: { Cookie: 'session=abc' } })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('send cookies in the cookies field')
  })

  it('bounds how many extra fields one request may carry, counting both maps together', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer, { maxExtraFields: 3 })
    const three = { ...VALID, headers: { a: '1', b: '2' }, cookies: { c: '3' } }
    const accepted = await post(handle, three)
    expect(accepted.status).toBe(200)
    await accepted.arrayBuffer()

    const response = await post(handle, { ...three, cookies: { c: '3', d: '4' } })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('at most 3 headers and cookies together')
    expect(seen).toHaveLength(1)
  })

  it('bounds how large those names and values may come to', async () => {
    const handle = await start(recordingRenderer().renderer, { maxExtraBytes: 64 })
    const response = await post(handle, { ...VALID, cookies: { session: 'x'.repeat(64) } })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('at most 64 bytes together')
  })

  it('refuses a session on a scheme that carries none', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    const response = await post(handle, { ...VALID, url: 'file:///tmp/page.html', cookies: { session: 'abc' } })
    expect(response.status).toBe(422)
    expect(await response.text()).toContain('headers and cookies apply to an http or https request; file: carries neither')
    expect(seen).toEqual([])
  })

  it('refuses a well-formed URL whose scheme is not renderable', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    for (const url of ['ftp://host/x', 'data:text/html,<p>x', 'javascript:alert(1)', 'chrome://settings']) {
      const response = await post(handle, { ...VALID, url })
      expect(response.status).toBe(422)
      expect(await response.text()).toContain('is not renderable')
    }
    expect(seen).toEqual([])
  })

  it('renders every scheme it does allow', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    for (const url of ['http://127.0.0.1:9/x', 'https://example.test/', 'file:///tmp/page.html']) {
      const response = await post(handle, { ...VALID, url })
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }
    expect(seen.map(request => request.url)).toEqual(['http://127.0.0.1:9/x', 'https://example.test/', 'file:///tmp/page.html'])
  })
})

describe('a rendered request', () => {
  it('answers the renderer bytes as an image', async () => {
    const handle = await start(recordingRenderer().renderer)
    const response = await post(handle, VALID)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(String(PNG.byteLength))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
  })

  it('resolves the optional fields before the renderer sees them', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    await (await post(handle, VALID)).arrayBuffer()
    await (await post(handle, { ...VALID, fullPage: true, delayMs: 250 })).arrayBuffer()
    expect(seen).toEqual([
      { url: VALID.url, width: 800, height: 600, fullPage: false, delayMs: 0, ...RESOLVED },
      { url: VALID.url, width: 800, height: 600, fullPage: true, delayMs: 250, ...RESOLVED },
    ])
  })

  it('resolves the deadline and what a passed one does, and hands block patterns on lowercased', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    await (await post(handle, { ...VALID, timeoutMs: 90_000, onTimeout: 'capture', blockHosts: ['WWW.Gravatar.com', '*.Cdn.test'] })).arrayBuffer()
    await (await post(handle, { ...VALID, blockHosts: [] })).arrayBuffer()
    expect(seen).toEqual([
      {
        url: VALID.url,
        width: 800,
        height: 600,
        fullPage: false,
        delayMs: 0,
        timeoutMs: 90_000,
        onTimeout: 'capture',
        blockHosts: ['www.gravatar.com', '*.cdn.test'],
      },
      { url: VALID.url, width: 800, height: 600, fullPage: false, delayMs: 0, ...RESOLVED },
    ])
  })

  it('hands the renderer the headers and cookies it was sent, and no empty maps', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    await (await post(handle, { ...VALID, headers: { 'X-Api-Key': 'k' }, cookies: { _redmine_session: 'abc' } })).arrayBuffer()
    await (await post(handle, { ...VALID, headers: {}, cookies: {} })).arrayBuffer()
    expect(seen).toEqual([
      {
        url: VALID.url,
        width: 800,
        height: 600,
        fullPage: false,
        delayMs: 0,
        ...RESOLVED,
        headers: { 'X-Api-Key': 'k' },
        cookies: { _redmine_session: 'abc' },
      },
      { url: VALID.url, width: 800, height: 600, fullPage: false, delayMs: 0, ...RESOLVED },
    ])
  })
})

describe('where the render landed', () => {
  /**
   * Render one page with a renderer that records `landed` as the main frame's
   * landing, and answer with the response.
   * @param landed - the URL `did-navigate` would have reported.
   * @param body - the request body.
   * @returns the 200 response, its body unread.
   */
  async function renderLandingAt(landed: string, body: unknown = VALID): Promise<Response> {
    const handle = await start(async (_request, _signal, trace) => {
      trace.mainDocument(landed, 200)
      return CAPTURE
    })
    return post(handle, body)
  }

  it('names the landing on a successful render, so a sign-in page is not read as the page asked for', async () => {
    const response = await renderLandingAt('http://127.0.0.1:30010/login?back_url=%2Fissues', { ...VALID, url: 'http://127.0.0.1:30010/issues' })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-dsh-render-landed-url')).toBe('http://127.0.0.1:30010/login?back_url=%2Fissues')
    await response.arrayBuffer()
  })

  it('says nothing when the frame stayed where it was sent, normalization included', async () => {
    const stayed = await renderLandingAt(VALID.url)
    expect(stayed.headers.get('x-dsh-render-landed-url')).toBeNull()
    await stayed.arrayBuffer()

    // Chromium reports the URL it loaded, so an origin without a path comes
    // back with one; that is not a redirect.
    const normalized = await renderLandingAt('https://example.test/', { ...VALID, url: 'https://example.test' })
    expect(normalized.headers.get('x-dsh-render-landed-url')).toBeNull()
    await normalized.arrayBuffer()
  })

  it('percent-encodes a landing a header value cannot carry, and cuts a long one', async () => {
    const encoded = await renderLandingAt('https://example.test/搜索?q=1')
    expect(encoded.headers.get('x-dsh-render-landed-url')).toBe('https://example.test/%E6%90%9C%E7%B4%A2?q=1')
    await encoded.arrayBuffer()

    const long = await renderLandingAt(`https://example.test/${'a'.repeat(200)}`)
    const header = long.headers.get('x-dsh-render-landed-url') ?? ''
    expect(header.endsWith('%E2%80%A6')).toBe(true)
    await long.arrayBuffer()
  })

  it('says nothing about a render that never reported a main document', async () => {
    const handle = await start(recordingRenderer().renderer)
    const response = await post(handle, VALID)
    expect(response.headers.get('x-dsh-render-landed-url')).toBeNull()
    await response.arrayBuffer()
  })
})

describe('admission', () => {
  it('renders one page at a time', async () => {
    let running = 0
    let peak = 0
    const handle = await start(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      running--
      return CAPTURE
    })
    const responses = await Promise.all([post(handle, VALID), post(handle, VALID), post(handle, VALID)])
    for (const response of responses) {
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }
    expect(peak).toBe(1)
  })

  it('refuses the request past the queue limit instead of queueing it', async () => {
    const held = gate()
    let started = 0
    const handle = await start(async () => {
      started++
      await held.wait
      return CAPTURE
    }, { queueLimit: 2 })
    const statuses: number[] = []
    const posts = [0, 1, 2, 3].map(async () => {
      const response = await post(handle, VALID)
      statuses.push(response.status)
      await response.arrayBuffer()
    })
    await until(() => statuses.filter(status => status === 503).length === 2, 'the two refusals')
    // One rendering, one waiting behind it, and the other two told to come back.
    expect(started).toBe(1)
    held.open()
    await Promise.all(posts)
    expect(statuses.filter(status => status === 200)).toHaveLength(2)
    expect(started).toBe(2)
  })

  it('accepts a later request once the queue drained', async () => {
    const handle = await start(async () => CAPTURE, { queueLimit: 1 })
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await post(handle, VALID)
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }
  })
})

describe('a render that does not produce an image', () => {
  it('reports a renderer failure as 500 with its message', async () => {
    const handle = await start(async () => {
      throw new Error('ERR_FILE_NOT_FOUND (-6) loading file:///missing.html')
    })
    const response = await post(handle, VALID)
    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await response.text()).toContain('ERR_FILE_NOT_FOUND (-6)')
  })

  it('answers 504 when the deadline passes, and aborts the renderer', async () => {
    let aborted = false
    const handle = await start(async (_request, signal, trace) => {
      trace.enter('navigating')
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true
          reject(new Error('render aborted'))
        }, { once: true })
      })
      return CAPTURE
    }, { timeoutMs: 60 })
    const response = await post(handle, VALID)
    expect(response.status).toBe(504)
    expect(await response.text()).toContain('render timed out after 60ms')
    expect(aborted).toBe(true)
  })

  it('goes on serving after a renderer that never settles once it is abandoned', async () => {
    const seen: string[] = []
    const handle = await start(async (request) => {
      seen.push(request.url)
      // What `webContents.executeJavaScript` does when its window is destroyed:
      // it neither resolves nor rejects, and the abort signal reaches nothing.
      if (seen.length === 1) return new Promise<Capture>(() => undefined)
      return CAPTURE
    }, { timeoutMs: 60 })
    const abandoned = await post(handle, VALID)
    expect(abandoned.status).toBe(504)
    await abandoned.text()
    const next = await post(handle, { ...VALID, url: 'https://example.test/after' })
    expect(next.status).toBe(200)
    expect(Buffer.from(await next.arrayBuffer())).toEqual(PNG)
    expect(seen).toEqual([VALID.url, 'https://example.test/after'])
  })

  it('says the render never started when the deadline found it still queued', async () => {
    expect(await timedOutLine(() => {})).toBe(
      'render timed out after 60ms: the render had not started (queued behind earlier renders)',
    )
  })

  it('says nothing answered yet, and what is in flight, before the main document responds', async () => {
    const line = await timedOutLine((trace) => {
      trace.enter('navigating')
      trace.requestStarted(1, 'https://example.test/page', 'mainFrame')
      trace.requestStarted(2, 'https://cdn.example.test/app.css', 'stylesheet')
    })
    expect(line).toBe(
      'render timed out after 60ms: no response from the main document yet, 2 requests pending: '
      + '[mainFrame] https://example.test/page, [stylesheet] https://cdn.example.test/app.css',
    )
  })

  it('names the main document status and the first three requests the page is still waiting on', async () => {
    const line = await timedOutLine((trace) => {
      trace.enter('navigating')
      trace.mainDocument(VALID.url, 200)
      for (let n = 0; n < 7; n++) trace.requestStarted(n, `https://www.gravatar.com/avatar/${String(n)}`, 'image')
    })
    expect(line).toBe(
      'render timed out after 60ms: main document 200, load event not fired, 7 requests pending: '
      + '[image] https://www.gravatar.com/avatar/0, [image] https://www.gravatar.com/avatar/1, '
      + '[image] https://www.gravatar.com/avatar/2 (+4 more)',
    )
  })

  it('says where the main frame landed when that is not where the request pointed, and what to retry with', async () => {
    const line = await timedOutLine((trace) => {
      trace.enter('navigating')
      trace.mainDocument('http://127.0.0.1:18099/login?back_url=%2Fissues', 200)
    }, { ...VALID, url: 'http://127.0.0.1:18099/issues' })
    expect(line).toBe(
      'render timed out after 60ms: main document 200 at http://127.0.0.1:18099/login?back_url=%2Fissues, '
      + 'load event not fired, pass cookies or headers to capture it with a session, no requests pending',
    )
  })

  it('names the landing and the retry on a page that loaded somewhere else and then timed out capturing', async () => {
    const line = await timedOutLine((trace) => {
      trace.enter('navigating')
      trace.mainDocument('http://127.0.0.1:18099/login', 200)
      trace.enter('capturing')
    }, { ...VALID, url: 'http://127.0.0.1:18099/issues' })
    expect(line).toBe(
      'render timed out after 60ms: page loaded at http://127.0.0.1:18099/login, timed out while capturing, '
      + 'pass cookies or headers to capture it with a session',
    )
  })

  it('says where a file: render landed without offering it a session the service would refuse', async () => {
    const url = 'file:///tmp/index.html'
    const line = await timedOutLine((trace) => {
      trace.enter('navigating')
      trace.mainDocument('file:///tmp/other.html', -1)
    }, { ...VALID, url })
    expect(line).toBe(
      'render timed out after 60ms: main document with no HTTP status at file:///tmp/other.html, '
      + 'load event not fired, no requests pending',
    )
  })

  it('says a navigation had no HTTP status rather than printing the -1 Electron reports for one', async () => {
    const url = 'file:///tmp/page.html'
    const line = await timedOutLine((trace) => {
      trace.enter('navigating')
      trace.mainDocument(url, -1)
    }, { ...VALID, url })
    expect(line).toBe(
      'render timed out after 60ms: main document with no HTTP status, load event not fired, no requests pending',
    )
  })

  it('drops a request from the pending list once it settles', async () => {
    const line = await timedOutLine((trace) => {
      trace.enter('navigating')
      trace.mainDocument(VALID.url, 200)
      trace.requestStarted(1, 'https://example.test/app.js', 'script')
      trace.requestStarted(2, 'https://example.test/hero.png', 'image')
      trace.requestCompleted(1, 200)
    })
    expect(line).toBe(
      'render timed out after 60ms: main document 200, load event not fired, 1 request pending: '
      + '[image] https://example.test/hero.png',
    )
  })

  it('ignores settling an id it never saw start, which is what a cache hit completes as', async () => {
    const line = await timedOutLine((trace) => {
      trace.enter('navigating')
      trace.mainDocument(VALID.url, 200)
      trace.requestStarted(1, 'https://example.test/app.js', 'script')
      trace.requestCompleted(99, 200)
    })
    expect(line).toBe(
      'render timed out after 60ms: main document 200, load event not fired, 1 request pending: '
      + '[script] https://example.test/app.js',
    )
  })

  it('cuts a pending URL at 96 characters and marks that it cut it', async () => {
    const long = `https://example.test/${'a'.repeat(200)}.png`
    const line = await timedOutLine((trace) => {
      trace.enter('navigating')
      trace.mainDocument(VALID.url, 200)
      trace.requestStarted(1, long, 'image')
    })
    const printed = line.slice(line.indexOf('[image] ') + '[image] '.length)
    expect(printed).toHaveLength(96)
    expect(printed.endsWith('…')).toBe(true)
    expect(long.startsWith(printed.slice(0, -1))).toBe(true)
  })

  it('says what a loaded page was still doing, and names no requests for it', async () => {
    const wordings: [RenderPhase, string][] = [
      ['loaded', 'page loaded, timed out right after the load event'],
      ['delaying', 'page loaded, timed out while waiting delayMs'],
      ['measuring', 'page loaded, timed out while measuring the document'],
      ['resizing', 'page loaded, timed out while resizing the window'],
      ['capturing', 'page loaded, timed out while capturing'],
    ]
    for (const [phase, expected] of wordings) {
      const line = await timedOutLine((trace) => {
        trace.enter('navigating')
        trace.mainDocument(VALID.url, 200)
        trace.requestStarted(1, 'https://example.test/late.png', 'image')
        trace.enter(phase)
      })
      expect(line).toBe(`render timed out after 60ms: ${expected}`)
    }
  })

  it('answers one line inside the 500 characters its caller quotes, cutting the pending list and not the retry', async () => {
    const long = (name: string): string => `https://cdn.example.test/${'segment/'.repeat(40)}${name}`
    const line = await timedOutLine((trace) => {
      trace.enter('navigating')
      trace.mainDocument(long('landing.html'), 200)
      for (let n = 0; n < 12; n++) trace.requestStarted(n, long(`asset-${String(n)}.css`), 'stylesheet')
    })
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThanOrEqual(500)
    expect(line.startsWith('render timed out after 60ms: main document 200 at https://cdn.example.test/')).toBe(true)
    // The whole hint, with the pending list opening after it: everything a
    // caller can act on is ahead of the only clause that grows with the page,
    // so the cut this line needs lands in that list.
    expect(line).toContain('pass cookies or headers to capture it with a session, 12 requests pending: ')
    expect(line.endsWith('…')).toBe(true)
  })

  it('counts the wait in the deadline, so a queued request gets only what is left of its own', async () => {
    const started: string[] = []
    const held = gate()
    const handle = await start(async (request, signal) => {
      started.push(request.url)
      await held.wait
      signal.throwIfAborted()
      return CAPTURE
    }, { timeoutMs: 80, queueLimit: 4 })
    const first = post(handle, VALID)
    await until(() => started.length === 1, 'the first render to start')
    const second = post(handle, { ...VALID, url: 'https://example.test/queued' })
    const secondResponse = await second
    expect(secondResponse.status).toBe(504)
    await secondResponse.text()
    // The chain moved on when the first render was abandoned, so the second one
    // ran — on the remainder of a window that started when it was accepted.
    expect(started).toEqual([VALID.url, 'https://example.test/queued'])
    held.open()
    const firstResponse = await first
    expect(firstResponse.status).toBe(504)
    await firstResponse.text()
  })
})

describe('the report every answer carries', () => {
  /**
   * The answer a render whose trace `record` filled times out with.
   * @param record - fills the trace the way the window half would.
   * @param body - the request body.
   * @returns the response, its body unread.
   */
  async function timedOut(record: (trace: RenderTrace) => void, body: unknown = VALID): Promise<Response> {
    const handle = await start(tracingRenderer(record), { timeoutMs: TRACE_TIMEOUT_MS })
    return post(handle, body)
  }

  it('says what a complete render did, and what size it came back at', async () => {
    const handle = await start(async (_request, _signal, trace) => {
      trace.enter('navigating')
      trace.mainDocument(VALID.url, 200)
      trace.pageTitle('Issues')
      trace.firstPaint()
      trace.requestStarted(1, VALID.url, 'mainFrame')
      trace.requestCompleted(1, 200)
      trace.enter('capturing')
      return CAPTURE
    })
    const response = await post(handle, VALID)
    expect(response.status).toBe(200)
    const report = reportOf(response)
    await response.arrayBuffer()
    expect(report.version).toBe(1)
    expect(report.outcome).toBe('complete')
    expect(report.phase).toBe('capturing')
    expect(report.deadlineMs).toBe(RENDER_LIMITS.timeoutMs)
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(report.requestedUrl).toBe(VALID.url)
    expect(report.mainDocument).toEqual({ url: VALID.url, status: 200, redirected: false, title: 'Issues' })
    expect(report.loadEventFired).toBe(true)
    expect(report.firstPaint).toBe(true)
    expect(report.requests).toEqual({ total: 1, completed: 1, failed: 0, pending: 0, blocked: 0 })
    expect(report.capture).toEqual({ partial: false, width: 800, height: 600 })
  })

  it('says why a render produced no image at all, on the 500 that refuses it', async () => {
    const handle = await start(async (_request, _signal, trace) => {
      trace.enter('navigating')
      trace.mainFrameFailed(-6, 'ERR_FILE_NOT_FOUND')
      throw new Error('ERR_FILE_NOT_FOUND (-6) loading file:///missing.html')
    })
    const response = await post(handle, VALID)
    expect(response.status).toBe(500)
    const report = reportOf(response)
    expect(await response.text()).toContain('render failed: ERR_FILE_NOT_FOUND (-6)')
    expect(report.outcome).toBe('failed')
    expect(report.mainFrameError).toEqual({ code: -6, description: 'ERR_FILE_NOT_FOUND' })
    expect(report.capture).toBeNull()
    expect(report.loadEventFired).toBe(false)
  })

  it('names the hosts a timed-out render is waiting on, worst first, and counts the rest', async () => {
    const response = await timedOut((trace) => {
      trace.enter('navigating')
      trace.mainDocument(VALID.url, 200)
      for (let n = 0; n < 7; n++) trace.requestStarted(n, `https://www.gravatar.com/avatar/${String(n)}`, 'image')
      trace.requestStarted(100, 'https://cdn.example.test/app.css', 'stylesheet')
      trace.requestStarted(101, 'https://cdn.example.test/late.js', 'script')
      trace.requestStarted(102, 'https://api.example.test/whoami', 'xhr')
      trace.requestFailed(102, 'net::ERR_CONNECTION_REFUSED')
      trace.requestStarted(103, 'https://api.example.test/list', 'xhr')
      trace.requestCompleted(103, 503)
    })
    expect(response.status).toBe(504)
    const report = reportOf(response)
    await response.text()
    expect(report.outcome).toBe('timeout')
    expect(report.phase).toBe('navigating')
    expect(report.requests).toEqual({ total: 11, completed: 0, failed: 2, pending: 9, blocked: 0 })
    expect(report.pending).toHaveLength(5)
    expect(report.pending[0]).toMatchObject({ url: 'https://www.gravatar.com/avatar/0', type: 'image' })
    expect(report.pending[0]?.ageMs).toBeGreaterThanOrEqual(0)
    expect(report.hosts).toEqual([
      { host: 'www.gravatar.com', pending: 7, failed: 0, blocked: 0, maxAgeMs: expect.any(Number) },
      { host: 'cdn.example.test', pending: 2, failed: 0, blocked: 0, maxAgeMs: expect.any(Number) },
      { host: 'api.example.test', pending: 0, failed: 2, blocked: 0, maxAgeMs: 0 },
    ])
    expect(report.failed).toEqual([
      { url: 'https://api.example.test/whoami', type: 'xhr', error: 'net::ERR_CONNECTION_REFUSED', status: null },
      { url: 'https://api.example.test/list', type: 'xhr', error: null, status: 503 },
    ])
  })

  it('counts what the page logged and quotes the first three errors', async () => {
    const response = await timedOut((trace) => {
      trace.enter('navigating')
      for (let n = 0; n < 5; n++) trace.consoleMessage('error', `boom ${String(n)}`)
      trace.consoleMessage('warning', 'deprecated')
      trace.consoleMessage('info', 'hello')
      trace.consoleMessage('debug', 'noise')
    })
    const report = reportOf(response)
    await response.text()
    expect(report.console).toEqual({ errors: 5, warnings: 1, samples: ['boom 0', 'boom 1', 'boom 2'] })
  })

  it('records the redirect, the title, the paint, and what became of the render process', async () => {
    const response = await timedOut((trace) => {
      trace.enter('navigating')
      trace.mainDocumentRedirected()
      trace.mainDocument('http://127.0.0.1:30010/login', -1)
      trace.pageTitle('sign in')
      trace.pageTitle('')
      trace.firstPaint()
      trace.rendererGone('crashed')
      trace.rendererUnresponsive()
    }, { ...VALID, url: 'http://127.0.0.1:30010/issues' })
    const report = reportOf(response)
    await response.text()
    expect(report.mainDocument).toEqual({ url: 'http://127.0.0.1:30010/login', status: null, redirected: true, title: 'sign in' })
    expect(report.firstPaint).toBe(true)
    expect(report.renderer).toEqual({ gone: 'crashed', unresponsive: true })
  })

  it('counts a blocked request as blocked and not as one the page is waiting for', async () => {
    const response = await timedOut((trace) => {
      trace.enter('navigating')
      trace.requestBlocked('https://www.gravatar.com/avatar/1')
      trace.requestBlocked('https://www.gravatar.com/avatar/2')
      // What Chromium reports for a cancelled request, under an id that never
      // sent headers.
      trace.requestFailed(7, 'net::ERR_BLOCKED_BY_CLIENT')
    })
    const report = reportOf(response)
    await response.text()
    expect(report.requests).toEqual({ total: 0, completed: 0, failed: 0, pending: 0, blocked: 2 })
    expect(report.hosts).toEqual([{ host: 'www.gravatar.com', pending: 0, failed: 0, blocked: 2, maxAgeMs: 0 }])
  })

  it('sends no report with a refusal no render was started for', async () => {
    const held = gate()
    const handle = await start(async () => {
      await held.wait
      return CAPTURE
    }, { queueLimit: 1 })
    const running = post(handle, VALID)
    const busy = await post(handle, VALID)
    expect(busy.status).toBe(503)
    expect(busy.headers.get('x-dsh-render-report')).toBeNull()
    await busy.text()
    held.open()
    await (await running).arrayBuffer()

    const refusals: [unknown, number][] = [[{ ...VALID, width: 1 }, 400], [{ ...VALID, url: 'ftp://host/x' }, 422]]
    for (const [body, status] of refusals) {
      const response = await post(handle, body)
      expect(response.status).toBe(status)
      expect(response.headers.get('x-dsh-render-report')).toBeNull()
      await response.text()
    }
  })

  it('keeps the header under its ceiling and still parseable when the page is at its worst', async () => {
    const long = `https://cdn.example.test/${'segment/'.repeat(250)}`
    const response = await timedOut((trace) => {
      trace.enter('navigating')
      trace.mainDocument(long, 200)
      trace.pageTitle('t'.repeat(2000))
      trace.mainFrameFailed(-105, 'ERR_NAME_NOT_RESOLVED '.repeat(50))
      for (let n = 0; n < 100; n++) trace.requestStarted(n, `${long}${String(n)}.png`, 'image')
      for (let n = 200; n < 260; n++) {
        trace.requestStarted(n, `${long}${String(n)}.js`, 'script')
        trace.requestFailed(n, `net::ERR_${'X'.repeat(200)}`)
      }
      for (let n = 0; n < 50; n++) trace.consoleMessage('error', `boom ${'y'.repeat(2000)}`)
    }, { ...VALID, url: `https://example.test/${'a'.repeat(2000)}` })
    const header = response.headers.get('x-dsh-render-report') ?? ''
    await response.text()
    expect(Buffer.byteLength(header, 'utf8')).toBeLessThanOrEqual(REPORT_HEADER_BYTES)
    const report = JSON.parse(decodeURIComponent(header)) as RenderReport
    expect(report.requests).toEqual({ total: 160, completed: 0, failed: 60, pending: 100, blocked: 0 })
    expect(report.pending).toHaveLength(5)
    expect(report.failed).toHaveLength(5)
    expect(report.console.errors).toBe(50)
    expect(report.console.samples).toHaveLength(3)
    for (const one of report.pending) expect(one.url.endsWith('…')).toBe(true)
    expect(report.requestedUrl.endsWith('…')).toBe(true)
  })

  it('bounds the header in the bytes it costs, not the characters, so a page in Chinese fits too', async () => {
    const long = `https://例え.test/${'搜索'.repeat(1000)}`
    const response = await timedOut((trace) => {
      trace.enter('navigating')
      trace.mainDocument(long, 200)
      trace.pageTitle('标题'.repeat(500))
      for (let n = 0; n < 100; n++) trace.requestStarted(n, `${long}${String(n)}`, '图片')
      for (let n = 0; n < 50; n++) trace.consoleMessage('error', '错误'.repeat(500))
    }, { ...VALID, url: long })
    const header = response.headers.get('x-dsh-render-report') ?? ''
    await response.text()
    expect(Buffer.byteLength(header, 'utf8')).toBeLessThanOrEqual(REPORT_HEADER_BYTES)
    const report = JSON.parse(decodeURIComponent(header)) as RenderReport
    expect(report.console.samples[0]?.endsWith('…')).toBe(true)
    expect(report.mainDocument?.title?.endsWith('…')).toBe(true)
  })
})

describe('a request that names its own deadline', () => {
  it('runs on what it asked for rather than on the deployment default', async () => {
    const handle = await start(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return CAPTURE
    }, { timeoutMs: 60 })
    const answered = await post(handle, { ...VALID, timeoutMs: 2000 })
    expect(answered.status).toBe(200)
    await answered.arrayBuffer()
    expect(reportOf(answered).deadlineMs).toBe(2000)

    const passed = await post(handle, VALID)
    expect(passed.status).toBe(504)
    expect(await passed.text()).toContain('render timed out after 60ms')
  })

  it('refuses a deadline outside the bounds instead of quietly moving it', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    const cases: unknown[] = [
      { ...VALID, timeoutMs: 999 },
      { ...VALID, timeoutMs: 120_001 },
      { ...VALID, timeoutMs: 1500.5 },
      { ...VALID, timeoutMs: '3000' },
      { ...VALID, timeoutMs: null },
    ]
    for (const body of cases) {
      const response = await post(handle, body)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('timeoutMs must be an integer between 1000 and 120000')
    }
    expect(seen).toEqual([])

    for (const timeoutMs of [1000, RENDER_LIMITS.maxTimeoutMs]) {
      const response = await post(handle, { ...VALID, timeoutMs })
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }
    expect(seen.map(request => request.timeoutMs)).toEqual([1000, RENDER_LIMITS.maxTimeoutMs])
  })

  it('refuses an onTimeout it does not implement', async () => {
    const handle = await start(recordingRenderer().renderer)
    for (const onTimeout of ['retry', '', 1, null]) {
      const response = await post(handle, { ...VALID, onTimeout })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('onTimeout must be "fail" or "capture"')
    }
  })
})

describe('the hosts a request refuses to reach', () => {
  it('matches an exact host in any case and a suffix pattern only below it', () => {
    expect(blockedByPattern(['www.gravatar.com'], 'https://WWW.Gravatar.com/avatar/1')).toBe(true)
    expect(blockedByPattern(['www.gravatar.com'], 'https://gravatar.com/avatar/1')).toBe(false)
    expect(blockedByPattern(['*.gravatar.com'], 'https://www.gravatar.com/avatar/1')).toBe(true)
    expect(blockedByPattern(['*.gravatar.com'], 'https://a.b.gravatar.com/avatar/1')).toBe(true)
    expect(blockedByPattern(['*.gravatar.com'], 'https://gravatar.com/avatar/1')).toBe(false)
    expect(blockedByPattern(['*.gravatar.com'], 'https://notgravatar.com/avatar/1')).toBe(false)
    expect(blockedByPattern(['127.0.0.1'], 'http://127.0.0.1:8080/hang.png')).toBe(true)
    expect(blockedByPattern(['example.test'], 'file:///tmp/page.html')).toBe(false)
    expect(blockedByPattern([], 'https://example.test/')).toBe(false)
  })

  it('refuses a list that is not one, an entry that is not a host, and more than it will match', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    const cases: [unknown, string][] = [
      [{ ...VALID, blockHosts: 'gravatar.com' }, 'blockHosts must be an array of host patterns'],
      [{ ...VALID, blockHosts: { host: 'gravatar.com' } }, 'blockHosts must be an array of host patterns'],
      [{ ...VALID, blockHosts: ['a.test', 7] }, 'blockHosts[1] must be a string'],
      [{ ...VALID, blockHosts: [`${'a'.repeat(254)}`] }, 'blockHosts[0] is longer than 253 characters'],
      [{ ...VALID, blockHosts: Array.from({ length: 33 }, (_entry, n) => `h${String(n)}.test`) }, 'blockHosts may name at most 32 host patterns'],
      [{ ...VALID, blockHosts: ['https://gravatar.com'] }, 'blockHosts pattern "https://gravatar.com" must be a host or *.suffix'],
      [{ ...VALID, blockHosts: ['gravatar.com:443'] }, 'blockHosts pattern "gravatar.com:443" must be a host or *.suffix'],
      [{ ...VALID, blockHosts: ['a.test/path'] }, 'blockHosts pattern "a.test/path" must be a host or *.suffix'],
      [{ ...VALID, blockHosts: ['*'] }, 'blockHosts pattern "*" must be a host or *.suffix'],
      [{ ...VALID, blockHosts: ['a.*.test'] }, 'blockHosts pattern "a.*.test" must be a host or *.suffix'],
      [{ ...VALID, blockHosts: [''] }, 'blockHosts pattern "" must be a host or *.suffix'],
    ]
    for (const [body, expected] of cases) {
      const response = await post(handle, body)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain(expected)
    }
    expect(seen).toEqual([])
  })

  it('refuses a pattern that would cancel the page being rendered', async () => {
    const { renderer, seen } = recordingRenderer()
    const handle = await start(renderer)
    const exact = await post(handle, { ...VALID, url: 'https://a.example.test/page', blockHosts: ['cdn.test', 'A.Example.test'] })
    expect(exact.status).toBe(400)
    expect(await exact.text()).toContain('blockHosts pattern "A.Example.test" matches a.example.test, the host of the page being rendered')

    const suffix = await post(handle, { ...VALID, url: 'https://a.example.test/page', blockHosts: ['*.example.test'] })
    expect(suffix.status).toBe(400)
    expect(await suffix.text()).toContain('blockHosts pattern "*.example.test" matches a.example.test, the host of the page being rendered')
    expect(seen).toEqual([])

    // The suffix form does not match the apex, so a page served from it may
    // block its own subdomains.
    const apex = await post(handle, { ...VALID, url: 'https://example.test/page', blockHosts: ['*.example.test'] })
    expect(apex.status).toBe(200)
    await apex.arrayBuffer()
    expect(seen).toHaveLength(1)
  })
})

describe('a deadline the caller asked to be answered with pixels', () => {
  /** What a partial capture hands back, distinct from {@link CAPTURE} so the reply can be told apart. */
  const PARTIAL: Capture = { png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]), width: 800, height: 600 }

  /**
   * A renderer that offers `capture` and then waits out the deadline.
   * @param capture - what the service gets when it takes the offer.
   * @param record - fills the trace the way the window half would.
   * @returns the renderer to inject.
   */
  function offering(capture: CaptureNow, record: (trace: RenderTrace) => void = () => {}): Renderer {
    return async (_request, signal, trace, offerCapture) => {
      record(trace)
      offerCapture(capture)
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('render aborted')) }, { once: true })
      })
      return CAPTURE
    }
  }

  it('answers 200 with what had painted, labelled a timeout', async () => {
    const handle = await start(offering(async () => PARTIAL, (trace) => {
      trace.enter('navigating')
      trace.mainDocument(VALID.url, 200)
      trace.firstPaint()
      trace.requestStarted(1, 'https://www.gravatar.com/avatar/1', 'image')
    }), { timeoutMs: TRACE_TIMEOUT_MS })
    const response = await post(handle, { ...VALID, onTimeout: 'capture' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    const report = reportOf(response)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PARTIAL.png)
    expect(report.outcome).toBe('timeout')
    expect(report.capture).toEqual({ partial: true, width: 800, height: 600 })
    expect(report.loadEventFired).toBe(false)
    expect(report.firstPaint).toBe(true)
    expect(report.requests.pending).toBe(1)
    expect(report.hosts[0]?.host).toBe('www.gravatar.com')
  })

  it('names the landing on a partial capture, the way a complete render does', async () => {
    const handle = await start(offering(async () => PARTIAL, (trace) => {
      trace.mainDocument('http://127.0.0.1:30010/login', 200)
    }), { timeoutMs: TRACE_TIMEOUT_MS })
    const response = await post(handle, { ...VALID, url: 'http://127.0.0.1:30010/issues', onTimeout: 'capture' })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-dsh-render-landed-url')).toBe('http://127.0.0.1:30010/login')
    await response.arrayBuffer()
  })

  it('takes no capture at all for a request that asked to fail', async () => {
    let taken = 0
    const handle = await start(offering(async () => {
      taken++
      return PARTIAL
    }), { timeoutMs: TRACE_TIMEOUT_MS })
    const response = await post(handle, VALID)
    expect(response.status).toBe(504)
    await response.text()
    expect(taken).toBe(0)
  })

  it('falls back to the 504 when the capture fails or when the renderer offered none', async () => {
    const throwing = await start(offering(async () => { throw new Error('window destroyed') }), { timeoutMs: TRACE_TIMEOUT_MS })
    const failed = await post(throwing, { ...VALID, onTimeout: 'capture' })
    expect(failed.status).toBe(504)
    expect(await failed.text()).toContain('render timed out after 60ms')
    expect(reportOf(failed).capture).toBeNull()
    await throwing.close()
    service = undefined

    const silent = await start(tracingRenderer(() => {}), { timeoutMs: TRACE_TIMEOUT_MS })
    const never = await post(silent, { ...VALID, onTimeout: 'capture' })
    expect(never.status).toBe(504)
    await never.text()
  })

  it('goes on serving while a capture that never settles runs out its own cap', async () => {
    const started: string[] = []
    const handle = await start(async (request, signal, _trace, offerCapture) => {
      started.push(request.url)
      if (started.length === 1) {
        offerCapture(() => new Promise<Capture>(() => undefined))
        return new Promise<Capture>(() => undefined)
      }
      signal.throwIfAborted()
      return CAPTURE
    }, { timeoutMs: TRACE_TIMEOUT_MS, captureOnTimeoutMs: 400 })
    const answered: string[] = []
    const first = post(handle, { ...VALID, onTimeout: 'capture' }).then((response) => {
      answered.push('first')
      return response
    })
    await until(() => started.length === 1, 'the first render to start')
    const second = await post(handle, { ...VALID, url: 'https://example.test/after' }).then((response) => {
      answered.push('second')
      return response
    })
    // The queue moved on the moment the deadline passed, so this answered while
    // the first request was still inside its capture cap.
    expect(second.status).toBe(200)
    expect(answered).toEqual(['second'])
    expect(Buffer.from(await second.arrayBuffer())).toEqual(PNG)
    const timedOut = await first
    expect(timedOut.status).toBe(504)
    await timedOut.text()
    expect(answered).toEqual(['second', 'first'])
    expect(started).toEqual([VALID.url, 'https://example.test/after'])
  })
})
