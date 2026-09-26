/**
 * Embedded web server lifecycle for the desktop shell: spawn the deployed CLI
 * on the bundled Node runtime, treat the printed URL line as the readiness
 * signal (the same contract the keyless CLI smoke relies on), and own bounded
 * teardown of the server process tree.
 * @module @deepseek-ai/dsh-desktop-shell/server
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { DESKTOP_PROFILE } from './profile-seed.ts'

/** The web-app readiness line; capture group 1 is the authenticated URL carrying the launch token. */
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/

/** How long the server may take to print its URL line before startup fails; a cold antivirus-scanned first launch is the slow case. */
const STARTUP_TIMEOUT_MS = 180_000

/** Grace between SIGTERM and SIGKILL on POSIX teardown. */
const STOP_GRACE_MS = 8_000

/**
 * How many trailing lines of the server's stdout/stderr an exit autopsy keeps.
 * Fed continuously for the whole life of the child rather than kept as one
 * unbounded accumulation, so a server that dies after hours of output still
 * leaves a small, useful excerpt instead of nothing (a full log has already
 * gone to `logSink`).
 */
const RECENT_OUTPUT_TAIL_LINES = 15

/**
 * Kill server processes left behind by an earlier run of this same install.
 *
 * A desktop process that dies without completing its teardown — killed from a
 * task manager, or exited on the stop deadline — leaves its server child
 * running and reparented. That orphan keeps the bundled Node binary and the
 * deployed server files open, which on Windows is enough to make the next
 * update fail while the installer tries to delete them.
 *
 * The match is the full executable path of this install's own Node binary, not
 * the image name: every other `node` on the machine belongs to someone else and
 * must be left alone.
 * @param nodeBin - absolute path of this install's bundled Node binary.
 * @param logSink - receives one line when anything was killed.
 * @returns the process ids that were killed.
 */
export async function sweepOrphanedServers(nodeBin: string, logSink: (chunk: string) => void): Promise<number[]> {
  const pids = await findProcessesRunning(nodeBin)
  if (pids.length === 0) return []
  logSink(`[desktop] found ${String(pids.length)} orphaned server process(es) from an earlier run (${pids.join(', ')}); killing\n`)
  for (const pid of pids) await killPid(pid)
  return pids
}

/**
 * Process ids whose executable is exactly this path.
 * @param executable - the absolute executable path to match.
 * @returns the matching process ids, empty when the query fails.
 */
