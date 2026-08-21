/**
 * @deepseek-ai/dsh-experimental-content-frame — shows one self-hosted static
 * web application in the service-line shell's content column. The node half
 * serves a configured directory under a named webserver route; the browser
 * half claims the `content` slot with an iframe over that route.
 *
 * Trust: the route answers on the dsh origin and the iframe carries no
 * `sandbox` attribute, so the document inside it is same-origin with the shell
 * and reaches the dsh HTTP API with the shell's own authority. `root` must
 * name a directory whose contents are trusted exactly as much as the harness
 * itself — see the package README's trust section.
 * @module @deepseek-ai/dsh-experimental-content-frame
 */

import { isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CONTENT_APP_ROUTE } from './route.ts'
import { serveContentApp } from './serve.ts'

/** Stable Cordis plugin name. */
export const name = 'content-frame'

/** Service required before the route can be claimed. */
export const inject = ['webServer']

/** Plugin config: the hosted application's location. */
export interface Config {
  /**
   * Absolute path of the directory whose `index.html` the content column
   * shows. Required with no default: which application a deployment hosts is
   * the whole decision this plugin exists to carry, and the trust it grants
   * that directory makes an inferred location the wrong kind of convenience.
   */
  root: string
}

export const Config: z<Config> = z.object({
  root: z.string().required(),
})

/**
 * Resolve and validate the configured root.
 * @param configured - the `root` config value.
 * @returns the directory's real path, symlinks resolved once for every later
 * containment check.
 * @throws {Error} when the path is relative, missing, or not a directory.
 */
async function resolveRoot(configured: string): Promise<string> {
  if (!isAbsolute(configured)) {
    throw new Error(`content-frame: root must be an absolute path, received "${configured}"`)
  }
  const info = await stat(configured).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw new Error(`content-frame: root "${configured}" is not an existing directory`)
  }
  return await realpath(configured)
}

/**
 * Validate the root and claim the hosted application's route.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Loud at load: a root that is not a directory would answer every request
  // with 404 and leave the column showing an empty iframe and no diagnostic.
  const root = await resolveRoot(config.root)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CONTENT_APP_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // `allow` because this route owns its whole prefix: nothing else can
        // answer the method the caller asked for, so the response states the
        // complete set, as 405 requires.
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      /* v8 ignore next -- node:http always sets url on server requests */
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      await serveContentApp(pathname.slice(CONTENT_APP_ROUTE.length), res, root)
    },
  }), 'content-frame: hosted application route')
}
