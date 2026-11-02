/** Forwards product-window key presses to the page that owns the binding table. */
import type { BrowserWindow, Input } from 'electron'
import type { DesktopShortcutInput, ShortcutRevision } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { SHORTCUT_CHANNELS } from './shortcut-channels.ts'

/**
 * Install native input forwarding for one window.
 *
 * Only chords reach the page: a bare letter or an unmodified navigation key is
 * the page's own input, and the menu keeps what it owns. The accepted
 * configuration identity travels with each press because the page drops a
 * press that outlived the configuration it was recorded against.
 * @param window - the product window.
 * @param revision - current accepted configuration identity, if one is known.
 * @returns disposer removing the listener.
 */
export function installKeyboard(window: BrowserWindow, revision: () => ShortcutRevision | undefined): () => void {
  const forward = (_event: Electron.Event, input: Input): void => {
    if (input.type !== 'keyDown') return
    if (!input.control && !input.alt && !input.meta) return
    const current = revision()
    if (current === undefined) return
    const press: DesktopShortcutInput = {
      kind: 'keyboard', revision: current, frameName: '',
      code: input.code, repeat: input.isAutoRepeat,
      control: input.control, alt: input.alt, shift: input.shift, meta: input.meta,
    }
    window.webContents.send(SHORTCUT_CHANNELS.input, press)
  }
  window.webContents.on('before-input-event', forward)
  return () => { window.webContents.off('before-input-event', forward) }
}
