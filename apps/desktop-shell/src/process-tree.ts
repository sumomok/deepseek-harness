/**
 * The embedded server's process tree: its descendants recorded while it runs,
 * and a check, after the server was stopped, that none of them is still
 * running. On POSIX the server's children (MCP servers, background jobs,
 * terminals) are handed to the system's init process when the server exits,
 * so they can no longer be found by their parent afterwards; they are found
 * by the process id and start time recorded before the stop. A process
 * started between the recording and the stop is not in the record.
 * @module @deepseek-ai/dsh-desktop-shell/process-tree
 */

import { spawn } from 'node:child_process'

/** One running process. */
export interface ProcessEntry {
  pid: number
  ppid: number
  /** When it started, as the system reports it; with the pid, it tells a process from a later one reusing the pid. */
  startedAt: string
  command: string
}

/** What checking a tree needs from the system; replaced in tests. */
export interface ProcessProbes {
  /** Every running process; empty when the system cannot be asked. */
  list: () => Promise<ProcessEntry[]>
  /** Kill one process at once (SIGKILL; `taskkill /F` on Windows). */
  kill: (pid: number) => Promise<void>
  sleep: (ms: number) => Promise<void>
}

/**
 * A process and every process below it.
 * @param root - the process id at the top.
 * @param entries - every running process.
 * @returns the root's entry (when it is running) and its descendants.
 */
export function descendantsOf(root: number, entries: readonly ProcessEntry[]): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>()
  for (const entry of entries) {
    const list = children.get(entry.ppid) ?? []
    list.push(entry)
    children.set(entry.ppid, list)
  }
  const found: ProcessEntry[] = []
  const seen = new Set<number>()
  const visit = (entry: ProcessEntry): void => {
    if (seen.has(entry.pid)) return
    seen.add(entry.pid)
    found.push(entry)
    for (const child of children.get(entry.pid) ?? []) visit(child)
  }
  const top = entries.find(entry => entry.pid === root)
  if (top !== undefined) visit(top)
  else for (const child of children.get(root) ?? []) visit(child)
  return found
}

/**
 * The recorded processes still running: the same process id with the same start time.
 * @param recorded - the tree as recorded.
 * @param running - every running process now.
 * @returns the ones still running.
 */
export function survivorsOf(recorded: readonly ProcessEntry[], running: readonly ProcessEntry[]): ProcessEntry[] {
  const now = new Map(running.map(entry => [entry.pid, entry]))
  return recorded.filter(entry => now.get(entry.pid)?.startedAt === entry.startedAt)
}

/** Kill rounds before a tree is given up as not stoppable. */
export const TREE_KILL_ROUNDS = 3

/** Milliseconds between two looks at the tree. */
export const TREE_CHECK_INTERVAL_MS = 500

/**
 * Make sure every recorded process is gone: kill the ones still running and
 * look again, up to {@link TREE_KILL_ROUNDS} times.
 * @param recorded - the tree as recorded before the stop.
 * @param probes - the process list, the kill, and the wait.
 * @returns the processes still running after the last round; empty when the tree is gone.
 */
export async function ensureTreeGone(recorded: readonly ProcessEntry[], probes: ProcessProbes): Promise<ProcessEntry[]> {
  if (recorded.length === 0) return []
  let survivors = survivorsOf(recorded, await probes.list())
  for (let round = 0; round < TREE_KILL_ROUNDS && survivors.length > 0; round += 1) {
    for (const entry of survivors) await probes.kill(entry.pid)
    await probes.sleep(TREE_CHECK_INTERVAL_MS)
    survivors = survivorsOf(recorded, await probes.list())
  }
  return survivors
}

/**
 * Parse `LC_ALL=C ps -axo pid=,ppid=,lstart=,comm=`: the start time is five
 * words (`Mon Sep 28 10:00:00 2026`), and the command may contain spaces.
 * @param output - what `ps` printed.
 * @returns the processes.
 */
export function parsePsOutput(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    entries.push({
      pid: Number(match[1]), ppid: Number(match[2]), startedAt: (match[3] ?? '').replace(/\s+/g, ' '), command: (match[4] ?? '').trim(),
    })
  }
  return entries
}

/** PowerShell listing every process as `pid<TAB>ppid<TAB>creation time<TAB>path`. */
export const WINDOWS_PROCESS_SCRIPT = 'Get-CimInstance Win32_Process | ForEach-Object { '
  + '"$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString(\'o\') })`t$($_.ExecutablePath)" }'

/**
 * Parse {@link WINDOWS_PROCESS_SCRIPT}'s output.
 * @param output - what it printed.
 * @returns the processes.
 */
export function parseWindowsProcesses(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    const [pid, ppid, startedAt, command] = line.split('\t')
    if (pid === undefined || ppid === undefined || !/^\d+$/.test(pid.trim()) || !/^\d+$/.test(ppid.trim())) continue
    entries.push({ pid: Number(pid), ppid: Number(ppid), startedAt: startedAt ?? '', command: command ?? '' })
  }
  return entries
}

/**
 * Run a command and collect its standard output; a command that cannot run gives nothing.
 * @param command - the program.
 * @param args - its arguments.
 * @returns stdout.
 */
function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    // The C locale fixes `lstart` to the five English words the parser reads; a Chinese locale prints four.
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, LC_ALL: 'C' } })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.once('error', () => { resolve('') })
    child.once('close', () => { resolve(out) })
  })
}

/**
 * The real process probes.
 * @param platform - the running platform.
 * @returns the probes.
 */
export function nodeProcessProbes(platform: NodeJS.Platform): ProcessProbes {
  return {
    list: async () => platform === 'win32'
      ? parseWindowsProcesses(await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCRIPT]))
      : parsePsOutput(await capture('ps', ['-axo', 'pid=,ppid=,lstart=,comm='])),
    kill: async (pid) => {
      if (platform === 'win32') {
        await capture('taskkill', ['/PID', String(pid), '/T', '/F'])
        return
      }
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ESRCH: it exited between the look and the kill, which is what the kill was for.
      }
    },
    sleep: ms => new Promise((resolve) => { setTimeout(resolve, ms) }),
  }
}

/** What {@link stopServerTree} works with. */
export interface ServerTreeStop {
  /** The server process, or `undefined` when none runs. */
  pid: number | undefined
  /** Stop the server (its bounded stop). */
  stop: () => Promise<void>
  /** Kill leftovers of earlier runs of this installation's server. */
  sweep: () => Promise<unknown>
  probes: ProcessProbes
}

/**
 * Stop the server and make sure its whole tree is gone: the tree is recorded
 * while the server runs, then the server is stopped, earlier runs' leftovers
 * are swept, and the recorded processes still running are killed.
 * @param input - the server, its stop, the sweep, and the process probes.
 * @returns the processes still running; empty when the tree is gone.
 */
export async function stopServerTree(input: ServerTreeStop): Promise<ProcessEntry[]> {
  const recorded = input.pid === undefined ? [] : descendantsOf(input.pid, await input.probes.list())
  await input.stop()
  await input.sweep()
  return ensureTreeGone(recorded, input.probes)
}
