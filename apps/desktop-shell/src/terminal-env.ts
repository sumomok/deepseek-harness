/**
 * The `DSH_HOME` a terminal `dsh` sees, read and written from the desktop
 * shell, so a data location set in either place reaches the other.
 *
 * Reading has two sources. {@link processDshHome} reads a non-blank `DSH_HOME`
 * in this process's own environment, unless it is the value the shell itself
 * exported from the pointer ({@link POINTER_HOME_ENV} records that value, and
 * it survives a relaunch the way every exported variable does); the caller
 * gives it precedence. {@link readPersistentDshHome} asks the persistent
 * source: on macOS the person's login shell, since an app opened from
 * Finder does not inherit what the shell profile exports; on Windows the user
 * environment in `HKCU\Environment`. A source that cannot be read counts as
 * "not known", never as "unset".
 *
 * Writing touches one place per platform. On Windows it is the user
 * environment, set through .NET's `SetEnvironmentVariable`, which broadcasts
 * `WM_SETTINGCHANGE` itself; no copy of the earlier value is kept there. On
 * macOS it is one block this module owns in the shell profile, between
 * {@link BLOCK_START} and {@link BLOCK_END}; an
 * assignment the person wrote elsewhere in that file is never edited, and its
 * presence stops the write, because the person's own line would keep deciding
 * what the terminal sees. Other shells, fish among them, are not written.
 *
 * `launchctl setenv` is not used: its value outlives the profile block until
 * the next reboot and is invisible in any file, so a person who deletes the
 * block would still find the old location coming back through every app
 * launched from Finder.
 * @module @deepseek-ai/dsh-desktop-shell/terminal-env
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, win32 } from 'node:path'
import { copyDurably, writeDurably } from './durable-file.ts'

/**
 * Environment variable carrying the home the shell exported from the pointer.
 * A `DSH_HOME` equal to it came from the shell, not from the person.
 */
export const POINTER_HOME_ENV = 'DSH_DESKTOP_POINTER_HOME'
/** First line of the profile block this module owns. */
export const BLOCK_START = '# >>> DSH data location >>>'
/** Last line of the profile block this module owns. */
export const BLOCK_END = '# <<< DSH data location <<<'
/** Suffix of the copy a profile is saved to before a write adds this module's block to it. */
export const PROFILE_BACKUP_SUFFIX = '.dsh-backup'
/** How long the login shell may take to report `DSH_HOME` before it counts as unknown. */
export const LOGIN_SHELL_TIMEOUT_MS = 5000

/** Where an explicit `DSH_HOME` was read from. */
export type ExplicitSource = 'process' | 'login-shell' | 'user-environment'

/** What reading the explicit `DSH_HOME` found. */
export type ExplicitRead =
  | { kind: 'set'; value: string; source: ExplicitSource }
  | { kind: 'unset' }
  | { kind: 'unknown'; detail: string }

/**
 * The raw value of `DSH_HOME` in this process's own environment, when the
 * person put it there.
 * @param env - the process environment.
 * @returns the value, or `undefined` when unset, blank, or exported by the shell itself.
 */
export function processDshHome(env: NodeJS.ProcessEnv): string | undefined {
  const value = env['DSH_HOME']
  if (value === undefined || value.trim().length === 0) return undefined
  if (value === env[POINTER_HOME_ENV]) return undefined
  return value
}

/**
 * A copy of an environment without the named variables.
 * @param env - the environment to copy.
 * @param names - the variables to leave out.
 * @returns the copy.
 */
function without(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)))
}

/** Shells whose `-ilc` script syntax the login-shell probe speaks. */
const PROBE_SHELLS = new Set(['zsh', 'bash', 'sh', 'ksh', 'dash'])

/** Inputs of {@link readLoginShellDshHome}. */
export interface LoginShellProbe {
  /** The login shell, `$SHELL`. */
  shell: string | undefined
  /** The environment to start it with; `DSH_HOME` and {@link POINTER_HOME_ENV} are removed from it. */
  env: NodeJS.ProcessEnv
  /** Milliseconds before the probe is killed. */
  timeoutMs: number
}

