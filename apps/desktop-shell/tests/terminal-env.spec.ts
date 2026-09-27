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
  READ_USER_ENV_SCRIPT, readLoginShellDshHome, readPersistentDshHome, readWindowsUserDshHome, shellQuote,
  updateShellProfile, WRITE_USER_ENV_SCRIPT, WRITE_VALUE_ENV, writeTerminalDshHome, writeWindowsUserDshHome,
  parseTerminalSnapshot, READ_USER_ENV_RAW_SCRIPT, snapshotShellProfile, snapshotTerminal, snapshotWindowsUserDshHome,
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

  posixOnly('gives up after the time limit and kills the shell with everything it started', async () => {
    const bin = join(home, 'bin')
    mkdirSync(bin)
    const pidFile = join(home, 'pid')
    const childFile = join(home, 'child')
    const shell = join(bin, 'zsh')
    // A background job of a shell without job control stays in the shell's
    // process group, which the probe made the shell lead.
    writeFileSync(shell, [
      '#!/bin/sh',
      'sleep 30 &',
      `echo $! > '${childFile}.tmp'; mv '${childFile}.tmp' '${childFile}'`,
      `echo $$ > '${pidFile}.tmp'; mv '${pidFile}.tmp' '${pidFile}'`,
      'exec sleep 30',
      '',
    ].join('\n'))
    chmodSync(shell, 0o755)
    const started: number[] = []
    // The probe's limit runs on a faked clock, advanced only once the shell has
    // written both pids, so a slow start under load cannot outlast the limit.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = readLoginShellDshHome({ shell, env: shellEnv(), timeoutMs: 1500 })
      while (!existsSync(pidFile)) await sleep(10)
      started.push(Number(readFileSync(pidFile, 'utf8')), Number(readFileSync(childFile, 'utf8')))
      vi.advanceTimersByTime(1500)
      const read = await pending
      expect(read.kind).toBe('unknown')
      expect(read.kind === 'unknown' && read.detail).toContain('did not answer within 1500ms')
      // A killed child stays a zombie until its parent reaps it; wait for that state.
      for (const pid of started) while (isAlive(pid)) await sleep(10)
    } finally {
      vi.useRealTimers()
      for (const pid of started) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // ESRCH: already gone, which is the expected state.
        }
      }
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
    const missing = (file: string): object => ({ kind: 'file', file, exists: false })
    expect(profileFile({ home: '/h', shell: '/bin/zsh', zdotdir: undefined })).toEqual(missing('/h/.zshrc'))
    expect(profileFile({ home: '/h', shell: '/bin/zsh', zdotdir: '/z' })).toEqual(missing('/z/.zshrc'))
    expect(profileFile({ home: '/h', shell: '/opt/bin/bash', zdotdir: '/z' })).toEqual(missing('/h/.bash_profile'))
    expect(profileFile({ home: '/h', shell: '/usr/local/bin/fish', zdotdir: undefined })).toEqual({ kind: 'unsupported' })
    expect(profileFile({ home: '/h', shell: undefined, zdotdir: undefined })).toEqual({ kind: 'unsupported' })
  })

  posixOnly('picks the first bash login file that exists, following links and skipping dangling ones, as bash does', () => {
    const bash = { home, shell: '/bin/bash', zdotdir: undefined }
    const found = (name: string): object => ({ kind: 'file', file: join(home, name), exists: true })
    expect(profileFile(bash)).toEqual({ kind: 'file', file: join(home, '.bash_profile'), exists: false })
    writeFileSync(join(home, '.profile'), '')
    expect(profileFile(bash)).toEqual(found('.profile'))
    writeFileSync(join(home, '.bash_login'), '')
    expect(profileFile(bash)).toEqual(found('.bash_login'))
    symlinkSync(join(home, 'dotfiles-gone'), join(home, '.bash_profile'))
    expect(profileFile(bash)).toEqual(found('.bash_login'))
    writeFileSync(join(home, 'dotfiles-gone'), '')
    expect(profileFile(bash)).toEqual(found('.bash_profile'))
  })

  /** What a login bash in the temporary home prints for `$FOO|$DSH_HOME`. */
  function bashLogin(): string {
    return execFileSync('/bin/bash', ['-ilc', 'printf "%s|%s" "$FOO" "$DSH_HOME"'], {
      env: shellEnv(), stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    })
  }

  withBash.each([
    ['only ~/.profile', () => { writeFileSync(join(home, '.profile'), 'export FOO=mark\n') }, '.profile'],
    ['only ~/.bash_login', () => { writeFileSync(join(home, '.bash_login'), 'export FOO=mark\n') }, '.bash_login'],
    ['a dangling ~/.bash_profile beside ~/.profile', () => {
      symlinkSync(join(home, 'unplugged', 'bash_profile'), join(home, '.bash_profile'))
      writeFileSync(join(home, '.profile'), 'export FOO=mark\n')
    }, '.profile'],
    ['~/.bash_profile linked to a dotfiles checkout', () => {
      writeFileSync(join(home, 'dot'), 'export FOO=mark\n')
      symlinkSync(join(home, 'dot'), join(home, '.bash_profile'))
    }, 'dot'],
  ])('writes where a login bash reads it with %s', (_name, arrange, written) => {
    arrange()
    expect(bashLogin()).toBe('mark|')
    expect(updateShellProfile({ home, shell: '/bin/bash', zdotdir: undefined }, '/data/B'))
      .toMatchObject({ kind: 'written', file: join(home, written) })
    expect(bashLogin()).toBe('mark|/data/B')
  })

  posixOnly('creates nothing through a dangling profile link, for bash or zsh', () => {
    const link = join(home, '.bash_profile')
    symlinkSync(join(home, 'unplugged', 'bash_profile'), link)
    expect(updateShellProfile({ home, shell: '/bin/bash', zdotdir: undefined }, '/data/B')).toEqual({ kind: 'dangling-profile', link })
    const zshrc = join(home, '.zshrc')
    symlinkSync(join(home, 'unplugged', 'zshrc'), zshrc)
    expect(updateShellProfile(zsh(), '/data/B')).toEqual({ kind: 'dangling-profile', link: zshrc })
    expect(readdirSync(home).sort()).toEqual(['.bash_profile', '.zshrc'])
  })

  it.each([
    ['high bytes', Buffer.from([0x65, 0x78, 0x0a, ...Array.from({ length: 128 }, (_, i) => 0x80 + i), 0x0a])],
    ['invalid UTF-8', Buffer.from([0x23, 0x20, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x90, 0x28, 0xbc, 0xff, 0xfe, 0x0a])],
    ['CRLF', Buffer.from('export A=1\r\nexport B=2\r\n')],
    ['no final newline', Buffer.from('export A=1\nexport B=2')],
    ['a final newline', Buffer.from('export A=1\nexport B=2\n')],
    ['a byte-order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export A=1\n')])],
    ['a blank last line', Buffer.from('export A=1\n\n')],
    ['mixed line ends and bytes', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\n'), Buffer.from([0x80, 0xff]), Buffer.from('\nb')])],
    ['CRLF and no final line end', Buffer.from('export A=1\r\nexport B=2')],
    ['a lone carriage return', Buffer.from('export A=1\r')],
  ])('gives back the original bytes of a profile with %s once the block is written, changed, and removed', (_name, original) => {
    const file = join(home, '.zshrc')
    writeFileSync(file, original)
    expect(updateShellProfile(zsh(), '/data/B').kind).toBe('written')
    expect(readFileSync(`${file}${PROFILE_BACKUP_SUFFIX}`).equals(original)).toBe(true)
    const written = readFileSync(file)
    expect(written.subarray(0, original.length).equals(original)).toBe(true)
    expect(written.subarray(original.length).toString('latin1')).not.toContain('\r')
    expect(updateShellProfile(zsh(), '/data/C').kind).toBe('written')
    expect(updateShellProfile(zsh(), undefined).kind).toBe('written')
    expect(readFileSync(file).equals(original)).toBe(true)
  })

  it('writes the block in LF even into a CRLF file, and rewrites a CRLF block in place as LF', () => {
    const file = join(home, '.zshrc')
    writeFileSync(file, `export A=1\r\n${BLOCK_START}\r\nexport DSH_HOME='/old'\r\n${BLOCK_END}\r\nexport C=3\r\n`)
    expect(updateShellProfile(zsh(), '/data/B')).toMatchObject({ kind: 'written' })
    expect(readFileSync(file, 'utf8')).toBe(`export A=1\r\n${BLOCK_START}\nexport DSH_HOME='/data/B'\n${BLOCK_END}\nexport C=3\r\n`)
    expect(updateShellProfile(zsh(), undefined)).toMatchObject({ kind: 'written' })
    expect(readFileSync(file, 'utf8')).toBe('export A=1\r\nexport C=3\r\n')
    writeFileSync(file, 'export A=1\r\n')
    updateShellProfile(zsh(), '/data/B')
    expect(readFileSync(file, 'utf8')).toBe(`export A=1\r\n\n${BLOCK_START}\nexport DSH_HOME='/data/B'\n${BLOCK_END}\n`)
  })

  withZsh('hands a login zsh the exact value from a CRLF profile, with no carriage return', async () => {
    writeFileSync(join(home, '.zshrc'), 'export A=1\r\nexport B=2\r\n')
    updateShellProfile(zsh(), TRICKY)
    expect(await readLoginShellDshHome({ shell: '/bin/zsh', env: shellEnv(), timeoutMs: 20_000 }))
      .toEqual({ kind: 'set', value: TRICKY, source: 'login-shell' })
  })

  withBash('keeps a login bash reading ~/.profile after the block is written', () => {
    writeFileSync(join(home, '.profile'), 'export PROFILE_MARK=from-profile\n')
    const login = (): string => execFileSync('/bin/bash', ['-ilc', 'printf "%s|%s" "$PROFILE_MARK" "$DSH_HOME"'], {
      env: shellEnv(), stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    })
    expect(login()).toBe('from-profile|')
    expect(updateShellProfile({ home, shell: '/bin/bash', zdotdir: undefined }, '/data/B'))
      .toMatchObject({ kind: 'written', file: join(home, '.profile') })
    expect(existsSync(join(home, '.bash_profile'))).toBe(false)
    expect(login()).toBe('from-profile|/data/B')
  })

  withZsh('backs up and keeps every byte outside the block, whatever the file\'s encoding', () => {
    const file = join(home, '.zshrc')
    const original = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\nalias x=y\n')])
    writeFileSync(file, original)
    updateShellProfile(zsh(), TRICKY)
    expect(readFileSync(`${file}${PROFILE_BACKUP_SUFFIX}`).equals(original)).toBe(true)
    const written = readFileSync(file)
    expect(written.subarray(0, original.length).equals(original)).toBe(true)
    expect(written.subarray(original.length).toString('utf8')).toBe(`\n${BLOCK_START}\nexport DSH_HOME=${shellQuote(TRICKY)}\n${BLOCK_END}\n`)
    const read = execFileSync('/bin/zsh', ['-c', `. '${file}'; printf %s "$DSH_HOME"`], { env: shellEnv(), encoding: 'utf8' })
    expect(read).toBe(TRICKY)
    updateShellProfile(zsh(), undefined)
    expect(readFileSync(file).equals(original)).toBe(true)
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

  it('asks the user environment on Windows, whatever this process was started with', async () => {
    const run: PowerShellRunner = async () => ({ code: 0, stdout: 'set:E:\\y' })
    expect(await readPersistentDshHome(host('win32', { DSH_HOME: 'D:\\x' }, run)))
      .toEqual({ kind: 'set', value: 'E:\\y', source: 'user-environment' })
  })

  withZsh('asks the login shell on macOS, whatever this process was started with', async () => {
    writeFileSync(join(home, '.zshrc'), 'export DSH_HOME=/z\n')
    expect(await readPersistentDshHome(host('darwin', { ...shellEnv(), SHELL: '/bin/zsh', DSH_HOME: '/from-process' })))
      .toEqual({ kind: 'set', value: '/z', source: 'login-shell' })
  })

  it('has no persistent source elsewhere', async () => {
    expect((await readPersistentDshHome(host('linux', {}))).kind).toBe('unknown')
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

  it('removes the setting it wrote when asked for none, on both platforms', async () => {
    const calls: string[] = []
    const run: PowerShellRunner = async (_script, env) => { calls.push(env[WRITE_VALUE_ENV] ?? '<removed>'); return { code: 0, stdout: '' } }
    expect(await writeTerminalDshHome(host('win32', {}, run), undefined)).toEqual({ kind: 'user-environment' })
    expect(calls).toEqual(['<removed>'])
    const zshrc = join(home, '.zshrc')
    writeFileSync(zshrc, 'alias ll=ls\n')
    await writeTerminalDshHome(host('darwin', { SHELL: '/bin/zsh' }), '/m')
    expect(readFileSync(zshrc, 'utf8')).toContain('/m')
    expect(await writeTerminalDshHome(host('darwin', { SHELL: '/bin/zsh' }), undefined))
      .toMatchObject({ kind: 'profile', update: { kind: 'written', file: zshrc } })
    expect(readFileSync(zshrc, 'utf8')).not.toContain('DSH_HOME')
    expect(readFileSync(zshrc, 'utf8')).toContain('alias ll=ls')
  })
})

describe('the terminal setting recorded before a move', () => {
  const zsh = (): { home: string; shell: string; zdotdir: undefined } => ({ home, shell: '/bin/zsh', zdotdir: undefined })

  it('records that the profile did not exist, rather than an empty one', () => {
    expect(snapshotShellProfile(zsh())).toEqual({ kind: 'profile', file: join(home, '.zshrc'), hadBlock: false, backupExisted: false })
    writeFileSync(join(home, '.zshrc'), '')
    chmodSync(join(home, '.zshrc'), 0o600)
    expect(snapshotShellProfile(zsh())).toEqual({
      kind: 'profile', file: realpathSync(join(home, '.zshrc')), content: '', mode: 0o600, hadBlock: false, backupExisted: false,
    })
  })

  it('records the profile byte for byte, at its real path, and whether our block is in it', () => {
    const bytes = Buffer.concat([Buffer.from('alias ll=ls\r\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\nexport X=1')])
    const real = join(home, 'dotfiles-zshrc')
    writeFileSync(real, bytes)
    symlinkSync(real, join(home, '.zshrc'))
    const before = snapshotShellProfile(zsh())
    expect(before).toEqual({
      kind: 'profile', file: realpathSync(real), content: bytes.toString('base64'), mode: statSync(real).mode & 0o777, hadBlock: false,
      backupExisted: false,
    })
    expect(Buffer.from(before.kind === 'profile' ? before.content ?? '' : '', 'base64').equals(bytes)).toBe(true)
    updateShellProfile(zsh(), '/data')
    expect(snapshotShellProfile(zsh())).toMatchObject({ kind: 'profile', hadBlock: true, backupExisted: true })
  })

  it('records our block\'s own bytes, CRLF markers included, and no block when a marker is missing', () => {
    const block = '# >>> DSH data location >>>\r\nexport DSH_HOME=/old\r\n# <<< DSH data location <<<\r\n'
    writeFileSync(join(home, '.zshrc'), `alias a=b\r\n${block}export Y=2\r\n`)
    const snapshot = snapshotShellProfile(zsh())
    expect(snapshot).toMatchObject({ kind: 'profile', hadBlock: true, block: Buffer.from(block, 'latin1').toString('base64') })
    writeFileSync(join(home, '.zshrc'), '# >>> DSH data location >>>\nexport DSH_HOME=/old\n')
    const damaged = snapshotShellProfile(zsh())
    expect(damaged).toMatchObject({ kind: 'profile', hadBlock: true })
    expect(damaged.kind === 'profile' ? damaged.block : 'x').toBeUndefined()
  })

  it('records why no profile would be written', () => {
    expect(snapshotShellProfile({ home, shell: '/usr/bin/fish', zdotdir: undefined }))
      .toEqual({ kind: 'profile-unavailable', reason: 'unsupported-shell', detail: '/usr/bin/fish' })
    symlinkSync(join(home, 'gone'), join(home, '.zshrc'))
    expect(snapshotShellProfile(zsh())).toEqual({ kind: 'profile-unavailable', reason: 'dangling-profile', detail: join(home, '.zshrc') })
  })

  it('records the Windows variable with its registry type, telling set-to-empty from unset', async () => {
    const answering = (stdout: string, code = 0): PowerShellRunner => async (script) => {
      expect(script).toBe(READ_USER_ENV_RAW_SCRIPT)
      return { code, stdout }
    }
    expect(await snapshotWindowsUserDshHome(answering('unset:'))).toEqual({ kind: 'user-environment', value: { kind: 'unset' } })
    expect(await snapshotWindowsUserDshHome(answering('set:String:')))
      .toEqual({ kind: 'user-environment', value: { kind: 'set', type: 'String', raw: '' } })
    expect(await snapshotWindowsUserDshHome(answering('set:ExpandString:%USERPROFILE%\\DSH')))
      .toEqual({ kind: 'user-environment', value: { kind: 'set', type: 'ExpandString', raw: '%USERPROFILE%\\DSH' } })
    expect(await snapshotWindowsUserDshHome(answering('set:String:D:\\a:b')))
      .toEqual({ kind: 'user-environment', value: { kind: 'set', type: 'String', raw: 'D:\\a:b' } })
    expect((await snapshotWindowsUserDshHome(answering('set:MultiString:x'))).kind).toBe('unknown')
    expect((await snapshotWindowsUserDshHome(answering('', 1))).kind).toBe('unknown')
    expect((await snapshotWindowsUserDshHome(async () => { throw new Error('no PowerShell') })).kind).toBe('unknown')
  })

  it('dispatches by platform, and survives the journal round trip', async () => {
    const linux = await snapshotTerminal({ platform: 'linux', env: {}, home, shellTimeoutMs: 1, powershell: async () => ({ code: 0, stdout: '' }) })
    expect(linux).toEqual({ kind: 'unsupported-platform', platform: 'linux' })
    const mac = await snapshotTerminal({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, home, shellTimeoutMs: 1, powershell: async () => ({ code: 0, stdout: '' }) })
    expect(mac).toMatchObject({ kind: 'profile' })
    for (const snapshot of [
      mac, linux, { kind: 'unknown', detail: 'x' },
      { kind: 'user-environment', value: { kind: 'set', type: 'ExpandString', raw: '' } },
      { kind: 'user-environment', value: { kind: 'unset' } },
      { kind: 'profile', file: '/p', content: 'AA==', mode: 0o644, hadBlock: true, block: 'AA==', backupExisted: true },
      { kind: 'profile', file: '/p', hadBlock: false, backupExisted: false },
      { kind: 'profile-unavailable', reason: 'dangling-profile', detail: '/l' },
    ]) {
      expect(parseTerminalSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
    }
    expect(parseTerminalSnapshot({ kind: 'profile', file: '/p', hadBlock: 'yes', backupExisted: false })).toBeUndefined()
    expect(parseTerminalSnapshot({ kind: 'profile', file: '/p', hadBlock: false })).toBeUndefined()
    expect(parseTerminalSnapshot({ kind: 'profile', file: '/p', hadBlock: false, backupExisted: false, mode: -1 })).toBeUndefined()
    expect(parseTerminalSnapshot({ kind: 'profile', file: '/p', hadBlock: false, backupExisted: false, block: 1 })).toBeUndefined()
    expect(parseTerminalSnapshot({ kind: 'user-environment', value: { kind: 'set', type: 'MultiString', raw: '' } })).toBeUndefined()
  })
})
