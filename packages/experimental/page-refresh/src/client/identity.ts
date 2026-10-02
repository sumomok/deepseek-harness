/**
 * What identifies a build of the web page, and how one is read out of a served
 * index. A build is identified by two things the index carries: the boot graph
 * the host composes — every client plugin by id with its revision — and the
 * web shell's own module scripts, whose file names carry the shell's build
 * hash. A restart that serves the same files serves the same identity; a
 * rebuild, an upgrade, or a change to the composed client plugins does not.
 * @module @deepseek-ai/dsh-experimental-page-refresh/src/client/identity
 */

import type { PageRefreshBrowser } from './browser.ts'

/** One build of the web page. */
export interface BuildIdentity {
  /** Client plugin revisions by plugin id; the order the graph listed them in plays no part. */
  readonly entries: ReadonlyMap<string, string>
  /** Absolute URLs of the shell's module scripts, sorted. */
  readonly shell: readonly string[]
}

/** What one request for the served index established. */
export type ServedBuild =
  /** The index carries a readable build. */
  | { readonly kind: 'known'; readonly identity: BuildIdentity }
  /** It does not, for the reason named; nothing is concluded from such an answer. */
  | { readonly kind: 'unknown'; readonly reason: string }

/**
 * The exact markup the host's index renderer opens the boot graph global with
 * (`renderIndexInjections` in `@deepseek-ai/dsh-host-webserver`). The JSON that
 * follows has every `<` escaped, so the first `</script>` after it closes it.
 */
export const BOOT_MARKUP_PREFIX = '<script>globalThis["__DSH_BOOT__"] = '

/** Markup closing the boot graph global. */
const BOOT_MARKUP_SUFFIX = '</script>'

/**
 * The URL the document was served from: the navigation entry's, falling back to
 * the address the page had when this plugin started, either without its
 * fragment, which no request carries.
 * @param navigationUrl - the navigation entry URL, when the page records one.
 * @param startHref - the page's address when this plugin started.
 * @returns the document URL.
 */
export function documentUrlOf(navigationUrl: string | undefined, startHref: string): string {
  const url = new URL(navigationUrl ?? startHref)
  url.hash = ''
  return url.href
}

/**
 * Read client plugin revisions out of one boot graph.
 * @param graph - the graph, as assigned or as parsed; unvalidated.
 * @returns revisions by plugin id, or `undefined` when the graph carries no
 * `entries` array of `{ id: string, rev: string }` with distinct ids.
 */
export function bootEntriesOf(graph: unknown): Map<string, string> | undefined {
  if (typeof graph !== 'object' || graph === null || !('entries' in graph) || !Array.isArray(graph.entries)) {
    return undefined
  }
  const listed: readonly unknown[] = graph.entries
  const revisions = new Map<string, string>()
  for (const entry of listed) {
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || !('rev' in entry)) return undefined
    const { id, rev } = entry
    if (typeof id !== 'string' || typeof rev !== 'string' || revisions.has(id)) return undefined
    revisions.set(id, rev)
  }
  return revisions
}

/**
 * Read the boot graph out of a served index body.
 * @param html - the index body.
 * @returns the parsed graph, or the reason none could be read.
 */
export function bootGraphIn(html: string): { readonly graph: unknown } | { readonly reason: string } {
  const start = html.indexOf(BOOT_MARKUP_PREFIX)
  if (start === -1) return { reason: 'the index carries no boot graph' }
  const from = start + BOOT_MARKUP_PREFIX.length
  const end = html.indexOf(BOOT_MARKUP_SUFFIX, from)
  if (end === -1) return { reason: 'the boot graph is not closed' }
  try {
    const graph: unknown = JSON.parse(html.slice(from, end))
    return { graph }
  } catch (_notJson) {
    return { reason: 'the boot graph is not JSON' }
  }
}

/**
 * Whether two builds are the same build: the same plugin ids with the same
 * revisions, and the same shell scripts.
 * @param a - one build.
 * @param b - the other.
 * @returns `true` when they are the same build.
 */
export function sameBuild(a: BuildIdentity, b: BuildIdentity): boolean {
  if (a.entries.size !== b.entries.size || a.shell.length !== b.shell.length) return false
  for (const [id, rev] of a.entries) {
    if (b.entries.get(id) !== rev) return false
  }
  return a.shell.every((url, index) => b.shell[index] === url)
}

/**
 * A stable text naming one build, independent of the order its graph listed
 * the plugins in: the reload guard stores it to recognize a build it already
 * reloaded for.
 * @param identity - the build.
 * @returns its key.
 */
export function buildKey(identity: BuildIdentity): string {
  const entries = [...identity.entries].sort(([a], [b]) => (a < b ? -1 : 1))
  return JSON.stringify({ entries, shell: identity.shell })
}

/**
 * Request the index the document was served from and read the build it carries.
 * Only a 200 answer of type `text/html` that carries the boot graph markup with
 * a valid graph is a known build; every other answer is unknown.
 * @param browser - the page operations.
 * @param url - the document URL.
 * @param signal - aborts the request.
 * @returns the served build.
 * @throws {Error} when the request fails or is aborted.
 */
export async function readServedBuild(
  browser: Pick<PageRefreshBrowser, 'fetchDocument' | 'moduleScriptsIn'>,
  url: string,
  signal: AbortSignal,
): Promise<ServedBuild> {
  const answer = await browser.fetchDocument(url, signal)
  if (answer.status !== 200) return { kind: 'unknown', reason: `the index answered ${String(answer.status)}` }
  const mediaType = answer.contentType?.replace(/;.*$/su, '').trim().toLowerCase()
  if (mediaType !== 'text/html') {
    return { kind: 'unknown', reason: `the index answered ${answer.contentType ?? 'no content type'}` }
  }
  const html = await answer.text()
  const read = bootGraphIn(html)
  if ('reason' in read) return { kind: 'unknown', reason: read.reason }
  const entries = bootEntriesOf(read.graph)
  if (entries === undefined) return { kind: 'unknown', reason: 'the boot graph lists no valid entries' }
  return { kind: 'known', identity: { entries, shell: browser.moduleScriptsIn(html, url) } }
}