/**
 * Ask the person's login shell what it exports as `DSH_HOME`, the way VS Code
 * resolves a shell environment: start it as an interactive login shell, have
 * it print the one variable between two random markers, and discard every
 * other byte its profile prints.
 * @param probe - the shell, its environment, and the time limit.
 * @returns `set` or `unset`, or `unknown` when the shell is unsupported, fails, or runs out of time.
 */
export async function readLoginShellDshHome(probe: LoginShellProbe): Promise<ExplicitRead> {
  const { shell } = probe
  if (shell === undefined || shell.length === 0) return { kind: 'unknown', detail: 'no login shell' }
  if (!PROBE_SHELLS.has(basename(shell))) return { kind: 'unknown', detail: `unsupported shell ${shell}` }
  const mark = randomBytes(8).toString('hex')
  const script = `printf '%s' "${mark}:\${DSH_HOME+set}:\${DSH_HOME}:${mark}"`
  const env: NodeJS.ProcessEnv = { ...without(probe.env, ['DSH_HOME', POINTER_HOME_ENV]), TERM: 'dumb' }
  return await new Promise<ExplicitRead>((settle) => {
    let output = ''
    let done = false
    const finish = (read: ExplicitRead): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle(read)
    }
    const child = spawn(shell, ['-ilc', script], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // ESRCH: the group exited between the timer firing and the kill.
          // Nothing is left to stop.
        }
      }
      finish({ kind: 'unknown', detail: `login shell did not answer within ${String(probe.timeoutMs)}ms` })
    }, probe.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.on('error', (error) => { finish({ kind: 'unknown', detail: String(error) }) })
    child.on('close', (code) => {
      const match = new RegExp(`${mark}:(set)?:([\\s\\S]*?):${mark}`).exec(output)
      if (match === null) {
        finish({ kind: 'unknown', detail: `login shell exited with ${String(code)} without reporting` })
        return
      }
      const value = match[2] ?? ''
      finish(match[1] === 'set' && value.trim().length > 0 ? { kind: 'set', value, source: 'login-shell' } : { kind: 'unset' })
    })
  })
}

/** Result of one PowerShell run. */
export interface PowerShellResult {
  code: number | null
  stdout: string
}

/**
 * Run one PowerShell script. `env` carries every value the script uses, so no
 * path is ever spliced into the command line.
 */
export type PowerShellRunner = (script: string, env: Record<string, string>) => Promise<PowerShellResult>

/** Environment variable a write script reads the new value from. */
export const WRITE_VALUE_ENV = 'DSH_DATA_LOCATION_VALUE'

/** Script reading the user-scope `DSH_HOME`, printed after a `set:` prefix as UTF-8. */
export const READ_USER_ENV_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$v = [Environment]::GetEnvironmentVariable('DSH_HOME', 'User')",
  "if ($null -ne $v) { [Console]::Out.Write('set:' + $v) } else { [Console]::Out.Write('unset:') }",
].join('; ')

/** Script setting the user-scope `DSH_HOME` from {@link WRITE_VALUE_ENV}, or removing it when that is absent. */
export const WRITE_USER_ENV_SCRIPT = [
  `$v = $env:${WRITE_VALUE_ENV}`,
  'if ([string]::IsNullOrEmpty($v)) { $v = $null }',
  "[Environment]::SetEnvironmentVariable('DSH_HOME', $v, 'User')",
].join('; ')

/**
 * Read `DSH_HOME` from the Windows user environment.
 * @param run - the PowerShell runner.
 * @returns `set` or `unset`, or `unknown` when PowerShell fails.
 */
