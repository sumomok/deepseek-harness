/** Quit ownership shared by the main veto and the tray, timers and notifications. */
export interface QuitEvents {
  on: (name: 'before-quit', listener: () => void) => unknown
}

let installDecisionPending = false

/**
 * Hold quit effects while Windows has not reported the elevation decision.
 * @param pending - whether an install attempt still owns the OS decision.
 */
export function setInstallDecisionPending(pending: boolean): void {
  installDecisionPending = pending
}

/**
 * Veto quit before any teardown while an install decision is pending.
 * @param event - Electron's cancellable before-quit event.
 * @returns whether this quit was deferred; no delayed quit is queued.
 */
export function deferQuitForInstall(event: { preventDefault: () => void }): boolean {
  if (!installDecisionPending) return false
  event.preventDefault()
  return true
}

/**
 * Run cleanup once for an accepted quit, preserving observers across the install veto.
 * `defaultPrevented` is deliberately not the decision: the main process also
 * prevents an accepted quit while stopping the server, then calls app.exit
 * without another before-quit event.
 * @param app - the application's quit event source.
 * @param effect - synchronous cleanup owned by this observer.
 */
export function onPermittedQuit(app: QuitEvents, effect: () => void): void {
  let completed = false
  app.on('before-quit', () => {
    if (installDecisionPending || completed) return
    completed = true
    effect()
  })
}
