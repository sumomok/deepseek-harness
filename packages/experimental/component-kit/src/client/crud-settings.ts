/**
 * The one setting the data page needs before it is drawn, and how the browser
 * half gets it there.
 *
 * The vendored page's request layer reads `window.$toy_env.VUE_APP_BASE_URL`
 * once, as its module evaluates, and that module evaluates when this row's
 * bundle does — before `apply` runs, and before any route could have been
 * read. So the value is not written ahead of the module; it is applied after,
 * through the kit's own `setBizBasePath`, which rewrites both the captured
 * default and the live request instance. What keeps that from being a race is
 * the renderer: it mounts nothing until {@link crudBasePathReady} has settled,
 * so no request leaves before the path is the configured one.
 *
 * A failed read is a block that cannot open rather than a row that fails: the
 * other renderers here request nothing and draw exactly as before, and the
 * data page draws the line saying its address is not configured. That line is
 * the loud failure; the console also carries the reason.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/crud-settings
 */
import { clientUrl } from '@deepseek-ai/dsh-client-connection/client'
import { setBizBasePath } from '@sumomok/toy-crud-kit'
import { COMPONENT_KIT_SETTINGS_ROUTE, readComponentKitSettings } from '../route.ts'

/** The one read this page performs, memoized for the page's life. */
let settled: Promise<string> | undefined

/**
 * Read the browser-facing half of this plugin's configuration from its node
 * half and apply the base path to the data page's request layer.
 * @returns the base path in force, once applied.
 * @throws {Error} when the route is unreachable, answers non-200, or answers a document without a usable base path.
 */
async function readAndApply(): Promise<string> {
  const url = clientUrl(COMPONENT_KIT_SETTINGS_ROUTE)
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`component-kit: ${url.href} answered ${response.status}`)
  }
  const settings = readComponentKitSettings(await response.json())
  if (settings === undefined) {
    throw new Error(`component-kit: ${url.href} answered a document with no usable bizBasePath`)
  }
  return setBizBasePath(settings.bizBasePath)
}

/**
 * Start the one read of this row's settings, where none has started.
 *
 * Called from the browser half's `apply`, so the read is in flight before
 * any block is drawn; a rejection is kept on the promise for the renderer to
 * read, and reported once to the console rather than left unhandled.
 * @returns the base path in force, once applied.
 */
export function settleCrudBasePath(): Promise<string> {
  if (settled === undefined) {
    settled = readAndApply()
    settled.catch((reason: unknown) => { console.error(`component-kit: the data page cannot open: ${String(reason)}`) })
  }
  return settled
}

/**
 * The read `apply` started, for the renderer to wait on before it mounts.
 * @returns the base path in force, once applied.
 * @throws {Error} when the row's browser half has not started, which is a placement outside this row's plugin.
 */
export function crudBasePathReady(): Promise<string> {
  if (settled === undefined) {
    return Promise.reject(new Error('component-kit: the data page was drawn before the row\'s browser half started'))
  }
  return settled
}