export async function readWindowsUserDshHome(run: PowerShellRunner): Promise<ExplicitRead> {
  let result: PowerShellResult
  try {
    result = await run(READ_USER_ENV_SCRIPT, {})
  } catch (error) {
    return { kind: 'unknown', detail: String(error) }
  }
  if (result.code !== 0) return { kind: 'unknown', detail: `PowerShell exited with ${String(result.code)}` }
  if (result.stdout.startsWith('unset:')) return { kind: 'unset' }
  if (!result.stdout.startsWith('set:')) return { kind: 'unknown', detail: 'PowerShell printed no value' }
  const value = result.stdout.slice('set:'.length)
  return value.trim().length === 0 ? { kind: 'unset' } : { kind: 'set', value, source: 'user-environment' }
}

/**
 * Set or remove `DSH_HOME` in the Windows user environment.
 * @param run - the PowerShell runner.
 * @param value - the new value, or `undefined` to remove the variable.
 * @throws when PowerShell fails.
 */
export async function writeWindowsUserDshHome(run: PowerShellRunner, value: string | undefined): Promise<void> {
  const result = await run(WRITE_USER_ENV_SCRIPT, value === undefined ? {} : { [WRITE_VALUE_ENV]: value })
  if (result.code !== 0) throw new Error(`PowerShell exited with ${String(result.code)} setting DSH_HOME`)
}

/** A Windows path that names its drive and starts at its root (`C:\…`), or a UNC path (`\\server\…`). */
const FULL_WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/u

/**
 * The Windows directory: `%SystemRoot%`, else `%windir%`, else `C:\Windows`.
 * Only a full path counts ({@link FULL_WINDOWS_PATH}): a blank, relative,
 * drive-relative (`C:`), drive-less (`\Windows`), or unexpanded
 * (`%SystemDrive%\Windows`) value counts as unset, so a program under the
 * result never depends on the working directory or drive.
 * @param env - the environment the two variables are read from.
 * @returns the directory.
 */
export function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return [env['SystemRoot'], env['windir']].find(value => value !== undefined && FULL_WINDOWS_PATH.test(value)) ?? 'C:\\Windows'
}

/**
 * A program of Windows itself by its full path under `%SystemRoot%\System32`,
 * so a `PATH` without `System32` still reaches it.
 * @param env - the environment the Windows directory is read from ({@link windowsSystemRoot}).
 * @param segments - the path below `System32`.
 * @returns the full Windows path.
 */
export function system32Program(env: NodeJS.ProcessEnv, ...segments: string[]): string {
  return win32.join(windowsSystemRoot(env), 'System32', ...segments)
}

/** The system's own `powershell.exe` below `System32`. */
export const WINDOWS_POWERSHELL: readonly string[] = ['WindowsPowerShell', 'v1.0', 'powershell.exe']

/**
 * The PowerShell runner used on Windows: the system's own `powershell.exe`,
 * no profile, no window.
 * @param systemRoot - the Windows directory ({@link windowsSystemRoot}); `C:\Windows` when it is not a full path.
 * @param timeoutMs - milliseconds before the run is killed.
 * @returns the runner.
 */
export function systemPowerShell(systemRoot: string, timeoutMs: number): PowerShellRunner {
  const exe = system32Program({ SystemRoot: systemRoot }, ...WINDOWS_POWERSHELL)
  return async (script, env) => await new Promise<PowerShellResult>((settle, fail) => {
    // A value left in this process's own environment must not stand in for
    // "remove the variable".
    const inherited = without(process.env, [WRITE_VALUE_ENV])
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: timeoutMs,
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.on('error', fail)
    child.on('close', (code) => { settle({ code, stdout }) })
  })
}

/** One assignment to `DSH_HOME` the person wrote outside the owned block. */
export interface ForeignAssignment {
  file: string
  /** 1-based line number. */
  line: number
}

/** Outcome of {@link updateShellProfile}. */
export type ProfileUpdate =
  /** `backup` names `<file>.dsh-backup` when this write copied the file there. */
  | { kind: 'written'; file: string; backup?: string }
  | { kind: 'unchanged'; file: string }
  | { kind: 'unsupported-shell'; shell: string }
  | { kind: 'foreign-assignment'; file: string; places: ForeignAssignment[] }
  | { kind: 'damaged-block'; file: string }
  /** The shell would read a profile through `link`, a link whose target does not exist; nothing is created through it. */
  | { kind: 'dangling-profile'; link: string }