async function findProcessesRunning(executable: string): Promise<number[]> {
  if (process.platform === 'win32') {
    // Win32_Process.Path is the full image path, so this compares the whole
    // path rather than the `node.exe` name every Node install shares.
    const quoted = executable.replace(/'/g, "''")
    const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.Path -eq '${quoted}' } | ForEach-Object { $_.ProcessId }`
    const output = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    return parsePids(output)
  }
  // `comm` is the executable path on macOS, and `=` drops the header.
  const output = await capture('ps', ['-axo', 'pid=,comm='])
  const pids: number[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match?.[2]?.trim() === executable) pids.push(Number.parseInt(match[1] as string, 10))
  }
  return pids
}

/** Parse a newline-separated list of process ids, ignoring anything else. */
function parsePids(output: string): number[] {
  return output
    .split('\n')
    .map(line => Number.parseInt(line.trim(), 10))
    .filter(pid => Number.isInteger(pid) && pid > 0)
}

/**
 * Kill one process and, on Windows, everything it spawned. A server orphan has
 * its own children (shells, language servers), and they hold the same files.
 * @param pid - the process to kill.
 */
async function killPid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await capture('taskkill', ['/PID', String(pid), '/T', '/F'])
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The orphan exited between the scan and the kill, which is the outcome
    // this function wanted; there is no other reason `kill` can fail here.
  }
}

/**
 * Run a command and return its stdout, treating any failure as no output. The
 * callers use this to look for processes: a query that cannot run means the
 * sweep finds nothing, never that startup fails.
 * @param command - the executable to run.
 * @param args - its arguments.
 * @returns stdout, or an empty string when the command failed.
 */
async function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.once('error', () => { resolve('') })
    child.once('close', () => { resolve(out) })
  })
}

/** How to launch the embedded server. */
export interface ServerSpec {
  /** Absolute path of the bundled Node binary. */
  nodeBin: string
  /** Absolute path of the deployed `dsh` CLI entry (`lib/bin.js`). */
  entry: string
  /** Working directory the server (and its sessions) start in. */
  cwd: string
  /**
   * Variables added to the inherited environment for this child alone — the
   * endpoint and token of each loopback service the shell lends it, the
   * renderer, the update service, and the Office engine service, the path of
   * the pnpm launcher, and the `NODE_PATH` entry the Office engine is
   * resolved through. They
   * are deliberately not put on the shell's own `process.env`, because every
   * other process the shell starts would inherit them from there.
   */
  env: Record<string, string>
}

/** What one server-child exit tells the caller. */
export interface ServerExitInfo {
  /** The child's exit code, or null when it left by signal. */
  code: number | null
  /** The signal the child left by, or null when it exited with a code. */
  signal: NodeJS.Signals | null
  /**
   * True when this exit is this shell's own teardown — `stop()`, the quit
   * flow, or an update-install stop, all of which route through `stop()` —
   * rather than the server dying on its own. A caller supervising the child
   * for unexpected death must act only when this is false.
   */
  expected: boolean
  /** The last {@link RECENT_OUTPUT_TAIL_LINES} lines of stdout/stderr the child produced before exiting. */
  tail: string
}

/** A started server: its UI URL, its bounded stop, and its exit. */
export interface ServerHandle {
  /** The bare loopback origin, for same-server URL checks; never load this directly — a fresh page needs {@link authenticatedUrl}. */
  url: string
  /** The readiness-line URL carrying the launch token; loading it exchanges the token for the browser-session cookie. */
  authenticatedUrl: string
  /** Terminate the server process tree; resolves once the process exited. This is what marks the exit "expected". */
  stop: () => Promise<void>
  /**
   * Register a listener for the child's own exit. Fires exactly once, whether
   * the child already exited by the time this is called (synchronously, with
   * the recorded info) or exits later.
   * @param listener - receives the exit info.
   */
  onExit: (listener: (info: ServerExitInfo) => void) => void
}

/**
 * Thrown when the server process exited before printing its URL line.
 *
 * {@link output} carries the boot attempt's whole collected stdout and stderr,
 * not the truncated tail {@link Error.message} shows: a quarantine pass over it
 * needs the line that names a plugin, which the message's last 15 lines may
 * not include.
 */
export class ServerExitedBeforeUrl extends Error {
  /** Every stdout/stderr chunk this boot attempt produced, concatenated whole. */
  readonly output: string

  constructor(message: string, output: string) {
    super(message)
    this.name = 'ServerExitedBeforeUrl'
    this.output = output
  }
}

/**
 * GUI-launched processes on macOS inherit launchd's minimal PATH, which would
 * strip the agent's shell of the user's ordinary tools. Return env with the
 * standard interactive locations appended when missing.
 * @param base - the inherited environment.
 * @returns the augmented environment.
 */
export function augmentedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return { ...base }
  const standard = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const current = (base.PATH ?? '').split(':').filter(part => part !== '')
  for (const dir of standard) if (!current.includes(dir)) current.push(dir)
  return { ...base, PATH: current.join(':') }
}

/**
 * Kill the server's whole process tree. Windows has no signal-based group
 * teardown from Node, so it goes through `taskkill /T`; POSIX sends SIGTERM
 * (the launcher's ordinary supervisor stop, exit 0) and escalates to SIGKILL
 * after the grace window.
 * @param child - the spawned server process.
 * @returns resolves once the process reported exit.
 */
async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await exited
    return
  }
  child.kill('SIGTERM')
  const timer = setTimeout(() => { child.kill('SIGKILL') }, STOP_GRACE_MS)
  await exited
  clearTimeout(timer)
}

/**
 * A bounded last-N-lines buffer, fed one chunk at a time. Chunk boundaries
 * need not land on line boundaries; only the joined text at the end matters.
 * @param maxLines - how many trailing lines to keep.
 * @returns `push` to feed one chunk, and `text` to read the current tail.
 */
function tailBuffer(maxLines: number): { push: (chunk: string) => void; text: () => string } {
  let lines: string[] = ['']
  return {
    push(chunk: string): void {
      const [first = '', ...rest] = chunk.split('\n')
      const last = lines.length - 1
      lines[last] = (lines[last] ?? '') + first
      lines.push(...rest)
      if (lines.length > maxLines) lines = lines.slice(-maxLines)
    },
    text: () => lines.join('\n'),
  }
}

/**
 * Feed a stream's chunks to `onLine` one complete line at a time, and the
 * unterminated rest when the stream ends.
 * @param stream - one of the child's output streams.
 * @param onLine - receives each line without its newline.
 */
function forEachLine(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let pending = ''
  stream.on('data', (chunk: Buffer) => {
    const lines = (pending + chunk.toString()).split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  })
  stream.on('end', () => {
    if (pending !== '') onLine(pending)
    pending = ''
  })
}

/**
 * Start the embedded server and resolve once its UI URL is known.
 * @param spec - launch paths and working directory.
 * @param logSink - receives every server stdout/stderr chunk (for the log file).
 * @param onLine - receives every line of stdout and of stderr, each stream
 * split on its own, for as long as the process writes: before the URL line and
 * after it.
 * @returns the running server handle; rejects when the process exits or stays
 * silent past the startup timeout, with the collected output in the message.
 */
export async function startServer(
  spec: ServerSpec, logSink: (chunk: string) => void, onLine?: (line: string) => void,
): Promise<ServerHandle> {
  // `--profile desktop-shell` rather than the `web` alias: the shell's profile
  // is its own, and the launcher forwards from the first token it does not recognize,
  // so the web app still receives the two flags after it. The shell's own
  // window is the browser for this server, so `--no-open` declines the handoff
  // the web app performs by default; without it every start, including the
  // relaunch after an update, adds a 127.0.0.1 tab.
  const child = spawn(spec.nodeBin, [spec.entry, '--profile', DESKTOP_PROFILE, '--port', '0', '--no-open'], {
    cwd: spec.cwd,
    // DSH_TELEMETRY_DISABLED is upstream's own hard-disable switch
    // (packages/boot/app-boot/src/profile-context.ts's
    // resolveTelemetryPatch): this product sends no session telemetry, on
    // top of the base bundle's own
    // session-telemetry-otel row already shipping disabled. `spec.env` still
    // wins if a caller (a test) sets its own value.
    env: { ...augmentedEnv(process.env), DSH_TELEMETRY_DISABLED: '1', ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Without this a console window flashes for the bundled node.exe on Windows.
    windowsHide: true,
  })
  let collected = ''
  const recentOutput = tailBuffer(RECENT_OUTPUT_TAIL_LINES)
  // Raised by `stop()` (and by the startup-timeout kill below, which is this
  // shell's own decision too) before the child is signaled, so the exit this
  // produces is never mistaken for the server dying on its own.
  let expectedExit = false
  let exitInfo: ServerExitInfo | undefined
  const exitListeners: Array<(info: ServerExitInfo) => void> = []
  // `.once`, not tied to the startup race below: an exit autopsy must see
  // every exit, including one long after the URL was already reported.
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal, expected: expectedExit, tail: recentOutput.text() }
    for (const listener of exitListeners) listener(exitInfo)
  })
  const authenticatedUrl = await new Promise<string>((resolve, reject) => {
    let settled = false
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => {
      settle(() => {
        expectedExit = true
        void killTree(child)
        reject(new Error(`dsh server printed no URL line within ${String(STARTUP_TIMEOUT_MS / 1000)}s.\n${tail(collected)}`))
      })
    }, STARTUP_TIMEOUT_MS)
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString()
      collected += text
      recentOutput.push(text)
      logSink(text)
      const match = URL_LINE.exec(collected)
      if (match?.[1] !== undefined) settle(() => { resolve(match[1] as string) })
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    if (onLine !== undefined) {
      forEachLine(child.stdout, onLine)
      forEachLine(child.stderr, onLine)
    }
    child.once('error', (error) => {
      settle(() => { reject(new Error(`dsh server failed to spawn: ${error.message}`)) })
    })
    child.once('exit', (code, signal) => {
      settle(() => {
        reject(new ServerExitedBeforeUrl(
          `dsh server exited before its URL line (${code === null ? `signal ${signal ?? 'unknown'}` : `code ${String(code)}`}).\n${tail(collected)}`,
          collected,
        ))
      })
    })
  })
  return {
    url: new URL(authenticatedUrl).origin,
    authenticatedUrl,
    stop: () => {
      expectedExit = true
      return killTree(child)
    },
    onExit: (listener) => {
      if (exitInfo !== undefined) {
        listener(exitInfo)
        return
      }
      exitListeners.push(listener)
    },
  }
}

/** The last lines of the collected output, for startup-failure messages. */
function tail(collected: string): string {
  const lines = collected.trimEnd().split('\n')
  return lines.slice(-RECENT_OUTPUT_TAIL_LINES).join('\n')
}

/**
 * Record every migrated bundle a boot's output says did not load, when there is
 * one to blame. Injected, so the startup paths below are testable without a
 * real profile on disk.
 * @param home - the Harness home for this launch.
 * @param output - one line of the boot's output, or its whole collected stdout and stderr.
 * @returns the first name recorded and its detail, or undefined when nothing in
 * the output named a plugin to record.
 */
export type QuarantineLoadFailure = (home: string, output: string) => { name: string; detail: string } | undefined

/**
 * Start the embedded server with every line of its output checked for a
 * migrated plugin that did not load, and retry once when a boot that named one
 * exits before its URL line.
 *
 * A migrated package can fail to load in ways manifest-level admission cannot
 * catch — an unbuilt git install with no `lib/` and no `prepare` script is the
 * field case. The server reports such a package and keeps running without it:
 * an import failure is a row of its startup audit block, and a package the
 * launcher or the compatibility check refuses gets a line of its own, and all
 * of them can arrive after the URL line. `quarantine` sees every line of both
 * streams for the life of the process and moves the package it blames into
 * the marker's `defective` list, so this boot runs without it and no later
 * boot loads it; nothing restarts. A boot that exits before its URL line is
 * retried once, with the same spec, when a line of it blamed a migrated
 * package or `quarantine` finds one in its whole output; the server reports a
 * refused package without exiting, so this retry only runs for a failure
 * that also ends the process. A second failure, or a first one with nothing
 * to blame, is left for the caller exactly as {@link startServer} would leave
 * it.
 * @param spec - launch paths and working directory.
 * @param logSink - receives every server stdout/stderr chunk, from both attempts.
 * @param quarantine - records a blamed migrated name; see {@link QuarantineLoadFailure}.
 * @param home - the Harness home, passed to `quarantine` unchanged.
 * @returns the running server handle.
 * @throws the retry's own failure, or the first failure when nothing blamed a migrated plugin.
 */
export async function startServerWithQuarantine(
  spec: ServerSpec, logSink: (chunk: string) => void, quarantine: QuarantineLoadFailure, home: string,
): Promise<ServerHandle> {
  let blamed: { name: string; detail: string } | undefined
  const scan = (line: string): void => {
    const found = quarantine(home, line)
    if (found === undefined) return
    blamed ??= found
    logSink(`[desktop] disabled migrated ${found.name} after it failed to load (${found.detail}); it stays off from the next launch\n`)
  }
  try {
    return await startServer(spec, logSink, scan)
  } catch (error) {
    if (!(error instanceof ServerExitedBeforeUrl)) throw error
    const quarantined = blamed ?? quarantine(home, error.output)
    if (quarantined === undefined) throw error
    logSink(`[desktop] disabled migrated ${quarantined.name} after it failed to load; retrying startup\n`)
    return await startServer(spec, logSink, scan)
  }
}
