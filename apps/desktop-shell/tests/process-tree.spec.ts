/**
 * Stopping the server's whole process tree: the tree recorded while the
 * server runs, the processes still running after the stop found by process
 * id and start time (so a reused process id is not taken for a survivor),
 * killed, and reported when they will not go. Every process here is a fake;
 * the real listing is only read, never acted on.
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  descendantsOf, ensureTreeGone, listWindowsProcesses, nodeProcessProbes, parsePsOutput, parseWindowsProcesses, stopServerTree, survivorsOf,
  TREE_KILL_ROUNDS, unhandledServerTrees, WINDOWS_PROCESS_SCRIPT, type ProcessProbes,
} from '../src/process-tree.ts'
import type { PowerShellResult, PowerShellRunner } from '../src/terminal-env.ts'
import { entry, fakeSystem } from './fake-processes.ts'

describe('the server process tree', () => {
  it('finds every descendant of the server, and nothing else', () => {
    const table = [entry(1, 0), entry(100, 1, 'node'), entry(101, 100, 'mcp'), entry(102, 101, 'sh'), entry(103, 102, 'zsh'), entry(200, 1, 'other')]
    expect(descendantsOf(100, table).map(item => item.pid)).toEqual([100, 101, 102, 103])
    expect(descendantsOf(999, table)).toEqual([])
  })

  it('kills what the server left running after its stop, found although the parent is gone', async () => {
    const system = fakeSystem([entry(1, 0), entry(100, 1, 'node'), entry(101, 100, 'mcp'), entry(102, 101, 'terminal'), entry(200, 1, 'other')])
    let swept = false
    const survivors = await stopServerTree({
      pid: 100, stop: async () => { system.stopServer(100) }, sweep: async () => { swept = true }, probes: system.probes,
    })
    expect(survivors).toEqual({ kind: 'gone' })
    expect(swept).toBe(true)
    expect(system.killed.sort()).toEqual([101, 102])
    expect(system.table.map(item => item.pid)).toEqual([1, 200])
  })

  it('closes the shell\'s own writers of the data before it records, stops, or sweeps anything', async () => {
    const system = fakeSystem([entry(1, 0), entry(100, 1, 'node'), entry(101, 100, 'mcp')])
    const calls: string[] = []
    const check = await stopServerTree({
      closeShellWriters: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 5) })
        calls.push('close the engine service')
      },
      pid: 100,
      stop: async () => { calls.push('stop'); system.stopServer(100) },
      sweep: async () => { calls.push('sweep') },
      probes: { ...system.probes, list: async () => { calls.push('list'); return await system.probes.list() } },
    })
    expect(check).toEqual({ kind: 'gone' })
    expect(calls.slice(0, 4)).toEqual(['close the engine service', 'list', 'stop', 'sweep'])
  })

  it('reports a process that will not go, and never kills a later process that reused a recorded id', async () => {
    const system = fakeSystem([entry(1, 0), entry(100, 1), entry(101, 100, 'stuck'), entry(102, 100, 'exits')], [101])
    const recorded = descendantsOf(100, await system.probes.list())
    system.stopServer(100)
    // 102 exited and its id now belongs to an unrelated process started later.
    const later = { ...entry(102, 1, 'unrelated'), startedAt: 'Mon Sep 28 11:00:00 2026' }
    const probes: ProcessProbes = {
      ...system.probes,
      list: async () => [...(await system.probes.list()).filter(item => item.pid !== 102), later],
    }
    const survivors = await ensureTreeGone(recorded, probes)
    expect(survivors).toMatchObject({ kind: 'running', survivors: [{ pid: 101 }] })
    expect(system.killed).toEqual(Array.from({ length: TREE_KILL_ROUNDS }, () => 101))
    expect(survivorsOf(recorded, [later])).toEqual([])
  })

  it('has nothing to check without a server', async () => {
    const system = fakeSystem([entry(1, 0)])
    const none = await stopServerTree({ pid: undefined, stop: async () => undefined, sweep: async () => undefined, probes: system.probes })
    expect(none).toEqual({ kind: 'gone' })
    expect(system.killed).toEqual([])
  })

  it('without a handle, records the shell\'s children running the server\'s executable with their trees, and nothing else', async () => {
    const node = '/Applications/DSH Desktop.app/Contents/Resources/runtime/node'
    const system = fakeSystem([
      entry(1, 0), entry(50, 1, '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop'),
      entry(60, 50, 'DSH Desktop Helper (GPU)'), entry(61, 50, 'DSH Desktop Helper (Renderer)'),
      // The server whose start timed out, still running, and what it started.
      entry(70, 50, node), entry(71, 70, '/bin/zsh'), entry(72, 71, 'python3'),
      // An earlier run's server, which the sweep is for, and another program's node.
      entry(80, 1, node), entry(90, 50, '/usr/local/bin/node'),
    ])
    const check = await stopServerTree({
      pid: undefined,
      unhandled: { shell: 50, executable: node.toUpperCase() },
      stop: async () => undefined,
      sweep: async () => { system.stopServer(70); system.stopServer(80) },
      probes: system.probes,
    })
    expect(check).toEqual({ kind: 'gone' })
    expect(system.killed.sort()).toEqual([71, 72])
    expect(system.table.map(item => item.pid)).toEqual([1, 50, 60, 61, 90])
    // A server that already exited is not the shell's child any more, and neither is what it started.
    expect(unhandledServerTrees([entry(50, 1), entry(71, 1, '/bin/zsh')], { shell: 50, executable: node })).toEqual([])
  })

  it('never takes a process list that cannot be read for a stopped tree', async () => {
    const failing: ProcessProbes = { list: async () => [], kill: async () => undefined, sleep: async () => undefined }
    let stopped = false
    const check = await stopServerTree({ pid: 100, stop: async () => { stopped = true }, sweep: async () => undefined, probes: failing })
    expect(check).toMatchObject({ kind: 'unconfirmed' })
    expect(stopped).toBe(true)
    // A list that shows the server but not itself: the snapshot has to contain the server.
    const elsewhere = fakeSystem([entry(1, 0), entry(200, 1)])
    expect(await stopServerTree({ pid: 100, stop: async () => undefined, sweep: async () => undefined, probes: elsewhere.probes }))
      .toMatchObject({ kind: 'unconfirmed' })
    // Readable before the stop, empty after it.
    const system = fakeSystem([entry(1, 0), entry(100, 1), entry(101, 100)])
    const blind: ProcessProbes = { ...system.probes, list: async () => [] }
    expect(await ensureTreeGone(descendantsOf(100, await system.probes.list()), blind)).toMatchObject({ kind: 'unconfirmed' })
  })

  it('takes a Windows listing that PowerShell did not finish for no list at all', async () => {
    const scripts: string[] = []
    const answering = (result: PowerShellResult): PowerShellRunner => async (script) => { scripts.push(script); return result }
    expect(await listWindowsProcesses(answering({ code: 0, stdout: '1200\t4\t2026-09-28T01:02:03.0000000Z\tC:\\DSH\\node.exe\r\n' })))
      .toEqual([{ pid: 1200, ppid: 4, startedAt: '2026-09-28T01:02:03.0000000Z', command: 'C:\\DSH\\node.exe' }])
    expect(scripts).toEqual([WINDOWS_PROCESS_SCRIPT])
    // A failure, and a run killed at its timeout (no exit code), may have printed part of the table.
    expect(await listWindowsProcesses(answering({ code: 1, stdout: '1200\t4\t\tC:\\DSH\\node.exe\r\n' }))).toEqual([])
    expect(await listWindowsProcesses(answering({ code: null, stdout: '1200\t4\t\tC:\\DSH\\node.exe\r\n' }))).toEqual([])
    expect(await listWindowsProcesses(async () => { throw new Error('spawn powershell.exe ENOENT') })).toEqual([])
  })

  it('reads ps and the Windows listing, commands with spaces and the five-word start time included', async () => {
    expect(parsePsOutput('  812   1 Mon Sep 28 10:00:00 2026 /Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop\n junk\n')).toEqual([
      { pid: 812, ppid: 1, startedAt: 'Mon Sep 28 10:00:00 2026', command: '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop' },
    ])
    expect(parseWindowsProcesses('4\t0\t\t\r\n1200\t4\t2026-09-28T01:02:03.0000000Z\tC:\\Program Files\\DSH\\node.exe\r\nx\ty\n')).toEqual([
      { pid: 4, ppid: 0, startedAt: '', command: '' },
      { pid: 1200, ppid: 4, startedAt: '2026-09-28T01:02:03.0000000Z', command: 'C:\\Program Files\\DSH\\node.exe' },
    ])
    if (process.platform !== 'win32') {
      const self = (await nodeProcessProbes(process.platform).list()).find(item => item.pid === process.pid)
      expect(self?.ppid).toBe(process.ppid)
      expect(self?.startedAt).toMatch(/\d{4}$/)
    }
  })
})