/** Inputs of {@link updateShellProfile}. */
export interface ProfileTarget {
  /** The person's home directory. */
  home: string
  /** The login shell, `$SHELL`. */
  shell: string | undefined
  /** `$ZDOTDIR`, where zsh reads its profile from when set. */
  zdotdir: string | undefined
}

/**
 * Which profile file a shell reads.
 *
 * - `file`: `file` is the profile; `exists` is false when it is to be created.
 * - `dangling`: the profile the shell would read is reached through `link`,
 *   a link whose target does not exist.
 * - `unsupported`: this module does not write the shell's profile.
 */
export type ProfileChoice =
  | { kind: 'file'; file: string; exists: boolean }
  | { kind: 'dangling'; link: string }
  | { kind: 'unsupported' }

/** The files a login bash tries, in its order. */
const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile'] as const

/**
 * What a shell finds at a candidate profile, following links as the shell does.
 * @param path - the candidate.
 * @returns `exists`, `dangling` for a link whose target is missing, or `absent`.
 * @throws when the candidate cannot be checked for a reason other than a missing entry.
 */
function candidateState(path: string): 'exists' | 'dangling' | 'absent' {
  try {
    statSync(path)
    return 'exists'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    lstatSync(path)
    return 'dangling'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return 'absent'
  }
}

/**
 * The profile file a shell reads for an interactive terminal, checked the way
 * the shell opens it, following links.
 *
 * For zsh it is `.zshrc` in `ZDOTDIR` or the home. For bash it is the first of
 * `~/.bash_profile`, `~/.bash_login`, and `~/.profile` that exists, which is
 * the order a login bash tries them in: a missing entry, a dangling link
 * included, is skipped, and the first one that exists is the only one read,
 * even when it cannot be read. With none of them existing it is
 * `~/.bash_profile`, to be created, unless one of them is a dangling link:
 * creating a file beside it, or through it, would take the place of the file
 * the person keeps on a disk that is not attached.
 * @param target - home, shell, and `ZDOTDIR`.
 * @returns the file, a dangling link that stands in the way, or `unsupported`.
 * @throws when a candidate cannot be checked for a reason other than a missing entry.
 */
export function profileFile(target: ProfileTarget): ProfileChoice {
  const name = target.shell === undefined ? '' : basename(target.shell)
  let candidates: string[]
  if (name === 'zsh') {
    const dir = target.zdotdir !== undefined && target.zdotdir.length > 0 ? target.zdotdir : target.home
    candidates = [join(dir, '.zshrc')]
  } else if (name === 'bash') {
    candidates = BASH_LOGIN_FILES.map(file => join(target.home, file))
  } else {
    return { kind: 'unsupported' }
  }
  let dangling: string | undefined
  for (const candidate of candidates) {
    const state = candidateState(candidate)
    if (state === 'exists') return { kind: 'file', file: candidate, exists: true }
    if (state === 'dangling') dangling ??= candidate
  }
  if (dangling !== undefined) return { kind: 'dangling', link: dangling }
  return { kind: 'file', file: candidates[0] ?? '', exists: false }
}

/**
 * Quote a value for a POSIX shell: single quotes, with each embedded single
 * quote closed, escaped, and reopened. Nothing inside is expanded.
 * @param value - the raw value.
 * @returns the quoted word.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const ASSIGNMENT = /(^|[\s;&|])(export\s+|typeset\s+-x\s+|declare\s+-x\s+)?DSH_HOME=/

/**
 * A line without its terminator, and without the carriage return a CRLF file
 * leaves before the newline.
 * @param segment - one line with its terminator, if any.
 * @returns the text of the line.
 */
function lineText(segment: string): string {
  return segment.replace(/\r?\n$/, '')
}

