/**
 * The loopback render protocol: what it refuses, in what order it decides, and
 * what it does with the requests it accepts. The window half is injected, so
 * everything here runs without a display.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  RENDER_LIMITS, startRenderService,
  type RenderLimits, type RenderPhase, type RenderRequest, type RenderServiceHandle, type RenderTrace, type Renderer,
} from '../src/render-service.ts'

/** Stand-in for encoded pixels; the service must hand these back untouched. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])

/** A request every field of which is valid, used wherever the body is not what is under test. */
const VALID = { url: 'https://example.test/page', width: 800, height: 600 }

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

/** A renderer that answers every request with {@link PNG} and records what it was asked for. */
function recordingRenderer(): { renderer: Renderer; seen: RenderRequest[] } {
  const seen: RenderRequest[] = []
  return {
    seen,
    renderer: async (request) => {
      seen.push(request)
      return PNG
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
    return PNG
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
      { url: VALID.url, width: 800, height: 600, fullPage: false, delayMs: 0 },
      { url: VALID.url, width: 800, height: 600, fullPage: true, delayMs: 250 },
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
        headers: { 'X-Api-Key': 'k' },
        cookies: { _redmine_session: 'abc' },
      },
      { url: VALID.url, width: 800, height: 600, fullPage: false, delayMs: 0 },
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
      return PNG
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
      return PNG
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
      return PNG
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
    const handle = await start(async () => PNG, { queueLimit: 1 })
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
      return PNG
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
      if (seen.length === 1) return new Promise<Buffer>(() => undefined)
      return PNG
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
      trace.requestSettled(1)
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
      trace.requestSettled(99)
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
      return PNG
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
