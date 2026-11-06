/**
 * Who may open the microphone: the served UI in the app window's main frame,
 * for audio alone, and on macOS only once the system has granted it.
 *
 * The app window runs on the default session, which carries no permission
 * handler of its own, and Electron's answer without one is yes to every
 * permission from every frame. The served UI's voice input records through
 * `getUserMedia`; without this, any frame the conversation or content column
 * embeds could record as well. Every permission other than `media` keeps
 * Electron's default answer. The render and login windows sit on partitions
 * of their own that refuse everything, so nothing here reaches them.
 *
 * Mirrors upstream's `apps/desktop/src/microphone-permissions.ts`, with the
 * served UI's loopback origin in place of upstream's `dsh-app:` scheme.
 * Depends on no Electron runtime value, so it is importable outside the main
 * process.
 * @module @deepseek-ai/dsh-desktop-shell/microphone-permissions
 */

import type { Session, WebContents } from 'electron'

/** What the permission handlers read beyond Electron's own arguments. */
export interface MicrophoneHost {
  /** The app window's contents, absent while no window is open. */
  primary: () => WebContents | undefined
  /** The running server's origin, absent while no server is up. */
  serverOrigin: () => string | undefined
  /** `process.platform`; macOS is the one platform whose system grant is asked for here. */
  platform: NodeJS.Platform
  /** `systemPreferences.getMediaAccessStatus('microphone')`, read on macOS only. */
  microphoneStatus: () => string
  /** `systemPreferences.askForMediaAccess('microphone')`, called on macOS only. */
  askForMicrophone: () => Promise<boolean>
}

/**
 * Whether a URL belongs to the running server.
 * @param url - the requesting frame's URL or origin.
 * @param serverOrigin - the server's origin, or undefined when none is up.
 * @returns true when both parse and their origins match.
 */
export function servedByServer(url: string, serverOrigin: string | undefined): boolean {
  if (serverOrigin === undefined) return false
  try {
    return new URL(url).origin === new URL(serverOrigin).origin
  } catch (_invalidUrl) {
    // `new URL` throws for a string that is not a URL; such a frame is not the served UI.
    return false
  }
}

/**
 * Install the microphone policy on the app window's session.
 * @param session - the session the app window loads the served UI in.
 * @param host - the window, server origin, and system grant this policy reads.
 */
export function installMicrophonePermissions(
  session: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>,
  host: MicrophoneHost,
): void {
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (permission !== 'media') return true
    return contents !== null && contents === host.primary() && details.isMainFrame
      && servedByServer(origin, host.serverOrigin()) && details.mediaType === 'audio'
      && (host.platform !== 'darwin' || host.microphoneStatus() === 'granted')
  })
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') { callback(true); return }
    const allowed = contents === host.primary() && details.isMainFrame
      && servedByServer(details.requestingUrl, host.serverOrigin())
      && 'mediaTypes' in details && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'
    if (!allowed) { callback(false); return }
    if (host.platform !== 'darwin') { callback(true); return }
    host.askForMicrophone().then(callback, () => { callback(false) })
  })
}