/** A profile's text (latin1, one code unit per byte) cut around this module's block. */
export type ProfileBlocks =
  | { kind: 'none' }
  | { kind: 'damaged' }
  | { kind: 'block'; before: string[]; block: string[]; after: string[] }

/**
 * Find this module's block in a profile's text: the lines from
 * {@link BLOCK_START} through {@link BLOCK_END}, markers recognized with or
 * without a carriage return.
 * @param text - the profile's bytes as latin1.
 * @returns the lines before, of, and after the block; `none` without one; `damaged` when only one marker is there or they are out of order.
 */
export function findProfileBlock(text: string): ProfileBlocks {
  const segments = text.length === 0 ? [] : text.split(/(?<=\n)/)
  const texts = segments.map(lineText)
  const start = texts.indexOf(BLOCK_START)
  const end = texts.indexOf(BLOCK_END)
  if (start === -1 && end === -1) return { kind: 'none' }
  if (start === -1 || end < start) return { kind: 'damaged' }
  return { kind: 'block', before: segments.slice(0, start), block: segments.slice(start, end + 1), after: segments.slice(end + 1) }
}

/**
 * A profile's text with this module's block removed, the way
 * {@link updateShellProfile} removes it: a block that is the last thing in the
 * file takes the one LF before it along, the one appending it added.
 * @param found - what {@link findProfileBlock} found.
 * @returns the text without the block.
 */
export function withoutProfileBlock(found: Extract<ProfileBlocks, { kind: 'block' }>): string {
  const before = [...found.before]
  const last = before.at(-1)
  // Only the LF this module appended before the block, never a carriage return before it.
  if (found.after.length === 0 && last?.endsWith('\n') === true) before[before.length - 1] = last.slice(0, -1)
  return [...before, ...found.after].join('')
}

/**
 * Set or remove this module's `DSH_HOME` block in the person's shell profile.
 * A profile that is a symbolic link is written at its target, so a dotfiles
 * checkout keeps its link. The file is replaced atomically with the same
 * permission bits.
 *
 * Only a write to an existing file that holds no block of this module's
 * copies it first, byte for byte, to `<file>.dsh-backup`, replacing an earlier
 * copy. A write to a file that already holds the block leaves the copy as it
 * is, so the copy keeps the file as it was before this module first added its
 * block, however many writes follow, and whatever the person changed around
 * the block since. A person who removes the block by hand gets a fresh copy of
 * that file on the next write.
 *
 * The profile is handled as bytes, not decoded text: every byte outside the
 * block, in whatever encoding the person saved it, is written back unchanged,
 * and only the block itself is UTF-8. The block's lines always end in LF,
 * whatever the file uses: a shell keeps a carriage return before the newline
 * as part of the value, so a CRLF block would hand every terminal a data
 * directory ending in `\r`. A CRLF block found in the file is rewritten as an
 * LF block, and its markers are recognized with or without the carriage
 * return. A new block is appended after one LF — the separating blank line
 * when the file ends with a line terminator, the missing final terminator
 * when it does not — and removing a block that is still the last thing in
 * the file removes that one LF too, so appending, changing the value, and
 * removing give back the original bytes. A block that is no longer last is
 * removed alone.
 * @param target - home, shell, and `ZDOTDIR`.
 * @param value - the absolute data directory, or `undefined` to remove the block.
 * @returns what was done, or why nothing was written.
 * @throws when the profile exists but cannot be read, or cannot be written.
 */
