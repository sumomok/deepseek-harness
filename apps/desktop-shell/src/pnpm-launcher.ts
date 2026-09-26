/**
 * The launcher scripts that let upstream's plugin manager run the package
 * manager this installer ships.
 *
 * `@deepseek-ai/dsh-plugin-manager` spawns its `pnpmCommand` config field as
 * one executable with no arguments of its own before the pnpm subcommand. The
 * shipped pnpm is `resources/runtime/pnpm/bin/pnpm.mjs`, whose `#!/usr/bin/env
 * node` resolves nothing on the machines this product targets: they have no
 * Node on `PATH`. So the payload carries one script per platform beside the
 * bundled Node, in `resources/runtime/`, that runs `pnpm.mjs` under that Node
 * and puts `runtime/` first on `PATH` for everything pnpm starts, lifecycle
 * scripts included. The shell names the script to the server child alone in
 * {@link PNPM_LAUNCHER_ENV}, and `apps/desktop-app/cordis.patch.yml` reads that
 * variable into the `plugin-manager` row's `pnpmCommand`.
 *
 * The names avoid `pnpm` itself: `runtime/pnpm` is the extracted pnpm package
 * directory. `scripts/package.ts` stages both scripts and asserts them, and
 * `scripts/after-pack.cjs` copies the target platform's script into
 * `runtime/`; that hook is CommonJS and restates {@link PNPM_LAUNCHERS}' file
 * names.
 * @module @deepseek-ai/dsh-desktop-shell/pnpm-launcher
 */

import { join } from 'node:path'

/** Environment variable naming the launcher script, set on the server child alone. */
export const PNPM_LAUNCHER_ENV = 'DSH_DESKTOP_PNPM'

/** The payload platforms that carry a launcher script. */
export type LauncherPlatform = 'darwin' | 'win'

/** One platform's launcher: its file name under `resources/runtime/`, and its text. */
export interface PnpmLauncherScript {
  /** File name inside `resources/runtime/`. */
  file: string
  /** The script, byte for byte. */
  content: string
  /** Whether the file needs the executable bit, which a POSIX shell script does and a `.cmd` does not. */
  executable: boolean
}

/**
 * The macOS launcher. `$0` is the script's own path as the spawner named it,
 * so the directory is resolved from it with shell builtins alone, which need
 * nothing on `PATH`; every expansion is quoted because the application path
 * carries a space (`DSH Desktop.app`).
 */
const POSIX_LAUNCHER = `#!/bin/sh
case $0 in */*) d=\${0%/*} ;; *) d=. ;; esac
d=$(cd "$d" && pwd) || exit 1
PATH="$d:$PATH"
export PATH
exec "$d/node" "$d/pnpm/bin/pnpm.mjs" "$@"
`

/**
 * The Windows launcher. `%~dp0` is the script's own directory with a trailing
 * separator. `setlocal` keeps the `PATH` change inside this script, and the
 * last line hands pnpm's exit status back to whoever spawned the script, which
 * a batch file otherwise does not guarantee.
 */
const WINDOWS_LAUNCHER = [
  '@echo off',
  'setlocal',
  'set "PATH=%~dp0;%PATH%"',
  '"%~dp0node.exe" "%~dp0pnpm\\bin\\pnpm.mjs" %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n')

/** Both launchers, by payload platform. */
export const PNPM_LAUNCHERS: Readonly<Record<LauncherPlatform, PnpmLauncherScript>> = {
  darwin: { file: 'dsh-pnpm', content: POSIX_LAUNCHER, executable: true },
  win: { file: 'dsh-pnpm.cmd', content: WINDOWS_LAUNCHER, executable: false },
}

/** Where this launch runs from. */
export interface LauncherLocation {
  /** Whether this is a packaged application, which is what ships a launcher. */
  packaged: boolean
  /** `process.resourcesPath` of a packaged application. */
  resourcesPath: string
  /** `process.platform`. */
  platform: NodeJS.Platform
}

/**
 * The environment additions that name this launch's pnpm launcher to the
 * server child.
 *
 * A development launch has no `resources/runtime` and adds nothing, so the
 * `plugin-manager` row falls back to `pnpm` on the developer's own `PATH`.
 * @param location - whether this launch is packaged, and where its resources are.
 * @returns `{ DSH_DESKTOP_PNPM: <absolute script path> }`, or an empty object for a development launch.
 */
export function pnpmLauncherEnv(location: LauncherLocation): Record<string, string> {
  if (!location.packaged) return {}
  const script = PNPM_LAUNCHERS[location.platform === 'win32' ? 'win' : 'darwin']
  return { [PNPM_LAUNCHER_ENV]: join(location.resourcesPath, 'runtime', script.file) }
}
