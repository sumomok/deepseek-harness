/**
 * A page the specs drive by hand: every request for the index stays open until
 * a spec answers it, every timer waits for a spec to advance the clock, and
 * session storage, the reload, the foreground, and the network are plain
 * fields. The served index is rendered by the host's own index renderer, so
 * the markup the specs feed the build check is the markup a server sends.
 *
 * Module-script extraction runs the production parsing over the jsdom
 * `DOMParser`, so specs using this page run in the jsdom environment.
 */

import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'
import { moduleScriptsInIndex, type PageRefreshBrowser, type ServedDocument } from '../src/client/browser.ts'
import { PAGE_REFRESH_ENTRY_ID } from '../src/config.ts'

/** The origin every fake page is served from. */
export const ORIGIN = 'https://console.example'

/** The document URL every fake page is served from. */
export const DOCUMENT_URL = `${ORIGIN}/`

/** One client plugin row of a boot graph. */
export interface Entry {
  id: string
  rev: string
}

/** This plugin's own row, which every graph a page running it boots with lists. */
export const SELF: Entry = { id: PAGE_REFRESH_ENTRY_ID, rev: 'self-1' }

/**
 * Revisions by plugin id for the given entries, {@link SELF} included, as the
 * build check reads them out of a {@link bootGraph}.
 * @param entries - the entries besides {@link SELF}.
 * @returns the revisions.
 */
export function revisions(entries: Record<string, string>): Map<string, string> {
  return new Map([[SELF.id, SELF.rev], ...Object.entries(entries)])
}

/** A boot graph with the fields the host serves, around {@link SELF} and the given entries. */
export function bootGraph(entries: readonly Entry[]): object {
  return {
    rev: 'graph-rev',
    entries: [SELF, ...entries].map(entry => ({ ...entry, url: `plugins/??${entry.id}/client.js&rev=${entry.rev}` })),
    batches: [],
  }
}

/**
 * An index body as the web server serves it: the dist server's `<base>`, the
 * boot graph global rendered by the host's own renderer, and the shell's module
 * scripts.
 * @param entries - the boot graph's entries.
 * @param shell - the module script sources, relative as the shell build writes them.
 * @returns the body.
 */
export function servedIndex(entries: readonly Entry[], shell: readonly string[] = ['./assets/index-A.js']): string {
  const scripts = shell.map(src => `<script type="module" crossorigin src="${src}"></script>`).join('')
  const dist = `<!doctype html><html lang="en"><head><meta charset="utf-8" />${scripts}</head><body><div id="root"></div></body></html>`
  return renderIndexInjections(dist, [{ kind: 'global', name: '__DSH_BOOT__', value: bootGraph(entries) }])
    .replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`)
}

/** One answer a spec gives an open request. */
export interface Answer {
  status?: number
  contentType?: string | null
  body?: string
}

/** One request for the index the fake page has made. */
export interface OpenRequest {
  readonly url: string
  readonly signal: AbortSignal
  answer(answer: Answer): void
  fail(error: Error): void
}

/** One pending timer. */
interface Timer {
  at: number
  run: () => void
  cancelled: boolean
}

/** The page a spec drives. */
export class FakePage implements PageRefreshBrowser {
  navigation: string | undefined = `${DOCUMENT_URL}#chat`
  href = `${DOCUMENT_URL}#later`
  boot: unknown = bootGraph([{ id: 'a', rev: '1' }])
  scripts: string[] = [`${ORIGIN}/assets/index-A.js`]
  readonly session = new Map<string, string>()
  failRead = false
  failWrite = false
  failRemove = false
  reloads = 0
  isOnline = true
  now = 0
  readonly requests: OpenRequest[] = []
  readonly foreground = new Set<() => void>()
  readonly network = new Set<() => void>()
  private readonly timers: Timer[] = []

  navigationUrl(): string | undefined { return this.navigation }
  currentHref(): string { return this.href }
  bootGraph(): unknown { return this.boot }
  moduleScripts(): string[] { return [...this.scripts] }
  moduleScriptsIn(html: string, url: string): string[] {
    return moduleScriptsInIndex(new DOMParser().parseFromString(html, 'text/html'), url)
  }

  fetchDocument(url: string, signal: AbortSignal): Promise<ServedDocument> {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
      this.requests.push({
        url,
        signal,
        answer: ({ status = 200, contentType = 'text/html; charset=utf-8', body = '' }) => {
          resolve({ status, contentType, text: () => Promise.resolve(body) })
        },
        fail: (error) => { reject(error) },
      })
    })
  }

  readSession(key: string): string | null {
    if (this.failRead) throw new Error('session storage is disabled')
    return this.session.get(key) ?? null
  }

  writeSession(key: string, value: string): void {
    if (this.failWrite) throw new Error('session storage is full')
    this.session.set(key, value)
  }

  removeSession(key: string): void {
    if (this.failRemove) throw new Error('session storage is disabled')
    this.session.delete(key)
  }

  reload(): void { this.reloads += 1 }

  schedule(delayMs: number, run: () => void): () => void {
    const timer: Timer = { at: this.now + delayMs, run, cancelled: false }
    this.timers.push(timer)
    return () => { timer.cancelled = true }
  }

  onVisible(listener: () => void): () => void {
    this.foreground.add(listener)
    return () => { this.foreground.delete(listener) }
  }

  online(): boolean { return this.isOnline }

  onOnlineChange(listener: () => void): () => void {
    this.network.add(listener)
    return () => { this.network.delete(listener) }
  }

  /** Move the clock forward, running every timer that falls due, in order. */
  advance(ms: number): void {
    const until = this.now + ms
    for (;;) {
      const due = this.timers.filter(timer => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (due === undefined) break
      due.cancelled = true
      this.now = due.at
      due.run()
    }
    this.now = until
  }

  /** Timers still waiting. */
  pendingTimers(): number {
    return this.timers.filter(timer => !timer.cancelled).length
  }

  /** The page returns to the foreground. */
  showPage(): void {
    for (const listener of [...this.foreground]) listener()
  }

  /** The browser gains or loses its network. */
  setOnline(online: boolean): void {
    this.isOnline = online
    for (const listener of [...this.network]) listener()
  }

  /** The most recent request, which a spec answers. */
  lastRequest(): OpenRequest {
    const request = this.requests.at(-1)
    if (request === undefined) throw new Error('the page made no request')
    return request
  }
}

/** Let every settled promise continuation run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
