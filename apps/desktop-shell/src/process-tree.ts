/**
 * The embedded server's process tree: its descendants recorded while it runs,
 * and a check, after the server was stopped, that none of them is still
 * running. On POSIX the server's children (MCP servers, background jobs,
 * terminals) are handed to the system's init process when the server exits,
 * so they can no longer be found by their parent afterwards; they are found
 * by the process id and start time recorded before the stop. A process
 * started between the recording and the stop is not in the record. An empty
 * process list means the system could not be asked, so it never confirms a
 * tree gone.
 * @module @deepseek-ai/dsh-desktop-shell/process-tree
 */

import { spawn } from 'node:child_process'
import { START_TIME_UNKNOWN, type LockProbes } from './move/lock.ts'
import { system32Program, systemPowerShell, windowsSystemRoot, type PowerShellResult, type PowerShellRunner } from './terminal-env.ts'

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

/** Whether a tree is gone after its stop. */
export type TreeCheck =
  | { kind: 'gone' }
  /** Some recorded processes are still running. */
  | { kind: 'running'; survivors: ProcessEntry[] }
  /** The process list could not be read, or did not show the server while it ran. */
  | { kind: 'unconfirmed'; detail: string }

/** Kill rounds before a tree is given up as not stoppable. */
export const TREE_KILL_ROUNDS = 3

/** Milliseconds between two looks at the tree. */
export const TREE_CHECK_INTERVAL_MS = 500

/**
 * Make sure every recorded process is gone: kill the ones still running and
 * look again, up to {@link TREE_KILL_ROUNDS} times.
 * @param recorded - the tree as recorded before the stop.
 * @param probes - the process list, the kill, and the wait.
 * @returns `gone`, the processes still running after the last round, or `unconfirmed` when the list came back empty.
 */
