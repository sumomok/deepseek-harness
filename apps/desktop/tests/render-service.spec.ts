/**
 * The loopback render protocol: what it refuses, in what order it decides, and
 * what it does with the requests it accepts. The window half is injected, so
 * everything here runs without a display.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  RENDER_LIMITS, startRenderService,
  type RenderLimits, type RenderRequest, type RenderServiceHandle, type Renderer,
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
    const handle = await start(async (_request, signal) => {
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

  it('counts the wait in the deadline, so a queued request never opens a window', async () => {
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
    expect(started).toEqual([VALID.url])
    held.open()
    const firstResponse = await first
    expect(firstResponse.status).toBe(504)
    await firstResponse.text()
  })
})
