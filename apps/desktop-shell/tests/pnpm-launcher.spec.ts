/**
 * The pnpm launcher scripts: which one a launch names to the server, and what
 * the script does when upstream's plugin manager spawns it — the shipped
 * `pnpm.mjs` under the Node beside it, every argument passed through as it
 * was given, that directory first on `PATH`, and pnpm's exit status returned.
 *
 * The run cases build a `runtime/` directory the way the payload lays it out,
 * under a path with a space in it as `DSH Desktop.app` has, with a stand-in
 * `pnpm.mjs` that reports what it received. The POSIX script runs on macOS and
 * Linux, the `.cmd` on Windows.
 * @module
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PNPM_LAUNCHER_ENV, PNPM_LAUNCHERS, pnpmInvocation, pnpmLauncherEnv } from '../src/pnpm-launcher.ts'

describe('pnpmInvocation', () => {
  it('runs pnpm from PATH in a development launch', () => {
    expect(pnpmInvocation({ packaged: false, resourcesPath: '/res', platform: 'darwin', nodeBin: 'node' }))
      .toEqual({ command: 'pnpm', prefixArgs: [] })
  })

  it('runs the shipped pnpm.mjs under the bundled Node, with runtime/ first on PATH, never through a script', () => {
    const resources = join('C:', 'DSH', 'resources')
    const nodeBin = join(resources, 'runtime', 'node.exe')
    expect(pnpmInvocation({ packaged: true, resourcesPath: resources, platform: 'win32', nodeBin })).toEqual({
      command: nodeBin,
      prefixArgs: [join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')],
      pathPrefix: join(resources, 'runtime'),
    })
  })
})

describe('pnpmLauncherEnv', () => {
  it('names nothing in a development launch, so pnpm on PATH is used', () => {
    expect(pnpmLauncherEnv({ packaged: false, resourcesPath: '/res', platform: 'darwin' })).toEqual({})
  })

  it('names the POSIX script beside the bundled Node on macOS', () => {
    expect(pnpmLauncherEnv({ packaged: true, resourcesPath: join('/Applications', 'DSH Desktop.app', 'Contents', 'Resources'), platform: 'darwin' }))
      .toEqual({ [PNPM_LAUNCHER_ENV]: join('/Applications', 'DSH Desktop.app', 'Contents', 'Resources', 'runtime', 'dsh-pnpm') })
  })

  it('names the .cmd script on Windows', () => {
    expect(pnpmLauncherEnv({ packaged: true, resourcesPath: join('C:', 'DSH', 'resources'), platform: 'win32' }))
      .toEqual({ [PNPM_LAUNCHER_ENV]: join('C:', 'DSH', 'resources', 'runtime', 'dsh-pnpm.cmd') })
  })

  it('is the variable the desktop composition layer reads', () => {
    expect(PNPM_LAUNCHER_ENV).toBe('DSH_DESKTOP_PNPM')
  })
})

describe('PNPM_LAUNCHERS', () => {
  it('names neither script pnpm, which is the pnpm package directory inside runtime/', () => {
    expect(Object.values(PNPM_LAUNCHERS).map(launcher => launcher.file)).not.toContain('pnpm')
  })

  it('marks only the POSIX script executable', () => {
    expect(PNPM_LAUNCHERS.darwin.executable).toBe(true)
    expect(PNPM_LAUNCHERS.win.executable).toBe(false)
  })

  it('writes the Windows script with CRLF line ends and returns pnpm\'s exit status', () => {
    const lines = PNPM_LAUNCHERS.win.content.split('\r\n')
    expect(PNPM_LAUNCHERS.win.content.replaceAll('\r\n', '')).not.toContain('\n')
    expect(lines).toContain('"%~dp0node.exe" "%~dp0pnpm\\bin\\pnpm.mjs" %*')
    expect(lines).toContain('set "PATH=%~dp0;%PATH%"')
    expect(lines.at(-2)).toBe('exit /b %ERRORLEVEL%')
  })
})

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** What the stand-in pnpm.mjs reports. */
interface Received {
  argv: string[]
  path: string
}

/**
 * Lay out `runtime/` as the payload does: the platform's Node, `pnpm/bin/pnpm.mjs`,
 * and the launcher, under a directory whose name has a space in it.
 * @param platform - which launcher to write.
 * @returns the runtime directory and the launcher's path.
 */
function stageRuntime(platform: 'darwin' | 'win'): { runtime: string; script: string } {
  root = mkdtempSync(join(tmpdir(), 'dsh-pnpm-launcher-'))
  const runtime = join(root, 'DSH Desktop', 'runtime')
  mkdirSync(join(runtime, 'pnpm', 'bin'), { recursive: true })
  writeFileSync(
    join(runtime, 'pnpm', 'bin', 'pnpm.mjs'),
    'console.log(JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH }))\nprocess.exit(3)\n',
  )
  if (platform === 'win') copyFileSync(process.execPath, join(runtime, 'node.exe'))
  else symlinkSync(process.execPath, join(runtime, 'node'))
  const launcher = PNPM_LAUNCHERS[platform]
  const script = join(runtime, launcher.file)
  writeFileSync(script, launcher.content)
  if (launcher.executable) chmodSync(script, 0o755)
  return { runtime, script }
}

describe.runIf(process.platform !== 'win32')('the POSIX launcher', () => {
  it('runs pnpm.mjs under the Node beside it with every argument intact and itself first on PATH', () => {
    const { runtime, script } = stageRuntime('darwin')
    const run = spawnSync(script, ['add', 'two words', '--flag=a b'], {
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    })
    expect(run.status).toBe(3)
    const received = JSON.parse(run.stdout) as Received
    expect(received.argv).toEqual(['add', 'two words', '--flag=a b'])
    expect(received.path).toBe(`${runtime}:/usr/bin:/bin`)
  })

  it('needs no node on the PATH it was started with', () => {
    const { script } = stageRuntime('darwin')
    expect(() => execFileSync('/bin/sh', ['-c', 'command -v node'], { env: { PATH: '/nonexistent' } })).toThrow()
    const run = spawnSync(script, ['--version'], { env: { PATH: '/nonexistent' }, encoding: 'utf8' })
    expect((JSON.parse(run.stdout) as Received).argv).toEqual(['--version'])
  })
})

describe.runIf(process.platform === 'win32')('the Windows launcher', () => {
  it('runs pnpm.mjs under the node.exe beside it with its directory first on PATH', () => {
    const { runtime, script } = stageRuntime('win')
    const run = spawnSync(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${script}" add pkg`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    })
    expect(run.status).toBe(3)
    const received = JSON.parse(run.stdout) as Received
    expect(received.argv).toEqual(['add', 'pkg'])
    expect(received.path.split(delimiter)[0]).toBe(`${runtime}\\`)
  })
})
