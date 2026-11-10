/**
 * Product-window bridge: marks the document as a desktop surface and carries
 * the native input and keybinding preferences the shared client expects from
 * `window.dshDesktop`. A sandboxed preload may only require `electron`.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
/** Mirrors `shortcut-channels.ts`; a sandboxed preload cannot import it. */
const SHORTCUT_CHANNELS = {
  input: 'dsh-desktop:shortcuts-input',
  get: 'dsh-desktop:shortcuts-get',
  edit: 'dsh-desktop:shortcuts-edit',
  changed: 'dsh-desktop:shortcuts-changed',
  closeWindow: 'dsh-desktop:shortcuts-close-window',
} as const

/** Mirrors `theme-channels.ts`; a sandboxed preload cannot import it. */
const THEME_CHANNEL = 'dsh-desktop:theme-report'

/** Mirrors `windows-layout.ts`; a sandboxed preload cannot import it. */
const WINDOWS_TITLEBAR_HEIGHT = 40

/** Marks `<html data-platform>` before the page's first script reads it. */
function markPlatform(): void {
  const mark = (): void => { document.documentElement.dataset.platform = process.platform }
  // A preload runs before the document root exists; `documentElement` is null then.
  const root = document.documentElement as HTMLElement | null
  if (root === null) window.addEventListener('DOMContentLoaded', mark)
  else mark()
}

/**
 * Reserves the Windows caption band the native window buttons float over.
 *
 * Without this marker the shared client paints under them, so the page's first
 * rows sit behind the minimize/maximize/close overlay. The height matches the
 * window's `titleBarOverlay`, which the shell also recolors on palette changes.
 */
function markWindowsTitlebar(): void {
  if (process.platform !== 'win32') return
  const mark = (): void => {
    const root = document.documentElement
    root.dataset.windowsTitlebar = ''
    root.style.setProperty('--dsh-windows-titlebar-height', `${WINDOWS_TITLEBAR_HEIGHT}px`)
  }
  const root = document.documentElement as HTMLElement | null
  if (root === null) window.addEventListener('DOMContentLoaded', mark)
  else mark()
}

markPlatform()
markWindowsTitlebar()

/**
 * Report the palette the page is painting to the shell.
 *
 * The served UI leaves the document transparent on macOS and draws its sidebar
 * as a translucent tint, so the window's own background shows through: it has
 * to follow the palette the page resolved, including when only the OS
 * appearance changed, which no window option and no user gesture reaches. The
 * page publishes both facts on its root element — `data-ds-theme-source` is the
 * preference it follows, and the inline `color-scheme` is the palette it
 * painted with `system` resolved.
 */
function reportTheme(): void {
  let sent = ''
  const send = (): void => {
    const root = document.documentElement as HTMLElement | null
    if (root === null) return
    const scheme = root.style.colorScheme
    const source = root.dataset.dsThemeSource
    if ((scheme !== 'light' && scheme !== 'dark')
      || (source !== 'light' && source !== 'dark' && source !== 'system')) return
    const report = `${source}:${scheme}`
    if (report === sent) return
    sent = report
    ipcRenderer.send(THEME_CHANNEL, { source, scheme })
  }
  // The theme bootstrap writes the attribute before this observer exists, so
  // the first read happens when observation starts; later writes update it.
  const observe = (): void => {
    const root = document.documentElement as HTMLElement | null
    if (root === null) return
    new MutationObserver(send).observe(root, { attributes: true, attributeFilter: ['data-ds-theme-source', 'style'] })
    send()
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', observe, { once: true })
  else observe()
}

reportTheme()

contextBridge.exposeInMainWorld('dshDesktop', {
  keyboard: {
    subscribe: (listener: (input: unknown) => void): (() => void) => {
      const handle = (_event: IpcRendererEvent, input: unknown): void => { listener(input) }
      ipcRenderer.on(SHORTCUT_CHANNELS.input, handle)
      return () => { ipcRenderer.off(SHORTCUT_CHANNELS.input, handle) }
    },
    closeWindow: (revision: string): Promise<void> =>
      ipcRenderer.invoke(SHORTCUT_CHANNELS.closeWindow, revision) as Promise<void>,
  },
  shortcuts: {
    get: (definitions: readonly unknown[]): Promise<unknown> =>
      ipcRenderer.invoke(SHORTCUT_CHANNELS.get, definitions) as Promise<unknown>,
    edit: (edit: unknown, revision: string): Promise<unknown> =>
      ipcRenderer.invoke(SHORTCUT_CHANNELS.edit, edit, revision) as Promise<unknown>,
    recording: async (): Promise<void> => {},
    subscribe: (listener: (snapshot: unknown) => void): (() => void) => {
      const handle = (_event: IpcRendererEvent, snapshot: unknown): void => { listener(snapshot) }
      ipcRenderer.on(SHORTCUT_CHANNELS.changed, handle)
      return () => { ipcRenderer.off(SHORTCUT_CHANNELS.changed, handle) }
    },
  },
})