export function updateShellProfile(target: ProfileTarget, value: string | undefined): ProfileUpdate {
  const choice = profileFile(target)
  if (choice.kind === 'unsupported') return { kind: 'unsupported-shell', shell: target.shell ?? '' }
  if (choice.kind === 'dangling') return { kind: 'dangling-profile', link: choice.link }
  let path = choice.file
  // latin1 maps each byte to one code unit and back, so the string operations
  // below see ASCII markers exactly and leave every other byte as it was.
  let original = ''
  let mode = 0o644
  if (choice.exists) {
    path = realpathSync(choice.file)
    original = readFileSync(path).toString('latin1')
    mode = statSync(path).mode & 0o777
  }
  const segments = original.length === 0 ? [] : original.split(/(?<=\n)/)
  const texts = segments.map(lineText)
  const start = texts.indexOf(BLOCK_START)
  const end = texts.indexOf(BLOCK_END)
  if ((start === -1) !== (end === -1) || end < start) return { kind: 'damaged-block', file: path }
  const places: ForeignAssignment[] = []
  texts.forEach((line, index) => {
    if (start !== -1 && index >= start && index <= end) return
    if (line.trimStart().startsWith('#')) return
    if (ASSIGNMENT.test(line)) places.push({ file: path, line: index + 1 })
  })
  if (places.length > 0) return { kind: 'foreign-assignment', file: path, places }
  const assignment = Buffer.from(`export DSH_HOME=${shellQuote(value ?? '')}`, 'utf8').toString('latin1')
  let content: string
  if (start !== -1) {
    const before = segments.slice(0, start)
    const after = segments.slice(end + 1)
    if (value !== undefined) {
      const block = `${BLOCK_START}\n${assignment}\n${BLOCK_END}${segments[end]?.endsWith('\n') === true ? '\n' : ''}`
      content = [...before, block, ...after].join('')
    } else {
      content = withoutProfileBlock({ kind: 'block', before, block: segments.slice(start, end + 1), after })
    }
  } else if (value === undefined) {
    content = original
  } else {
    const separator = original.length > 0 ? '\n' : ''
    content = `${original}${separator}${BLOCK_START}\n${assignment}\n${BLOCK_END}\n`
  }
  if (content === original) return { kind: 'unchanged', file: path }
  let backup: string | undefined
  if (choice.exists && start === -1) {
    backup = `${path}${PROFILE_BACKUP_SUFFIX}`
    copyDurably(path, backup)
  }
  writeDurably(path, Buffer.from(content, 'latin1'), mode)
  return backup === undefined ? { kind: 'written', file: path } : { kind: 'written', file: path, backup }
}

/** Everything {@link readPersistentDshHome} and {@link writeTerminalDshHome} need from the host. */
export interface TerminalEnvHost {
  platform: NodeJS.Platform
  /** This process's environment. */
  env: NodeJS.ProcessEnv
  /** The person's home directory. */
  home: string
  /** Runs PowerShell on Windows. */
  powershell: PowerShellRunner
  /** Milliseconds the login shell may take. */
  shellTimeoutMs: number
}

/**
 * Read `DSH_HOME` from the persistent source, never from this process's
 * environment: what a terminal opened now would see. A write is confirmed
 * this way, since a value this process was started with says nothing about it.
 * @param host - platform, environment, and runners.
 * @returns the value with where it came from, `unset`, or `unknown`.
 */
export async function readPersistentDshHome(host: TerminalEnvHost): Promise<ExplicitRead> {
  if (host.platform === 'win32') return await readWindowsUserDshHome(host.powershell)
  if (host.platform === 'darwin') {
    return await readLoginShellDshHome({ shell: host.env['SHELL'], env: host.env, timeoutMs: host.shellTimeoutMs })
  }
  return { kind: 'unknown', detail: `no persistent source on ${host.platform}` }
}

/** Outcome of {@link writeTerminalDshHome}. */
export type TerminalWrite =
  | { kind: 'user-environment' }
  | { kind: 'profile'; update: ProfileUpdate }
  | { kind: 'unsupported-platform'; platform: NodeJS.Platform }

/**
 * Make terminals opened from now on see `value` as `DSH_HOME`.
 * @param host - platform, environment, and runners.
 * @param value - the absolute data directory, or `undefined` to remove the setting.
 * @returns what was written, or why nothing was.
 * @throws when the platform's store cannot be written.
 */
