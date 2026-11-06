/**
 * The app window's preload as the page sees it: it marks the document as a
 * desktop surface and reports the palette the page paints, first when the
 * observer starts and again whenever the root element's published theme
 * changes — the signal the shell needs when only the OS appearance moved.
 *
 * The preload runs in Electron's sandbox, not in this process, so the suite
 * evaluates its shipped source with the window, document, and observer handed
 * in. Its two `import` lines are the only part rewritten; everything the test
 * drives is the code that ships.
 * @module
 */

import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  sent: [] as { channel: string; payload: unknown }[],
  observers: [] as (() => void)[],
}))

/**
 * The preload compiled the way its build compiles it: TypeScript erased, its
 * `electron` import left as a `require` the runner supplies.
 */
const PRELOAD = transformSync(
  readFileSync(new URL('../src/preload.cts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code

/** Records the callback the preload observes with, so a test can fire it. */
class FakeMutationObserver {
  constructor(callback: () => void) {
    fixture.observers.push(callback)
  }

  observe(): void {}
  disconnect(): void {}
}

/** The root element's published facts, in the properties the preload reads and writes. */
interface FakeDocument {
  documentElement: {
    dataset: Record<string, string>
    style: {
      colorScheme: string
      setProperty(name: string, value: string): void
      getPropertyValue(name: string): string
    }
  }
  readyState: string
}

/**
 * Run the preload against a document root carrying these facts.
 * @param facts - published theme source, painted palette, and whatever else the root carries.
 * @returns the document the preload ran against, for later mutation.
 */
function runPreload(facts: { source?: string; scheme?: string } = {}, platform = 'darwin'): FakeDocument {
  const dataset: Record<string, string> = {}
  if (facts.source !== undefined) dataset.dsThemeSource = facts.source
  const properties: Record<string, string> = {}
  const document: FakeDocument = {
    documentElement: {
      dataset,
      style: {
        colorScheme: facts.scheme ?? '',
        setProperty: (name, value) => { properties[name] = value },
        getPropertyValue: name => properties[name] ?? '',
      },
    },
    readyState: 'complete',
  }
  const ipcRenderer = { send: (channel: string, payload: unknown): void => { fixture.sent.push({ channel, payload }) } }
  const contextBridge = { exposeInMainWorld: (): void => {} }
  const window = { addEventListener: (): void => {} }
  const electron = { contextBridge, ipcRenderer }
  // `process` shadows the global so the platform mark is the same on every host.
  const processStub = { platform }
  new Function('require', 'exports', 'document', 'window', 'MutationObserver', 'process', PRELOAD)(
    (id: string) => (id === 'electron' ? electron : undefined),
    {},
    document,
    window,
    FakeMutationObserver,
    processStub,
  )
  return document
}

/** Fire every installed observer, as a root-element mutation would. */
function mutate(): void {
  for (const notify of fixture.observers) notify()
}

beforeEach(() => {
  fixture.sent = []
  fixture.observers = []
})

describe('the window preload theme report', () => {
  it('marks the document as the platform it runs on', () => {
    expect(runPreload().documentElement.dataset.platform).toBe('darwin')
  })

  it('reserves the Windows caption strip and its height', () => {
    const document = runPreload({}, 'win32')
    expect(document.documentElement.dataset.windowsTitlebar).toBe('')
    expect(document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height')).toBe('40px')
  })

  it('leaves other platforms without a caption strip', () => {
    const document = runPreload({}, 'darwin')
    expect(document.documentElement.dataset.windowsTitlebar).toBeUndefined()
    expect(document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height')).toBe('')
  })

  it('reports the palette the served UI published when observation starts', () => {
    runPreload({ source: 'system', scheme: 'dark' })
    expect(fixture.sent).toEqual([{ channel: 'dsh-desktop:theme-report', payload: { source: 'system', scheme: 'dark' } }])
  })

  it('reports again when the OS appearance resolves another palette', () => {
    const document = runPreload({ source: 'system', scheme: 'dark' })
    document.documentElement.style.colorScheme = 'light'
    mutate()
    expect(fixture.sent.at(-1)).toEqual({ channel: 'dsh-desktop:theme-report', payload: { source: 'system', scheme: 'light' } })
  })

  it('reports an explicit preference together with the palette it paints', () => {
    const document = runPreload()
    document.documentElement.dataset.dsThemeSource = 'dark'
    document.documentElement.style.colorScheme = 'dark'
    mutate()
    expect(fixture.sent).toEqual([{ channel: 'dsh-desktop:theme-report', payload: { source: 'dark', scheme: 'dark' } }])
  })

  it('says nothing until the page has both facts, and never repeats a report', () => {
    const document = runPreload({ scheme: 'dark' })
    expect(fixture.sent).toEqual([])
    document.documentElement.dataset.dsThemeSource = 'system'
    mutate()
    mutate()
    expect(fixture.sent).toEqual([{ channel: 'dsh-desktop:theme-report', payload: { source: 'system', scheme: 'dark' } }])
  })

  it('ignores a palette or source the shell cannot apply', () => {
    const document = runPreload({ source: 'sepia', scheme: 'dark' })
    expect(fixture.sent).toEqual([])
    document.documentElement.dataset.dsThemeSource = 'system'
    document.documentElement.style.colorScheme = ''
    mutate()
    expect(fixture.sent).toEqual([])
  })
})
