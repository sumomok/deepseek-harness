/**
 * The name and per-user directories the installed application answers to,
 * pinned to values this package's own name no longer produces.
 *
 * Electron derives the application name from the name field of the
 * application's `package.json`, and derives `userData` — plus `sessionData`,
 * `crashDumps` under it, and on macOS the `logs` directory — from that name.
 * This package is named `@deepseek-ai/dsh-desktop-shell` so that upstream's
 * `@deepseek-ai/dsh-desktop` can occupy `apps/desktop`, but the installed
 * application still has to find the cookies, login partitions, preferences and
 * `desktop-state.json` that every shipped version wrote under the name
 * `@deepseek-ai/dsh-desktop`.
 *
 * Setting the name is not enough on its own: Electron resolves `userData` and
 * `sessionData` once during startup, before any of this package's code runs,
 * so both are set explicitly here as well. `logs` is resolved on first use and
 * follows the name on macOS; on Windows and Linux it sits under `userData`.
 *
 * A packaged build never depends on this module for that: `extraMetadata.name`
 * in `electron-builder.yml` writes the pinned name into the `package.json`
 * inside the asar, which is also what `updaterCacheDirName` in `app-update.yml`
 * is generated from. This module is what makes a source-tree launch use the
 * same directories, and it is a no-op wherever the packaged name already
 * resolves to them.
 *
 * The rename and what it must not move:
 * `.agents/notes/implemented/architecture/2026-09-10-fork-shell-vacates-apps-desktop.md`.
 * @module @deepseek-ai/dsh-desktop-shell/app-identity
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The name every shipped build has been installed under, and therefore the
 * name its per-user directories are named after. Changing it strands the data
 * of every existing installation.
 */
export const PINNED_APP_NAME = '@deepseek-ai/dsh-desktop'

/**
 * Names a suffix that moves this installation's per-user directories beside
 * the shipped ones, so a test build runs its own copy of the application
 * without taking the single-instance lock an installed build holds. Unset
 * leaves every shipped build on the pinned directories.
 */
export const IDENTITY_SUFFIX_ENV = 'DSH_DESKTOP_IDENTITY_SUFFIX'

/**
 * Read the isolation suffix for this launch.
 * @returns the sanitized suffix, or an empty string when the launch is not isolated.
 */
function identitySuffix(): string {
  const raw = process.env[IDENTITY_SUFFIX_ENV] ?? ''
  const trimmed = raw.replace(/[^A-Za-z0-9._-]/gu, '')
  return trimmed === '' ? '' : `-${trimmed}`
}

/** The `app` members the pin needs, so the pin can be exercised without Electron. */
export interface AppIdentityHost {
  /** Overrides the name Electron reports and derives paths from. */
  setName: (name: string) => void
  /** Reads a directory Electron resolved at startup. */
  getPath: (name: 'appData') => string
  /** Overrides a directory Electron resolved at startup; the directory must exist. */
  setPath: (name: 'userData' | 'sessionData', path: string) => void
}

/**
 * Where the per-user directory of the pinned name sits under the platform's
 * roaming application-data directory. The name's `/` is a directory separator
 * here, which is how Electron itself lays a scoped name out.
 * @param appData - the platform's roaming application-data directory.
 * @param suffix - isolation suffix appended to the name; empty for a shipped build.
 * @returns the absolute user-data directory.
 */
export function pinnedUserDataPath(appData: string, suffix = identitySuffix()): string {
  const segments = PINNED_APP_NAME.split('/')
  const last = segments.pop() ?? PINNED_APP_NAME
  return join(appData, ...segments, `${last}${suffix}`)
}

/**
 * Pin the application name and the two directories Electron resolves from it
 * before the first launch step reads either. Creates the user-data directory
 * when it does not exist yet, because `setPath` refuses a path that is not
 * there — a fresh installation reaches this before Electron would have created
 * it.
 * @param app - the Electron `app` module, or a stand-in with the same members.
 * @param suffix - isolation suffix for a test installation; defaults to the launch's environment.
 */
export function pinAppIdentity(app: AppIdentityHost, suffix = identitySuffix()): void {
  app.setName(`${PINNED_APP_NAME}${suffix}`)
  const userData = pinnedUserDataPath(app.getPath('appData'), suffix)
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
}
