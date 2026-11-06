/**
 * The title the data move's window and the data-location message boxes carry:
 * the product name in the system locale's language. Electron is a stand-in
 * that records the options each window and box is opened with.
 * @module
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_NAME } from '../src/brand.ts'
import { moveText } from '../src/move-text.ts'

const electron = vi.hoisted(() => ({
  locale: 'en-US',
  windows: [] as { title?: string }[],
  boxes: [] as { title?: string }[],
}))

vi.mock('electron', () => {
  /** A window that records its options and accepts the calls `openMoveWindow` makes. */
  class FakeWindow {
    readonly webContents = { setWindowOpenHandler: () => undefined, on: () => undefined }

    /** @param options - the constructor options, recorded. */
    constructor(options: { title?: string }) {
      electron.windows.push(options)
    }

    /** @returns this window. */
    on(): this {
      return this
    }

    /** @returns a settled load. */
    loadURL(): Promise<void> {
      return Promise.resolve()
    }

    /** @returns false: the window stays open. */
    isDestroyed(): boolean {
      return false
    }
  }
  return {
    app: { getLocale: () => electron.locale, getPath: () => '/fake' },
    BrowserWindow: FakeWindow,
    dialog: {
      showMessageBox: (_window: unknown, options: { title?: string }) => {
        electron.boxes.push(options)
        return Promise.resolve({ response: 0 })
      },
    },
    shell: { showItemInFolder: () => undefined },
  }
})

vi.mock('../src/theme.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/theme.ts')>(),
  resolveAppearance: () => 'light' as const,
}))

const { openMoveWindow } = await import('../src/move-window.ts')
const { appDataLocationHost } = await import('../src/data-location-window.ts')
const { BrowserWindow } = await import('electron')

beforeEach(() => {
  electron.windows.length = 0
  electron.boxes.length = 0
})

describe.each([
  { locale: 'zh-CN', name: PRODUCT_NAME.zh },
  { locale: 'en-US', name: PRODUCT_NAME.en },
])('under the $locale locale', ({ locale, name }) => {
  beforeEach(() => { electron.locale = locale })

  it(`titles the data move's window ${name}`, () => {
    openMoveWindow(moveText(locale), () => undefined)
    expect(electron.windows.map(options => options.title)).toEqual([name])
  })

  it(`titles the data-location message box ${name}`, async () => {
    await appDataLocationHost(new BrowserWindow(), () => undefined, () => undefined).tell('message')
    expect(electron.boxes.map(options => options.title)).toEqual([name])
  })
})
