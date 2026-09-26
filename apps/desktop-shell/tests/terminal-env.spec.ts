/**
 * Reading and writing the `DSH_HOME` a terminal sees: the login-shell probe
 * against real shells in a temporary home, the owned profile block, and the
 * Windows user environment through a recorded PowerShell runner.
 * @module
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BLOCK_END, BLOCK_START, POINTER_HOME_ENV, PROFILE_BACKUP_SUFFIX, processDshHome, profileFile,
  READ_USER_ENV_SCRIPT, readExplicitDshHome, readLoginShellDshHome, readWindowsUserDshHome, shellQuote,
  updateShellProfile, WRITE_USER_ENV_SCRIPT, WRITE_VALUE_ENV, writeTerminalDshHome, writeWindowsUserDshHome,
  type PowerShellRunner, type TerminalEnvHost,
} from '../src/terminal-env.ts'

let home: string

beforeEach(async () => {
  home = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-terminal-env-')))
  // Every profile and shell below reads and writes this home; it must never be the user's own.
  expect(home.startsWith(realpathSync(tmpdir()))).toBe(true)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const TRICKY = "/Volumes/外置 盘/it's DSH-Data"
const posixOnly = process.platform === 'win32' ? it.skip : it
const withZsh = existsSync('/bin/zsh') ? it : it.skip
const withBash = existsSync('/bin/bash') ? it : it.skip

/**
 * Whether a process exists.
 * @param pid - the process id.
 * @returns false once signal 0 reports no such process.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: the process is gone, which is the state being waited for.
    return false
  }
}

/** Environment for a shell confined to the temporary home. */
function shellEnv(): NodeJS.ProcessEnv {
  return { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
}

describe('processDshHome', () => {
  it('ignores blank values and the value the shell exported from the pointer', () => {
    expect(processDshHome({})).toBeUndefined()
    expect(processDshHome({ DSH_HOME: ' ' })).toBeUndefined()
    expect(processDshHome({ DSH_HOME: '/p', [POINTER_HOME_ENV]: '/p' })).toBeUndefined()
    expect(processDshHome({ DSH_HOME: '/q', [POINTER_HOME_ENV]: '/p' })).toBe('/q')
  })
})

describe('readLoginShellDshHome', () => {
  withZsh('reads the value a zsh profile exports, discarding everything else the profile prints', async () => {
    writeFileSync(join(home, '.zshrc'), `echo "welcome, $USER"\nprintf 'noise:set:/fake:noise'\nexport DSH_HOME=${shellQuote(TRICKY)}\n`)
    const read = await readLoginShellDshHome({ shell: '/bin/zsh', env: { ...shellEnv(), DSH_HOME: '/from-process' }, timeoutMs: 10_000 })
    expect(read).toEqual({ kind: 'set', value: TRICKY, source: 'login-shell' })
  })

  withBash('reads a bash profile', async () => {
    writeFileSync(join(home, '.bash_profile'), 'export DSH_HOME=/data/bash\n')
    expect(await readLoginShellDshHome({ shell: '/bin/bash', env: shellEnv(), timeoutMs: 10_000 }))
      .toEqual({ kind: 'set', value: '/data/bash', source: 'login-shell' })
  })

  withZsh('reports unset when the profile sets nothing or an empty value', async () => {
    expect(await readLoginShellDshHome({ shell: '/bin/zsh', env: shellEnv(), timeoutMs: 10_000 })).toEqual({ kind: 'unset' })
    writeFileSync(join(home, '.zshrc'), 'export DSH_HOME=\n')
    expect(await readLoginShellDshHome({ shell: '/bin/zsh', env: shellEnv(), timeoutMs: 10_000 })).toEqual({ kind: 'unset' })
  })

  posixOnly('gives up after the time limit and kills the shell', async () => {
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const pidFile = join(home, 'pid')
    const shell = join(bin, 'zsh')
    writeFileSync(shell, `#!/bin/sh\necho $$ > '${pidFile}.tmp'\nmv '${pidFile}.tmp' '${pidFile}'\nexec sleep 30\n`)
    chmodSync(shell, 0o755)
    // The probe's limit runs on a faked clock, advanced only once the shell has
    // written its pid, so a slow start under load cannot outlast the limit.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = readLoginShellDshHome({ shell, env: shellEnv(), timeoutMs: 1500 })
      while (!existsSync(pidFile)) await sleep(10)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      vi.advanceTimersByTime(1500)
      const read = await pending
      expect(read.kind).toBe('unknown')
      expect(read.kind === 'unknown' && read.detail).toContain('did not answer within 1500ms')
      // A killed child stays a zombie until Node reaps it; wait for that state.
      while (isAlive(pid)) await sleep(10)
    } finally {
      vi.useRealTimers()
    }
  })

  posixOnly('reports unknown for a shell that exits without reporting', async () => {
    const shell = join(home, 'bash')
    writeFileSync(shell, '#!/bin/sh\nexit 3\n')
    chmodSync(shell, 0o755)
    const read = await readLoginShellDshHome({ shell, env: shellEnv(), timeoutMs: 10_000 })
    expect(read.kind === 'unknown' && read.detail).toContain('exited with 3')
  })

  it('does not start a shell it cannot speak to', async () => {
    expect(await readLoginShellDshHome({ shell: '/usr/local/bin/fish', env: shellEnv(), timeoutMs: 100 }))
      .toEqual({ kind: 'unknown', detail: 'unsupported shell /usr/local/bin/fish' })
    expect((await readLoginShellDshHome({ shell: undefined, env: shellEnv(), timeoutMs: 100 })).kind).toBe('unknown')
    const missing = await readLoginShellDshHome({ shell: join(home, 'nowhere', 'zsh'), env: shellEnv(), timeoutMs: 1000 })
    expect(missing.kind === 'unknown' && missing.detail).toContain('ENOENT')
  })
})

