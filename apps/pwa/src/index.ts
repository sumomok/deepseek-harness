/**
 * @deepseek-ai/dsh-pwa — installable-web-app layer over the `dsh web` surface.
 *
 * A composition-layer plugin: it registers the web-app manifest, the service
 * worker, and the icon files as named webserver routes, and injects their
 * references (manifest link, theme color, apple-touch icon, service-worker
 * registration) into every served index.html through the webserver's index
 * tap. The frontend build is untouched; mounting this plugin is what makes
 * the served UI installable from Chrome/Edge (desktop and Android) and
 * addable to the iOS home screen.
 *
 * Installability requires a secure context: `http://127.0.0.1` counts, a bare
 * LAN `http://<ip>` does not — the injected registration script skips the
 * service worker there instead of failing the page. See the package README
 * for the LAN and HTTPS paths.
 * @module @deepseek-ai/dsh-pwa
 */

import { readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'pwa'

/** Service required before the routes and index tap can register. */
export const inject = ['webServer']

/** Plugin config: the identity the installed app shows on the OS. */
export interface Config {
  /** Full name shown by install prompts and the OS app list. */
  appName: string
  /** Short name shown under the launcher icon. */
  shortName: string
  /** Toolbar/theme color of the installed window (CSS color). */
  themeColor: string
  /** Splash background while the installed app loads (CSS color). */
  backgroundColor: string
}

export const Config: z<Config> = z.object({
  appName: z.string().default('DeepSeek Harness'),
  shortName: z.string().default('dsh'),
  themeColor: z.string().default('#10131a'),
  backgroundColor: z.string().default('#10131a'),
})

/** Icon files this package ships; route path → asset filename with its manifest size. */
const ICONS = {
  'icon-192.png': { sizes: '192x192', purpose: 'any' },
  'icon-512.png': { sizes: '512x512', purpose: 'any' },
  'icon-maskable-512.png': { sizes: '512x512', purpose: 'maskable' },
  'apple-touch-icon.png': { sizes: '180x180', purpose: 'any' },
} as const

/** Route prefix the icon files are served under. */
const ICON_PREFIX = '/pwa'

/** Shipped icon directory (beside `lib/` in both source and built layouts). */
const ASSET_DIR = fileURLToPath(new URL('../assets/', import.meta.url))

/**
 * Render the web-app manifest body.
 * @param config - validated {@link Config}.
 * @returns the manifest JSON text.
 */
export function renderManifest(config: Config): string {
  return JSON.stringify({
    id: '/',
    name: config.appName,
    short_name: config.shortName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: config.themeColor,
    background_color: config.backgroundColor,
    icons: Object.entries(ICONS)
      .filter(([file]) => file !== 'apple-touch-icon.png')
      .map(([file, meta]) => ({
        src: `${ICON_PREFIX}/${file}`,
        sizes: meta.sizes,
        type: 'image/png',
        purpose: meta.purpose,
      })),
  })
}

/**
 * The service worker: it precaches `/` at install and answers navigation
 * requests network-first with the cached index as the offline fallback.
 * Static assets are left to the network — the API and SSE surfaces must never
 * be cached, and the index tap re-renders `/` per request, so a broader cache
 * would serve stale boot manifests.
 */
const SERVICE_WORKER = `'use strict'
const CACHE = 'dsh-pwa-v1'
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/')))
  self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' || request.mode !== 'navigate') return
  event.respondWith(fetch(request).then((response) => {
    const copy = response.clone()
    void caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => undefined)
    return response
  }).catch(async () => {
    const cached = await caches.match('/')
    return cached ?? new Response('dsh is offline and no cached shell exists yet.', { status: 503 })
  }))
})
`

/**
 * The head fragment for one index response: theme color, apple-touch icon,
 * and the service-worker registration, plus a manifest link only when the
 * frontend does not carry its own (the shipped dist already links
 * `/manifest.webmanifest`, whose content this plugin's exact route shadows).
 * Registration is skipped outside secure contexts (plain-HTTP LAN) so the
 * page keeps working there without console errors.
 * @param config - validated {@link Config}.
 * @param html - the index body the fragment is composed against.
 * @returns the HTML fragment ending with a newline.
 */
export function renderHeadFragment(config: Config, html: string): string {
  const parts: string[] = []
  if (!html.includes('rel="manifest"')) parts.push('<link rel="manifest" href="/manifest.webmanifest">')
  if (!html.includes('name="theme-color"')) parts.push(`<meta name="theme-color" content="${config.themeColor}">`)
  if (!html.includes('rel="apple-touch-icon"')) parts.push(`<link rel="apple-touch-icon" href="${ICON_PREFIX}/apple-touch-icon.png">`)
  parts.push('<script>if ("serviceWorker" in navigator && window.isSecureContext) { window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}) }) }</script>')
  return parts.join('\n') + '\n'
}

/**
 * Inject the head fragment before `</head>`; an index without a head section
 * is returned unchanged (the tap must never break serving).
 * @param html - the index.html body.
 * @param fragment - the head fragment from {@link renderHeadFragment}.
 * @returns the transformed body.
 */
export function injectHead(html: string, fragment: string): string {
  const at = html.indexOf('</head>')
  if (at === -1) return html
  return html.slice(0, at) + fragment + html.slice(at)
}

/** Write one fully-known body with its content type. */
function send(res: ServerResponse, contentType: string, body: string | Buffer): void {
  res.writeHead(200, { 'content-type': contentType })
  res.end(body)
}

/**
 * Register the manifest, service-worker, and icon routes plus the index tap.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const manifest = renderManifest(config)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/manifest.webmanifest',
    handler: async (_req, res) => { send(res, 'application/manifest+json', manifest) },
  }), 'pwa: manifest route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/sw.js',
    handler: async (_req, res) => { send(res, 'text/javascript; charset=utf-8', SERVICE_WORKER) },
  }), 'pwa: service-worker route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ICON_PREFIX,
    handler: async (req, res) => {
      /* v8 ignore next -- node:http always sets url on server requests */
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const file = pathname.slice(ICON_PREFIX.length + 1)
      if (!Object.hasOwn(ICONS, file)) {
        res.writeHead(404)
        res.end()
        return
      }
      send(res, 'image/png', await readFile(join(ASSET_DIR, file)))
    },
  }), 'pwa: icon routes')
  ctx.effect(() => ctx.webServer.tapIndex(html => injectHead(html, renderHeadFragment(config, html))), 'pwa: index tap')
}
