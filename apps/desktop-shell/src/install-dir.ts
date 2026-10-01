/**
 * The installation directory, named to the server child for the permission
 * gateway plugin (`@haoran/dsh-llm-permission-gateway`), which reads it from
 * 0.6.0 on; the vendored 0.5.0 does not.
 *
 * The directory is the one an installer creates and an update replaces: on
 * macOS the `.app` bundle, two levels above `Contents/Resources`; on Windows
 * and Linux the directory holding `resources/`. A development launch has no
 * installation and names nothing.
 * @module @deepseek-ai/dsh-desktop-shell/install-dir
 */

import { posix, win32 } from 'node:path'
import type { LauncherLocation } from './pnpm-launcher.ts'

/** Environment variable naming the installation directory, set on the server child alone. The gateway reads it from 0.6.0 on. */
export const INSTALL_DIR_ENV = 'DSH_DESKTOP_INSTALL_DIR'

/**
 * The environment addition that names this launch's installation directory.
 * @param location - whether this launch is packaged, and where its resources are.
 * @returns `{ DSH_DESKTOP_INSTALL_DIR: <absolute directory> }`, or an empty
 * object for a development launch or an empty `resourcesPath`.
 */
export function installDirEnv(location: LauncherLocation): Record<string, string> {
  if (!location.packaged || location.resourcesPath === '') return {}
  if (location.platform === 'darwin') {
    return { [INSTALL_DIR_ENV]: posix.dirname(posix.dirname(location.resourcesPath)) }
  }
  const path = location.platform === 'win32' ? win32 : posix
  return { [INSTALL_DIR_ENV]: path.dirname(location.resourcesPath) }
}
