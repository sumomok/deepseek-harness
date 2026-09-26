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
 * `WM_SETTINGCHANGE` itself. On macOS it is one block this module owns in the
 * shell profile, between {@link BLOCK_START} and {@link BLOCK_END}; an
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
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
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
/** Suffix of the copy a profile is saved to before each rewrite. */
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

/**
 * The PowerShell runner used on Windows: the system's own `powershell.exe`,
 * no profile, no window.
 * @param systemRoot - `%SystemRoot%`.
 * @param timeoutMs - milliseconds before the run is killed.
 * @returns the runner.
 */
export function systemPowerShell(systemRoot: string, timeoutMs: number): PowerShellRunner {
  const exe = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
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
  | { kind: 'written'; file: string; backup?: string }
  | { kind: 'unchanged'; file: string }
  | { kind: 'unsupported-shell'; shell: string }
  | { kind: 'foreign-assignment'; file: string; places: ForeignAssignment[] }
  | { kind: 'damaged-block'; file: string }

/** Inputs of {@link updateShellProfile}. */
export interface ProfileTarget {
  /** The person's home directory. */
  home: string
  /** The login shell, `$SHELL`. */
  shell: string | undefined
  /** `$ZDOTDIR`, where zsh reads its profile from when set. */
  zdotdir: string | undefined
}

/** The files a bash login shell reads, in its order; it reads only the first that exists. */
const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile'] as const

/**
 * Whether a directory entry exists, a dangling link included.
 * @param path - the entry.
 * @returns true when `lstat` finds it.
 */
function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * The profile file a shell reads for an interactive terminal. For bash it is
 * the first of `~/.bash_profile`, `~/.bash_login`, and `~/.profile` that
 * exists, because a login bash reads that one and skips the rest; creating
 * `~/.bash_profile` beside an existing `~/.profile` would stop bash reading
 * the `~/.profile`. With none of them it is `~/.bash_profile`.
 * @param target - home, shell, and `ZDOTDIR`.
 * @returns the file, or `undefined` for a shell this module does not write.
 * @throws when a bash candidate cannot be checked for a reason other than its absence.
 */
export function profileFile(target: ProfileTarget): string | undefined {
  const name = target.shell === undefined ? '' : basename(target.shell)
  if (name === 'zsh') {
    const dir = target.zdotdir !== undefined && target.zdotdir.length > 0 ? target.zdotdir : target.home
    return join(dir, '.zshrc')
  }
  if (name === 'bash') {
    const found = BASH_LOGIN_FILES.map(file => join(target.home, file)).find(entryExists)
    return found ?? join(target.home, BASH_LOGIN_FILES[0])
  }
  return undefined
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
 * Set or remove this module's `DSH_HOME` block in the person's shell profile.
 * A profile that is a symbolic link is written at its target, so a dotfiles
 * checkout keeps its link. The file is copied byte for byte to
 * `<file>.dsh-backup` and then replaced atomically with the same permission
 * bits. The profile is handled as bytes, not decoded text: every byte outside
 * the block, in whatever encoding the person saved it, is written back
 * unchanged, and only the block itself is UTF-8.
 * @param target - home, shell, and `ZDOTDIR`.
 * @param value - the absolute data directory, or `undefined` to remove the block.
 * @returns what was done, or why nothing was written.
 * @throws when the profile exists but cannot be read, or cannot be written.
 */
export function updateShellProfile(target: ProfileTarget, value: string | undefined): ProfileUpdate {
  const file = profileFile(target)
  if (file === undefined) return { kind: 'unsupported-shell', shell: target.shell ?? '' }
  let path = file
  // latin1 maps each byte to one code unit and back, so the string operations
  // below see ASCII markers exactly and leave every other byte as it was.
  let original = ''
  let mode = 0o644
  const exists = entryExists(file)
  if (exists) {
    path = realpathSync(file)
    original = readFileSync(path).toString('latin1')
    mode = statSync(path).mode & 0o777
  }
  const lines = original.length === 0 ? [] : original.replace(/\n$/, '').split('\n')
  const start = lines.indexOf(BLOCK_START)
  const end = lines.indexOf(BLOCK_END)
  if ((start === -1) !== (end === -1) || end < start) return { kind: 'damaged-block', file: path }
  const places: ForeignAssignment[] = []
  lines.forEach((line, index) => {
    if (start !== -1 && index >= start && index <= end) return
    if (line.trimStart().startsWith('#')) return
    if (ASSIGNMENT.test(line)) places.push({ file: path, line: index + 1 })
  })
  if (places.length > 0) return { kind: 'foreign-assignment', file: path, places }
  const assignment = Buffer.from(`export DSH_HOME=${shellQuote(value ?? '')}`, 'utf8').toString('latin1')
  const block = value === undefined ? [] : [BLOCK_START, assignment, BLOCK_END]
  let next: string[]
  if (start !== -1) {
    next = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)]
  } else if (block.length === 0) {
    next = lines
  } else {
    next = lines.length > 0 && lines.at(-1) !== '' ? [...lines, '', ...block] : [...lines, ...block]
  }
  const content = next.length === 0 ? '' : `${next.join('\n')}\n`
  if (content === original) return { kind: 'unchanged', file: path }
  let backup: string | undefined
  if (exists) {
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
