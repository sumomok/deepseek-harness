/**
 * @deepseek-ai/dsh-experimental-content-frame — the shell's content column as
 * a surface the agent drives. The node half serves a configured directory
 * under a named webserver route, offers the deployment's pages to the model as
 * `content_show`, and projects what each session's column shows; the browser
 * half claims the column and keeps one live frame per session.
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
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: resolves ctx.contentSurface for the optional extractor child.
import type {} from '@deepseek-ai/dsh-experimental-content-surface'
import type { ContentPage } from './types.ts'
import { indexPages } from './pages.ts'
import { contentProjection } from './projection.ts'
import { pageExtractor } from './surface.ts'
import { contentShowTool } from './tool.ts'
import { CONTENT_APP_ROUTE, CONTENT_SETTINGS_ROUTE, type ContentFrameSettings } from './route.ts'
import { serveContentApp } from './serve.ts'

// The `content/shown` and `content` declarations live in src/types.ts (their
// one home); this re-export projects the type face onto the package root and
// keeps the module edge in the emitted index.d.ts.
export type * from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'content-frame'

/** Service required before the route can be claimed. */
export const inject = ['webServer']

/** Plugin config: the hosted application, and the pages the agent may show from it. */
export interface Config {
  /**
   * Absolute path of the directory the content column's pages are served
   * from. Required with no default: which application a deployment hosts is
   * the whole decision this plugin exists to carry, and the trust it grants
   * that directory makes an inferred location the wrong kind of convenience.
   */
  root: string
  /**
   * The pages the agent may put in the column, in the order the tool
   * description offers them. At least one is required — `content_show` exists
   * to choose among these, and an empty list leaves the model a tool it can
   * never call successfully. Each `url` must be a same-origin path.
   */
  pages: ContentPage[]
  /**
   * Page the `content` projection reports while a session has shown nothing
   * yet, and after the agent clears the column. Must name a configured page.
   * Omit to leave that value empty until the agent fills it. The content
   * column itself does not show it: the column is a stream of what a session
   * produced, and a default page is not something any session produced.
   */
  defaultPage?: string
  /**
   * How many frames the browser keeps alive at once, counted over (session,
   * page) pairs. A cached frame keeps its live document — scroll position,
   * form state, whatever the page holds — across a switch to another page,
   * another content kind, or another session; the least recently shown one is
   * dropped past this bound, and reloads when it comes back. Raise it for a
   * deployment whose users move between many pages and sessions and whose
   * pages are expensive to reload; lower it to bound the browser's memory.
   */
  cacheSize?: number
}

/** Default frame cache size: the current session plus the two before it. */
const DEFAULT_CACHE_SIZE = 3

export const Config: z<Config> = z.object({
  root: z.string().required(),
  pages: z.array(z.object({
    id: z.string().required(),
    title: z.string().required(),
    description: z.string().required(),
    url: z.string().required(),
  })).required(),
  defaultPage: z.string(),
  cacheSize: z.natural().default(DEFAULT_CACHE_SIZE),
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
 * Validate the configuration, then claim the route, the tool, and the
 * projection unit.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Loud at load, all of it: a root that is not a directory would answer every
  // request with 404, and a broken page list would surface as a tool call the
  // agent cannot get right — both with no diagnostic pointing at the row.
  const pages = indexPages(config.pages, config.defaultPage)
  const cacheSize = config.cacheSize ?? DEFAULT_CACHE_SIZE
  if (cacheSize < 1) throw new Error(`content-frame: cacheSize must be at least 1, received ${cacheSize}`)
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
  const settings: ContentFrameSettings = { cacheSize }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONTENT_SETTINGS_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      // The browser half reads this once per boot and the values come from the
      // row it booted with, so a cached copy would outlive its own truth.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(settings))
    },
  }), 'content-frame: browser settings route')
  // Every child activates only when its seam is composed: a deployment without
  // a tool runtime, without a projection registry, or without the content
  // column's router keeps the route, and the browser shows nothing.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(contentShowTool(pages))
  })
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(contentProjection(pages, config.defaultPage))
  })
  ctx.inject(['contentSurface'], (surfaceCtx) => {
    surfaceCtx.contentSurface.register(pageExtractor(pages))
  })
}
