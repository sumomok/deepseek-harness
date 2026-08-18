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
  const child = spawn(spec.nodeBin, [spec.entry, 'web', '--port', '0'], {
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
