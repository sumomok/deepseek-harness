/**
 * The shell's own per-user directories, named to the server child so the
 * desktop composition layer can list them in the model's system prompt
 * (`@deepseek-ai/dsh-desktop-app`'s `desktop-brand` row reads each variable)
 * and the vendored permission gateway 0.5.3 can list them in its review prompt.
 *
 * Electron's `userData` holds the shell's preferences, cookies, login
 * partitions, and `desktop-state.json`; `logs` holds the shell's and the
 * server's log files and crash reports, and sits outside `userData` on macOS
 * (`~/Library/Logs/<name>`); the update cache holds downloaded and staged
 * updates under `~/Library/Caches`, `%LOCALAPPDATA%`, or `~/.cache`, outside
 * `userData` on every platform.
 * @module @deepseek-ai/dsh-desktop-shell/app-dirs
 */

/** Environment variable naming Electron's `userData` directory, set on the server child alone. */
export const USER_DATA_DIR_ENV = 'DSH_DESKTOP_USER_DATA_DIR'

/** Environment variable naming the shell's log directory, set on the server child alone. */
export const LOG_DIR_ENV = 'DSH_DESKTOP_LOG_DIR'

/** Environment variable naming electron-updater's cache directory, set on the server child alone. */
export const UPDATE_CACHE_DIR_ENV = 'DSH_DESKTOP_UPDATE_CACHE_DIR'

/** The directories one launch resolved. */
export interface AppDirectories {
  /** Electron's `userData` directory. */
  userData: string
  /** The directory the shell writes `dsh-server.log` into. */
  logs: string
  /** electron-updater's cache directory for this application. */
  updateCache: string
}

/**
 * The environment addition that names this launch's own directories.
 * @param directories - the directories this launch resolved.
 * @returns one variable per non-empty directory.
 */
export function appDirsEnv(directories: AppDirectories): Record<string, string> {
  const entries: [string, string][] = [
    [USER_DATA_DIR_ENV, directories.userData],
    [LOG_DIR_ENV, directories.logs],
    [UPDATE_CACHE_DIR_ENV, directories.updateCache],
  ]
  return Object.fromEntries(entries.filter(([, path]) => path !== ''))
}