export async function writeTerminalDshHome(host: TerminalEnvHost, value: string | undefined): Promise<TerminalWrite> {
  if (host.platform === 'win32') {
    await writeWindowsUserDshHome(host.powershell, value)
    return { kind: 'user-environment' }
  }
  if (host.platform === 'darwin') {
    return {
      kind: 'profile',
      update: updateShellProfile({ home: host.home, shell: host.env['SHELL'], zdotdir: host.env['ZDOTDIR'] }, value),
    }
  }
  return { kind: 'unsupported-platform', platform: host.platform }
}

/**
 * The terminal's persistent `DSH_HOME` setting as it is before a data move,
 * recorded so a rollback puts back exactly what was there.
 *
 * - `profile`: the shell profile this module would edit (its real path).
 *   `content` is the file's bytes, base64, and `mode` its permission bits;
 *   both absent when the file did not exist. `hadBlock` says whether this
 *   module's block was in it, and `block` holds that block's bytes, base64,
 *   from its first marker line through its last, when both markers were
 *   there. `backupExisted` says whether `<file>.dsh-backup` existed.
 * - `profile-unavailable`: no profile would be edited (an unsupported shell,
 *   or a profile reached through a dangling link).
 * - `user-environment`: the Windows user variable, `unset`, or `set` with its
 *   registry type (`String` is REG_SZ, `ExpandString` REG_EXPAND_SZ) and its
 *   text unexpanded; an empty `raw` is a variable set to the empty string.
 * - `unknown`: the source could not be read.
 * - `unsupported-platform`: nothing is written on this platform.
 */
export type TerminalSnapshot =
  | { kind: 'profile'; file: string; content?: string; mode?: number; hadBlock: boolean; block?: string; backupExisted: boolean }
  | { kind: 'profile-unavailable'; reason: 'unsupported-shell' | 'dangling-profile'; detail: string }
  | { kind: 'user-environment'; value: { kind: 'unset' } | { kind: 'set'; type: 'String' | 'ExpandString'; raw: string } }
  | { kind: 'unknown'; detail: string }
  | { kind: 'unsupported-platform'; platform: string }

/**
 * Script reading the user-scope `DSH_HOME` from the registry as stored: its
 * value type and its text with environment references left unexpanded,
 * printed as `set:<type>:<text>` or `unset:`, UTF-8.
 */
export const READ_USER_ENV_RAW_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$k = Get-Item -LiteralPath 'HKCU:\\Environment'",
  "if ($k.GetValueNames() -contains 'DSH_HOME') { "
  + "$t = $k.GetValueKind('DSH_HOME'); "
  + "$v = $k.GetValue('DSH_HOME', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); "
  + "[Console]::Out.Write('set:' + $t + ':' + $v) } else { [Console]::Out.Write('unset:') }",
].join('; ')

/**
 * Record the Windows user `DSH_HOME` as stored.
 * @param run - the PowerShell runner.
 * @returns the snapshot, or `unknown` when PowerShell fails or reports a type other than a string.
 */
export async function snapshotWindowsUserDshHome(run: PowerShellRunner): Promise<TerminalSnapshot> {
  let result: PowerShellResult
  try {
    result = await run(READ_USER_ENV_RAW_SCRIPT, {})
  } catch (error) {
    return { kind: 'unknown', detail: String(error) }
  }
  if (result.code !== 0) return { kind: 'unknown', detail: `PowerShell exited with ${String(result.code)}` }
  if (result.stdout === 'unset:') return { kind: 'user-environment', value: { kind: 'unset' } }
  const match = /^set:(String|ExpandString):/.exec(result.stdout)
  if (match === null) return { kind: 'unknown', detail: `unexpected registry value: ${result.stdout.slice(0, 40)}` }
  const type = match[1] === 'ExpandString' ? 'ExpandString' : 'String'
  return { kind: 'user-environment', value: { kind: 'set', type, raw: result.stdout.slice(match[0].length) } }
}

/**
 * Record the shell profile this module would edit, byte for byte.
 * @param target - home, shell, and `ZDOTDIR`.
 * @returns the snapshot.
 * @throws when the profile exists but cannot be read.
 */
