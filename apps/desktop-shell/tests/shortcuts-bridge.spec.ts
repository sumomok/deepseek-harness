import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installKeyboard } from '../src/keyboard.ts'
import { desktopKeybindings } from '../src/keybindings.ts'
import { SHORTCUT_CHANNELS } from '../src/shortcut-channels.ts'

/** Minimal BrowserWindow stand-in: one listener slot and a sent-press log. */
function fakeWindow() {
  const listeners: ((event: unknown, input: unknown) => void)[] = []
  const sent: unknown[] = []
  return {
    sent,
    webContents: {
      on: (_channel: string, listener: (event: unknown, input: unknown) => void) => { listeners.push(listener) },
      off: (_channel: string, listener: (event: unknown, input: unknown) => void) => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      },
      send: (channel: string, payload: unknown) => { sent.push({ channel, payload }) },
    },
    listeners,
    press: (input: Record<string, unknown>) => { for (const listener of listeners) listener({ preventDefault() {} }, input) },
  }
}

describe('desktop shortcut bridge', () => {
  let home = ''
  afterEach(() => { if (home !== '') rmSync(home, { recursive: true, force: true }); home = '' })

  it('forwards a chord with the accepted configuration identity', () => {
    const window = fakeWindow()
    installKeyboard(window as never, () => 'rev-1' as never)
    window.press({ type: 'keyDown', code: 'KeyK', control: false, alt: false, shift: false, meta: true, isAutoRepeat: false, isComposing: false })
    expect(window.sent).toEqual([{
      channel: SHORTCUT_CHANNELS.input,
      payload: { kind: 'keyboard', revision: 'rev-1', frameName: '', code: 'KeyK', repeat: false,
        control: false, alt: false, shift: false, meta: true },
    }])
  })

  it('leaves plain typing and key releases to the page', () => {
    const window = fakeWindow()
    installKeyboard(window as never, () => 'rev-1' as never)
    window.press({ type: 'keyDown', code: 'KeyA', control: false, alt: false, shift: false, meta: false, isAutoRepeat: false, isComposing: false })
    window.press({ type: 'keyUp', code: 'KeyK', control: false, alt: false, shift: false, meta: true, isAutoRepeat: false, isComposing: false })
    expect(window.sent).toEqual([])
  })

  it('drops a press that arrives before any configuration was read', () => {
    const window = fakeWindow()
    installKeyboard(window as never, () => undefined)
    window.press({ type: 'keyDown', code: 'KeyK', control: false, alt: false, shift: false, meta: true, isAutoRepeat: false, isComposing: false })
    expect(window.sent).toEqual([])
  })

  it('reads and edits the device configuration through one store', async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-keybindings-'))
    const published: unknown[] = []
    const store = desktopKeybindings(home, 'macos', (snapshot) => { published.push(snapshot) })
    const snapshot = await store.readCurrent() as { revision: string; status: string }
    expect(snapshot.status).not.toBe('loading')
    expect(typeof snapshot.revision).toBe('string')
    expect(published.length).toBeGreaterThan(0)
  })
})
