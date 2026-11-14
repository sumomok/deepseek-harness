import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { deferQuitForInstall, onPermittedQuit, setInstallDecisionPending } from '../src/quit-effects.ts'

it('preserves observers across install vetoes and cleans up on accepted asynchronous exit', () => {
  const app = new EventEmitter()
  const effects: string[] = []
  // Main runs first. Accepted quits also preventDefault while stopping the
  // server, then use app.exit, which emits no second before-quit event.
  app.on('before-quit', (event: { preventDefault: () => void }) => {
    if (deferQuitForInstall(event)) return
    event.preventDefault()
  })
  for (const owner of ['tray', 'update timers', 'notification stream']) {
    onPermittedQuit(app, () => { effects.push(owner) })
  }
  const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true } })
  try {
    setInstallDecisionPending(true)
    app.emit('before-quit', event())
    app.emit('before-quit', event())
    expect(effects).toEqual([])
    setInstallDecisionPending(false)
    const accepted = event()
    app.emit('before-quit', accepted)
    expect(accepted.defaultPrevented).toBe(true)
    expect(effects).toEqual(['tray', 'update timers', 'notification stream'])
    app.emit('before-quit', event())
    expect(effects).toHaveLength(3)
  } finally {
    setInstallDecisionPending(false)
  }
})