export function snapshotShellProfile(target: ProfileTarget): TerminalSnapshot {
  const choice = profileFile(target)
  if (choice.kind === 'unsupported') return { kind: 'profile-unavailable', reason: 'unsupported-shell', detail: target.shell ?? '' }
  if (choice.kind === 'dangling') return { kind: 'profile-unavailable', reason: 'dangling-profile', detail: choice.link }
  if (!choice.exists) {
    return { kind: 'profile', file: choice.file, hadBlock: false, backupExisted: existsSync(`${choice.file}${PROFILE_BACKUP_SUFFIX}`) }
  }
  const file = realpathSync(choice.file)
  const bytes = readFileSync(file)
  const mode = statSync(file).mode & 0o777
  const backupExisted = existsSync(`${file}${PROFILE_BACKUP_SUFFIX}`)
  const segments = bytes.toString('latin1').split(/(?<=\n)/)
  const texts = segments.map(lineText)
  const start = texts.indexOf(BLOCK_START)
  const end = texts.indexOf(BLOCK_END)
  const snapshot: TerminalSnapshot = { kind: 'profile', file, content: bytes.toString('base64'), mode, hadBlock: start !== -1, backupExisted }
  if (start === -1 || end < start) return snapshot
  return { ...snapshot, block: Buffer.from(segments.slice(start, end + 1).join(''), 'latin1').toString('base64') }
}

/**
 * Record the terminal's persistent `DSH_HOME` setting before a data move.
 * @param host - platform, environment, and runners.
 * @returns the snapshot.
 * @throws when a profile exists but cannot be read.
 */
export async function snapshotTerminal(host: TerminalEnvHost): Promise<TerminalSnapshot> {
  if (host.platform === 'win32') return await snapshotWindowsUserDshHome(host.powershell)
  if (host.platform === 'darwin') {
    return snapshotShellProfile({ home: host.home, shell: host.env['SHELL'], zdotdir: host.env['ZDOTDIR'] })
  }
  return { kind: 'unsupported-platform', platform: host.platform }
}

/**
 * Check a parsed {@link TerminalSnapshot}.
 * @param value - the value.
 * @returns it, or `undefined` when it is not one.
 */
export function parseTerminalSnapshot(value: unknown): TerminalSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const r = value as Record<string, unknown>
  switch (r['kind']) {
    case 'profile': {
      const { file, content, mode, hadBlock, block, backupExisted } = r
      if (typeof file !== 'string' || typeof hadBlock !== 'boolean' || typeof backupExisted !== 'boolean') return undefined
      if (content !== undefined && typeof content !== 'string') return undefined
      if (block !== undefined && typeof block !== 'string') return undefined
      if (mode !== undefined && (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777)) return undefined
      return {
        kind: 'profile', file, hadBlock, backupExisted,
        ...typeof content === 'string' ? { content } : {},
        ...typeof mode === 'number' ? { mode } : {},
        ...typeof block === 'string' ? { block } : {},
      }
    }
    case 'profile-unavailable': {
      const { reason, detail } = r
      if ((reason !== 'unsupported-shell' && reason !== 'dangling-profile') || typeof detail !== 'string') return undefined
      return { kind: 'profile-unavailable', reason, detail }
    }
    case 'user-environment': {
      const v = typeof r['value'] === 'object' && r['value'] !== null ? r['value'] as Record<string, unknown> : {}
      if (v['kind'] === 'unset') return { kind: 'user-environment', value: { kind: 'unset' } }
      const { type, raw } = v
      if (v['kind'] !== 'set' || (type !== 'String' && type !== 'ExpandString') || typeof raw !== 'string') return undefined
      return { kind: 'user-environment', value: { kind: 'set', type, raw } }
    }
    case 'unknown':
      return typeof r['detail'] === 'string' ? { kind: 'unknown', detail: r['detail'] } : undefined
    case 'unsupported-platform':
      return typeof r['platform'] === 'string' ? { kind: 'unsupported-platform', platform: r['platform'] } : undefined
    default:
      return undefined
  }
}
