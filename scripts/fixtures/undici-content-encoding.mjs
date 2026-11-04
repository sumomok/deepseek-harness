/**
 * Exercise the Content-Encoding DoS fix in a child process.
 *
 * The fixture serves one response with six content encodings, one response
 * whose declared length exceeds the bytes it sends before it disconnects, and
 * a healthy response after both. A runtime carrying the vulnerable Undici may
 * terminate here, so the parent test only observes the child's exit status and
 * stdout; it never runs the malformed responses in the Vitest process.
 */

import { createServer } from 'node:http'

const server = createServer((request, response) => {
  if (request.url === '/layered') {
    response.writeHead(200, {
      'content-encoding': 'gzip, deflate, br, zstd, gzip, deflate',
      'content-length': '1',
      'content-type': 'text/plain',
    })
    response.end('x')
    return
  }
  if (request.url === '/truncated') {
    response.writeHead(200, {
      'content-encoding': 'gzip',
      'content-length': '4096',
      'content-type': 'text/plain',
    })
    response.write('short')
    response.destroy()
    return
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
    return
  }
  response.writeHead(404)
  response.end()
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const origin = `http://127.0.0.1:${server.address().port}`

/** Describe an error without assuming a cause exists. */
function describe(error) {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) }
  const cause = error.cause
  return {
    name: error.name,
    message: error.message,
    cause: cause instanceof Error ? { name: cause.name, message: cause.message } : undefined,
  }
}

/** Request one fixture path, recording whether the response or the request failed. */
async function attempt(path) {
  try {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(5000) })
    return { response: { status: response.status, body: await response.text() } }
  } catch (error) {
    return { error: describe(error) }
  }
}

const layered = await attempt('/layered')
const truncated = await attempt('/truncated')
const health = await attempt('/health')
server.closeAllConnections()
server.close()
console.log(JSON.stringify({ layered, truncated, health }))
