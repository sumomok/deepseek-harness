/**
 * The configured page list, validated once at load and then read by both
 * host-side registrants: the tool resolves an id the agent named, and the
 * projection resolves the id a log recorded. Validation lives here rather than
 * in either of them so a deployment learns about a broken page list when the
 * row loads, not when the agent first calls the tool.
 */

import { isPrintable, MAX_NAME_CHARS } from './access/wire.ts'
import type { ContentPage } from './types.ts'

/** The id `content_show` reserves for "empty the column"; never a page id. */
export const CLEAR_PAGE = 'none'

/** Configured pages indexed by id, in declaration order. */
export type PageIndex = ReadonlyMap<string, ContentPage>

/**
 * Whether a page URL is a same-origin path this plugin will put in the frame.
 *
 * The frame carries the shell's own authority (see the package README's trust
 * section), so a page URL may only address the dsh origin: an absolute path,
 * never a scheme and never the protocol-relative `//host/path` form a browser
 * resolves to a foreign origin.
 * @param url - the configured `url` value.
 * @returns whether the value is a site-root-relative path.
 */
function isSameOriginPath(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//')
}

/**
 * Reject a page id a read report could not carry, at load.
 *
 * The id is the one configured string a browser seat posts exactly as the
 * deployment wrote it: every other page string reaches the wire through the
 * seat's own removal and clipping, so only this one can turn a working read
 * into a report the parser refuses. That refusal would reach the model as a
 * console that never answered, with nothing naming the row that caused it.
 * @param page - the configured page.
 * @param at - the page's position in the list, counted from one.
 * @throws {Error} when the id is longer than the wire's bound on a name, or
 * carries a code point a posted document may not.
 */
function requirePostableId(page: ContentPage, at: number): void {
  if (page.id.length > MAX_NAME_CHARS) {
    throw new Error(
      `content-frame: page ${String(at)} id must be at most ${String(MAX_NAME_CHARS)} characters, received ${String(page.id.length)}`)
  }
  if (!isPrintable(page.id)) {
    throw new Error(
      `content-frame: page ${String(at)} id ${JSON.stringify(page.id)} carries a control character or a lone `
      + 'surrogate, which a read report cannot carry')
  }
}

/**
 * Validate the configured pages and index them by id.
 * @param pages - the `pages` config value, in declaration order.
 * @param defaultPage - the `defaultPage` config value, when set.
 * @returns the id index, in declaration order.
 * @throws {Error} when the list is empty, an id repeats, is blank, or is one a
 * read report could not carry, a URL is not a same-origin path, an id collides
 * with the reserved clear id, or `defaultPage` names no configured page.
 */
export function indexPages(pages: readonly ContentPage[], defaultPage: string | undefined): PageIndex {
  if (pages.length === 0) {
    throw new Error('content-frame: pages must list at least one page — the content_show tool has nothing to offer otherwise')
  }
  const index = new Map<string, ContentPage>()
  for (const [at, page] of pages.entries()) {
    if (page.id.length === 0) throw new Error('content-frame: every page needs a non-empty id')
    requirePostableId(page, at + 1)
    if (page.id === CLEAR_PAGE) {
      throw new Error(`content-frame: "${CLEAR_PAGE}" is reserved for clearing the column and cannot be a page id`)
    }
    if (index.has(page.id)) throw new Error(`content-frame: duplicate page id "${page.id}"`)
    if (!isSameOriginPath(page.url)) {
      throw new Error(
        `content-frame: page "${page.id}" url must be a same-origin path starting with a single "/", received "${page.url}"`)
    }
    index.set(page.id, page)
  }
  if (defaultPage !== undefined && !index.has(defaultPage)) {
    throw new Error(`content-frame: defaultPage "${defaultPage}" names no configured page`)
  }
  return index
}
