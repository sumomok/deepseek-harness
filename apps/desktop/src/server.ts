/**
 * Embedded `dsh web` server lifecycle for the desktop shell: spawn the
 * deployed CLI on the bundled Node runtime, treat the printed URL line as the
 * readiness signal (the same contract the keyless CLI smoke relies on), and
 * own bounded teardown of the server process tree.
 * @module @deepseek-ai/dsh-desktop/server
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** The web-app readiness line; the loopback URL is capture group 1. */
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

/** How long the server may take to print its URL line before startup fails; a cold antivirus-scanned first launch is the slow case. */
const STARTUP_TIMEOUT_MS = 180_000

/** Grace between SIGTERM and SIGKILL on POSIX teardown. */
const STOP_GRACE_MS = 8_000

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
}

/** A started server: its UI URL and its bounded stop. */
export interface ServerHandle {
  /** The loopback URL from the readiness line. */
  url: string
  /** Terminate the server process tree; resolves once the process exited. */
  stop: () => Promise<void>
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
 * Start the embedded server and resolve once its UI URL is known.
 * @param spec - launch paths and working directory.
 * @param logSink - receives every server stdout/stderr chunk (for the log file).
 * @returns the running server handle; rejects when the process exits or stays
 * silent past the startup timeout, with the collected output in the message.
 */
export async function startServer(spec: ServerSpec, logSink: (chunk: string) => void): Promise<ServerHandle> {
  // The shell's own window is the browser for this server, so `--no-open`
  // declines the handoff the web app performs by default; without it every
  // start, including the relaunch after an update, adds a 127.0.0.1 tab.
  const child = spawn(spec.nodeBin, [spec.entry, 'web', '--port', '0', '--no-open'], {
    cwd: spec.cwd,
    env: augmentedEnv(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Without this a console window flashes for the bundled node.exe on Windows.
    windowsHide: true,
  })
  let collected = ''
  const url = await new Promise<string>((resolve, reject) => {
    let settled = false
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const timer = setTimeout(() => {
      settle(() => {
        void killTree(child)
        reject(new Error(`dsh server printed no URL line within ${String(STARTUP_TIMEOUT_MS / 1000)}s.\n${tail(collected)}`))
      })
    }, STARTUP_TIMEOUT_MS)
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString()
      collected += text
      logSink(text)
      const match = URL_LINE.exec(collected)
      if (match?.[1] !== undefined) settle(() => { resolve(match[1] as string) })
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.once('error', (error) => {
      settle(() => { reject(new Error(`dsh server failed to spawn: ${error.message}`)) })
    })
    child.once('exit', (code, signal) => {
      settle(() => {
        reject(new Error(`dsh server exited before its URL line (${code === null ? `signal ${signal ?? 'unknown'}` : `code ${String(code)}`}).\n${tail(collected)}`))
      })
    })
  })
  return { url, stop: () => killTree(child) }
}

/** The last lines of the collected output, for startup-failure messages. */
function tail(collected: string): string {
  const lines = collected.trimEnd().split('\n')
  return lines.slice(-15).join('\n')
}