describe('updateShellProfile', () => {
  const zsh = (): { home: string; shell: string; zdotdir: undefined } => ({ home, shell: '/bin/zsh', zdotdir: undefined })

  it('picks the profile by shell, honoring ZDOTDIR', () => {
    expect(profileFile({ home: '/h', shell: '/bin/zsh', zdotdir: undefined })).toBe('/h/.zshrc')
    expect(profileFile({ home: '/h', shell: '/bin/zsh', zdotdir: '/z' })).toBe('/z/.zshrc')
    expect(profileFile({ home: '/h', shell: '/opt/bin/bash', zdotdir: '/z' })).toBe('/h/.bash_profile')
    expect(profileFile({ home: '/h', shell: '/usr/local/bin/fish', zdotdir: undefined })).toBeUndefined()
    expect(profileFile({ home: '/h', shell: undefined, zdotdir: undefined })).toBeUndefined()
  })

  it('does not write for fish', () => {
    expect(updateShellProfile({ home, shell: '/opt/homebrew/bin/fish', zdotdir: undefined }, '/d'))
      .toEqual({ kind: 'unsupported-shell', shell: '/opt/homebrew/bin/fish' })
    expect(readdirSync(home)).toEqual([])
  })

  it('creates the profile with only the block when there is none', () => {
    expect(updateShellProfile(zsh(), '/data/one')).toEqual({ kind: 'written', file: join(home, '.zshrc') })
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe(`${BLOCK_START}\nexport DSH_HOME='/data/one'\n${BLOCK_END}\n`)
    expect(existsSync(join(home, `.zshrc${PROFILE_BACKUP_SUFFIX}`))).toBe(false)
  })

  it('appends the block, backs up the original, and keeps its permission bits', () => {
    const file = join(home, '.zshrc')
    const original = 'alias ll="ls -l"\nexport PATH=$HOME/bin:$PATH\n'
    writeFileSync(file, original)
    chmodSync(file, 0o600)
    const update = updateShellProfile(zsh(), '/data/one')
    expect(update).toEqual({ kind: 'written', file, backup: `${file}${PROFILE_BACKUP_SUFFIX}` })
    expect(readFileSync(file, 'utf8')).toBe(`${original}\n${BLOCK_START}\nexport DSH_HOME='/data/one'\n${BLOCK_END}\n`)
    expect(readFileSync(`${file}${PROFILE_BACKUP_SUFFIX}`, 'utf8')).toBe(original)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(home).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('replaces an existing block in place and leaves the lines around it', () => {
    const file = join(home, '.zshrc')
    writeFileSync(file, `before\n${BLOCK_START}\nexport DSH_HOME='/old'\n${BLOCK_END}\nafter\n`)
    updateShellProfile(zsh(), '/new')
    expect(readFileSync(file, 'utf8')).toBe(`before\n${BLOCK_START}\nexport DSH_HOME='/new'\n${BLOCK_END}\nafter\n`)
    expect(updateShellProfile(zsh(), '/new')).toEqual({ kind: 'unchanged', file })
  })

  it('removes the block when the value is cleared', () => {
    const file = join(home, '.zshrc')
    writeFileSync(file, `before\n${BLOCK_START}\nexport DSH_HOME='/old'\n${BLOCK_END}\nafter\n`)
    updateShellProfile(zsh(), undefined)
    expect(readFileSync(file, 'utf8')).toBe('before\nafter\n')
    expect(updateShellProfile(zsh(), undefined)).toEqual({ kind: 'unchanged', file })
  })

  it('leaves the person\'s own assignment alone and writes nothing', () => {
    const file = join(home, '.zshrc')
    const original = `# export DSH_HOME=/commented\nexport PATH=/x\nexport DSH_HOME="$HOME/mine"\n${BLOCK_START}\nexport DSH_HOME='/old'\n${BLOCK_END}\n[ -d /y ] && DSH_HOME=/y\n`
    writeFileSync(file, original)
    expect(updateShellProfile(zsh(), '/new')).toEqual({
      kind: 'foreign-assignment', file, places: [{ file, line: 3 }, { file, line: 7 }],
    })
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(existsSync(`${file}${PROFILE_BACKUP_SUFFIX}`)).toBe(false)
  })

  it('refuses a block with only one of its markers', () => {
    const file = join(home, '.zshrc')
    writeFileSync(file, `${BLOCK_START}\nexport DSH_HOME='/old'\n`)
    expect(updateShellProfile(zsh(), '/new')).toEqual({ kind: 'damaged-block', file })
    writeFileSync(file, `${BLOCK_END}\nx\n${BLOCK_START}\n`)
    expect(updateShellProfile(zsh(), '/new')).toEqual({ kind: 'damaged-block', file })
  })

  posixOnly('writes through a symbolic link to its target and keeps the link', () => {
    const dotfiles = join(home, 'dotfiles')
    mkdirSync(dotfiles)
    writeFileSync(join(dotfiles, 'zshrc'), 'x=1\n')
    symlinkSync(join(dotfiles, 'zshrc'), join(home, '.zshrc'))
    const update = updateShellProfile(zsh(), '/new')
    expect(update).toMatchObject({ kind: 'written', file: join(dotfiles, 'zshrc') })
    expect(lstatSync(join(home, '.zshrc')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dotfiles, 'zshrc'), 'utf8')).toContain("export DSH_HOME='/new'")
  })

  withBash('writes a block the shell reads back exactly, spaces, CJK, and quotes included', () => {
    writeFileSync(join(home, '.bash_profile'), 'true\n')
    updateShellProfile({ home, shell: '/bin/bash', zdotdir: undefined }, TRICKY)
    const read = execFileSync('/bin/bash', ['-c', `. '${join(home, '.bash_profile')}'; printf %s "$DSH_HOME"`], { env: shellEnv(), encoding: 'utf8' })
    expect(read).toBe(TRICKY)
  })
})

describe('Windows user environment', () => {
  /** A runner that records each call and answers from a queue. */
  function recorder(answers: Array<{ code: number | null; stdout: string } | Error>): {
    run: PowerShellRunner
    calls: Array<{ script: string; env: Record<string, string> }>
  } {
    const calls: Array<{ script: string; env: Record<string, string> }> = []
    return {
      calls,
      run: async (script, env) => {
        calls.push({ script, env })
        const next = answers.shift()
        if (next === undefined) throw new Error('unexpected PowerShell call')
        if (next instanceof Error) throw next
        return next
      },
    }
  }

  it('reads the user-scope value as UTF-8', async () => {
    const { run, calls } = recorder([{ code: 0, stdout: 'set:D:\\数据 盘\\DSH-Data' }])
    expect(await readWindowsUserDshHome(run)).toEqual({ kind: 'set', value: 'D:\\数据 盘\\DSH-Data', source: 'user-environment' })
    expect(calls).toEqual([{ script: READ_USER_ENV_SCRIPT, env: {} }])
    expect(READ_USER_ENV_SCRIPT).toContain("GetEnvironmentVariable('DSH_HOME', 'User')")
    expect(READ_USER_ENV_SCRIPT).toContain('OutputEncoding = [System.Text.Encoding]::UTF8')
  })

  it('reports unset, and unknown for a failed or silent run', async () => {
    expect(await readWindowsUserDshHome(recorder([{ code: 0, stdout: 'unset:' }]).run)).toEqual({ kind: 'unset' })
    expect(await readWindowsUserDshHome(recorder([{ code: 0, stdout: 'set:  ' }]).run)).toEqual({ kind: 'unset' })
    expect((await readWindowsUserDshHome(recorder([{ code: 1, stdout: '' }]).run)).kind).toBe('unknown')
    expect((await readWindowsUserDshHome(recorder([{ code: 0, stdout: 'banner' }]).run)).kind).toBe('unknown')
    expect((await readWindowsUserDshHome(recorder([new Error('spawn failed')]).run)).kind).toBe('unknown')
  })

  it('passes the new value through the environment, never the command line', async () => {
    const { run, calls } = recorder([{ code: 0, stdout: '' }, { code: 0, stdout: '' }])
    await writeWindowsUserDshHome(run, "D:\\it's 数据")
    await writeWindowsUserDshHome(run, undefined)
    expect(calls).toEqual([
      { script: WRITE_USER_ENV_SCRIPT, env: { [WRITE_VALUE_ENV]: "D:\\it's 数据" } },
      { script: WRITE_USER_ENV_SCRIPT, env: {} },
    ])
    expect(WRITE_USER_ENV_SCRIPT).toContain("SetEnvironmentVariable('DSH_HOME', $v, 'User')")
    expect(WRITE_USER_ENV_SCRIPT).not.toContain('数据')
  })

  it('throws when the write fails', async () => {
    await expect(writeWindowsUserDshHome(recorder([{ code: 5, stdout: '' }]).run, '/x')).rejects.toThrow(/exited with 5/)
  })
})

describe('platform dispatch', () => {
  function host(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, run?: PowerShellRunner): TerminalEnvHost {
    return {
      platform, env, home, shellTimeoutMs: 10_000,
      powershell: run ?? (async () => { throw new Error('PowerShell must not run here') }),
    }
  }

  it('prefers the person\'s own process DSH_HOME on every platform', async () => {
    expect(await readExplicitDshHome(host('win32', { DSH_HOME: 'D:\\x' }))).toEqual({ kind: 'set', value: 'D:\\x', source: 'process' })
  })

  it('asks the user environment on Windows when the process value is the shell\'s own', async () => {
    const run: PowerShellRunner = async () => ({ code: 0, stdout: 'set:E:\\y' })
    expect(await readExplicitDshHome(host('win32', { DSH_HOME: 'D:\\x', [POINTER_HOME_ENV]: 'D:\\x' }, run)))
      .toEqual({ kind: 'set', value: 'E:\\y', source: 'user-environment' })
  })

  withZsh('asks the login shell on macOS', async () => {
    writeFileSync(join(home, '.zshrc'), 'export DSH_HOME=/z\n')
    expect(await readExplicitDshHome(host('darwin', { ...shellEnv(), SHELL: '/bin/zsh' })))
      .toEqual({ kind: 'set', value: '/z', source: 'login-shell' })
  })

  it('has no persistent source elsewhere', async () => {
    expect((await readExplicitDshHome(host('linux', {}))).kind).toBe('unknown')
    expect(await writeTerminalDshHome(host('linux', {}), '/x')).toEqual({ kind: 'unsupported-platform', platform: 'linux' })
  })

  it('writes the user environment on Windows and the profile on macOS', async () => {
    const calls: string[] = []
    const run: PowerShellRunner = async (_script, env) => { calls.push(env[WRITE_VALUE_ENV] ?? '<removed>'); return { code: 0, stdout: '' } }
    expect(await writeTerminalDshHome(host('win32', {}, run), 'D:\\d')).toEqual({ kind: 'user-environment' })
    expect(calls).toEqual(['D:\\d'])
    const written = await writeTerminalDshHome(host('darwin', { SHELL: '/bin/zsh' }), '/m')
    expect(written).toEqual({ kind: 'profile', update: { kind: 'written', file: join(home, '.zshrc') } })
  })
})