export async function ensureTreeGone(recorded: readonly ProcessEntry[], probes: ProcessProbes): Promise<TreeCheck> {
  if (recorded.length === 0) return { kind: 'gone' }
  const look = async (): Promise<ProcessEntry[] | undefined> => {
    const running = await probes.list()
    return running.length === 0 ? undefined : survivorsOf(recorded, running)
  }
  let survivors = await look()
  for (let round = 0; round < TREE_KILL_ROUNDS && survivors !== undefined && survivors.length > 0; round += 1) {
    for (const entry of survivors) await probes.kill(entry.pid)
    await probes.sleep(TREE_CHECK_INTERVAL_MS)
    survivors = await look()
  }
  if (survivors === undefined) return { kind: 'unconfirmed', detail: 'the process list came back empty after the stop' }
  return survivors.length === 0 ? { kind: 'gone' } : { kind: 'running', survivors }
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

/** Milliseconds the Windows process listing may take before it is killed and the list counts as unreadable. */
export const PROCESS_LIST_TIMEOUT_MS = 15_000

/**
 * List every process on Windows through {@link WINDOWS_PROCESS_SCRIPT}.
 * @param run - the PowerShell runner.
 * @returns the processes; none when PowerShell cannot run, exits with a failure, or is killed at its timeout.
 */
export async function listWindowsProcesses(run: PowerShellRunner): Promise<ProcessEntry[]> {
  let result: PowerShellResult
  try {
    result = await run(WINDOWS_PROCESS_SCRIPT, {})
  } catch {
    // The runner rejects when powershell.exe cannot be started; an empty list says the system could not be asked.
    return []
  }
  return result.code === 0 ? parseWindowsProcesses(result.stdout) : []
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

/** What {@link nodeProcessProbes} runs programs with; replaced in tests. */
export interface ProcessPrograms {
  /** The environment the Windows directory is read from. */
  env: NodeJS.ProcessEnv
  /** Run a program and collect its standard output; a program that cannot run gives nothing. */
  capture: (command: string, args: string[]) => Promise<string>
  /** The runner of the system's own `powershell.exe` under a `%SystemRoot%`. */
  powerShell: (systemRoot: string, timeoutMs: number) => PowerShellRunner
}

/** The programs the running process has. */
const NODE_PROGRAMS: ProcessPrograms = { env: process.env, capture, powerShell: systemPowerShell }

/**
 * The real process probes. On Windows the listing runs the system's own
 * `powershell.exe` and the kill its `taskkill.exe`, both by their full path
 * under the Windows directory ({@link windowsSystemRoot}), so a `PATH` without
 * `System32` still reaches them.
 * @param platform - the running platform.
 * @param programs - how programs are run; the running process's own when absent.
 * @returns the probes.
 */
export function nodeProcessProbes(platform: NodeJS.Platform, programs: ProcessPrograms = NODE_PROGRAMS): ProcessProbes {
  const systemRoot = windowsSystemRoot(programs.env)
  return {
    list: async () => platform === 'win32'
      ? await listWindowsProcesses(programs.powerShell(systemRoot, PROCESS_LIST_TIMEOUT_MS))
      : parsePsOutput(await programs.capture('ps', ['-axo', 'pid=,ppid=,lstart=,comm='])),
    kill: async (pid) => {
      if (platform === 'win32') {
        await programs.capture(system32Program(programs.env, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'])
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
  /**
   * Close what the shell itself runs that writes to the data outside the
   * server's tree (the Office engine download); awaited before anything else.
   */
  closeShellWriters?: () => Promise<unknown>
  /** The server process, or `undefined` when the shell holds no handle to one. */
  pid: number | undefined
  /**
   * Where a server without a handle is looked for when `pid` is `undefined`:
   * among the shell's own child processes, by the server's executable. A
   * start that failed before its URL line leaves no handle while that server
   * may still run, as at the startup timeout.
   */
  unhandled?: { shell: number; executable: string }
  /** Stop the server (its bounded stop). */
  stop: () => Promise<void>
  /** Kill leftovers of earlier runs of this installation's server. */
  sweep: () => Promise<unknown>
  probes: ProcessProbes
}

/**
 * The servers the shell started and holds no handle to, with every process
 * below them: the shell's direct children running the server's executable,
 * its path compared without letter case, as the file systems of macOS and
 * Windows compare it by default.
 * @param entries - every running process.
 * @param unhandled - the shell's process id and the server's executable.
 * @returns their entries and their descendants'.
 */
export function unhandledServerTrees(entries: readonly ProcessEntry[], unhandled: { shell: number; executable: string }): ProcessEntry[] {
  const executable = unhandled.executable.toLowerCase()
  return entries
    .filter(entry => entry.ppid === unhandled.shell && entry.command.toLowerCase() === executable)
    .flatMap(entry => descendantsOf(entry.pid, entries))
}

/**
 * Stop the server and make sure its whole tree is gone: what the shell itself
 * runs on the data is closed first, then the tree is recorded while the
 * server runs, the server is stopped, earlier runs' leftovers are swept, and
 * the recorded processes still running are killed. A record without the
 * server itself (the list could not be read) confirms nothing; the server is
 * still stopped. Without a handle, the trees of the shell's children running
 * the server's executable are recorded instead ({@link unhandledServerTrees});
 * a server that has already exited is not among them, nor are the processes
 * it started, and a list that could not be read confirms nothing there either.
 * @param input - the shell's own writers, the server, where to look for one without a handle, its stop, the sweep,
 * and the process probes.
 * @returns whether the recorded tree is gone; `gone` when nothing was recorded without a handle from a list that
 * could be read, or when neither a handle nor where to look for one was given.
 */
export async function stopServerTree(input: ServerTreeStop): Promise<TreeCheck> {
  if (input.closeShellWriters !== undefined) await input.closeShellWriters()
  const pid = input.pid
  const unhandled = input.unhandled
  const listed = pid !== undefined || unhandled !== undefined ? await input.probes.list() : []
  const recorded = pid !== undefined
    ? descendantsOf(pid, listed)
    : unhandled === undefined ? [] : unhandledServerTrees(listed, unhandled)
  await input.stop()
  await input.sweep()
  if (pid !== undefined && !recorded.some(entry => entry.pid === pid)) {
    return { kind: 'unconfirmed', detail: `the process list did not show the server (pid ${String(pid)}) while it ran` }
  }
  if (pid === undefined && unhandled !== undefined && listed.length === 0) {
    return { kind: 'unconfirmed', detail: 'the process list could not be read to look for a server without a handle' }
  }
  return await ensureTreeGone(recorded, input.probes)
}

/**
 * A process's start time, for telling a lock's holder from a later process
 * that reused its id.
 * @param pid - the process.
 * @param probes - the process list.
 * @returns its start time; `undefined` when no such process runs; `unknown` when the list is empty (the system could not be asked).
 */
export async function startTimeOf(pid: number, probes: Pick<ProcessProbes, 'list'>): Promise<string | undefined> {
  const entries = await probes.list()
  if (entries.length === 0) return START_TIME_UNKNOWN
  return entries.find(entry => entry.pid === pid)?.startedAt
}

/**
 * The real probes the move lock needs.
 * @param platform - the running platform.
 * @returns the start-time lookup and the clock.
 */
export function nodeLockProbes(platform: NodeJS.Platform): LockProbes {
  const processes = nodeProcessProbes(platform)
  return { startTimeOf: pid => startTimeOf(pid, processes), now: () => new Date() }
}
